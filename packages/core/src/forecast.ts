/**
 * Forecasting: coverage dips, overtime risk, meal-deadline risk, and adherence
 * findings, turned into alert drafts the supervisor board can act on.
 *
 * WHAT "AI" MEANS HERE, precisely, because it matters in a wage-and-hour system.
 *
 * Every number below is arithmetic over the schedule and the punch stream. There
 * is no model in the loop and no estimate: a supervisor can reproduce any figure
 * with a calculator, which is the only reason they will still trust it after it
 * disagrees with them. A language model that invented a projected overtime figure
 * — or quietly rounded one — would be producing evidence about hours worked, and
 * that is not a place for plausible-sounding output.
 *
 * The model's job is the layer above: taking a pile of findings and telling the
 * supervisor which three matter this morning and why, in a sentence. That is the
 * SummaryProvider seam at the bottom of this file. It receives the computed
 * findings and returns prose. It never computes, and nothing downstream reads its
 * output as data — `templateSummary` is the default and needs no model at all.
 *
 * COVERAGE, and its honest limitation. With no demand forecast to compare against,
 * "coverage issue" can only mean a RELATIVE dip: a slot staffed materially below
 * the day's own peak. That catches the real thing this is for — everyone taking
 * lunch at noon — but it cannot know that Tuesday at 14:00 needs six people.
 * Pass `requiredBySlot` once a volume forecast exists and the same code becomes an
 * absolute check.
 */

import type { AdherenceFinding, AdherenceResult, PlannedShift, Severity } from './adherence';
import type { OvertimeProjection } from './overtime';
import type { StateRules } from './rules';
import { mealDeadlineMs } from './rules';

export type AlertKind =
  | 'COVERAGE_GAP'
  | 'OT_DAILY_FORECAST'
  | 'OT_WEEKLY_FORECAST'
  | 'OT_DAILY_ACTUAL'
  | 'OT_WEEKLY_ACTUAL'
  | 'MEAL_DEADLINE_FORECAST'
  | 'SEVENTH_DAY_FORECAST'
  | 'LATE_IN'
  | 'EARLY_IN'
  | 'LATE_OUT'
  | 'EARLY_OUT'
  | 'MISSED_SHIFT'
  | 'UNSCHEDULED_SHIFT'
  | 'LATE_MEAL_START'
  | 'MEAL_OVER_SCHEDULE';

export interface AlertDraft {
  workDate: string;
  kind: AlertKind;
  severity: Severity;
  message: string;
  agentId?: string | null;
  /** Persisted verbatim. `slot` participates in the dedupe key. */
  detail: Record<string, unknown>;
}

/* ------------------------------------------------------------------ coverage */

export interface ScheduledInterval {
  agentId: string;
  displayName?: string;
  startUtc: string;
  endUtc: string;
  lunchUtc: string | null;
  lunchMinutes: number | null;
}

export interface CoverageSlot {
  slotStartUtc: string;
  /** Bodies on the clock in this slot, with scheduled meals removed. */
  scheduled: number;
  required: number;
  deficit: number;
}

export interface CoverageOptions {
  slotMinutes?: number;
  /** Percent of the day's peak that counts as adequate. Mirrors tenant.coverage_threshold_pct. */
  thresholdPct?: number;
  /** Absolute requirement per slot start (ISO). Overrides the relative rule. */
  requiredBySlot?: Record<string, number>;
  /** Ignore dips shorter than this — a 15-minute trough is not a staffing crisis. */
  minGapMinutes?: number;
}

const MIN = 60_000;

