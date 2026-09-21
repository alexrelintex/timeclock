/**
 * Injection point #1 — Paycor OAuth TokenProvider (AuthenticationSupport flow).
 *
 * Paycor's OAuth lives under the AuthenticationSupport API: a refresh token
 * (obtained once during Marketplace app activation via the authorization-code
 * exchange) is POSTed as JSON to
 *   {tokenUrl}  e.g. https://apis.paycor.com/v1/authenticationsupport/retrieveAccessTokenWithRefreshToken
 * with the Ocp-Apim-Subscription-Key header, and Paycor returns a short-lived
 * access token PLUS a NEW refresh token (single-use rotation). We cache the access
 * token until ~60s before expiry and must persist the rotated refresh token —
 * `onRotate` writes it back to the tenant's hrisConfig, or the next exchange fails.
 *
 * Implements @timeclock/hris TokenProvider: getAccessToken() / invalidate().
 */
import type { TokenProvider } from '@timeclock/hris';

export interface PaycorOAuthConfig {
  /** Full AuthenticationSupport endpoint (retrieveAccessTokenWithRefreshToken). */
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string; // from Marketplace activation; rotates on every exchange
  subscriptionKey: string; // Ocp-Apim-Subscription-Key
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
    /** Persist the rotated (new) refresh token — Paycor invalidates the old one. */
    private onRotate: (newRefreshToken: string) => void = () => {},
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
    const res = await this.fetchImpl(this.cfg.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': this.cfg.subscriptionKey,
        Accept: 'application/json',
      },
      // Paycor's AuthenticationSupport endpoint takes JSON with snake_case keys
      // (verified live: camelCase JSON → 400 "client_id/client_secret/refresh_token
      // required"; form-encoded → 415). Response is read tolerantly below.
      body: JSON.stringify({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        refresh_token: this.cfg.refreshToken,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Paycor token refresh failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as Record<string, unknown>;
    // Paycor's token response has been seen both snake_case (OAuth-standard) and
    // camelCase; accept either so a schema tweak doesn't silently break auth.
    const accessToken = (json.access_token ?? json.accessToken) as string | undefined;
    const newRefresh = (json.refresh_token ?? json.refreshToken) as string | undefined;
    const expiresIn = (json.expires_in ?? json.expiresIn) as number | undefined;
    if (!accessToken) {
      throw new Error(`Paycor token refresh: no access token in response (${JSON.stringify(json).slice(0, 200)})`);
    }
    // Single-use rotation: persist the NEW refresh token or the next refresh fails.
    if (newRefresh && newRefresh !== this.cfg.refreshToken) {
      this.cfg.refreshToken = newRefresh;
      this.onRotate(newRefresh);
    }
    // Paycor access tokens live ~30 min; trust the response's expires_in, and fall
    // back to 30 min (not longer) so we never serve a token past its real expiry.
    const ttlMs = (expiresIn ?? 1800) * 1000;
    this.cached = { accessToken, expiresAtMs: this.now() + ttlMs };
    return accessToken;
  }

  /** Expose the current refresh token so the caller can persist rotation. */
  currentRefreshToken(): string {
    return this.cfg.refreshToken;
  }
}
