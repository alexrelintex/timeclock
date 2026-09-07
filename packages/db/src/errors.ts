/**
 * Error translation: Postgres SQLSTATE -> HTTP status.
 *
 * The RPCs raise PTxyz SQLSTATEs, which PostgREST already maps to that HTTP
 * status (https://postgrest.org/en/v12/references/errors.html). apps/api proxies
 * rather than exposing PostgREST directly, so it applies the identical mapping —
 * one rule, two paths, no divergence.
 */

export interface PostgrestLikeError {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

export class TcError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly sqlstate?: string,
    readonly hint?: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'TcError';
  }

  toJSON(): { error: string; message: string; hint?: string; detail?: unknown } {
    let detail: unknown = this.detail;
    if (typeof this.detail === 'string') {
      try {
        detail = JSON.parse(this.detail);
      } catch {
        detail = this.detail;
      }
    }
    return {
      error: this.sqlstate ?? String(this.status),
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(detail === undefined || detail === null ? {} : { detail }),
    };
  }
}

/** SQLSTATEs the schema raises deliberately, plus the ones Postgres raises for us. */
const STATIC_MAP: Record<string, number> = {
  '42501': 401, // insufficient_privilege — missing/invalid claims, or a closed door
  '23001': 409, // restrict_violation — append-only guard tripped
  '23505': 409, // unique_violation — e.g. duplicate client_uuid racing itself
  '23503': 409, // foreign_key_violation
  '23514': 400, // check_violation
  '22P02': 400, // invalid_text_representation
  '40001': 409, // serialization_failure — caller may retry
  '40P01': 409, // deadlock_detected
  '55P03': 503, // lock_not_available
  P0001: 400, // bare RAISE EXCEPTION
};

export function statusForSqlstate(sqlstate: string | null | undefined): number {
  if (!sqlstate) return 500;
  // PTxyz — the schema asked for a specific status.
  if (/^PT\d{3}$/.test(sqlstate)) {
    const code = Number(sqlstate.slice(2));
    return code >= 400 && code <= 599 ? code : 500;
  }
  return STATIC_MAP[sqlstate] ?? 500;
}

export function toTcError(err: PostgrestLikeError, fallbackMessage = 'database error'): TcError {
  const status = statusForSqlstate(err.code);
  return new TcError(
    status,
    err.message ?? fallbackMessage,
    err.code ?? undefined,
    err.hint ?? undefined,
    err.details ?? undefined,
  );
}

/** True when a caller should retry the same request unchanged. */
export function isRetryable(err: unknown): boolean {
  return err instanceof TcError && (err.status === 503 || err.sqlstate === '40001' || err.sqlstate === '40P01');
}
