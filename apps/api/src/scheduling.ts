/**
 * In-memory scheduler + forecast engine.
 *
 * The heavy lifting is the portable core (from bs5_1): adherence, overtime and
 * forecast are pure functions that take planned instants, actual instants and
 * the state rules. This module is the glue that resolves the repeating pattern
 * (+ per-date exceptions) into instants in each agent's timezone, reads actuals
 * off the punch stream, and feeds both into the core — then upserts nothing yet:
 * it returns alert drafts + a narration summary the supervisor board renders.
 *
 * Times are stored as local wall clock ("08:00") plus the agent's IANA zone and
 * resolved to an instant per date, so DST is the zone database's problem.
 */
import {
  adherenceAlerts,
  assessOvertime,
  evaluateAdherence,
  forecastCoverage,
  forecastMealDeadline,
  forecastOvertime,
  projectShift,
  templateSummary,
  weekStart,
  WORKING_KINDS,
  type ActualShift,
  type AlertDraft,
  type DayLoad,
  type PlannedShift,
  type ScheduledInterval,
  type ScheduleKind,
  type SummaryProvider,
} from '@timeclock/core';
import type { Store } from './store/contract.js';
import { rulesForState } from './stateRules.js';
import type { Agent, PunchEvent } from './types.js';

// ------------------------------------------------------------ tz helpers
function tzOffsetMs(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(instant).map((x) => [x.type, x.value])) as Record<
    string,
    string
  >;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - instant.getTime();
}

/** Interpret a local wall time (YYYY-MM-DD, HH:MM) in a zone as a UTC instant. */
export function zonedToUtc(dateStr: string, timeStr: string, timeZone: string): Date {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let utc = guess - tzOffsetMs(new Date(guess), timeZone);
  utc = guess - tzOffsetMs(new Date(utc), timeZone); // one refinement for DST edges
  return new Date(utc);
}