export function coverageBySlot(
  intervals: ScheduledInterval[],
  opts: CoverageOptions = {},
): CoverageSlot[] {
  const slotMs = (opts.slotMinutes ?? 15) * MIN;
  if (!intervals.length) return [];

  const starts = intervals.map((i) => new Date(i.startUtc).getTime());
  const ends = intervals.map((i) => new Date(i.endUtc).getTime());
  const dayStart = Math.floor(Math.min(...starts) / slotMs) * slotMs;
  const dayEnd = Math.ceil(Math.max(...ends) / slotMs) * slotMs;

  const counts: { slot: number; n: number }[] = [];
  for (let t = dayStart; t < dayEnd; t += slotMs) {
    let n = 0;
    for (const iv of intervals) {
      const s = new Date(iv.startUtc).getTime();
      const e = new Date(iv.endUtc).getTime();
      if (t + slotMs <= s || t >= e) continue;

      // Scheduled meal removes them from the floor for its duration.
      const lm = iv.lunchMinutes ?? 0;
      if (lm > 0 && iv.lunchUtc) {
        const ls = new Date(iv.lunchUtc).getTime();
        const le = ls + lm * MIN;
        if (t < le && t + slotMs > ls) continue;
      }
      n += 1;
    }
    counts.push({ slot: t, n });
  }

  const peak = counts.reduce((m, c) => Math.max(m, c.n), 0);
  const pct = opts.thresholdPct ?? 70;

  return counts.map((c) => {
    const iso = new Date(c.slot).toISOString();
    const required =
      opts.requiredBySlot?.[iso] ??
      // Relative rule: the day's own peak, scaled. Only meaningful where the day
      // actually has staff — an empty slot at 03:00 is not a gap.
      (c.n === 0 ? 0 : Math.ceil((peak * pct) / 100));
    return {
      slotStartUtc: iso,
      scheduled: c.n,
      required,
      deficit: Math.max(0, required - c.n),
    };
  });
}

export interface CoverageGap {
  fromUtc: string;
  toUtc: string;
  minScheduled: number;
  required: number;
  worstDeficit: number;
  minutes: number;
}

export function coverageGaps(slots: CoverageSlot[], opts: CoverageOptions = {}): CoverageGap[] {
  const slotMinutes = opts.slotMinutes ?? 15;
  const minGap = opts.minGapMinutes ?? 30;
  const gaps: CoverageGap[] = [];
  let open: CoverageSlot[] = [];

  const flush = (): void => {
    if (!open.length) return;
    const minutes = open.length * slotMinutes;
    if (minutes >= minGap) {
      const last = open[open.length - 1]!;
      gaps.push({
        fromUtc: open[0]!.slotStartUtc,
        toUtc: new Date(new Date(last.slotStartUtc).getTime() + slotMinutes * MIN).toISOString(),
        minScheduled: Math.min(...open.map((s) => s.scheduled)),
        required: Math.max(...open.map((s) => s.required)),
        worstDeficit: Math.max(...open.map((s) => s.deficit)),
        minutes,
      });
    }
    open = [];
  };

  for (const s of slots) {
    if (s.deficit > 0) open.push(s);
    else flush();
  }
  flush();
  return gaps;
}

export function forecastCoverage(
  workDate: string,
  intervals: ScheduledInterval[],
  opts: CoverageOptions = {},
): AlertDraft[] {
  const gaps = coverageGaps(coverageBySlot(intervals, opts), opts);
  return gaps.map((g) => ({
    workDate,
    kind: 'COVERAGE_GAP' as const,
    severity: (g.worstDeficit >= 3 ? 'CRITICAL' : 'WARN') as Severity,
    message:
      `Coverage dips to ${g.minScheduled} of ${g.required} between ` +
      `${hhmm(g.fromUtc)} and ${hhmm(g.toUtc)} UTC (${g.minutes} min).`,
    agentId: null,
    // `slot` is the dedupe discriminator: two gaps on one day are two alerts.
    detail: { ...g, slot: g.fromUtc },
  }));
}

const hhmm = (iso: string): string => iso.slice(11, 16);

/* ------------------------------------------------------------------ overtime */

