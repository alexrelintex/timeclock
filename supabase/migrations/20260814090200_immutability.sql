-- =============================================================================
-- 20 · IMMUTABILITY — append-only enforcement + tamper-evident hash chain
-- =============================================================================
-- Design decision #1 in CLAUDE.md ("PunchEvent rows are NEVER updated or
-- deleted") is enforced at three layers, because a comment is not a control:
--
--   1. PRIVILEGE   UPDATE/DELETE/TRUNCATE revoked from every role including
--                  service_role. Only tc_owner (reachable solely through the
--                  SECURITY DEFINER RPCs) retains them.
--   2. TRIGGER     DELETE always raises. UPDATE may touch exactly three columns
--                  (status, approved_by_id, approved_at) and only along a
--                  whitelisted status transition.
--   3. JOURNAL     Every permitted status transition is appended to
--                  punch_event_mutation with the acting role and JWT claims.
--
-- The hash chain gives evidentiary weight to the export: recompute the chain and
-- any silently edited or removed row breaks every hash after it. Relevant when
-- this app is the SOLE meal-period record (Donohue v. AMN Services, 11 Cal.5th
-- 58 (2021)) and must survive a records challenge.
-- =============================================================================

set role tc_owner;

-- ------------------------------------------------------------- hash chain
create or replace function timeclock.punch_event_chain()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev text;
  v_payload text;
begin
  -- Serialise chain appends for this (tenant, agent) so two concurrent inserts
  -- cannot both read the same tail. Released at commit.
  perform pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.tenant_id::text || ':' || new.agent_id::text, 0)
  );

  select pe.self_hash into v_prev
  from timeclock.punch_event pe
  where pe.tenant_id = new.tenant_id
    and pe.agent_id  = new.agent_id
  order by pe.seq desc
  limit 1;

  v_payload := pg_catalog.concat_ws('|',
    coalesce(v_prev, 'GENESIS'),
    new.seq::text,
    new.id::text,
    new.tenant_id::text,
    new.agent_id::text,
    new.event_type::text,
    pg_catalog.to_char(new.event_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS'),
    new.source::text,
    new.status::text,
    coalesce(new.correction_of_id::text, ''),
    coalesce(new.note, ''),
    new.created_by_id::text,
    new.client_uuid::text
  );

  new.prev_hash := v_prev;
  new.self_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_payload, 'UTF8')), 'hex'
  );
  return new;
end
$$;

drop trigger if exists punch_event_chain_before_insert on timeclock.punch_event;
create trigger punch_event_chain_before_insert
  before insert on timeclock.punch_event
  for each row execute function timeclock.punch_event_chain();

-- Verifier: returns the first row where the chain does not reconcile.
-- Run it in the nightly reconciler and before any compliance export.
create or replace function timeclock.verify_chain(p_tenant_id uuid, p_agent_id uuid)
returns table (punch_event_id uuid, event_time timestamptz, problem text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_prev text := null;
  v_expected text;
begin
  for r in
    select * from timeclock.punch_event pe
    where pe.tenant_id = p_tenant_id and pe.agent_id = p_agent_id
    order by pe.seq asc
  loop
    if r.prev_hash is distinct from v_prev then
      return query select r.id, r.event_time, 'prev_hash does not match preceding self_hash';
    end if;
    v_expected := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.concat_ws('|',
      coalesce(v_prev, 'GENESIS'), r.seq::text, r.id::text, r.tenant_id::text, r.agent_id::text,
      r.event_type::text,
      pg_catalog.to_char(r.event_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS'),
      r.source::text, r.status::text, coalesce(r.correction_of_id::text, ''),
      coalesce(r.note, ''), r.created_by_id::text, r.client_uuid::text
    ), 'UTF8')), 'hex');
    -- NOTE: status participates in the hash, so an approved correction
    -- (PENDING_APPROVAL -> ACTIVE) intentionally shows here as a status-only
    -- divergence; punch_event_mutation is the proof of who changed it and when.
    if r.self_hash is distinct from v_expected then
      return query
        select r.id, r.event_time,
               case when r.status <> 'ACTIVE'::timeclock.event_status
                         or exists (select 1 from timeclock.punch_event_mutation m
                                    where m.punch_event_id = r.id)
                    then 'self_hash differs — status transition, see punch_event_mutation'
                    else 'self_hash differs — CONTENT TAMPERED' end;
    end if;
    v_prev := r.self_hash;
  end loop;
  return;
