/**
 * Postgres driver — durable persistence behind the synchronous `Store` contract.
 *
 * Design: an in-memory PROJECTION (inherited from MemoryDb) serves every
 * synchronous read exactly as the memory driver does, so nothing above the store
 * changes. Durability is added at the edges:
 *   - init()  hydrates the projection from Postgres on boot (survives restarts).
 *   - writes  are mirrored to Postgres (write-through) via Prisma, using the id
 *             MemoryDb assigned so the row and the projection always agree.
 *
 * The payroll-critical punch path (appendWithOutbox) and the outbox consumer
 * transitions are awaited + transactional. The directory/exception writes keep
 * MemoryDb's synchronous signatures, so their persistence is fire-and-forget with
 * error logging — a process crash in the gap is the known, documented limit of
 * this single-process write-through (see README.md). Time-Clock remains its own
 * system of record: this schema holds no foreign keys out to any CRM.
 */
import { MemoryDb, type OutboxRecord, type StoreSnapshot } from '../../db.js';
import type { OutboxRow } from '@timeclock/hris';
import type {
  Agent,
  ComplianceException,
  PunchEvent,
  SchedulePatternRow,
  ScheduleExceptionRow,
  Tenant,
} from '../../types.js';
import type { Store } from '../contract.js';
import { loadPrismaClient, type PrismaClientLike } from './prisma.js';

export class PostgresStore extends MemoryDb implements Store {
  private prisma?: PrismaClientLike;
  // Set while appendWithOutbox owns the event+outbox transaction, so the nested
  // enqueueOutbox() override doesn't also persist the row out of FK order.
  private inPunchTxn = false;

  private client(): PrismaClientLike {
    if (!this.prisma) throw new Error('PostgresStore.init() must run before any write');
    return this.prisma;
  }

