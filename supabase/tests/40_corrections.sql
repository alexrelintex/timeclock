-- =============================================================================
-- TEST 40 · orphan detection, correction proposal, supervisor decision
-- =============================================================================
-- Scope split under test (design decision, 2026-08-07):
--   IN/OUT orphans   -> corrected in-app AND round-tripped to the HRIS
--   BREAK/LUNCH      -> corrected entirely in-app, nothing leaves
\set ON_ERROR_STOP on
\set QUIET on

\set acme  '11111111-1111-1111-1111-111111111111'
\set dana  '22222222-2222-2222-2222-000000000001'
\set priya '22222222-2222-2222-2222-000000000002'
\set ana   '22222222-2222-2222-2222-000000000004'

begin;

-- ---------------------------------------------------------------- ORPHAN_IN
-- An IN from 15 hours ago with no OUT: past the 14h max_shift threshold.
insert into timeclock.punch_event
  (tenant_id, agent_id, event_type, event_time, source, created_by_id, client_uuid)
values (:'acme', :'priya', 'IN', clock_timestamp() - interval '15 hours',
        'WIDGET', :'priya', '00000000-0000-4000-8000-000000000400');

select tctest.act_as(:'acme', :'priya');
set local role authenticated;
select tc_api.status() as st \gset
reset role;
select tctest.eq(:'st'::jsonb -> 'openOrphan' ->> 'kind', 'ORPHAN_IN', 'ORPHAN_IN surfaced');
select tctest.ok((:'st'::jsonb -> 'openOrphan' ->> 'syncsToHris')::boolean,
  'IN/OUT orphans are flagged as HRIS round-trip');

-- Input validation on the correction form.
select tctest.act_as(:'acme', :'priya');
set local role authenticated;
select tctest.throws(
  $$select tc_api.submit_correction('BREAK_END', 'wrong kind', gen_random_uuid(), null, 60)$$,
  'PT400', 'missing type must match the orphan kind');
select tctest.throws(
  $$select tc_api.submit_correction('OUT', '', gen_random_uuid(), null, 60)$$,
  'PT400', 'attestation is required');
select tctest.throws(
  format($$select tc_api.submit_correction('OUT', %L, gen_random_uuid(), null, 60)$$,
         repeat('x', 301)),
  'PT400', 'attestation capped at 300 chars for HRIS pass-through');
select tctest.throws(
  $$select tc_api.submit_correction('OUT', 'both forms', gen_random_uuid(), now(), 60)$$,
  'PT400', 'exactly one of time or minutes');
select tctest.throws(
  $$select tc_api.submit_correction('OUT', 'neither form', gen_random_uuid(), null, null)$$,
  'PT400', 'exactly one of time or minutes (neither)');
select tctest.throws(
  $$select tc_api.submit_correction('OUT', 'future', gen_random_uuid(),
      clock_timestamp() + interval '1 hour', null)$$,
  'PT400', 'proposed time cannot be in the future');
select tctest.throws(
  $$select tc_api.submit_correction('OUT', 'before opener', gen_random_uuid(),
      clock_timestamp() - interval '16 hours', null)$$,
  'PT400', 'proposed time must be after the unpaired event');

-- Valid proposal, duration form: 8h after the orphaned IN.
select tc_api.submit_correction('OUT', 'Laptop crashed; left at 5pm per team lead.',
       '00000000-0000-4000-8000-000000000401', null, 480) as c \gset
select tctest.ok(:'c'::jsonb ->> 'correctionEventId' is not null, 'correction event created');
select tctest.eq(:'c'::jsonb -> 'pendingCorrection' ->> 'eventType', 'OUT',
  'snapshot advertises the pending correction');

-- One at a time.
select tctest.throws(
  $$select tc_api.submit_correction('OUT', 'again', gen_random_uuid(), null, 480)$$,
  'PT409', 'only one pending correction per agent');
-- An agent cannot approve their own.
select tctest.throws(
  format($$select tc_api.decide_correction(%L, true)$$, :'c'::jsonb ->> 'correctionEventId'),
  'PT403', 'agent cannot decide their own correction');
reset role;

select :'c'::jsonb ->> 'correctionEventId' as corr \gset

-- Nothing has left the app yet: approval gates the HRIS round trip.
select tctest.eq((select count(*)::int from timeclock.hris_outbox where punch_event_id = :'corr'),
  0, 'PENDING_APPROVAL enqueues nothing');
select tctest.eq((select status::text from timeclock.punch_event where id = :'corr'),
  'PENDING_APPROVAL', 'correction parked for approval');
select tctest.ok(
  (select correction_of_id is not null from timeclock.punch_event where id = :'corr'),
  'correction points at the event it corrects');
select tctest.eq((select status::text from timeclock.project_shift(:'priya')),
  'ACTIVE', 'a pending correction does not move the projection');

