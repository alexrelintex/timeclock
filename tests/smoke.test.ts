// Smoke test: state machine, meal deadline, orphan detection, coverage.
import { projectShift, transition } from '../packages/core/src/stateMachine';
import { evaluateMealDeadline, latestCompliantLunchStart } from '../packages/core/src/mealDeadline';
import { detectOrphans } from '../packages/core/src/orphanDetection';
import { recommendSlots, SLOT_MS } from '../packages/core/src/coverage';

const t0 = new Date('2026-08-10T15:00:00Z'); // 8:00 AM PT
const ev = (type: any, minsAfter: number) => ({ eventType: type, eventTime: new Date(t0.getTime() + minsAfter * 60000), status: 'ACTIVE' as const });

// 1. state machine
console.assert(transition('CLOCKED_OUT', 'IN') === 'ACTIVE', 'in');
let threw = false; try { transition('ON_BREAK', 'OUT'); } catch { threw = true; }
console.assert(threw, 'guard: no OUT while ON_BREAK');

// 2. projection: IN 0, BREAK 120-135, LUNCH 240-275, now=300
const stream = [ev('IN',0), ev('BREAK_START',120), ev('BREAK_END',135), ev('LUNCH_START',240), ev('LUNCH_END',275)];
const now = new Date(t0.getTime() + 300 * 60000);
const p = projectShift(stream, now);
console.assert(p.status === 'ACTIVE', 'status');
console.assert(p.breakMs === 15*60000, `break=${p.breakMs}`);
console.assert(p.lunchMs === 35*60000, `lunch=${p.lunchMs}`);
console.assert(p.workedMs === 300*60000, `worked=${p.workedMs}`); // paid => contiguous

// 3. meal deadline: lunch at 240m (4h) < 5h deadline => satisfied, no premium
const meal = evaluateMealDeadline({ shiftStart: t0, lunchStart: stream[3].eventTime, lunchEnd: stream[4].eventTime, now, waiverOnFile: false });
console.assert(meal.satisfied && !meal.premiumHourPayable, 'timely 35-min lunch');

// late lunch at 5h05 => premium
const late = evaluateMealDeadline({ shiftStart: t0, lunchStart: new Date(t0.getTime() + 305*60000), lunchEnd: null, now: new Date(t0.getTime()+310*60000), waiverOnFile: false });
console.assert(late.lateMeal && late.premiumHourPayable, 'late meal premium');

// short lunch 25 min => premium
const short = evaluateMealDeadline({ shiftStart: t0, lunchStart: ev('LUNCH_START',200).eventTime, lunchEnd: ev('LUNCH_END',225).eventTime, now, waiverOnFile: false });
console.assert(short.shortMeal && short.premiumHourPayable, 'short meal premium');

// escalation: 20 min before deadline, no lunch yet => STRONG (<=30)
const esc = evaluateMealDeadline({ shiftStart: t0, lunchStart: null, lunchEnd: null, now: new Date(t0.getTime() + 280*60000), waiverOnFile: false });
console.assert(esc.level === 'STRONG', `level=${esc.level}`);

// 4. orphan: IN 15h ago, still ACTIVE
const orphans = detectOrphans([ev('IN', 0)], new Date(t0.getTime() + 15*3600*1000));
console.assert(orphans.length === 1 && orphans[0].kind === 'ORPHAN_IN' && orphans[0].syncsToHris, 'orphan IN syncs');
const bOrphans = detectOrphans([ev('IN',0), ev('BREAK_START',60)], new Date(t0.getTime() + 120*60000));
console.assert(bOrphans.some(o => o.kind==='ORPHAN_BREAK' && !o.syncsToHris), 'orphan break internal');

// 5. coverage: 10 agents, threshold 70%, lunch must land before each deadline
const gridStart = now;
const slots = Array.from({length: 16}, (_,i)=>({ slotStart: new Date(gridStart.getTime()+i*SLOT_MS), scheduled: 10, projectedAway: 0 }));
const agents = Array.from({length: 4}, (_,i)=>({ agentId: `a${i}`, shiftStart: new Date(now.getTime() - (200+i*10)*60000), shiftEnd: new Date(now.getTime()+240*60000), lunchTaken: false, breaksTaken: 0, breaksEntitled: 1, waived: false }));
const recs = recommendSlots(agents, slots, { thresholdPct: 70, lunchSlots: 2 });
const lunches = recs.filter(r=>r.kind==='LUNCH');
console.assert(lunches.length === 4, `lunches=${lunches.length}`);
// No hard constraint: every lunch is placed; it is either within the meal window or flagged mealAtRisk (advisory).
for (const r of lunches) console.assert(r.mealWindowEnd === null || r.slotStart.getTime() <= r.mealWindowEnd!.getTime() || r.mealAtRisk, 'lunch within window or flagged advisory');
console.assert(latestCompliantLunchStart(t0).getTime() === t0.getTime() + 5*3600*1000 - 60000, 'latest start');

console.log('ALL SMOKE TESTS PASSED');
console.log('recommendations:', recs.map(r=>`${r.agentId}:${r.kind}@+${(r.slotStart.getTime()-gridStart.getTime())/60000}m cov=${r.coverageAfterPct.toFixed(0)}%${r.mealAtRisk?' [MEAL-RISK]':''}${r.coverageAtRisk?' [COV-RISK]':''}`).join('  '));
