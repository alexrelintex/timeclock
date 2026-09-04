/**
 * Injection #4 — production Prisma implementations of the two persistence ports
 * (@timeclock/core PunchStore, @timeclock/hris OutboxStore). These map the exact
 * queries against prisma/schema.prisma. The demo server runs on MemoryDb; swap
 * these in for Postgres by constructing them with a real PrismaClient.
 *
 * To keep the repo typecheckable before `prisma generate` has run, the client is
 * accepted as a structural PrismaLike type rather than importing @prisma/client.
 * At wiring time: `new PrismaPunchStore(new PrismaClient())`.
 */
import type { PunchStore } from '@timeclock/core';
import type { OutboxStore, OutboxRow } from '@timeclock/hris';
import type { PunchEventType, EventSource } from '../types.js';

// --- structural subset of the generated PrismaClient we depend on ---------
interface Delegate {
  create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  findMany(args: Record<string, unknown>): Promise<Record<string, any>[]>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
}
export interface PrismaLike {
  punchEvent: Delegate;
  hrisOutbox: Delegate;
  $transaction<T>(fn: (tx: PrismaLike) => Promise<T>): Promise<T>;
}

export class PrismaPunchStore implements PunchStore {
  constructor(private prisma: PrismaLike) {}

  async loadOpenStream(agentId: string) {
    const rows = (await this.prisma.punchEvent.findMany({
      where: { agentId, status: 'ACTIVE' },
      orderBy: { eventTime: 'asc' },
    })) as { id: string; eventType: PunchEventType; eventTime: Date; status: 'ACTIVE' }[];
    // Trim to the current open shift: everything after the last OUT.
    let start = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].eventType === 'OUT') {
        start = i + 1;
        break;
      }
    }
    return rows.slice(start).map((r) => ({
      id: r.id,
      eventType: r.eventType,
      eventTime: r.eventTime,
      status: r.status,
    }));
  }

  async appendWithOutbox(args: {
    tenantId: string;
    agentId: string;
    eventType: PunchEventType;
    eventTime: Date;
    source: EventSource;
    sessionId?: string;
    note?: string;
    createdById: string;
    outbox: null | { kind: 'PUNCH'; payload: unknown };
  }): Promise<string> {
    // Event + outbox row in ONE transaction — the transactional-outbox guarantee.
    return this.prisma.$transaction(async (tx) => {
      const ev = await tx.punchEvent.create({
        data: {
          tenantId: args.tenantId,
          agentId: args.agentId,
          eventType: args.eventType,
          eventTime: args.eventTime,
          source: args.source,
          sessionId: args.sessionId ?? null,
          note: args.note ?? null,
          createdById: args.createdById,
          status: 'ACTIVE',
        },
      });
      if (args.outbox) {
        const payload = { ...(args.outbox.payload as Record<string, unknown>) };
        if (payload.punchEventId === 'SELF') payload.punchEventId = ev.id;
        await tx.hrisOutbox.create({
          data: {
            tenantId: args.tenantId,
            punchEventId: ev.id,
            kind: args.outbox.kind,
            payload,
            status: 'PENDING',
          },
        });
      }
      return ev.id;
    });
  }
}

export class PrismaOutboxStore implements OutboxStore {
  constructor(private prisma: PrismaLike) {}

  async claimPending(tenantId: string, kind: OutboxRow['kind'], limit: number): Promise<OutboxRow[]> {
    const rows = (await this.prisma.hrisOutbox.findMany({
      where: { tenantId, kind, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    })) as { id: string; tenantId: string; kind: OutboxRow['kind']; payload: unknown; attempts: number }[];
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenantId,
      kind: r.kind,
      payload: r.payload,
      attempts: r.attempts,
    }));
  }

  async markSubmitted(ids: string[], trackingId: string): Promise<void> {
    await this.prisma.hrisOutbox.updateMany({
      where: { id: { in: ids } },
      data: { status: 'SUBMITTED', trackingId, submittedAt: new Date() },
    });
  }
  async markDelivered(ids: string[]): Promise<void> {
    await this.prisma.hrisOutbox.updateMany({
      where: { id: { in: ids } },
      data: { status: 'DELIVERED', resolvedAt: new Date() },
    });
  }
  async markNotSupported(ids: string[]): Promise<void> {
    await this.prisma.hrisOutbox.updateMany({
      where: { id: { in: ids } },
      data: { status: 'NOT_SUPPORTED', resolvedAt: new Date() },
    });
  }
  async markFailed(ids: string[], error: string, retryable: boolean): Promise<void> {
    await this.prisma.hrisOutbox.updateMany({
      where: { id: { in: ids } },
      data: { status: retryable ? 'PENDING' : 'FAILED', lastError: error },
    });
  }
  async listSubmitted(tenantId: string): Promise<{ trackingId: string; ids: string[] }[]> {
    const rows = (await this.prisma.hrisOutbox.findMany({
      where: { tenantId, status: 'SUBMITTED', NOT: { trackingId: null } },
    })) as { id: string; trackingId: string }[];
    const groups = new Map<string, string[]>();
    for (const r of rows) {
      const g = groups.get(r.trackingId) ?? [];
      g.push(r.id);
      groups.set(r.trackingId, g);
    }
    return [...groups.entries()].map(([trackingId, ids]) => ({ trackingId, ids }));
  }
  async markResolved(
    trackingId: string,
    perRecordErrors: { recordRef: string; message: string }[],
  ): Promise<void> {
    const failed = perRecordErrors.length > 0;
    await this.prisma.hrisOutbox.updateMany({
      where: { trackingId, status: 'SUBMITTED' },
      data: {
        status: failed ? 'FAILED' : 'DELIVERED',
        resolvedAt: new Date(),
        lastError: failed ? perRecordErrors.map((e) => e.message).join('; ') : null,
      },
    });
  }
}
