-- =============================================================================
-- 10 · ENUMS + TABLES — port of prisma/schema.prisma to the Supabase system of record
-- =============================================================================
-- Enum labels are byte-identical to the TypeScript union members in
-- packages/core so a value can round-trip DB -> API -> widget without mapping.
-- Retention: >= 4 years (FLSA 29 CFR 516.5 / 516.6 + CA margin). Nothing here is
-- ever hard-deleted; see migration 20 for the append-only enforcement.
-- =============================================================================

set role tc_owner;

-- ----------------------------------------------------------------- enums
create type timeclock.punch_event_type as enum
  ('IN', 'OUT', 'BREAK_START', 'BREAK_END', 'LUNCH_START', 'LUNCH_END');

create type timeclock.agent_status as enum
  ('CLOCKED_OUT', 'ACTIVE', 'ON_BREAK', 'ON_LUNCH');

create type timeclock.event_source as enum
  ('WIDGET', 'SUPERVISOR', 'SYSTEM', 'IMPORT');

create type timeclock.event_status as enum
  ('ACTIVE', 'SUPERSEDED', 'PENDING_APPROVAL', 'REJECTED');

create type timeclock.exception_type as enum
  ('ORPHAN_IN', 'ORPHAN_BREAK', 'ORPHAN_LUNCH',
   'LATE_MEAL', 'SHORT_MEAL', 'MISSED_MEAL', 'MISSED_REST');

create type timeclock.exception_status as enum
  ('OPEN', 'PENDING_APPROVAL', 'RESOLVED', 'DISMISSED');

create type timeclock.outbox_kind as enum
  ('PUNCH', 'PAY_ITEM', 'MISSED_PUNCH_REQUEST', 'MISSED_PUNCH_DECISION');

create type timeclock.outbox_status as enum
  ('PENDING', 'SUBMITTED', 'DELIVERED', 'FAILED', 'NOT_SUPPORTED');

-- ----------------------------------------------------------------- tenant
create table timeclock.tenant (
  id                     uuid primary key default gen_random_uuid(),
  slug                   text not null unique,          -- data-tenant on the loader tag
  name                   text not null,
  timezone               text not null default 'America/New_York', -- fallback; agent tz wins
  -- Business rules (admin-configurable). Breaks and lunch are PAID here.
  break_minutes          int  not null default 15,
  lunch_min_minutes      int  not null default 30,
  lunch_max_minutes      int  not null default 60,
  coverage_threshold_pct int  not null default 70,
  meal_alert_tiers       jsonb not null default '[60,30,15]'::jsonb,
  ca_meal_rules_enabled  boolean not null default true,
  -- Orphan thresholds (mirror packages/core/src/orphanDetection.ts DEFAULT_THRESHOLDS)
  max_shift_minutes      int  not null default 840,      -- 14h
  max_break_minutes      int  not null default 30,       -- 2x a 15-min break
  max_lunch_minutes      int  not null default 90,       -- lunch_max + 30m grace
  -- HRIS
  hris_provider          text,                           -- 'paycor' | null
  hris_config            jsonb,                          -- legalEntityId, dept/activity maps
  hris_premium_earning_ref text,                         -- Paycor legalEntityEarningId (GUID)
  created_at             timestamptz not null default now(),
  constraint tenant_lunch_range_ck check (lunch_min_minutes <= lunch_max_minutes),
  constraint tenant_coverage_ck    check (coverage_threshold_pct between 0 and 100),
  constraint tenant_tiers_ck       check (jsonb_typeof(meal_alert_tiers) = 'array')
);

-- ----------------------------------------------------------------- agent
create table timeclock.agent (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references timeclock.tenant(id),
  display_name         text not null,
  timezone             text not null,                    -- IANA; drives HRIS local time + meal timers
  is_supervisor        boolean not null default false,
  -- Identity map: host CRM user -> agent -> HRIS employee.
  -- host_user_id is asserted by the host in a signed JWT and verified server-side.
  host_user_id         text not null,
  hris_employee_id     text,                             -- Paycor employee GUID; null until mapped
  hris_department_id   text,                             -- Paycor write requirement (GUID)
  hris_activity_type_id text,
  meal_waiver_on_file  boolean not null default false,   -- CA <=6h shift waiver
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  unique (tenant_id, host_user_id)
);
create index agent_tenant_hris_idx on timeclock.agent (tenant_id, hris_employee_id);

