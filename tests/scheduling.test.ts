// Smoke test: adherence classification, overtime projection, coverage forecasting.
// Every clock is injected — nothing here reads Date.now(), so the same input gives
// the same verdict on every run and on every replica.
import { finish } from './assert';   // makes a failed console.assert exit non-zero
import { evaluateAdherence, worstSeverity } from '../packages/core/src/adherence';
import { assessOvertime, remainingPlannedMs, weekStart } from '../packages/core/src/overtime';
import {
  coverageBySlot,
  coverageGaps,
  forecastCoverage,
  forecastMealDeadline,
  forecastOvertime,
  templateSummary,
} from '../packages/core/src/forecast';
import { FEDERAL_DEFAULT, hasMealPenalty, type StateRules } from '../packages/core/src/rules';

const CA: StateRules = {
  ...FEDERAL_DEFAULT,
  state: 'CA',
  jurisdiction: 'California',
  mealRequired: true,
  mealDeadlineHours: 5,
  mealPremiumRequired: true,
  secondMealHours: 10,
  dailyOtHours: 8,
  doubleTimeHours: 12,
  seventhDayRule: true,
};
const TX: StateRules = { ...FEDERAL_DEFAULT, state: 'TX', jurisdiction: 'Texas' };

const iso = (h: number, m = 0) =>
  new Date(Date.UTC(2026, 7, 26, h, m, 0)).toISOString(); // 2026-08-26

// ---------------------------------------------------------------- state rules
console.assert(hasMealPenalty(CA), 'CA carries a meal penalty');
console.assert(!hasMealPenalty(TX), 'TX does not');
console.assert(TX.mealMinMinutes === 30, 'the federal 30-minute floor applies everywhere');
console.assert(TX.dailyOtHours === null, 'no daily OT under FLSA alone');

// ----------------------------------------------------------------- adherence
const planned = {
  kind: 'WORK' as const,
  source: 'PATTERN' as const,
  startUtc: iso(15), // 08:00 PT
  lunchUtc: iso(19),
  lunchMinutes: 30,
  endUtc: iso(23, 30),
  scheduledMinutes: 480,
};
const actualOnTime = {
  firstInUtc: iso(15, 2),
  lunchOutUtc: iso(19, 3),
  lunchInUtc: iso(19, 35),
  lastOutUtc: iso(23, 28),
  workedMs: 7.5 * 3_600_000,
  breakMs: 0,
  lunchMs: 32 * 60_000,
  breaks: 0,
  complete: true,
  shiftCount: 1,
};

let r = evaluateAdherence({ planned, actual: actualOnTime, graceMinutes: 5, now: new Date(iso(23, 59)) });
console.assert(r.status === 'ON_SCHEDULE', `on schedule, got ${r.status} ${JSON.stringify(r.findings)}`);
console.assert(r.variance.in === 2, `in variance 2, got ${r.variance.in}`);
console.assert(worstSeverity(r.findings) === null, 'nothing to report');

// Late in, meal over, early out — three findings, one verdict.
r = evaluateAdherence({
  planned,
  actual: { ...actualOnTime, firstInUtc: iso(15, 22), lunchMs: 50 * 60_000, lastOutUtc: iso(23, 5) },
  graceMinutes: 5,
  now: new Date(iso(23, 59)),
});
console.assert(r.status === 'OFF_SCHEDULE', 'off schedule');
const codes = r.findings.map((f) => f.code).sort().join(',');
console.assert(codes === 'EARLY_OUT,LATE_IN,MEAL_OVER_SCHEDULE', `codes: ${codes}`);
console.assert(r.variance.in === 22, `in ${r.variance.in}`);
console.assert(r.variance.out === -25, `out ${r.variance.out}`);

// Grace is symmetric: 4 minutes either side is silence, 6 is not.
for (const [off, expected] of [[4, 'ON_SCHEDULE'], [-4, 'ON_SCHEDULE'], [6, 'OFF_SCHEDULE'], [-6, 'OFF_SCHEDULE']] as const) {
  const rr = evaluateAdherence({
    planned,
    actual: { ...actualOnTime, firstInUtc: iso(15, 0 + Math.abs(off) * (off < 0 ? -1 : 1)) },
    graceMinutes: 5,
    now: new Date(iso(23, 59)),
  });
  // A negative offset from 15:00 needs the previous hour.
  const at = off < 0 ? new Date(Date.UTC(2026, 7, 26, 15, off)).toISOString() : iso(15, off);
  const rr2 = evaluateAdherence({
    planned,
    actual: { ...actualOnTime, firstInUtc: at },
    graceMinutes: 5,
    now: new Date(iso(23, 59)),
  });
  console.assert(rr2.status === expected, `offset ${off} => ${rr2.status}, expected ${expected}`);
  void rr;
}

