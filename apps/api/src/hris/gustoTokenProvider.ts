/**
 * Gusto OAuth2 TokenProvider (App Integrations API).
 *
 * Authorization-code flow: the tenant admin authorizes once (per company) and we
 * store the resulting refresh token. Gusto refresh tokens are SINGLE-USE and
 * rotate on every exchange — each refresh returns a NEW access+refresh pair, and
 * the old refresh token is invalidated. So we must persist the rotated refresh
 * token; `onRotate` is the hook to write it back to the tenant's hrisConfig.
 *
 * Implements @timeclock/hris TokenProvider: getAccessToken() / invalidate().
 */
import type { TokenProvider } from '@timeclock/hris';

export interface GustoOAuthConfig {
  tokenUrl: string; // e.g. https://api.gusto.com/oauth/token (demo: api.gusto-demo.com)
  clientId: string;
  clientSecret: string;
  refreshToken: string; // from the authorization-code exchange; rotates on refresh
}

export class GustoTokenProvider implements TokenProvider {
  private cached: { accessToken: string; expiresAtMs: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(
    private cfg: GustoOAuthConfig,
    /** Persist the rotated (new) refresh token — Gusto invalidates the old one. */
    private onRotate: (newRefreshToken: string) => void = () => {},
    private fetchImpl: typeof fetch = fetch,
    private now: () => number = () => Date.now(),
  ) {}

  invalidate(): void {
    this.cached = null;
  }

  async getAccessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAtMs - 60_000 > this.now()) return this.cached.accessToken;
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refresh(): Promise<string> {
    const res = await this.fetchImpl(this.cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: this.cfg.refreshToken,
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gusto token refresh failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      access_token: string;
      expires_in?: number;
      refresh_token?: string;
    };
    // Single-use rotation: persist the NEW refresh token or the next refresh 401s.
    if (json.refresh_token && json.refresh_token !== this.cfg.refreshToken) {
      this.cfg.refreshToken = json.refresh_token;
      this.onRotate(json.refresh_token);
    }
    const ttlMs = (json.expires_in ?? 7200) * 1000; // Gusto access tokens ~2h
    this.cached = { accessToken: json.access_token, expiresAtMs: this.now() + ttlMs };
    return json.access_token;
  }

  currentRefreshToken(): string {
    return this.cfg.refreshToken;
  }
}
