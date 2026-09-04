/**
 * Gusto adapter — implements HrisAdapter against the Gusto **App Integrations API**
 * (docs.gusto.com/app-integrations). Verified surface, 2026-09 analysis:
 *
 *  - Server: https://api.gusto.com (prod) / https://api.gusto-demo.com (demo).
 *  - Auth: OAuth2 authorization-code; access token ~2h; refresh token is
 *    SINGLE-USE and rotates on every refresh (persist the new one). Injected via
 *    TokenProvider — the concrete GustoTokenProvider lives in apps/api.
 *  - Header: `X-Gusto-API-Version` (date-based, e.g. 2024-04-01).
 *
 * The defining difference from Paycor: **Gusto has no raw-punch model and no
 * missed-punch workflow.** It ingests COMPLETED SHIFTS with hours pre-classified
 * as Regular / Overtime / Double-Overtime. So this adapter owns the two seams
 * Paycor never needed:
 *   1. pairPunchesIntoShifts() — turn the IN/OUT stream into closed shifts.
 *   2. classifyHours()         — split each shift's hours into Reg/OT/DoubleOT.
 * Both are marked below; the defaults are deliberately conservative (all Regular,
 * one shift per IN/OUT pair) and MUST be replaced with the tenant's overtime
 * rules before this drives real payroll.
 */
import type {
  CanonicalMissedPunchDecision,
  CanonicalMissedPunchProposal,
  CanonicalPayItem,
  CanonicalPunch,
  HrisAdapter,
  HrisEmployeeRef,
  PushOutcome,
  SubmissionResolution,
  TokenProvider,
} from '../adapter';

export interface GustoTenantConfig {
  companyUuid: string;
  apiVersion?: string; // X-Gusto-API-Version, default '2024-04-01'
  baseUrl?: string; // default prod; demo = https://api.gusto-demo.com
}

const DEFAULT_BASE = 'https://api.gusto.com';
const DEFAULT_VERSION = '2024-04-01';

/** A completed shift ready for Gusto's time_sheets endpoint. */
export interface GustoShift {
  hrisEmployeeId: string;
  startUtc: Date;
  endUtc: Date;
  entries: { hours_worked: number; pay_classification: 'Regular' | 'Overtime' | 'Double Overtime' }[];
}

export class GustoAdapter implements HrisAdapter {
  readonly provider = 'gusto';

