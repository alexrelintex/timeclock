# Handoff — Time-Clock (updated 2026-09-05)

Pick-up notes for the next session. Project: `~/Downloads/timeclock` — its own git
repo (`git@github.com:alexrelintex/timeclock.git`, branch `main`). Node/TypeScript,
npm workspaces (`packages/core`, `packages/hris`, `apps/api`).

## ▶ Current work (active): Headless CRM database schema → connect CRM ↔ Timeclock

The next PR designs a **headless CRM database schema** and wires the CRM to
Time-Clock. Time-Clock is built to hang off a host CRM; the integration seams
already exist and are what the CRM connects through:

- **Identity** — the CRM backend mints a short-lived signed JWT
  (`{iss:tenant, sub:hostUserId, role?, exp}`) → `apps/api/src/identity.ts`. The
  embed forwards it; we verify + map `hostUserId → agent`. Role travels in the
  claim and is clamped to `min(jwtRole, recordRole)`.
- **Embed** — one-line loader `widget/loader.js` (closed shadow-DOM iframe,
  postMessage, `window.TimeClock.setIdentityToken(jwt)`).
- **Employee sync** — the identity map (`agent.hostUserId ↔ hrisEmployeeId`) and
  the HRIS webhook receiver `POST /webhooks/hris` (`Employee.Modified/Created`).
- **Per-tenant HRIS** — connector catalog (`apps/api/src/hris/catalog.ts`):
  none / mock / Paycor / Gusto, administered per tenant.

**Open design questions for the CRM schema:** what entities the CRM owns vs
Time-Clock owns (people/identity, org/departments, tenancy); how CRM user records
map to `agent` (hostUserId keys); whether the CRM drives role + department
assignment (via JWT claims) or Time-Clock's admin UI stays authoritative; and
where the shared DB lives once Time-Clock gets persistence (see the standing P0).
Keep the CRM **headless** — DB + API, no UI of its own; Time-Clock's widget/board
is the front end.

**Architecture invariant (see `docs/adr/0001-storage-drivers-and-crm-isolation.md`):**
Time-Clock is always its own system of record. One image runs three ways via
`STORE_DRIVER` — `memory` (standalone/ephemeral), `postgres` (durable; own
`timeclock` schema, may co-locate with a CRM), `embedded` (self-contained durable,
e.g. PGlite). Its data/history stay **isolated** from any CRM/HRIS: linkage is
`agent.hostUserId ↔ CRM user id` resolved in code, never a DB foreign key. The
headless CRM schema is a **separate** schema/DB with its own migrations.

Ship the CRM-schema changes into the repo, let CI go green, then cut **v0.2.0**
(multi-arch) and re-point the containers. **Do not release yet** — v0.1.0 stays.

## Where it stands (baseline = v0.1.0)

All green: `npm run typecheck`, `npm test`, `npm run test:scheduling`. Two live
containers on the published image `ghcr.io/alexrelintex/timeclock:0.1.0`:

| Container | Instance | Port |
|---|---|---|
| `timeclock-cwdr` | **CWDR (UAT)** — master/starting env | 8787 |
| `timeclock-hc` | **Housing Counselors** — tenant | 8788 |

Local build-out: `cd ~/Downloads/timeclock && npm start` (tsx, hot-reloadable) —
but the running instances are the GHCR containers now, not `npm start`.
`docker compose` runs the GHCR image (version-pinned via `TIMECLOCK_VERSION`).
**State is still in-memory — every container restart re-seeds.**

## Shipped since the last handoff (all verified, on `main`)
- **Roles (4 tiers)**: admin > manager (multi-dept) > supervisor (one dept by
  default, holds an assigned list) > user. `requireAdmin` gates HRIS/tenant config;
  department scoping per tier; role in JWT claim, clamped to the stored ceiling.
- **Multi-HRIS connector catalog** + **Gusto** connector (time_sheets shift model,
  punch-pairing/OT seams) alongside Paycor + mock; per-tenant admin (`/api/admin/hris`).
- **CSV export** of all punches (scoped + date/department filters).
- **Timezone**: employee sees own local time; supervisor sees server/HQ time;
  world-timezone dropdown; local-date fix.
- **Deployment**: Dockerfile (tsx runtime, graceful shutdown, `SEED_DEMO`/`INSTANCE_NAME`),
  docker-compose, `DEPLOY.md`.
- **CI/CD**: `.github/workflows/ci.yml` (typecheck + both suites + docker build +
  image health check) and `release.yml` (semver tag → multi-arch push to GHCR).
- Earlier: advisory recommender, orphan clock-out gate, per-dept coverage, history +
  date filter, 10-min breaks, state-aware CA/TX meal rules, scheduler + editor,
  AI forecast + Claude `SummaryProvider`, employees CRUD, retention/archival.

## Standing decisions / P0 (unchanged, gate "real")
1. **Persistence.** Still in-memory (`apps/api/src/db.ts`) — nothing survives a
   restart; can't scale past one replica. This is the crux the CRM-schema work
   forces a decision on: adopt the **bs5_1 Supabase** system-of-record (append-only
   + hash chain + RLS; `~/Downloads/timeclock-supabase-bs5_1.zip`) or wire Postgres
   via the existing `apps/api/src/stores/prismaStores.ts`. The CRM DB and the
   Time-Clock store likely share this Postgres.
2. **Block punches for inactive/archived employees** — identity resolution doesn't
   check `active` yet (a deactivated user could still punch).
3. Broader tests (employees CRUD, archival gate, roles, CA/TX rules, forecast).
4. Real host-JWT/JWKS auth (today: demo `?user=` in dev; HS256 JWT verify exists).

## Fast resume
1. Containers already run v0.1.0: `docker ps` → CWDR UAT :8787, HC :8788.
2. Build-out: `npm start` locally, or edit → `docker build` → recreate container.
3. Release when ready: `git tag -a vX.Y.Z -m … && git push origin vX.Y.Z`
   → CI + GHCR multi-arch publish; then `TIMECLOCK_VERSION=X.Y.Z docker compose up -d`.
4. `README.md` = architecture + file map; `DEPLOY.md` = deploy/env; this file = status.
