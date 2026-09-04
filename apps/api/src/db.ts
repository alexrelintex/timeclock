/**
 * In-memory data layer for local/dev/demo runs.
 *
 * It implements the two persistence ports the domain packages define —
 *   @timeclock/core   -> PunchStore   (loadOpenStream, appendWithOutbox)
 *   @timeclock/hris   -> OutboxStore  (claim/mark/list two-phase drain)
 * — so PunchService and drainTenant run against it unchanged. A Prisma-backed
 * implementation of the same ports lives in ./stores/prismaStores.ts for
 * production; nothing above this line knows which is wired.
 *
 * Beyond the ports it also holds the directory (tenants/agents), compliance
 * exceptions, and a tiny event bus so the HTTP layer can push SSE updates.
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { PunchStore } from '@timeclock/core';
import type { OutboxStore, OutboxRow } from '@timeclock/hris';
import type {
  Agent,
  ComplianceException,
  ExceptionType,
  OutboxStatus,
  PunchEvent,
  SchedulePatternRow,
  ScheduleExceptionRow,
  Tenant,
} from './types.js';

/** YYYY-MM-DD for an instant in a given IANA timezone (agent-local calendar date). */
export function localDateOf(utc: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(utc);
}

interface OutboxRecord {
  id: string;
  tenantId: string;
  punchEventId?: string;
  kind: OutboxRow['kind'];
  payload: unknown;
  status: OutboxStatus;
  trackingId?: string;
  attempts: number;
  lastError?: string;
  submittedAt?: Date;
  resolvedAt?: Date;
  availableAt: number; // epoch ms; retry backoff gate
  createdAt: Date;
}

export type DbEvent =
  | { type: 'punch'; tenantId: string; agentId: string; event: PunchEvent }
  | { type: 'exception'; tenantId: string; agentId: string; exception: ComplianceException }
  | { type: 'outbox'; tenantId: string };

export class MemoryDb implements PunchStore, OutboxStore {
  readonly bus = new EventEmitter();
  private tenants = new Map<string, Tenant>();
  private agents = new Map<string, Agent>();
  private events: PunchEvent[] = [];
  private exceptions = new Map<string, ComplianceException>();
  private outbox: OutboxRecord[] = [];

  constructor() {
    this.bus.setMaxListeners(0); // one listener per open SSE connection
  }

  // ------------------------------------------------------------ directory
  upsertTenant(t: Tenant): Tenant {
    this.tenants.set(t.id, t);
    return t;
  }
  upsertAgent(a: Agent): Agent {
    this.agents.set(a.id, a);
    return a;
  }
  getTenant(id: string): Tenant | undefined {
    return this.tenants.get(id);
  }
  /** Administer a tenant's HRIS connector: set provider + full config. */
  setTenantHris(tenantId: string, provider: string | null, config: Record<string, unknown> | null): Tenant | undefined {
    const t = this.tenants.get(tenantId);
    if (!t) return undefined;
    t.hrisProvider = provider;
    t.hrisConfig = config;
    return t;
  }
  /** Merge a patch into a tenant's HRIS config (e.g. rotated OAuth refresh token). */
  updateTenantHrisConfig(tenantId: string, patch: Record<string, unknown>): void {
    const t = this.tenants.get(tenantId);
    if (!t) return;
    t.hrisConfig = { ...(t.hrisConfig ?? {}), ...patch };
  }
  getAgent(id: string): Agent | undefined {
    return this.agents.get(id);
  }
  listTenants(): Tenant[] {
    return [...this.tenants.values()];
  }
  listAgents(tenantId: string): Agent[] {
    return [...this.agents.values()].filter((a) => a.tenantId === tenantId && a.active);
  }
  /** Includes deactivated employees — for the Employees management panel. */
  listAllAgents(tenantId: string): Agent[] {
    return [...this.agents.values()].filter((a) => a.tenantId === tenantId);
  }
  /** Identity resolution: host CRM user id (from signed JWT) -> agent. */
  agentByHostUserId(tenantId: string, hostUserId: string): Agent | undefined {
    return [...this.agents.values()].find(
      (a) => a.tenantId === tenantId && a.hostUserId === hostUserId,
    );
  }
  agentByHrisEmployeeId(tenantId: string, hrisEmployeeId: string): Agent | undefined {
    return [...this.agents.values()].find(
      (a) => a.tenantId === tenantId && a.hrisEmployeeId === hrisEmployeeId,
    );
  }

