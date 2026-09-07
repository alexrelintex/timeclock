/**
 * The Store contract — the full persistence surface Time-Clock's app/domain use.
 *
 * It extends the two domain ports (PunchStore, OutboxStore) and adds the directory,
 * event, exception, and schedule accessors. Every STORE_DRIVER (memory / postgres /
 * embedded) implements THIS interface; nothing above the store depends on a concrete
 * driver. See docs/adr/0001-storage-drivers-and-crm-isolation.md.
 *
 * Whatever the driver, this data is Time-Clock's own system of record and stays
 * isolated from any CRM/HRIS — no cross-schema writes, no DB-level foreign keys out.
 */
import type { EventEmitter } from 'node:events';
import type { PunchStore } from '@timeclock/core';
import type { OutboxStore, OutboxRow } from '@timeclock/hris';
import type {
  Agent,
  ComplianceException,
  OutboxStatus,
  PunchEvent,
  ScheduleExceptionRow,
  SchedulePatternRow,
  Tenant,
} from '../types.js';

export type StoreDriver = 'memory' | 'postgres' | 'embedded';

export interface Store extends PunchStore, OutboxStore {
  /** Change bus for SSE fan-out (one 'change' event per mutation). */
  readonly bus: EventEmitter;

  /**
   * Optional one-time async warm-up. Durable drivers (postgres/embedded) load
   * their persisted state into the in-memory projection here so the synchronous
   * read surface below is served without a per-call round-trip. The memory driver
   * has nothing to do. The server awaits this once before it starts listening.
   */
  init?(): Promise<void>;

  /**
   * Wait for all pending write-throughs to reach the backing store. Durable
   * drivers persist directory/schedule mutations fire-and-forget for a synchronous
   * API; a batch job or a graceful shutdown calls this so nothing in flight is lost
   * on exit. The memory driver has nothing to flush.
   */
  flush?(): Promise<void>;

  // ---- directory: tenants
  upsertTenant(t: Tenant): Tenant;
  getTenant(id: string): Tenant | undefined;
  listTenants(): Tenant[];
  setTenantHris(tenantId: string, provider: string | null, config: Record<string, unknown> | null): Tenant | undefined;
  updateTenantHrisConfig(tenantId: string, patch: Record<string, unknown>): void;

  // ---- directory: agents
  upsertAgent(a: Agent): Agent;
  getAgent(id: string): Agent | undefined;
  listAgents(tenantId: string): Agent[];
  listAllAgents(tenantId: string): Agent[];
  agentByHostUserId(tenantId: string, hostUserId: string): Agent | undefined;
  agentByHrisEmployeeId(tenantId: string, hrisEmployeeId: string): Agent | undefined;
  /** Identity resolution by email — the CRM<->Time-Clock connection key. */
  agentByEmail(tenantId: string, email: string): Agent | undefined;
  /** One-time "connect": bind a CRM hostUserId (+ email) to an existing agent. */
  linkHostUser(agentId: string, hostUserId: string, email?: string): Agent | undefined;
  departments(tenantId: string): string[];

  // ---- punch events
  agentEvents(agentId: string): PunchEvent[];
  tenantEvents(tenantId: string): PunchEvent[];
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
  }): string;
  eventsOnLocalDate(
    tenantId: string,
    localDate: string,
    opts?: { agentId?: string; department?: string },
  ): PunchEvent[];

  // ---- outbox producers (consumers are the OutboxStore port methods)
  enqueueOutbox(args: {
    tenantId: string;
    punchEventId?: string;
    kind: OutboxRow['kind'];
    payload: unknown;
  }): string;
  outboxSnapshot(tenantId: string): { status: OutboxStatus; kind: string; lastError?: string }[];

  // ---- compliance exceptions
  upsertException(
    x: Omit<ComplianceException, 'id' | 'detectedAt' | 'status'> &
      Partial<Pick<ComplianceException, 'status'>>,
  ): ComplianceException;
  getException(id: string): ComplianceException | undefined;
  listOpenExceptions(tenantId: string): ComplianceException[];
  markPremiumDelivered(exceptionId: string): void;
  resolveException(id: string, byId: string, resolution: string): ComplianceException | undefined;

  // ---- scheduler
  setPattern(agentId: string, rows: SchedulePatternRow[]): void;
  getPattern(agentId: string): SchedulePatternRow[];
  patternForWeekday(agentId: string, weekday: number): SchedulePatternRow | undefined;
  setScheduleException(row: ScheduleExceptionRow): void;
  clearScheduleException(agentId: string, date: string): boolean;
  getScheduleException(agentId: string, date: string): ScheduleExceptionRow | undefined;
}
