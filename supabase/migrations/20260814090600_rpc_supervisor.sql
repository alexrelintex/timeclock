-- =============================================================================
-- 60 · SUPERVISOR RPCs — roster, correction decisions, exception intake
-- =============================================================================
-- Supervisor authority comes from the tc.role claim, which apps/api sets only
-- after reading agent.is_supervisor from the database — never from anything the
-- host page asserts about the user's role.
-- =============================================================================

set role tc_owner;

create or replace function timeclock.assert_supervisor()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  perform timeclock.assert_claims();
  if not timeclock.jwt_is_supervisor() then
    raise sqlstate 'PT403' using message = 'supervisor role required';
  end if;
end
$$;

-- ------------------------------------------------------------------ roster
-- One round trip for the whole live board: per-agent projection, open orphans,
-- pending corrections, and the coverage numerator/denominator the recommender in
-- packages/core/src/coverage.ts needs.
create or replace function tc_api.roster()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_now       timestamptz := clock_timestamp();
  t           timeclock.tenant;
  v_agents    jsonb;
begin
  perform timeclock.assert_supervisor();
  v_tenant_id := timeclock.jwt_tenant_id();
  select * into t from timeclock.tenant where id = v_tenant_id;

  select coalesce(jsonb_agg(timeclock.snapshot(a.id, v_now) order by a.display_name), '[]'::jsonb)
    into v_agents
  from timeclock.agent a
  where a.tenant_id = v_tenant_id and a.active;

  return jsonb_build_object(
    'serverNowUtc', timeclock.iso(v_now),
    'tenant', jsonb_build_object(
      'id', t.id, 'name', t.name, 'timezone', t.timezone,
      'breakMinutes', t.break_minutes,
      'lunchMinMinutes', t.lunch_min_minutes,
      'lunchMaxMinutes', t.lunch_max_minutes,
      'coverageThresholdPct', t.coverage_threshold_pct,
      'mealAlertTiers', t.meal_alert_tiers,
      'caMealRulesEnabled', t.ca_meal_rules_enabled),
    'agents', v_agents,
    'coverage', jsonb_build_object(
      'scheduled', jsonb_array_length(v_agents),
      'active',    (select count(*) from jsonb_array_elements(v_agents) e
                    where e ->> 'status' = 'ACTIVE'),
      'onBreak',   (select count(*) from jsonb_array_elements(v_agents) e
                    where e ->> 'status' = 'ON_BREAK'),
      'onLunch',   (select count(*) from jsonb_array_elements(v_agents) e
                    where e ->> 'status' = 'ON_LUNCH'),
      'clockedOut',(select count(*) from jsonb_array_elements(v_agents) e
                    where e ->> 'status' = 'CLOCKED_OUT')),
    'pendingCorrections', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'eventId', pe.id,
               'agentId', pe.agent_id,
               'agentName', a.display_name,
               'eventType', pe.event_type,
               'proposedTimeUtc', timeclock.iso(pe.event_time),
               'submittedAtUtc', timeclock.iso(pe.created_at),
               'attestation', pe.note,
               'syncsToHris', pe.event_type in ('IN', 'OUT') and a.hris_employee_id is not null
             ) order by pe.seq asc), '[]'::jsonb)
      from timeclock.punch_event pe
      join timeclock.agent a on a.id = pe.agent_id
      where pe.tenant_id = v_tenant_id and pe.status = 'PENDING_APPROVAL'),
    'openExceptions', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', ce.id, 'agentId', ce.agent_id, 'workDate', ce.work_date::text,
               'type', ce.type, 'premiumHourPayable', ce.premium_hour_payable,
               'premiumDelivered', ce.premium_delivered)
             order by ce.work_date desc), '[]'::jsonb)
      from timeclock.compliance_exception ce
      where ce.tenant_id = v_tenant_id and ce.status = 'OPEN')
  );
end
$$;

