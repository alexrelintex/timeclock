-- =============================================================================
-- TEST 70 · identity map: resolution, JIT provisioning, HRIS mapping
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on

\set acme  '11111111-1111-1111-1111-111111111111'
\set dana  '22222222-2222-2222-2222-000000000001'

begin;

-- 1. Only the API's identity may touch the identity map.
select tctest.act_as(:'acme', :'dana', true);
set local role authenticated;
select tctest.throws($$select tc_api.resolve_identity('acme', 'crm-user-1002')$$,
  '42501', 'a supervisor cannot resolve identities');
select tctest.throws($$select tc_api.upsert_agent('acme', 'crm-user-9999', 'Injected User')$$,
  '42501', 'a supervisor cannot provision agents');
select tctest.throws(
  format($$select tc_api.map_hris_employee(%L, 'stolen-employee-id')$$, :'dana'),
  '42501', 'a supervisor cannot remap HRIS identity');
reset role;

-- 2. Resolution of a seeded agent.
set local role service_role;
select tc_api.resolve_identity('acme', 'crm-user-1002') as id1 \gset
select tctest.eq(:'id1'::jsonb ->> 'agentId', '22222222-2222-2222-2222-000000000002',
  'host user maps to the right agent');
select tctest.eq(:'id1'::jsonb ->> 'role', 'agent', 'role derives from is_supervisor');
select tctest.eq(:'id1'::jsonb ->> 'timezone', 'America/Los_Angeles', 'agent timezone returned');

select tc_api.resolve_identity('acme', 'crm-user-1001') as id2 \gset
select tctest.eq(:'id2'::jsonb ->> 'role', 'supervisor', 'supervisor role derives from the row, not the claim');

-- Unknown user resolves to nothing rather than to a default identity.
select tctest.ok(tc_api.resolve_identity('acme', 'crm-user-nope') is null,
  'unknown host user resolves to null');
select tctest.ok(tc_api.resolve_identity('globex', 'crm-user-1002') is null,
  'a host user id is scoped to its tenant');

-- 3. JIT provisioning on first login.
select tc_api.upsert_agent('acme', 'crm-user-1500', 'Nia Okafor', 'Asia/Manila') as new1 \gset
select tctest.eq(:'new1'::jsonb ->> 'displayName', 'Nia Okafor', 'agent provisioned');
select tctest.eq(:'new1'::jsonb ->> 'timezone', 'Asia/Manila', 'host-supplied timezone honoured');
select tctest.eq(:'new1'::jsonb ->> 'role', 'agent', 'provisioned agents are not supervisors');
select tctest.ok(:'new1'::jsonb ->> 'hrisEmployeeId' is null, 'unmapped until the HRIS sync runs');

-- Idempotent: a second login updates, never duplicates.
select tc_api.upsert_agent('acme', 'crm-user-1500', 'Nia Okafor-Bell') as new2 \gset
select tctest.eq(:'new2'::jsonb ->> 'agentId', :'new1'::jsonb ->> 'agentId', 'same agent row');
select tctest.eq(:'new2'::jsonb ->> 'displayName', 'Nia Okafor-Bell', 'display name refreshed');
select tctest.eq(:'new2'::jsonb ->> 'timezone', 'Asia/Manila',
  'omitting the timezone does not reset it to the tenant default');

select tctest.throws($$select tc_api.upsert_agent('no-such-tenant', 'x', 'y')$$,
  'PT404', 'unknown tenant slug is a 404');
select tctest.throws($$select tc_api.upsert_agent('acme', 'crm-user-1501', 'Bad TZ', 'Mars/Olympus')$$,
  'PT400', 'a bogus IANA zone is rejected, not silently defaulted');

-- 4. HRIS mapping, then the punch path starts syncing.
select :'new1'::jsonb ->> 'agentId' as nia \gset
select tc_api.map_hris_employee(:'nia', 'aaaaaaaa-0000-0000-0000-00000000e900',
  'dddddddd-0000-0000-0000-00000000d001', 'cccccccc-0000-0000-0000-00000000a001') as m \gset
select tctest.eq(:'m'::jsonb ->> 'hrisEmployeeId', 'aaaaaaaa-0000-0000-0000-00000000e900',
  'employee id mapped');
select tctest.throws(
  $$select tc_api.map_hris_employee('00000000-0000-0000-0000-000000000000', 'x')$$,
  'PT404', 'mapping an unknown agent is a 404');
reset role;

select tctest.act_as(:'acme', :'nia');
set local role authenticated;
select tc_api.punch('IN', '00000000-0000-4000-8000-000000000700') as p \gset
reset role;
select tctest.ok((:'p'::jsonb ->> 'enqueuedToHris')::boolean,
  'once mapped, IN/OUT starts flowing to the HRIS');

-- 5. Worker config for the AdapterRegistry.
set local role service_role;
select tc_api.tenant_hris_config(:'acme') as cfg \gset
reset role;
select tctest.eq(:'cfg'::jsonb ->> 'provider', 'paycor', 'provider surfaced');
select tctest.eq((:'cfg'::jsonb -> 'config' ->> 'legalEntityId')::int, 4242, 'legalEntityId surfaced');
select tctest.ok(
  :'cfg'::jsonb -> 'employeeWriteConfig' -> 'aaaaaaaa-0000-0000-0000-00000000e001' ->> 'departmentId'
    is not null,
  'per-employee departmentId/activityTypeId map built for Paycor writes');

rollback;
\echo '  ok 70_identity'
