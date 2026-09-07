-- =============================================================================
-- TEST 10 · state machine, idempotency, server clock, HRIS scope
-- =============================================================================
-- Runs the way production does: role `authenticated`, identity in
-- request.jwt.claims, every write through tc_api. Assertions run after RESET ROLE
-- so they can read the private tables directly.
\set ON_ERROR_STOP on
\set QUIET on

\set tenant '11111111-1111-1111-1111-111111111111'
\set priya  '22222222-2222-2222-2222-000000000002'
\set marco  '22222222-2222-2222-2222-000000000003'

begin;
select tctest.act_as(:'tenant', :'priya');
set local role authenticated;

-- 1. CLOCKED_OUT accepts nothing but IN.
select tctest.throws(
  $$select tc_api.punch('OUT', '00000000-0000-4000-8000-000000000001')$$,
  'PT409', 'OUT while CLOCKED_OUT');
select tctest.throws(
  $$select tc_api.punch('BREAK_START', '00000000-0000-4000-8000-000000000002')$$,
  'PT409', 'BREAK_START while CLOCKED_OUT');
select tctest.throws(
  $$select tc_api.punch('LUNCH_START', '00000000-0000-4000-8000-000000000003')$$,
  'PT409', 'LUNCH_START while CLOCKED_OUT');

-- 2. IN -> ACTIVE, and a mapped agent enqueues exactly one HRIS punch.
select tc_api.punch('IN', '00000000-0000-4000-8000-000000000010') as snap \gset
select tctest.eq(:'snap'::jsonb ->> 'status', 'ACTIVE', 'status after IN') as _ \gset
select tctest.ok((:'snap'::jsonb ->> 'enqueuedToHris')::boolean, 'mapped agent enqueues');
select tctest.ok(not (:'snap'::jsonb ->> 'idempotentReplay')::boolean, 'first call is not a replay');
select tctest.ok(:'snap'::jsonb ->> 'shiftStartUtc' is not null, 'shiftStartUtc present');
select tctest.eq((:'snap'::jsonb ->> 'breaksTaken')::int, 0, 'no breaks yet');

-- 3. Same client_uuid = retry, not a second punch.
select tc_api.punch('IN', '00000000-0000-4000-8000-000000000010') as snap2 \gset
select tctest.ok((:'snap2'::jsonb ->> 'idempotentReplay')::boolean, 'replay flagged') as _ \gset
select tctest.eq(:'snap2'::jsonb ->> 'status', 'ACTIVE', 'replay does not advance state');

-- 4. Reusing a client_uuid for a different type is a client bug -> 409.
select tctest.throws(
  $$select tc_api.punch('OUT', '00000000-0000-4000-8000-000000000010')$$,
  'PT409', 'client_uuid reuse across event types');

-- 5. The guard that matters most: no OUT while ON_BREAK.
select tc_api.punch('BREAK_START', '00000000-0000-4000-8000-000000000011') as _ \gset
select tctest.throws(
  $$select tc_api.punch('OUT', '00000000-0000-4000-8000-000000000012')$$,
  'PT409', 'OUT while ON_BREAK');
select tctest.throws(
  $$select tc_api.punch('LUNCH_START', '00000000-0000-4000-8000-00000000001a')$$,
  'PT409', 'LUNCH_START while ON_BREAK');
select tc_api.punch('BREAK_END', '00000000-0000-4000-8000-000000000013') as b \gset
select tctest.eq(:'b'::jsonb ->> 'status', 'ACTIVE', 'BREAK_END returns to ACTIVE') as _ \gset
select tctest.eq((:'b'::jsonb ->> 'breaksTaken')::int, 1, 'break counted');

-- 6. Lunch round trip, then close the shift.
select tc_api.punch('LUNCH_START', '00000000-0000-4000-8000-000000000014') as l1 \gset
select tctest.eq(:'l1'::jsonb ->> 'status', 'ON_LUNCH', 'ON_LUNCH') as _ \gset
select tctest.ok(:'l1'::jsonb ->> 'lunchStartUtc' is not null, 'lunchStartUtc captured');
select tc_api.punch('LUNCH_END', '00000000-0000-4000-8000-000000000015') as l2 \gset
select tctest.ok(:'l2'::jsonb ->> 'lunchEndUtc' is not null, 'lunchEndUtc captured') as _ \gset
select tc_api.punch('OUT', '00000000-0000-4000-8000-000000000016') as fin \gset
select tctest.eq(:'fin'::jsonb ->> 'status', 'CLOCKED_OUT', 'status after OUT') as _ \gset
select tctest.eq((:'fin'::jsonb ->> 'workedMs')::bigint, 0::bigint, 'worked resets on close');

-- 7. Bad input is a 400, not a 500.
select tctest.throws(
  $$select tc_api.punch('LUNCH_MAYBE', '00000000-0000-4000-8000-000000000017')$$,
  'PT400', 'unknown event type');
select tctest.throws(
  $$select tc_api.punch('IN', null)$$,
  'PT400', 'missing client_uuid');

-- 8. Fail closed with no identity.
select set_config('request.jwt.claims', '{}', true);
select tctest.throws(
  $$select tc_api.punch('IN', '00000000-0000-4000-8000-000000000018')$$,
  '42501', 'no claims -> insufficient_privilege');
select tctest.throws($$select tc_api.status()$$, '42501', 'status needs claims');

reset role;

-- Persisted-stream assertions.
select tctest.eq(
  (select count(*)::int from timeclock.punch_event
    where agent_id = :'priya'), 6, 'six events persisted');
select tctest.eq(
  (select count(*)::int from timeclock.hris_outbox o
     join timeclock.punch_event pe on pe.id = o.punch_event_id
    where pe.agent_id = :'priya'), 2, 'exactly two outbox rows (IN, OUT)');
select tctest.eq(
  (select count(*)::int from timeclock.hris_outbox o
     join timeclock.punch_event pe on pe.id = o.punch_event_id
    where pe.event_type in ('BREAK_START','BREAK_END','LUNCH_START','LUNCH_END')),
  0, 'break/lunch never leave the app');
select tctest.ok(
  not exists (select 1 from timeclock.punch_event
              where event_time > clock_timestamp() + interval '1 second'),
  'no event stamped in the future (server clock only)');
select tctest.ok(
  (select bool_and(self_hash is not null and length(self_hash) = 64)
     from timeclock.punch_event where agent_id = :'priya'),
  'every event carries a sha256 chain link');
select tctest.eq(
  (select count(*)::int from timeclock.verify_chain(:'tenant', :'priya')),
  0, 'hash chain verifies clean');

-- 9. An unmapped agent (no hris_employee_id) enqueues nothing.
select tctest.act_as(:'tenant', :'marco');
set local role authenticated;
select tc_api.punch('IN', '00000000-0000-4000-8000-000000000020') as m \gset
reset role;
select tctest.ok(not (:'m'::jsonb ->> 'enqueuedToHris')::boolean, 'unmapped agent does not enqueue');
select tctest.eq(
  (select count(*)::int from timeclock.hris_outbox o
     join timeclock.punch_event pe on pe.id = o.punch_event_id
    where pe.agent_id = :'marco'), 0, 'unmapped agent has no outbox rows');

rollback;
\echo '  ok 10_state_machine'
