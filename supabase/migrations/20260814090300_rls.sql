-- =============================================================================
-- 30 · RLS — tenant isolation from JWT claims, forced on the owner
-- =============================================================================
-- Claim contract (minted by apps/api after it verifies the host CRM's identity
-- JWT against the host JWKS — see CLAUDE.md decision #5):
--
--   {
--     "iss": "https://api.YOURAPP.com/timeclock",
--     "sub": "<agent uuid>",              -- also auth.uid() if Supabase Auth is used
--     "aud": "authenticated",
--     "role": "authenticated",            -- the Postgres role PostgREST switches to
--     "exp": <= now + 300s,
--     "tc": {                             -- namespaced to avoid colliding with
--       "tenant_id": "<uuid>",            -- Supabase Auth's own claims
--       "agent_id":  "<uuid>",
--       "role":      "agent" | "supervisor",
--       "sid":       "<widget session id>"
--     }
--   }
--
-- Claims are read from `request.jwt.claims`, the GUC PostgREST sets per request,
-- rather than auth.jwt(), so the same policies work under a direct psql session
-- in CI (set_config) and under a Supabase Auth session.
-- Refs: https://supabase.com/docs/guides/database/postgres/row-level-security
--       https://supabase.com/docs/guides/auth/jwts
--       https://postgrest.org/en/stable/references/auth.html
--
-- Every policy predicate is wrapped in (select ...) so Postgres hoists it into an
-- InitPlan and evaluates it once per statement instead of once per row.
-- =============================================================================

set role tc_owner;

-- ------------------------------------------------------------ claim helpers
create or replace function timeclock.claims()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  )
$$;

create or replace function timeclock.jwt_tenant_id()
returns uuid
language sql
stable
set search_path = ''
as $$ select nullif(timeclock.claims() -> 'tc' ->> 'tenant_id', '')::uuid $$;

create or replace function timeclock.jwt_agent_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(
    coalesce(timeclock.claims() -> 'tc' ->> 'agent_id',
                        timeclock.claims() ->> 'sub'), '')::uuid
$$;

create or replace function timeclock.jwt_is_supervisor()
returns boolean
language sql
stable
set search_path = ''
as $$ select coalesce(timeclock.claims() -> 'tc' ->> 'role', 'agent') = 'supervisor' $$;

-- Fail fast and loudly rather than silently returning an empty result set.
create or replace function timeclock.assert_claims()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if timeclock.jwt_tenant_id() is null or timeclock.jwt_agent_id() is null then
    raise exception 'missing time-clock identity claims (tc.tenant_id / tc.agent_id)'
      using errcode = 'insufficient_privilege',
            hint = 'apps/api must mint the session JWT after verifying the host assertion.';
  end if;
end
$$;

-- --------------------------------------------------------------- enable RLS
-- FORCE makes policies apply to tc_owner, the role the SECURITY DEFINER RPCs run
-- as. Roles with the BYPASSRLS attribute (postgres, service_role) are still
-- exempt — that is the intended admin/worker escape hatch.
alter table timeclock.tenant                enable row level security;
alter table timeclock.tenant                force  row level security;
alter table timeclock.agent                 enable row level security;
alter table timeclock.agent                 force  row level security;
alter table timeclock.punch_event           enable row level security;
alter table timeclock.punch_event           force  row level security;
alter table timeclock.punch_event_mutation  enable row level security;
alter table timeclock.punch_event_mutation  force  row level security;
alter table timeclock.compliance_exception  enable row level security;
alter table timeclock.compliance_exception  force  row level security;
alter table timeclock.hris_outbox           enable row level security;
alter table timeclock.hris_outbox           force  row level security;

-- ------------------------------------------------------------------ tenant
create policy tenant_select_own on timeclock.tenant
  for select to tc_owner
  using (id = (select timeclock.jwt_tenant_id()));

-- ------------------------------------------------------------------- agent
create policy agent_select_scope on timeclock.agent
  for select to tc_owner
  using (
    tenant_id = (select timeclock.jwt_tenant_id())
    and (id = (select timeclock.jwt_agent_id()) or (select timeclock.jwt_is_supervisor()))
  );