  // Tracks in-flight punch ops (which enqueue their DB write only after an await, so
  // the serial `tail` alone can't see them until then). flush() drains these too.
  private pending = new Set<Promise<unknown>>();
  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    void p.catch(() => {}).finally(() => this.pending.delete(p));
    return p;
  }

  /** Wait for every queued write-through to finish (batch jobs / graceful shutdown). */
  async flush(): Promise<void> {
    // Draining in-flight ops can enqueue more onto the serial tail; a few passes
    // settle both. Bounded so a persistent failure can't hang shutdown forever.
    for (let i = 0; i < 5 && this.pending.size; i++) {
      await Promise.allSettled([...this.pending]);
    }
    await this.tail;
  }

  /** Connect + load the projection from Postgres. Awaited by the server pre-listen. */
  async init(): Promise<void> {
    this.prisma = loadPrismaClient();
    const p = this.prisma;
    const [tenants, agents, events, exceptions, outbox, patterns, schedExceptions] = await Promise.all([
      p.tenant.findMany(),
      p.agent.findMany(),
      p.punchEvent.findMany({ where: { status: 'ACTIVE' }, orderBy: { eventTime: 'asc' } }),
      p.complianceException.findMany(),
      p.hrisOutbox.findMany({ where: { status: { in: ['PENDING', 'SUBMITTED'] } } }),
      p.schedulePattern.findMany(),
      p.scheduleException.findMany(),
    ]);
    const snapshot: StoreSnapshot = {
      tenants: tenants.map(rowToTenant),
      agents: agents.map(rowToAgent),
      events: events.map(rowToEvent),
      exceptions: exceptions.map(rowToException),
      outbox: outbox.map(rowToOutbox),
      patterns: patterns.map(rowToPattern),
      scheduleExceptions: schedExceptions.map(rowToScheduleException),
    };
    this.hydrate(snapshot);
    console.log(
      `[store:postgres] hydrated ${snapshot.tenants!.length} tenant(s), ` +
        `${snapshot.agents!.length} agent(s), ${snapshot.events!.length} open event(s), ` +
        `${snapshot.outbox!.length} pending outbox row(s), ${snapshot.patterns!.length} schedule pattern row(s)`,
    );
  }

  // ------------------------------------------------------------- directory
  upsertTenant(t: Tenant): Tenant {
    const saved = super.upsertTenant(t);
    void this.persist('tenant', () =>
      this.client().tenant.upsert({ where: { id: t.id }, create: tenantToRow(t), update: tenantToRow(t) }),
    );
    return saved;
  }
  setTenantHris(tenantId: string, provider: string | null, config: Record<string, unknown> | null): Tenant | undefined {
    const t = super.setTenantHris(tenantId, provider, config);
    if (t) void this.persist('tenant.hris', () =>
      this.client().tenant.update({ where: { id: tenantId }, data: { hrisProvider: provider, hrisConfig: config } }),
    );
    return t;
  }
  updateTenantHrisConfig(tenantId: string, patch: Record<string, unknown>): void {
    super.updateTenantHrisConfig(tenantId, patch);
    const t = this.getTenant(tenantId);
    if (t) void this.persist('tenant.hrisConfig', () =>
      this.client().tenant.update({ where: { id: tenantId }, data: { hrisConfig: t.hrisConfig } }),
    );
  }
  upsertAgent(a: Agent): Agent {
    const saved = super.upsertAgent(a);
    void this.persist('agent', () =>
      this.client().agent.upsert({ where: { id: a.id }, create: agentToRow(a), update: agentToRow(a) }),
    );
    return saved;
  }
  linkHostUser(agentId: string, hostUserId: string, email?: string): Agent | undefined {
    const a = super.linkHostUser(agentId, hostUserId, email);
    if (a) void this.persist('agent.link', () =>
      this.client().agent.update({ where: { id: agentId }, data: { hostUserId: a.hostUserId, email: a.email } }),
    );
    return a;
  }

  // ------------------------------------------------------------- events
  appendEvent(args: Parameters<MemoryDb['appendEvent']>[0]): string {
    const id = super.appendEvent(args);
    const ev = this.getEventById(id);
    if (ev) void this.persist('punchEvent', () => this.client().punchEvent.create({ data: eventToRow(ev) }));
    return id;
  }

  appendWithOutbox(args: Parameters<MemoryDb['appendWithOutbox']>[0]): Promise<string> {
    // Register the whole op as in-flight so flush()/shutdown wait for it even when a
    // caller doesn't await the returned promise (e.g. a batch seed). Normal request
    // handlers DO await it, so per-request durability is unchanged.
    return this.track(this.doAppendWithOutbox(args));
  }
  private async doAppendWithOutbox(args: Parameters<MemoryDb['appendWithOutbox']>[0]): Promise<string> {
    this.inPunchTxn = true;
    let id: string;
    try {
      id = await super.appendWithOutbox(args); // updates the projection (+ enqueues in memory)
    } finally {
      this.inPunchTxn = false;
    }
    const ev = this.getEventById(id);
    // The outbox row (if any) super enqueued for this event — its id was captured
    // by the enqueueOutbox override that ran inside super, above.
    const outboxRow = args.outbox && this.lastEnqueuedId ? this.getOutboxById(this.lastEnqueuedId) : undefined;
    // Event + outbox in ONE transaction — the transactional-outbox guarantee.
    await this.persist('punch', () =>
      this.client().$transaction(async (tx) => {
        if (ev) await tx.punchEvent.create({ data: eventToRow(ev) });
        if (outboxRow) await tx.hrisOutbox.create({ data: outboxToRow(outboxRow) });
      }),
    );
    return id;
  }

  enqueueOutbox(args: Parameters<MemoryDb['enqueueOutbox']>[0]): string {
    const id = super.enqueueOutbox(args);
    this.lastEnqueuedId = id; // so appendWithOutbox can persist it in its txn
    if (!this.inPunchTxn) {
      const row = this.getOutboxById(id);
      if (row) void this.persist('outbox', () => this.client().hrisOutbox.create({ data: outboxToRow(row) }));
    }
    return id;
  }

  // ---- outbox consumer transitions (awaited: they gate HRIS delivery)
  async markSubmitted(ids: string[], trackingId: string): Promise<void> {
    await super.markSubmitted(ids, trackingId);
    await this.updateOutbox(ids, { status: 'SUBMITTED', trackingId, submittedAt: new Date() });
  }
  async markDelivered(ids: string[]): Promise<void> {
    await super.markDelivered(ids);
    await this.updateOutbox(ids, { status: 'DELIVERED', resolvedAt: new Date() });
  }
  async markNotSupported(ids: string[]): Promise<void> {
    await super.markNotSupported(ids);
    await this.updateOutbox(ids, { status: 'NOT_SUPPORTED', resolvedAt: new Date() });
  }
  async markFailed(ids: string[], error: string, retryable: boolean, retryAfterMs?: number): Promise<void> {
    await super.markFailed(ids, error, retryable, retryAfterMs);
    // Mirror the resulting status/attempts the projection computed for each id.
    for (const id of ids) {
      const row = this.getOutboxById(id);
      if (row) await this.updateOutbox([id], { status: row.status, attempts: row.attempts, lastError: row.lastError });
    }
  }
  async markResolved(trackingId: string, perRecordErrors: { recordRef: string; message: string }[]): Promise<void> {
    await super.markResolved(trackingId, perRecordErrors);
    const failed = perRecordErrors.length > 0;
    await this.persist('outbox.resolve', () =>
      this.client().hrisOutbox.updateMany({
        where: { trackingId, status: 'SUBMITTED' },
        data: {
          status: failed ? 'FAILED' : 'DELIVERED',
          resolvedAt: new Date(),
          lastError: failed ? perRecordErrors.map((e) => e.message).join('; ') : null,
        },
      }),
    );
  }

  // ------------------------------------------------------------- exceptions
  upsertException(x: Parameters<MemoryDb['upsertException']>[0]): ComplianceException {
    const saved = super.upsertException(x);
    void this.persist('exception', () =>
      this.client().complianceException.upsert({
        where: { id: saved.id },
        create: exceptionToRow(saved),
        update: exceptionToRow(saved),
      }),
    );
    return saved;
  }
  markPremiumDelivered(exceptionId: string): void {
    super.markPremiumDelivered(exceptionId);
    void this.persist('exception.premium', () =>
      this.client().complianceException.update({ where: { id: exceptionId }, data: { premiumDelivered: true } }),
    );
  }
  resolveException(id: string, byId: string, resolution: string): ComplianceException | undefined {
    const e = super.resolveException(id, byId, resolution);
    if (e) void this.persist('exception.resolve', () =>
      this.client().complianceException.update({
        where: { id },
        data: { status: e.status, resolvedById: e.resolvedById, resolvedAt: e.resolvedAt, resolution: e.resolution },
      }),
    );
    return e;
  }

  // ------------------------------------------------------------- scheduler
  setPattern(agentId: string, rows: SchedulePatternRow[]): void {
    super.setPattern(agentId, rows);
    // setPattern REPLACES the agent's whole weekly pattern — mirror that as a
    // delete-then-insert in one transaction.
    const withAgent = rows.map((r) => ({ ...r, agentId }));
    void this.persist('schedule.pattern', () =>
      this.client().$transaction(async (tx) => {
        await tx.schedulePattern.deleteMany({ where: { agentId } });
        if (withAgent.length) await tx.schedulePattern.createMany({ data: withAgent.map(patternToRow) });
      }),
    );
  }
  setScheduleException(row: ScheduleExceptionRow): void {
    super.setScheduleException(row);
    const data = scheduleExceptionToRow(row);
    void this.persist('schedule.exception', () =>
      this.client().scheduleException.upsert({
        where: { agentId_date: { agentId: row.agentId, date: row.date } },
        create: data,
        update: data,
      }),
    );
  }
  clearScheduleException(agentId: string, date: string): boolean {
    const existed = super.clearScheduleException(agentId, date);
    if (existed) void this.persist('schedule.exception.clear', () =>
      this.client().scheduleException.deleteMany({ where: { agentId, date } }),
    );
    return existed;
  }

  // ---------------------------------------------------------------- helpers
  private async updateOutbox(ids: string[], data: Record<string, unknown>): Promise<void> {
    await this.persist('outbox.update', () =>
      this.client().hrisOutbox.updateMany({ where: { id: { in: ids } }, data }),
    );
  }
  private lastEnqueuedId?: string;

  // Serial write queue: every write-through runs after the previous one settles,
  // in call order. This preserves referential order the projection guarantees but a
  // fire-and-forget write would otherwise race — tenant before agent, agent before
  // its events/exceptions — so foreign keys are never violated by write reordering.
  private tail: Promise<void> = Promise.resolve();
  private persist(label: string, op: () => Promise<unknown>): Promise<void> {
    const result = this.tail.then(() => op());
    this.tail = result.then(
      () => {},
      () => {}, // a failed write must not break the chain for later writes
    );
    return result.then(
      () => {},
      (err) => console.error(`[store:postgres] write-through failed (${label}):`, err),
    );
  }
}

