/**
 * Schedule adherence: what was planned, what happened, and whether the gap
 * matters.
 *
 * Deliberately in TypeScript rather than SQL. The database returns planned and
 * actual instants plus signed variance minutes — arithmetic — and this module
 * decides what counts as off-schedule. That decision is policy: it moves with the
 * grace window, it differs per tenant, and the supervisor board, the alert engine
 * and any report all have to reach the same verdict from the same code.
 *
 * GRACE is symmetric and defaults to 5 minutes. Both directions matter, and for
 * different reasons: clocking in 12 minutes late is an attendance issue, and
 * clocking in 12 minutes EARLY is unscheduled paid time that nobody approved.
 */

export type AdherenceStatus =
  | 'ON_SCHEDULE'
  | 'OFF_SCHEDULE'
  | 'IN_PROGRESS'
  | 'ABSENT'
  | 'NOT_SCHEDULED';

export type AdherenceCode =
  | 'LATE_IN'
  | 'EARLY_IN'
  | 'LATE_OUT'
  | 'EARLY_OUT'
  | 'LATE_MEAL_START'
  | 'MEAL_OVER_SCHEDULE'
  | 'MEAL_NOT_TAKEN'
  | 'MISSED_SHIFT'
  | 'UNSCHEDULED_SHIFT'
  | 'MULTIPLE_SHIFTS';

export type Severity = 'INFO' | 'WARN' | 'CRITICAL';

/** Working kinds count toward coverage; everything else is an absence. */
export type ScheduleKind =
  | 'WORK'
  | 'TRAINING'
  | 'HOLIDAY'
  | 'VACATION'
  | 'PTO'
  | 'SICK'
  | 'LEAVE'
  | 'OFF';

export const WORKING_KINDS: ReadonlySet<ScheduleKind> = new Set<ScheduleKind>(['WORK', 'TRAINING']);

export interface PlannedShift {
  kind: ScheduleKind;
  source: 'PATTERN' | 'EXCEPTION' | 'UNSCHEDULED';
  startUtc: string | null;
  lunchUtc: string | null;
  lunchMinutes: number | null;
  endUtc: string | null;
  scheduledMinutes: number;
  note?: string | null;
}

export interface ActualShift {
  firstInUtc: string;
  lunchOutUtc: string | null;
  lunchInUtc: string | null;
  lastOutUtc: string | null;
  workedMs: number;
  breakMs: number;
  lunchMs: number;
  breaks: number;
  complete: boolean;
  shiftCount: number;
}

export interface AdherenceFinding {
  code: AdherenceCode;
  severity: Severity;
  /** Signed minutes, where the finding is a time variance. Positive = late/over. */
  minutes?: number;
  message: string;
}

export interface AdherenceResult {
  status: AdherenceStatus;
  findings: AdherenceFinding[];
  graceMinutes: number;
  /** Signed minutes, null where one side is missing. */
  variance: { in: number | null; out: number | null; mealStart: number | null; mealDuration: number | null };
}

export interface AdherenceInput {
  planned: PlannedShift | null;
  actual: ActualShift | null;
  graceMinutes?: number;
  /** Whether the meal is a legal obligation here — drives MEAL_NOT_TAKEN. */
  mealRequired?: boolean;
  now?: Date;
}

const MIN = 60_000;
const ms = (iso: string | null | undefined): number | null => (iso ? new Date(iso).getTime() : null);
const round1 = (n: number): number => Math.round(n * 10) / 10;
const mins = (n: number): string => `${Math.abs(round1(n))} min`;

