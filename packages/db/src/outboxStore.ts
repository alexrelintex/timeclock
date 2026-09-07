/**
 * OutboxStore backed by the tc_api worker RPCs.
 *
 * Implements the interface in packages/hris/src/outboxWorker.ts verbatim, so the
 * provider-agnostic drain logic written before the Supabase decision runs
 * unchanged. That was the point of injecting persistence there.
 *
 * Every call goes through the service_role client: claiming and resolving outbox
 * rows is the one thing an agent identity must never be able to do.
 */

import type { OutboxRow, OutboxStore, AdapterRegistry } from '../../hris/src/outboxWorker';
import type { HrisAdapter, TokenProvider } from '../../hris/src/adapter';
import { PaycorAdapter, type PaycorTenantConfig } from '../../hris/src/paycor/adapter';
import type { TimeclockDb } from './client';

export class SupabaseOutboxStore implements OutboxStore {
  constructor(private readonly db: TimeclockDb) {}

  async claimPending(
    tenantId: string,
    kind: OutboxRow['kind'],
    limit: number,
  ): Promise<OutboxRow[]> {
    const rows = await this.db.call<
      { id: string; tenantId: string; kind: OutboxRow['kind']; payload: unknown; attempts: number }[]
    >(this.db.admin(), 'outbox_claim', {
      p_tenant_id: tenantId,
      p_kind: kind,
      p_limit: limit,
    });
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenantId,
      kind: r.kind,
      payload: r.payload,
      attempts: r.attempts,
    }));
  }

  async markSubmitted(ids: string[], trackingId: string): Promise<void> {
    if (!ids.length) return;
    await this.db.call(this.db.admin(), 'outbox_mark_submitted', {
      p_ids: ids,
      p_tracking_id: trackingId,
    });
  }

  async markDelivered(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.db.call(this.db.admin(), 'outbox_mark_delivered', { p_ids: ids });
  }

  async markNotSupported(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.db.call(this.db.admin(), 'outbox_mark_not_supported', { p_ids: ids });
  }

  async markFailed(
    ids: string[],
    error: string,
    retryable: boolean,
    retryAfterMs?: number,
  ): Promise<void> {
    if (!ids.length) return;
    await this.db.call(this.db.admin(), 'outbox_mark_failed', {
      p_ids: ids,
      p_error: error,
      p_retryable: retryable,
      p_retry_after_ms: retryAfterMs ?? null,
    });
  }

  async listSubmitted(tenantId: string): Promise<{ trackingId: string; ids: string[] }[]> {
    return this.db.call<{ trackingId: string; ids: string[] }[]>(
      this.db.admin(),
      'outbox_list_submitted',
      { p_tenant_id: tenantId },
    );
  }

  async markResolved(
    trackingId: string,
    perRecordErrors: { recordRef: string; message: string }[],
  ): Promise<void> {
    await this.db.call(this.db.admin(), 'outbox_mark_resolved', {
      p_tracking_id: trackingId,
      p_errors: perRecordErrors,
    });
  }
}

/**
 * Resolves the tenant's HRIS adapter from tc_api.tenant_hris_config.
 *
 * The per-employee departmentId/activityTypeId map that Paycor requires on every
 * punch write is assembled in SQL from the agent rows, so adding an agent does not
 * mean redeploying a config file. A tenant with hris_provider null gets a null
 * adapter and the worker leaves its events internal — the correct behaviour for a
 * CRM tenant that has not connected payroll yet.
 */
export class SupabaseAdapterRegistry implements AdapterRegistry {
  private readonly cache = new Map<string, { adapter: HrisAdapter | null; at: number }>();

  constructor(
    private readonly db: TimeclockDb,
    private readonly tokens: (tenantId: string) => TokenProvider,
    private readonly opts: { subscriptionKey: string; ttlMs?: number } = { subscriptionKey: '' },
  ) {}

  async forTenant(tenantId: string): Promise<HrisAdapter | null> {
    const ttl = this.opts.ttlMs ?? 60_000;
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.at < ttl) return hit.adapter;

    const cfg = await this.db.tenantHrisConfig(tenantId);
    let adapter: HrisAdapter | null = null;

    if (cfg && cfg.provider === 'paycor') {
      const raw = (cfg.config ?? {}) as Record<string, unknown>;
      const legalEntityId = Number(raw.legalEntityId);
      if (!Number.isFinite(legalEntityId)) {
        throw new Error(`tenant ${tenantId}: paycor hris_config.legalEntityId missing or not a number`);
      }
      const employeeWriteConfig: PaycorTenantConfig['employeeWriteConfig'] = {};
      for (const [employeeId, m] of Object.entries(cfg.employeeWriteConfig ?? {})) {
        if (m.departmentId && m.activityTypeId) {
          employeeWriteConfig[employeeId] = {
            departmentId: m.departmentId,
            activityTypeId: m.activityTypeId,
          };
        }
      }
      adapter = new PaycorAdapter(
        {
          legalEntityId,
          subscriptionKey: String(raw.subscriptionKey ?? this.opts.subscriptionKey),
          employeeWriteConfig,
          ...(cfg.premiumEarningRef ? { mealPremiumEarningId: cfg.premiumEarningRef } : {}),
          ...(typeof raw.baseUrl === 'string' ? { baseUrl: raw.baseUrl } : {}),
        },
        this.tokens(tenantId),
      );
    }

    this.cache.set(tenantId, { adapter, at: Date.now() });
    return adapter;
  }

  invalidate(tenantId?: string): void {
    if (tenantId) this.cache.delete(tenantId);
    else this.cache.clear();
  }
}
