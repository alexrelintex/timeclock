-- =============================================================================
-- TEST 60 · tamper-evident hash chain
-- =============================================================================
-- The chain is the evidentiary backstop, not the primary control. It answers the
-- question a records challenge actually asks: can you show this history was not
-- edited after the fact? To test it we must first defeat the primary control, so
-- these tests disable the append-only trigger — something only the table owner can
-- do, and something that shows up in the Postgres audit log.
\set ON_ERROR_STOP on
\set QUIET on

\set acme  '11111111-1111-1111-1111-111111111111'
\set priya '22222222-2222-2222-2222-000000000002'

begin;

select tctest.act_as(:'acme', :'priya');
set local role authenticated;
select tc_api.punch('IN',          '00000000-0000-4000-8000-000000000600') as _ \gset
select tc_api.punch('BREAK_START', '00000000-0000-4000-8000-000000000601') as _ \gset
select tc_api.punch('BREAK_END',   '00000000-0000-4000-8000-000000000602') as _ \gset
select tc_api.punch('OUT',         '00000000-0000-4000-8000-000000000603') as s \gset
reset role;

-- 1. Clean chain, correctly linked.
select tctest.eq((select count(*)::int from timeclock.verify_chain(:'acme', :'priya')),
  0, 'chain verifies clean');
select tctest.ok(
  (select prev_hash is null from timeclock.punch_event
    where client_uuid = '00000000-0000-4000-8000-000000000600'),
  'first event is the genesis link');
select tctest.ok(
  (select bool_and(length(self_hash) = 64) from timeclock.punch_event where agent_id = :'priya'),
  'every link is a 64-hex sha256');
select tctest.eq(
  (select count(distinct self_hash)::int from timeclock.punch_event where agent_id = :'priya'),
  4, 'no two links collide');
select tctest.ok(
  (select b.prev_hash = a.self_hash
     from timeclock.punch_event a, timeclock.punch_event b
    where a.client_uuid = '00000000-0000-4000-8000-000000000600'
      and b.client_uuid = '00000000-0000-4000-8000-000000000601'),
  'link N+1 commits to link N');

-- 2. Silent content edit, with the guard trigger switched off.
alter table timeclock.punch_event disable trigger punch_event_guard_before_update;
update timeclock.punch_event
   set note = 'inserted after the fact'
 where client_uuid = '00000000-0000-4000-8000-000000000601';
alter table timeclock.punch_event enable trigger punch_event_guard_before_update;

select tctest.ok(
  exists (select 1 from timeclock.verify_chain(:'acme', :'priya')
           where problem like '%CONTENT TAMPERED%'),
  'an edited note is detected as content tampering');
select tctest.ok(
  (select count(*) from timeclock.verify_chain(:'acme', :'priya')) >= 1,
  'the break is reported');

rollback;

-- 3. Silent deletion of a middle event breaks the linkage of everything after it.
begin;
select tctest.act_as(:'acme', :'priya');
set local role authenticated;
select tc_api.punch('IN',          '00000000-0000-4000-8000-000000000610') as _ \gset
select tc_api.punch('BREAK_START', '00000000-0000-4000-8000-000000000611') as _ \gset
select tc_api.punch('BREAK_END',   '00000000-0000-4000-8000-000000000612') as _ \gset
reset role;

alter table timeclock.punch_event disable trigger punch_event_guard_before_delete;
delete from timeclock.punch_event where client_uuid = '00000000-0000-4000-8000-000000000611';
alter table timeclock.punch_event enable trigger punch_event_guard_before_delete;

select tctest.ok(
  exists (select 1 from timeclock.verify_chain(:'acme', :'priya')
           where problem like '%prev_hash does not match%'),
  'a removed event leaves a hole the chain reports');

rollback;

-- 4. A legitimate status transition is distinguishable from tampering: the chain
--    flags it, and punch_event_mutation explains it.
begin;
-- An open shift for the correction to close.
insert into timeclock.punch_event
  (tenant_id, agent_id, event_type, event_time, source, created_by_id, client_uuid)
values (:'acme', :'priya', 'IN', clock_timestamp() - interval '2 hours',
        'WIDGET', :'priya', '00000000-0000-4000-8000-00000000061f');

insert into timeclock.punch_event
  (tenant_id, agent_id, event_type, event_time, source, status, created_by_id, client_uuid, note)
values (:'acme', :'priya', 'OUT', clock_timestamp(), 'WIDGET', 'PENDING_APPROVAL',
        :'priya', '00000000-0000-4000-8000-000000000620', 'forgot to clock out')
returning id as pend \gset

select tctest.act_as(:'acme', '22222222-2222-2222-2222-000000000001', true);
set local role authenticated;
select tc_api.decide_correction(:'pend', true, 'ok') as _ \gset
reset role;

select tctest.ok(
  exists (select 1 from timeclock.verify_chain(:'acme', :'priya')
           where punch_event_id = :'pend'
             and problem like '%status transition, see punch_event_mutation%'),
  'an approved correction is reported as a status transition, not tampering');
select tctest.eq(
  (select count(*)::int from timeclock.punch_event_mutation where punch_event_id = :'pend'),
  1, 'and the journal has the receipt');

rollback;
\echo '  ok 60_hash_chain'