export function forecastOvertime(
  agentId: string,
  displayName: string,
  p: OvertimeProjection,
): AlertDraft[] {
  const out: AlertDraft[] = [];

  for (const d of p.days) {
    if (d.dailyOverBy <= 0) continue;
    const actual = d.basis === 'ACTUAL';
    out.push({
      workDate: d.workDate,
      kind: actual ? 'OT_DAILY_ACTUAL' : 'OT_DAILY_FORECAST',
      severity: d.doubleTimeOverBy > 0 ? 'CRITICAL' : 'WARN',
      message:
        `${displayName} ${actual ? 'has worked' : 'is on track for'} ` +
        `${d.projectedHours}h on ${d.workDate}, ` +
        `${d.dailyOverBy}h over the ${d.dailyThresholdHours}h daily threshold` +
        (d.doubleTimeOverBy > 0 ? ` (${d.doubleTimeOverBy}h into double time)` : '') +
        ` — ${p.rules.jurisdiction}.`,
      agentId,
      detail: {
        projectedHours: d.projectedHours,
        actualHours: d.actualHours,
        thresholdHours: d.dailyThresholdHours,
        overBy: d.dailyOverBy,
        doubleTimeOverBy: d.doubleTimeOverBy,
        basis: d.basis,
        state: p.rules.state,
      },
    });
  }

  if (p.weekly.overBy > 0) {
    const actual = p.weekly.basis === 'ACTUAL';
    out.push({
      workDate: p.weekStartDate,
      kind: actual ? 'OT_WEEKLY_ACTUAL' : 'OT_WEEKLY_FORECAST',
      severity: p.weekly.overBy >= 8 ? 'CRITICAL' : 'WARN',
      message:
        `${displayName} ${actual ? 'has reached' : 'is projected to reach'} ` +
        `${p.weekly.projectedHours}h for the week beginning ${p.weekStartDate}, ` +
        `${p.weekly.overBy}h over ${p.weekly.thresholdHours}h.`,
      agentId,
      detail: {
        projectedHours: p.weekly.projectedHours,
        actualHours: p.weekly.actualHours,
        thresholdHours: p.weekly.thresholdHours,
        overBy: p.weekly.overBy,
        basis: p.weekly.basis,
        state: p.rules.state,
      },
    });
  }

  if (p.seventhDayRisk) {
    out.push({
      workDate: p.weekStartDate,
      kind: 'SEVENTH_DAY_FORECAST',
      severity: 'WARN',
      message:
        `${displayName} is scheduled ${p.consecutiveDays} consecutive days. ` +
        `${p.rules.jurisdiction} applies a seventh-day premium.`,
      agentId,
      detail: { consecutiveDays: p.consecutiveDays, state: p.rules.state },
    });
  }

  return out;
}

/* -------------------------------------------------------------- meal risk */

/**
 * Does the SCHEDULE itself breach the meal deadline? Worth catching at the point
 * the schedule is written rather than at 13:05 on the day, and only meaningful
 * where the jurisdiction has a deadline at all.
 */
export function forecastMealDeadline(
  agentId: string,
  displayName: string,
  workDate: string,
  planned: PlannedShift,
  rules: StateRules,
): AlertDraft[] {
  const deadlineMs = mealDeadlineMs(rules);
  if (deadlineMs === null || !planned.startUtc || !planned.endUtc) return [];

  const start = new Date(planned.startUtc).getTime();
  const end = new Date(planned.endUtc).getTime();
  const shiftMs = end - start;
  if (shiftMs <= deadlineMs) return []; // too short to owe a meal

  const deadline = start + deadlineMs;

  if (!planned.lunchUtc || !planned.lunchMinutes) {
    return [
      {
        workDate,
        kind: 'MEAL_DEADLINE_FORECAST',
        severity: 'CRITICAL',
        message:
          `${displayName} is scheduled ${Math.round(shiftMs / 3_600_000)}h on ${workDate} ` +
          `with no meal period. ${rules.jurisdiction} requires one to start before ` +
          `${hhmm(new Date(deadline).toISOString())} UTC.`,
        agentId,
        detail: { deadlineUtc: new Date(deadline).toISOString(), state: rules.state, scheduledMeal: null },
      },
    ];
  }

  const lunch = new Date(planned.lunchUtc).getTime();
  if (lunch >= deadline) {
    const lateBy = Math.round((lunch - deadline) / MIN);
    return [
      {
        workDate,
        kind: 'MEAL_DEADLINE_FORECAST',
        severity: 'CRITICAL',
        message:
          `${displayName}'s scheduled meal on ${workDate} starts ${lateBy} min after the ` +
          `${rules.mealDeadlineHours}-hour deadline. As scheduled this owes a premium hour.`,
        agentId,
        detail: {
          deadlineUtc: new Date(deadline).toISOString(),
          scheduledMeal: planned.lunchUtc,
          lateByMinutes: lateBy,
          state: rules.state,
        },
      },
    ];
  }
  if (planned.lunchMinutes < rules.mealMinMinutes) {
    return [
      {
        workDate,
        kind: 'MEAL_DEADLINE_FORECAST',
        severity: 'WARN',
        message:
          `${displayName}'s scheduled meal on ${workDate} is ${planned.lunchMinutes} min; ` +
          `the minimum is ${rules.mealMinMinutes}. The clock will refuse the early return.`,
        agentId,
        detail: { scheduledMinutes: planned.lunchMinutes, minimum: rules.mealMinMinutes, state: rules.state },
      },
    ];
  }
  return [];
}

