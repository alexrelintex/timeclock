-- =============================================================================
-- TEST 50 · transactional outbox: leasing, two-phase resolution, premium pay
-- =============================================================================
-- Exercises the OutboxStore contract from packages/hris/src/outboxWorker.ts
-- against the real RPCs, as service_role.
\set ON_ERROR_STOP on
\set QUIET on

\set acme  '11111111-1111-1111-1111-111111111111'
\set dana  '22222222-2222-2222-2222-000000000001'
\set priya '22222222-2222-2222-2222-000000000002'

begin;

-- Two IN/OUT punches -> two PUNCH outbox rows, written in the same transaction
-- as the events themselves.
select tctest.act_as(:'acme', :'priya');
set local role authenticated;
select tc_api.punch('IN',  '00000000-0000-4000-8000-000000000500') as _ \gset
select tc_api.punch('OUT', '00000000-0000-4000-8000-000000000501') as _ \gset
reset role;
select tctest.eq((select count(*)::int from timeclock.hris_outbox
                   where tenant_id = :'acme' and kind = 'PUNCH' and status = 'PENDING'),
  2, 'two PENDING punch rows');

-- 1. Claim leases the rows and bumps attempts.
set local role service_role;
select tc_api.outbox_claim(:'acme', 'PUNCH', 100) as claimed \gset
select tctest.eq(jsonb_array_length(:'claimed'::jsonb), 2, 'claim returns both rows') as _ \gset
select tctest.ok(
  (select bool_and((e ->> 'attempts')::int = 1) from jsonb_array_elements(:'claimed'::jsonb) e),
  'attempts incremented to 1');
select tctest.ok(
  (select bool_and(e -> 'payload' ->> 'hrisEmployeeId' is not null)
     from jsonb_array_elements(:'claimed'::jsonb) e),
  'canonical payload carries the HRIS employee id');
select tctest.ok(
  (select bool_and(e -> 'payload' ->> 'timeUtc' like '%Z')
     from jsonb_array_elements(:'claimed'::jsonb) e),
  'canonical times are explicit UTC (adapter converts to employee-local)');

-- 2. A second worker gets nothing while the lease holds — no double-shipping.
select tctest.eq(jsonb_array_length(tc_api.outbox_claim(:'acme', 'PUNCH', 100)), 0,
  'leased rows are invisible to a concurrent worker');
reset role;

select (select array_agg((e ->> 'id')::uuid) from jsonb_array_elements(:'claimed'::jsonb) e) as ids \gset
select ((:'claimed'::jsonb -> 0) -> 'payload' ->> 'punchEventId') as ref0 \gset

-- 3. Two-phase: SUBMITTED with a tracking id, then resolved from the error log.
set local role service_role;
select tctest.eq(tc_api.outbox_mark_submitted(:'ids'::uuid[], 'trk-0001'), 2, 'both marked SUBMITTED');
select tc_api.outbox_list_submitted(:'acme') as subs \gset
select tctest.eq(jsonb_array_length(:'subs'::jsonb), 1, 'one tracking group');
select tctest.eq((:'subs'::jsonb -> 0) ->> 'trackingId', 'trk-0001', 'tracking id round-trips');

-- The provider reports one bad record; everything it does not name succeeded.
select tc_api.outbox_mark_resolved('trk-0001',
  jsonb_build_array(jsonb_build_object('recordRef', :'ref0', 'message', 'departmentId not mapped'))) as res \gset
reset role;
select tctest.eq((:'res'::jsonb ->> 'delivered')::int, 1, 'one delivered');
select tctest.eq((:'res'::jsonb ->> 'failed')::int, 1, 'one failed');
select tctest.eq(
  (select status::text from timeclock.hris_outbox where payload ->> 'punchEventId' = :'ref0'),
  'FAILED', 'the named record is FAILED');
select tctest.ok(
  (select last_error like '%departmentId not mapped%' from timeclock.hris_outbox
    where payload ->> 'punchEventId' = :'ref0'),
  'provider message retained for the admin alert');

