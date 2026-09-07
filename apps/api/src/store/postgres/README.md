# Postgres store driver

Durable persistence behind the synchronous `Store` contract (ADR 0001), selected
with `STORE_DRIVER=postgres`.

## Design: in-memory projection + write-through

`PostgresStore extends MemoryDb`. The inherited in-memory maps serve every
**synchronous read** exactly as the memory driver does — so nothing above the store
changes and reads stay fast. Durability is added at the edges:

- **`init()`** — on boot, loads tenants, agents, open (`ACTIVE`) punch events, open
  exceptions, and unresolved outbox rows from Postgres into the projection (survives
  restarts). The server `await`s this once before it starts listening.
- **writes** — mirrored to Postgres via Prisma, using the id `MemoryDb` assigned, so
  the row and the projection always agree.
  - The payroll-critical punch path (`appendWithOutbox`) writes the event **and** its
    outbox row in one Prisma `$transaction` — the transactional-outbox guarantee.
  - Outbox consumer transitions (`markSubmitted`/`markDelivered`/…) are awaited.
  - Directory + exception writes keep `MemoryDb`'s synchronous signatures, so their
    persistence is fire-and-forget with error logging.

### Known limits (v1)

- **Single process.** The projection lives in one process's memory, so this driver
  does not scale horizontally yet (same caveat the memory driver has). A second
  replica would not see the first's in-memory state until its own restart/hydration.
- **Fire-and-forget directory writes.** A crash in the gap between the in-memory
  mutation and the async Postgres write can drop a directory/exception/schedule
  change. The punch/outbox path is transactional and not subject to this. All
  write-throughs run through a serial FIFO queue, so they never reorder (tenant
  before agent before its events) — a foreign key is never violated by races.

## Setup

```bash
# 1. Point at your database
export DATABASE_URL="postgres://user:pass@host:5432/timeclock"

# 2. Install deps + generate the Prisma client (generate needs only the schema)
npm install
npm run prisma:generate

# 3. Create the tables
npm run prisma:migrate        # prisma migrate deploy  (prod: use committed migrations)
#   or, for a scratch/dev database:  npx prisma db push

# 4. Run
STORE_DRIVER=postgres npm start
```

If the client isn't generated or `DATABASE_URL` is unset, boot fails fast with an
actionable message (not a cryptic stack trace).

## Verified

A live throwaway Postgres (`postgres:16`) confirmed the round trip: write a
tenant + agent + punch + outbox through the driver, then a **fresh** store instance
`init()`-hydrated all of it back (agent `role`/`locationState` included) and
`claimPending` returned the persisted outbox row with its event FK intact.

## Relationship to `supabase/` (the bs5 port)

This driver is the **Prisma** path — Time-Clock's own isolated relational store,
schema in `prisma/schema.prisma`. The `supabase/` migrations staged on this branch
are a **different, richer** design (domain logic in Postgres RPCs + RLS), tracked
separately in `docs/persistence-port.md`. Both keep Time-Clock's data isolated from
any CRM (no foreign keys out). Pick one system of record before production.