-- Supervisor sees it in the queue, then approves.
select tctest.act_as(:'acme', :'dana', true);
set local role authenticated;
select tc_api.roster() as r \gset
select tctest.eq(jsonb_array_length(:'r'::jsonb -> 'pendingCorrections'), 1,
  'correction appears in the supervisor queue');
select tctest.ok(
  ((:'r'::jsonb -> 'pendingCorrections' -> 0) ->> 'syncsToHris')::boolean,
  'queue marks it as an HRIS round trip');
select tc_api.decide_correction(:'corr', true, 'Confirmed with team lead.') as d \gset
reset role;

select tctest.ok((:'d'::jsonb ->> 'enqueuedToHris')::boolean, 'approval enqueues the missed punch');
select tctest.eq((select status::text from timeclock.punch_event where id = :'corr'),
  'ACTIVE', 'approved correction becomes ACTIVE');
select tctest.eq(
  (select kind::text from timeclock.hris_outbox where punch_event_id = :'corr'),
  'MISSED_PUNCH_REQUEST', 'canonical missed-punch request enqueued');
select tctest.eq(
  (select payload ->> 'proposedType' from timeclock.hris_outbox where punch_event_id = :'corr'),
  'OUT', 'payload carries the proposed type');
select tctest.eq(
  (select count(*)::int from timeclock.punch_event_mutation where punch_event_id = :'corr'),
  1, 'the approval is journalled');
select tctest.eq((select status::text from timeclock.project_shift(:'priya')),
  'CLOCKED_OUT', 'the shift is closed once the correction lands');

-- Deciding twice is a conflict, not a duplicate push.
select tctest.act_as(:'acme', :'dana', true);
set local role authenticated;
select tctest.throws(format($$select tc_api.decide_correction(%L, true)$$, :'corr'),
  'PT409', 'a decided correction cannot be decided again');
reset role;

-- ------------------------------------------------------------- ORPHAN_BREAK
-- Ana: IN 3h ago, BREAK_START 50 min ago, threshold 30 min.
insert into timeclock.punch_event
  (tenant_id, agent_id, event_type, event_time, source, created_by_id, client_uuid)
values (:'acme', :'ana', 'IN', clock_timestamp() - interval '3 hours',
        'WIDGET', :'ana', '00000000-0000-4000-8000-000000000410'),
       (:'acme', :'ana', 'BREAK_START', clock_timestamp() - interval '50 minutes',
        'WIDGET', :'ana', '00000000-0000-4000-8000-000000000411');

select tctest.act_as(:'acme', :'ana');
set local role authenticated;
select tc_api.status() as st2 \gset
select tctest.eq(:'st2'::jsonb -> 'openOrphan' ->> 'kind', 'ORPHAN_BREAK', 'ORPHAN_BREAK surfaced');
select tctest.ok(not (:'st2'::jsonb -> 'openOrphan' ->> 'syncsToHris')::boolean,
  'break orphans stay internal');
select tc_api.submit_correction('BREAK_END', 'Took the standard 15.',
       '00000000-0000-4000-8000-000000000412', null, 15) as c2 \gset
reset role;
select :'c2'::jsonb ->> 'correctionEventId' as corr2 \gset

select tctest.act_as(:'acme', :'dana', true);
set local role authenticated;
select tc_api.decide_correction(:'corr2', true) as d2 \gset
reset role;
select tctest.ok(not (:'d2'::jsonb ->> 'enqueuedToHris')::boolean,
  'approved break correction enqueues nothing (Paycor has no break punch type)');
select tctest.eq((select status::text from timeclock.project_shift(:'ana')),
  'ACTIVE', 'Ana is back on the clock');
select tctest.eq(
  (select count(*)::int from timeclock.hris_outbox o
     join timeclock.punch_event pe on pe.id = o.punch_event_id
    where pe.agent_id = :'ana'), 0, 'nothing from Ana has left the app');

-- Rejection path: no HRIS traffic, event marked REJECTED, projection untouched.
insert into timeclock.punch_event
  (tenant_id, agent_id, event_type, event_time, source, status, created_by_id, client_uuid, note)
values (:'acme', :'ana', 'BREAK_END', clock_timestamp() - interval '5 minutes',
        'WIDGET', 'PENDING_APPROVAL', :'ana', '00000000-0000-4000-8000-000000000413', 'test reject')
returning id as rej \gset

select tctest.act_as(:'acme', :'dana', true);
set local role authenticated;
select tc_api.decide_correction(:'rej', false, 'Duplicate of the approved one.') as d3 \gset
reset role;
select tctest.ok(not (:'d3'::jsonb ->> 'approved')::boolean, 'decision recorded as rejected');
select tctest.eq((select status::text from timeclock.punch_event where id = :'rej'),
  'REJECTED', 'rejected correction is REJECTED, not deleted');
select tctest.ok(
  (select approved_by_id = :'dana' from timeclock.punch_event where id = :'rej'),
  'the deciding supervisor is recorded even on rejection');

rollback;
\echo '  ok 40_corrections'
