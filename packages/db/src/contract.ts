/**
 * The wire contract between Postgres, apps/api and the widget.
 *
 * These interfaces mirror, key for key, the jsonb that the tc_api RPCs return
 * (see supabase/migrations/20260814090400_projection.sql). Keys are camelCase in
 * the database so there is exactly one vocabulary end to end — no snake_case
 * translation layer to drift out of sync.
 *
 * Bump CONTRACT_VERSION when a field's meaning changes; tc_api.health() returns
 * the database's view of the same number so a deploy skew is loud, not subtle.
 */

export const CONTRACT_VERSION = 1;

export type AgentStatus = 'CLOCKED_OUT' | 'ACTIVE' | 'ON_BREAK' | 'ON_LUNCH';

export type PunchEventType =
  | 'IN'
  | 'OUT'
  | 'BREAK_START'
  | 'BREAK_END'
  | 'LUNCH_START'
  | 'LUNCH_END';

export type OrphanKind = 'ORPHAN_IN' | 'ORPHAN_BREAK' | 'ORPHAN_LUNCH';

export type ExceptionType =
  | OrphanKind
  | 'LATE_MEAL'
  | 'SHORT_MEAL'
  | 'MISSED_MEAL'
  | 'MISSED_REST';

/** The missing half of an unpaired event, as offered by the correction form. */
export type MissingEventType = 'OUT' | 'BREAK_END' | 'LUNCH_END';

export interface OpenOrphan {
  kind: OrphanKind;
  openedAtUtc: string;
  /** Only IN/OUT round-trip to the HRIS; break/lunch are resolved in-app. */
  syncsToHris: boolean;
}

export interface PendingCorrection {
  id: string;
  eventType: PunchEventType;
  eventTimeUtc: string;
  submittedAtUtc: string;
  attestation: string | null;
}

/**
 * Everything the widget needs to render, in one round trip. All instants are UTC
 * ISO-8601 with an explicit Z (timeclock.iso), never a local wall time.
 */
export interface StatusSnapshot {
  agentId: string;
  displayName: string;
  timezone: string;
  isSupervisor: boolean;
  status: AgentStatus;
  /** Server clock at projection time — the widget ticks from this, not Date.now(). */
  serverNowUtc: string;
  shiftStartUtc: string | null;
  currentIntervalStartUtc: string | null;
  lunchStartUtc: string | null;
  lunchEndUtc: string | null;
  workedMs: number;
  breakMs: number;
  lunchMs: number;
  breaksTaken: number;
  /** Events the projection could not apply — evidence for the reconciler. */
  anomalyCount: number;
  breakMinutesConfigured: number;
  lunchMinConfigured: number;
  lunchMaxConfigured: number;
  mealWaiverOnFile: boolean;
  caMealRulesEnabled: boolean;
  mealAlertTiers: number[];
  openOrphan: OpenOrphan | null;
  pendingCorrection: PendingCorrection | null;
}

export interface PunchResult extends StatusSnapshot {
  eventId: string;
  idempotentReplay: boolean;
  enqueuedToHris: boolean;
}

export interface CorrectionResult extends StatusSnapshot {
  correctionEventId?: string;
  idempotentReplay: boolean;
}

export interface RosterEntry extends StatusSnapshot {}

export interface RosterPendingCorrection {
  eventId: string;
  agentId: string;
  agentName: string;
  eventType: PunchEventType;
  proposedTimeUtc: string;
  submittedAtUtc: string;
  attestation: string | null;
  syncsToHris: boolean;
}

export interface Roster {
  serverNowUtc: string;
  tenant: {
    id: string;
    name: string;
    timezone: string;
    breakMinutes: number;
    lunchMinMinutes: number;
    lunchMaxMinutes: number;
    coverageThresholdPct: number;
    mealAlertTiers: number[];
    caMealRulesEnabled: boolean;
  };
  agents: RosterEntry[];
  coverage: {
    scheduled: number;
    active: number;
    onBreak: number;
    onLunch: number;
    clockedOut: number;
  };
  pendingCorrections: RosterPendingCorrection[];
  openExceptions: {
    id: string;
    agentId: string;
    workDate: string;
    type: ExceptionType;
    premiumHourPayable: boolean;
    premiumDelivered: boolean;
  }[];
}

export interface LedgerShift {
  workDate: string;
  shiftStartUtc: string;
  shiftEndUtc: string | null;
  workedMs: number;
  breakMs: number;
  lunchMs: number;
  lunchStartUtc: string | null;
  lunchEndUtc: string | null;
  breaks: number;
  complete: boolean;
}

export interface Ledger {
  timezone: string;
  shifts: LedgerShift[];
  exceptions: {
    workDate: string;
    type: ExceptionType;
    status: 'OPEN' | 'PENDING_APPROVAL' | 'RESOLVED' | 'DISMISSED';
    premiumHourPayable: boolean;
    premiumDelivered: boolean;
  }[];
}

/** Result of tc_api.resolve_identity / upsert_agent. */
export interface ResolvedIdentity {
  tenantId: string;
  tenantSlug: string;
  tenantTimezone: string;
  agentId: string;
  displayName: string;
  timezone: string;
  isSupervisor: boolean;
  role: 'agent' | 'supervisor';
  active: boolean;
  hrisEmployeeId: string | null;
  mealWaiverOnFile: boolean;
}

/** Claims apps/api mints for the widget session (see migration 30 for the contract). */
export interface TimeclockClaims {
  tenant_id: string;
  agent_id: string;
  role: 'agent' | 'supervisor';
  sid?: string;
}