-- ------------------------------------------------------------- punch_event
create policy punch_event_select_scope on timeclock.punch_event
  for select to tc_owner
  using (
    tenant_id = (select timeclock.jwt_tenant_id())
    and (agent_id = (select timeclock.jwt_agent_id()) or (select timeclock.jwt_is_supervisor()))
  );

-- A supervisor may punch on another agent's behalf (source = SUPERVISOR); an
-- agent may only write their own stream.
create policy punch_event_insert_scope on timeclock.punch_event
  for insert to tc_owner
  with check (
    tenant_id = (select timeclock.jwt_tenant_id())
    and (agent_id = (select timeclock.jwt_agent_id()) or (select timeclock.jwt_is_supervisor()))
    and exists (
      select 1 from timeclock.agent a
      where a.id = punch_event.agent_id
        and a.tenant_id = punch_event.tenant_id
    )
  );

-- Status transitions only: approving/rejecting a correction, superseding an
-- original. The guard trigger from migration 20 constrains *what* may change;
-- this policy constrains *who* may change it.
create policy punch_event_update_supervisor on timeclock.punch_event
  for update to tc_owner
  using (
    tenant_id = (select timeclock.jwt_tenant_id())
    and (select timeclock.jwt_is_supervisor())
  )
  with check (tenant_id = (select timeclock.jwt_tenant_id()));

-- --------------------------------------------------- punch_event_mutation
-- Written only by the SECURITY DEFINER journal trigger, which owns the row
-- contents; readable by supervisors for the audit view.
create policy mutation_insert_trigger on timeclock.punch_event_mutation
  for insert to tc_owner with check (true);

create policy mutation_select_supervisor on timeclock.punch_event_mutation
  for select to tc_owner
  using (
    tenant_id = (select timeclock.jwt_tenant_id())
    and (select timeclock.jwt_is_supervisor())
  );

-- ------------------------------------------------- compliance_exception
create policy exception_select_scope on timeclock.compliance_exception
  for select to tc_owner
  using (
    tenant_id = (select timeclock.jwt_tenant_id())
    and (agent_id = (select timeclock.jwt_agent_id()) or (select timeclock.jwt_is_supervisor()))
  );

create policy exception_insert_scope on timeclock.compliance_exception
  for insert to tc_owner
  with check (
    tenant_id = (select timeclock.jwt_tenant_id())
    and (agent_id = (select timeclock.jwt_agent_id()) or (select timeclock.jwt_is_supervisor()))
  );

create policy exception_update_scope on timeclock.compliance_exception
  for update to tc_owner
  using (
    tenant_id = (select timeclock.jwt_tenant_id())
    and (agent_id = (select timeclock.jwt_agent_id()) or (select timeclock.jwt_is_supervisor()))
  )
  with check (tenant_id = (select timeclock.jwt_tenant_id()));

-- -------------------------------------------------------------- hris_outbox
-- Enqueue happens inside the punch/correction RPCs (tc_owner). Draining is
-- deliberately NOT possible as tc_owner: there is no UPDATE policy, so the
-- worker must authenticate as service_role. An RPC bug cannot mark a row
-- DELIVERED that never shipped.
create policy outbox_insert_scope on timeclock.hris_outbox
  for insert to tc_owner
  with check (tenant_id = (select timeclock.jwt_tenant_id()));

create policy outbox_select_supervisor on timeclock.hris_outbox
  for select to tc_owner
  using (
    tenant_id = (select timeclock.jwt_tenant_id())
    and (select timeclock.jwt_is_supervisor())
  );

-- ------------------------------------------------------------- privileges
-- Re-assert the append-only revokes last, so this file is the final word even if
-- a future migration runs the broad GRANT ALL from the Supabase custom-schema guide.
grant select on timeclock.tenant, timeclock.agent, timeclock.compliance_exception,
                timeclock.hris_outbox, timeclock.transition to service_role;
grant insert, update on timeclock.hris_outbox to service_role;      -- the drain worker
grant update on timeclock.compliance_exception to service_role;      -- premium_delivered
revoke update, delete, truncate on timeclock.punch_event          from service_role;
revoke update, delete, truncate on timeclock.punch_event_mutation from service_role;

comment on table timeclock.transition is
  'Reference data (the state machine). No tenant column, so no RLS; no grants beyond SELECT.';

reset role;
