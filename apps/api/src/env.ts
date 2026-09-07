/**
 * Configuration. Fails at boot on anything missing rather than at the first punch.
 * No secret has a default.
 */

export interface Env {
  port: number;
  logLevel: string;
  /** Origins allowed to call the API (the CRM origins + the widget origin). */
  allowedOrigins: string[];

  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  /**
   * Secret used to SIGN the short-lived session JWT the API sends to PostgREST.
   *
   * Today this is the project's legacy HS256 JWT secret, because Supabase's
   * third-party auth only accepts a fixed provider list (Clerk, Firebase, Auth0,
   * Cognito, WorkOS) — there is no "register my own JWKS" option, so a CRM cannot
   * be the issuer directly. The token never leaves this process and lives <= 5
   * minutes. If/when the project rotates to asymmetric signing keys, swap this
   * for the private key and set sessionJwtAlg to ES256/RS256; nothing else changes.
   * Refs: https://supabase.com/docs/guides/auth/jwts
   *       https://supabase.com/docs/guides/auth/signing-keys
   *       https://supabase.com/docs/guides/auth/third-party/overview
   */
  supabaseJwtSecret: string;
  sessionJwtIssuer: string;
  sessionTtlSeconds: number;
  /**
   * Hand the session JWT to the browser so the widget can open a Supabase Realtime
   * channel directly. Safe in principle — it is a <=5 min token and RLS scopes
   * everything it can reach — but off by default: the SSE feed covers the same
   * ground without putting a database credential in the page.
   */
  exposeSessionToken: boolean;

  /** Host CRM assertion verification (CLAUDE.md decision #5). */
  hostJwksUrl: string;
  hostIssuer: string;
  hostAudience: string;
  /** Reject an assertion older than this even if exp is generous. */
  hostMaxTokenAgeSeconds: number;
  /** Trust the host's claim that a user is a supervisor? Default false: the
   *  database's agent.is_supervisor is authoritative. */
  trustHostSupervisorClaim: boolean;
  /** Create an agent row on first verified assertion. */
  autoProvisionAgents: boolean;

  /** Direct Postgres URL, used only for LISTEN/NOTIFY -> SSE. Optional. */
  databaseUrl?: string;

  /** Shared secret for /internal/* (pg_cron + pg_net, or your scheduler). */
  workerSecret: string;
  runWorkerInProcess: boolean;
  workerIntervalMs: number;
  sweepIntervalMs: number;

  paycor: {
    subscriptionKey?: string;
    tokenUrl?: string;
    clientId?: string;
    clientSecret?: string;
    scope?: string;
  };
}

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`missing required env var ${name}`);
  return v.trim();
}
function opt(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}
function num(name: string, dflt: number): number {
  const v = opt(name);
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env var ${name} must be a number, got ${v}`);
  return n;
}
function bool(name: string, dflt: boolean): boolean {
  const v = opt(name)?.toLowerCase();
  if (v === undefined) return dflt;
  return v === '1' || v === 'true' || v === 'yes';
}

export function loadEnv(): Env {
  const ttl = num('SESSION_TTL_SECONDS', 300);
  if (ttl > 300) {
    // CLAUDE.md decision #5 caps the assertion lifetime at five minutes; the
    // session token it produces must not outlive it.
    throw new Error('SESSION_TTL_SECONDS must be <= 300');
  }
  return {
    port: num('PORT', 8080),
    logLevel: opt('LOG_LEVEL') ?? 'info',
    allowedOrigins: (opt('ALLOWED_ORIGINS') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),

    supabaseUrl: req('SUPABASE_URL'),
    supabaseAnonKey: req('SUPABASE_ANON_KEY'),
    supabaseServiceRoleKey: req('SUPABASE_SERVICE_ROLE_KEY'),
    supabaseJwtSecret: req('SUPABASE_JWT_SECRET'),
    sessionJwtIssuer: opt('SESSION_JWT_ISSUER') ?? 'timeclock-api',
    sessionTtlSeconds: ttl,
    exposeSessionToken: bool('EXPOSE_SESSION_TOKEN', false),

    hostJwksUrl: req('HOST_JWKS_URL'),
    hostIssuer: req('HOST_ISSUER'),
    hostAudience: opt('HOST_AUDIENCE') ?? 'timeclock-widget',
    hostMaxTokenAgeSeconds: num('HOST_MAX_TOKEN_AGE_SECONDS', 300),
    trustHostSupervisorClaim: bool('TRUST_HOST_SUPERVISOR_CLAIM', false),
    autoProvisionAgents: bool('AUTO_PROVISION_AGENTS', true),

    ...(opt('DATABASE_URL') ? { databaseUrl: opt('DATABASE_URL') } : {}),

    workerSecret: req('WORKER_SECRET'),
    runWorkerInProcess: bool('RUN_WORKER_IN_PROCESS', true),
    workerIntervalMs: num('WORKER_INTERVAL_MS', 15_000),
    sweepIntervalMs: num('SWEEP_INTERVAL_MS', 300_000),

    paycor: {
      ...(opt('PAYCOR_SUBSCRIPTION_KEY') ? { subscriptionKey: opt('PAYCOR_SUBSCRIPTION_KEY') } : {}),
      ...(opt('PAYCOR_TOKEN_URL') ? { tokenUrl: opt('PAYCOR_TOKEN_URL') } : {}),
      ...(opt('PAYCOR_CLIENT_ID') ? { clientId: opt('PAYCOR_CLIENT_ID') } : {}),
      ...(opt('PAYCOR_CLIENT_SECRET') ? { clientSecret: opt('PAYCOR_CLIENT_SECRET') } : {}),
      ...(opt('PAYCOR_SCOPE') ? { scope: opt('PAYCOR_SCOPE') } : {}),
    },
  };
}
