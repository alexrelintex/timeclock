-- =============================================================================
-- 00 · BOOTSTRAP — schemas, extensions, owner role, grants
-- =============================================================================
-- Two schemas, deliberately:
--   timeclock  PRIVATE. Tables, triggers, projection helpers. NEVER added to the
--              Data API "Exposed schemas" list. No grants to anon/authenticated.
--   tc_api     EXPOSED. Nothing but SECURITY DEFINER RPC entry points, each one
--              hardened with `set search_path = ''` and an explicit GRANT.
--
-- Why an owner role (tc_owner) instead of `postgres`:
--   `ALTER TABLE ... FORCE ROW LEVEL SECURITY` makes policies apply to the table
--   OWNER too, but the BYPASSRLS role attribute still exempts a role. Supabase's
--   `postgres` and `service_role` carry BYPASSRLS, so a SECURITY DEFINER function
--   owned by `postgres` would silently bypass every policy. tc_owner is NOLOGIN
--   NOBYPASSRLS, so the RPCs run *under* RLS: a bug in an RPC's WHERE clause
--   still cannot cross a tenant boundary.
--   Refs: https://www.postgresql.org/docs/16/ddl-rowsecurity.html
--         https://supabase.com/docs/guides/api/using-custom-schemas
-- =============================================================================

create schema if not exists timeclock;
create schema if not exists tc_api;

-- No extension dependency on purpose. gen_random_uuid() has been in core since
-- Postgres 13 and sha256(bytea) since 14, so the hash chain needs neither pgcrypto
-- nor USAGE on Supabase's `extensions` schema (which the migration role may not
-- own). Refs: https://www.postgresql.org/docs/16/functions-uuid.html
--            https://www.postgresql.org/docs/16/functions-binarystring.html

do $$
begin
  -- Supabase pre-creates these. Locally they must exist for the GRANTs below.
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  -- Table/function owner. NOBYPASSRLS is the whole point — do not change it.
  if not exists (select 1 from pg_roles where rolname = 'tc_owner') then
    create role tc_owner nologin noinherit nobypassrls;
  end if;
end
$$;

-- The migration runner (postgres) must be able to act as the owner.
do $$
begin
  execute format('grant tc_owner to %I', current_user);
exception when duplicate_object or invalid_grant_operation then null;
end
$$;

alter schema timeclock owner to tc_owner;
alter schema tc_api    owner to tc_owner;

-- PRIVATE schema: nothing outside the owner and BYPASSRLS admin roles.
revoke all on schema timeclock from public;
grant usage on schema timeclock to service_role;

-- EXPOSED schema: usage only. Table grants are never issued here (there are no
-- tables); each function is granted individually in the RPC migrations.
revoke all on schema tc_api from public;
grant usage on schema tc_api to authenticated, service_role;
alter default privileges for role tc_owner in schema tc_api revoke execute on functions from public;

comment on schema timeclock is
  'Private time-clock system of record. Not exposed to the Data API.';
comment on schema tc_api is
  'Exposed RPC surface for the time-clock widget. SECURITY DEFINER, owned by tc_owner.';
