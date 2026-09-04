/**
 * Orphan-punch detection.
 * An orphan is an unpaired event: IN with no OUT past the max-shift threshold,
 * or BREAK_START/LUNCH_START with no matching END past its threshold — including
 * cases caused by orphaned logins (session invalidated without punch-out).
 *
 * Scope split (design decision, 2026-08-07):
 *  - IN/OUT orphans: corrected in-app AND round-tripped to the HRIS
 *    (missed-punch request -> supervisor decision).
 *  - BREAK/LUNCH orphans: detected, documented, and approved ENTIRELY in-app.
 */

import { PunchEventLike, projectShift } from './stateMachine';

export interface OrphanThresholds {
  maxShiftMs: number; // default 14h — IN older than this with no OUT
  maxBreakMs: number; // default 2x configured break (e.g. 30m)
  maxLunchMs: number; // default lunchMax + 30m grace
}

export const DEFAULT_THRESHOLDS: OrphanThresholds = {
  maxShiftMs: 14 * 60 * 60 * 1000,
  maxBreakMs: 30 * 60 * 1000,
  maxLunchMs: 90 * 60 * 1000,
};

export type OrphanKind = 'ORPHAN_IN' | 'ORPHAN_BREAK' | 'ORPHAN_LUNCH';

export interface DetectedOrphan {
  kind: OrphanKind;
  openedAt: Date; // the unpaired event's time
  ageMs: number;
  syncsToHris: boolean; // only IN/OUT orphans round-trip
}

/**
 * Run against a single agent's open shift stream. Call from the periodic
 * reconciler and on session-invalidation hooks from the host CRM.
 */
export function detectOrphans(
  events: PunchEventLike[],
  now: Date = new Date(),
  t: OrphanThresholds = DEFAULT_THRESHOLDS,
): DetectedOrphan[] {
  const proj = projectShift(events, now);
  const out: DetectedOrphan[] = [];

  if (proj.status === 'ACTIVE' && proj.shiftStart) {
    const age = now.getTime() - proj.shiftStart.getTime();
    if (age > t.maxShiftMs) {
      out.push({ kind: 'ORPHAN_IN', openedAt: proj.shiftStart, ageMs: age, syncsToHris: true });
    }
  }
  if (proj.status === 'ON_BREAK' && proj.currentIntervalStart) {
    const age = now.getTime() - proj.currentIntervalStart.getTime();
    if (age > t.maxBreakMs) {
      out.push({
        kind: 'ORPHAN_BREAK',
        openedAt: proj.currentIntervalStart,
        ageMs: age,
        syncsToHris: false,
      });
    }
  }
  if (proj.status === 'ON_LUNCH' && proj.currentIntervalStart) {
    const age = now.getTime() - proj.currentIntervalStart.getTime();
    if (age > t.maxLunchMs) {
      out.push({
        kind: 'ORPHAN_LUNCH',
        openedAt: proj.currentIntervalStart,
        ageMs: age,
        syncsToHris: false,
      });
    }
  }
  return out;
}

/**
 * Correction proposal: the agent documents either a concrete time-of-day OR
 * a duration in minutes (from which the missing event time is derived).
 * Writes a NEW event with correctionOf -> the synthetic missing pair,
 * status PENDING_APPROVAL; supervisor approval flips it ACTIVE and
 * (for IN/OUT) enqueues the HRIS missed-punch round trip via the outbox.
 */
export interface CorrectionProposal {
  agentId: string;
  orphanKind: OrphanKind;
  missingEventType: 'OUT' | 'BREAK_END' | 'LUNCH_END';
  proposedTime?: Date; // time-of-day form
  proposedMinutes?: number; // duration form: openedAt + minutes
  attestation: string; // required; <=300 chars for HRIS note pass-through
}

export function resolveProposedTime(openedAt: Date, p: CorrectionProposal): Date {
  if (p.proposedTime) return p.proposedTime;
  if (p.proposedMinutes !== undefined) {
    return new Date(openedAt.getTime() + p.proposedMinutes * 60_000);
  }
  throw new Error('Correction proposal must include proposedTime or proposedMinutes');
}
