# Time-Clock Widget & Service

Embeddable clock-in/out widget + HRIS-agnostic time service. System of record
for ALL time data including paid breaks (10 min, admin-set) and paid lunch
(30–60 min) — break/lunch events never sync to the HRIS by design (and Paycor's
punch model cannot represent them: PunchStatusType = Auto|In|Out|Transfer).

## Layout
- `prisma/schema.prisma` — append-only PunchEvent stream, ComplianceException,
  Agent identity map (hostUserId → agent → hrisEmployeeId), transactional HrisOutbox
- `packages/core/` — HRIS-agnostic domain
  - `stateMachine.ts` — CLOCKED_OUT/ACTIVE/ON_BREAK/ON_LUNCH projection + guards
  - `punchService.ts` — single guarded write path; event + outbox in one tx
  - `mealDeadline.ts` — CA §512/§226.7 5th-hour countdown, tiers (T-60/30/15/breach),
    late/short/missed detection, premium flag
  - `orphanDetection.ts` — orphan IN/BREAK/LUNCH; IN/OUT round-trip to HRIS,
    break/lunch corrected entirely in-app
  - `coverage.ts` — greedy break/lunch recommender, PER DEPARTMENT; ADVISORY
    only (no hard constraints) — proposes a best-effort slot and flags
    trade-offs (`mealAtRisk` / `coverageAtRisk`), never forces or refuses
- `packages/hris/` — adapter boundary
  - `adapter.ts` — capability-flag interface (supportsBreakPunches() etc.),
    canonical types, TokenProvider injection point (token endpoint TBD)
  - `outboxWorker.ts` — drains PENDING rows per tenant, two-phase
    SUBMITTED→resolved for async providers
  - `paycor/adapter.ts` — verified v1/v2 endpoints: CreatePunches,
    punchErrorLog polling, missed-punch round trip, CreatePayItems (meal
    premium), v2 paired-timecard reconciliation reads, 429 backoff (60s),
    Ocp-Apim-Subscription-Key header, employee-LOCAL punchDateTime conversion
- `widget/loader.js` — one-line CRM header embed: closed-Shadow-DOM launcher +
  widget-origin iframe, postMessage w/ strict origin allowlist, host-minted
  short-lived identity JWT via `window.TimeClock.setIdentityToken(jwt)`
- `apps/api/` — the runnable service that wires the domain to I/O
  - `src/server.ts` — node:http server (no web framework): punch write path,
    agent + supervisor read models, SSE streams, webhook receiver, embed loader
  - `src/db.ts` — in-memory `PunchStore` + `OutboxStore` (+ directory,
    exceptions, event bus) for credential-free local runs
  - `src/stores/prismaStores.ts` — production Prisma impls of the same two ports
  - `src/identity.ts` — host identity-JWT verify + webhook HMAC verify
  - `src/hris/tokenProvider.ts` — Paycor OAuth refresh-token `TokenProvider`
  - `src/hris/registry.ts` — tenant → `HrisAdapter` resolver for the drain worker
  - `src/compliance.ts` — scheduled sweeper: meal/orphan exceptions + premium pay-item enqueue
  - `src/snapshot.ts` — pure read-models for the two UIs
  - `public/{index,embed,supervisor}.html` — agent widget + live supervisor panel
- `tests/smoke.test.ts` — passing smoke suite for the domain core

## Quick start
```bash
npm install
npm test          # domain smoke suite
npm run typecheck # whole workspace, strict
npm start         # http://localhost:8787  (agent /embed · supervisor /supervisor)
```
Runs with an in-memory store and a demo tenant (no HRIS configured), so every
compliance path is exercised with zero external credentials. Point it at Postgres
by swapping `MemoryDb` for the Prisma stores; enable Paycor by setting a tenant's
`hrisProvider`/`hrisConfig` (OAuth + write config) — the registry does the rest.

## Injection points — now built
1. `TokenProvider` → `apps/api/src/hris/tokenProvider.ts` (Paycor refresh-token grant, coalesced refresh, rotation)
2. Webhook receiver → `POST /webhooks/hris` (HMAC-verified; `Employee.Modified/Created` → identity-map sync)
3. `PaycorAdapter.listEmployees` → implemented on the v1 paged/continuationToken shape (confirm field names vs portal)
4. Prisma `PunchStore` / `OutboxStore` → `apps/api/src/stores/prismaStores.ts` (transactional event+outbox write)
5. Widget iframe app UI + supervisor panel (SSE) → `apps/api/public/*.html`

