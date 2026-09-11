// HTTP contract test: the service as a host integrates with it.
//
// Spawns the real server (demo seed, dev auth) on a free port and drives it
// over HTTP, so what is asserted is what a host CRM would actually receive:
//   - /healthz reports the build version
//   - an employee created with an email is identified by that email (lower-cased),
//     a host-minted token with sub=<email> resolves them, case does not matter,
//     and a second employee with the same email is refused
//   - history rows carry id, agentId and hostUserId so a host can dedupe a mirror
//   - a token whose sub is the email connects a CRM user to an agent that only
//     carries the email (seeded or synced) and binds the host id to them once
//   - a pull from the (mock) HRIS keys the imported employees on their email and
//     binds to an agent already here under that email instead of duplicating them
//
// Runs with `npm run test:api`; CI runs it after the domain suites.

import { finish } from './assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mintIdentityToken } from '../apps/api/src/identity';

const require = createRequire(import.meta.url);
const ROOT = resolve(import.meta.dirname ?? '.', '..');
const PKG = require(resolve(ROOT, 'package.json')) as { version: string };
// The secret the spawned instance verifies with; the test mints as a host backend would.
const IDENTITY_SECRET = 'api-test-identity-secret';

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
    s.on('error', fail);
  });
}

async function waitFor(url: string, ms: number): Promise<void> {
  const until = Date.now() + ms;
  let last: unknown;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
      last = r.status;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not come up: ${String(last)}`);
}

async function main(): Promise<void> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  // The tsx bin the repo already runs the service with (`npm start`).
  const child: ChildProcess = spawn(resolve(ROOT, 'node_modules/.bin/tsx'), ['apps/api/src/server.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'development', SEED_DEMO: 'true', ANTHROPIC_API_KEY: '', TIMECLOCK_IDENTITY_SECRET: IDENTITY_SECRET },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout?.on('data', (d) => { log += String(d); });
  child.stderr?.on('data', (d) => { log += String(d); });

  const admin = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}${path.includes('?') ? '&' : '?'}user=u-sam`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const asToken = (token: string, path: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });

  try {
    await waitFor(`${base}/healthz`, 20_000);

    // 1. /healthz names the build.
    const health = await (await fetch(`${base}/healthz`)).json() as { ok: boolean; tenants: number; version: string; name: string };
    console.assert(health.ok === true, 'healthz ok');
    console.assert(health.version === PKG.version, `healthz version ${health.version} is the package version ${PKG.version}`);
    console.assert(health.name === 'timeclock', 'healthz names the service');

    // 1b. The OpenAPI integration contract is served, public, and well-formed.
    const specRes = await fetch(`${base}/openapi.json`);
    console.assert(specRes.status === 200 && (specRes.headers.get('content-type') ?? '').includes('application/json'), `GET /openapi.json → 200 JSON (got ${specRes.status})`);
    const spec = await specRes.json() as { openapi?: string; info?: { version?: string }; paths?: Record<string, unknown> };
    console.assert(spec.openapi === '3.1.0', `openapi is 3.1.0 (got ${spec.openapi})`);
    console.assert(spec.info?.version === PKG.version, 'spec version tracks the package version');
    const specPaths = Object.keys(spec.paths ?? {});
    console.assert(specPaths.includes('/api/punch') && specPaths.includes('/webhooks/hris') && specPaths.includes('/api/me'), 'spec documents the core integration paths');
    console.assert((await fetch(`${base}/docs`)).status === 200, 'GET /docs → 200 (reference UI)');

    // 2. Email is the host identity.
    const created = await admin('/api/supervisor/employees', {
      method: 'POST',
      body: JSON.stringify({ displayName: 'Casey Hostmapped', department: 'Support', email: 'Casey.Hostmapped@Acme.Example' }),
    });
    console.assert(created.status === 200, `create with email → 200 (got ${created.status})`);
    const createdBody = await created.json() as { agentId: string; hostUserId: string; email: string | null };
    console.assert(createdBody.hostUserId === 'casey.hostmapped@acme.example', `hostUserId is the lower-cased email (got ${createdBody.hostUserId})`);
    console.assert(createdBody.email === 'casey.hostmapped@acme.example', 'email is stored lower-cased');

    const dup = await admin('/api/supervisor/employees', {
      method: 'POST',
      body: JSON.stringify({ displayName: 'Casey Twice', department: 'Support', email: 'casey.hostmapped@acme.example' }),
    });
    console.assert(dup.status === 409, `duplicate email → 409 (got ${dup.status})`);
    console.assert(((await dup.json()) as { code: string }).code === 'EMAIL_IN_USE', 'duplicate email names its code');

    const bad = await admin('/api/supervisor/employees', {
      method: 'POST',
      body: JSON.stringify({ displayName: 'Bad Mail', department: 'Support', email: 'not-an-address' }),
    });
    console.assert(bad.status === 400, `malformed email → 400 (got ${bad.status})`);

    const noEmail = await admin('/api/supervisor/employees', {
      method: 'POST',
      body: JSON.stringify({ displayName: 'Slug Person', department: 'Support' }),
    });
    const noEmailBody = await noEmail.json() as { hostUserId: string; email: string | null };
    console.assert(noEmailBody.hostUserId.startsWith('u-slug-person'), `without an email the id is still a slug (got ${noEmailBody.hostUserId})`);
    console.assert(noEmailBody.email === null, 'no email stored when none given');

    // 3. A host-minted token whose sub is the email resolves the person, whatever the case.
    const minted = await (await fetch(`${base}/api/dev/token?user=${encodeURIComponent('CASEY.HOSTMAPPED@acme.example')}`)).json() as { token?: string; error?: string };
    console.assert(typeof minted.token === 'string', `token minted for the email regardless of case (${minted.error ?? 'ok'})`);
    const me = await asToken(minted.token ?? '', '/api/me');
    console.assert(me.status === 200, `token with sub=<email> resolves the agent (got ${me.status})`);

    // 4. History rows carry ids and the host identity.
    const punched = await fetch(`${base}/api/punch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${minted.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'IN' }),
    });
    console.assert(punched.status === 200, `punch IN as the email-identified agent (got ${punched.status})`);
    const history = await (await asToken(minted.token ?? '', '/api/history')).json() as { events: Array<{ id: string; agentId: string; hostUserId: string; eventType: string }> };
    console.assert(history.events.length === 1, `one punch in today's history (got ${history.events.length})`);
    const row = history.events[0];
    console.assert(typeof row?.id === 'string' && row.id.length > 0, 'history row carries the event id');
    console.assert(row?.agentId === createdBody.agentId, 'history row carries the agent id');
    console.assert(row?.hostUserId === 'casey.hostmapped@acme.example', 'history row carries the host identity');
    const supHistory = await (await admin('/api/supervisor/history')).json() as { events: Array<{ id: string; hostUserId: string | null }> };
    console.assert(supHistory.events.some((e) => e.id === row?.id), 'the supervisor sees the same row by id');

    // 5. Editing the email moves the identity; the old token no longer resolves.
    const edited = await admin(`/api/supervisor/employees/${createdBody.agentId}`, {
      method: 'POST',
      body: JSON.stringify({ email: 'casey.h@acme.example' }),
    });
    console.assert(edited.status === 200, `edit email → 200 (got ${edited.status})`);
    const roster = await (await admin('/api/supervisor/employees')).json() as { employees: Array<{ agentId: string; hostUserId: string; email: string | null }> };
    const casey = roster.employees.find((e) => e.agentId === createdBody.agentId);
    console.assert(casey?.hostUserId === 'casey.h@acme.example' && casey?.email === 'casey.h@acme.example', 'identity moved to the new email');
    const stale = await asToken(minted.token ?? '', '/api/me');
    console.assert(stale.status === 403, `a token for the old email no longer maps (got ${stale.status})`);

    // 6. The CRM contract: sub is the email, and the email rides as a claim too.
    //    Lena is seeded with an email and no host id (created in-app, never logged
    //    in from the CRM). Her first CRM token connects her and binds the host id.
    const LENA = 'lena.fischer@acme.example';
    const rosterBefore = await (await admin('/api/supervisor/employees')).json() as { employees: Array<{ hostUserId: string; email: string | null }> };
    console.assert(rosterBefore.employees.some((e) => e.email === LENA && e.hostUserId === ''), 'seed has an agent with an email and no host id');
    const crmToken = (sub: string) => mintIdentityToken({ tenantId: 'demo', hostUserId: sub, email: sub, displayName: 'Lena Fischer' }, IDENTITY_SECRET);
    const firstLogin = await asToken(crmToken(LENA), '/api/me');
    console.assert(firstLogin.status === 200, `first CRM token connects the email-only agent (got ${firstLogin.status})`);
    const rosterAfter = await (await admin('/api/supervisor/employees')).json() as { employees: Array<{ hostUserId: string; email: string | null }> };
    console.assert(rosterAfter.employees.filter((e) => e.email === LENA).length === 1, 'connecting did not create a second Lena');
    console.assert(rosterAfter.employees.some((e) => e.email === LENA && e.hostUserId === LENA), 'the host id bound to her is the email');
    console.assert((await asToken(crmToken(LENA.toUpperCase()), '/api/me')).status === 200, 'later logins resolve by id whatever the case');
    console.assert((await asToken(crmToken('nobody@acme.example'), '/api/me')).status === 403, 'an unknown email is not auto-provisioned');

    // 7. A pull from the HRIS keys the imported people on their HRIS email, and
    //    binds the HRIS id to anyone already here under that email (Lena again).
    const pulled = await admin('/api/supervisor/employees/pull-hris', { method: 'POST', body: JSON.stringify({ department: 'Support' }) });
    console.assert(pulled.status === 200, `pull-hris → 200 (got ${pulled.status})`);
    const pulledBody = await pulled.json() as { created: number; linked: number; imported: Array<{ hostUserId: string; hrisEmployeeId: string; linked?: boolean }> };
    console.assert(pulledBody.created > 0, 'the mock roster imported somebody');
    console.assert(pulledBody.imported.every((i) => i.hostUserId.includes('@')), `imported employees are keyed on email (${pulledBody.imported.map((i) => i.hostUserId).join(', ')})`);
    const lenaPull = pulledBody.imported.find((i) => i.hostUserId === LENA);
    console.assert(pulledBody.linked >= 1 && lenaPull?.linked === true, 'the roster entry matching an existing email was bound, not imported again');
    const rosterFinal = await (await admin('/api/supervisor/employees')).json() as { employees: Array<{ email: string | null }> };
    console.assert(rosterFinal.employees.filter((e) => e.email === LENA).length === 1, 'still exactly one Lena after the pull');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    if (process.exitCode && process.exitCode !== 0) console.error(log.slice(-2000));
  }
  finish('api');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
