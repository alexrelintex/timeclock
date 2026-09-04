/**
 * Coverage monitoring + greedy break/lunch slot recommendation (MVP).
 *
 * active_pct = ACTIVE / scheduled headcount, per 15-min slot, PER DEPARTMENT.
 * Advisory only — there are NO hard constraints. The engine always proposes a
 * best-effort slot and surfaces trade-offs via flags (mealAtRisk / coverageAtRisk)
 * for a human to decide; it never forces a placement or refuses to schedule.
 * (Graduate to OR-Tools CP-SAT if constraints outgrow the greedy heuristic.)
 */

import { latestCompliantLunchStart } from './mealDeadline';

export const SLOT_MS = 15 * 60 * 1000;

export interface AgentCoverageInput {
  agentId: string;
  shiftStart: Date;
  shiftEnd: Date; // scheduled
  lunchTaken: boolean;
  breaksTaken: number;
  breaksEntitled: number; // e.g. 1 per 4h worked or major fraction
  waived: boolean;
}

export interface SlotLoad {
  slotStart: Date;
  scheduled: number;
  projectedAway: number; // already-assigned breaks/lunches in this slot
}

export interface Recommendation {
  agentId: string;
  kind: 'LUNCH' | 'BREAK';
  slotStart: Date;
  mealWindowEnd: Date | null; // lunch only: latest compliant start (advisory, not enforced)
  coverageAfterPct: number;
  // Advisory flags only — NOTHING is forced. The engine always proposes a
  // best-effort slot and surfaces the trade-off for a human to decide.
  mealAtRisk: boolean; // proposed start is at/after the meal window end
  coverageAtRisk: boolean; // proposed slot dips below the coverage threshold
}

function slotIndex(t: Date, gridStart: Date): number {
  return Math.floor((t.getTime() - gridStart.getTime()) / SLOT_MS);
}

/**
 * Greedy assignment: lunches first (hard deadlines, longest holes), earliest-
 * deadline-first; then breaks into remaining headroom. One pass, explainable.
 */
export function recommendSlots(
  agents: AgentCoverageInput[],
  slots: SlotLoad[],
  opts: { thresholdPct: number; lunchSlots: number; breakSlots?: number },
): Recommendation[] {
  const breakSlots = opts.breakSlots ?? 1; // 10-min break fits within one 15-min slot
  if (slots.length === 0) return [];
  const gridStart = slots[0].slotStart;
  const away = slots.map((s) => s.projectedAway);
  const recs: Recommendation[] = [];

  const activePctAfter = (i: number, extra: number) => {
    const s = slots[i];
    if (!s || s.scheduled === 0) return 100;
    return ((s.scheduled - (away[i] + extra)) / s.scheduled) * 100;
  };

  // Fits check across a window of consecutive slots.
  const windowOk = (start: number, len: number) => {
    for (let i = start; i < start + len; i++) {
      if (i < 0 || i >= slots.length) return false;
      if (activePctAfter(i, 1) < opts.thresholdPct) return false;
    }
    return true;
  };
  const commit = (start: number, len: number) => {
    for (let i = start; i < start + len; i++) away[i] += 1;
  };

  // --- Lunches: earliest meal-window first (priority heuristic, not a wall).
  const needLunch = agents
    .filter((a) => !a.lunchTaken && !a.waived)
    .sort(
      (a, b) =>
        latestCompliantLunchStart(a.shiftStart).getTime() -
        latestCompliantLunchStart(b.shiftStart).getTime(),
    );

  const windowHeadroom = (i: number) =>
    Math.min(...Array.from({ length: opts.lunchSlots }, (_, k) => activePctAfter(i + k, 1)));

  for (const a of needLunch) {
    const windowEnd = latestCompliantLunchStart(a.shiftStart);
    const windowEndIdx = slotIndex(windowEnd, gridStart);
    const firstIdx = Math.max(0, slotIndex(new Date(), gridStart));
    const lastIdx = slots.length - opts.lunchSlots; // whole grid — deadline no longer clamps

    // No hard constraint: score every feasible slot and pick the best trade-off.
    // Preference tiers: (0) in-window & covered, (1) in-window, (2) covered, (3) neither.
    let best: { i: number; headroom: number; inWindow: boolean; covered: boolean; tier: number } | null =
      null;
    for (let i = firstIdx; i <= lastIdx; i++) {
      if (i < 0) continue;
      const headroom = windowHeadroom(i);
      const inWindow = i <= windowEndIdx;
      const covered = headroom >= opts.thresholdPct;
      const tier = inWindow && covered ? 0 : inWindow ? 1 : covered ? 2 : 3;
      if (!best || tier < best.tier || (tier === best.tier && headroom > best.headroom)) {
        best = { i, headroom, inWindow, covered, tier };
      }
    }
    if (!best) continue; // grid smaller than a lunch — nothing to place

    commit(best.i, opts.lunchSlots);
    recs.push({
      agentId: a.agentId,
      kind: 'LUNCH',
      slotStart: new Date(gridStart.getTime() + best.i * SLOT_MS),
      mealWindowEnd: windowEnd,
      coverageAfterPct: Math.min(
        ...Array.from({ length: opts.lunchSlots }, (_, k) => activePctAfter(best!.i + k, 0)),
      ),
      mealAtRisk: !best.inWindow,
      coverageAtRisk: !best.covered,
    });
  }

  // --- Breaks: fill remaining headroom, soft placement (mid-4h "insofar as practicable").
  for (const a of agents) {
    for (let b = a.breaksTaken; b < a.breaksEntitled; b++) {
      const firstIdx = Math.max(0, slotIndex(new Date(), gridStart));
      const lastIdx = Math.min(slots.length - breakSlots, slotIndex(a.shiftEnd, gridStart));
      let chosen = -1;
      let bestHeadroom = -Infinity;
      for (let i = firstIdx; i <= lastIdx; i++) {
        if (!windowOk(i, breakSlots)) continue;
        const headroom = activePctAfter(i, 1);
        if (headroom > bestHeadroom) {
          bestHeadroom = headroom;
          chosen = i;
        }
      }
      if (chosen === -1) continue; // breaks are soft: skip rather than breach
      commit(chosen, breakSlots);
      recs.push({
        agentId: a.agentId,
        kind: 'BREAK',
        slotStart: new Date(gridStart.getTime() + chosen * SLOT_MS),
        mealWindowEnd: null,
        coverageAfterPct: activePctAfter(chosen, 0),
        mealAtRisk: false,
        coverageAtRisk: false,
      });
    }
  }

  return recs;
}
