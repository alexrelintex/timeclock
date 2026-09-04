/**
 * In-memory mirror of timeclock.state_rule (bs5_1 migration 110).
 *
 * Meal/overtime obligations follow where the EMPLOYEE WORKS, not the tenant:
 * agent.locationState (USPS code) resolves against this table. A table rather
 * than a CASE statement, because these are the numbers most likely to change
 * with no code change — a new state is a row, not a deploy.
 *
 * The 30-minute meal minimum is FEDERAL and present in every row: a meal under
 * 30 min is not a bona-fide meal period (29 CFR 785.19), which is what makes an
 * unpaid meal lawful anywhere. The 5th-hour deadline and the §226.7(c) premium
 * are STATE law (CA), so a late meal in TX is a scheduling annoyance, not pay.
 */
import { FEDERAL_DEFAULT, type StateRules } from '@timeclock/core';

export const STATE_RULES: Record<string, StateRules> = {
  DEFAULT: FEDERAL_DEFAULT,
  CA: {
    state: 'CA',
    jurisdiction: 'California',
    mealRequired: true,
    mealMinMinutes: 30,
    mealDeadlineHours: 5,
    mealPremiumRequired: true,
    secondMealHours: 10,
    mealWaiverMaxHours: 6,
    paidRestRequired: true,
    restMinutes: 10,
    restPerHours: 4,
    dailyOtHours: 8,
    doubleTimeHours: 12,
    weeklyOtHours: 40,
    seventhDayRule: true,
    citation: 'Cal. Lab. Code 512(a), 226.7(c), 510(a); IWC Wage Orders',
  },
  TX: {
    state: 'TX',
    jurisdiction: 'Texas',
    mealRequired: false,
    mealMinMinutes: 30,
    mealDeadlineHours: null,
    mealPremiumRequired: false,
    secondMealHours: null,
    mealWaiverMaxHours: null,
    paidRestRequired: false,
    restMinutes: 10,
    restPerHours: null,
    dailyOtHours: null,
    doubleTimeHours: null,
    weeklyOtHours: 40,
    seventhDayRule: false,
    citation: 'FLSA only',
  },
};

/** Resolve rules for a work state; unknown/empty falls back to the federal floor. */
export function rulesForState(state?: string | null): StateRules {
  if (!state) return STATE_RULES.DEFAULT;
  return STATE_RULES[state.toUpperCase()] ?? STATE_RULES.DEFAULT;
}
