/**
 * Demo seed — one tenant, no HRIS configured (so everything runs credential-free
 * and events stay internal), with agents deliberately arranged to exercise every
 * compliance path: a healthy shift, an approaching 5th-hour deadline, a breached
 * meal, an on-break agent, and a fresh clock-in.
 */
import { randomUUID } from 'node:crypto';
import type { Store } from './store/contract.js';
import type { Agent, PunchEventType, Tenant } from './types.js';

export const DEMO_TENANT_ID = 'demo';

const MIN = 60_000;

export interface SeededAgent {
  id: string;
  displayName: string;
  hostUserId: string;
  isSupervisor: boolean;
}

export function seedDemo(db: Store, now: Date = new Date()): { tenant: Tenant; agents: SeededAgent[] } {
  const tenant: Tenant = {
    id: DEMO_TENANT_ID,
    name: process.env.INSTANCE_NAME || 'Acme Support (demo)',
    timezone: 'America/Los_Angeles',
    breakMinutes: 10,
    lunchMinMinutes: 30,
    lunchMaxMinutes: 60,
    coverageThresholdPct: 70,
    mealAlertTiers: [60, 30, 15],
    caMealRulesEnabled: true,
    hrisProvider: 'mock', // demo HRIS: enables "pull from HRIS" + real sync path
    hrisConfig: {},
  };
  db.upsertTenant(tenant);

  const scheduledStart = new Date(now.getTime() - 5 * 60 * MIN);
  const mkAgent = (
    a: Partial<Agent> & Pick<Agent, 'displayName' | 'hostUserId' | 'department'>,
  ): Agent => ({
    id: a.id ?? randomUUID(),
    tenantId: tenant.id,
    displayName: a.displayName,
    department: a.department,
    locationState: a.locationState ?? 'CA',
    timezone: a.timezone ?? tenant.timezone,
    role: a.role ?? 'user',
    isSupervisor: (a.role ?? 'user') !== 'user',
    managedDepartments: a.managedDepartments,
    hostUserId: a.hostUserId,
    hrisEmployeeId: a.hrisEmployeeId ?? null,
    hrisDepartmentId: null,
    hrisActivityTypeId: null,
    mealWaiverOnFile: a.mealWaiverOnFile ?? false,
    active: true,
    scheduledStart: a.scheduledStart ?? scheduledStart,
    scheduledEnd: a.scheduledEnd ?? new Date(scheduledStart.getTime() + 8 * 60 * MIN),
  });

  const event = (agentId: string, type: PunchEventType, minsAgo: number) =>
    db.appendWithOutbox({
      tenantId: tenant.id,
      agentId,
      eventType: type,
      eventTime: new Date(now.getTime() - minsAgo * MIN),
      source: 'WIDGET',
      createdById: agentId,
      outbox: null, // seeded history: don't re-enqueue to HRIS
    });

  const seeded: SeededAgent[] = [];
  const register = (a: Agent) => {
    db.upsertAgent(a);
    seeded.push({
      id: a.id,
      displayName: a.displayName,
      hostUserId: a.hostUserId,
      isSupervisor: a.isSupervisor,
    });
    return a;
  };

  // Supervisor (also the panel operator).
  // Sam — ADMIN: full board (all departments) + HRIS connector / tenant config.
  register(
    mkAgent({
      displayName: 'Sam Ortiz (admin)',
      hostUserId: 'u-sam',
      department: 'Support',
      role: 'admin',
    }),
  );
  // Rosa — MANAGER: oversees MULTIPLE departments (Support + Sales), no HRIS config.
  register(
    mkAgent({
      displayName: 'Rosa Lang (manager)',
      hostUserId: 'u-rosa',
      department: 'Sales',
      role: 'manager',
      managedDepartments: ['Support', 'Sales'],
    }),
  );
  // Vera — SUPERVISOR: scoped to a single department (Sales, her own).
  register(
    mkAgent({
      displayName: 'Vera Cole (Sales supervisor)',
      hostUserId: 'u-vera',
      department: 'Sales',
      role: 'supervisor',
    }),
  );

  // Priya — Support — healthy shift: in 6h ago, timely 35-min lunch.
  const priya = register(mkAgent({ displayName: 'Priya Shah', hostUserId: 'u-priya', department: 'Support' }));
  event(priya.id, 'IN', 360);
  event(priya.id, 'BREAK_START', 300);
  event(priya.id, 'BREAK_END', 290); // 10-min break
  event(priya.id, 'LUNCH_START', 240);
  event(priya.id, 'LUNCH_END', 205);

  // Marcus — Support — in 4h40m ago, no lunch yet: 5th-hour deadline approaching.
  const marcus = register(mkAgent({ displayName: 'Marcus Lee', hostUserId: 'u-marcus', department: 'Support' }));
  event(marcus.id, 'IN', 280);
  event(marcus.id, 'BREAK_START', 120);
  event(marcus.id, 'BREAK_END', 110); // 10-min break

  // Nia — Support — just clocked in.
  const nia = register(mkAgent({ displayName: 'Nia Brooks', hostUserId: 'u-nia', department: 'Support' }));
  event(nia.id, 'IN', 8);

  // Dana — Sales — in 5h30m ago, no lunch: BREACH -> missed meal -> premium hour payable.
  const dana = register(mkAgent({ displayName: 'Dana Kim', hostUserId: 'u-dana', department: 'Sales' }));
  event(dana.id, 'IN', 330);

  // Theo — Sales, TEXAS (Central time) — currently on break. TX: no meal deadline.
  const theo = register(mkAgent({ displayName: 'Theo Ruiz', hostUserId: 'u-theo', department: 'Sales', locationState: 'TX', timezone: 'America/Chicago' }));
  event(theo.id, 'IN', 150);
  event(theo.id, 'BREAK_START', 5);

  // Owen — Sales — ORPHAN: clocked IN ~16h ago and never clocked out (past the
  // 14h max-shift threshold). His widget must force a clock-out correction
  // (estimated time + reason) before he can start a new shift.
  const owen = register(
    mkAgent({
      displayName: 'Owen Park',
      hostUserId: 'u-owen',
      department: 'Sales',
      locationState: 'TX', // TX: 16h orphan missed a meal, but no meal penalty owed
      timezone: 'America/Chicago', // Central time
      scheduledStart: new Date(now.getTime() - 16 * 60 * MIN),
      scheduledEnd: new Date(now.getTime() - 8 * 60 * MIN),
    }),
  );
  event(owen.id, 'IN', 16 * 60); // 16h ago, no OUT

  // Wes — BILLING department. Sam does NOT manage Billing, so Sam never sees Wes
  // (department scoping). A Billing supervisor would.
  const wes = register(mkAgent({ displayName: 'Wes Carter', hostUserId: 'u-wes', department: 'Billing', locationState: 'CA' }));
  event(wes.id, 'IN', 200);
  event(wes.id, 'LUNCH_START', 60);
  event(wes.id, 'LUNCH_END', 25);

  // Jordan — FORMER employee: deactivated 120 days ago, so archive-eligible now
  // (90-day rule). Local-only, so the timeclock app is the record of retention —
  // the old punches below must survive (5-year retention), archive only hides.
  const DAY = 24 * 60; // minutes
  const jordan = mkAgent({ displayName: 'Jordan Pike', hostUserId: 'u-jordan', department: 'Support', locationState: 'CA' });
  jordan.active = false;
  jordan.deactivatedAt = new Date(now.getTime() - 120 * DAY * MIN);
  register(jordan);
  event(jordan.id, 'IN', 120 * DAY); // retained punch history from ~120 days ago
  event(jordan.id, 'OUT', 120 * DAY - 8 * 60);

  // ---- Weekly schedule patterns (Mon–Fri) so the forecast has real input.
  const week = (
    agentId: string,
    startTime: string | null,
    endTime: string | null,
    lunchTime: string | null,
    lunchMinutes: number | null,
  ) =>
    db.setPattern(
      agentId,
      [1, 2, 3, 4, 5].map((weekday) => ({
        agentId,
        weekday,
        kind: 'WORK' as const,
        startTime,
        endTime,
        lunchTime,
        lunchMinutes,
      })),
    );

  week(priya.id, '08:00', '17:00', '12:30', 30); // CA 9h days → daily + weekly OT forecast
  week(marcus.id, '07:00', '17:00', null, null); // CA 10h, NO scheduled meal → meal-deadline forecast
  week(nia.id, '09:00', '17:00', '13:00', 30);
  week(dana.id, '08:00', '16:00', '12:00', 30);
  week(theo.id, '08:00', '16:00', '12:00', 30); // TX
  week(owen.id, '08:00', '16:00', '12:00', 30); // TX

  return { tenant, agents: seeded };
}
