/**
 * Mock HRIS adapter for the demo (hrisProvider === 'mock').
 *
 * It stands in for a real provider (Paycor) so the whole sync path is
 * demonstrable without credentials:
 *   - listEmployees() returns a small canned roster to "pull from HRIS".
 *   - punch/pay-item writes are accepted and reported DELIVERED, so an employee
 *     who IS linked to HRIS shows real outbox activity, while a local-only
 *     employee (hrisEmployeeId === null) never reaches this adapter at all.
 *
 * Shape mirrors the Paycor adapter's capabilities: IN/OUT punches sync, break
 * and lunch never do.
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
} from '@timeclock/hris';

const CANNED: HrisEmployeeRef[] = [
  { hrisEmployeeId: 'pc-1001', displayName: 'Grace Okafor', email: 'grace.okafor@acme.example', employeeNumber: '1001' },
  { hrisEmployeeId: 'pc-1002', displayName: 'Ravi Menon', email: 'ravi.menon@acme.example', employeeNumber: '1002' },
  { hrisEmployeeId: 'pc-1003', displayName: 'Lena Fischer', email: 'lena.fischer@acme.example', employeeNumber: '1003' },
  { hrisEmployeeId: 'pc-1004', displayName: 'Diego Alvarez', email: 'diego.alvarez@acme.example', employeeNumber: '1004' },
];

export class MockHrisAdapter implements HrisAdapter {
  readonly provider = 'mock';
  private delivered: string[] = [];

  supportsPunchWrite(): boolean {
    return true;
  }
  supportsBreakPunches(): boolean {
    return false; // breaks/lunch stay internal, same as Paycor
  }
  supportsMissedPunchWorkflow(): boolean {
    return true;
  }
  supportsPayItems(): boolean {
    return true;
  }

  async listEmployees(): Promise<{ items: HrisEmployeeRef[]; nextCursor?: string }> {
    return { items: CANNED };
  }

  async pushPunches(batch: CanonicalPunch[]): Promise<PushOutcome> {
    for (const p of batch) this.delivered.push(`${p.type}@${p.timeUtc.toISOString?.() ?? p.timeUtc}`);
    return { kind: 'DELIVERED' };
  }
  async pushPayItems(_batch: CanonicalPayItem[]): Promise<PushOutcome> {
    return { kind: 'DELIVERED' };
  }
  async pushMissedPunchProposals(_batch: CanonicalMissedPunchProposal[]): Promise<PushOutcome> {
    return { kind: 'DELIVERED' };
  }
  async pushMissedPunchDecisions(_batch: CanonicalMissedPunchDecision[]): Promise<PushOutcome> {
    return { kind: 'DELIVERED' };
  }
  async resolveSubmission(_trackingId: string): Promise<SubmissionResolution> {
    return { resolved: true, perRecordErrors: [] };
  }
  async readPunchPairs(): Promise<{ punchIn: Date | null; punchOut: Date | null; hours: number }[]> {
    return [];
  }
}