end
$$;

-- --------------------------------------------------------- append-only guard
create or replace function timeclock.punch_event_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allowed boolean;
begin
  if tg_op = 'DELETE' then
    raise exception
      'punch_event is append-only: DELETE is never permitted (id=%)', old.id
      using errcode = 'restrict_violation',
            hint = 'Supersede the event with a correction instead.';
  end if;

  -- Column whitelist: everything except status/approved_by_id/approved_at is frozen.
  if new.id            is distinct from old.id
     or new.seq        is distinct from old.seq
     or new.tenant_id  is distinct from old.tenant_id
     or new.agent_id   is distinct from old.agent_id
     or new.event_type is distinct from old.event_type
     or new.event_time is distinct from old.event_time
     or new.source     is distinct from old.source
     or new.session_id is distinct from old.session_id
     or new.correction_of_id is distinct from old.correction_of_id
     or new.note       is distinct from old.note
     or new.created_by_id is distinct from old.created_by_id
     or new.client_uuid is distinct from old.client_uuid
     or new.created_at is distinct from old.created_at
     or new.prev_hash  is distinct from old.prev_hash
     or new.self_hash  is distinct from old.self_hash
  then
    raise exception
      'punch_event is append-only: only status/approved_by_id/approved_at may change (id=%)', old.id
      using errcode = 'restrict_violation';
  end if;

  -- Status transition whitelist.
  v_allowed := (old.status = new.status)
    or (old.status = 'PENDING_APPROVAL' and new.status in ('ACTIVE', 'REJECTED'))
    or (old.status = 'ACTIVE'           and new.status = 'SUPERSEDED');
  if not v_allowed then
    raise exception 'illegal event_status transition % -> % (id=%)',
      old.status, new.status, old.id
      using errcode = 'restrict_violation';
  end if;

  return new;
end
$$;

drop trigger if exists punch_event_guard_before_update on timeclock.punch_event;
create trigger punch_event_guard_before_update
  before update on timeclock.punch_event
  for each row execute function timeclock.punch_event_guard();

drop trigger if exists punch_event_guard_before_delete on timeclock.punch_event;
create trigger punch_event_guard_before_delete
  before delete on timeclock.punch_event
  for each row execute function timeclock.punch_event_guard();

-- --------------------------------------------------------------- journal
create or replace function timeclock.punch_event_journal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status is distinct from new.status then
    insert into timeclock.punch_event_mutation
      (punch_event_id, tenant_id, from_status, to_status, actor_id, db_role, jwt_claims)
    values
      (new.id, new.tenant_id, old.status, new.status,
       new.approved_by_id, current_user,
       nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb);
  end if;
  return null;
end
$$;

create trigger punch_event_journal_after_update
  after update on timeclock.punch_event
  for each row execute function timeclock.punch_event_journal();

-- The journal is itself append-only.
create or replace function timeclock.deny_write()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only (% denied)', tg_table_name, tg_op
    using errcode = 'restrict_violation';
end
$$;

drop trigger if exists punch_event_mutation_immutable on timeclock.punch_event_mutation;
create trigger punch_event_mutation_immutable
  before update or delete on timeclock.punch_event_mutation
  for each row execute function timeclock.deny_write();

-- ------------------------------------------------------------- privileges
-- Belt and braces: even if someone later runs the broad
-- "GRANT ALL ON ALL TABLES IN SCHEMA ..." from the Supabase custom-schema guide,
-- these REVOKEs are re-asserted by migration 30's grant block.
revoke all on timeclock.punch_event           from public, anon, authenticated, service_role;
revoke all on timeclock.punch_event_mutation  from public, anon, authenticated, service_role;
grant select on timeclock.punch_event          to service_role;   -- read-only: exports, reconciler
grant select on timeclock.punch_event_mutation to service_role;

reset role;
