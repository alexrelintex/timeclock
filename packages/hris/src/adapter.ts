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
  email?: string;
  employeeNumber?: string;
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