-- ----------------------------------------------------------------- punch_event
-- APPEND-ONLY. Inserts only; the sole permitted UPDATE is a whitelisted status
-- transition (see migration 20). DELETE is never permitted.
create table timeclock.punch_event (
  id               uuid primary key default gen_random_uuid(),
  -- Monotonic append order. created_at is NOT usable for this: every row written
  -- in one transaction shares the same now(), which made the hash-chain tail
  -- selection nondeterministic (caught by supabase/tests/60_hash_chain.sql).
  seq              bigint generated always as identity,
  tenant_id        uuid not null references timeclock.tenant(id),
  agent_id         uuid not null references timeclock.agent(id),
  event_type       timeclock.punch_event_type not null,
  event_time       timestamptz not null,                 -- UTC; converted at the HRIS boundary only
  source           timeclock.event_source not null,
  session_id       text,                                 -- widget session; orphan-login forensics
  status           timeclock.event_status not null default 'ACTIVE',
  -- Corrections: the new event points at what it corrects; the original goes SUPERSEDED.
  correction_of_id uuid references timeclock.punch_event(id),
  note             text,                                 -- attestation / reason
  created_by_id    uuid not null,                        -- agent or supervisor id
  approved_by_id   uuid,
  approved_at      timestamptz,
  -- Idempotency: the widget generates this UUID before the request leaves the
  -- browser, so a retry (offline replay, double tap, lost 200) cannot double-punch.
  client_uuid      uuid not null,
  created_at       timestamptz not null default clock_timestamp(),
  -- Tamper-evident chain, per (tenant, agent). Filled by trigger.
  prev_hash        text,
  self_hash        text,
  constraint punch_event_note_len_ck check (note is null or char_length(note) <= 300),
  constraint punch_event_approval_ck check (
    (approved_by_id is null) = (approved_at is null)
  )
);
create unique index punch_event_client_uuid_key
  on timeclock.punch_event (tenant_id, client_uuid);
create index punch_event_agent_time_idx
  on timeclock.punch_event (tenant_id, agent_id, event_time desc);
create unique index punch_event_chain_idx
  on timeclock.punch_event (tenant_id, agent_id, seq desc);
create index punch_event_status_idx
  on timeclock.punch_event (tenant_id, status)
  where status in ('PENDING_APPROVAL', 'ACTIVE');
create index punch_event_correction_idx
  on timeclock.punch_event (correction_of_id)
  where correction_of_id is not null;

comment on column timeclock.punch_event.client_uuid is
  'Client-generated idempotency key. Unique per tenant; a replayed punch returns the original.';
comment on column timeclock.punch_event.self_hash is
  'sha256(prev_hash || seq || tenant || agent || type || event_time || source || status || correction_of || note || created_by || client_uuid). Chain per (tenant, agent), ordered by seq.';

-- --------------------------------------------------- punch_event_mutation
-- The only writes that are not inserts into punch_event are whitelisted status
-- transitions. Each one is journalled here, append-only, so the audit trail
-- covers state changes as well as the events themselves.
create table timeclock.punch_event_mutation (
  id             bigserial primary key,
  punch_event_id uuid not null references timeclock.punch_event(id),
  tenant_id      uuid not null references timeclock.tenant(id),
  from_status    timeclock.event_status not null,
  to_status      timeclock.event_status not null,
  actor_id       uuid,
  db_role        text not null default current_user,
  jwt_claims     jsonb,
  mutated_at     timestamptz not null default now()
);
create index punch_event_mutation_event_idx on timeclock.punch_event_mutation (punch_event_id);

