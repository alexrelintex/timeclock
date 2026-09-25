/**
 * HRIS adapter interface — capability-based, provider-agnostic.
 * The core NEVER imports a provider; the outbox worker resolves the tenant's
 * adapter and drains canonical records through it.
 *
 * Canonical rules enforced at this boundary:
 *  - Only IN/OUT punches leave the app (break/lunch stay internal), UNLESS a
 *    provider opts in via supportsBreakPunches().
 *  - All canonical times are UTC; adapters own local-time conversion.
 *  - Writes are two-phase where the provider is async:
 *    pushX() -> { submitted, trackingId } then resolveSubmission(trackingId).
 */

export type CanonicalPunchType = 'IN' | 'OUT' | 'BREAK_START' | 'BREAK_END' | 'LUNCH_START' | 'LUNCH_END';

export interface CanonicalPunch {
  punchEventId: string; // our append-only event id (audit linkage)
  agentId: string;
  hrisEmployeeId: string;
  type: CanonicalPunchType;
  timeUtc: Date;
  agentTimezone: string; // IANA
  note?: string;
  /** Provider write fields stamped at enqueue time from the employee record, so a
   *  punch is self-contained (no dependency on a cached adapter's employee map).
   *  Paycor: department GUID + activity-type GUID. Adapters fall back to tenant
   *  defaults when absent. */
  departmentId?: string;
  activityTypeId?: string;
}

export interface CanonicalPayItem {
  exceptionId: string; // ComplianceException linkage (e.g. CA meal premium)
  hrisEmployeeId: string;
  earningCodeRef: string; // provider-specific meaning (Paycor: legalEntityEarningId GUID)
  amount?: number;
  hours?: number;
  workDate: Date;
  note?: string;
}

export interface CanonicalMissedPunchProposal {
  correctionEventId: string;
  hrisEmployeeId: string;
  proposedType: 'IN' | 'OUT';
  proposedTimeUtc: Date;
  agentTimezone: string;
  note?: string; // agent attestation, <=300 chars pass-through
}

export interface CanonicalMissedPunchDecision {
  hrisPunchId: string;
  approved: boolean;
  note?: string;
  reasonCodeRef?: string;
}

export type PushOutcome =
  | { kind: 'DELIVERED' } // sync provider, done
  | { kind: 'SUBMITTED'; trackingId: string } // async provider, poll later
  | { kind: 'FAILED'; retryable: boolean; error: string; retryAfterMs?: number };

export interface SubmissionResolution {
  resolved: boolean; // false => keep polling
  perRecordErrors: { recordRef: string; message: string }[];
}

export interface HrisEmployeeRef {
  hrisEmployeeId: string;
  displayName?: string;
  /** Given / family name as the provider holds them, when it reports them
   *  separately (Paycor does). `displayName` is their composition. */
  firstName?: string;
  lastName?: string;
  email?: string;
  employeeNumber?: string;
  /** Raw HRIS employment status when the provider reports one (e.g. Paycor's
   *  "Active" | "Terminated" | "Resigned" | "Retired" | …). For surfacing/logging. */
  status?: string;
  /** Derived: is this a currently-employed person? `false` for terminated/separated
   *  employees the HRIS still returns. `undefined` when the provider doesn't say. */
  active?: boolean;
  /** Home department name, resolved from the HRIS (used on first import only). */
  department?: string;
  /** Raw HRIS department id (Paycor GUID) — required on punch writes. */
  departmentId?: string;
  /** Work-location USPS state code (e.g. "CA"), for wage/meal rules on first import. */
  locationState?: string;
  /** Job title from the HRIS (persisted for CRM sync; not shown in the panel). */
  title?: string;
  /** FLSA type from the HRIS (HourlyExempt | HourlyNonExempt | SalaryExempt |
   *  SalaryNonExempt); persisted for CRM sync, not shown in the panel. */
  flsa?: string;
}

/** Auth is injected: the token endpoint gets wired during the build. */
export interface TokenProvider {
  getAccessToken(): Promise<string>; // returns a currently-valid bearer token
  invalidate(): void; // called on 401 to force refresh
}

export interface HrisAdapter {
  readonly provider: string;

  // Capability flags — the outbox worker filters on these.
  supportsPunchWrite(): boolean;
  supportsBreakPunches(): boolean; // Paycor: false (enum has no break/lunch)
  supportsMissedPunchWorkflow(): boolean;
  supportsPayItems(): boolean; // premium-pay delivery path

  listEmployees(cursor?: string): Promise<{ items: HrisEmployeeRef[]; nextCursor?: string }>;

  pushPunches(batch: CanonicalPunch[]): Promise<PushOutcome>;
  pushPayItems(batch: CanonicalPayItem[]): Promise<PushOutcome>;
  pushMissedPunchProposals(batch: CanonicalMissedPunchProposal[]): Promise<PushOutcome>;
  pushMissedPunchDecisions(batch: CanonicalMissedPunchDecision[]): Promise<PushOutcome>;

  /** Poll async submissions (tracking-id pattern). */
  resolveSubmission(trackingId: string): Promise<SubmissionResolution>;

  /** Reconciliation read: provider's computed punch pairs for a window. */
  readPunchPairs(
    hrisEmployeeId: string,
    fromUtc: Date,
    toUtc: Date,
  ): Promise<{ punchIn: Date | null; punchOut: Date | null; hours: number }[]>;
}

/** Filter applied by the outbox worker BEFORE any adapter sees the batch. */
export function filterForProvider(adapter: HrisAdapter, batch: CanonicalPunch[]): CanonicalPunch[] {
  if (adapter.supportsBreakPunches()) return batch;
  return batch.filter((p) => p.type === 'IN' || p.type === 'OUT');
}
