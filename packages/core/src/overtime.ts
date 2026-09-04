/**
 * Overtime: what has already been earned, and what the schedule says is coming.
 *
 * Thresholds come from StateRules, because they are not universal. FLSA is weekly
 * only — over 40 hours in a workweek (29 U.S.C. 207(a)) — and says nothing about
 * a long day. California adds daily overtime over 8, double time over 12, and a
 * seventh-consecutive-day rule (Lab. Code 510(a)). Reading a daily threshold from
 * a constant would quietly invent overtime for the Texas half of the team.
 *
 * PROJECTION is the point of this module. Telling a supervisor on Friday evening
 * that someone hit 44 hours is a payroll fact; telling them on Wednesday that the
 * schedule as it stands lands at 44 is something they can still act on. So every
 * day is projected as "what has been worked, plus the part of the schedule still
 * ahead of now" — which collapses to actual hours for a finished day and to
 * scheduled hours for a day that has not started.
 *
 * Arithmetic only. No estimation, no model: a forecast a supervisor cannot
 * reproduce by hand is a forecast they will not trust the third time it is wrong.
 */

import type { StateRules } from './rules';

const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

export interface DayLoad {
  /** Agent-local calendar date, YYYY-MM-DD. */
  workDate: string;
  /** True when the day carries a working schedule (WORK/TRAINING). */
  scheduled: boolean;
  plannedStartUtc: string | null;
  plannedEndUtc: string | null;
  plannedLunchUtc: string | null;
  plannedLunchMinutes: number | null;
  /** Paid minutes on the schedule, already net of the unpaid meal. */
  plannedMinutes: number;
  /** Worked so far, net of the unpaid meal. */
  actualMs: number;
  /** Shift closed. A day can have actualMs > 0 and still be open. */
  complete: boolean;
}

export interface DayProjection {
  workDate: string;
  actualHours: number;
  /** Worked so far plus the remainder of the schedule. */
  projectedHours: number;
  dailyThresholdHours: number | null;
  /** Hours beyond the daily threshold, 0 when under or when there is no threshold. */
  dailyOverBy: number;
  doubleTimeOverBy: number;
  /** ACTUAL = already earned. FORECAST = only if the schedule plays out. */
  basis: 'NONE' | 'FORECAST' | 'ACTUAL';
}

export interface OvertimeProjection {
  rules: StateRules;
  weekStartDate: string;
  days: DayProjection[];
  weekly: {
    actualHours: number;
    projectedHours: number;
    thresholdHours: number;
    overBy: number;
    basis: 'NONE' | 'FORECAST' | 'ACTUAL';
  };
  /** Longest run of consecutive scheduled-or-worked days in the window. */
  consecutiveDays: number;
  seventhDayRisk: boolean;
}

export interface OvertimeInput {
  rules: StateRules;
  /** One entry per day of the workweek, in date order. */
  days: DayLoad[];
  now?: Date;
}

const hours = (msValue: number): number => Math.round((msValue / HOUR_MS) * 100) / 100;

/**
 * The part of a planned window that still lies ahead of `now`, less any scheduled
 * meal that also lies ahead. Zero for a finished day; the whole shift for a day
 * that has not started.
 */
export function remainingPlannedMs(day: DayLoad, now: Date): number {
  if (!day.scheduled || !day.plannedStartUtc || !day.plannedEndUtc) return 0;
  const start = new Date(day.plannedStartUtc).getTime();
  const end = new Date(day.plannedEndUtc).getTime();
  const t = now.getTime();
  if (t >= end) return 0;

  const from = Math.max(t, start);
  let remaining = end - from;

  // Don't count a meal the agent has not taken yet — it is unpaid.
  const lunchMinutes = day.plannedLunchMinutes ?? 0;
  if (lunchMinutes > 0) {
    const lunchStart = day.plannedLunchUtc ? new Date(day.plannedLunchUtc).getTime() : null;
    if (lunchStart === null) {
      remaining -= lunchMinutes * MIN_MS;
    } else {
      const lunchEnd = lunchStart + lunchMinutes * MIN_MS;
      const overlap = Math.max(0, Math.min(end, lunchEnd) - Math.max(from, lunchStart));
      remaining -= overlap;
    }
  }
  return Math.max(0, remaining);
}

export function assessOvertime(input: OvertimeInput): OvertimeProjection {
  const now = input.now ?? new Date();
  const { rules } = input;

  const days: DayProjection[] = input.days.map((d) => {
    const projectedMs = d.actualMs + remainingPlannedMs(d, now);
    const actualH = hours(d.actualMs);
    const projectedH = hours(projectedMs);
    const threshold = rules.dailyOtHours;
    const dt = rules.doubleTimeHours;

    // ACTUAL only when the overtime is already banked — a closed day, or an open
    // day that has passed the threshold on the clock alone.
    const earned = d.complete || actualH > (threshold ?? Infinity);
    return {
      workDate: d.workDate,
      actualHours: actualH,
      projectedHours: projectedH,
      dailyThresholdHours: threshold,
      dailyOverBy: threshold === null ? 0 : Math.max(0, Math.round((projectedH - threshold) * 100) / 100),
      doubleTimeOverBy: dt === null ? 0 : Math.max(0, Math.round((projectedH - dt) * 100) / 100),
      basis: projectedMs === 0 ? 'NONE' : earned ? 'ACTUAL' : 'FORECAST',
    };
  });

  const actualWeekMs = input.days.reduce((a, d) => a + d.actualMs, 0);
  const projectedWeekMs = input.days.reduce(
    (a, d) => a + d.actualMs + remainingPlannedMs(d, now),
    0,
  );
  const weeklyThreshold = rules.weeklyOtHours;
  const projectedWeekH = hours(projectedWeekMs);
  const actualWeekH = hours(actualWeekMs);

  // Consecutive run of days the agent is expected on, or has already worked.
  let run = 0;
  let best = 0;
  for (const d of input.days) {
    if (d.scheduled || d.actualMs > 0) {
      run += 1;
      best = Math.max(best, run);
    } else {
      run = 0;
    }
  }

  return {
    rules,
    weekStartDate: input.days[0]?.workDate ?? '',
    days,
    weekly: {
      actualHours: actualWeekH,
      projectedHours: projectedWeekH,
      thresholdHours: weeklyThreshold,
      overBy: Math.max(0, Math.round((projectedWeekH - weeklyThreshold) * 100) / 100),
      basis:
        projectedWeekMs === 0
          ? 'NONE'
          : actualWeekH > weeklyThreshold
            ? 'ACTUAL'
            : 'FORECAST',
    },
    consecutiveDays: best,
    seventhDayRisk: rules.seventhDayRule && best >= 7,
  };
}

/** Monday-start ISO week containing `date`, or Sunday-start when told to. */
export function weekStart(date: Date, startsOn: 0 | 1 = 0): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const shift = (d.getUTCDay() - startsOn + 7) % 7;
  d.setUTCDate(d.getUTCDate() - shift);
  return d;
}