// Scheduled, nobody clocked in.
r = evaluateAdherence({ planned, actual: null, graceMinutes: 5, now: new Date(iso(15, 3)) });
console.assert(r.status === 'IN_PROGRESS', 'inside grace, still silent');
r = evaluateAdherence({ planned, actual: null, graceMinutes: 5, now: new Date(iso(15, 40)) });
console.assert(r.findings[0]?.code === 'MISSED_SHIFT' && r.findings[0]?.severity === 'WARN', 'late');
r = evaluateAdherence({ planned, actual: null, graceMinutes: 5, now: new Date(iso(17, 0)) });
console.assert(r.findings[0]?.severity === 'CRITICAL', 'an hour past start escalates');

// Absences and unscheduled work.
r = evaluateAdherence({ planned: { ...planned, kind: 'HOLIDAY' }, actual: null, now: new Date(iso(20)) });
console.assert(r.status === 'ABSENT' && r.findings.length === 0, 'a holiday is not a finding');
r = evaluateAdherence({
  planned: { ...planned, kind: 'VACATION' },
  actual: actualOnTime,
  now: new Date(iso(23, 59)),
});
console.assert(r.findings[0]?.code === 'UNSCHEDULED_SHIFT', 'worked through approved leave');
r = evaluateAdherence({ planned: null, actual: actualOnTime, now: new Date(iso(23, 59)) });
console.assert(r.status === 'OFF_SCHEDULE', 'worked with no schedule');
r = evaluateAdherence({ planned: null, actual: null, now: new Date(iso(20)) });
console.assert(r.status === 'NOT_SCHEDULED', 'a day off is not a finding');

// A meal that was required and never taken.
r = evaluateAdherence({
  planned,
  actual: { ...actualOnTime, lunchOutUtc: null, lunchInUtc: null, lunchMs: 0 },
  mealRequired: true,
  now: new Date(iso(23, 59)),
});
console.assert(
  r.findings.some((f) => f.code === 'MEAL_NOT_TAKEN' && f.severity === 'CRITICAL'),
  'a scheduled meal that never happened is critical',
);

// ------------------------------------------------------------------ overtime
const day = (d: string, workedH: number, plannedStart: string, plannedEnd: string, complete = true) => ({
  workDate: d,
  scheduled: true,
  plannedStartUtc: plannedStart,
  plannedEndUtc: plannedEnd,
  plannedLunchUtc: null,
  plannedLunchMinutes: 30,
  plannedMinutes: 480,
  actualMs: workedH * 3_600_000,
  complete,
});

// A finished 9-hour day in California is an hour of daily overtime, already earned.
let ot = assessOvertime({
  rules: CA,
  days: [day('2026-08-24', 9, '2026-08-24T15:00:00Z', '2026-08-24T23:30:00Z')],
  now: new Date('2026-08-25T00:00:00Z'),
});
console.assert(ot.days[0]!.dailyOverBy === 1, `daily over by 1, got ${ot.days[0]!.dailyOverBy}`);
console.assert(ot.days[0]!.basis === 'ACTUAL', 'a closed day is actual, not forecast');
console.assert(ot.days[0]!.doubleTimeOverBy === 0, 'nowhere near double time');

// The same day in Texas is not overtime at all.
ot = assessOvertime({
  rules: TX,
  days: [day('2026-08-24', 9, '2026-08-24T15:00:00Z', '2026-08-24T23:30:00Z')],
  now: new Date('2026-08-25T00:00:00Z'),
});
console.assert(ot.days[0]!.dailyOverBy === 0, 'no daily threshold in Texas');
console.assert(ot.weekly.overBy === 0, 'and 9 hours is not a weekly breach');