  // ------------------------------------------------------- events / reads
  /** All ACTIVE events for an agent, chronological. */
  agentEvents(agentId: string): PunchEvent[] {
    return this.events
      .filter((e) => e.agentId === agentId && e.status === 'ACTIVE')
      .sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime());
  }

  /** All ACTIVE events for a tenant, chronological. Used by CSV export. */
  tenantEvents(tenantId: string): PunchEvent[] {
    return this.events
      .filter((e) => e.tenantId === tenantId && e.status === 'ACTIVE')
      .sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime());
  }

  /** Append a plain event (no outbox) and return its id. Used by corrections. */
  appendEvent(args: {
    tenantId: string;
    agentId: string;
    eventType: PunchEvent['eventType'];
    eventTime: Date;
    source: PunchEvent['source'];
    note?: string;
    createdById: string;
    status?: PunchEvent['status'];
    correctionOfId?: string;
  }): string {
    const id = randomUUID();
    const event: PunchEvent = {
      id,
      tenantId: args.tenantId,
      agentId: args.agentId,
      eventType: args.eventType,
      eventTime: args.eventTime,
      source: args.source,
      status: args.status ?? 'ACTIVE',
      correctionOfId: args.correctionOfId,
      note: args.note,
      createdById: args.createdById,
      createdAt: new Date(),
    };
    this.events.push(event);
    this.emit({ type: 'punch', tenantId: args.tenantId, agentId: args.agentId, event });
    return id;
  }

  /**
   * History query: ACTIVE events on a given agent-local calendar date, optionally
   * scoped to one agent and/or department. `localDate` is YYYY-MM-DD.
   */
  eventsOnLocalDate(
    tenantId: string,
    localDate: string,
    opts: { agentId?: string; department?: string } = {},
  ): PunchEvent[] {
    return this.events
      .filter((e) => {
        if (e.tenantId !== tenantId || e.status !== 'ACTIVE') return false;
        if (opts.agentId && e.agentId !== opts.agentId) return false;
        const agent = this.agents.get(e.agentId);
        if (!agent) return false;
        if (opts.department && agent.department !== opts.department) return false;
        return localDateOf(e.eventTime, agent.timezone) === localDate;
      })
      .sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime());
  }

  // -------------------------------------------------------- scheduler
  // Repeating weekly pattern (one row per agent+weekday) and per-date overrides.
  private patterns = new Map<string, SchedulePatternRow[]>(); // key: agentId
  private scheduleExceptions = new Map<string, ScheduleExceptionRow>(); // key: agentId|date

  setPattern(agentId: string, rows: SchedulePatternRow[]): void {
    this.patterns.set(
      agentId,
      rows.map((r) => ({ ...r, agentId })),
    );
  }
  getPattern(agentId: string): SchedulePatternRow[] {
    return this.patterns.get(agentId) ?? [];
  }
  patternForWeekday(agentId: string, weekday: number): SchedulePatternRow | undefined {
    return this.getPattern(agentId).find((r) => r.weekday === weekday);
  }
  setScheduleException(row: ScheduleExceptionRow): void {
    this.scheduleExceptions.set(`${row.agentId}|${row.date}`, row);
  }
  clearScheduleException(agentId: string, date: string): boolean {
    return this.scheduleExceptions.delete(`${agentId}|${date}`);
  }
  getScheduleException(agentId: string, date: string): ScheduleExceptionRow | undefined {
    return this.scheduleExceptions.get(`${agentId}|${date}`);
  }

  /** Distinct departments in the tenant (excludes supervisors from coverage). */
  departments(tenantId: string): string[] {
    const set = new Set<string>();
    for (const a of this.agents.values()) {
      if (a.tenantId === tenantId && a.active && !a.isSupervisor) set.add(a.department);
    }
    return [...set].sort();
  }

  // --------------------------------------------- PunchStore (core port)
  async loadOpenStream(agentId: string): Promise<(PunchEvent & { id: string })[]> {
    // "Open stream": events since the last OUT (or all, if currently open).
    const all = this.agentEvents(agentId);
    let startIdx = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].eventType === 'OUT') {
        startIdx = i + 1;
        break;
      }
    }
    return all.slice(startIdx);
  }

  async appendWithOutbox(args: {
    tenantId: string;
    agentId: string;
    eventType: PunchEvent['eventType'];
    eventTime: Date;
    source: PunchEvent['source'];
    sessionId?: string;
    note?: string;
    createdById: string;
    outbox: null | { kind: 'PUNCH'; payload: unknown };
  }): Promise<string> {
    const id = randomUUID();
    const event: PunchEvent = {
      id,
      tenantId: args.tenantId,
      agentId: args.agentId,
      eventType: args.eventType,
      eventTime: args.eventTime,
      source: args.source,
      sessionId: args.sessionId,
      status: 'ACTIVE',
      note: args.note,
      createdById: args.createdById,
      createdAt: new Date(),
    };
    // Single "transaction": event + outbox row appended together.
    this.events.push(event);
    if (args.outbox) {
      const payload = args.outbox.payload as Record<string, unknown>;
      // Store impl replaces the SELF sentinel with the real event id (audit linkage).
      if (payload && payload.punchEventId === 'SELF') payload.punchEventId = id;
      this.enqueueOutbox({ tenantId: args.tenantId, punchEventId: id, kind: 'PUNCH', payload });
    }
    this.emit({ type: 'punch', tenantId: args.tenantId, agentId: args.agentId, event });
    return id;
  }

  // -------------------------------------------------- outbox producers
  enqueueOutbox(args: {
    tenantId: string;
    punchEventId?: string;
    kind: OutboxRow['kind'];
    payload: unknown;
  }): string {
    const id = randomUUID();
    this.outbox.push({
      id,
      tenantId: args.tenantId,
      punchEventId: args.punchEventId,
      kind: args.kind,
      payload: args.payload,
      status: 'PENDING',
      attempts: 0,
      availableAt: 0,
      createdAt: new Date(),
    });
    this.emit({ type: 'outbox', tenantId: args.tenantId });
    return id;
  }

  // -------------------------------------------- OutboxStore (hris port)
  async claimPending(
    tenantId: string,
    kind: OutboxRow['kind'],
    limit: number,
  ): Promise<OutboxRow[]> {
    const now = Date.now();
    return this.outbox
      .filter(
        (r) =>
          r.tenantId === tenantId &&
          r.kind === kind &&
          r.status === 'PENDING' &&
          r.availableAt <= now,
      )
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        kind: r.kind,
        payload: r.payload,
        attempts: r.attempts,
      }));
  }
  async markSubmitted(ids: string[], trackingId: string): Promise<void> {
    this.patch(ids, (r) => {
      r.status = 'SUBMITTED';
      r.trackingId = trackingId;
      r.submittedAt = new Date();
    });
  }
  async markDelivered(ids: string[]): Promise<void> {
    this.patch(ids, (r) => {
      r.status = 'DELIVERED';
      r.resolvedAt = new Date();
    });
  }
  async markNotSupported(ids: string[]): Promise<void> {
    this.patch(ids, (r) => {
      r.status = 'NOT_SUPPORTED';
      r.resolvedAt = new Date();
    });
  }
  async markFailed(
    ids: string[],
    error: string,
    retryable: boolean,
    retryAfterMs?: number,
  ): Promise<void> {
    this.patch(ids, (r) => {
      r.attempts += 1;
      r.lastError = error;
      if (retryable && r.attempts < 8) {
        r.status = 'PENDING';
        const backoff = retryAfterMs ?? Math.min(60_000, 1000 * 2 ** r.attempts);
        r.availableAt = Date.now() + backoff;
      } else {
        r.status = 'FAILED';
      }
    });
  }
  async listSubmitted(tenantId: string): Promise<{ trackingId: string; ids: string[] }[]> {
    const groups = new Map<string, string[]>();
    for (const r of this.outbox) {
      if (r.tenantId === tenantId && r.status === 'SUBMITTED' && r.trackingId) {
        const g = groups.get(r.trackingId) ?? [];
        g.push(r.id);
        groups.set(r.trackingId, g);
      }
    }
    return [...groups.entries()].map(([trackingId, ids]) => ({ trackingId, ids }));
  }
  async markResolved(
    trackingId: string,
    perRecordErrors: { recordRef: string; message: string }[],
  ): Promise<void> {
    const hadError = perRecordErrors.length > 0;
    for (const r of this.outbox) {
      if (r.trackingId === trackingId && r.status === 'SUBMITTED') {
        r.status = hadError ? 'FAILED' : 'DELIVERED';
        r.resolvedAt = new Date();
        if (hadError) r.lastError = perRecordErrors.map((e) => e.message).join('; ');
      }
    }
  }

  outboxSnapshot(tenantId: string): { status: OutboxStatus; kind: string; lastError?: string }[] {
    return this.outbox
      .filter((r) => r.tenantId === tenantId)
      .map((r) => ({ status: r.status, kind: r.kind, lastError: r.lastError }));
  }

  private patch(ids: string[], fn: (r: OutboxRecord) => void): void {
    const set = new Set(ids);
    for (const r of this.outbox) if (set.has(r.id)) fn(r);
  }

  // -------------------------------------------------------- exceptions
  /** Idempotent per (agent, workDate, type): the sweeper calls this repeatedly. */
  upsertException(
    x: Omit<ComplianceException, 'id' | 'detectedAt' | 'status'> &
      Partial<Pick<ComplianceException, 'status'>>,
  ): ComplianceException {
    // Natural key mirrors the schema's (agent, workDate, type) index. Once a
    // violation exists for a workday it is never re-raised — a supervisor's
    // RESOLVED/DISMISSED is terminal, so a re-sweep won't resurrect it.
    const key = `${x.agentId}|${x.workDate.toISOString().slice(0, 10)}|${x.type}`;
    const existing = [...this.exceptions.values()].find(
      (e) => `${e.agentId}|${e.workDate.toISOString().slice(0, 10)}|${e.type}` === key,
    );
    if (existing) {
      if (existing.status === 'OPEN' || existing.status === 'PENDING_APPROVAL') {
        existing.relatedEventIds = x.relatedEventIds;
        existing.premiumHourPayable = x.premiumHourPayable;
        // A later caller (e.g. the clock-out correction) can enrich an
        // exception the sweeper opened first: carry over status + resolution.
        if (x.status) existing.status = x.status;
        if (x.resolution !== undefined) existing.resolution = x.resolution;
        this.emit({
          type: 'exception',
          tenantId: existing.tenantId,
          agentId: existing.agentId,
          exception: existing,
        });
      }
      return existing;
    }
    const created: ComplianceException = {
      id: randomUUID(),
      status: x.status ?? 'OPEN',
      detectedAt: new Date(),
      ...x,
    };
    this.exceptions.set(created.id, created);
    this.emit({
      type: 'exception',
      tenantId: created.tenantId,
      agentId: created.agentId,
      exception: created,
    });
    return created;
  }
  getException(id: string): ComplianceException | undefined {
    return this.exceptions.get(id);
  }
  listOpenExceptions(tenantId: string): ComplianceException[] {
    return [...this.exceptions.values()].filter(
      (e) => e.tenantId === tenantId && (e.status === 'OPEN' || e.status === 'PENDING_APPROVAL'),
    );
  }
  markPremiumDelivered(exceptionId: string): void {
    const e = this.exceptions.get(exceptionId);
    if (e) e.premiumDelivered = true;
  }
  resolveException(id: string, byId: string, resolution: string): ComplianceException | undefined {
    const e = this.exceptions.get(id);
    if (!e) return undefined;
    e.status = 'RESOLVED';
    e.resolvedById = byId;
    e.resolvedAt = new Date();
    e.resolution = resolution;
    this.emit({ type: 'exception', tenantId: e.tenantId, agentId: e.agentId, exception: e });
    return e;
  }

  private emit(e: DbEvent): void {
    this.bus.emit('change', e);
  }
}