## Employees (user menu) & HRIS sync
- A supervisor manages the roster from the **Employees** panel: **Create employee**
  (with a "Sync to HRIS" toggle) or **Pull from HRIS**. Endpoints:
  `GET/POST /api/supervisor/employees`, `POST /api/supervisor/employees/pull-hris`,
  `POST /api/supervisor/employees/:id/hris` (link/unlink).
- **Sync is per-employee**, keyed on `agent.hrisEmployeeId`: set → the employee's
  IN/OUT punches flow through the transactional outbox to the HRIS; `null` → the
  employee lives solely in the timeclock DB and nothing leaves the app. (Breaks and
  lunch never sync regardless.)
- **Pull from HRIS** resolves the tenant's `HrisAdapter` and imports
  `listEmployees()`, creating HRIS-synced agents (idempotent on `hrisEmployeeId`).
  The demo tenant uses `hrisProvider: 'mock'` (`apps/api/src/hris/mockAdapter.ts`) —
  a canned roster + accept-and-deliver writes — so the whole pull → sync → outbox
  path runs without credentials. A real tenant sets `hrisProvider: 'paycor'`.
- **Retention & archival (no hard delete).** Deactivate is a soft-delete: an
  employee's punch logs are never removed (5-year retention floor — FLSA/CA). After
  **90 days** deactivated, an employee is **archived** — hidden from the default
  Employees view, data retained. An hourly job auto-archives eligible employees
  (`POST /api/supervisor/employees/run-archival` triggers it on demand); per-employee
  `.../archive` and `.../unarchive` are gated by the 90-day rule; reactivating
  unarchives. Retention authority is surfaced per employee: **HRIS** holds a synced
  employee's punch archive, the **timeclock** app is the sole record for local-only
  employees. Endpoints add `?includeArchived=1` to reveal archived rows.

## Behavior policies
- **No hard constraints** in scheduling: the recommender never forces a
  placement or delays a lunch to protect coverage. It always proposes the best
  available slot and surfaces trade-offs (`mealAtRisk`, `coverageAtRisk`) for a
  human to decide. Coverage is measured **per department**.
- **Missing clock-out gate** (`orphanCorrection.ts`): if a team member never
  clocks out, their shift becomes an orphan. Before they may clock in again a
  clock-out exception (`ORPHAN_IN`, PENDING_APPROVAL) MUST be filed, logging the
  **estimated clock-out time** and the **reason**; a corrective OUT then closes
  the prior shift and (with an HRIS) round-trips as a missed-punch request.
- **History**: `GET /api/history?date=` (agent) and
  `GET /api/supervisor/history?date=&department=` (supervisor) return punches
  for an agent-local calendar date; both UIs expose a date filter.

## Folded in from bs5_1 (additive — nothing removed)
- **State-aware CA lunch rules** — meal deadline + §226.7 premium follow the
  agent's `locationState` (CA vs TX …) via `apps/api/src/stateRules.ts` +
  `packages/core/src/rules.ts`. TX agents owe no premium and get no 5th-hour
  countdown; the federal 30-min short-meal floor still applies everywhere.
- **Scheduler** — weekly `schedule_pattern` + per-date `schedule_exception`
  (in-memory), resolved to instants in the agent's timezone
  (`apps/api/src/scheduling.ts`). Reads: `GET /api/me/schedule`,
  `GET /api/supervisor/schedule`. Adherence (planned vs actual) via
  `packages/core/src/adherence.ts`.
- **AI forecast** — `packages/core/src/forecast.ts` (coverage / overtime /
  meal-deadline / adherence → alert drafts + a narration `SummaryProvider`).
  Runs on demand (`POST /api/supervisor/forecast`) and on an interval worker;
  surfaced in the supervisor **Forecast** panel. Overtime math in
  `packages/core/src/overtime.ts`, thresholds from the state rule.
  - **Claude-backed summary** — `apps/api/src/summaryProvider.ts`. The engine's
    numbers are pure arithmetic (auditable); the model only ranks + phrases the
    finished alerts into the morning read. It may not recompute figures and its
    output is presentation only. Set `ANTHROPIC_API_KEY` to enable it (model
    `claude-opus-5`, effort `low`); with no key, or on any API error, it falls
    back to the deterministic `templateSummary`. The panel labels which produced
    the summary (✨ Claude / template).

## Compliance notes encoded in code
- FLSA 29 CFR §785.18 (paid rest <20 min) / §785.19 (meal) — both paid here
- CA Labor Code §512(a): lunch must START before end of 5th hour → hard timer
- CA §226.7(c): premium hour → `premiumHourPayable` → PAY_ITEM outbox → Paycor CreatePayItems
- Short-meal (<30 min) return: warn + attestation, never block (Brinker)
- App is the sole meal-period record (Donohue) → retain ≥4 yr, exportable
