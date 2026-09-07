-- =============================================================================
-- 40 · PROJECTION — status is derived, never stored
-- =============================================================================
-- SQL mirror of packages/core/src/stateMachine.ts. It has to live in the database
-- because the transition guard must be evaluated in the SAME transaction that
-- appends the event; projecting in Node and then inserting is a race (two taps,
-- two tabs, an offline replay landing next to a live punch) that would let an
-- agent be ACTIVE twice or clock out while ON_LUNCH.
--
-- What deliberately does NOT live here: the CA meal-period evaluator, orphan
-- batch detection and the coverage recommender. Those stay single-sourced in
-- packages/core (TypeScript) because they are policy, not integrity — the widget
-- and the supervisor panel need the same math client-side, and duplicating CA
-- rules in plpgsql would create a third copy that drifts.
--   Integrity  -> Postgres (this file, migrations 20/30/50)
--   Policy     -> packages/core, results written back via tc_api.record_exception
-- =============================================================================

set role tc_owner;

-- Deterministic UTC ISO-8601 rendering. to_json() on a timestamptz honours
-- DateStyle/TimeZone GUCs; the widget parses these strings with new Date(), so
-- the format is pinned here rather than left to session settings.
create or replace function timeclock.iso(p_ts timestamptz)
returns text
language sql
immutable
set search_path = ''
as $$ select pg_catalog.to_char(p_ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

-- Events belonging to the agent's currently open shift: everything after the
-- last ACTIVE OUT, or an 18-hour lookback if they have never clocked out (which
-- is itself an orphan condition — max_shift_minutes defaults to 14h).
create or replace function timeclock.open_stream(p_agent_id uuid, p_now timestamptz)
returns setof timeclock.punch_event
language sql
stable
set search_path = ''
as $$
  with last_out as (
    select max(pe.event_time) as t
    from timeclock.punch_event pe
    where pe.agent_id = p_agent_id
      and pe.status = 'ACTIVE'
      and pe.event_type = 'OUT'
      and pe.event_time <= p_now
  )
  select pe.*
  from timeclock.punch_event pe, last_out
  where pe.agent_id = p_agent_id
    and pe.status = 'ACTIVE'
    and pe.event_time <= p_now
    and pe.event_time > coalesce(last_out.t, p_now - interval '18 hours')
  order by pe.event_time asc, pe.seq asc
$$;

create or replace function timeclock.can_transition(
  p_from timeclock.agent_status,
  p_event timeclock.punch_event_type
) returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from timeclock.transition t
    where t.from_status = p_from and t.event_type = p_event
  )
$$;

-- Tolerant fold, matching projectShift(): an inapplicable event is counted as an
-- anomaly rather than throwing, because a historical stream can legitimately
-- contain orphans that are still awaiting correction.
create or replace function timeclock.project_shift(
  p_agent_id uuid,
  p_now timestamptz default now()
) returns table (
  status                 timeclock.agent_status,
  shift_start            timestamptz,
  current_interval_start timestamptz,
  worked_ms              bigint,
  break_ms               bigint,
  lunch_ms               bigint,
  lunch_start            timestamptz,
  lunch_end              timestamptz,
  breaks_taken           int,
  anomaly_count          int
)
language plpgsql
stable
set search_path = ''
as $$
declare
  r  record;
  v_to timeclock.agent_status;
begin
  status                 := 'CLOCKED_OUT';
  shift_start            := null;
  current_interval_start := null;
  worked_ms              := 0;
  break_ms               := 0;
  lunch_ms               := 0;
  lunch_start            := null;
  lunch_end              := null;
  breaks_taken           := 0;
  anomaly_count          := 0;

  for r in select * from timeclock.open_stream(p_agent_id, p_now) loop
    v_to := null;
    select t.to_status into v_to
    from timeclock.transition t
    where t.from_status = status and t.event_type = r.event_type;

    if v_to is null then
      anomaly_count := anomaly_count + 1;
      continue;
    end if;
    status := v_to;

    if r.event_type = 'IN' then
      shift_start := r.event_time;
    elsif r.event_type = 'OUT' then
      shift_start := null;
    elsif r.event_type = 'BREAK_END' and current_interval_start is not null then
      break_ms := break_ms + (extract(epoch from (r.event_time - current_interval_start)) * 1000)::bigint;
      breaks_taken := breaks_taken + 1;
    elsif r.event_type = 'LUNCH_START' then
      if lunch_start is null then lunch_start := r.event_time; end if;
    elsif r.event_type = 'LUNCH_END' and current_interval_start is not null then
      lunch_ms := lunch_ms + (extract(epoch from (r.event_time - current_interval_start)) * 1000)::bigint;
      if lunch_end is null then lunch_end := r.event_time; end if;
    end if;

    current_interval_start := r.event_time;
  end loop;

  -- Accrue the still-open interval up to p_now.
  if status = 'ON_BREAK' and current_interval_start is not null then
    break_ms := break_ms + (extract(epoch from (p_now - current_interval_start)) * 1000)::bigint;
  elsif status = 'ON_LUNCH' and current_interval_start is not null then
    lunch_ms := lunch_ms + (extract(epoch from (p_now - current_interval_start)) * 1000)::bigint;
  end if;

  -- Breaks and lunch are PAID, so worked time is the contiguous span since IN.
  if shift_start is not null then
    worked_ms := (extract(epoch from (p_now - shift_start)) * 1000)::bigint;
  end if;

  return next;
