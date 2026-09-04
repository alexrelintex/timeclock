/**
 * Transactional-outbox drain worker (provider-agnostic).
 * Core services write PunchEvent + HrisOutbox rows in ONE db transaction;
 * this worker batches PENDING rows per tenant, filters by adapter capability,
 * pushes, and tracks two-phase resolution for async providers.
 *
 * Persistence is injected so this stays ORM-agnostic (Prisma impl in apps/api).
 */

import {
  CanonicalPunch,
  filterForProvider,
  HrisAdapter,
  PushOutcome,
} from './adapter';

export interface OutboxRow {
  id: string;
  tenantId: string;
  kind: 'PUNCH' | 'PAY_ITEM' | 'MISSED_PUNCH_REQUEST' | 'MISSED_PUNCH_DECISION';
  payload: unknown;
  attempts: number;
}

export interface OutboxStore {
  claimPending(tenantId: string, kind: OutboxRow['kind'], limit: number): Promise<OutboxRow[]>;
  markSubmitted(ids: string[], trackingId: string): Promise<void>;
  markDelivered(ids: string[]): Promise<void>;
  markNotSupported(ids: string[]): Promise<void>;
  markFailed(ids: string[], error: string, retryable: boolean, retryAfterMs?: number): Promise<void>;
  /** SUBMITTED rows awaiting error-log resolution, grouped by trackingId. */
  listSubmitted(tenantId: string): Promise<{ trackingId: string; ids: string[] }[]>;
  markResolved(trackingId: string, perRecordErrors: { recordRef: string; message: string }[]): Promise<void>;
}

export interface AdapterRegistry {
  forTenant(tenantId: string): Promise<HrisAdapter | null>;
}

const BATCH = 100; // aligns with the strictest verified provider cap

export async function drainTenant(
  tenantId: string,
  store: OutboxStore,
  registry: AdapterRegistry,
): Promise<void> {
  const adapter = await registry.forTenant(tenantId);
  if (!adapter) return; // tenant has no HRIS configured — events stay internal

  // --- punches
  if (adapter.supportsPunchWrite()) {
    const rows = await store.claimPending(tenantId, 'PUNCH', BATCH);
    if (rows.length) {
      const canonical = rows.map((r) => r.payload as CanonicalPunch);
      const eligible = filterForProvider(adapter, canonical);
      const eligibleIds = new Set(eligible.map((p) => p.punchEventId));
      const skipped = rows.filter((r) => !eligibleIds.has((r.payload as CanonicalPunch).punchEventId));
      if (skipped.length) await store.markNotSupported(skipped.map((r) => r.id));

      const sendRows = rows.filter((r) => eligibleIds.has((r.payload as CanonicalPunch).punchEventId));
      if (sendRows.length) {
        const outcome = await adapter.pushPunches(eligible);
        await applyOutcome(outcome, sendRows.map((r) => r.id), store);
      }
    }
  } else {
    const rows = await store.claimPending(tenantId, 'PUNCH', BATCH);
    if (rows.length) await store.markNotSupported(rows.map((r) => r.id));
  }

  // --- pay items (e.g. CA §226.7 premium hours)
  if (adapter.supportsPayItems()) {
    const rows = await store.claimPending(tenantId, 'PAY_ITEM', BATCH);
    if (rows.length) {
      const outcome = await adapter.pushPayItems(rows.map((r) => r.payload as never));
      await applyOutcome(outcome, rows.map((r) => r.id), store);
    }
  }

  // --- missed punch round trip
  if (adapter.supportsMissedPunchWorkflow()) {
    for (const kind of ['MISSED_PUNCH_REQUEST', 'MISSED_PUNCH_DECISION'] as const) {
      const rows = await store.claimPending(tenantId, kind, BATCH);
      if (!rows.length) continue;
      const outcome =
        kind === 'MISSED_PUNCH_REQUEST'
          ? await adapter.pushMissedPunchProposals(rows.map((r) => r.payload as never))
          : await adapter.pushMissedPunchDecisions(rows.map((r) => r.payload as never));
      await applyOutcome(outcome, rows.map((r) => r.id), store);
    }
  }

  // --- resolve async submissions (two-phase)
  for (const sub of await store.listSubmitted(tenantId)) {
    const resolution = await adapter.resolveSubmission(sub.trackingId);
    if (resolution.resolved) {
      await store.markResolved(sub.trackingId, resolution.perRecordErrors);
    }
  }
}

async function applyOutcome(outcome: PushOutcome, ids: string[], store: OutboxStore): Promise<void> {
  switch (outcome.kind) {
    case 'DELIVERED':
      return store.markDelivered(ids);
    case 'SUBMITTED':
      return store.markSubmitted(ids, outcome.trackingId);
    case 'FAILED':
      return store.markFailed(ids, outcome.error, outcome.retryable, outcome.retryAfterMs);
  }
}
