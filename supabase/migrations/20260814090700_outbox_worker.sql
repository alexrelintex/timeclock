-- =============================================================================
-- 70 · OUTBOX + RECONCILER RPCs — service_role only
-- =============================================================================
-- These implement the OutboxStore interface in packages/hris/src/outboxWorker.ts
-- one-for-one, so the existing provider-agnostic drain logic runs unchanged.
--
-- SECURITY INVOKER on purpose: the caller must actually BE service_role, whose
-- BYPASSRLS attribute is what grants cross-tenant reach. There is deliberately no
-- tc_owner path to marking a row DELIVERED — a bug in an agent-facing RPC cannot
-- claim an HRIS push happened.
--
-- Claim leasing uses FOR UPDATE SKIP LOCKED so N worker replicas can drain the
-- same tenant concurrently without double-shipping a punch.
-- =============================================================================

set role tc_owner;

grant insert on timeclock.compliance_exception to service_role;

-- ------------------------------------------------------------------- claim
create or replace function tc_api.outbox_claim(
  p_tenant_id uuid,
  p_kind      text,
  p_limit     int default 100     -- the strictest verified Paycor batch cap
) returns jsonb
language sql
volatile
set search_path = ''
as $$
  with candidate as (
    select o.id
    from timeclock.hris_outbox o
    where o.tenant_id = p_tenant_id
      and o.kind = p_kind::timeclock.outbox_kind
      and o.status = 'PENDING'
      and o.next_attempt_at <= clock_timestamp()
      and (o.locked_until is null or o.locked_until < clock_timestamp())
    order by o.created_at asc
    limit greatest(1, least(p_limit, 100))
    for update skip locked
  ),
  claimed as (
    update timeclock.hris_outbox o
       set locked_until = clock_timestamp() + interval '5 minutes',
           attempts     = o.attempts + 1
      from candidate c
     where o.id = c.id
    returning o.id, o.tenant_id, o.kind, o.payload, o.attempts
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'tenantId', tenant_id, 'kind', kind,
           'payload', payload, 'attempts', attempts)), '[]'::jsonb)
  from claimed
$$;

create or replace function tc_api.outbox_tenants_pending()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(distinct o.tenant_id), '[]'::jsonb)
  from timeclock.hris_outbox o
  where o.status in ('PENDING', 'SUBMITTED')
    and o.next_attempt_at <= clock_timestamp()
$$;

-- --------------------------------------------------------------- two-phase
create or replace function tc_api.outbox_mark_submitted(p_ids uuid[], p_tracking_id text)
returns int
language sql
volatile
set search_path = ''
as $$
  with u as (
    update timeclock.hris_outbox
       set status = 'SUBMITTED', tracking_id = p_tracking_id,
           submitted_at = clock_timestamp(), locked_until = null
     where id = any(p_ids)
     returning 1
  ) select count(*)::int from u
$$;

create or replace function tc_api.outbox_mark_delivered(p_ids uuid[])
returns int
language plpgsql
volatile
set search_path = ''
as $$
declare v_n int;
begin
  update timeclock.hris_outbox
     set status = 'DELIVERED', resolved_at = clock_timestamp(),
         locked_until = null, last_error = null
   where id = any(p_ids);
  get diagnostics v_n = row_count;

  -- A delivered PAY_ITEM is the moment the CA 226.7 premium actually reaches payroll.
  update timeclock.compliance_exception ce
     set premium_delivered = true
    from timeclock.hris_outbox o
   where o.id = any(p_ids)
     and o.kind = 'PAY_ITEM'
     and o.exception_id = ce.id;
  return v_n;
end
$$;

create or replace function tc_api.outbox_mark_not_supported(p_ids uuid[])
returns int
language sql
volatile
set search_path = ''
as $$
  with u as (
    update timeclock.hris_outbox
       set status = 'NOT_SUPPORTED', resolved_at = clock_timestamp(), locked_until = null,
           last_error = 'provider capability flag excluded this record'
     where id = any(p_ids)
     returning 1
  ) select count(*)::int from u
$$;

-- Retryable failures go back to PENDING with a backoff; Paycor's documented
-- 429 guidance is ~60s, and the adapter passes retryAfterMs through.
create or replace function tc_api.outbox_mark_failed(
  p_ids            uuid[],
  p_error          text,
  p_retryable      boolean,
  p_retry_after_ms bigint default null
) returns int
language sql
volatile
set search_path = ''
as $$
  with u as (
    update timeclock.hris_outbox o
       set status       = case when p_retryable and o.attempts < 12 then 'PENDING'::timeclock.outbox_status
                               else 'FAILED'::timeclock.outbox_status end,
           last_error   = pg_catalog.left(p_error, 2000),
           locked_until = null,
           resolved_at  = case when p_retryable and o.attempts < 12 then null else clock_timestamp() end,
           next_attempt_at = clock_timestamp()
             + coalesce(pg_catalog.make_interval(secs => p_retry_after_ms / 1000.0),
                        -- exponential backoff, capped at 15 minutes
                        pg_catalog.make_interval(secs => least(900, power(2, least(o.attempts, 10))::int)))
     where o.id = any(p_ids)
     returning 1
  ) select count(*)::int from u
$$;

create or replace function tc_api.outbox_list_submitted(p_tenant_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('trackingId', tracking_id, 'ids', ids)), '[]'::jsonb)
  from (
    select o.tracking_id, jsonb_agg(o.id) as ids
    from timeclock.hris_outbox o
    where o.tenant_id = p_tenant_id
      and o.status = 'SUBMITTED'
      and o.tracking_id is not null
    group by o.tracking_id
  ) g
