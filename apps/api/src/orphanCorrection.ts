/**
 * Missing-clock-out correction (orphan IN).
 *
 * Policy: if a team member never clocks out, their shift stays open past the
 * max-shift threshold and becomes an orphan. Before they may clock in for a new
 * shift, a CLOCK-OUT exception MUST be created that logs (a) the estimated
 * clock-out time and (b) the reason for the missing punch. That exception, plus
 * a corrective OUT event, closes the prior shift; only then is a new IN allowed.
 *
 * IN/OUT orphans round-trip to the HRIS (missed-punch request), so the exception
 * opens PENDING_APPROVAL for supervisor sign-off while the agent proceeds.
 */
import { detectOrphans, projectShift } from '@timeclock/core';
import type { Store } from './store/contract.js';
import type { Agent, PunchEvent } from './types.js';

export interface OrphanClockoutInfo {
  shiftStart: Date;
  ageMs: number;
  /** A sensible default estimate: scheduled end if in the past, else last activity. */
  suggestedClockout: Date;
}

/** Returns orphan-IN info when the agent's open shift needs a clock-out correction. */
export function pendingClockoutCorrection(
  db: Store,
  agent: Agent,
  now: Date,
): OrphanClockoutInfo | null {
  const events = db.agentEvents(agent.id);
  const orphan = detectOrphans(events, now).find((o) => o.kind === 'ORPHAN_IN');
  if (!orphan) return null;
  const scheduledEnd = agent.scheduledEnd ?? null;
  const lastEvent = events[events.length - 1]?.eventTime ?? orphan.openedAt;
  const suggested =
    scheduledEnd && scheduledEnd > orphan.openedAt && scheduledEnd <= now ? scheduledEnd : lastEvent;
  return { shiftStart: orphan.openedAt, ageMs: orphan.ageMs, suggestedClockout: suggested };
}

export class ClockoutCorrectionError extends Error {}

export interface ClockoutCorrectionInput {
  estimatedClockoutUtc?: string; // ISO instant
  estimatedMinutes?: number; // minutes after shift start (alternative to a time)
  reason: string;
}

export interface ClockoutCorrectionResult {
  correctiveEventId: string;
  exceptionId: string;
  estimatedClockout: Date;
  syncedToHris: boolean;
}

export function resolveMissingClockout(
  db: Store,
  agent: Agent,
  input: ClockoutCorrectionInput,
  now: Date = new Date(),
): ClockoutCorrectionResult {
  const reason = (input.reason ?? '').trim();
  if (!reason) throw new ClockoutCorrectionError('A reason for the missing clock-out is required.');

  const events = db.agentEvents(agent.id);
  const proj = projectShift(events, now);
  if (proj.status === 'CLOCKED_OUT' || !proj.shiftStart) {
    throw new ClockoutCorrectionError('No open shift to correct.');
  }
  const orphan = detectOrphans(events, now).find((o) => o.kind === 'ORPHAN_IN');
  if (!orphan) throw new ClockoutCorrectionError('Open shift is not an orphan yet.');

  const shiftStart = proj.shiftStart;
  const estimated = resolveEstimatedTime(shiftStart, input);
  if (estimated.getTime() <= shiftStart.getTime()) {
    throw new ClockoutCorrectionError('Estimated clock-out must be after the clock-in.');
  }
  if (estimated.getTime() > now.getTime()) {
    throw new ClockoutCorrectionError('Estimated clock-out cannot be in the future.');
  }

  const inEvent = events.find((e) => e.eventType === 'IN') as PunchEvent | undefined;

  // 1) Corrective OUT closes the orphaned shift (agent attestation in the note).
  const note = `Missing clock-out corrected. Estimated ${estimated.toISOString()}. Reason: ${reason}`.slice(
    0,
    300,
  );
  const outId = db.appendEvent({
    tenantId: agent.tenantId,
    agentId: agent.id,
    eventType: 'OUT',
    eventTime: estimated,
    source: 'SYSTEM',
    note,
    createdById: agent.id,
    status: 'ACTIVE',
  });

  // 2) The required clock-out exception: logs estimated time + reason.
  const ex = db.upsertException({
    tenantId: agent.tenantId,
    agentId: agent.id,
    workDate: shiftStart,
    type: 'ORPHAN_IN',
    status: 'PENDING_APPROVAL',
    relatedEventIds: [inEvent?.id, outId].filter(Boolean) as string[],
    premiumHourPayable: false,
    premiumDelivered: false,
    resolution: `Estimated clock-out ${estimated.toISOString()} — ${reason}`,
  });

  // 3) IN/OUT orphans round-trip to the HRIS as a missed-punch request.
  let synced = false;
  if (agent.hrisEmployeeId) {
    db.enqueueOutbox({
      tenantId: agent.tenantId,
      punchEventId: outId,
      kind: 'MISSED_PUNCH_REQUEST',
      payload: {
        correctionEventId: outId,
        hrisEmployeeId: agent.hrisEmployeeId,
        proposedType: 'OUT',
        proposedTimeUtc: estimated,
        agentTimezone: agent.timezone,
        note,
      },
    });
    synced = true;
  }

  return { correctiveEventId: outId, exceptionId: ex.id, estimatedClockout: estimated, syncedToHris: synced };
}

function resolveEstimatedTime(shiftStart: Date, input: ClockoutCorrectionInput): Date {
  if (input.estimatedClockoutUtc) {
    const d = new Date(input.estimatedClockoutUtc);
    if (Number.isNaN(d.getTime())) throw new ClockoutCorrectionError('Invalid estimated clock-out time.');
    return d;
  }
  if (typeof input.estimatedMinutes === 'number' && input.estimatedMinutes > 0) {
    return new Date(shiftStart.getTime() + input.estimatedMinutes * 60_000);
  }
  throw new ClockoutCorrectionError('Provide an estimated clock-out time.');
}
