-- =============================================================================
-- 90 · IDENTITY MAP — host CRM user -> agent -> HRIS employee
-- =============================================================================
-- CLAUDE.md decision #5: identity is host-asserted, server-verified. apps/api
-- verifies the host's short-lived JWT against the host JWKS and then calls
-- resolve_identity with the *verified* subject. These functions are service_role
-- only — they are the one place where a host_user_id string is trusted, and it is
-- only trusted because the caller proved it came out of a signed assertion.
--
-- Nothing here is reachable from `authenticated`: an agent cannot look up or
-- create identity rows, only act as the identity apps/api minted for them.
-- =============================================================================

set role tc_owner;

grant insert, update on timeclock.agent to service_role;

create or replace function tc_api.resolve_identity(
  p_tenant_slug  text,
  p_host_user_id text
) returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'tenantId',       t.id,
    'tenantSlug',     t.slug,
    'tenantTimezone', t.timezone,
    'agentId',        a.id,
    'displayName',    a.display_name,
    'timezone',       a.timezone,
    'isSupervisor',   a.is_supervisor,
    'role',           case when a.is_supervisor then 'supervisor' else 'agent' end,
    'active',         a.active,
    'hrisEmployeeId', a.hris_employee_id,
    'mealWaiverOnFile', a.meal_waiver_on_file
  )
  from timeclock.agent a
  join timeclock.tenant t on t.id = a.tenant_id
  where t.slug = p_tenant_slug
    and a.host_user_id = p_host_user_id
$$;

-- Just-in-time provisioning. Called by apps/api on a verified assertion for a
-- host user with no agent row yet. Timezone comes from the host claim when it
-- supplies one (agents span US/India/Philippines and the meal timers depend on
-- it), otherwise the tenant default.
create or replace function tc_api.upsert_agent(
  p_tenant_slug  text,
  p_host_user_id text,
  p_display_name text,
  p_timezone     text default null,
  p_is_supervisor boolean default null
) returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  t timeclock.tenant;
  a timeclock.agent;
begin
  select * into t from timeclock.tenant where slug = p_tenant_slug;
  if t.id is null then
    raise sqlstate 'PT404' using message = pg_catalog.format('unknown tenant %L', p_tenant_slug);
  end if;

  -- Reject a bogus IANA zone rather than silently mis-timing every meal deadline
  -- for this agent. pg_timezone_names is the authoritative list in this server.
  if p_timezone is not null
     and not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_timezone) then
    raise sqlstate 'PT400' using
      message = pg_catalog.format('invalid IANA timezone %L', p_timezone),
      hint    = 'Meal deadlines and HRIS local-time conversion both depend on this.';
  end if;

  insert into timeclock.agent
    (tenant_id, host_user_id, display_name, timezone, is_supervisor)
  values
    (t.id, p_host_user_id, coalesce(nullif(pg_catalog.btrim(p_display_name), ''), p_host_user_id),
     coalesce(p_timezone, t.timezone), coalesce(p_is_supervisor, false))
  on conflict (tenant_id, host_user_id) do update
    set display_name  = coalesce(nullif(pg_catalog.btrim(excluded.display_name), ''),
                                 timeclock.agent.display_name),
        timezone      = case when p_timezone is null then timeclock.agent.timezone
                            else excluded.timezone end,
        is_supervisor = case when p_is_supervisor is null then timeclock.agent.is_supervisor
                            else excluded.is_supervisor end
  returning * into a;

  return tc_api.resolve_identity(p_tenant_slug, p_host_user_id);
end
$$;

-- Identity-map sync target for the HRIS webhook receiver (Paycor
-- Employee.Modified-class events). Separate from upsert_agent because mapping an
-- employee id is an admin action, not a login side effect.
create or replace function tc_api.map_hris_employee(
  p_agent_id            uuid,
  p_hris_employee_id    text,
  p_hris_department_id  text default null,
  p_hris_activity_type_id text default null
) returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare a timeclock.agent;
begin
  update timeclock.agent
     set hris_employee_id      = p_hris_employee_id,
         hris_department_id    = coalesce(p_hris_department_id, hris_department_id),
         hris_activity_type_id = coalesce(p_hris_activity_type_id, hris_activity_type_id)
   where id = p_agent_id
  returning * into a;

  if a.id is null then
    raise sqlstate 'PT404' using message = 'agent not found';
  end if;
  return jsonb_build_object('agentId', a.id, 'hrisEmployeeId', a.hris_employee_id,
                            'hrisDepartmentId', a.hris_department_id,
                            'hrisActivityTypeId', a.hris_activity_type_id);
end
$$;

-- Tenant HRIS configuration for the worker's AdapterRegistry.
create or replace function tc_api.tenant_hris_config(p_tenant_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'tenantId', t.id,
    'slug', t.slug,
    'provider', t.hris_provider,
    'config', t.hris_config,
    'premiumEarningRef', t.hris_premium_earning_ref,
    'employeeWriteConfig', (
      select coalesce(jsonb_object_agg(a.hris_employee_id, jsonb_build_object(
               'departmentId', a.hris_department_id,
               'activityTypeId', a.hris_activity_type_id)), '{}'::jsonb)
      from timeclock.agent a
      where a.tenant_id = t.id and a.hris_employee_id is not null)
  )
  from timeclock.tenant t
  where t.id = p_tenant_id
$$;

do $$
declare fn text;
begin
  for fn in
    select p.oid::regprocedure::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'tc_api'
      and p.proname in ('resolve_identity', 'upsert_agent', 'map_hris_employee', 'tenant_hris_config')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$$;

reset role;
