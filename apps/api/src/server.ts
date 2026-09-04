/**
 * Time-clock API server (node:http, zero web-framework deps).
 *
 * Wires the domain packages to the in-memory store and serves:
 *   - the embeddable agent widget UI          GET /embed
 *   - the supervisor panel (live via SSE)      GET /supervisor
 *   - the punch write path                     POST /api/punch
 *   - agent + supervisor read models (+SSE)    GET /api/me[/stream], /api/supervisor/*
 *   - the HRIS webhook receiver                POST /webhooks/hris   (injection #2)
 *   - the one-line embed loader                GET /loader.js
 *
 * Background loops: the compliance sweeper and the transactional-outbox drain.
 * With the demo tenant (no HRIS configured) everything runs credential-free.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  InvalidTransitionError,
  PunchService,
  type AgentContext,
  type PunchEventType,
} from '@timeclock/core';
import { drainTenant } from '@timeclock/hris';
import { MemoryDb, localDateOf } from './db.js';
import { seedDemo } from './seed.js';
import { TenantAdapterRegistry } from './hris/registry.js';
import { CONNECTORS, catalogList } from './hris/catalog.js';
import { sweep } from './compliance.js';
import { buildAgentView, buildSupervisorSnapshot } from './snapshot.js';
import {
  ClockoutCorrectionError,
  pendingClockoutCorrection,
  resolveMissingClockout,
} from './orphanCorrection.js';
import { runForecast, scheduleRange, type ForecastResult } from './scheduling.js';
import { makeSummaryProvider, providerKind } from './summaryProvider.js';
import {
  IdentityError,
  mintIdentityToken,
  verifyIdentityToken,
  verifyWebhookSignature,
} from './identity.js';
import { openSse, readBody, readJson, sendFile, sendJson, sendText } from './http.js';
import type { Agent, Role, ScheduleKindT, Tenant } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(HERE, '../public');
const REPO_ROOT = resolve(HERE, '../../..');

const PORT = Number(process.env.PORT ?? 8787);
const IDENTITY_SECRET = process.env.TIMECLOCK_IDENTITY_SECRET ?? 'dev-demo-secret';
const WEBHOOK_SECRET = process.env.TIMECLOCK_WEBHOOK_SECRET ?? 'dev-webhook-secret';
const DEMO = process.env.NODE_ENV !== 'production';

const db = new MemoryDb();
// Seed the demo tenant by default in dev; off in production unless SEED_DEMO=true.
const SEED = process.env.SEED_DEMO ? process.env.SEED_DEMO === 'true' : DEMO;
if (SEED) seedDemo(db);
const registry = new TenantAdapterRegistry(db);
const punch = new PunchService(db);
// Forecast narration: Claude-backed when a key is configured, else deterministic.
const summaryProvider = makeSummaryProvider();

// ------------------------------------------------------------ background loops
const SWEEP_MS = 10_000;
const DRAIN_MS = 5_000;
sweep(db);
setInterval(() => {
  try {
    sweep(db);
  } catch (err) {
    console.error('[sweep]', err);
  }
}, SWEEP_MS).unref();
setInterval(async () => {
  for (const t of db.listTenants()) {
    try {
      await drainTenant(t.id, db, registry);
    } catch (err) {
      console.error('[drain]', t.id, err);
    }
  }
}, DRAIN_MS).unref();

// Forecast worker: recompute each tenant's board for "today" (in the tenant's own
// timezone) on an interval and cache it. The supervisor's Recheck button and this
// loop run the SAME runForecast — one code path whether a human or a timer fired.
const FORECAST_MS = 60_000;
const forecastCache = new Map<string, ForecastResult>();
async function refreshForecast(tenantId: string): Promise<ForecastResult> {
  const t = db.getTenant(tenantId)!;
  const date = localDateOf(new Date(), t.timezone);
  const result = await runForecast(db, tenantId, date, new Date());
  forecastCache.set(tenantId, result);
  return result;
}
setInterval(async () => {
  for (const t of db.listTenants()) {
    try {
      await refreshForecast(t.id);
    } catch (err) {
      console.error('[forecast]', t.id, err);
    }
  }
}, FORECAST_MS).unref();
void Promise.all(db.listTenants().map((t) => refreshForecast(t.id).catch(() => {})));

// Retention & archival policy.
//   - Deactivate is a SOFT delete: punch logs are NEVER hard-deleted (5-year
//     retention floor, FLSA/CA). Reactivating restores the employee.
//   - After 90 days deactivated, an employee is ARCHIVED: hidden from the default
//     Employees view, data still retained. For HRIS-synced employees the HRIS is
//     the archival record of their punches; for local-only employees the
//     timeclock app is the sole record and retains them.
const ARCHIVE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;
function archiveEligible(a: Agent, now = Date.now()): boolean {
  return !a.active && !!a.deactivatedAt && !a.archivedAt && now - a.deactivatedAt.getTime() >= ARCHIVE_AFTER_MS;
}
function archiveEligibleInDays(a: Agent, now = Date.now()): number | null {
  if (a.active || !a.deactivatedAt || a.archivedAt) return null;
  const remaining = ARCHIVE_AFTER_MS - (now - a.deactivatedAt.getTime());
  return Math.max(0, Math.ceil(remaining / (24 * 60 * 60 * 1000)));
}
/** Archive every employee that has been deactivated at least 90 days. */
function runArchival(now = new Date()): number {
  let archived = 0;
  for (const t of db.listTenants()) {
    for (const a of db.listAllAgents(t.id)) {
      if (archiveEligible(a, now.getTime())) {
        db.upsertAgent({ ...a, archivedAt: now });
        archived += 1;
      }
    }
  }
  return archived;
}
// Runs hourly in production; harmless in the demo (nothing crosses 90 days in a
// session). The seeded former employee stays eligible so the manual flow is
// visible; a supervisor can also trigger it via POST /employees/run-archival.
setInterval(() => {
  try {
    const n = runArchival();
    if (n) console.log(`[archival] auto-archived ${n} employee(s) past 90 days`);
  } catch (err) {
    console.error('[archival]', err);
  }
}, 60 * 60 * 1000).unref();

