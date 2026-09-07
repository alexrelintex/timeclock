-- =============================================================================
-- 80 · REALTIME AUTHORIZATION, EXPORT, HEALTH
-- =============================================================================

set role tc_owner;

-- ------------------------------------------------------- realtime authz
-- Private Broadcast topics carry roster changes. Authorization for a private
-- topic is an RLS policy on realtime.messages.
-- Docs: https://supabase.com/docs/guides/realtime/authorization
--       https://supabase.com/docs/guides/realtime/broadcast
--
-- Two topics:
--   tc:tenant:<tenant_id>  supervisors only — the whole board
--   tc:agent:<agent_id>    that agent (and their supervisors) — own state only
--
-- Guarded so this migration still applies on a plain Postgres without the
-- realtime extension (CI, self-hosted).
do $$
begin
  if pg_catalog.to_regclass('realtime.messages') is null then
    raise warning 'realtime.messages absent — skipping broadcast policies (SSE fallback in apps/api still works)';
    return;
  end if;

  execute $p$
    drop policy if exists timeclock_broadcast_tenant on realtime.messages;
    create policy timeclock_broadcast_tenant on realtime.messages
      for select to authenticated
      using (
        topic = 'tc:tenant:' || coalesce((select timeclock.jwt_tenant_id())::text, '-')
        and (select timeclock.jwt_is_supervisor())
      );
  $p$;

  execute $p$
    drop policy if exists timeclock_broadcast_agent on realtime.messages;
    create policy timeclock_broadcast_agent on realtime.messages
      for select to authenticated
      using (topic = 'tc:agent:' || coalesce((select timeclock.jwt_agent_id())::text, '-'));
  $p$;
end
$$;

-- ------------------------------------------------------------------ export
-- Flat, join-free row shape for the compliance/payroll export. There is NO
-- retention or purge job in this schema by design: FLSA 29 CFR 516.5 (payroll,
-- 3 years) and 516.6 (time records, 2 years) set the federal floor, CA pushes
-- practice to 4, and this app is the sole record of meal periods
-- (Donohue v. AMN Services, 11 Cal.5th 58 (2021)). Deletion is an explicit,
-- audited operation someone must write on purpose — not a cron job.
create or replace function timeclock.export_events(
  p_tenant_id uuid,
  p_from      timestamptz,
  p_to        timestamptz
) returns table (
  agent_name       text,
  hris_employee_id text,
  agent_timezone   text,
  event_type       text,
  event_time_utc   text,
  event_time_local text,
  work_date_local  date,
  source           text,
  status           text,
  note             text,
  correction_of_id uuid,
  self_hash        text
)
language sql
stable
set search_path = ''
as $$
  select a.display_name,
         a.hris_employee_id,
         a.timezone,
         pe.event_type::text,
         timeclock.iso(pe.event_time),
         pg_catalog.to_char(pe.event_time at time zone a.timezone, 'YYYY-MM-DD"T"HH24:MI:SS'),
         (pe.event_time at time zone a.timezone)::date,
         pe.source::text,
         pe.status::text,
         pe.note,
         pe.correction_of_id,
         pe.self_hash
  from timeclock.punch_event pe
  join timeclock.agent a on a.id = pe.agent_id
  where pe.tenant_id = p_tenant_id
    and pe.event_time >= p_from
    and pe.event_time <  p_to
  order by a.display_name, pe.event_time
$$;

revoke all on function timeclock.export_events(uuid, timestamptz, timestamptz) from public;
grant execute on function timeclock.export_events(uuid, timestamptz, timestamptz) to service_role;

-- ------------------------------------------------------------------ health
-- Cheap readiness probe for apps/api: confirms the schema is the one the code
-- expects and that the RPC surface is reachable under the caller's claims.
create or replace function tc_api.health()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'schema', 'timeclock',
    'contractVersion', 1,
    'transitions', (select count(*) from timeclock.transition),
    'serverNowUtc', timeclock.iso(clock_timestamp()),
    'claimsPresent', timeclock.jwt_tenant_id() is not null
  )
$$;

revoke all on function tc_api.health() from public;
grant execute on function tc_api.health() to authenticated, service_role;

reset role;
