/**
 * Read-model builders for the widget and supervisor UIs. Pure projections over
 * the event stream + live compliance evaluation — no stored status anywhere.
 * Coverage is computed PER DEPARTMENT: an agent's break only affects the
 * coverage of their own department.
 */
import {
  canTransition,
  projectShift,
  recommendSlots,
  SLOT_MS,
  type AgentStatus,
  type PunchEventType,
  type Recommendation,
} from '@timeclock/core';
import { evaluateAgentMeal } from './compliance.js';
import { pendingClockoutCorrection } from './orphanCorrection.js';
import { rulesForState } from './stateRules.js';
import type { MemoryDb } from './db.js';
import type { Agent, ComplianceException } from './types.js';

const ACTIONS: PunchEventType[] = ['IN', 'OUT', 'BREAK_START', 'BREAK_END', 'LUNCH_START', 'LUNCH_END'];

export interface AgentView {
  agentId: string;
  displayName: string;
  department: string;
  locationState: string;
  timezone: string; // IANA — the employee's own local time
  jurisdiction: string;
  mealPremiumState: boolean; // does this work-state owe a §226.7-style premium?
  status: AgentStatus;
  shiftStart: string | null;
  workedMs: number;
  breakMs: number;
  lunchMs: number;
  currentIntervalStart: string | null;
  allowed: PunchEventType[];
  /** Present when the agent must file a missing clock-out before a new shift. */
  clockoutCorrection: { shiftStart: string; ageMs: number; suggestedClockout: string } | null;
  meal: {
    deadline: string;
    msRemaining: number;
    level: string;
    satisfied: boolean;
    lateMeal: boolean;
    shortMeal: boolean;
    missedMeal: boolean;
    premiumHourPayable: boolean;
  } | null;
}

export function buildAgentView(db: MemoryDb, agent: Agent, now: Date): AgentView {
  const events = db.agentEvents(agent.id);
  const proj = projectShift(events, now);
  const meal = evaluateAgentMeal(db, agent, now);
  const orphan = pendingClockoutCorrection(db, agent, now);
  const rules = rulesForState(agent.locationState);
  return {
    agentId: agent.id,
    displayName: agent.displayName,
    department: agent.department,
    locationState: agent.locationState,
    timezone: agent.timezone,
    jurisdiction: rules.jurisdiction,
    mealPremiumState: rules.mealPremiumRequired,
    status: proj.status,
    shiftStart: proj.shiftStart?.toISOString() ?? null,
    workedMs: proj.workedMs,
    breakMs: proj.breakMs,
    lunchMs: proj.lunchMs,
    currentIntervalStart: proj.currentIntervalStart?.toISOString() ?? null,
    allowed: ACTIONS.filter((a) => canTransition(proj.status, a)),
    clockoutCorrection: orphan
      ? {
          shiftStart: orphan.shiftStart.toISOString(),
          ageMs: orphan.ageMs,
          suggestedClockout: orphan.suggestedClockout.toISOString(),
        }
      : null,
    meal: meal
      ? {
          deadline: meal.deadline.toISOString(),
          msRemaining: meal.msRemaining,
          level: meal.level,
          satisfied: meal.satisfied,
          lateMeal: meal.lateMeal,
          shortMeal: meal.shortMeal,
          missedMeal: meal.missedMeal,
          premiumHourPayable: meal.premiumHourPayable,
        }
      : null,
  };
}

export interface DepartmentCoverage {
  department: string;
  activePct: number;
  active: number;
  scheduled: number;
  belowThreshold: boolean;
}

export interface SupervisorSnapshot {
  tenantId: string;
  now: string;
  serverTimezone: string; // the supervisor sees all times in this (server/HQ) zone
  visibleDepartments: string[]; // departments this supervisor may see (for the filter)
  thresholdPct: number;
  coverage: DepartmentCoverage[];
  overall: { activePct: number; active: number; scheduled: number };
  roster: AgentView[];
  exceptions: (ComplianceException & { agentName: string; department: string })[];
  recommendations: (Recommendation & { agentName: string; department: string })[];
  outbox: Record<string, number>;
}

