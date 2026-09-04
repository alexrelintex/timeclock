/**
 * AdapterRegistry — resolves a tenant to its HrisAdapter for the outbox worker.
 * Tenants with no HRIS configured resolve to null: drainTenant() then leaves
 * their events internal (break/lunch NEVER sync anyway; IN/OUT just stay in-app).
 *
 * A tenant with hrisProvider='paycor' and full config gets a live PaycorAdapter
 * driven by PaycorTokenProvider. The demo tenant has no provider, so the whole
 * system runs end-to-end with zero external credentials.
 */
import { PaycorAdapter, type AdapterRegistry, type HrisAdapter } from '@timeclock/hris';
import type { MemoryDb } from '../db.js';
import { PaycorTokenProvider, type PaycorOAuthConfig } from './tokenProvider.js';
import { MockHrisAdapter } from './mockAdapter.js';
import type { PaycorTenantConfig } from '@timeclock/hris';

export interface PaycorHrisConfig {
  oauth: PaycorOAuthConfig;
  tenant: PaycorTenantConfig;
}

export class TenantAdapterRegistry implements AdapterRegistry {
  private cache = new Map<string, HrisAdapter>();
  constructor(private db: MemoryDb) {}

  async forTenant(tenantId: string): Promise<HrisAdapter | null> {
    const cached = this.cache.get(tenantId);
    if (cached) return cached;

    const tenant = this.db.getTenant(tenantId);
    if (!tenant || !tenant.hrisProvider) return null;

    // Demo/dev provider: a canned roster + accept-and-deliver writes.
    if (tenant.hrisProvider === 'mock') {
      const adapter = new MockHrisAdapter();
      this.cache.set(tenantId, adapter);
      return adapter;
    }

    if (tenant.hrisProvider !== 'paycor' || !tenant.hrisConfig) return null;

    // hrisConfig carries both OAuth activation record and write config.
    const cfg = tenant.hrisConfig as unknown as PaycorHrisConfig;
    if (!cfg.oauth || !cfg.tenant) return null;

    const tokens = new PaycorTokenProvider(cfg.oauth);
    const adapter = new PaycorAdapter(cfg.tenant, tokens);
    this.cache.set(tenantId, adapter);
    return adapter;
  }
}