function addDays(dateStr: string, n: number): string {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d));
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
function weekdayOf(dateStr: string): number {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

// ------------------------------------------------------ schedule resolution
/** Resolve one date to a planned shift: exception > pattern > unscheduled. */
export function resolvePlanned(db: Store, agent: Agent, dateStr: string): PlannedShift {
  const ex = db.getScheduleException(agent.id, dateStr);
  const row = ex ?? db.patternForWeekday(agent.id, weekdayOf(dateStr));
  const source: PlannedShift['source'] = ex ? 'EXCEPTION' : row ? 'PATTERN' : 'UNSCHEDULED';

  if (!row) {
    return { kind: 'OFF', source, startUtc: null, lunchUtc: null, lunchMinutes: null, endUtc: null, scheduledMinutes: 0 };
  }
  const kind = row.kind as ScheduleKind;
  if (!WORKING_KINDS.has(kind) || !row.startTime || !row.endTime) {
    return { kind, source, startUtc: null, lunchUtc: null, lunchMinutes: null, endUtc: null, scheduledMinutes: 0 };
  }
  const startUtc = zonedToUtc(dateStr, row.startTime, agent.timezone);
  const endDate = row.endTime <= row.startTime ? addDays(dateStr, 1) : dateStr; // overnight
  const endUtc = zonedToUtc(endDate, row.endTime, agent.timezone);
  let lunchUtc: Date | null = null;
  if (row.lunchTime) {
    const lunchDate = row.lunchTime < row.startTime ? addDays(dateStr, 1) : dateStr;
    lunchUtc = zonedToUtc(lunchDate, row.lunchTime, agent.timezone);
  }
  // Paid-lunch model: scheduled minutes are the full span (meal not subtracted).
  const scheduledMinutes = Math.round((endUtc.getTime() - startUtc.getTime()) / 60_000);
  return {
    kind,
    source,
    startUtc: startUtc.toISOString(),
    endUtc: endUtc.toISOString(),
    lunchUtc: lunchUtc?.toISOString() ?? null,
    lunchMinutes: row.lunchMinutes ?? null,
    scheduledMinutes,
  };
}

// ------------------------------------------------------- actuals off the stream
function buildActual(events: PunchEvent[], now: Date): ActualShift | null {
  if (events.length === 0) return null;
  const proj = projectShift(events, now);
  const first = (t: PunchEvent['eventType']) => events.find((e) => e.eventType === t) ?? null;
  const last = (t: PunchEvent['eventType']) => [...events].reverse().find((e) => e.eventType === t) ?? null;
  const firstIn = first('IN');
  if (!firstIn) return null;
  const complete = proj.status === 'CLOCKED_OUT';
  return {
    firstInUtc: firstIn.eventTime.toISOString(),
    lunchOutUtc: first('LUNCH_START')?.eventTime.toISOString() ?? null,
    lunchInUtc: first('LUNCH_END')?.eventTime.toISOString() ?? null,
    lastOutUtc: complete ? last('OUT')?.eventTime.toISOString() ?? null : null,
    workedMs: proj.workedMs,
    breakMs: proj.breakMs,
    lunchMs: proj.lunchMs,
    breaks: events.filter((e) => e.eventType === 'BREAK_START').length,
    complete,
    shiftCount: events.filter((e) => e.eventType === 'IN').length,
  };
}

// --------------------------------------------------------------- forecast run
export interface ForecastResult {
  date: string;
  summary: string;
  summaryBy: string; // 'claude' | 'template' — which provider wrote the summary
  alerts: AlertDraft[];
  headcount: { scheduled: number; absent: number; onDuty: number };
}

export async function runForecast(
  db: Store,
  tenantId: string,
  dateStr: string,
  now: Date = new Date(),
  summaryProvider: SummaryProvider = templateSummary,
): Promise<ForecastResult> {
  const tenant = db.getTenant(tenantId)!;
  const agents = db.listAgents(tenantId).filter((a) => !a.isSupervisor);
  const weekDates = weekOf(dateStr);

  const intervals: ScheduledInterval[] = [];
  const alerts: AlertDraft[] = [];
  let absent = 0;

  for (const agent of agents) {
    const rules = rulesForState(agent.locationState);
    const planned = resolvePlanned(db, agent, dateStr);
    if (planned.startUtc && planned.endUtc && WORKING_KINDS.has(planned.kind)) {
      intervals.push({
        agentId: agent.id,
        displayName: agent.displayName,
        startUtc: planned.startUtc,
        endUtc: planned.endUtc,
        lunchUtc: planned.lunchUtc,
        lunchMinutes: planned.lunchMinutes,
      });
    } else if (!WORKING_KINDS.has(planned.kind) && planned.source !== 'UNSCHEDULED') {
      absent += 1;
    }

    // Meal-deadline forecast (state-aware; CA only among the seeded states).
    alerts.push(...forecastMealDeadline(agent.id, agent.displayName, dateStr, planned, rules));

    // Overtime across the workweek: worked-so-far + the schedule still ahead.
    const days: DayLoad[] = weekDates.map((dt) => {
      const p = resolvePlanned(db, agent, dt);
      const evs = db.eventsOnLocalDate(tenantId, dt, { agentId: agent.id });
      const proj = evs.length ? projectShift(evs, now) : null;
      return {
        workDate: dt,
        scheduled: WORKING_KINDS.has(p.kind),
        plannedStartUtc: p.startUtc,
        plannedEndUtc: p.endUtc,
        plannedLunchUtc: p.lunchUtc,
        plannedLunchMinutes: null, // paid-lunch model: do not subtract the meal
        plannedMinutes: p.scheduledMinutes,
        actualMs: proj?.workedMs ?? 0,
        complete: proj ? proj.status === 'CLOCKED_OUT' : false,
      };
    });
    alerts.push(...forecastOvertime(agent.id, agent.displayName, assessOvertime({ rules, days, now })));

    // Adherence for the date: planned beside actual, grace applied in core.
    const dayEvents = db.eventsOnLocalDate(tenantId, dateStr, { agentId: agent.id });
    const actual = buildActual(dayEvents, now);
    const adh = evaluateAdherence({
      planned,
      actual,
      graceMinutes: 5,
      mealRequired: rules.mealRequired,
      now,
    });
    alerts.push(...adherenceAlerts(agent.id, agent.displayName, dateStr, adh));
  }

  alerts.unshift(
    ...forecastCoverage(dateStr, intervals, { thresholdPct: tenant.coverageThresholdPct }),
  );

  const onDuty = agents.filter(
    (a) => projectShift(db.agentEvents(a.id), now).status === 'ACTIVE',
  ).length;
  const headcount = { scheduled: intervals.length, absent, onDuty };

  // Stable ordering (CRITICAL first) BEFORE narration, so "most pressing" is
  // deterministic and the provider sees the ranked list.
  const rank = { CRITICAL: 0, WARN: 1, INFO: 2 } as const;
  alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);

  const summary = await summaryProvider.summarize({ workDate: dateStr, alerts, coverage: [], headcount });
  // Reflect what actually wrote the text: a Claude provider that fell back to the
  // template reports 'template', not 'claude'.
  const summaryBy = (summaryProvider as { lastOutcome?: string }).lastOutcome ?? 'template';
  return { date: dateStr, summary, summaryBy, alerts, headcount };
}

function weekOf(dateStr: string): string[] {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const start = weekStart(new Date(Date.UTC(y, mo - 1, d)), 0);
  const base = start.toISOString().slice(0, 10);
  return Array.from({ length: 7 }, (_, i) => addDays(base, i));
}

/** Resolved schedule for a date range, for the supervisor/agent read views. */
export function scheduleRange(
  db: Store,
  agentIds: string[],
  from: string,
  to: string,
): { agentId: string; date: string; planned: PlannedShift }[] {
  const out: { agentId: string; date: string; planned: PlannedShift }[] = [];
  for (const agentId of agentIds) {
    const agent = db.getAgent(agentId);
    if (!agent) continue;
    for (let dt = from; dt <= to; dt = addDays(dt, 1)) {
      out.push({ agentId, date: dt, planned: resolvePlanned(db, agent, dt) });
    }
  }
  return out;
}