-- ------------------------------------------------------- decide_correction
-- Our decision is authoritative; the HRIS mirrors it (CLAUDE.md, verified Paycor
-- missed-punch round trip). Break/lunch corrections are resolved entirely in-app
-- and never enqueue anything.
create or replace function tc_api.decide_correction(
  p_event_id uuid,
  p_approve  boolean,
  p_note     text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_actor     uuid;
  v_now       timestamptz := clock_timestamp();
  pe          timeclock.punch_event;
  a           timeclock.agent;
  v_status    timeclock.agent_status;
  v_enqueued  boolean := false;
begin
  perform timeclock.assert_supervisor();
  v_tenant_id := timeclock.jwt_tenant_id();
  v_actor     := timeclock.jwt_agent_id();

  select * into pe from timeclock.punch_event
  where id = p_event_id and tenant_id = v_tenant_id;
  if pe.id is null then
    raise sqlstate 'PT404' using message = 'correction not found';
  end if;
  if pe.status <> 'PENDING_APPROVAL' then
    raise sqlstate 'PT409' using
      message = pg_catalog.format('correction is %s, not PENDING_APPROVAL', pe.status);
  end if;

  perform timeclock.lock_agent(pe.agent_id);
  select * into a from timeclock.agent where id = pe.agent_id;

  if p_approve then
    -- Re-check the guard: the agent may have punched in the meantime, in which
    -- case the correction no longer applies to the open stream.
    select ps.status into v_status from timeclock.project_shift(pe.agent_id, v_now) ps;
    if not timeclock.can_transition(v_status, pe.event_type) then
      raise sqlstate 'PT409' using
        message = pg_catalog.format('cannot apply %s while agent is %s', pe.event_type, v_status),
        hint    = 'The stream moved on. Reject this correction and have the agent resubmit.';
    end if;

    update timeclock.punch_event
       set status = 'ACTIVE', approved_by_id = v_actor, approved_at = v_now
     where id = pe.id;

    if pe.event_type in ('IN', 'OUT') and a.hris_employee_id is not null then
      insert into timeclock.hris_outbox (tenant_id, punch_event_id, kind, payload)
      values (v_tenant_id, pe.id, 'MISSED_PUNCH_REQUEST', jsonb_build_object(
        'correctionEventId', pe.id,
        'hrisEmployeeId',    a.hris_employee_id,
        'proposedType',      pe.event_type,
        'proposedTimeUtc',   timeclock.iso(pe.event_time),
        'agentTimezone',     a.timezone,
        'note',              pg_catalog.left(coalesce(p_note, pe.note, ''), 300)));
      v_enqueued := true;
    end if;
  else
    -- approved_by_id doubles as "decided by"; punch_event_mutation records the
    -- direction of the decision along with the acting role and claims.
    update timeclock.punch_event
       set status = 'REJECTED', approved_by_id = v_actor, approved_at = v_now
     where id = pe.id;
  end if;

  perform timeclock.notify_roster(v_tenant_id, 'correction_decided',
    jsonb_build_object('agentId', pe.agent_id, 'eventId', pe.id, 'approved', p_approve));

  return jsonb_build_object(
    'eventId', pe.id,
    'approved', p_approve,
    'enqueuedToHris', v_enqueued,
    'agent', timeclock.snapshot(pe.agent_id, v_now));
end
$$;

-- -------------------------------------------------------- punch_for_agent
-- Supervisor-assisted punch (kiosk help, agent locked out of the CRM). Source is
-- recorded as SUPERVISOR and a reason is mandatory, so the audit trail always
-- shows why someone else touched the stream.
create or replace function tc_api.punch_for_agent(
  p_agent_id    uuid,
  p_event_type  text,
  p_client_uuid uuid,
  p_reason      text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_actor     uuid;
  v_now       timestamptz := clock_timestamp();
  v_type      timeclock.punch_event_type;
  v_status    timeclock.agent_status;
  a           timeclock.agent;
  v_event_id  uuid;
  v_reason    text;
  v_enqueued  boolean := false;
begin
  perform timeclock.assert_supervisor();
  v_tenant_id := timeclock.jwt_tenant_id();
  v_actor     := timeclock.jwt_agent_id();

  v_reason := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise sqlstate 'PT400' using message = 'a reason is required for a supervisor punch';
  end if;
  if p_client_uuid is null then
    raise sqlstate 'PT400' using message = 'client_uuid is required';
  end if;

  begin
    v_type := p_event_type::timeclock.punch_event_type;
  exception when invalid_text_representation then
    raise sqlstate 'PT400' using message = pg_catalog.format('unknown event type %L', p_event_type);
  end;

  select * into a from timeclock.agent where id = p_agent_id and tenant_id = v_tenant_id;
  if a.id is null then
    raise sqlstate 'PT404' using message = 'agent not found in this tenant';
  end if;

  perform timeclock.lock_agent(p_agent_id);

  if exists (select 1 from timeclock.punch_event pe
             where pe.tenant_id = v_tenant_id and pe.client_uuid = p_client_uuid) then
    return timeclock.snapshot(p_agent_id, v_now) || jsonb_build_object('idempotentReplay', true);
  end if;

  select ps.status into v_status from timeclock.project_shift(p_agent_id, v_now) ps;
  if not timeclock.can_transition(v_status, v_type) then
    raise sqlstate 'PT409' using
      message = pg_catalog.format('cannot %s while %s', v_type, v_status);
  end if;

  insert into timeclock.punch_event
    (tenant_id, agent_id, event_type, event_time, source, status,
     note, created_by_id, client_uuid)
  values
    (v_tenant_id, p_agent_id, v_type, v_now, 'SUPERVISOR', 'ACTIVE',
     pg_catalog.left(v_reason, 300), v_actor, p_client_uuid)
  returning id into v_event_id;

  if v_type in ('IN', 'OUT') and a.hris_employee_id is not null then
    insert into timeclock.hris_outbox (tenant_id, punch_event_id, kind, payload)
    values (v_tenant_id, v_event_id, 'PUNCH', timeclock.canonical_punch(v_event_id));
    v_enqueued := true;
  end if;

  perform timeclock.notify_roster(v_tenant_id, 'punch',
    jsonb_build_object('agentId', p_agent_id, 'eventType', v_type, 'bySupervisor', true));

  return timeclock.snapshot(p_agent_id, v_now)
         || jsonb_build_object('eventId', v_event_id, 'enqueuedToHris', v_enqueued);
end
$$;

-- ------------------------------------------------------- record_exception
-- Intake for the compliance verdicts computed in packages/core (meal deadline,
-- orphan detection). Idempotent on (tenant, agent, work_date, type), which is
-- also what makes CA Labor Code 226.7(c) "one premium hour per workday"
-- structurally true rather than merely intended.
create or replace function tc_api.record_exception(
  p_agent_id             uuid,
  p_work_date            date,
  p_type                 text,
  p_related_event_ids    uuid[] default '{}',
  p_premium_hour_payable boolean default false,
  p_resolution           text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_type      timeclock.exception_type;
  a           timeclock.agent;
  t           timeclock.tenant;
  ce          timeclock.compliance_exception;
  v_premium   boolean;
begin
  perform timeclock.assert_claims();
  v_tenant_id := timeclock.jwt_tenant_id();

  if p_agent_id <> timeclock.jwt_agent_id() and not timeclock.jwt_is_supervisor() then
    raise sqlstate 'PT403' using message = 'cannot record an exception for another agent';
  end if;

  begin
    v_type := p_type::timeclock.exception_type;
  exception when invalid_text_representation then
    raise sqlstate 'PT400' using message = pg_catalog.format('unknown exception type %L', p_type);
  end;

  select * into a from timeclock.agent where id = p_agent_id and tenant_id = v_tenant_id;
  if a.id is null then
    raise sqlstate 'PT404' using message = 'agent not found in this tenant';
  end if;
  select * into t from timeclock.tenant where id = v_tenant_id;

  -- CA Labor Code 226.7(c) allows ONE premium hour per workday for a non-provided
  -- meal period, not one per violation type. A day that is both LATE_MEAL and
  -- SHORT_MEAL still owes a single hour, so the second exception is recorded for
  -- the audit trail with the premium suppressed. Without this, a day with two
  -- meal findings would enqueue two pay items and overpay.
  v_premium := coalesce(p_premium_hour_payable, false);
  if v_premium and exists (
       select 1 from timeclock.compliance_exception ce2
       where ce2.tenant_id = v_tenant_id
         and ce2.agent_id  = p_agent_id
         and ce2.work_date = p_work_date
         and ce2.type <> v_type
         and ce2.premium_hour_payable
         and ce2.type in ('LATE_MEAL', 'SHORT_MEAL', 'MISSED_MEAL')
         and v_type in ('LATE_MEAL', 'SHORT_MEAL', 'MISSED_MEAL')
     ) then
    v_premium := false;
    p_resolution := coalesce(p_resolution, '') ||
      ' [premium suppressed: one 226.7(c) hour already payable for this workday]';
  end if;

  insert into timeclock.compliance_exception
    (tenant_id, agent_id, work_date, type, related_event_ids, premium_hour_payable, resolution)
  values
    (v_tenant_id, p_agent_id, p_work_date, v_type,
     coalesce(p_related_event_ids, '{}'), v_premium, p_resolution)
  on conflict (tenant_id, agent_id, work_date, type) do update
    set related_event_ids   = excluded.related_event_ids,
        -- Never downgrade a premium once it has been determined payable.
        premium_hour_payable = timeclock.compliance_exception.premium_hour_payable
                                 or excluded.premium_hour_payable,
        resolution          = coalesce(excluded.resolution, timeclock.compliance_exception.resolution)
  returning * into ce;

  -- Premium delivery: one pay item per exception, enforced by the partial unique
  -- index on hris_outbox(exception_id) where kind = 'PAY_ITEM'.
  if ce.premium_hour_payable
     and not ce.premium_delivered
     and a.hris_employee_id is not null
     and t.hris_premium_earning_ref is not null then
    insert into timeclock.hris_outbox (tenant_id, exception_id, kind, payload)
    values (v_tenant_id, ce.id, 'PAY_ITEM', jsonb_build_object(
      'exceptionId',    ce.id,
      'hrisEmployeeId', a.hris_employee_id,
      'earningCodeRef', t.hris_premium_earning_ref,
      'hours',          1,
      'workDate',       ce.work_date::text,
      'note',           pg_catalog.left(coalesce(p_resolution, v_type::text), 300)))
    on conflict (exception_id) where kind = 'PAY_ITEM' do nothing;
  end if;

  perform timeclock.notify_roster(v_tenant_id, 'exception',
    jsonb_build_object('agentId', p_agent_id, 'type', v_type,
                       'premium', ce.premium_hour_payable));

  return jsonb_build_object(
    'id', ce.id, 'agentId', ce.agent_id, 'workDate', ce.work_date::text,
    'type', ce.type, 'status', ce.status,
    'premiumHourPayable', ce.premium_hour_payable,
    'premiumDelivered', ce.premium_delivered);
end
$$;

create or replace function tc_api.resolve_exception(
  p_exception_id uuid,
  p_status       text,
  p_resolution   text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status timeclock.exception_status;
  ce       timeclock.compliance_exception;
begin
  perform timeclock.assert_supervisor();
  begin
    v_status := p_status::timeclock.exception_status;
  exception when invalid_text_representation then
    raise sqlstate 'PT400' using message = pg_catalog.format('unknown status %L', p_status);
  end;
  if v_status not in ('RESOLVED', 'DISMISSED') then
    raise sqlstate 'PT400' using message = 'status must be RESOLVED or DISMISSED';
  end if;

  update timeclock.compliance_exception
     set status = v_status,
         resolution = coalesce(p_resolution, resolution),
         resolved_by_id = timeclock.jwt_agent_id(),
         resolved_at = clock_timestamp()
   where id = p_exception_id
     and tenant_id = timeclock.jwt_tenant_id()
  returning * into ce;

  if ce.id is null then
    raise sqlstate 'PT404' using message = 'exception not found';
  end if;
  return jsonb_build_object('id', ce.id, 'status', ce.status);
end
$$;

-- --------------------------------------------------------------- audit_trail
-- Compliance export for one agent: the raw event stream, every status mutation,
-- and the hash-chain verification. This is what gets handed over when the app is
-- the sole meal-period record.
create or replace function tc_api.audit_trail(
  p_agent_id uuid,
  p_from     timestamptz,
  p_to       timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
begin
  perform timeclock.assert_supervisor();
  v_tenant_id := timeclock.jwt_tenant_id();
  if not exists (select 1 from timeclock.agent where id = p_agent_id and tenant_id = v_tenant_id) then
    raise sqlstate 'PT404' using message = 'agent not found in this tenant';
  end if;

  return jsonb_build_object(
    'agentId', p_agent_id,
    'fromUtc', timeclock.iso(p_from),
    'toUtc',   timeclock.iso(p_to),
    'events', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', pe.id, 'eventType', pe.event_type,
               'eventTimeUtc', timeclock.iso(pe.event_time),
               'source', pe.source, 'status', pe.status,
               'correctionOfId', pe.correction_of_id, 'note', pe.note,
               'createdById', pe.created_by_id, 'approvedById', pe.approved_by_id,
               'createdAtUtc', timeclock.iso(pe.created_at),
               'prevHash', pe.prev_hash, 'selfHash', pe.self_hash)
             order by pe.event_time asc), '[]'::jsonb)
      from timeclock.punch_event pe
      where pe.agent_id = p_agent_id and pe.event_time >= p_from and pe.event_time < p_to),
    'mutations', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'punchEventId', m.punch_event_id, 'fromStatus', m.from_status,
               'toStatus', m.to_status, 'actorId', m.actor_id, 'dbRole', m.db_role,
               'mutatedAtUtc', timeclock.iso(m.mutated_at))
             order by m.mutated_at asc), '[]'::jsonb)
      from timeclock.punch_event_mutation m
      join timeclock.punch_event pe on pe.id = m.punch_event_id
      where pe.agent_id = p_agent_id),
    'chainProblems', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'punchEventId', v.punch_event_id,
               'eventTimeUtc', timeclock.iso(v.event_time),
               'problem', v.problem)), '[]'::jsonb)
      from timeclock.verify_chain(v_tenant_id, p_agent_id) v)
  );
end
$$;

-- ------------------------------------------------------------------- grants
revoke all on function tc_api.roster() from public;
revoke all on function tc_api.decide_correction(uuid, boolean, text) from public;
revoke all on function tc_api.punch_for_agent(uuid, text, uuid, text) from public;
revoke all on function tc_api.record_exception(uuid, date, text, uuid[], boolean, text) from public;
revoke all on function tc_api.resolve_exception(uuid, text, text) from public;
revoke all on function tc_api.audit_trail(uuid, timestamptz, timestamptz) from public;

grant execute on function tc_api.roster()                                                  to authenticated;
grant execute on function tc_api.decide_correction(uuid, boolean, text)                    to authenticated;
grant execute on function tc_api.punch_for_agent(uuid, text, uuid, text)                   to authenticated;
grant execute on function tc_api.record_exception(uuid, date, text, uuid[], boolean, text) to authenticated, service_role;
grant execute on function tc_api.resolve_exception(uuid, text, text)                       to authenticated;
grant execute on function tc_api.audit_trail(uuid, timestamptz, timestamptz)               to authenticated;

reset role;