-- ------------------------------------------------- compliance_exception
create table timeclock.compliance_exception (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references timeclock.tenant(id),
  agent_id             uuid not null references timeclock.agent(id),
  work_date            date not null,                    -- bucket in AGENT-LOCAL tz
  type                 timeclock.exception_type not null,
  status               timeclock.exception_status not null default 'OPEN',
  detected_at          timestamptz not null default now(),
  related_event_ids    uuid[] not null default '{}',
  premium_hour_payable boolean not null default false,   -- CA Labor Code 226.7(c)
  premium_delivered    boolean not null default false,   -- pay item accepted by the HRIS
  resolution           text,
  resolved_by_id       uuid,
  resolved_at          timestamptz,
  -- 226.7(c) allows ONE premium hour per workday per category; the unique index
  -- below makes a duplicate premium structurally impossible.
  unique (tenant_id, agent_id, work_date, type)
);
create index compliance_exception_open_idx
  on timeclock.compliance_exception (tenant_id, status, work_date desc);
create index compliance_exception_premium_idx
  on timeclock.compliance_exception (tenant_id, premium_hour_payable, premium_delivered)
  where premium_hour_payable and not premium_delivered;

-- ----------------------------------------------------------------- hris_outbox
-- Transactional outbox: the punch RPC writes the event AND its outbox row in one
-- transaction, so an HRIS push can never exist without its audit record and vice
-- versa. A worker drains it (migration 70).
create table timeclock.hris_outbox (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references timeclock.tenant(id),
  punch_event_id  uuid references timeclock.punch_event(id),
  exception_id    uuid references timeclock.compliance_exception(id),
  kind            timeclock.outbox_kind not null,
  payload         jsonb not null,                        -- canonical form; adapter maps to provider
  status          timeclock.outbox_status not null default 'PENDING',
  tracking_id     text,                                  -- provider async id (Paycor punchErrorLog)
  attempts        int not null default 0,
  last_error      text,
  locked_until    timestamptz,                           -- claim lease for the worker
  next_attempt_at timestamptz not null default now(),    -- backoff (429 -> +60s)
  submitted_at    timestamptz,
  resolved_at     timestamptz,
  created_at      timestamptz not null default now()
);
create index hris_outbox_claim_idx
  on timeclock.hris_outbox (tenant_id, kind, next_attempt_at)
  where status = 'PENDING';
create index hris_outbox_submitted_idx
  on timeclock.hris_outbox (tenant_id, tracking_id)
  where status = 'SUBMITTED';
-- One pay item per exception, ever.
create unique index hris_outbox_pay_item_key
  on timeclock.hris_outbox (exception_id)
  where kind = 'PAY_ITEM';

-- ----------------------------------------------------------------- transitions
-- The state machine as data, mirroring packages/core/src/stateMachine.ts:
--   CLOCKED_OUT --IN--> ACTIVE
--   ACTIVE --BREAK_START--> ON_BREAK --BREAK_END--> ACTIVE
--   ACTIVE --LUNCH_START--> ON_LUNCH --LUNCH_END--> ACTIVE
--   ACTIVE --OUT--> CLOCKED_OUT
-- Guards fall out of the absence of a row: no break/lunch unless ACTIVE, and no
-- OUT while ON_BREAK/ON_LUNCH.
create table timeclock.transition (
  from_status timeclock.agent_status     not null,
  event_type  timeclock.punch_event_type not null,
  to_status   timeclock.agent_status     not null,
  primary key (from_status, event_type)
);

insert into timeclock.transition (from_status, event_type, to_status) values
  ('CLOCKED_OUT', 'IN',          'ACTIVE'),
  ('ACTIVE',      'OUT',         'CLOCKED_OUT'),
  ('ACTIVE',      'BREAK_START', 'ON_BREAK'),
  ('ON_BREAK',    'BREAK_END',   'ACTIVE'),
  ('ACTIVE',      'LUNCH_START', 'ON_LUNCH'),
  ('ON_LUNCH',    'LUNCH_END',   'ACTIVE');

reset role;
