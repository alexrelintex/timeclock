/**
 * AdapterRegistry — resolves a tenant to its HrisAdapter via the connector
 * catalog, and caches the built adapter until the tenant's HRIS config changes.
 *
 * Every connector the image ships lives in ./catalog.ts. A tenant with
 * hrisProvider='none' (or unconfigured) resolves to null: drainTenant() then
 * leaves its events internal.
 */
import type { AdapterRegistry, HrisAdapter } from '@timeclock/hris';
import type { Store } from '../store/contract.js';
import { buildAdapter } from './catalog.js';

export class TenantAdapterRegistry implements AdapterRegistry {
  private cache = new Map<string, HrisAdapter | null>();
  constructor(private db: Store) {}

  async forTenant(tenantId: string): Promise<HrisAdapter | null> {
    if (this.cache.has(tenantId)) return this.cache.get(tenantId)!;
    const tenant = this.db.getTenant(tenantId);
    if (!tenant) return null;
    const adapter = buildAdapter(tenant, this.db);
    this.cache.set(tenantId, adapter);
    return adapter;
  }

  /** Drop the cached adapter so the next drain rebuilds from fresh config. */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }
}