end
$$;

-- The status snapshot the widget renders. Keys are camelCase to match
-- StatusSnapshot in apps/widget-bs5/src/timeclock.js and
-- apps/widget/src/hooks/useApi.ts — one contract, three consumers.
create or replace function timeclock.snapshot(p_agent_id uuid, p_now timestamptz default now())
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  a  timeclock.agent;
  t  timeclock.tenant;
  p  record;
  v_orphan jsonb := null;
  v_pending jsonb := null;
  v_age_min numeric;
begin
  select * into a from timeclock.agent where id = p_agent_id;
  if a.id is null then
    raise exception 'agent % not visible under current claims', p_agent_id
      using errcode = 'insufficient_privilege';
  end if;
  select * into t from timeclock.tenant where id = a.tenant_id;
  select * into p from timeclock.project_shift(p_agent_id, p_now);

  -- Open orphan (age-based; the batch reconciler in packages/core is authoritative
  -- for writing ComplianceException rows — this is only what the widget needs to
  -- decide whether to offer the correction form).
  if p.status = 'ACTIVE' and p.shift_start is not null then
    v_age_min := extract(epoch from (p_now - p.shift_start)) / 60;
    if v_age_min > t.max_shift_minutes then
      v_orphan := jsonb_build_object('kind', 'ORPHAN_IN',
        'openedAtUtc', timeclock.iso(p.shift_start), 'syncsToHris', true);
    end if;
  elsif p.status = 'ON_BREAK' and p.current_interval_start is not null then
    v_age_min := extract(epoch from (p_now - p.current_interval_start)) / 60;
    if v_age_min > t.max_break_minutes then
      v_orphan := jsonb_build_object('kind', 'ORPHAN_BREAK',
        'openedAtUtc', timeclock.iso(p.current_interval_start), 'syncsToHris', false);
    end if;
  elsif p.status = 'ON_LUNCH' and p.current_interval_start is not null then
    v_age_min := extract(epoch from (p_now - p.current_interval_start)) / 60;
    if v_age_min > t.max_lunch_minutes then
      v_orphan := jsonb_build_object('kind', 'ORPHAN_LUNCH',
        'openedAtUtc', timeclock.iso(p.current_interval_start), 'syncsToHris', false);
    end if;
  end if;

  select jsonb_build_object(
           'id', pe.id,
           'eventType', pe.event_type,
           'eventTimeUtc', timeclock.iso(pe.event_time),
           'submittedAtUtc', timeclock.iso(pe.created_at),
           'attestation', pe.note)
    into v_pending
  from timeclock.punch_event pe
  where pe.agent_id = p_agent_id and pe.status = 'PENDING_APPROVAL'
  order by pe.seq desc
  limit 1;

  return jsonb_build_object(
    'agentId',                a.id,
    'displayName',            a.display_name,
    'timezone',               a.timezone,
    'isSupervisor',           a.is_supervisor,
    'status',                 p.status,
    'serverNowUtc',           timeclock.iso(p_now),
    'shiftStartUtc',          timeclock.iso(p.shift_start),
    'currentIntervalStartUtc',timeclock.iso(p.current_interval_start),
    'lunchStartUtc',          timeclock.iso(p.lunch_start),
    'lunchEndUtc',            timeclock.iso(p.lunch_end),
    'workedMs',               p.worked_ms,
    'breakMs',                p.break_ms,
    'lunchMs',                p.lunch_ms,
    'breaksTaken',            p.breaks_taken,
    'anomalyCount',           p.anomaly_count,
    'breakMinutesConfigured', t.break_minutes,
    'lunchMinConfigured',     t.lunch_min_minutes,
    'lunchMaxConfigured',     t.lunch_max_minutes,
    'mealWaiverOnFile',       a.meal_waiver_on_file,
    'caMealRulesEnabled',     t.ca_meal_rules_enabled,
    'mealAlertTiers',         t.meal_alert_tiers,
    'openOrphan',             v_orphan,
    'pendingCorrection',      v_pending
  );
end
$$;

reset role;
