/**
 * California meal-period countdown (Cal. Labor Code §512(a), §226.7(c)).
 *
 * Rule encoded: a >=30-minute duty-free meal must START strictly before the
 * end of the 5th hour of work. Because breaks/lunch are paid in this system,
 * elapsed worked time == wall-clock time since first IN (no subtraction).
 * A late, short (<30 min), or missed meal => one premium hour payable per
 * workday (premium is an EARNING, delivered via the HRIS pay-item path).
 *
 * The 5th-hour deadline is a HARD constraint: it outranks the coverage
 * threshold in the break-recommendation engine.
 */

export const FIFTH_HOUR_MS = 5 * 60 * 60 * 1000;
export const MIN_MEAL_MS = 30 * 60 * 1000;
export const SECOND_MEAL_DEADLINE_MS = 10 * 60 * 60 * 1000; // shifts > 10h
export const WAIVER_MAX_SHIFT_MS = 6 * 60 * 60 * 1000; // <=6h mutual-consent waiver

export type MealAlertLevel = 'NONE' | 'ADVISORY' | 'STRONG' | 'CRITICAL' | 'BREACH';

export interface MealDeadlineInput {
  shiftStart: Date; // first IN (UTC)
  lunchStart: Date | null; // first LUNCH_START of the shift, if any
  lunchEnd: Date | null;
  now: Date;
  waiverOnFile: boolean; // agent/day waiver
  scheduledShiftMs?: number; // if known; used with waiver
  /** Alert tier thresholds in minutes before deadline, descending. Default [60,30,15]. */
  alertTiersMinutes?: number[];
  /** Work by which the meal must START (ms). Default = 5th hour. State-rule driven. */
  deadlineMs?: number;
}

export interface MealDeadlineState {
  deadline: Date; // shiftStart + 5h; lunch must START before this instant
  msRemaining: number; // negative once breached (and no timely lunch)
  level: MealAlertLevel;
  satisfied: boolean; // a timely lunch has started
  waived: boolean;
  shortMeal: boolean; // lunch ended before 30 min elapsed
  lateMeal: boolean; // lunch started at/after deadline
  missedMeal: boolean; // deadline passed, no lunch started, not waived
  premiumHourPayable: boolean;
}

export function evaluateMealDeadline(input: MealDeadlineInput): MealDeadlineState {
  const {
    shiftStart,
    lunchStart,
    lunchEnd,
    now,
    waiverOnFile,
    scheduledShiftMs,
    alertTiersMinutes = [60, 30, 15],
    deadlineMs = FIFTH_HOUR_MS,
  } = input;

  const deadline = new Date(shiftStart.getTime() + deadlineMs);
  const waived =
    waiverOnFile && (scheduledShiftMs === undefined || scheduledShiftMs <= WAIVER_MAX_SHIFT_MS);

  const startedTimely = lunchStart !== null && lunchStart.getTime() < deadline.getTime();
  const lateMeal = lunchStart !== null && lunchStart.getTime() >= deadline.getTime();
  const shortMeal =
    lunchStart !== null &&
    lunchEnd !== null &&
    lunchEnd.getTime() - lunchStart.getTime() < MIN_MEAL_MS;
  const missedMeal = !waived && lunchStart === null && now.getTime() >= deadline.getTime();

  const msRemaining = deadline.getTime() - now.getTime();

  let level: MealAlertLevel = 'NONE';
  if (!waived && !startedTimely) {
    if (msRemaining <= 0) level = 'BREACH';
    else {
      const [advisory = 60, strong = 30, critical = 15] = alertTiersMinutes;
      const minRemaining = msRemaining / 60000;
      if (minRemaining <= critical) level = 'CRITICAL';
      else if (minRemaining <= strong) level = 'STRONG';
      else if (minRemaining <= advisory) level = 'ADVISORY';
    }
  }

  // §226.7(c): one premium hour per workday for a non-provided meal period.
  // Late, short, or missed each independently triggers it (subject to the
  // voluntary-return attestation captured for short meals — Brinker).
  const premiumHourPayable = !waived && (lateMeal || shortMeal || missedMeal);

  return {
    deadline,
    msRemaining,
    level,
    satisfied: startedTimely && !shortMeal,
    waived,
    shortMeal,
    lateMeal,
    missedMeal,
    premiumHourPayable,
  };
}

/**
 * Latest instant a lunch may START and still be compliant, given a required
 * minimum duration. Used by the recommendation engine as a hard upper bound.
 */
export function latestCompliantLunchStart(shiftStart: Date): Date {
  // "Before the end of the 5th hour" — strictly before; subtract 1 minute of
  // scheduling slack so recommendations never land exactly on the boundary.
  return new Date(shiftStart.getTime() + FIFTH_HOUR_MS - 60_000);
}