  constructor(
    private readonly cfg: GustoTenantConfig,
    private readonly tokens: TokenProvider,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  // Gusto takes classified-shift time, not raw punches; no missed-punch API.
  supportsPunchWrite(): boolean {
    return true;
  }
  supportsBreakPunches(): boolean {
    return false; // breaks/lunch stay internal, same as Paycor
  }
  supportsMissedPunchWorkflow(): boolean {
    return false; // no missed-punch endpoint — corrections stay in-app
  }
  supportsPayItems(): boolean {
    // Premiums have no hourly classification in Gusto; they map to a fixed-DOLLAR
    // `fixed_compensation` on a payroll run, which needs a $ amount + payroll_uuid
    // we don't have at the outbox boundary. Left off until that path is wired.
    return false;
  }

  // ---------------------------------------------------------------- reads
  async listEmployees(cursor?: string): Promise<{ items: HrisEmployeeRef[]; nextCursor?: string }> {
    // VERIFIED: GET /v1/companies/{company_uuid}/employees (paged).
    const params = new URLSearchParams({ per: '100' });
    if (cursor) params.set('page', cursor);
    const res = await this.request('GET', `/v1/companies/${this.cfg.companyUuid}/employees?${params}`);
    if (!res.ok) throw new Error(`Gusto listEmployees failed: HTTP ${res.status}`);
    const body = (await res.json()) as {
      uuid: string;
      first_name?: string;
      last_name?: string;
      email?: string;
      department_uuid?: string;
      jobs?: { uuid: string; primary?: boolean }[];
    }[];
    const items: HrisEmployeeRef[] = (body ?? []).map((e) => ({
      hrisEmployeeId: e.uuid, // Gusto employee UUID is the mapping key
      displayName: [e.first_name, e.last_name].filter(Boolean).join(' ') || undefined,
      email: e.email,
    }));
    // Gusto paginates via Link headers / page params; expose the next page number.
    const next = res.headers.get('x-page')
      ? String(Number(res.headers.get('x-page')) + 1)
      : undefined;
    return { items, nextCursor: items.length === 100 ? next : undefined };
  }

  async readPunchPairs(
    hrisEmployeeId: string,
    fromUtc: Date,
    toUtc: Date,
  ): Promise<{ punchIn: Date | null; punchOut: Date | null; hours: number }[]> {
    // VERIFIED: GET /v1/companies/{company_uuid}/time_tracking/time_sheets returns
    // the shifts we (or Gusto-native time tracking) submitted — usable for
    // "did it land" reconciliation, not device-level punch fidelity.
    const params = new URLSearchParams({
      start_date: fromUtc.toISOString().slice(0, 10),
      end_date: toUtc.toISOString().slice(0, 10),
    });
    const res = await this.request(
      'GET',
      `/v1/companies/${this.cfg.companyUuid}/time_tracking/time_sheets?${params}`,
    );
    if (!res.ok) return [];
    const body = (await res.json()) as {
      entity_uuid?: string;
      shift_started_at?: string;
      shift_ended_at?: string;
      entries?: { hours_worked?: number }[];
    }[];
    return (body ?? [])
      .filter((s) => s.entity_uuid === hrisEmployeeId)
      .map((s) => ({
        punchIn: s.shift_started_at ? new Date(s.shift_started_at) : null,
        punchOut: s.shift_ended_at ? new Date(s.shift_ended_at) : null,
        hours: (s.entries ?? []).reduce((h, e) => h + (e.hours_worked ?? 0), 0),
      }));
  }

  // --------------------------------------------------------------- writes
  async pushPunches(batch: CanonicalPunch[]): Promise<PushOutcome> {
    // Defense in depth: never let break/lunch reach Gusto.
    const inOut = batch.filter((p) => p.type === 'IN' || p.type === 'OUT');
    if (inOut.length === 0) return { kind: 'DELIVERED' };

    // SEAM 1: pair the punch stream into completed shifts.
    const shifts = pairPunchesIntoShifts(inOut);
    if (shifts.length === 0) {
      // Open shift(s) only — wait for the OUT before sending to Gusto.
      return { kind: 'DELIVERED' };
    }

    // Gusto's time_sheets POST is synchronous and one shift per call.
    for (const shift of shifts) {
      const res = await this.request(
        'POST',
        `/v1/companies/${this.cfg.companyUuid}/time_tracking/time_sheets`,
        {
          entity_uuid: shift.hrisEmployeeId,
          entity_type: 'Employee',
          time_zone: 'Etc/UTC',
          shift_started_at: shift.startUtc.toISOString(),
          shift_ended_at: shift.endUtc.toISOString(),
          entries: shift.entries,
        },
      );
      const outcome = this.classifyResponse(res);
      if (outcome.kind === 'FAILED') return outcome; // surface the first failure
    }
    return { kind: 'DELIVERED' };
  }

  async pushPayItems(_batch: CanonicalPayItem[]): Promise<PushOutcome> {
    return {
      kind: 'FAILED',
      retryable: false,
      error:
        'Gusto has no premium-hour earning; premiums must post as a fixed-dollar ' +
        'compensation on a payroll run (fixed_compensations). Not wired yet.',
    };
  }

  async pushMissedPunchProposals(_batch: CanonicalMissedPunchProposal[]): Promise<PushOutcome> {
    return { kind: 'FAILED', retryable: false, error: 'Gusto has no missed-punch API' };
  }
  async pushMissedPunchDecisions(_batch: CanonicalMissedPunchDecision[]): Promise<PushOutcome> {
    return { kind: 'FAILED', retryable: false, error: 'Gusto has no missed-punch API' };
  }

  async resolveSubmission(_trackingId: string): Promise<SubmissionResolution> {
    // time_sheets writes are synchronous — nothing to poll.
    return { resolved: true, perRecordErrors: [] };
  }

  // ------------------------------------------------------------- plumbing
  private classifyResponse(res: Response): PushOutcome {
    if (res.status === 429) return { kind: 'FAILED', retryable: true, error: 'rate limited', retryAfterMs: 60_000 };
    if (res.status === 401) {
      this.tokens.invalidate();
      return { kind: 'FAILED', retryable: true, error: 'unauthorized (token invalidated)' };
    }
    if (res.status === 409) return { kind: 'FAILED', retryable: true, error: 'version conflict (re-prepare)' };
    if (res.status >= 500) return { kind: 'FAILED', retryable: true, error: `server error ${res.status}` };
    if (!res.ok) return { kind: 'FAILED', retryable: false, error: `HTTP ${res.status}` };
    return { kind: 'DELIVERED' };
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.tokens.getAccessToken();
    return this.fetchImpl(`${this.cfg.baseUrl ?? DEFAULT_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Gusto-API-Version': this.cfg.apiVersion ?? DEFAULT_VERSION,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
}

/**
 * SEAM 1 — pair a chronological IN/OUT stream into completed shifts, per employee.
 * Conservative default: match each IN with the next OUT for the same employee; a
 * trailing IN with no OUT is an OPEN shift and is NOT sent (Gusto only takes
 * completed shifts). Replace with the app's own shift model if punches can
 * interleave across days.
 */
export function pairPunchesIntoShifts(punches: CanonicalPunch[]): GustoShift[] {
  const byEmp = new Map<string, CanonicalPunch[]>();
  for (const p of punches) {
    const arr = byEmp.get(p.hrisEmployeeId) ?? [];
    arr.push(p);
    byEmp.set(p.hrisEmployeeId, arr);
  }
  const shifts: GustoShift[] = [];
  for (const [hrisEmployeeId, list] of byEmp) {
    list.sort((a, b) => a.timeUtc.getTime() - b.timeUtc.getTime());
    let open: Date | null = null;
    for (const p of list) {
      if (p.type === 'IN') open = p.timeUtc;
      else if (p.type === 'OUT' && open) {
        const hours = (p.timeUtc.getTime() - open.getTime()) / 3_600_000;
        shifts.push({ hrisEmployeeId, startUtc: open, endUtc: p.timeUtc, entries: classifyHours(hours) });
        open = null;
      }
    }
  }
  return shifts;
}

/**
 * SEAM 2 — split a shift's total hours into Gusto pay classifications.
 * Default: everything Regular. Wire the tenant's StateRules here (CA daily OT > 8,
 * double-time > 12, etc.) so overtime lands in the right bucket for payroll.
 */
export function classifyHours(
  totalHours: number,
): { hours_worked: number; pay_classification: 'Regular' | 'Overtime' | 'Double Overtime' }[] {
  return [{ hours_worked: Math.round(totalHours * 100) / 100, pay_classification: 'Regular' }];
}