/* ------------------------------------------------------- adherence findings */

const ADHERENCE_TO_ALERT: Partial<Record<AdherenceFinding['code'], AlertKind>> = {
  LATE_IN: 'LATE_IN',
  EARLY_IN: 'EARLY_IN',
  LATE_OUT: 'LATE_OUT',
  EARLY_OUT: 'EARLY_OUT',
  MISSED_SHIFT: 'MISSED_SHIFT',
  UNSCHEDULED_SHIFT: 'UNSCHEDULED_SHIFT',
  LATE_MEAL_START: 'LATE_MEAL_START',
  MEAL_OVER_SCHEDULE: 'MEAL_OVER_SCHEDULE',
};

export function adherenceAlerts(
  agentId: string,
  displayName: string,
  workDate: string,
  result: AdherenceResult,
): AlertDraft[] {
  const out: AlertDraft[] = [];
  for (const f of result.findings) {
    const kind = ADHERENCE_TO_ALERT[f.code];
    // MEAL_NOT_TAKEN and MULTIPLE_SHIFTS are deliberately not alerts: the first is
    // already a compliance_exception with a premium attached, and duplicating it
    // here would have a supervisor resolve the same thing twice.
    if (!kind) continue;
    out.push({
      workDate,
      kind,
      severity: f.severity,
      message: `${displayName}: ${f.message}`,
      agentId,
      detail: { code: f.code, minutes: f.minutes ?? null, variance: result.variance },
    });
  }
  return out;
}

/* ----------------------------------------------------------- narration seam */

export interface ForecastBundle {
  workDate: string;
  alerts: AlertDraft[];
  coverage: CoverageSlot[];
  headcount: { scheduled: number; absent: number; onDuty: number };
}

/**
 * Turns computed findings into prose for the supervisor's morning read.
 *
 * An LLM implementation is a reasonable thing to put here — ranking and phrasing
 * are what it is good at. Two constraints it must respect, and they are not
 * stylistic:
 *
 *   1. It receives the finished numbers and may not recompute them. Every figure
 *      in the prose has to be traceable to an AlertDraft.detail field.
 *   2. Its output is presentation. Nothing reads it back as data, no decision
 *      branches on it, and it never reaches payroll.
 */
export interface SummaryProvider {
  summarize(bundle: ForecastBundle): Promise<string>;
}

/** Deterministic default. No model, no network, same input yields same sentence. */
export const templateSummary: SummaryProvider = {
  async summarize(b: ForecastBundle): Promise<string> {
    if (!b.alerts.length) {
      return `${b.workDate}: ${b.headcount.scheduled} scheduled, ${b.headcount.onDuty} on duty, nothing outstanding.`;
    }
    const bySev = (s: Severity): number => b.alerts.filter((a) => a.severity === s).length;
    const parts = [
      `${b.workDate}: ${b.alerts.length} item${b.alerts.length === 1 ? '' : 's'}`,
      `${bySev('CRITICAL')} critical, ${bySev('WARN')} warning, ${bySev('INFO')} informational`,
    ];
    const worst = b.alerts.find((a) => a.severity === 'CRITICAL') ?? b.alerts[0]!;
    parts.push(`most pressing: ${worst.message}`);
    return `${parts.join('. ')}.`;
  },
};
