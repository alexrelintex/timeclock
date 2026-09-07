/**
 * HRIS connector catalog — the single source of truth for every connector the
 * master image ships. One build, many connectors; which one a tenant uses (and
 * its config) is administered per tenant via tenant.hrisProvider + hrisConfig.
 *
 * Add a connector here (factory + config schema) and it is instantly available to
 * every tenant to select — no per-tenant code, no image fork.
 */
import {
  GustoAdapter,
  PaycorAdapter,
  type HrisAdapter,
  type PaycorTenantConfig,
} from '@timeclock/hris';
import { MockHrisAdapter } from './mockAdapter.js';
import { PaycorTokenProvider } from './tokenProvider.js';
import { GustoTokenProvider } from './gustoTokenProvider.js';
import type { Store } from '../store/contract.js';
import type { Tenant } from '../types.js';

export interface ConfigField {
  key: string;
  label: string;
  secret?: boolean;
}
export interface ConnectorInfo {
  provider: string;
  label: string;
  syncsPunches: boolean;
  configFields: ConfigField[];
  /** Build the live adapter from the tenant's config, or null if not configured. */
  build(tenant: Tenant, db: Store): HrisAdapter | null;
}

const cfgOf = (t: Tenant): Record<string, unknown> => (t.hrisConfig ?? {}) as Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

export const CONNECTORS: Record<string, ConnectorInfo> = {
  none: {
    provider: 'none',
    label: 'None — events stay internal',
    syncsPunches: false,
    configFields: [],
    build: () => null,
  },

  mock: {
    provider: 'mock',
    label: 'Mock HRIS (demo)',
    syncsPunches: true,
    configFields: [],
    build: () => new MockHrisAdapter(),
  },

  paycor: {
    provider: 'paycor',
    label: 'Paycor',
    syncsPunches: true,
    configFields: [
      { key: 'legalEntityId', label: 'Legal entity ID' },
      { key: 'subscriptionKey', label: 'Ocp-Apim subscription key', secret: true },
      { key: 'tokenUrl', label: 'OAuth token URL' },
      { key: 'clientId', label: 'Client ID' },
      { key: 'clientSecret', label: 'Client secret', secret: true },
      { key: 'refreshToken', label: 'Refresh token', secret: true },
      { key: 'mealPremiumEarningId', label: 'Meal-premium earning ID (optional)' },
    ],
    build(tenant) {
      const c = cfgOf(tenant);
      if (!c.legalEntityId || !c.subscriptionKey || !c.refreshToken) return null;
      const tokens = new PaycorTokenProvider({
        tokenUrl: str(c.tokenUrl),
        clientId: str(c.clientId),
        clientSecret: str(c.clientSecret),
        refreshToken: str(c.refreshToken),
        subscriptionKey: str(c.subscriptionKey),
      });
      const cfg: PaycorTenantConfig = {
        legalEntityId: Number(c.legalEntityId),
        subscriptionKey: str(c.subscriptionKey),
        employeeWriteConfig: (c.employeeWriteConfig as PaycorTenantConfig['employeeWriteConfig']) ?? {},
        ...(c.mealPremiumEarningId ? { mealPremiumEarningId: str(c.mealPremiumEarningId) } : {}),
      };
      return new PaycorAdapter(cfg, tokens);
    },
  },

  gusto: {
    provider: 'gusto',
    label: 'Gusto',
    syncsPunches: true,
    configFields: [
      { key: 'companyUuid', label: 'Company UUID' },
      { key: 'clientId', label: 'Client ID' },
      { key: 'clientSecret', label: 'Client secret', secret: true },
      { key: 'refreshToken', label: 'Refresh token', secret: true },
      { key: 'demo', label: 'Use demo API (true/false)' },
    ],
    build(tenant, db) {
      const c = cfgOf(tenant);
      if (!c.companyUuid || !c.refreshToken) return null;
      const demo = c.demo === true || c.demo === 'true';
      const base = demo ? 'https://api.gusto-demo.com' : 'https://api.gusto.com';
      const tokens = new GustoTokenProvider(
        {
          tokenUrl: `${base}/oauth/token`,
          clientId: str(c.clientId),
          clientSecret: str(c.clientSecret),
          refreshToken: str(c.refreshToken),
        },
        // Persist Gusto's single-use rotated refresh token back to tenant config.
        (newRefresh) => db.updateTenantHrisConfig(tenant.id, { refreshToken: newRefresh }),
      );
      return new GustoAdapter({ companyUuid: str(c.companyUuid), baseUrl: base }, tokens);
    },
  },
};

/** Public list for the admin UI — config field values are never included. */
export function catalogList() {
  return Object.values(CONNECTORS).map((c) => ({
    provider: c.provider,
    label: c.label,
    syncsPunches: c.syncsPunches,
    configFields: c.configFields.map((f) => ({ key: f.key, label: f.label, secret: !!f.secret })),
  }));
}

/** Resolve a tenant to its live adapter via the catalog. */
export function buildAdapter(tenant: Tenant, db: Store): HrisAdapter | null {
  const info = CONNECTORS[tenant.hrisProvider ?? 'none'] ?? CONNECTORS.none;
  return info.build(tenant, db);
}
