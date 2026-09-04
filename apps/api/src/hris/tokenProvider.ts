/**
 * Injection point #1 — Paycor OAuth TokenProvider (activation flow).
 *
 * Paycor uses OAuth2 with a refresh-token grant obtained during app activation
 * (Marketplace). We hold the refresh token per tenant and exchange it for a
 * short-lived access token, caching until ~60s before expiry. The exact token
 * endpoint + client credentials come from the activation record; they are
 * injected here so no secret is hard-coded.
 *
 * Implements @timeclock/hris TokenProvider: getAccessToken() / invalidate().
 */
import type { TokenProvider } from '@timeclock/hris';

export interface PaycorOAuthConfig {
  tokenUrl: string; // e.g. https://apis.paycor.com/sts/v1/common/oauth2/token (confirm at activation)
  clientId: string;
  clientSecret: string;
  refreshToken: string; // obtained during Marketplace activation
  subscriptionKey: string; // Ocp-Apim-Subscription-Key, also required on token call
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

export class PaycorTokenProvider implements TokenProvider {
  private cached: CachedToken | null = null;
  private inflight: Promise<string> | null = null;

  constructor(
    private cfg: PaycorOAuthConfig,
    private fetchImpl: typeof fetch = fetch,
    private now: () => number = () => Date.now(),
  ) {}

  invalidate(): void {
    this.cached = null;
  }

  async getAccessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAtMs - 60_000 > this.now()) {
      return this.cached.accessToken;
    }
    // Coalesce concurrent refreshes so a burst of drains makes one token call.
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refresh(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.cfg.refreshToken,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
    });
    const res = await this.fetchImpl(this.cfg.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Ocp-Apim-Subscription-Key': this.cfg.subscriptionKey,
        Accept: 'application/json',
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Paycor token refresh failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      access_token: string;
      expires_in?: number;
      refresh_token?: string;
    };
    // Paycor rotates refresh tokens; persist the new one if returned.
    if (json.refresh_token) this.cfg.refreshToken = json.refresh_token;
    const ttlMs = (json.expires_in ?? 3600) * 1000;
    this.cached = { accessToken: json.access_token, expiresAtMs: this.now() + ttlMs };
    return json.access_token;
  }

  /** Expose the current refresh token so the caller can persist rotation. */
  currentRefreshToken(): string {
    return this.cfg.refreshToken;
  }
}
