-- =============================================================================
-- TEST HELPERS
-- =============================================================================
-- Deliberately tiny: no pgTAP dependency, so `scripts/db-reset.sh --with-tests`
-- runs anywhere psql runs (CI container, supabase start, a bare Postgres).
--
-- Assertions live in a `tctest` schema and are EXECUTE-able by `authenticated`,
-- because the tests impersonate that role — the same path the widget takes —
-- rather than asserting as a superuser and hoping RLS behaves the same way.
-- Drop this schema before promoting to a shared environment (see teardown at the
-- bottom of scripts/db-reset.sh usage notes).
-- =============================================================================

create schema if not exists tctest;

create or replace function tctest.ok(p_cond boolean, p_label text)
returns void
language plpgsql
as $$
begin
  if p_cond is not true then
    raise exception 'ASSERT FAILED: %', p_label using errcode = 'assert_failure';
  end if;
end
$$;

create or replace function tctest.eq(p_actual anyelement, p_expected anyelement, p_label text)
returns void
language plpgsql
as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'ASSERT FAILED: % (expected %, got %)', p_label, p_expected, p_actual
      using errcode = 'assert_failure';
  end if;
end
$$;

-- Assert that a statement raises a specific SQLSTATE. Runs the statement with the
-- caller's privileges and claims, so it exercises RLS and the RPC grants exactly
-- as production does.
create or replace function tctest.throws(p_sql text, p_sqlstate text, p_label text)
returns void
language plpgsql
as $$
begin
  execute p_sql;
  raise exception 'ASSERT FAILED: % — expected SQLSTATE %, statement succeeded', p_label, p_sqlstate
    using errcode = 'assert_failure';
exception
  when assert_failure then
    raise;
  when others then
    if sqlstate <> p_sqlstate then
      raise exception 'ASSERT FAILED: % — expected SQLSTATE %, got % (%)',
        p_label, p_sqlstate, sqlstate, sqlerrm using errcode = 'assert_failure';
    end if;
end
$$;

-- Impersonate an identity: set the claims PostgREST would set, then drop into the
-- `authenticated` role. Call inside a transaction; the claims are transaction-local.
create or replace function tctest.act_as(
  p_tenant_id  uuid,
  p_agent_id   uuid,
  p_supervisor boolean default false
) returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', json_build_object(
    'sub',  p_agent_id,
    'role', 'authenticated',
    'aud',  'authenticated',
    'tc',   json_build_object(
              'tenant_id', p_tenant_id,
              'agent_id',  p_agent_id,
              'role',      case when p_supervisor then 'supervisor' else 'agent' end,
              'sid',       'test-session')
  )::text, true);
end
$$;

grant usage on schema tctest to public;
grant execute on all functions in schema tctest to public;