// ------------------------------------------------------------------- auth
interface Resolved {
  agent: Agent;
  tenant: Tenant;
}
class AuthError extends Error {
  constructor(
    public status: number,
    msg: string,
  ) {
    super(msg);
  }
}

/**
 * Resolve the caller to an Agent. Production path: a host-minted identity JWT in
 * Authorization: Bearer. Demo path (only when DEMO): ?user=<hostUserId> or the
 * x-demo-user header, so the panel is explorable without a host CRM.
 */
function resolveAgent(req: IncomingMessage, url: URL): Resolved {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) {
    let claims;
    try {
      claims = verifyIdentityToken(auth.slice(7), IDENTITY_SECRET);
    } catch (e) {
      throw new AuthError(401, e instanceof IdentityError ? e.message : 'invalid token');
    }
    const tenant = db.getTenant(claims.tenantId);
    if (!tenant) throw new AuthError(401, 'unknown tenant');
    const agent = db.agentByHostUserId(tenant.id, claims.hostUserId);
    if (!agent) throw new AuthError(403, 'no agent mapped for host user');
    // Host-asserted role (when present in the verified JWT) is authoritative for
    // this session; otherwise the stored agent role applies. Shallow-copy so the
    // store is never mutated by a per-request assertion.
    const effective =
      claims.role && claims.role !== agent.role
        ? { ...agent, role: claims.role, isSupervisor: claims.role !== 'user' }
        : agent;
    return { agent: effective, tenant };
  }
  if (DEMO) {
    const tenantId = url.searchParams.get('tenant') ?? (req.headers['x-demo-tenant'] as string) ?? 'demo';
    const user =
      url.searchParams.get('user') ?? (req.headers['x-demo-user'] as string | undefined);
    if (user) {
      const tenant = db.getTenant(tenantId);
      if (!tenant) throw new AuthError(401, 'unknown tenant');
      const agent = db.agentByHostUserId(tenant.id, user);
      if (!agent) throw new AuthError(403, 'no such demo user');
      return { agent, tenant };
    }
  }
  throw new AuthError(401, 'missing identity token');
}

/** Manager-level: admin or supervisor. Gates the supervisor board + employee ops. */
function requireSupervisor(r: Resolved): void {
  if (r.agent.role !== 'admin' && r.agent.role !== 'supervisor') {
    throw new AuthError(403, 'supervisor or admin only');
  }
}
/** Admin-only: HRIS connector config, tenant settings, role assignment. */
function requireAdmin(r: Resolved): void {
  if (r.agent.role !== 'admin') throw new AuthError(403, 'admin only');
}

/** Departments a supervisor may see. Admins see all (null). */
function managedDepartments(sup: Agent): string[] | null {
  if (sup.role === 'admin') return null; // admins are not department-scoped
  return sup.managedDepartments && sup.managedDepartments.length ? sup.managedDepartments : null;
}
/**
 * Resolve the department filter for a supervisor request: the intersection of
 * what they manage and any requested `department`. Returns null = no restriction
 * (org admin, no filter). Throws 403 if they request a department they don't manage.
 */
function deptScope(sup: Agent, requested?: string | null): string[] | null {
  const managed = managedDepartments(sup);
  if (requested) {
    if (managed && !managed.includes(requested)) {
      throw new AuthError(403, `you do not manage the ${requested} department`);
    }
    return [requested];
  }
  return managed;
}

/** Filter a forecast's agent-attributed alerts to a supervisor's managed departments. */
function scopeForecast(result: ForecastResult, sup: Agent): ForecastResult {
  const managed = managedDepartments(sup);
  if (!managed) return result;
  const set = new Set(managed);
  const alerts = result.alerts.filter((a) => {
    if (!a.agentId) return true; // org-wide (coverage) alerts have no department
    const dept = db.getAgent(a.agentId)?.department;
    return dept ? set.has(dept) : true;
  });
  return { ...result, alerts };
}

/** CSV cell: quote when it contains comma/quote/newline; double embedded quotes. */
function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Determine the role to assign, preventing privilege escalation: only an admin
 * caller may grant 'admin' or 'supervisor'; anyone else creates 'user's.
 */
function resolveAssignableRole(caller: Agent, requestedRole?: unknown, legacyIsSupervisor?: unknown): Role {
  const requested =
    typeof requestedRole === 'string'
      ? requestedRole
      : legacyIsSupervisor === true
        ? 'supervisor'
        : 'user';
  if (caller.role !== 'admin') return 'user';
  return requested === 'admin' || requested === 'supervisor' ? requested : 'user';
}

/** Stable-ish host identity id for a manually-created or pulled employee. */
function makeHostUserId(tenantId: string, displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20) || 'user';
  let candidate = `u-${slug}`;
  let n = 2;
  while (db.agentByHostUserId(tenantId, candidate)) candidate = `u-${slug}-${n++}`;
  return candidate;
}

function historyRow(e: {
  eventType: string;
  eventTime: Date;
  source: string;
  status: string;
  note?: string;
}) {
  return {
    eventType: e.eventType,
    eventTime: e.eventTime.toISOString(),
    source: e.source,
    status: e.status,
    note: e.note ?? null,
  };
}

// ---- schedule-editor validation
class BadInput extends Error {}
const SCHEDULE_KINDS = new Set<ScheduleKindT>([
  'WORK',
  'TRAINING',
  'HOLIDAY',
  'VACATION',
  'PTO',
  'SICK',
  'LEAVE',
  'OFF',
]);
const WORKING_SCHEDULE_KINDS = new Set<ScheduleKindT>(['WORK', 'TRAINING']);
const timeOk = (s: unknown): s is string => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

interface NormalizedScheduleRow {
  weekday?: number;
  kind: ScheduleKindT;
  startTime: string | null;
  endTime: string | null;
  lunchTime: string | null;
  lunchMinutes: number | null;
}

