-- =============================================================================
-- TEST 30 · tenant isolation and role scope, including forged claims
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on

\set acme    '11111111-1111-1111-1111-111111111111'
\set globex  '99999999-9999-9999-9999-999999999999'
\set dana    '22222222-2222-2222-2222-000000000001'
\set priya   '22222222-2222-2222-2222-000000000002'
\set sam     '88888888-8888-8888-8888-000000000001'

begin;

-- Give both tenants some history to leak.
select tctest.act_as(:'acme', :'priya');
set local role authenticated;
select tc_api.punch('IN', '00000000-0000-4000-8000-000000000300') as _ \gset
reset role;

select tctest.act_as(:'globex', :'sam');
set local role authenticated;
select tc_api.punch('IN', '00000000-0000-4000-8000-000000000301') as _ \gset
reset role;

-- 1. An agent is not a supervisor.
select tctest.act_as(:'acme', :'priya');
set local role authenticated;
select tctest.throws($$select tc_api.roster()$$, 'PT403', 'agent cannot read the roster');
select tctest.throws($$select tc_api.audit_trail(
    '22222222-2222-2222-2222-000000000003', now() - interval '1 day', now())$$,
  'PT403', 'agent cannot pull another agent audit trail');
select tctest.throws($$select tc_api.punch_for_agent(
    '22222222-2222-2222-2222-000000000003', 'IN', gen_random_uuid(), 'because')$$,
  'PT403', 'agent cannot punch for someone else');
select tctest.throws($$select tc_api.record_exception(
    '22222222-2222-2222-2222-000000000003', current_date, 'LATE_MEAL')$$,
  'PT403', 'agent cannot record an exception against another agent');

-- 2. An agent sees only their own stream. my_ledger is scoped by claims, not by
--    an argument the caller controls — there is no agent_id parameter to tamper with.
select jsonb_array_length((tc_api.my_ledger(7)) -> 'shifts') as n \gset
select tctest.ok(:n >= 1, 'own ledger returns own shifts');
reset role;

-- 3. Supervisor scope stops at the tenant boundary.
select tctest.act_as(:'acme', :'dana', true);
set local role authenticated;
select tc_api.roster() as r \gset
reset role;
select tctest.eq(jsonb_array_length(:'r'::jsonb -> 'agents'), 4, 'acme supervisor sees 4 acme agents');
select tctest.ok(
  not (:'r'::jsonb -> 'agents') @> jsonb_build_array(jsonb_build_object('agentId', :'sam')),
  'globex agent absent from the acme roster');
select tctest.ok(
  (select bool_and((a ->> 'agentId')::uuid in (
     select id from timeclock.agent where tenant_id = :'acme'))
   from jsonb_array_elements(:'r'::jsonb -> 'agents') a),
  'every roster row belongs to the acme tenant');

-- 4. Forged claims: a real acme tenant paired with a foreign agent id resolves to
--    nothing, because the agent row is invisible under the acme predicate.
select tctest.act_as(:'acme', :'sam');
set local role authenticated;
select tctest.throws($$select tc_api.status()$$, '42501', 'acme tenant + globex agent = no identity');
select tctest.throws($$select tc_api.punch('IN', gen_random_uuid())$$,
  'PT404', 'cannot punch as an agent outside the claimed tenant');
reset role;

-- 5. A supervisor of one tenant cannot act on the other tenant's records.
select tctest.act_as(:'globex', :'sam', true);
set local role authenticated;
select tc_api.roster() as gr \gset
reset role;
select tctest.eq(jsonb_array_length(:'gr'::jsonb -> 'agents'), 1, 'globex supervisor sees only globex');

select id as acme_event from timeclock.punch_event
 where tenant_id = :'acme' order by created_at desc limit 1 \gset
select tctest.act_as(:'globex', :'sam', true);
set local role authenticated;
select tctest.throws(
  format($$select tc_api.decide_correction(%L, true)$$, :'acme_event'),
  'PT404', 'cross-tenant correction decision is a 404, not a leak');
select tctest.throws(
  format($$select tc_api.audit_trail(%L, now() - interval '1 day', now())$$, :'priya'),
  'PT404', 'cross-tenant audit trail is a 404');
reset role;

-- 6. Worker RPCs are closed to user identities.
select tctest.act_as(:'acme', :'dana', true);
set local role authenticated;
select tctest.throws(format($$select tc_api.outbox_claim(%L, 'PUNCH', 10)$$, :'acme'),
  '42501', 'supervisor cannot claim outbox rows');
select tctest.throws($$select tc_api.sweep_orphans()$$,
  '42501', 'supervisor cannot run the reconciler sweep');
reset role;

-- 7. service_role is the worker identity and reaches every tenant by design.
set local role service_role;
select tctest.ok(jsonb_array_length(tc_api.outbox_tenants_pending()) >= 1,
  'service_role sees pending work across tenants');
reset role;

rollback;
\echo '  ok 30_rls_isolation'
