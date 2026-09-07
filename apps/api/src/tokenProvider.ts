/**
 * TokenProvider — injection point #1 from CLAUDE.md.
 *
 * Paycor auth is a bearer JWT plus the Ocp-Apim-Subscription-Key header (Azure
 * APIM). The subscription key is verified and comes from tenant config; the TOKEN
 * ENDPOINT is the piece that was never confirmed from the OpenAPI export, so it is
 * configuration here rather than a hardcoded URL:
 *
 *   PAYCOR_TOKEN_URL       e.g. https://.../oauth/token   <- confirm in the portal
 *   PAYCOR_CLIENT_ID
 *   PAYCOR_CLIENT_SECRET
 *   PAYCOR_SCOPE           optional
 *
 * The shape implemented is OAuth2 client_credentials, which is what Paycor's
 * activation flow issues against. If the tenant activation flow turns out to hand
 * back a refresh token instead, replace exchange() only — the interface, the
 * caching and the 401 invalidation path all stay.
 *
 * Until the endpoint is configured this throws a message that says exactly what is
 * missing, rather than failing deep inside an HTTP call.
 */

import type { TokenProvider } from '../../../packages/hris/src/adapter';

export interface OAuthClientCredentialsConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  /** Refresh this many seconds before expiry. */
  skewSeconds?: number;
  fetchImpl?: typeof fetch;
}

export class ClientCredentialsTokenProvider implements TokenProvider {
  private token: string | null = null;
  private expiresAt = 0;
  private inflight: Promise<string> | null = null;

  constructor(private readonly cfg: OAuthClientCredentialsConfig) {}

  async getAccessToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt) return this.token;
    // Collapse concurrent refreshes: a batch drain would otherwise ask N times.
    if (this.inflight) return this.inflight;
    this.inflight = this.exchange().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  invalidate(): void {
    this.token = null;
    this.expiresAt = 0;
  }

  private async exchange(): Promise<string> {
    const doFetch = this.cfg.fetchImpl ?? fetch;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      ...(this.cfg.scope ? { scope: this.cfg.scope } : {}),
    });
    const res = await doFetch(this.cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
    if (!res.ok) {
      throw new Error(`token endpoint ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('token endpoint returned no access_token');
    const ttl = Number(json.expires_in ?? 3600);
    const skew = this.cfg.skewSeconds ?? 60;
    this.token = json.access_token;
    this.expiresAt = Date.now() + Math.max(30, ttl - skew) * 1000;
    return this.token;
  }
}

/** Placeholder used until the endpoint is configured, so the failure is legible. */
export class UnconfiguredTokenProvider implements TokenProvider {
  constructor(private readonly tenantId: string) {}
  async getAccessToken(): Promise<string> {
    throw new Error(
      `tenant ${this.tenantId}: HRIS token endpoint not configured. ` +
        'Set PAYCOR_TOKEN_URL, PAYCOR_CLIENT_ID and PAYCOR_CLIENT_SECRET, or clear ' +
        'tenant.hris_provider to keep this tenant internal-only.',
    );
  }
  invalidate(): void {
    /* nothing cached */
  }
}