export function evaluateAdherence(input: AdherenceInput): AdherenceResult {
  const grace = input.graceMinutes ?? 5;
  const now = (input.now ?? new Date()).getTime();
  const { planned, actual } = input;
  const findings: AdherenceFinding[] = [];
  const variance: AdherenceResult['variance'] = {
    in: null,
    out: null,
    mealStart: null,
    mealDuration: null,
  };

  const working = planned !== null && WORKING_KINDS.has(planned.kind);

  // --- nothing planned, nothing worked
  if (!planned && !actual) {
    return { status: 'NOT_SCHEDULED', findings, graceMinutes: grace, variance };
  }

  // --- an absence on the books
  if (planned && !working) {
    if (!actual) {
      return { status: 'ABSENT', findings, graceMinutes: grace, variance };
    }
    // Worked through a holiday or approved leave. Not automatically wrong, but a
    // supervisor should know: it is unplanned paid time, and on a holiday it may
    // attract premium pay under the tenant's own policy.
    findings.push({
      code: 'UNSCHEDULED_SHIFT',
      severity: 'WARN',
      message: `Worked on a day marked ${planned.kind.toLowerCase()}.`,
    });
    return { status: 'OFF_SCHEDULE', findings, graceMinutes: grace, variance };
  }

  // --- worked with no schedule at all
  if (!planned || !working) {
    findings.push({
      code: 'UNSCHEDULED_SHIFT',
      severity: 'INFO',
      message: 'Clocked in on a day with no schedule on file.',
    });
    return { status: 'OFF_SCHEDULE', findings, graceMinutes: grace, variance };
  }

  const plannedStart = ms(planned.startUtc);
  const plannedEnd = ms(planned.endUtc);

  // --- scheduled but never clocked in
  if (!actual) {
    if (plannedStart !== null && now < plannedStart + grace * MIN) {
      // Not due yet (or inside grace) — silence is correct.
      return { status: 'IN_PROGRESS', findings, graceMinutes: grace, variance };
    }
    const lateBy = plannedStart === null ? 0 : (now - plannedStart) / MIN;
    findings.push({
      code: 'MISSED_SHIFT',
      // An hour past the start is no longer "running late".
      severity: lateBy > 60 ? 'CRITICAL' : 'WARN',
      minutes: round1(lateBy),
      message:
        lateBy > 60
          ? `No clock-in ${mins(lateBy)} after the scheduled start.`
          : `Has not clocked in; ${mins(lateBy)} past the scheduled start.`,
    });
    return { status: 'OFF_SCHEDULE', findings, graceMinutes: grace, variance };
  }

  // --- clock-in variance
  const firstIn = ms(actual.firstInUtc);
  if (plannedStart !== null && firstIn !== null) {
    const v = (firstIn - plannedStart) / MIN;
    variance.in = round1(v);
    if (v > grace) {
      findings.push({
        code: 'LATE_IN',
        severity: v > 30 ? 'CRITICAL' : 'WARN',
        minutes: round1(v),
        message: `Clocked in ${mins(v)} late.`,
      });
    } else if (v < -grace) {
      findings.push({
        code: 'EARLY_IN',
        severity: 'INFO',
        minutes: round1(v),
        message: `Clocked in ${mins(v)} early — unscheduled paid time.`,
      });
    }
  }

  // --- meal
  const plannedLunch = ms(planned.lunchUtc);
  const actualLunch = ms(actual.lunchOutUtc);
  if (plannedLunch !== null && actualLunch !== null) {
    const v = (actualLunch - plannedLunch) / MIN;
    variance.mealStart = round1(v);
    if (v > grace) {
      findings.push({
        code: 'LATE_MEAL_START',
        severity: 'WARN',
        minutes: round1(v),
        message: `Took lunch ${mins(v)} later than scheduled.`,
      });
    }
  }
  if (planned.lunchMinutes !== null && actual.lunchMs > 0) {
    const v = actual.lunchMs / MIN - planned.lunchMinutes;
    variance.mealDuration = round1(v);
    if (v > grace) {
      findings.push({
        code: 'MEAL_OVER_SCHEDULE',
        severity: 'WARN',
        minutes: round1(v),
        message: `Lunch ran ${mins(v)} over the scheduled ${planned.lunchMinutes} minutes.`,
      });
    }
  }
  if (
    input.mealRequired &&
    planned.lunchMinutes !== null &&
    planned.lunchMinutes > 0 &&
    actual.lunchMs === 0 &&
    actual.complete
  ) {
    findings.push({
      code: 'MEAL_NOT_TAKEN',
      severity: 'CRITICAL',
      message: 'Shift closed with no meal period recorded, and one was scheduled.',
    });
  }

  // --- clock-out variance (only once the shift is closed)
  const lastOut = ms(actual.lastOutUtc);
  if (!actual.complete || lastOut === null) {
    if (findings.length === 0) {
      return { status: 'IN_PROGRESS', findings, graceMinutes: grace, variance };
    }
    return { status: 'OFF_SCHEDULE', findings, graceMinutes: grace, variance };
  }
  if (plannedEnd !== null) {
    const v = (lastOut - plannedEnd) / MIN;
    variance.out = round1(v);
    if (v > grace) {
      findings.push({
        code: 'LATE_OUT',
        // Staying late is how unplanned overtime happens, so it is not merely FYI.
        severity: v > 30 ? 'WARN' : 'INFO',
        minutes: round1(v),
        message: `Clocked out ${mins(v)} after the scheduled end.`,
      });
    } else if (v < -grace) {
      findings.push({
        code: 'EARLY_OUT',
        severity: v < -30 ? 'WARN' : 'INFO',
        minutes: round1(v),
        message: `Clocked out ${mins(v)} early.`,
      });
    }
  }

  if (actual.shiftCount > 1) {
    findings.push({
      code: 'MULTIPLE_SHIFTS',
      severity: 'INFO',
      minutes: actual.shiftCount,
      message: `${actual.shiftCount} separate shifts on one scheduled day.`,
    });
  }

  return {
    status: findings.length === 0 ? 'ON_SCHEDULE' : 'OFF_SCHEDULE',
    findings,
    graceMinutes: grace,
    variance,
  };
}

/** Worst severity present, for sorting a board by what needs attention first. */
export function worstSeverity(findings: AdherenceFinding[]): Severity | null {
  if (findings.some((f) => f.severity === 'CRITICAL')) return 'CRITICAL';
  if (findings.some((f) => f.severity === 'WARN')) return 'WARN';
  if (findings.length) return 'INFO';
  return null;
}
