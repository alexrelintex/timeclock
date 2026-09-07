-- =============================================================================
-- TEST 20 · append-only enforcement at the privilege, trigger and journal layers
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on

\set tenant '11111111-1111-1111-1111-111111111111'
\set priya  '22222222-2222-2222-2222-000000000002'

begin;
select tctest.act_as(:'tenant', :'priya');
set local role authenticated;
select tc_api.punch('IN', '00000000-0000-4000-8000-000000000100') as s \gset
select :'s'::jsonb ->> 'eventId' as evid \gset

-- 1. The private schema is unreachable from the widget's role. The RPC surface is
--    the only door.
select tctest.throws($$select count(*) from timeclock.punch_event$$,
  '42501', 'authenticated cannot read timeclock.punch_event') as _ \gset
select tctest.throws($$insert into timeclock.punch_event
    (tenant_id, agent_id, event_type, event_time, source, created_by_id, client_uuid)
   values ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-000000000002',
           'IN', now(), 'WIDGET', '22222222-2222-2222-2222-000000000002', gen_random_uuid())$$,
  '42501', 'authenticated cannot insert directly');
select tctest.throws($$select count(*) from timeclock.tenant$$,
  '42501', 'authenticated cannot read timeclock.tenant');
reset role;

-- 2. Not even the drain worker may rewrite history.
set local role service_role;
select tctest.throws(
  format($$update timeclock.punch_event set status = 'SUPERSEDED' where id = %L$$, :'evid'),
  '42501', 'service_role cannot UPDATE punch_event');
select tctest.throws(
  format($$delete from timeclock.punch_event where id = %L$$, :'evid'),
  '42501', 'service_role cannot DELETE punch_event');
select tctest.throws($$truncate timeclock.punch_event$$,
  '42501', 'service_role cannot TRUNCATE punch_event');
select tctest.ok((select count(*) from timeclock.punch_event) >= 1,
  'service_role retains read access for exports');
reset role;

-- 3a. As tc_owner (the identity the RPCs run under) there is no DELETE policy at
--     all, so FORCE RLS silently matches nothing. Zero rows, row intact — the
--     trigger is never even reached.
set local role tc_owner;
delete from timeclock.punch_event where id = :'evid';
reset role;
select tctest.eq((select count(*)::int from timeclock.punch_event where id = :'evid'),
  1, 'RLS gives tc_owner no DELETE path (0 rows affected, row intact)');

-- 3b. As an admin role that DOES bypass RLS (postgres / service_role class), the
--     statement reaches the table and the trigger is the thing that stops it.
select tctest.throws(
  format($$delete from timeclock.punch_event where id = %L$$, :'evid'),
  '23001', 'DELETE denied by trigger for a BYPASSRLS admin');
select tctest.throws(
  format($$update timeclock.punch_event set note = 'edited' where id = %L$$, :'evid'),
  '23001', 'note is frozen');
select tctest.throws(
  format($$update timeclock.punch_event set event_time = now() - interval '2 hours' where id = %L$$, :'evid'),
  '23001', 'event_time is frozen');
select tctest.throws(
  format($$update timeclock.punch_event set event_type = 'OUT' where id = %L$$, :'evid'),
  '23001', 'event_type is frozen');
select tctest.throws(
  format($$update timeclock.punch_event set self_hash = 'deadbeef' where id = %L$$, :'evid'),
  '23001', 'self_hash is frozen');
select tctest.throws(
  format($$update timeclock.punch_event set agent_id = '22222222-2222-2222-2222-000000000003' where id = %L$$, :'evid'),
  '23001', 'agent_id is frozen');
select tctest.throws(
  format($$update timeclock.punch_event set status = 'PENDING_APPROVAL' where id = %L$$, :'evid'),
  '23001', 'ACTIVE -> PENDING_APPROVAL is not a legal transition');

-- 4. The one permitted mutation, and its journal entry.
set local role tc_owner;
select tctest.act_as(:'tenant', '22222222-2222-2222-2222-000000000001', true);  -- supervisor claims
update timeclock.punch_event set status = 'SUPERSEDED' where id = :'evid';
reset role;

select tctest.eq((select status::text from timeclock.punch_event where id = :'evid'),
  'SUPERSEDED', 'ACTIVE -> SUPERSEDED permitted');
select tctest.eq(
  (select count(*)::int from timeclock.punch_event_mutation where punch_event_id = :'evid'),
  1, 'the transition is journalled');
select tctest.eq(
  (select from_status::text || '->' || to_status::text
     from timeclock.punch_event_mutation where punch_event_id = :'evid'),
  'ACTIVE->SUPERSEDED', 'journal records the direction');
select tctest.eq(
  (select db_role from timeclock.punch_event_mutation where punch_event_id = :'evid'),
  'tc_owner', 'journal records the acting database role');
select tctest.ok(
  (select jwt_claims -> 'tc' ->> 'role' = 'supervisor'
     from timeclock.punch_event_mutation where punch_event_id = :'evid'),
  'journal captures the JWT claims of the actor');

-- 5. The journal itself is append-only, checked from the BYPASSRLS admin role so
--    the statement actually reaches the trigger.
select tctest.throws($$update timeclock.punch_event_mutation set to_status = 'ACTIVE'$$,
  '23001', 'journal rows cannot be updated');
select tctest.throws($$delete from timeclock.punch_event_mutation$$,
  '23001', 'journal rows cannot be deleted');

-- 6. A superseded event leaves the open stream, so the projection ignores it.
select tctest.eq((select status::text from timeclock.project_shift(:'priya')),
  'CLOCKED_OUT', 'superseded IN no longer projects as ACTIVE');

rollback;
\echo '  ok 20_append_only'
