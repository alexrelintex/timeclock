# ADR 0001 — Storage drivers & CRM data isolation

- Status: **Accepted**
- Date: 2026-09-05

## Context

Time-Clock must deploy in three shapes, from the **one** published image:

1. **Standalone** — no external system.
2. **With a Postgres/Supabase CRM** — integrated with a host CRM's database.
3. **Embedded self-contained database** — Time-Clock brings its own durable DB.

In **every** shape, Time-Clock is the **system of record for time data** — punches,
employees, schedules, compliance exceptions, and the HRIS outbox. That data, and its
history, must stay **separate** from any embedded or integrated system (the CRM, an
HRIS, or a host app). Nothing outside Time-Clock may own, mutate, or entangle its
records; retention (5-year punch retention, append-only history) is Time-Clock's
responsibility alone.

## Decision

### 1. All persistence goes through the domain's storage *ports*
The domain already defines `PunchStore` (core) and `OutboxStore` (hris), plus the
app-level directory / exceptions / schedule accessors on the store. Nothing above the
store knows the concrete backend. A single env var **`STORE_DRIVER`** selects it:

| `STORE_DRIVER` | Durability | Shape it serves |
|---|---|---|
| `memory` (default) | ephemeral | standalone dev/demo/UAT |
| `postgres` | durable | connected (own schema; may co-locate with a CRM) |
| `embedded` | durable | standalone with persistence, no external DB |

All drivers implement the same ports; the API, domain logic, and UI are identical
across drivers. Adding a driver never touches business logic.

### 2. Time-Clock owns a dedicated schema and migration history
Under `postgres`, Time-Clock uses a dedicated **`timeclock`** schema (configurable via
`DB_SCHEMA`) with its **own** migrations. It **never** creates, reads-for-write, or
foreign-keys into any other schema's tables.

### 3. CRM (and HRIS) integration is app-layer only — never a database join
The linkage to external identities is resolved **in code**, not by DB FK:
`agent.hostUserId ↔ CRM user id`, established through the identity JWT
(`apps/api/src/identity.ts`), the embed loader (`widget/loader.js`), the webhook
receiver (`POST /webhooks/hris`), and the HRIS connector catalog
(`apps/api/src/hris/catalog.ts`). Employee/time records are copied/mapped, not shared.

### 4. The headless CRM schema is a *separate* schema/database
If the CRM and Time-Clock share one Postgres/Supabase instance, they live in **distinct
schemas** (`crm.*` vs `timeclock.*`) with **distinct migration histories** and no
cross-schema FKs. Either can be backed up, migrated, exported, or dropped without
touching the other. They may also be entirely separate databases.

## Consequences

- **Portability**: the same image runs standalone (`memory`/`embedded`) or connected
  (`postgres` + CRM) — configuration, not a code fork.
- **No commingling**: exporting/deleting/migrating the CRM never touches time records
  (and vice-versa). A tenant can offboard the CRM and keep their time history intact.
- **One seam to add durability**: implement a driver behind the existing ports; RLS,
  append-only, tamper-evident hashing, and the transactional outbox live **inside**
  Time-Clock's schema regardless of driver.
- **Tenant isolation** (RLS / `tenantId` scoping) is enforced within Time-Clock's
  schema in every driver.

## Implementation status

- `memory` — **done** (`apps/api/src/db.ts`).
- `postgres` — **scaffolded**: `apps/api/src/stores/prismaStores.ts` implements the
  ports; still needs the `timeclock` schema + migrations, RLS + append-only + hash
  chain (the bs5_1 Supabase design in `~/Downloads/timeclock-supabase-bs5_1.zip` is the
  reference), and driver wiring behind `STORE_DRIVER`.
- `embedded` — **not started**. Candidate: **PGlite** (embedded Postgres, shares the
  `postgres` SQL) so the durable drivers share one dialect; SQLite is the lighter
  alternative if a second dialect is acceptable.

## Non-goals
- Time-Clock does not become a CRM, and the CRM does not store time data. The CRM is
  headless (DB + API); Time-Clock's widget/board is the front end for time.
