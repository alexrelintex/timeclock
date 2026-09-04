/**
 * Paycor adapter — implements HrisAdapter against the VERIFIED Public API
 * v1/v2 surface (source: official OpenAPI specs, captured 2026-08-07).
 *
 * Verified facts encoded here:
 *  - Server: https://apis.paycor.com
 *  - Auth: Bearer JWT (Authorization) + Ocp-Apim-Subscription-Key (Azure APIM).
 *    Token acquisition is INJECTED via TokenProvider — token endpoint TBD in build.
 *  - PunchStatusType enum: Auto | In | Out | Transfer — NO break/lunch types,
 *    so supportsBreakPunches() = false (breaks/lunch never leave the app).
 *  - EmployeePunch required: employeeId(GUID), departmentId(GUID),
 *    punchDateTime (EMPLOYEE-LOCAL, YYYY-MM-DDTHH:MM:SS, no offset),
 *    punchStatusType, activityTypeId(GUID), isTransfer.
 *  - Writes are async: tracking id -> GET .../punchErrorLog/{trackingId}.
 *  - Batch caps: 100 on updatePunches/DeletePunches/CreatePayItems/
 *    createMissedPunchRequests/approveOrDenyMissedPunchRequests.
 *  - Rate limiting: 429 + PaycorRateLimitError ("try again in 60 seconds").
 */