/**
 * Validate one pattern/exception row. An absence cannot carry hours and a
 * working day must have them — refused here, exactly as the bs5_1 RPC does.
 */
function normalizeScheduleRow(d: Record<string, unknown>, _agentId: string, _date: string | null): NormalizedScheduleRow {
  const kind = String(d.kind ?? 'WORK').toUpperCase() as ScheduleKindT;
  if (!SCHEDULE_KINDS.has(kind)) throw new BadInput(`kind must be one of ${[...SCHEDULE_KINDS].join(', ')}`);
  const weekday = d.weekday !== undefined ? Number(d.weekday) : undefined;

  if (WORKING_SCHEDULE_KINDS.has(kind)) {
    if (!timeOk(d.startTime) || !timeOk(d.endTime)) throw new BadInput(`${kind} needs startTime and endTime (HH:MM)`);
    let lunchTime: string | null = null;
    if (d.lunchTime) {
      if (!timeOk(d.lunchTime)) throw new BadInput('lunchTime must be HH:MM');
      lunchTime = d.lunchTime;
    }
    let lunchMinutes: number | null =
      d.lunchMinutes === undefined || d.lunchMinutes === null ? (lunchTime ? 30 : null) : Number(d.lunchMinutes);
    if (lunchMinutes !== null && (!Number.isInteger(lunchMinutes) || lunchMinutes < 0 || lunchMinutes > 240)) {
      throw new BadInput('lunchMinutes must be an integer 0..240');
    }
    return { weekday, kind, startTime: d.startTime, endTime: d.endTime, lunchTime, lunchMinutes };
  }
  // Absence: no hours allowed.
  if (d.startTime || d.endTime) throw new BadInput(`${kind} is an absence and cannot carry hours`);
  return { weekday, kind, startTime: null, endTime: null, lunchTime: null, lunchMinutes: null };
}

function agentContext(r: Resolved): AgentContext {
  return {
    agentId: r.agent.id,
    tenantId: r.tenant.id,
    timezone: r.agent.timezone,
    hrisEmployeeId: r.agent.hrisEmployeeId,
  };
}

