-- =============================================================================
-- SEED — deterministic development fixtures (safe to re-run)
-- =============================================================================
-- Runs as the migration/admin role, which has BYPASSRLS, so it writes the tables
-- directly. Application code never does this — it goes through tc_api.
-- Agent timezones deliberately span US/Philippines/India, matching the agent
-- population this service was scoped for.
-- =============================================================================

insert into timeclock.tenant
  (id, slug, name, timezone, break_minutes, lunch_min_minutes, lunch_max_minutes,
   coverage_threshold_pct, ca_meal_rules_enabled, hris_provider,
   hris_premium_earning_ref, hris_config)
values
  ('11111111-1111-1111-1111-111111111111', 'acme', 'Acme Support Ops',
   'America/Los_Angeles', 15, 30, 60, 70, true, 'paycor',
   '00000000-0000-0000-0000-00000000ea01',
   jsonb_build_object('legalEntityId', 4242, 'baseUrl', 'https://apis.paycor.com'))
on conflict (id) do nothing;

insert into timeclock.agent
  (id, tenant_id, display_name, timezone, is_supervisor, host_user_id,
   hris_employee_id, hris_department_id, hris_activity_type_id, meal_waiver_on_file)
values
  ('22222222-2222-2222-2222-000000000001', '11111111-1111-1111-1111-111111111111',
   'Dana Ruiz (supervisor)', 'America/Los_Angeles', true, 'crm-user-1001',
   null, null, null, false),
  ('22222222-2222-2222-2222-000000000002', '11111111-1111-1111-1111-111111111111',
   'Priya Nair', 'America/Los_Angeles', false, 'crm-user-1002',
   'aaaaaaaa-0000-0000-0000-00000000e001',
   'dddddddd-0000-0000-0000-00000000d001',
   'cccccccc-0000-0000-0000-00000000a001', false),
  ('22222222-2222-2222-2222-000000000003', '11111111-1111-1111-1111-111111111111',
   'Marco Silva', 'Asia/Manila', false, 'crm-user-1003',
   null, null, null, false),          -- unmapped: punches stay internal
  ('22222222-2222-2222-2222-000000000004', '11111111-1111-1111-1111-111111111111',
   'Ana Cruz', 'Asia/Kolkata', false, 'crm-user-1004',
   'aaaaaaaa-0000-0000-0000-00000000e002',
   'dddddddd-0000-0000-0000-00000000d001',
   'cccccccc-0000-0000-0000-00000000a001', true)   -- <=6h waiver on file
on conflict (id) do nothing;

-- A second tenant exists only so the RLS tests can prove isolation.
insert into timeclock.tenant (id, slug, name, timezone)
values ('99999999-9999-9999-9999-999999999999', 'globex', 'Globex Inc', 'America/New_York')
on conflict (id) do nothing;

insert into timeclock.agent (id, tenant_id, display_name, timezone, host_user_id)
values ('88888888-8888-8888-8888-000000000001', '99999999-9999-9999-9999-999999999999',
        'Sam Vance', 'America/New_York', 'crm-user-2001')
on conflict (id) do nothing;