// Projection: nothing worked yet, five 8-hour days scheduled -> 40h, no breach.
const week = ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28'].map((d) => ({
  ...day(d, 0, `${d}T15:00:00Z`, `${d}T23:30:00Z`, false),
  plannedLunchUtc: `${d}T19:00:00Z`,
}));
ot = assessOvertime({ rules: CA, days: week, now: new Date('2026-08-24T00:00:00Z') });
console.assert(ot.weekly.projectedHours === 40, `projected 40, got ${ot.weekly.projectedHours}`);
console.assert(ot.weekly.overBy === 0, 'exactly at the threshold is not over it');
console.assert(ot.weekly.basis === 'FORECAST', 'nothing worked yet, so it is a forecast');

// Add a sixth scheduled day and the week is projected over 40 before it happens.
ot = assessOvertime({
  rules: CA,
  days: [...week, { ...day('2026-08-29', 0, '2026-08-29T15:00:00Z', '2026-08-29T23:30:00Z', false), plannedLunchUtc: '2026-08-29T19:00:00Z' }],
  now: new Date('2026-08-24T00:00:00Z'),
});
console.assert(ot.weekly.overBy === 8, `weekly over by 8, got ${ot.weekly.overBy}`);
console.assert(ot.consecutiveDays === 6, `6 consecutive, got ${ot.consecutiveDays}`);
console.assert(!ot.seventhDayRisk, 'six days is not seven');

// remainingPlannedMs is the whole mechanism; check the three positions directly.
const d0 = week[0]!;
console.assert(remainingPlannedMs(d0, new Date('2026-08-24T14:00:00Z')) === 8 * 3_600_000,
  'before the shift: the whole thing, less the meal');
console.assert(remainingPlannedMs(d0, new Date('2026-08-25T00:00:00Z')) === 0, 'after: nothing');
const mid = remainingPlannedMs(d0, new Date('2026-08-24T21:00:00Z'));
console.assert(mid === 2.5 * 3_600_000, `mid-shift after the meal: 2.5h, got ${mid / 3_600_000}`);

console.assert(weekStart(new Date('2026-08-26T12:00:00Z'), 0).toISOString().slice(0, 10) === '2026-08-23',
  'Sunday-start week');
console.assert(weekStart(new Date('2026-08-26T12:00:00Z'), 1).toISOString().slice(0, 10) === '2026-08-24',
  'Monday-start week');

// ------------------------------------------------------------------ coverage
// Four agents, all taking the same meal at 12:00 local. That trough is the thing
// this is for.
const intervals = ['a', 'b', 'c', 'd'].map((id) => ({
  agentId: id,
  startUtc: '2026-08-26T15:00:00Z',
  endUtc: '2026-08-26T23:30:00Z',
  lunchUtc: '2026-08-26T19:00:00Z',
  lunchMinutes: 30,
}));
const slots = coverageBySlot(intervals, { thresholdPct: 70, slotMinutes: 15 });
// The meal runs 19:00-19:30, so only those two slots are empty; 19:30 onward is
// back to four. Filtering the whole 19:00 hour was the first version of this test
// and it failed for the right reason.
const trough = slots.filter(
  (s) => s.slotStartUtc === '2026-08-26T19:00:00.000Z' || s.slotStartUtc === '2026-08-26T19:15:00.000Z',
);
console.assert(trough.length === 2, `two empty slots, got ${trough.length}`);
console.assert(trough.every((s) => s.scheduled === 0), 'everyone is off the floor at once');
console.assert(trough.every((s) => s.deficit === 0),
  'an empty slot is not a deficit — with nobody scheduled, nobody is required');
console.assert(
  slots.filter((s) => s.slotStartUtc === '2026-08-26T19:30:00.000Z')[0]?.scheduled === 4,
  'and the floor refills the moment the meal ends',
);

// Stagger three of them and the remaining dip is a real, reportable gap.
const staggered = intervals.map((iv, i) => ({
  ...iv,
  lunchUtc: `2026-08-26T${19 + Math.floor(i / 2)}:${i % 2 === 0 ? '00' : '30'}:00Z`,
}));
const gaps = coverageGaps(
  coverageBySlot(staggered, { thresholdPct: 90, slotMinutes: 15 }),
  { slotMinutes: 15, minGapMinutes: 15 },
);
console.assert(gaps.length > 0, 'a staggered meal rotation still dips below a 90% bar');
console.assert(gaps.every((g) => g.minutes >= 15), 'gaps respect the minimum width');