-- 4. Retryable failure goes back to PENDING behind a backoff window.
set local role service_role;
select tc_api.outbox_claim(:'acme', 'PUNCH', 100);  -- nothing left to claim
reset role;
insert into timeclock.hris_outbox (tenant_id, kind, payload, status)
values (:'acme', 'PUNCH', '{"punchEventId":"retry-me"}'::jsonb, 'PENDING')
returning id as retry_id \gset

set local role service_role;
select tc_api.outbox_claim(:'acme', 'PUNCH', 100) as c2 \gset
select tctest.eq(jsonb_array_length(:'c2'::jsonb), 1, 'the new row is claimable') as _ \gset
select tc_api.outbox_mark_failed(array[:'retry_id'::uuid], 'HTTP 429 rate limited', true, 60000) as _ \gset
select tctest.eq(jsonb_array_length(tc_api.outbox_claim(:'acme', 'PUNCH', 100)), 0,
  'a 429 backoff keeps the row out of the next claim');
reset role;
select tctest.eq((select status::text from timeclock.hris_outbox where id = :'retry_id'),
  'PENDING', 'retryable failure returns to PENDING');
select tctest.ok(
  (select next_attempt_at > clock_timestamp() + interval '30 seconds'
     from timeclock.hris_outbox where id = :'retry_id'),
  'retry_after_ms honoured (~60s, matching the documented Paycor guidance)');

-- Non-retryable is terminal.
set local role service_role;
select tc_api.outbox_mark_failed(array[:'retry_id'::uuid], 'schema rejected', false, null) as _ \gset
reset role;
select tctest.eq((select status::text from timeclock.hris_outbox where id = :'retry_id'),
  'FAILED', 'non-retryable failure is terminal');

-- 5. CA 226.7 premium: one pay item per exception, ever.
select tctest.act_as(:'acme', :'dana', true);
set local role authenticated;
select tc_api.record_exception(:'priya', current_date, 'LATE_MEAL',
  '{}'::uuid[], true, 'Lunch started at 5h12m.') as ex \gset
select tctest.ok((:'ex'::jsonb ->> 'premiumHourPayable')::boolean, 'premium flagged') as _ \gset
-- Re-running the evaluator must not double-pay.
select tc_api.record_exception(:'priya', current_date, 'LATE_MEAL', '{}'::uuid[], true, 'recomputed') as _ \gset
select tc_api.record_exception(:'priya', current_date, 'LATE_MEAL', '{}'::uuid[], false, 'recomputed again') as _ \gset
reset role;

select tctest.eq((select count(*)::int from timeclock.compliance_exception
                   where agent_id = :'priya' and type = 'LATE_MEAL'),
  1, 'one exception row per agent/day/type');
select tctest.ok((select premium_hour_payable from timeclock.compliance_exception
                   where agent_id = :'priya' and type = 'LATE_MEAL'),
  'a determined premium is never downgraded by a later recompute');
select tctest.eq((select count(*)::int from timeclock.hris_outbox
                   where kind = 'PAY_ITEM' and exception_id = (:'ex'::jsonb ->> 'id')::uuid),
  1, 'exactly one PAY_ITEM enqueued');
select tctest.eq(
  (select payload ->> 'earningCodeRef' from timeclock.hris_outbox
    where kind = 'PAY_ITEM' and exception_id = (:'ex'::jsonb ->> 'id')::uuid),
  '00000000-0000-0000-0000-00000000ea01', 'tenant earning code used');
select tctest.eq(
  (select (payload ->> 'hours')::int from timeclock.hris_outbox
    where kind = 'PAY_ITEM' and exception_id = (:'ex'::jsonb ->> 'id')::uuid),
  1, 'one premium hour, per 226.7(c)');

-- Delivering the pay item is what flips premium_delivered.
set local role service_role;
select tc_api.outbox_claim(:'acme', 'PAY_ITEM', 100) as pc \gset
select tc_api.outbox_mark_delivered(
  (select array_agg((e ->> 'id')::uuid) from jsonb_array_elements(:'pc'::jsonb) e)) as _ \gset