export function buildSupervisorSnapshot(
  db: MemoryDb,
  tenantId: string,
  now: Date,
  allowedDepartments?: string[] | null,
): SupervisorSnapshot {
  const tenant = db.getTenant(tenantId)!;
  const threshold = tenant.coverageThresholdPct;
  const allowed = allowedDepartments && allowedDepartments.length ? new Set(allowedDepartments) : null;
  const agents = db
    .listAgents(tenantId)
    .filter((a) => !a.isSupervisor && (!allowed || allowed.has(a.department)));
  const roster = agents.map((a) => buildAgentView(db, a, now));
  const nameOf = (id: string) => db.getAgent(id)?.displayName ?? id;
  const deptOf = (id: string) => db.getAgent(id)?.department ?? '—';

  // Coverage + recommendations, computed independently per department.
  const coverage: DepartmentCoverage[] = [];
  const recommendations: (Recommendation & { agentName: string; department: string })[] = [];

  const scopedDepts = db.departments(tenantId).filter((d) => !allowed || allowed.has(d));
  for (const department of scopedDepts) {
    const deptAgents = agents.filter((a) => a.department === department);
    const active = deptAgents.filter(
      (a) => projectShift(db.agentEvents(a.id), now).status === 'ACTIVE',
    ).length;
    const scheduled = deptAgents.length;
    const activePct = scheduled ? Math.round((active / scheduled) * 100) : 100;
    coverage.push({
      department,
      active,
      scheduled,
      activePct,
      belowThreshold: activePct < threshold,
    });

    // 16 x 15-min slots from now, scoped to this department's schedule.
    const slots = Array.from({ length: 16 }, (_, i) => {
      const slotStart = new Date(now.getTime() + i * SLOT_MS);
      const sched = deptAgents.filter(
        (a) =>
          a.scheduledStart &&
          a.scheduledEnd &&
          a.scheduledStart.getTime() <= slotStart.getTime() &&
          a.scheduledEnd.getTime() > slotStart.getTime(),
      ).length;
      return { slotStart, scheduled: sched, projectedAway: 0 };
    });
    const covInput = deptAgents
      .map((a) => {
        const proj = projectShift(db.agentEvents(a.id), now);
        if (proj.status === 'CLOCKED_OUT' || !proj.shiftStart) return null;
        const evs = db.agentEvents(a.id);
        return {
          agentId: a.id,
          shiftStart: proj.shiftStart,
          shiftEnd: a.scheduledEnd ?? new Date(now.getTime() + 3 * 3600_000),
          lunchTaken: evs.some((e) => e.eventType === 'LUNCH_START'),
          breaksTaken: evs.filter((e) => e.eventType === 'BREAK_START').length,
          breaksEntitled: 1,
          waived: a.mealWaiverOnFile,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    for (const r of recommendSlots(covInput, slots, { thresholdPct: threshold, lunchSlots: 2 })) {
      recommendations.push({ ...r, agentName: nameOf(r.agentId), department });
    }
  }

  const overallScheduled = agents.length;
  const overallActive = roster.filter((r) => r.status === 'ACTIVE').length;
  const overall = {
    scheduled: overallScheduled,
    active: overallActive,
    activePct: overallScheduled ? Math.round((overallActive / overallScheduled) * 100) : 100,
  };

  const exceptions = db
    .listOpenExceptions(tenantId)
    .map((e) => ({ ...e, agentName: nameOf(e.agentId), department: deptOf(e.agentId) }));

  const outbox: Record<string, number> = {};
  for (const row of db.outboxSnapshot(tenantId)) {
    outbox[row.status] = (outbox[row.status] ?? 0) + 1;
  }

  return {
    tenantId,
    now: now.toISOString(),
    serverTimezone: tenant.timezone,
    visibleDepartments: scopedDepts,
    thresholdPct: threshold,
    coverage,
    overall,
    roster,
    exceptions,
    recommendations,
    outbox,
  };
}