// ------------------------------------------------------ row <-> domain maps
// camelCase columns (schema.prisma) match the domain field names key-for-key.
function tenantToRow(t: Tenant): Record<string, unknown> {
  return { ...t };
}
function rowToTenant(r: Record<string, any>): Tenant {
  return {
    id: r.id,
    name: r.name,
    timezone: r.timezone,
    breakMinutes: r.breakMinutes,
    lunchMinMinutes: r.lunchMinMinutes,
    lunchMaxMinutes: r.lunchMaxMinutes,
    coverageThresholdPct: r.coverageThresholdPct,
    mealAlertTiers: r.mealAlertTiers ?? [60, 30, 15],
    caMealRulesEnabled: r.caMealRulesEnabled,
    hrisProvider: r.hrisProvider ?? null,
    hrisConfig: r.hrisConfig ?? null,
  };
}
function agentToRow(a: Agent): Record<string, unknown> {
  return { ...a };
}
function rowToAgent(r: Record<string, any>): Agent {
  return {
    id: r.id,
    tenantId: r.tenantId,
    displayName: r.displayName,
    department: r.department,
    locationState: r.locationState ?? 'CA',
    timezone: r.timezone,
    role: r.role ?? (r.isSupervisor ? 'supervisor' : 'user'),
    isSupervisor: r.isSupervisor,
    managedDepartments: r.managedDepartments ?? undefined,
    hostUserId: r.hostUserId,
    email: r.email ?? null,
    hrisEmployeeId: r.hrisEmployeeId ?? null,
    hrisDepartmentId: r.hrisDepartmentId ?? null,
    hrisActivityTypeId: r.hrisActivityTypeId ?? null,
    mealWaiverOnFile: r.mealWaiverOnFile,
    active: r.active,
    deactivatedAt: r.deactivatedAt ?? null,
    archivedAt: r.archivedAt ?? null,
    scheduledStart: r.scheduledStart ?? undefined,
    scheduledEnd: r.scheduledEnd ?? undefined,
  };
}
function eventToRow(e: PunchEvent): Record<string, unknown> {
  return {
    id: e.id,
    tenantId: e.tenantId,
    agentId: e.agentId,
    eventType: e.eventType,
    eventTime: e.eventTime,
    source: e.source,
    sessionId: e.sessionId ?? null,
    status: e.status,
    correctionOfId: e.correctionOfId ?? null,
    note: e.note ?? null,
    createdById: e.createdById,
    approvedById: e.approvedById ?? null,
    approvedAt: e.approvedAt ?? null,
    createdAt: e.createdAt,
  };
}
function rowToEvent(r: Record<string, any>): PunchEvent {
  return {
    id: r.id,
    tenantId: r.tenantId,
    agentId: r.agentId,
    eventType: r.eventType,
    eventTime: r.eventTime,
    source: r.source,
    sessionId: r.sessionId ?? undefined,
    status: r.status,
    correctionOfId: r.correctionOfId ?? undefined,
    note: r.note ?? undefined,
    createdById: r.createdById,
    approvedById: r.approvedById ?? undefined,
    approvedAt: r.approvedAt ?? undefined,
    createdAt: r.createdAt,
  };
}
function exceptionToRow(e: ComplianceException): Record<string, unknown> {
  return {
    id: e.id,
    tenantId: e.tenantId,
    agentId: e.agentId,
    workDate: e.workDate,
    type: e.type,
    status: e.status,
    detectedAt: e.detectedAt,
    relatedEventIds: e.relatedEventIds,
    premiumHourPayable: e.premiumHourPayable,
    premiumDelivered: e.premiumDelivered,
    resolution: e.resolution ?? null,
    resolvedById: e.resolvedById ?? null,
    resolvedAt: e.resolvedAt ?? null,
  };
}
function rowToException(r: Record<string, any>): ComplianceException {
  return {
    id: r.id,
    tenantId: r.tenantId,
    agentId: r.agentId,
    workDate: r.workDate,
    type: r.type,
    status: r.status,
    detectedAt: r.detectedAt,
    relatedEventIds: r.relatedEventIds ?? [],
    premiumHourPayable: r.premiumHourPayable,
    premiumDelivered: r.premiumDelivered,
    resolution: r.resolution ?? undefined,
    resolvedById: r.resolvedById ?? undefined,
    resolvedAt: r.resolvedAt ?? undefined,
  };
}
function outboxToRow(r: OutboxRecord): Record<string, unknown> {
  return {
    id: r.id,
    tenantId: r.tenantId,
    punchEventId: r.punchEventId ?? null,
    kind: r.kind,
    payload: r.payload as object,
    status: r.status,
    trackingId: r.trackingId ?? null,
    attempts: r.attempts,
    lastError: r.lastError ?? null,
    submittedAt: r.submittedAt ?? null,
    resolvedAt: r.resolvedAt ?? null,
    createdAt: r.createdAt,
  };
}
function patternToRow(r: SchedulePatternRow): Record<string, unknown> {
  return {
    agentId: r.agentId,
    weekday: r.weekday,
    kind: r.kind,
    startTime: r.startTime,
    endTime: r.endTime,
    lunchTime: r.lunchTime,
    lunchMinutes: r.lunchMinutes,
  };
}
function rowToPattern(r: Record<string, any>): SchedulePatternRow {
  return {
    agentId: r.agentId,
    weekday: r.weekday,
    kind: r.kind,
    startTime: r.startTime ?? null,
    endTime: r.endTime ?? null,
    lunchTime: r.lunchTime ?? null,
    lunchMinutes: r.lunchMinutes ?? null,
  };
}
function scheduleExceptionToRow(r: ScheduleExceptionRow): Record<string, unknown> {
  return {
    agentId: r.agentId,
    date: r.date,
    kind: r.kind,
    startTime: r.startTime,
    endTime: r.endTime,
    lunchTime: r.lunchTime,
    lunchMinutes: r.lunchMinutes,
    note: r.note ?? null,
  };
}
function rowToScheduleException(r: Record<string, any>): ScheduleExceptionRow {
  return {
    agentId: r.agentId,
    date: r.date,
    kind: r.kind,
    startTime: r.startTime ?? null,
    endTime: r.endTime ?? null,
    lunchTime: r.lunchTime ?? null,
    lunchMinutes: r.lunchMinutes ?? null,
    note: r.note ?? undefined,
  };
}
function rowToOutbox(r: Record<string, any>): OutboxRecord {
  return {
    id: r.id,
    tenantId: r.tenantId,
    punchEventId: r.punchEventId ?? undefined,
    kind: r.kind as OutboxRow['kind'],
    payload: r.payload,
    status: r.status,
    trackingId: r.trackingId ?? undefined,
    attempts: r.attempts,
    lastError: r.lastError ?? undefined,
    submittedAt: r.submittedAt ?? undefined,
    resolvedAt: r.resolvedAt ?? undefined,
    availableAt: 0, // re-armed for immediate retry after a restart
    createdAt: r.createdAt,
  };
}