import {
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
import { toEmployeeLocalDateTime } from './time';

export interface PaycorTenantConfig {
  legalEntityId: number; // integer in v2 paths
  subscriptionKey: string; // Ocp-Apim-Subscription-Key
  /** Per-agent Paycor write requirements, keyed by hrisEmployeeId. */
  employeeWriteConfig: Record<string, { departmentId: string; activityTypeId: string }>;
  /** Earning code GUID for the CA meal/rest premium pay item. */
  mealPremiumEarningId?: string;
  baseUrl?: string; // default https://apis.paycor.com
}

const DEFAULT_BASE = 'https://apis.paycor.com';
const BATCH_CAP = 100;

export class PaycorAdapter implements HrisAdapter {
  readonly provider = 'paycor';

  constructor(
    private readonly cfg: PaycorTenantConfig,
    private readonly tokens: TokenProvider,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  supportsPunchWrite(): boolean {
    return true;
  }
  supportsBreakPunches(): boolean {
    return false; // PunchStatusType has no break/lunch — verified
  }
  supportsMissedPunchWorkflow(): boolean {
    return true;
  }
  supportsPayItems(): boolean {
    return Boolean(this.cfg.mealPremiumEarningId);
  }

  // ---------------------------------------------------------------- reads

  async listEmployees(cursor?: string): Promise<{ items: HrisEmployeeRef[]; nextCursor?: string }> {
    // Employee list uses the same v2 paged + continuationToken pattern as punches.
    // NOTE: confirm the exact path/field names against the portal Guides before
    // production — this follows the documented PagedResult envelope shape.
    const params = new URLSearchParams({ take: '100' });
    if (cursor) params.set('continuationToken', cursor);
    const res = await this.request(
      'GET',
      `/v1/legalentities/${this.cfg.legalEntityId}/employees?${params}`,
    );
    if (!res.ok) {
      throw new Error(`Paycor listEmployees failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      records?: {
        id?: string;
        employeeId?: string;
        firstName?: string;
        lastName?: string;
        emailAddress?: string;
        employeeNumber?: string;
      }[];
      continuationToken?: string;
    };
    const items: HrisEmployeeRef[] = (body.records ?? []).map((r) => ({
      hrisEmployeeId: r.employeeId ?? r.id ?? '',
      displayName: [r.firstName, r.lastName].filter(Boolean).join(' ') || undefined,
      email: r.emailAddress,
      employeeNumber: r.employeeNumber,
    }));
    return { items, nextCursor: body.continuationToken || undefined };
  }

  async readPunchPairs(
    hrisEmployeeId: string,
    fromUtc: Date,
    toUtc: Date,
  ): Promise<{ punchIn: Date | null; punchOut: Date | null; hours: number }[]> {
    // VERIFIED: GET /v2/employees/{employeeId}/punches -> PagedResultOfTimeCardV4
    const params = new URLSearchParams({
      startDate: fromUtc.toISOString().slice(0, 10),
      endDate: toUtc.toISOString().slice(0, 10),
    });
    const pairs: { punchIn: Date | null; punchOut: Date | null; hours: number }[] = [];
    let continuation: string | undefined;
    do {
      if (continuation) params.set('continuationToken', continuation);
      const res = await this.request(
        'GET',
        `/v2/employees/${encodeURIComponent(hrisEmployeeId)}/punches?${params}`,
      );
      const body = (await res.json()) as {
        records?: {
          punchIn?: string | null;
          punchOut?: string | null;
          hourAmount?: number;
        }[];
        continuationToken?: string;
      };
      for (const r of body.records ?? []) {
        pairs.push({
          punchIn: r.punchIn ? new Date(r.punchIn) : null,
          punchOut: r.punchOut ? new Date(r.punchOut) : null,
          hours: r.hourAmount ?? 0,
        });
      }
      continuation = body.continuationToken || undefined;
    } while (continuation);
    return pairs;
  }

  // --------------------------------------------------------------- writes

  async pushPunches(batch: CanonicalPunch[]): Promise<PushOutcome> {
    // Defense in depth: the outbox worker already filters, but never let a
    // break/lunch event reach Paycor from any call path.
    const inOut = batch.filter((p) => p.type === 'IN' || p.type === 'OUT');
    if (inOut.length === 0) return { kind: 'DELIVERED' };

    const body = inOut.map((p) => {
      const w = this.cfg.employeeWriteConfig[p.hrisEmployeeId];
      if (!w) {
        throw new Error(
          `Missing Paycor write config (departmentId/activityTypeId) for employee ${p.hrisEmployeeId}`,
        );
      }
      return {
        employeeId: p.hrisEmployeeId,
        departmentId: w.departmentId,
        // VERIFIED: punchDateTime is employee-LOCAL, no offset.
        punchDateTime: toEmployeeLocalDateTime(p.timeUtc, p.agentTimezone),
        punchStatusType: p.type === 'IN' ? 'In' : 'Out',
        activityTypeId: w.activityTypeId,
        isTransfer: false,
        ...(p.note ? { note: p.note.slice(0, 300) } : {}),
      };
    });

    return this.asyncPost(
      `/v1/legalentities/${this.cfg.legalEntityId}/CreatePunches`,
      body,
    );
  }

  async pushPayItems(batch: CanonicalPayItem[]): Promise<PushOutcome> {
    if (!this.cfg.mealPremiumEarningId) {
      return { kind: 'FAILED', retryable: false, error: 'mealPremiumEarningId not configured' };
    }
    const chunk = batch.slice(0, BATCH_CAP); // verified maxItems=100
    const body = chunk.map((i) => ({
      // VERIFIED shape: legalEntityEarningId + amount (+ note)
      payItemId: cryptoRandomGuid(),
      legalEntityEarningId: i.earningCodeRef || this.cfg.mealPremiumEarningId,
      ...(i.amount !== undefined ? { amount: i.amount } : {}),
      ...(i.note ? { note: i.note.slice(0, 300) } : {}),
    }));
    return this.asyncPost(
      `/v1/legalentities/${this.cfg.legalEntityId}/CreatePayItems`,
      body,
    );
  }

  async pushMissedPunchProposals(
    batch: CanonicalMissedPunchProposal[],
  ): Promise<PushOutcome> {
    const chunk = batch.slice(0, BATCH_CAP);
    const body = chunk.map((m) => {
      const w = this.cfg.employeeWriteConfig[m.hrisEmployeeId];
      if (!w) throw new Error(`Missing Paycor write config for ${m.hrisEmployeeId}`);
      return {
        // VERIFIED MissedPunchRequest3: a proposed punch
        employeeId: m.hrisEmployeeId,
        departmentId: w.departmentId,
        punchDateTime: toEmployeeLocalDateTime(m.proposedTimeUtc, m.agentTimezone),
        punchStatusType: m.proposedType === 'IN' ? 'In' : 'Out',
        isTransfer: false,
        ...(m.note ? { note: m.note.slice(0, 300) } : {}),
      };
    });
    return this.asyncPost(
      `/v1/legalentities/${this.cfg.legalEntityId}/createMissedPunchRequests`,
      body,
    );
  }

  async pushMissedPunchDecisions(
    batch: CanonicalMissedPunchDecision[],
  ): Promise<PushOutcome> {
    const chunk = batch.slice(0, BATCH_CAP);
    const body = chunk.map((d) => ({
      // VERIFIED MissedPunchRequest2: punchId + status (Approved|Denied)
      employeeId: undefined, // filled by caller mapping if required per record
      punchId: d.hrisPunchId,
      status: d.approved ? 'Approved' : 'Denied',
      ...(d.note ? { note: d.note.slice(0, 300) } : {}),
      ...(d.reasonCodeRef ? { reasonCodeId: d.reasonCodeRef } : {}),
    }));
    return this.asyncPut(
      `/v1/legalentities/${this.cfg.legalEntityId}/approveOrDenyMissedPunchRequests`,
      body,
    );
  }

  async resolveSubmission(trackingId: string): Promise<SubmissionResolution> {
    // VERIFIED: GET /v1/legalentities/{id}/punchErrorLog/{trackingId}
    const res = await this.request(
      'GET',
      `/v1/legalentities/${this.cfg.legalEntityId}/punchErrorLog/${encodeURIComponent(trackingId)}`,
    );
    if (res.status === 404) return { resolved: false, perRecordErrors: [] }; // still processing
    const body = (await res.json()) as {
      records?: { employeeId?: string; message?: string }[];
    };
    return {
      resolved: true,
      perRecordErrors: (body.records ?? []).map((r) => ({
        recordRef: r.employeeId ?? 'unknown',
        message: r.message ?? 'unspecified error',
      })),
    };
  }

  // ------------------------------------------------------------- plumbing

  private async asyncPost(path: string, body: unknown): Promise<PushOutcome> {
    return this.asyncWrite('POST', path, body);
  }
  private async asyncPut(path: string, body: unknown): Promise<PushOutcome> {
    return this.asyncWrite('PUT', path, body);
  }

  private async asyncWrite(
    method: 'POST' | 'PUT',
    path: string,
    body: unknown,
  ): Promise<PushOutcome> {
    const res = await this.request(method, path, body);

    if (res.status === 429) {
      // VERIFIED: PaycorRateLimitError — "try again in 60 seconds"
      return { kind: 'FAILED', retryable: true, error: 'rate limited', retryAfterMs: 60_000 };
    }
    if (res.status === 401) {
      this.tokens.invalidate();
      return { kind: 'FAILED', retryable: true, error: 'unauthorized (token invalidated)' };
    }
    if (res.status >= 500) {
      return { kind: 'FAILED', retryable: true, error: `server error ${res.status}` };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { kind: 'FAILED', retryable: false, error: `HTTP ${res.status}: ${text.slice(0, 500)}` };
    }

    // 200/201/202: extract async tracking id when present.
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const trackingId =
      (parsed['trackingId'] as string | undefined) ??
      (parsed['id'] as string | undefined);
    return trackingId ? { kind: 'SUBMITTED', trackingId } : { kind: 'DELIVERED' };
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.tokens.getAccessToken();
    return this.fetchImpl(`${this.cfg.baseUrl ?? DEFAULT_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Ocp-Apim-Subscription-Key': this.cfg.subscriptionKey, // verified header
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
}

function cryptoRandomGuid(): string {
  // Node >= 19 / modern runtimes expose WebCrypto globally.
  return globalThis.crypto.randomUUID();
}