reset role;
select tctest.ok((select premium_delivered from timeclock.compliance_exception
                   where id = (:'ex'::jsonb ->> 'id')::uuid),
  'premium_delivered set only when the pay item actually shipped');

-- An unmapped agent has no premium delivery path, so nothing is enqueued.
select tctest.act_as(:'acme', :'dana', true);
set local role authenticated;
select tc_api.record_exception('22222222-2222-2222-2222-000000000003', current_date,
  'MISSED_MEAL', '{}'::uuid[], true, 'no lunch taken') as ex2 \gset
reset role;
select tctest.eq((select count(*)::int from timeclock.hris_outbox
                   where kind = 'PAY_ITEM' and exception_id = (:'ex2'::jsonb ->> 'id')::uuid),
  0, 'unmapped agent premium stays in-app until identity mapping exists');

rollback;
\echo '  ok 50_outbox'

-- =============================================================================
-- TEST 50b · 226.7(c) is one premium hour per WORKDAY, not per violation type
-- =============================================================================
begin;
select tctest.act_as('11111111-1111-1111-1111-111111111111',
                     '22222222-2222-2222-2222-000000000001', true);
set local role authenticated;
select tc_api.record_exception('22222222-2222-2222-2222-000000000002', current_date,
  'LATE_MEAL', '{}'::uuid[], true, 'lunch started at 5h10m') as e1 \gset
select tc_api.record_exception('22222222-2222-2222-2222-000000000002', current_date,
  'SHORT_MEAL', '{}'::uuid[], true, 'lunch was 24 minutes') as e2 \gset
reset role;

select tctest.ok((:'e1'::jsonb ->> 'premiumHourPayable')::boolean,
  'the first meal violation of the day is payable');
select tctest.ok(not (:'e2'::jsonb ->> 'premiumHourPayable')::boolean,
  'the second is recorded but the premium is suppressed');
select tctest.eq((select count(*)::int from timeclock.compliance_exception
                   where agent_id = '22222222-2222-2222-2222-000000000002'
                     and work_date = current_date), 2,
  'both violations still exist in the audit trail');
select tctest.eq((select count(*)::int from timeclock.hris_outbox o
                   join timeclock.compliance_exception ce on ce.id = o.exception_id
                  where o.kind = 'PAY_ITEM' and ce.work_date = current_date
                    and ce.agent_id = '22222222-2222-2222-2222-000000000002'), 1,
  'exactly one premium hour reaches payroll for the day');
select tctest.ok((select resolution like '%premium suppressed%' from timeclock.compliance_exception
                   where agent_id = '22222222-2222-2222-2222-000000000002'
                     and work_date = current_date and type = 'SHORT_MEAL'),
  'the suppression is explained in the record');

-- A different day is a different premium.
select tctest.act_as('11111111-1111-1111-1111-111111111111',
                     '22222222-2222-2222-2222-000000000001', true);
set local role authenticated;
select tc_api.record_exception('22222222-2222-2222-2222-000000000002', current_date - 1,
  'MISSED_MEAL', '{}'::uuid[], true, 'no lunch') as e3 \gset
reset role;
select tctest.ok((:'e3'::jsonb ->> 'premiumHourPayable')::boolean,
  'the previous workday gets its own premium');

-- An orphan exception is not a meal violation and must not be suppressed by one.
select tctest.act_as('11111111-1111-1111-1111-111111111111',
                     '22222222-2222-2222-2222-000000000001', true);
set local role authenticated;
select tc_api.record_exception('22222222-2222-2222-2222-000000000002', current_date,
  'ORPHAN_IN', '{}'::uuid[], false, 'no clock-out') as e4 \gset
reset role;
select tctest.eq(:'e4'::jsonb ->> 'type', 'ORPHAN_IN', 'orphan recorded alongside meal findings');

rollback;
\echo '  ok 50b_premium_per_workday'