// --------------------------------------------------------------- routing
const VALID_PUNCH: ReadonlySet<string> = new Set<PunchEventType>([
  'IN',
  'OUT',
  'BREAK_START',
  'BREAK_END',
  'LUNCH_START',
  'LUNCH_END',
]);

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const p = url.pathname;
  const method = req.method ?? 'GET';

  // ---- static + health
  if (p === '/healthz') return sendJson(res, 200, { ok: true, tenants: db.listTenants().length });
  if (p === '/' ) return sendFile(res, resolve(PUBLIC, 'index.html'), 'text/html; charset=utf-8');
  if (p === '/embed') return sendFile(res, resolve(PUBLIC, 'embed.html'), 'text/html; charset=utf-8');
  if (p === '/supervisor')
    return sendFile(res, resolve(PUBLIC, 'supervisor.html'), 'text/html; charset=utf-8');
  if (p === '/loader.js')
    return sendFile(res, resolve(REPO_ROOT, 'widget/loader.js'), 'text/javascript; charset=utf-8');

  // ---- demo helper: mint an identity token the way a host backend would
  if (p === '/api/dev/token' && DEMO) {
    const user = url.searchParams.get('user');
    const tenant = url.searchParams.get('tenant') ?? 'demo';
    if (!user) return sendJson(res, 400, { error: 'user required' });
    const agent = db.agentByHostUserId(tenant, user);
    if (!agent) return sendJson(res, 404, { error: 'no such user' });
    // Mint the way a host backend would, asserting the mapped agent's role.
    const token = mintIdentityToken(
      { tenantId: tenant, hostUserId: user, displayName: agent.displayName, role: agent.role },
      IDENTITY_SECRET,
    );
    return sendJson(res, 200, { token, role: agent.role });
  }

  // ---- roster helper for the demo agent-switcher
  if (p === '/api/dev/agents' && DEMO) {
    const tenant = url.searchParams.get('tenant') ?? 'demo';
    return sendJson(
      res,
      200,
      db.listAgents(tenant).map((a) => ({
        hostUserId: a.hostUserId,
        displayName: a.displayName,
        isSupervisor: a.isSupervisor,
      })),
    );
  }

  try {
    // ---- agent read model
    if (p === '/api/me' && method === 'GET') {
      const r = resolveAgent(req, url);
      return sendJson(res, 200, buildAgentView(db, r.agent, new Date()));
    }

    // ---- agent SSE
    if (p === '/api/me/stream' && method === 'GET') {
      const r = resolveAgent(req, url);
      const sse = openSse(res);
      const push = () => sse.send('update', buildAgentView(db, r.agent, new Date()));
      push();
      const listener = (e: { agentId?: string }) => {
        if (e.agentId === r.agent.id) push();
      };
      db.bus.on('change', listener);
      const tick = setInterval(push, 10_000);
      sse.onClose(() => {
        db.bus.off('change', listener);
        clearInterval(tick);
      });
      return;
    }

    // ---- punch write path
    if (p === '/api/punch' && method === 'POST') {
      const r = resolveAgent(req, url);
      const body = await readJson<{ type?: string; note?: string }>(req);
      if (!body.type || !VALID_PUNCH.has(body.type)) {
        return sendJson(res, 400, { error: 'invalid punch type' });
      }
      // Orphan gate: a missing clock-out must be filed before a new clock-in.
      if (body.type === 'IN') {
        const correction = pendingClockoutCorrection(db, r.agent, new Date());
        if (correction) {
          return sendJson(res, 409, {
            code: 'ORPHAN_CLOCKOUT_REQUIRED',
            error: 'File the missing clock-out from your previous shift before clocking in.',
            correction: {
              shiftStart: correction.shiftStart.toISOString(),
              ageMs: correction.ageMs,
              suggestedClockout: correction.suggestedClockout.toISOString(),
            },
          });
        }
      }
      try {
        const result = await punch.punch(agentContext(r), body.type as PunchEventType, {
          note: body.note,
        });
        sweep(db); // refresh compliance immediately after a state change
        return sendJson(res, 200, {
          ...result,
          view: buildAgentView(db, r.agent, new Date()),
        });
      } catch (e) {
        if (e instanceof InvalidTransitionError) {
          return sendJson(res, 409, { error: e.message, code: 'INVALID_TRANSITION' });
        }
        throw e;
      }
    }

    // ---- missing clock-out correction (orphan IN): logs estimated time + reason
    if (p === '/api/clockout-correction' && method === 'POST') {
      const r = resolveAgent(req, url);
      const body = await readJson<{
        estimatedClockoutUtc?: string;
        estimatedMinutes?: number;
        reason?: string;
      }>(req);
      try {
        const result = resolveMissingClockout(
          db,
          r.agent,
          {
            estimatedClockoutUtc: body.estimatedClockoutUtc,
            estimatedMinutes: body.estimatedMinutes,
            reason: body.reason ?? '',
          },
          new Date(),
        );
        sweep(db);
        return sendJson(res, 200, {
          ...result,
          estimatedClockout: result.estimatedClockout.toISOString(),
          view: buildAgentView(db, r.agent, new Date()),
        });
      } catch (e) {
        if (e instanceof ClockoutCorrectionError) return sendJson(res, 400, { error: e.message });
        throw e;
      }
    }

    // ---- agent's own punch history for a local calendar date
    if (p === '/api/history' && method === 'GET') {
      const r = resolveAgent(req, url);
      const date = url.searchParams.get('date') || localDateOf(new Date(), r.agent.timezone);
      const events = db.eventsOnLocalDate(r.tenant.id, date, { agentId: r.agent.id });
      return sendJson(res, 200, { date, timezone: r.agent.timezone, events: events.map(historyRow) });
    }

    // ---- CSV export of all punches (scoped to managed departments, filterable)
    if (p === '/api/supervisor/export/punches' && method === 'GET') {
      const r = resolveAgent(req, url);
      requireSupervisor(r);
      const requestedDept = url.searchParams.get('department') || undefined;
      const scope = deptScope(r.agent, requestedDept); // may throw 403
      const scopeSet = scope ? new Set(scope) : null;
      const from = url.searchParams.get('from') || undefined;
      const to = url.searchParams.get('to') || undefined;
      const stz = r.tenant.timezone;

      const rows = db.tenantEvents(r.tenant.id).filter((e) => {
        const a = db.getAgent(e.agentId);
        if (!a || a.isSupervisor) return false;
        if (scopeSet && !scopeSet.has(a.department)) return false;
        if (from || to) {
          const d = localDateOf(e.eventTime, stz);
          if (from && d < from) return false;
          if (to && d > to) return false;
        }
        return true;
      });

      const header = [
        'timestamp_utc',
        'timestamp_server_local',
        'server_timezone',
        'employee',
        'host_user_id',
        'hris_employee_id',
        'department',
        'work_state',
        'event_type',
        'source',
        'status',
        'note',
      ];
      const lines = [header.join(',')];
      for (const e of rows) {
        const a = db.getAgent(e.agentId)!;
        lines.push(
          [
            e.eventTime.toISOString(),
            new Intl.DateTimeFormat('sv-SE', { timeZone: stz, dateStyle: 'short', timeStyle: 'medium' }).format(e.eventTime),
            stz,
            a.displayName,
            a.hostUserId,
            a.hrisEmployeeId ?? '',
            a.department,
            a.locationState,
            e.eventType,
            e.source,
            e.status,
            e.note ?? '',
          ]
            .map(csvCell)
            .join(','),
        );
      }
      const csv = lines.join('\r\n') + '\r\n';
      const stamp = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="punches-${r.tenant.id}-${stamp}.csv"`,
        'Cache-Control': 'no-store',
      });
      res.end(csv);
      return;
    }

    // ---- supervisor history: all agents on a date, filterable by department
    if (p === '/api/supervisor/history' && method === 'GET') {
      const r = resolveAgent(req, url);
      requireSupervisor(r);
      const date =
        url.searchParams.get('date') || localDateOf(new Date(), r.tenant.timezone);
      const department = url.searchParams.get('department') || undefined;
      const scope = deptScope(r.agent, department); // managed ∩ requested; may throw 403
      const scopeSet = scope ? new Set(scope) : null;
      const events = db
        .eventsOnLocalDate(r.tenant.id, date, {})
        .filter((e) => !scopeSet || scopeSet.has(db.getAgent(e.agentId)?.department ?? ''));
      return sendJson(res, 200, {
        date,
        department: department ?? null,
        departments: managedDepartments(r.agent) ?? db.departments(r.tenant.id),
        serverTimezone: r.tenant.timezone, // supervisor views punches in server/HQ time
        events: events.map((e) => ({
          ...historyRow(e),
          agentName: db.getAgent(e.agentId)?.displayName ?? e.agentId,
          department: db.getAgent(e.agentId)?.department ?? '—',
          timezone: db.getAgent(e.agentId)?.timezone ?? 'UTC', // employee's own zone (context)
        })),
      });
    }

    // ---- schedule reads (agent: own; supervisor: everyone), resolved per date
    if (p === '/api/me/schedule' && method === 'GET') {
      const r = resolveAgent(req, url);
      const from = url.searchParams.get('from') || localDateOf(new Date(), r.agent.timezone);
      const to = url.searchParams.get('to') || from;
      return sendJson(res, 200, { from, to, days: scheduleRange(db, [r.agent.id], from, to) });
    }
    if (p === '/api/supervisor/schedule' && method === 'GET') {
      const r = resolveAgent(req, url);
      requireSupervisor(r);
      const today = localDateOf(new Date(), r.tenant.timezone);
      const from = url.searchParams.get('from') || today;
      const to = url.searchParams.get('to') || from;
      const schedScope = deptScope(r.agent, url.searchParams.get('department'));
      const schedSet = schedScope ? new Set(schedScope) : null;
      const roster = db
        .listAgents(r.tenant.id)
        .filter((a) => !a.isSupervisor && (!schedSet || schedSet.has(a.department)));
      const ids = roster.map((a) => a.id);
      const patterns: Record<string, unknown> = {};
      for (const a of roster) patterns[a.id] = db.getPattern(a.id);
      return sendJson(res, 200, {
        from,
        to,
        agents: roster.map((a) => ({
          agentId: a.id,
          displayName: a.displayName,
          department: a.department,
          locationState: a.locationState,
          timezone: a.timezone,
        })),
        patterns,
        days: scheduleRange(db, ids, from, to),
      });
    }

    // ---- schedule writes (supervisor only)
    if (p === '/api/supervisor/schedule/pattern' && method === 'POST') {
      const r = resolveAgent(req, url);
      requireSupervisor(r);
      const body = await readJson<{ agentId?: string; days?: unknown }>(req);
      const agent = body.agentId ? db.getAgent(body.agentId) : undefined;
      if (!agent || agent.tenantId !== r.tenant.id) return sendJson(res, 400, { error: 'unknown agentId' });
      if (!Array.isArray(body.days)) return sendJson(res, 400, { error: 'days must be an array (empty = no scheduled days)' });
      try {
        const seen = new Set<number>();
        const rows = (body.days as Record<string, unknown>[]).map((d) => {
          const weekday = Number(d.weekday);
          if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new BadInput('weekday must be 0..6');
          if (seen.has(weekday)) throw new BadInput(`weekday ${weekday} appears twice`);
          seen.add(weekday);
          return normalizeScheduleRow(d, agent.id, null);
        });
        db.setPattern(agent.id, rows.map((x) => ({ ...x, agentId: agent.id, weekday: x.weekday! })));
        await refreshForecast(r.tenant.id);
        return sendJson(res, 200, { ok: true, agentId: agent.id, days: db.getPattern(agent.id) });
      } catch (e) {
        if (e instanceof BadInput) return sendJson(res, 400, { error: e.message });
        throw e;
      }
    }

    if (p === '/api/supervisor/schedule/day' && method === 'POST') {
      const r = resolveAgent(req, url);
      requireSupervisor(r);
      const body = await readJson<Record<string, unknown>>(req);
      const agent = typeof body.agentId === 'string' ? db.getAgent(body.agentId) : undefined;
      if (!agent || agent.tenantId !== r.tenant.id) return sendJson(res, 400, { error: 'unknown agentId' });
      const date = typeof body.date === 'string' ? body.date : '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'date must be YYYY-MM-DD' });
      try {
        const row = normalizeScheduleRow(body, agent.id, date);
        db.setScheduleException({
          agentId: agent.id,
          date,
          kind: row.kind,
          startTime: row.startTime,
          endTime: row.endTime,
          lunchTime: row.lunchTime,
          lunchMinutes: row.lunchMinutes,
          ...(typeof body.note === 'string' ? { note: body.note.slice(0, 300) } : {}),
        });
        await refreshForecast(r.tenant.id);
        return sendJson(res, 200, { ok: true, agentId: agent.id, date });
      } catch (e) {
        if (e instanceof BadInput) return sendJson(res, 400, { error: e.message });
        throw e;
      }
    }

    if (p === '/api/supervisor/schedule/day/clear' && method === 'POST') {
      const r = resolveAgent(req, url);
      requireSupervisor(r);
      const body = await readJson<{ agentId?: string; date?: string }>(req);
      const agent = body.agentId ? db.getAgent(body.agentId) : undefined;
      if (!agent || agent.tenantId !== r.tenant.id) return sendJson(res, 400, { error: 'unknown agentId' });
      if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return sendJson(res, 400, { error: 'date must be YYYY-MM-DD' });
      const removed = db.clearScheduleException(agent.id, body.date);
      await refreshForecast(r.tenant.id);
      return sendJson(res, 200, { ok: true, removed });
    }

    // ---- forecast: cached board (GET) or an on-demand recompute (POST)
    if (p === '/api/supervisor/forecast' && method === 'GET') {
      const r = resolveAgent(req, url);
      requireSupervisor(r);
      const cached = forecastCache.get(r.tenant.id) ?? (await refreshForecast(r.tenant.id));
      return sendJson(res, 200, scopeForecast(cached, r.agent));
    }
    if (p === '/api/supervisor/forecast' && method === 'POST') {
      const r = resolveAgent(req, url);
      requireSupervisor(r);
      const body = await readJson<{ date?: string }>(req);
      const date = body.date || localDateOf(new Date(), r.tenant.timezone);
      // On-demand recompute uses the configured (Claude) provider for the summary.
      const result = await runForecast(db, r.tenant.id, date, new Date(), summaryProvider);
      forecastCache.set(r.tenant.id, result);
      return sendJson(res, 200, scopeForecast(result, r.agent));
    }

    // ---- HRIS connectors (admin): catalog, get/set this tenant's connector
    if (p === '/api/admin/hris/catalog' && method === 'GET') {
      const r = resolveAgent(req, url);
      requireAdmin(r);
      return sendJson(res, 200, { connectors: catalogList() });
    }
    if (p === '/api/admin/hris' && method === 'GET') {
      const r = resolveAgent(req, url);
      requireAdmin(r);
      const provider = r.tenant.hrisProvider ?? 'none';
      const info = CONNECTORS[provider];
      const cfg = (r.tenant.hrisConfig ?? {}) as Record<string, unknown>;
      // Never return secret values — only whether each is set.
      const config: Record<string, unknown> = {};
      for (const f of info?.configFields ?? []) {
        config[f.key] = f.secret ? (cfg[f.key] ? '••••••' : '') : (cfg[f.key] ?? '');
      }
      const adapter = await registry.forTenant(r.tenant.id);
      return sendJson(res, 200, { provider, configured: adapter !== null, config });
    }
    if (p === '/api/admin/hris' && method === 'POST') {
      const r = resolveAgent(req, url);
      requireAdmin(r);
      const body = await readJson<{ provider?: string; config?: Record<string, unknown> }>(req);
      const provider = body.provider ?? 'none';
      const info = CONNECTORS[provider];
      if (!info) return sendJson(res, 400, { error: `unknown connector '${provider}'` });
      // Merge: keep existing values for secret fields the admin left blank.
      const existing = (r.tenant.hrisConfig ?? {}) as Record<string, unknown>;
      const incoming = body.config ?? {};
      const next: Record<string, unknown> = { ...existing };
      for (const f of info.configFields) {
        const v = incoming[f.key];
        if (v === undefined) continue;
        if (f.secret && (v === '' || v === '••••••')) continue; // blank/masked → keep existing
        next[f.key] = v;
      }
      db.setTenantHris(r.tenant.id, provider === 'none' ? null : provider, info.configFields.length ? next : {});
      registry.invalidate(r.tenant.id); // rebuild the adapter from fresh config
      const adapter = await registry.forTenant(r.tenant.id);
      return sendJson(res, 200, { ok: true, provider, configured: adapter !== null });
    }

    // ---- employees "user menu": list, create (local or HRIS-synced), pull, link
    if (p === '/api/supervisor/employees' && method === 'GET') {
      const r = resolveAgent(req, url);
      requireSupervisor(r);
      const tenant = r.tenant;
      const includeArchived = url.searchParams.get('includeArchived') === '1';
      const nowMs = Date.now();
      const scope = deptScope(r.agent, url.searchParams.get('department')); // may throw 403
      const scopeSet = scope ? new Set(scope) : null;
      const all = db
        .listAllAgents(tenant.id)
        .filter((a) => (includeArchived || !a.archivedAt) && (!scopeSet || scopeSet.has(a.department)));
      return sendJson(res, 200, {
        hrisProvider: tenant.hrisProvider,
        visibleDepartments: managedDepartments(r.agent) ?? db.departments(tenant.id),
        viewerRole: r.agent.role,
        includeArchived,
        archivedCount: db.listAllAgents(tenant.id).filter((a) => a.archivedAt).length,
        employees: all.map((a) => ({
          agentId: a.id,
          displayName: a.displayName,
          department: a.department,
          locationState: a.locationState,
          timezone: a.timezone,
          role: a.role,
          managedDepartments: a.managedDepartments ?? null,
          isSupervisor: a.isSupervisor,
          hostUserId: a.hostUserId,
          hrisEmployeeId: a.hrisEmployeeId,
          synced: a.hrisEmployeeId !== null,
          active: a.active,
          deactivatedAt: a.deactivatedAt?.toISOString() ?? null,
          archivedAt: a.archivedAt?.toISOString() ?? null,
          archived: !!a.archivedAt,
          archiveEligible: archiveEligible(a, nowMs),
          archiveEligibleInDays: archiveEligibleInDays(a, nowMs),
          // Where the punch record of retention lives.
          punchRetention: a.hrisEmployeeId !== null ? 'HRIS' : 'TIMECLOCK',
        })),
      });
    }

    if (p === '/api/supervisor/employees' && method === 'POST') {
      const r = resolveAgent(req, url);
      requireSupervisor(r);
      const b = await readJson<Record<string, unknown>>(req);
      const displayName = typeof b.displayName === 'string' ? b.displayName.trim() : '';
      if (!displayName) return sendJson(res, 400, { error: 'displayName is required' });
      const syncToHris = b.syncToHris === true;
      const hrisEmployeeId = syncToHris
        ? (typeof b.hrisEmployeeId === 'string' && b.hrisEmployeeId.trim()) || `mock-${randomUUID().slice(0, 8)}`
        : null;
      // Only an admin may assign a role above 'user'; managers create team members.
      const role = resolveAssignableRole(r.agent, b.role, b.isSupervisor);
      const agent: Agent = {
        id: randomUUID(),
        tenantId: r.tenant.id,
        displayName,
        department: typeof b.department === 'string' && b.department.trim() ? b.department.trim() : 'General',
        locationState: typeof b.locationState === 'string' && b.locationState.trim() ? b.locationState.trim().toUpperCase() : 'CA',
        timezone: typeof b.timezone === 'string' && b.timezone.trim() ? b.timezone.trim() : r.tenant.timezone,
        role,
        isSupervisor: role !== 'user',
        managedDepartments:
          role === 'supervisor' && Array.isArray(b.managedDepartments)
            ? (b.managedDepartments as unknown[]).filter((d): d is string => typeof d === 'string')
            : undefined,
        hostUserId: makeHostUserId(r.tenant.id, displayName),
        hrisEmployeeId,
        hrisDepartmentId: typeof b.hrisDepartmentId === 'string' ? b.hrisDepartmentId : null,
        hrisActivityTypeId: typeof b.hrisActivityTypeId === 'string' ? b.hrisActivityTypeId : null,
        mealWaiverOnFile: false,
        active: true,
      };
      db.upsertAgent(agent);
      return sendJson(res, 200, {
        ok: true,
        agentId: agent.id,
        hostUserId: agent.hostUserId,
        synced: agent.hrisEmployeeId !== null,
        source: 'MANUAL',
      });
    }

    if (p === '/api/supervisor/employees/pull-hris' && method === 'POST') {
      const r = resolveAgent(req, url);
      requireSupervisor(r);
      const adapter = await registry.forTenant(r.tenant.id);
      if (!adapter) {
        return sendJson(res, 400, {
          error: 'No HRIS is configured for this tenant — connect one before pulling.',
        });
      }
      const b = await readJson<{ department?: string; locationState?: string }>(req);
      let created = 0;
      let skipped = 0;
      let cursor: string | undefined;
      const imported: { displayName: string; hrisEmployeeId: string }[] = [];
      do {
        const page = await adapter.listEmployees(cursor);
        for (const emp of page.items) {
          if (db.agentByHrisEmployeeId(r.tenant.id, emp.hrisEmployeeId)) {
            skipped += 1;
            continue;
          }
          const name = emp.displayName || emp.employeeNumber || emp.hrisEmployeeId;
          db.upsertAgent({
            id: randomUUID(),
            tenantId: r.tenant.id,
            displayName: name,
            department: b.department?.trim() || 'General',
            locationState: (b.locationState?.trim() || 'CA').toUpperCase(),
            timezone: r.tenant.timezone,
            role: 'user',
            isSupervisor: false,
            hostUserId: makeHostUserId(r.tenant.id, name),
            hrisEmployeeId: emp.hrisEmployeeId, // synced by construction
            hrisDepartmentId: null,
            hrisActivityTypeId: null,
            mealWaiverOnFile: false,
            active: true,
          });
          imported.push({ displayName: name, hrisEmployeeId: emp.hrisEmployeeId });
          created += 1;
        }
        cursor = page.nextCursor;
      } while (cursor);
      return sendJson(res, 200, { ok: true, created, skipped, imported, provider: adapter.provider });
    }

    // ---- run the 90-day archival policy on demand (same as the hourly job).
    // Must precede the :id edit route below — 'run-archival' is a single segment.
    if (p === '/api/supervisor/employees/run-archival' && method === 'POST') {
      const r = resolveAgent(req, url);
      requireSupervisor(r);
      const archived = runArchival();
      return sendJson(res, 200, { ok: true, archived });
    }

    // ---- edit an employee's profile fields
    const empEdit = p.match(/^\/api\/supervisor\/employees\/([^/]+)$/);
    if (empEdit && method === 'POST') {
      const r = resolveAgent(req, url);
      requireSupervisor(r);
      const agent = db.getAgent(empEdit[1]);
      if (!agent || agent.tenantId !== r.tenant.id) return sendJson(res, 404, { error: 'no such employee' });
      const b = await readJson<Record<string, unknown>>(req);
      if (typeof b.displayName === 'string' && !b.displayName.trim()) {
        return sendJson(res, 400, { error: 'displayName cannot be blank' });
      }
      const next: Agent = {
        ...agent,
        displayName: typeof b.displayName === 'string' && b.displayName.trim() ? b.displayName.trim() : agent.displayName,
        department: typeof b.department === 'string' && b.department.trim() ? b.department.trim() : agent.department,
        locationState:
          typeof b.locationState === 'string' && b.locationState.trim()
            ? b.locationState.trim().toUpperCase()
            : agent.locationState,
        timezone: typeof b.timezone === 'string' && b.timezone.trim() ? b.timezone.trim() : agent.timezone,
      };
      // Role changes are admin-only; a manager editing a profile can't change tiers.
      if (r.agent.role === 'admin' && (typeof b.role === 'string' || typeof b.isSupervisor === 'boolean')) {
        next.role = resolveAssignableRole(r.agent, b.role, b.isSupervisor);
        next.isSupervisor = next.role !== 'user';
        if (next.role === 'supervisor' && Array.isArray(b.managedDepartments)) {
          next.managedDepartments = (b.managedDepartments as unknown[]).filter((d): d is string => typeof d === 'string');
        } else if (next.role !== 'supervisor') {
          next.managedDepartments = undefined;
        }
      }
      db.upsertAgent(next);
      return sendJson(res, 200, { ok: true, agentId: next.id });
    }

    // ---- activate / deactivate an employee
    const empActive = p.match(/^\/api\/supervisor\/employees\/([^/]+)\/active$/);
    if (empActive && method === 'POST') {
      const r = resolveAgent(req, url);
      requireSupervisor(r);
      const agent = db.getAgent(empActive[1]);
      if (!agent || agent.tenantId !== r.tenant.id) return sendJson(res, 404, { error: 'no such employee' });
      const b = await readJson<{ active?: boolean }>(req);
      const activate = b.active !== false;
      if (agent.id === r.agent.id && !activate) {
        return sendJson(res, 400, { error: 'you cannot deactivate yourself' });
      }
      const next: Agent = activate
        ? { ...agent, active: true, deactivatedAt: null, archivedAt: null } // reactivate also unarchives
        : { ...agent, active: false, deactivatedAt: agent.deactivatedAt ?? new Date() };
      db.upsertAgent(next);
      return sendJson(res, 200, { ok: true, agentId: agent.id, active: next.active });
    }

    // ---- archive (after 90 days deactivated) / unarchive — never a hard delete
    const empArchive = p.match(/^\/api\/supervisor\/employees\/([^/]+)\/archive$/);
    if (empArchive && method === 'POST') {
      const r = resolveAgent(req, url);
      requireSupervisor(r);
      const agent = db.getAgent(empArchive[1]);
      if (!agent || agent.tenantId !== r.tenant.id) return sendJson(res, 404, { error: 'no such employee' });
      if (!archiveEligible(agent)) {
        const inDays = archiveEligibleInDays(agent);
        return sendJson(res, 400, {
          error:
            agent.active
              ? 'Deactivate the employee first; archiving is only for employees inactive 90+ days.'
              : agent.archivedAt
                ? 'Already archived.'
                : `Not archivable yet — eligible in ${inDays} day(s) (90-day rule). Punch logs are retained regardless.`,
        });
      }
      db.upsertAgent({ ...agent, archivedAt: new Date() });
      return sendJson(res, 200, {
        ok: true,
        agentId: agent.id,
        archived: true,
        punchRetention: agent.hrisEmployeeId !== null ? 'HRIS' : 'TIMECLOCK',
      });
    }

    const empUnarchive = p.match(/^\/api\/supervisor\/employees\/([^/]+)\/unarchive$/);
    if (empUnarchive && method === 'POST') {
      const r = resolveAgent(req, url);
      requireSupervisor(r);
      const agent = db.getAgent(empUnarchive[1]);
      if (!agent || agent.tenantId !== r.tenant.id) return sendJson(res, 404, { error: 'no such employee' });
      db.upsertAgent({ ...agent, archivedAt: null }); // stays deactivated, just un-hidden
      return sendJson(res, 200, { ok: true, agentId: agent.id, archived: false });
    }

    const empHris = p.match(/^\/api\/supervisor\/employees\/([^/]+)\/hris$/);
    if (empHris && method === 'POST') {
      const r = resolveAgent(req, url);
      requireSupervisor(r);
      const agent = db.getAgent(empHris[1]);
      if (!agent || agent.tenantId !== r.tenant.id) return sendJson(res, 404, { error: 'no such employee' });
      const b = await readJson<{ sync?: boolean; hrisEmployeeId?: string }>(req);
      const next: Agent = {
        ...agent,
        hrisEmployeeId: b.sync
          ? (b.hrisEmployeeId?.trim() || agent.hrisEmployeeId || `mock-${randomUUID().slice(0, 8)}`)
          : null,
      };
      db.upsertAgent(next);
      return sendJson(res, 200, { ok: true, agentId: next.id, synced: next.hrisEmployeeId !== null, hrisEmployeeId: next.hrisEmployeeId });
    }

    // ---- supervisor snapshot
    if (p === '/api/supervisor/snapshot' && method === 'GET') {
      const r = resolveAgent(req, url);
      requireSupervisor(r);
      return sendJson(res, 200, buildSupervisorSnapshot(db, r.tenant.id, new Date(), managedDepartments(r.agent), r.agent.role));
    }

    // ---- supervisor SSE
    if (p === '/api/supervisor/stream' && method === 'GET') {
      const r = resolveAgent(req, url);
      requireSupervisor(r);
      const sse = openSse(res);
      let scheduled = false;
      const push = () => {
        scheduled = false;
        sse.send('snapshot', buildSupervisorSnapshot(db, r.tenant.id, new Date(), managedDepartments(r.agent), r.agent.role));
      };
      push();
      const listener = (e: { tenantId?: string }) => {
        if (e.tenantId !== r.tenant.id || scheduled) return;
        scheduled = true;
        setTimeout(push, 150); // debounce bursts
      };
      db.bus.on('change', listener);
      const tick = setInterval(push, 5_000); // live countdowns
      sse.onClose(() => {
        db.bus.off('change', listener);
        clearInterval(tick);
      });
      return;
    }

    // ---- supervisor resolves an exception
    const exMatch = p.match(/^\/api\/exceptions\/([^/]+)\/resolve$/);
    if (exMatch && method === 'POST') {
      const r = resolveAgent(req, url);
      requireSupervisor(r);
      const body = await readJson<{ resolution?: string }>(req);
      const ex = db.resolveException(exMatch[1], r.agent.id, body.resolution ?? 'resolved');
      if (!ex) return sendJson(res, 404, { error: 'no such exception' });
      return sendJson(res, 200, ex);
    }

    // ---- HRIS webhook receiver (injection #2): identity-map sync
    if (p === '/webhooks/hris' && method === 'POST') {
      const raw = await readBody(req);
      const sig = (req.headers['x-hris-signature'] as string) ?? '';
      if (!verifyWebhookSignature(raw, sig, WEBHOOK_SECRET)) {
        return sendJson(res, 401, { error: 'bad signature' });
      }
      return handleWebhook(raw, res);
    }
  } catch (e) {
    if (e instanceof AuthError) return sendJson(res, e.status, { error: e.message });
    console.error('[server]', e);
    return sendJson(res, 500, { error: 'internal error' });
  }

  return sendText(res, 404, 'not found');
}

/**
 * Injection #2 — HRIS event subscription handler.
 * Employee.Modified / Employee.Created keep the identity map in sync: when the
 * HRIS reports an employee whose email/host id we recognize, we bind (or update)
 * that agent's hrisEmployeeId + write config. Deactivation flips active=false.
 */
function handleWebhook(raw: string, res: ServerResponse): void {
  let evt: {
    type?: string;
    tenantId?: string;
    employee?: {
      hrisEmployeeId?: string;
      hostUserId?: string;
      email?: string;
      departmentId?: string;
      activityTypeId?: string;
      active?: boolean;
    };
  };
  try {
    evt = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: 'invalid json' });
  }
  const tenantId = evt.tenantId ?? 'demo';
  const emp = evt.employee ?? {};
  if (!db.getTenant(tenantId)) return sendJson(res, 404, { error: 'unknown tenant' });

  if (evt.type === 'Employee.Modified' || evt.type === 'Employee.Created') {
    // Match by existing hris id, then host id (email match omitted in demo).
    let agent =
      (emp.hrisEmployeeId && db.agentByHrisEmployeeId(tenantId, emp.hrisEmployeeId)) ||
      (emp.hostUserId && db.agentByHostUserId(tenantId, emp.hostUserId)) ||
      undefined;
    if (!agent) return sendJson(res, 202, { matched: false });
    const updated: Agent = {
      ...agent,
      hrisEmployeeId: emp.hrisEmployeeId ?? agent.hrisEmployeeId,
      hrisDepartmentId: emp.departmentId ?? agent.hrisDepartmentId,
      hrisActivityTypeId: emp.activityTypeId ?? agent.hrisActivityTypeId,
      active: emp.active ?? agent.active,
    };
    db.upsertAgent(updated);
    return sendJson(res, 200, { matched: true, agentId: updated.id, hrisEmployeeId: updated.hrisEmployeeId });
  }
  return sendJson(res, 202, { ignored: evt.type });
}

const HOST = process.env.HOST ?? '0.0.0.0'; // bind all interfaces (containers/orchestrators)
const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error('[unhandled]', e);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
  });
});
server.listen(PORT, HOST, () => {
  console.log(`time-clock api  ->  http://${HOST}:${PORT}  (env=${process.env.NODE_ENV ?? 'development'}, demoAuth=${DEMO}, seeded=${SEED})`);
  console.log(`  agent widget   ->  /embed    supervisor -> /supervisor    health -> /healthz`);
  console.log(`  forecast summary provider: ${providerKind(summaryProvider)}` +
    (providerKind(summaryProvider) === 'template' ? '  (set ANTHROPIC_API_KEY for Claude-generated summaries)' : ''));
});

// Graceful shutdown so orchestrators (Docker/k8s) can stop the container cleanly.
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received — closing server`);
  server.close(() => {
    console.log('[shutdown] closed');
    process.exit(0);
  });
  // Force-exit if connections don't drain in time.
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
