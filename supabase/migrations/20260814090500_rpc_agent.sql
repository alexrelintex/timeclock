-- =============================================================================
-- 50 · AGENT RPCs — the single guarded write path
-- =============================================================================
-- These are the only functions the widget's identity can reach. Every one:
--   * runs SECURITY DEFINER as tc_owner, so FORCE RLS still applies (migration 30)
--   * pins `search_path = ''` so a hostile schema on the caller's path cannot
--     shadow a function name (CVE-class: search_path hijacking of SECURITY DEFINER)
--   * takes an advisory transaction lock on the agent before projecting, so the
--     read-then-write is serialised per agent
--   * raises PTxyz SQLSTATEs, which PostgREST maps straight to that HTTP status
--     (https://postgrest.org/en/v12/references/errors.html) and which apps/api
--     maps identically when it proxies.
--
-- Server clock only. A live punch's event_time is always now() — never a value
-- from the browser. Backdated times exist solely in the correction flow, which
-- requires an attestation and a supervisor decision.
-- =============================================================================

set role tc_owner;

-- ------------------------------------------------------------------ helpers
create or replace function timeclock.lock_agent(p_agent_id uuid)
returns void
language sql
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_agent_id::text, 42))
$$;

-- Canonical outbox payload, shaped exactly like CanonicalPunch in
-- packages/hris/src/adapter.ts so the worker can cast without a mapping layer.
create or replace function timeclock.canonical_punch(p_event_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'punchEventId',   pe.id,
    'agentId',        a.id,
    'hrisEmployeeId', a.hris_employee_id,
    'type',           pe.event_type,
    'timeUtc',        timeclock.iso(pe.event_time),
    'agentTimezone',  a.timezone
  ) || case when pe.note is null then '{}'::jsonb
            else jsonb_build_object('note', pe.note) end
  from timeclock.punch_event pe
  join timeclock.agent a on a.id = pe.agent_id
  where pe.id = p_event_id
$$;