const covAlerts = forecastCoverage('2026-08-26', staggered, { thresholdPct: 90, minGapMinutes: 15 });
console.assert(covAlerts.every((a) => typeof a.detail.slot === 'string'),
  'every coverage alert carries a slot, or the dedupe key collapses them');
console.assert(new Set(covAlerts.map((a) => a.detail.slot)).size === covAlerts.length,
  'and the slots are distinct');

// A gap shorter than the minimum is not worth a supervisor's attention. The
// staggered rotation leaves exactly one person off the floor from 19:00 to 21:00,
// which is a 120-minute deficit against a 90% bar — so 120 does NOT suppress it
// and 180 does. Worth pinning: an off-by-one here silently mutes real gaps.
const wide = coverageGaps(coverageBySlot(staggered, { thresholdPct: 90 }), { minGapMinutes: 120 });
console.assert(wide.length === 1 && wide[0]!.minutes === 120, `expected one 120-min gap, got ${JSON.stringify(wide)}`);
console.assert(
  coverageGaps(coverageBySlot(staggered, { thresholdPct: 90 }), { minGapMinutes: 180 }).length === 0,
  'minGapMinutes suppresses anything narrower than the bar',
);

// -------------------------------------------------------------- meal at risk
const lateMealPlan = {
  kind: 'WORK' as const,
  source: 'PATTERN' as const,
  startUtc: '2026-08-26T15:00:00Z',
  lunchUtc: '2026-08-26T20:30:00Z', // 5h30 in — past the 5th hour
  lunchMinutes: 30,
  endUtc: '2026-08-27T00:00:00Z',
  scheduledMinutes: 510,
};
let mealAlerts = forecastMealDeadline('a', 'Priya', '2026-08-26', lateMealPlan, CA);
console.assert(mealAlerts.length === 1 && mealAlerts[0]!.severity === 'CRITICAL',
  'a schedule that breaches the deadline is caught before the day starts');
console.assert(String(mealAlerts[0]!.detail.lateByMinutes) === '30', 'and says by how much');

mealAlerts = forecastMealDeadline('a', 'Marco', '2026-08-26', lateMealPlan, TX);
console.assert(mealAlerts.length === 0, 'the same schedule is unremarkable in Texas');

mealAlerts = forecastMealDeadline(
  'a', 'Priya', '2026-08-26',
  { ...lateMealPlan, lunchUtc: null, lunchMinutes: null }, CA,
);
console.assert(mealAlerts.length === 1 && mealAlerts[0]!.detail.scheduledMeal === null,
  'a long CA shift with no meal scheduled at all is critical');

mealAlerts = forecastMealDeadline(
  'a', 'Priya', '2026-08-26',
  { ...lateMealPlan, endUtc: '2026-08-26T19:00:00Z', lunchUtc: null, lunchMinutes: null }, CA,
);
console.assert(mealAlerts.length === 0, 'a 4-hour shift owes no meal');

// ------------------------------------------------------------ alert assembly
const otAlerts = forecastOvertime('a', 'Priya', ot);
console.assert(otAlerts.some((a) => a.kind === 'OT_WEEKLY_FORECAST'), 'weekly forecast alert');
console.assert(otAlerts.every((a) => a.agentId === 'a'), 'attributed to the agent');
console.assert(
  otAlerts.every((a) => typeof a.detail.state === 'string'),
  'each alert records which jurisdiction produced it',
);

// The default summariser is deterministic — same input, same sentence, no model.
// Wrapped rather than top-level await so this compiles to CommonJS and runs with
// plain `node`, like the other smoke suite.
async function summaryChecks(): Promise<void> {
  const bundle = {
    workDate: '2026-08-26',
    alerts: otAlerts,
    coverage: [],
    headcount: { scheduled: 4, absent: 0, onDuty: 3 },
  };
  const s1 = await templateSummary.summarize(bundle);
  const s2 = await templateSummary.summarize(bundle);
  console.assert(s1 === s2, 'the default summary is deterministic');
  console.assert(s1.includes('2026-08-26'), 'and mentions the day');
  finish('scheduling');
  console.log('ALL SCHEDULING TESTS PASSED');
  console.log('summary:', s1);
}

void summaryChecks();
