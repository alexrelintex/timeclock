/**
 * Postgres store-driver durability test — runs only when DATABASE_URL is set
 * (CI provides a throwaway Postgres; a plain `npm run test:postgres` with no DB
 * skips cleanly so it never breaks a DB-less checkout).
 *
 * It exercises the real round trip: write through the driver, then hydrate a FRESH
 * store instance (a simulated restart) and assert everything came back — tenant,
 * agent (with role/email), punch event, outbox row, weekly pattern, and a per-date
 * schedule exception. Assumes the schema is already applied (CI runs
 * `prisma migrate deploy` first).
 */
import assert from 'node:assert';
import { createStore } from '../apps/api/src/store/index.js';
import type { Tenant, Agent, SchedulePatternRow, ScheduleExceptionRow } from '../apps/api/src/types.js';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log('SKIP postgres driver tests (no DATABASE_URL set)');
    return;
  }
  process.env.STORE_DRIVER = 'postgres';

  // Unique tenant id per run so repeated CI runs against the same DB don't collide.
  const tid = `ci-${Date.now()}`;
  const tenant: Tenant = {
    id: tid, name: 'CI', timezone: 'America/Los_Angeles', breakMinutes: 10,
    lunchMinMinutes: 30, lunchMaxMinutes: 60, coverageThresholdPct: 70,
    mealAlertTiers: [60, 30, 15], caMealRulesEnabled: true, hrisProvider: null, hrisConfig: null,
  };
  const agent: Agent = {
    id: `${tid}-a1`, tenantId: tid, displayName: 'CI Bot', department: 'Support',
    locationState: 'CA', timezone: 'America/Los_Angeles', role: 'manager', isSupervisor: true,
    managedDepartments: ['Support'], hostUserId: `${tid}-u1`, email: `ci-${tid}@x.co`,
    hrisEmployeeId: null, hrisDepartmentId: null, hrisActivityTypeId: null,
    mealWaiverOnFile: false, active: true,
  };
  const pattern: SchedulePatternRow[] = [1, 2, 3, 4, 5].map((weekday) => ({
    agentId: agent.id, weekday, kind: 'WORK', startTime: '08:00', endTime: '17:00',
    lunchTime: '12:30', lunchMinutes: 30,
  }));
  const exception: ScheduleExceptionRow = {
    agentId: agent.id, date: '2026-09-10', kind: 'PTO',
    startTime: null, endTime: null, lunchTime: null, lunchMinutes: null, note: 'ci day off',
  };

  // --- write through the driver ---
  const w = createStore('postgres');
  await w.init!();
  w.upsertTenant(tenant);
  w.upsertAgent(agent);
  const evId = await w.appendWithOutbox({
    tenantId: tid, agentId: agent.id, eventType: 'IN', eventTime: new Date(),
    source: 'WIDGET', createdById: agent.hostUserId, outbox: { kind: 'PUNCH', payload: { punchEventId: 'SELF' } },
  });
  w.setPattern(agent.id, pattern);
  w.setScheduleException(exception);
  await new Promise((r) => setTimeout(r, 1000)); // let fire-and-forget writes flush

  // --- hydrate a fresh instance (simulated restart) and assert ---
  const r = createStore('postgres');
  await r.init!();

  assert.ok(r.getTenant(tid), 'tenant hydrated');
  const ga = r.getAgent(agent.id);
  assert.ok(ga, 'agent hydrated');
  assert.equal(ga!.role, 'manager', 'agent role persisted');
  assert.equal(ga!.email, `ci-${tid}@x.co`, 'agent email persisted');
  assert.ok(r.agentByEmail(tid, `CI-${tid}@X.CO`), 'agent resolvable by email (case-insensitive)');
  assert.equal(r.tenantEvents(tid).length, 1, 'punch event hydrated');
  const pending = await r.claimPending(tid, 'PUNCH', 10);
  assert.equal(pending.length, 1, 'outbox row hydrated');
  assert.equal(pending[0].id ? true : false, true, `outbox row has id (event ${evId})`);
  assert.equal(r.getPattern(agent.id).length, 5, 'weekly pattern hydrated (5 rows)');
  assert.equal(r.patternForWeekday(agent.id, 3)?.startTime, '08:00', 'Wed pattern start persisted');
  assert.equal(r.getScheduleException(agent.id, '2026-09-10')?.kind, 'PTO', 'schedule exception hydrated');

  console.log('ALL POSTGRES DRIVER TESTS PASSED');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
