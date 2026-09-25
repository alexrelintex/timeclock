/**
 * Paycor token provider: it must call Paycor's AuthenticationSupport endpoint as
 * JSON with the subscription-key header, cache the access token, and PERSIST the
 * rotated (single-use) refresh token — the bug that would break the connector on
 * the second exchange if the rotation weren't written back.
 */
import { finish } from './assert';
import { PaycorTokenProvider } from '../apps/api/src/hris/tokenProvider';

type AnyFetch = typeof fetch;
function res(status: number, json: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  } as unknown as Response;
}

async function main(): Promise<void> {
  // 1. snake_case response: correct request shape + rotation persisted.
  {
    let captured: { url: string; init: RequestInit } | null = null;
    let rotated: string | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return res(200, { access_token: 'at1', refresh_token: 'rt2', expires_in: 3600 });
    }) as unknown as AnyFetch;
    const p = new PaycorTokenProvider(
      { tokenUrl: 'https://apis.paycor.com/v1/authenticationsupport/retrieveAccessTokenWithRefreshToken', clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt1', subscriptionKey: 'subkey' },
      (r) => { rotated = r; },
      fetchImpl,
    );
    const at = await p.getAccessToken();
    const h = (captured!.init.headers ?? {}) as Record<string, string>;
    const body = JSON.parse(captured!.init.body as string);
    console.assert(at === 'at1', 'returns the access token');
    console.assert(captured!.url.endsWith('/retrieveAccessTokenWithRefreshToken'), 'POSTs to the AuthenticationSupport endpoint');
    console.assert(captured!.init.method === 'POST', 'uses POST');
    console.assert(h['Ocp-Apim-Subscription-Key'] === 'subkey', 'sends the Ocp-Apim-Subscription-Key header');
    console.assert(h['Content-Type'] === 'application/json', 'sends JSON');
    console.assert(body.client_id === 'cid' && body.client_secret === 'sec' && body.refresh_token === 'rt1', 'JSON body carries snake_case client_id/client_secret/refresh_token');
    console.assert(rotated === 'rt2', 'persists the rotated refresh token via onRotate');
    console.assert(p.currentRefreshToken() === 'rt2', 'in-memory refresh token advanced to the rotated value');
  }

  // 2. the access token is cached (a second call within TTL makes no network call).
  {
    let calls = 0;
    const fetchImpl = (async () => { calls += 1; return res(200, { access_token: 'atC', refresh_token: 'rtC', expires_in: 3600 }); }) as unknown as AnyFetch;
    const p = new PaycorTokenProvider({ tokenUrl: 'u', clientId: 'c', clientSecret: 's', refreshToken: 'r', subscriptionKey: 'k' }, () => {}, fetchImpl);
    await p.getAccessToken();
    await p.getAccessToken();
    console.assert(calls === 1, 'caches the access token (one exchange for two reads)');
  }

  // 3. camelCase response is parsed too (schema-tolerant).
  {
    let rotated: string | null = null;
    const fetchImpl = (async () => res(200, { accessToken: 'atX', refreshToken: 'rtX', expiresIn: 1200 })) as unknown as AnyFetch;
    const p = new PaycorTokenProvider({ tokenUrl: 'u', clientId: 'c', clientSecret: 's', refreshToken: 'r0', subscriptionKey: 'k' }, (r) => { rotated = r; }, fetchImpl);
    const at = await p.getAccessToken();
    console.assert(at === 'atX', 'parses camelCase accessToken');
    console.assert(rotated === 'rtX', 'parses + persists camelCase refreshToken');
  }

  // 4. an HTTP error surfaces (does not cache a bad state).
  {
    const fetchImpl = (async () => res(401, { message: 'unauthorized' })) as unknown as AnyFetch;
    const p = new PaycorTokenProvider({ tokenUrl: 'u', clientId: 'c', clientSecret: 's', refreshToken: 'r', subscriptionKey: 'k' }, () => {}, fetchImpl);
    let threw = false;
    try { await p.getAccessToken(); } catch { threw = true; }
    console.assert(threw, 'throws on a non-2xx token response');
  }

  console.log('paycor: all assertions passed');
  finish('paycor');
}