-- Realtime fan-out for the supervisor panel. Guarded so the migration also runs
-- on a plain Postgres (CI, self-hosted) where the realtime schema is absent.
-- Docs: https://supabase.com/docs/guides/realtime/broadcast (Broadcast from the Database)
create or replace function timeclock.notify_roster(p_tenant_id uuid, p_event text, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if pg_catalog.to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
    -- Supervisor board.
    perform realtime.send(p_payload, p_event, 'tc:tenant:' || p_tenant_id::text, true);
    -- The agent's own topic, so a second browser tab or the mobile CRM view
    -- re-renders without waiting for the 30s poll.
    if p_payload ? 'agentId' then
      perform realtime.send(p_payload, p_event, 'tc:agent:' || (p_payload ->> 'agentId'), true);
    end if;
  end if;
  -- LISTEN/NOTIFY is the transport for the SSE endpoint in apps/api, and the
  -- fallback when Realtime is not provisioned. 8000-byte payload ceiling, so
  -- only identifiers travel — the client re-reads the roster RPC.
  perform pg_catalog.pg_notify('tc_roster',
    jsonb_build_object('tenantId', p_tenant_id, 'event', p_event, 'payload', p_payload)::text);
end
$$;

-- ------------------------------------------------------------------- punch
create or replace function tc_api.punch(
  p_event_type  text,
  p_client_uuid uuid,
  p_note        text default null,
  p_session_id  text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_agent_id  uuid;
  v_type      timeclock.punch_event_type;
  v_now       timestamptz := clock_timestamp();
  a           timeclock.agent;
  v_status    timeclock.agent_status;
  v_to        timeclock.agent_status;
  v_existing  timeclock.punch_event;
  v_event_id  uuid;
  v_enqueued  boolean := false;
begin
  perform timeclock.assert_claims();
  v_tenant_id := timeclock.jwt_tenant_id();
  v_agent_id  := timeclock.jwt_agent_id();

  if p_client_uuid is null then
    raise sqlstate 'PT400' using
      message = 'client_uuid is required',
      hint    = 'Generate a UUID in the browser before the request so retries are idempotent.';
  end if;

  begin
    v_type := p_event_type::timeclock.punch_event_type;
  exception when invalid_text_representation then
    raise sqlstate 'PT400' using message = pg_catalog.format('unknown event type %L', p_event_type);
  end;

  perform timeclock.lock_agent(v_agent_id);

  -- Idempotent replay: same client_uuid means the caller is retrying, not
  -- punching again. Return the state as if the original call had just succeeded.
  select * into v_existing
  from timeclock.punch_event pe
  where pe.tenant_id = v_tenant_id and pe.client_uuid = p_client_uuid;

  if v_existing.id is not null then
    if v_existing.event_type <> v_type then
      raise sqlstate 'PT409' using
        message = 'client_uuid already used for a different event type',
        detail  = pg_catalog.format('stored=%s requested=%s', v_existing.event_type, v_type);
    end if;
    -- Report what the ORIGINAL call did, not what a fresh call would do: a client
    -- retrying after a lost response is asking "did my punch land, and did it go to
    -- payroll?", and answering false for a punch that did enqueue is a lie.
    return timeclock.snapshot(v_agent_id, v_now)
           || jsonb_build_object(
                'eventId', v_existing.id,
                'idempotentReplay', true,
                'enqueuedToHris', exists (
                  select 1 from timeclock.hris_outbox o
                  where o.punch_event_id = v_existing.id and o.kind = 'PUNCH'));
  end if;

  select * into a from timeclock.agent where id = v_agent_id and tenant_id = v_tenant_id;
  if a.id is null then
    raise sqlstate 'PT404' using message = 'agent not found for these claims';
  end if;
  if not a.active then
    raise sqlstate 'PT403' using message = 'agent is inactive';
  end if;

  select ps.status into v_status from timeclock.project_shift(v_agent_id, v_now) ps;
  select t.to_status into v_to
  from timeclock.transition t
  where t.from_status = v_status and t.event_type = v_type;

  if v_to is null then
    raise sqlstate 'PT409' using
      message = pg_catalog.format('cannot %s while %s', v_type, v_status),
      detail  = jsonb_build_object('code', 'INVALID_TRANSITION',
                                   'from', v_status, 'event', v_type)::text,
      hint    = 'Refresh the snapshot — another tab or a supervisor may have moved this agent.';
  end if;

  insert into timeclock.punch_event
    (tenant_id, agent_id, event_type, event_time, source, session_id,
     status, note, created_by_id, client_uuid)
  values
    (v_tenant_id, v_agent_id, v_type, v_now, 'WIDGET', p_session_id,
     'ACTIVE', nullif(pg_catalog.btrim(coalesce(p_note, '')), ''), v_agent_id, p_client_uuid)
  returning id into v_event_id;

  -- Transactional outbox. Only IN/OUT ever leave the app (CLAUDE.md decision #2),
  -- and only once the agent is mapped to an HRIS employee.
  if v_type in ('IN', 'OUT') and a.hris_employee_id is not null then
    insert into timeclock.hris_outbox (tenant_id, punch_event_id, kind, payload)
    values (v_tenant_id, v_event_id, 'PUNCH', timeclock.canonical_punch(v_event_id));
    v_enqueued := true;
  end if;

  perform timeclock.notify_roster(v_tenant_id, 'punch',
    jsonb_build_object('agentId', v_agent_id, 'status', v_to, 'eventType', v_type));

  return timeclock.snapshot(v_agent_id, v_now)
         || jsonb_build_object('eventId', v_event_id,
                               'idempotentReplay', false,
                               'enqueuedToHris', v_enqueued);
end
$$;

-- ------------------------------------------------------------------ status
create or replace function tc_api.status()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform timeclock.assert_claims();
  return timeclock.snapshot(timeclock.jwt_agent_id(), clock_timestamp());
end
$$;

-- ------------------------------------------------------- submit_correction
-- Orphan repair. The agent documents the missing END either as a wall-clock time
-- or as a duration from the opening event (resolveProposedTime() in
-- packages/core/src/orphanDetection.ts), attests to it, and the event lands
-- PENDING_APPROVAL. Nothing reaches the HRIS until a supervisor decides.
create or replace function tc_api.submit_correction(
  p_missing_event_type text,
  p_attestation        text,
  p_client_uuid        uuid,
  p_proposed_time_utc  timestamptz default null,
  p_proposed_minutes   int default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_agent_id  uuid;
  v_now       timestamptz := clock_timestamp();
  v_type      timeclock.punch_event_type;
  v_snap      jsonb;
  v_orphan    jsonb;
  v_expected  text;
  v_opened_at timestamptz;
  v_opening   uuid;
  v_resolved  timestamptz;
  v_event_id  uuid;
  v_attest    text;
begin
  perform timeclock.assert_claims();
  v_tenant_id := timeclock.jwt_tenant_id();
  v_agent_id  := timeclock.jwt_agent_id();

  v_attest := nullif(pg_catalog.btrim(coalesce(p_attestation, '')), '');
  if v_attest is null then
    raise sqlstate 'PT400' using message = 'attestation is required';
  end if;
  if pg_catalog.char_length(v_attest) > 300 then
    raise sqlstate 'PT400' using
      message = 'attestation must be <= 300 characters',
      hint    = 'The HRIS note field truncates beyond 300.';
  end if;
  if (p_proposed_time_utc is null) = (p_proposed_minutes is null) then
    raise sqlstate 'PT400' using
      message = 'supply exactly one of proposed_time_utc or proposed_minutes';
  end if;
  if p_client_uuid is null then
    raise sqlstate 'PT400' using message = 'client_uuid is required';
  end if;

  perform timeclock.lock_agent(v_agent_id);

  if exists (select 1 from timeclock.punch_event pe
             where pe.tenant_id = v_tenant_id and pe.client_uuid = p_client_uuid) then
    return timeclock.snapshot(v_agent_id, v_now) || jsonb_build_object('idempotentReplay', true);
  end if;

  if exists (select 1 from timeclock.punch_event pe
             where pe.agent_id = v_agent_id and pe.status = 'PENDING_APPROVAL') then
    raise sqlstate 'PT409' using
      message = 'a correction is already awaiting supervisor approval';
  end if;

  v_snap   := timeclock.snapshot(v_agent_id, v_now);
  v_orphan := v_snap -> 'openOrphan';
  if v_orphan is null or v_orphan = 'null'::jsonb then
    raise sqlstate 'PT409' using
      message = 'no open orphan to correct',
      hint    = 'Corrections are only accepted for an unpaired IN/BREAK_START/LUNCH_START past its threshold.';
  end if;

  v_expected := case v_orphan ->> 'kind'
                  when 'ORPHAN_IN'    then 'OUT'
                  when 'ORPHAN_BREAK' then 'BREAK_END'
                  when 'ORPHAN_LUNCH' then 'LUNCH_END'
                end;
  if p_missing_event_type <> v_expected then
    raise sqlstate 'PT400' using
      message = pg_catalog.format('open orphan is %s, which needs a %s (got %s)',
                                  v_orphan ->> 'kind', v_expected, p_missing_event_type);
  end if;
  v_type := v_expected::timeclock.punch_event_type;

  -- The event being corrected is the unpaired opener still in the open stream.
  -- Matched by type and recency rather than by the snapshot's timestamp: the wire
  -- format is millisecond-truncated (timeclock.iso), stored times are microseconds.
  select pe.id, pe.event_time into v_opening, v_opened_at
  from timeclock.open_stream(v_agent_id, v_now) pe
  where pe.event_type = (case v_type when 'OUT'       then 'IN'
                                     when 'BREAK_END' then 'BREAK_START'
                                     when 'LUNCH_END' then 'LUNCH_START'
                         end)::timeclock.punch_event_type
  order by pe.event_time desc, pe.seq desc
  limit 1;

  if v_opening is null then
    raise sqlstate 'PT409' using
      message = 'the unpaired event is no longer in the open stream',
      hint    = 'Refresh and resubmit.';
  end if;

  v_resolved := coalesce(p_proposed_time_utc, v_opened_at + pg_catalog.make_interval(mins => p_proposed_minutes));

  if v_resolved <= v_opened_at then
    raise sqlstate 'PT400' using message = 'proposed time must be after the unpaired event';
  end if;
  if v_resolved > v_now then
    raise sqlstate 'PT400' using message = 'proposed time cannot be in the future';
  end if;

  insert into timeclock.punch_event
    (tenant_id, agent_id, event_type, event_time, source, status,
     correction_of_id, note, created_by_id, client_uuid)
  values
    (v_tenant_id, v_agent_id, v_type, v_resolved, 'WIDGET', 'PENDING_APPROVAL',
     v_opening, v_attest, v_agent_id, p_client_uuid)
  returning id into v_event_id;

  perform timeclock.notify_roster(v_tenant_id, 'correction_submitted',
    jsonb_build_object('agentId', v_agent_id, 'eventId', v_event_id, 'eventType', v_type));

  return timeclock.snapshot(v_agent_id, v_now)
         || jsonb_build_object('correctionEventId', v_event_id, 'idempotentReplay', false);
end
$$;

-- ------------------------------------------------------------------ ledger
-- Closed shifts for the agent's own timesheet view and for payroll export.
create or replace function timeclock.shifts(
  p_agent_id uuid,
  p_from     timestamptz,
  p_to       timestamptz
) returns table (
  shift_start timestamptz,
  shift_end   timestamptz,
  worked_ms   bigint,
  break_ms    bigint,
  lunch_ms    bigint,
  lunch_start timestamptz,
  lunch_end   timestamptz,
  breaks      int,
  complete    boolean
)
language plpgsql
stable
set search_path = ''
as $$
declare
  r      record;
  v_stat timeclock.agent_status := 'CLOCKED_OUT';
  v_to   timeclock.agent_status;
  v_cis  timestamptz;
begin
  shift_start := null; break_ms := 0; lunch_ms := 0; breaks := 0;
  lunch_start := null; lunch_end := null;

  for r in
    select pe.* from timeclock.punch_event pe
    where pe.agent_id = p_agent_id
      and pe.status = 'ACTIVE'
      and pe.event_time >= p_from
      and pe.event_time <  p_to
    order by pe.event_time asc, pe.seq asc
  loop
    v_to := null;
    select t.to_status into v_to from timeclock.transition t
    where t.from_status = v_stat and t.event_type = r.event_type;
    if v_to is null then continue; end if;   -- anomaly; the reconciler owns it
    v_stat := v_to;

    if r.event_type = 'IN' then
      shift_start := r.event_time; break_ms := 0; lunch_ms := 0; breaks := 0;
      lunch_start := null; lunch_end := null;
    elsif r.event_type = 'BREAK_END' and v_cis is not null then
      break_ms := break_ms + (extract(epoch from (r.event_time - v_cis)) * 1000)::bigint;
      breaks := breaks + 1;
    elsif r.event_type = 'LUNCH_START' then
      if lunch_start is null then lunch_start := r.event_time; end if;
    elsif r.event_type = 'LUNCH_END' and v_cis is not null then
      lunch_ms := lunch_ms + (extract(epoch from (r.event_time - v_cis)) * 1000)::bigint;
      if lunch_end is null then lunch_end := r.event_time; end if;
    elsif r.event_type = 'OUT' and shift_start is not null then
      shift_end := r.event_time;
      worked_ms := (extract(epoch from (shift_end - shift_start)) * 1000)::bigint;
      complete  := true;
      return next;
      shift_start := null; shift_end := null;
    end if;
    v_cis := r.event_time;
  end loop;

  -- Trailing open shift, reported as incomplete.
  if shift_start is not null then
    shift_end := null;
    worked_ms := (extract(epoch from (least(p_to, clock_timestamp()) - shift_start)) * 1000)::bigint;
    complete  := false;
    return next;
  end if;
  return;
end
$$;

create or replace function tc_api.my_ledger(p_days int default 7)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agent_id uuid;
  v_tz       text;
  v_from     timestamptz;
  v_rows     jsonb;
begin
  perform timeclock.assert_claims();
  v_agent_id := timeclock.jwt_agent_id();
  if p_days is null or p_days < 1 or p_days > 90 then
    raise sqlstate 'PT400' using message = 'p_days must be between 1 and 90';
  end if;

  select a.timezone into v_tz from timeclock.agent a where a.id = v_agent_id;
  if v_tz is null then
    raise sqlstate 'PT404' using message = 'agent not found for these claims';
  end if;
  v_from := clock_timestamp() - pg_catalog.make_interval(days => p_days);

  select coalesce(jsonb_agg(x order by x ->> 'workDate' desc, x ->> 'shiftStartUtc' desc), '[]'::jsonb)
    into v_rows
  from (
    select jsonb_build_object(
             'workDate',      ((s.shift_start at time zone v_tz)::date)::text,
             'shiftStartUtc', timeclock.iso(s.shift_start),
             'shiftEndUtc',   timeclock.iso(s.shift_end),
             'workedMs',      s.worked_ms,
             'breakMs',       s.break_ms,
             'lunchMs',       s.lunch_ms,
             'lunchStartUtc', timeclock.iso(s.lunch_start),
             'lunchEndUtc',   timeclock.iso(s.lunch_end),
             'breaks',        s.breaks,
             'complete',      s.complete
           ) as x
    from timeclock.shifts(v_agent_id, v_from, clock_timestamp() + interval '1 minute') s
  ) q;

  return jsonb_build_object(
    'timezone', v_tz,
    'shifts',   v_rows,
    'exceptions', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'workDate', ce.work_date::text,
               'type', ce.type,
               'status', ce.status,
               'premiumHourPayable', ce.premium_hour_payable,
               'premiumDelivered', ce.premium_delivered)
             order by ce.work_date desc), '[]'::jsonb)
      from timeclock.compliance_exception ce
      where ce.agent_id = v_agent_id
        and ce.work_date >= (v_from at time zone v_tz)::date
    )
  );
end
$$;

-- ------------------------------------------------------------------- grants
revoke all on function tc_api.punch(text, uuid, text, text) from public;
revoke all on function tc_api.status() from public;
revoke all on function tc_api.submit_correction(text, text, uuid, timestamptz, int) from public;
revoke all on function tc_api.my_ledger(int) from public;

grant execute on function tc_api.punch(text, uuid, text, text)                          to authenticated;
grant execute on function tc_api.status()                                               to authenticated;
grant execute on function tc_api.submit_correction(text, text, uuid, timestamptz, int)  to authenticated;
grant execute on function tc_api.my_ledger(int)                                         to authenticated;

reset role;
