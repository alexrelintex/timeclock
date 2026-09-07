/**
 * Compliance sweeper — the scheduled reconciler.
 *
 * Runs on an interval (and on demand). For every agent with an open shift it:
 *   1. evaluates the CA §512 meal deadline; a late/short/missed meal raises the
 *      matching ComplianceException and, once definitive, enqueues the §226.7(c)
 *      premium hour as a PAY_ITEM outbox row (delivered via the HRIS pay-item
 *      path — never as a punch).
 *   2. detects orphan IN/BREAK/LUNCH and raises exceptions. Break/lunch orphans
 *      are resolved entirely in-app; IN orphans are flagged for the missed-punch
 *      round trip (enqueued only after supervisor correction, elsewhere).
 *
 * Everything here is idempotent: upsertException keys on (agent, workDate, type),
 * and premiumDelivered gates the pay-item enqueue so re-runs never double-pay.
 */
import {
  detectOrphans,
  evaluateMealDeadline,
  projectShift,
  type MealDeadlineState,
  type PunchEventType,
} from '@timeclock/core';
import type { Store } from './store/contract.js';
import { rulesForState } from './stateRules.js';
import type { Agent, ExceptionType, PunchEvent } from './types.js';

export interface ShiftFacts {
  shiftStart: Date | null;
  lunchStart: Date | null;
  lunchEnd: Date | null;
  relatedIds: string[];
}

/** Extract meal-relevant landmarks from an agent's open stream. */
export function shiftFacts(events: PunchEvent[]): ShiftFacts {
  const find = (t: PunchEventType) => events.find((e) => e.eventType === t) ?? null;
  const shiftStart = find('IN');
  const lunchStart = find('LUNCH_START');
  const lunchEnd = find('LUNCH_END');
  return {
    shiftStart: shiftStart?.eventTime ?? null,
    lunchStart: lunchStart?.eventTime ?? null,
    lunchEnd: lunchEnd?.eventTime ?? null,
    relatedIds: [shiftStart, lunchStart, lunchEnd].filter(Boolean).map((e) => (e as PunchEvent).id),
  };
}

const MEAL_EXCEPTION: Record<'late' | 'short' | 'missed', ExceptionType> = {
  late: 'LATE_MEAL',
  short: 'SHORT_MEAL',
  missed: 'MISSED_MEAL',
};

export function evaluateAgentMeal(
  db: Store,
  agent: Agent,
  now: Date,
): MealDeadlineState | null {
  const tenant = db.getTenant(agent.tenantId);
  if (!tenant || !tenant.caMealRulesEnabled) return null; // tenant master kill switch
  const events = db.agentEvents(agent.id);
  const { status, shiftStart } = projectShift(events, now);
  if (status === 'CLOCKED_OUT' || !shiftStart) return null;

  // Rules follow where the employee WORKS, not the tenant.
  const rules = rulesForState(agent.locationState);
  const facts = shiftFacts(events);
  const hasDeadline = rules.mealRequired && rules.mealDeadlineHours !== null;

  const base = evaluateMealDeadline({
    shiftStart,
    lunchStart: facts.lunchStart,
    lunchEnd: facts.lunchEnd,
    now,
    waiverOnFile: agent.mealWaiverOnFile,
    alertTiersMinutes: tenant.mealAlertTiers,
    // No state deadline (e.g. TX): push it far out so no countdown/late/missed
    // fires, while the FEDERAL 30-min short-meal check below still stands.
    deadlineMs: hasDeadline ? rules.mealDeadlineHours! * 3_600_000 : 1000 * 3_600_000,
  });

  if (!hasDeadline) {
    // No meal-timing obligation in this state. The only thing that can still be
    // wrong is a short meal actually taken — federal (29 CFR 785.19), no premium.
    if (facts.lunchStart && base.shortMeal) {
      return { ...base, level: 'NONE', lateMeal: false, missedMeal: false, premiumHourPayable: false };
    }
    return null;
  }
  // State deadline applies: gate the premium on the state actually owing one.
  return { ...base, premiumHourPayable: base.premiumHourPayable && rules.mealPremiumRequired };
}

/** One sweep pass over every open shift in the system. */
export function sweep(db: Store, now: Date = new Date()): void {
  for (const tenant of db.listTenants()) {
    for (const agent of db.listAgents(tenant.id)) {
      const events = db.agentEvents(agent.id);
      if (events.length === 0) continue;
      const proj = projectShift(events, now);
      const facts = shiftFacts(events);

      // ---- meal compliance (state-aware: deadline + premium per work state)
      const meal = proj.shiftStart ? evaluateAgentMeal(db, agent, now) : null;
      if (meal && proj.shiftStart) {
        const violation = meal.lateMeal
          ? 'late'
          : meal.shortMeal
            ? 'short'
            : meal.missedMeal
              ? 'missed'
              : null;

        if (violation) {
          const rules = rulesForState(agent.locationState);
          const ex = db.upsertException({
            tenantId: tenant.id,
            agentId: agent.id,
            workDate: proj.shiftStart,
            type: MEAL_EXCEPTION[violation],
            relatedEventIds: facts.relatedIds,
            premiumHourPayable: meal.premiumHourPayable,
            premiumDelivered: false,
          });
          // §226.7(c): one premium hour, once, via pay-item — only where owed.
          if (meal.premiumHourPayable && !ex.premiumDelivered && agent.hrisEmployeeId) {
            db.enqueueOutbox({
              tenantId: tenant.id,
              kind: 'PAY_ITEM',
              payload: {
                exceptionId: ex.id,
                hrisEmployeeId: agent.hrisEmployeeId,
                earningCodeRef: '',
                hours: 1,
                workDate: proj.shiftStart,
                note: `${rules.state} meal premium (${MEAL_EXCEPTION[violation]})`,
              },
            });
            db.markPremiumDelivered(ex.id);
          }
        }
      }

      // ---- orphan detection
      for (const orphan of detectOrphans(events, now)) {
        db.upsertException({
          tenantId: tenant.id,
          agentId: agent.id,
          workDate: orphan.openedAt,
          type: orphan.kind,
          relatedEventIds: facts.relatedIds,
          premiumHourPayable: false,
          premiumDelivered: false,
        });
      }
    }
  }
}
