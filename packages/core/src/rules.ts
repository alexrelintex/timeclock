/**
 * Wage-and-hour parameters by work location.
 *
 * Mirrors timeclock.state_rule (migration 110) and is produced by
 * timeclock.rules_json(agent). Which rules apply is a function of where the
 * EMPLOYEE WORKS, not of the tenant: a Texas agent and a California agent on the
 * same team owe different things.
 *
 * The distinction that is easy to get wrong, restated here because this is the
 * type everything else reads:
 *
 *   mealMinMinutes is FEDERAL and applies everywhere. A meal period under ~30
 *   minutes with the employee relieved of duty is not a bona fide meal period, so
 *   the time is compensable (FLSA 29 CFR 785.19). That is why the punch guard runs
 *   in every state — it is what makes an unpaid meal lawful at all.
 *
 *   mealDeadlineHours and mealPremiumRequired are STATE law. California requires
 *   the meal to start before the end of the 5th hour (Lab. Code 512(a)) and owes
 *   one premium hour when it does not (226.7(c)). Outside CA neither exists, so a
 *   late meal is a scheduling problem, not a payroll liability.
 *
 *   Overtime splits the same way: FLSA is weekly only; CA adds daily and double time.
 */

export interface StateRules {
  state: string;
  jurisdiction: string;
  mealRequired: boolean;
  /** Federal bona-fide-meal floor. Applies in every state. */
  mealMinMinutes: number;
  /** Hours worked by which the meal must START. Null = no state deadline. */
  mealDeadlineHours: number | null;
  /** Does a failure owe a premium hour? CA only, among the seeded rows. */
  mealPremiumRequired: boolean;
  secondMealHours: number | null;
  mealWaiverMaxHours: number | null;
  paidRestRequired: boolean;
  restMinutes: number;
  restPerHours: number | null;
  /** Null = no daily overtime (the federal position). */
  dailyOtHours: number | null;
  doubleTimeHours: number | null;
  weeklyOtHours: number;
  seventhDayRule: boolean;
  citation: string | null;
}

/** Used when an agent has no location on file: federal floor, nothing more. */
export const FEDERAL_DEFAULT: StateRules = {
  state: 'DEFAULT',
  jurisdiction: 'Federal (FLSA) only',
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
  citation: 'FLSA 29 U.S.C. 207(a); meal exclusion per 29 CFR 785.19',
};

/** Does this location carry a meal-period obligation with a pay remedy? */
export function hasMealPenalty(rules: StateRules): boolean {
  return rules.mealPremiumRequired && rules.mealDeadlineHours !== null;
}

/** Milliseconds of work by which the first meal must start, or null. */
export function mealDeadlineMs(rules: StateRules): number | null {
  return rules.mealDeadlineHours === null ? null : rules.mealDeadlineHours * 3_600_000;
}