main().catch((e) => { console.error(e); process.exit(1); });

// -- listEmployees: employment status → active flag (terminated employees) --
import { PaycorAdapter } from '../packages/hris/src/paycor/adapter';

async function statusMain(): Promise<void> {
  const tokens = { getAccessToken: async () => 'at', invalidate() {} };
  const page = {
    records: [
      { employeeId: 'e-active', firstName: 'Ann', lastName: 'Active', statusData: { status: 'Active', flsa: 'SalaryExempt' }, email: { type: 'Work', emailAddress: 'ann@co.com' }, department: { id: 'dept-1' }, workLocation: { state: 'tx' }, positionData: { jobTitle: 'Engineer', manager: { id: 'mgr-9' } } },
      { employeeId: 'e-term', firstName: 'Ted', lastName: 'Term', statusData: { status: 'Terminated' } },
      { employeeId: 'e-resigned', firstName: 'Rae', lastName: 'Quit', statusData: { status: 'Resigned' } },
      { employeeId: 'e-datedterm', firstName: 'Dan', lastName: 'Dated', statusData: { status: 'Active' }, employmentDateData: { terminationDate: '2025-01-01T00:00:00Z' } },
      { employeeId: 'e-unknown', firstName: 'Uma', lastName: 'Unknown' },
    ],
  };
  let calledUrl = '';
  const fetchImpl = (async (u: string) => {
    calledUrl = u;
    if (/\/departments/.test(u)) return res(200, { records: [{ id: 'dept-1', description: 'Engineering' }] });
    return res(200, page);
  }) as unknown as AnyFetch;
  const a = new PaycorAdapter(
    { legalEntityId: 1, subscriptionKey: 'k', employeeWriteConfig: {} },
    tokens,
    fetchImpl,
  );
  const { items } = await a.listEmployees();
  console.assert(/include=Status/.test(calledUrl) && /include=EmploymentDates/.test(calledUrl), 'requests include=Status&include=EmploymentDates (else Paycor returns null status)');
  console.assert(/include=WorkLocation/.test(calledUrl) && /include=Position/.test(calledUrl), 'requests include=WorkLocation&include=Position (dept-state/title/manager)');
  const ann = items.find((i) => i.hrisEmployeeId === 'e-active');
  console.assert(ann?.firstName === 'Ann' && ann?.lastName === 'Active' && ann?.displayName === 'Ann Active', `first/last name ride along with the display name (got ${JSON.stringify(ann)})`);
  const by = Object.fromEntries(items.map((i) => [i.hrisEmployeeId, i]));
  console.assert(by['e-active'].active === true, 'Active → active');
  console.assert(by['e-term'].active === false, 'Terminated → inactive');
  console.assert(by['e-resigned'].active === false, 'Resigned → inactive');
  console.assert(by['e-datedterm'].active === false, 'termination date overrides Active → inactive');
  console.assert(by['e-unknown'].active === undefined, 'no status → undefined (unknown)');
  console.assert(by['e-term'].status === 'Terminated', 'raw status is surfaced');
  console.assert(by['e-active'].email === 'ann@co.com', 'extracts nested email.emailAddress (CRM link key)');
  console.assert(by['e-active'].department === 'Engineering', 'resolves department id → name');
  console.assert(by['e-active'].departmentId === 'dept-1', 'exposes the raw department GUID (punch writes)');
  console.assert(by['e-active'].locationState === 'TX', 'maps workLocation.state (upper-cased)');
  console.assert(by['e-active'].title === 'Engineer', 'maps positionData.jobTitle');
  console.assert(by['e-active'].flsa === 'SalaryExempt', 'maps statusData.flsa');
  console.log('paycor status: all assertions passed');
  finish('paycor-status');
}

statusMain().catch((e) => { console.error(e); process.exit(1); });