$$;

-- Async resolution. p_errors is the provider's per-record error list, shaped
-- [{"recordRef": "<punchEventId|exceptionId>", "message": "..."}]. Anything not
-- named in it succeeded — that is how Paycor's punchErrorLog reads.
create or replace function tc_api.outbox_mark_resolved(p_tracking_id text, p_errors jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_failed uuid[];
  v_ok     uuid[];
begin
  select coalesce(array_agg(o.id), '{}')
    into v_failed
  from timeclock.hris_outbox o
  where o.tracking_id = p_tracking_id
    and o.status = 'SUBMITTED'
    and exists (
      select 1 from jsonb_array_elements(coalesce(p_errors, '[]'::jsonb)) e
      where e ->> 'recordRef' in (o.payload ->> 'punchEventId',
                                  o.payload ->> 'exceptionId',
                                  o.payload ->> 'correctionEventId')
    );

  select coalesce(array_agg(o.id), '{}')
    into v_ok
  from timeclock.hris_outbox o
  where o.tracking_id = p_tracking_id
    and o.status = 'SUBMITTED'
    and not (o.id = any(v_failed));

  if array_length(v_ok, 1) > 0 then
    perform tc_api.outbox_mark_delivered(v_ok);
  end if;
  if array_length(v_failed, 1) > 0 then
    perform tc_api.outbox_mark_failed(
      v_failed,
      (select string_agg(e ->> 'message', '; ')
       from jsonb_array_elements(coalesce(p_errors, '[]'::jsonb)) e),
      false, null);
  end if;

  return jsonb_build_object('delivered', coalesce(array_length(v_ok, 1), 0),
                            'failed',    coalesce(array_length(v_failed, 1), 0));
end
$$;

-- --------------------------------------------------------- orphan sweep
-- Pure-SQL reconciler pass: opens a ComplianceException for every agent sitting
-- past an orphan threshold. Safe to run on a schedule with no HTTP involved.
-- packages/core/src/orphanDetection.ts stays the reference implementation; this
-- exists so a dead worker process cannot mean undetected orphans.
create or replace function tc_api.sweep_orphans(p_tenant_id uuid default null)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  a        record;
  v_snap   jsonb;
  v_orphan jsonb;
  v_opened timestamptz;
  v_count  int := 0;
begin
  for a in
    select ag.id, ag.tenant_id, ag.timezone
    from timeclock.agent ag
    where ag.active
      and (p_tenant_id is null or ag.tenant_id = p_tenant_id)
  loop
    v_snap := timeclock.snapshot(a.id, clock_timestamp());
    v_orphan := v_snap -> 'openOrphan';
    continue when v_orphan is null or v_orphan = 'null'::jsonb;

    v_opened := (v_orphan ->> 'openedAtUtc')::timestamptz;
    insert into timeclock.compliance_exception
      (tenant_id, agent_id, work_date, type, related_event_ids)
    values
      (a.tenant_id, a.id, (v_opened at time zone a.timezone)::date,
       (v_orphan ->> 'kind')::timeclock.exception_type, '{}')
    on conflict (tenant_id, agent_id, work_date, type) do nothing;
    v_count := v_count + 1;

    perform timeclock.notify_roster(a.tenant_id, 'orphan',
      jsonb_build_object('agentId', a.id, 'kind', v_orphan ->> 'kind'));
  end loop;
  return jsonb_build_object('orphansSeen', v_count);
end
$$;

-- ------------------------------------------------------------------- grants
do $$
declare fn text;
begin
  for fn in
    select p.oid::regprocedure::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'tc_api'
      and (p.proname like 'outbox%' or p.proname = 'sweep_orphans')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$$;

-- --------------------------------------------------------------- scheduling
-- The orphan sweep is pure SQL, so pg_cron can own it outright.
-- Docs: https://supabase.com/docs/guides/cron
do $$
begin
  if pg_catalog.to_regnamespace('cron') is not null then
    perform cron.unschedule('timeclock-sweep-orphans')
    where exists (select 1 from cron.job where jobname = 'timeclock-sweep-orphans');
    perform cron.schedule('timeclock-sweep-orphans', '*/5 * * * *',
      $sweep$ select tc_api.sweep_orphans(); $sweep$);
  else
    raise warning 'pg_cron not installed — schedule tc_api.sweep_orphans() externally (apps/api does this too)';
  end if;
end
$$;

-- The HRIS drain needs outbound HTTPS, so it cannot live in plpgsql. Two options,
-- both supported by the code in this repo:
--   A. apps/api runs the drain loop itself (default; see apps/api/src/worker.ts).
--   B. pg_cron + pg_net POST to the API's /internal/outbox/drain endpoint, with the
--      shared secret read from Supabase Vault. Uncomment when running the API
--      serverless. Docs: https://supabase.com/docs/guides/database/extensions/pg_net
--
-- select cron.schedule('timeclock-drain-outbox', '* * * * *', $$
--   select net.http_post(
--     url     := 'https://api.YOURAPP.com/internal/outbox/drain',
--     headers := jsonb_build_object('Content-Type', 'application/json',
--                                   'X-Worker-Secret', (select decrypted_secret
--                                                       from vault.decrypted_secrets
--                                                       where name = 'timeclock_worker_secret')),
--     body    := '{}'::jsonb,
--     timeout_milliseconds := 8000);
-- $$);

reset role;
