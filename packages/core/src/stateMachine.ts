/**
 * Agent status state machine.
 * Status is a PROJECTION of the append-only event stream — never stored as truth.
 *
 *   CLOCKED_OUT --IN--> ACTIVE
 *   ACTIVE --BREAK_START--> ON_BREAK --BREAK_END--> ACTIVE
 *   ACTIVE --LUNCH_START--> ON_LUNCH --LUNCH_END--> ACTIVE
 *   ACTIVE --OUT--> CLOCKED_OUT
 *
 * Guards: no break/lunch unless ACTIVE; no OUT while ON_BREAK/ON_LUNCH.
 */

export type PunchEventType =
  | 'IN'
  | 'OUT'
  | 'BREAK_START'
  | 'BREAK_END'
  | 'LUNCH_START'
  | 'LUNCH_END';

export type AgentStatus = 'CLOCKED_OUT' | 'ACTIVE' | 'ON_BREAK' | 'ON_LUNCH';

export interface PunchEventLike {
  eventType: PunchEventType;
  eventTime: Date;
  status?: 'ACTIVE' | 'SUPERSEDED' | 'PENDING_APPROVAL' | 'REJECTED';
}

const TRANSITIONS: Record<AgentStatus, Partial<Record<PunchEventType, AgentStatus>>> = {
  CLOCKED_OUT: { IN: 'ACTIVE' },
  ACTIVE: {
    OUT: 'CLOCKED_OUT',
    BREAK_START: 'ON_BREAK',
    LUNCH_START: 'ON_LUNCH',
  },
  ON_BREAK: { BREAK_END: 'ACTIVE' },
  ON_LUNCH: { LUNCH_END: 'ACTIVE' },
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: AgentStatus,
    public readonly event: PunchEventType,
  ) {
    super(`Invalid transition: ${event} while ${from}`);
    this.name = 'InvalidTransitionError';
  }
}

/** Pure transition; throws on guard violation. */
export function transition(from: AgentStatus, event: PunchEventType): AgentStatus {
  const to = TRANSITIONS[from][event];
  if (!to) throw new InvalidTransitionError(from, event);
  return to;
}

export function canTransition(from: AgentStatus, event: PunchEventType): boolean {
  return TRANSITIONS[from][event] !== undefined;
}

export interface ShiftProjection {
  status: AgentStatus;
  shiftStart: Date | null; // first IN of current open shift
  currentIntervalStart: Date | null; // when current status began
  workedMs: number; // IN..now including paid breaks/lunch (all paid => contiguous)
  breakMs: number;
  lunchMs: number;
  /** Events that could not be applied (orphan/ooo evidence for the reconciler). */
  anomalies: { event: PunchEventLike; reason: string }[];
}

/**
 * Fold an agent's event stream (chronological, ACTIVE-status events only)
 * into current status + accumulated interval durations.
 * Tolerant fold: invalid events are collected as anomalies, not thrown,
 * because historical streams may contain orphans awaiting correction.
 */
export function projectShift(
  events: PunchEventLike[],
  now: Date = new Date(),
): ShiftProjection {
  let status: AgentStatus = 'CLOCKED_OUT';
  let shiftStart: Date | null = null;
  let currentIntervalStart: Date | null = null;
  let breakMs = 0;
  let lunchMs = 0;
  const anomalies: ShiftProjection['anomalies'] = [];

  const applicable = events
    .filter((e) => !e.status || e.status === 'ACTIVE')
    .sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime());

  for (const e of applicable) {
    if (!canTransition(status, e.eventType)) {
      anomalies.push({ event: e, reason: `cannot ${e.eventType} while ${status}` });
      continue;
    }
    const prev = status;
    status = transition(status, e.eventType);

    if (e.eventType === 'IN') shiftStart = e.eventTime;
    if (e.eventType === 'OUT') {
      shiftStart = null;
    }
    if (e.eventType === 'BREAK_END' && currentIntervalStart) {
      breakMs += e.eventTime.getTime() - currentIntervalStart.getTime();
    }
    if (e.eventType === 'LUNCH_END' && currentIntervalStart) {
      lunchMs += e.eventTime.getTime() - currentIntervalStart.getTime();
    }
    currentIntervalStart = e.eventTime;
    void prev;
  }

  // Accrue the open interval up to `now`.
  if (status === 'ON_BREAK' && currentIntervalStart) {
    breakMs += now.getTime() - currentIntervalStart.getTime();
  }
  if (status === 'ON_LUNCH' && currentIntervalStart) {
    lunchMs += now.getTime() - currentIntervalStart.getTime();
  }

  // Breaks & lunch are PAID: worked time is the contiguous span since IN.
  const workedMs = shiftStart ? now.getTime() - shiftStart.getTime() : 0;

  return { status, shiftStart, currentIntervalStart, workedMs, breakMs, lunchMs, anomalies };
}