// -- pushPunches: write fields resolved from the punch + tenant default activity type --
async function writeMain(): Promise<void> {
  const tokens = { getAccessToken: async () => 'at', invalidate() {} };
  let posted: { url: string; body: unknown } | null = null;
  const fetchImpl = (async (u: string, init: RequestInit) => {
    posted = { url: u, body: JSON.parse(init.body as string) };
    return res(200, { trackingId: 'trk-1' });
  }) as unknown as AnyFetch;
  const a = new PaycorAdapter(
    { legalEntityId: 199759, subscriptionKey: 'k', employeeWriteConfig: {}, defaultActivityTypeId: 'act-default' },
    tokens,
    fetchImpl,
  );
  const punch = {
    punchEventId: 'ev-1', agentId: 'ag-1', hrisEmployeeId: 'emp-1', type: 'IN' as const,
    timeUtc: new Date('2026-09-25T16:00:00Z'), agentTimezone: 'America/Los_Angeles', departmentId: 'dept-9',
  };
  const out = await a.pushPunches([punch]);
  const row = (posted!.body as Record<string, unknown>[])[0];
  console.assert(/\/v1\/legalentities\/199759\/CreatePunches$/.test(posted!.url), 'POSTs to CreatePunches for the legal entity');
  console.assert(row.departmentId === 'dept-9', 'uses the departmentId stamped on the punch');
  console.assert(row.activityTypeId === 'act-default', 'falls back to the tenant default activity type');
  console.assert(row.punchStatusType === 'In' && row.punchDateTime === '2026-09-25T09:00:00', 'In punch, employee-local time (PDT)');
  console.assert(out.kind === 'SUBMITTED', 'returns SUBMITTED with the tracking id');

  // Missing both → FAILED (visible in the outbox), never a throw that wedges the drain.
  const b = new PaycorAdapter({ legalEntityId: 1, subscriptionKey: 'k', employeeWriteConfig: {} }, tokens, fetchImpl);
  let threw = false;
  let failed = null as { kind: string; retryable?: boolean } | null;
  try { failed = (await b.pushPunches([{ ...punch, departmentId: undefined }])) as { kind: string; retryable?: boolean }; } catch { threw = true; }
  console.assert(!threw && failed?.kind === 'FAILED' && failed.retryable === false, 'missing write config → FAILED, not thrown');
  console.log('paycor write: all assertions passed');
  finish('paycor-write');
}

writeMain().catch((e) => { console.error(e); process.exit(1); });

// -- resolveSubmission: only a real success may count as resolved --
async function resolveMain(): Promise<void> {
  let invalidated = 0;
  const tokens = { getAccessToken: async () => 'at', invalidate() { invalidated += 1; } };
  const mk = (status: number, json: unknown) =>
    new PaycorAdapter({ legalEntityId: 199758, subscriptionKey: 'k', employeeWriteConfig: {} }, tokens,
      (async () => res(status, json)) as unknown as AnyFetch);
  const warn = console.warn; console.warn = () => {}; // expected warnings, keep output clean
  try {
    const r404 = await mk(404, {}).resolveSubmission('t1');
    console.assert(r404.resolved === false, '404 → still processing');
    const r403 = await mk(403, { Title: 'Forbidden' }).resolveSubmission('t2');
    console.assert(r403.resolved === false && r403.perRecordErrors.length === 0, '403 (missing grant) → NOT resolved (was a false success)');
    const r500 = await mk(500, {}).resolveSubmission('t3');
    console.assert(r500.resolved === false, '500 → NOT resolved');
    const r401 = await mk(401, {}).resolveSubmission('t4');
    console.assert(r401.resolved === false && invalidated === 1, '401 → NOT resolved, token invalidated');
    const ok = await mk(200, { records: [] }).resolveSubmission('t5');
    console.assert(ok.resolved === true && ok.perRecordErrors.length === 0, '200 empty → resolved, no errors');
    const bad = await mk(200, { records: [{ employeeId: 'e1', message: 'Invalid activity type' }] }).resolveSubmission('t6');
    console.assert(bad.resolved === true && bad.perRecordErrors[0]?.message === 'Invalid activity type', '200 with records → resolved with per-record errors');
  } finally { console.warn = warn; }
  console.log('paycor resolve: all assertions passed');
  finish('paycor-resolve');
}

resolveMain().catch((e) => { console.error(e); process.exit(1); });
