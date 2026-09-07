# Supabase / Postgres persistence port (staged, WIP)

This branch stages the **durable system-of-record** from the `bs5` Supabase fork so
it lives in the versioned repo. It is the concrete implementation the storage-driver
ADR has been waiting for: [`docs/adr/0001-storage-drivers-and-crm-isolation.md`](adr/0001-storage-drivers-and-crm-isolation.md)
defines `STORE_DRIVER = memory | postgres | embedded`, and today `postgres` throws
"not implemented". This is that implementation, not yet wired.

## What landed here

- **`supabase/`** — the Postgres schema as ordered migrations (the crown jewel):
  - `migrations/` — bootstrap, enums+tables, immutability (append-only), RLS
    (tenant isolation), projection views, agent + supervisor RPCs, outbox worker,
    realtime export, identity map. Dated `20260814…`.
  - `tests/` — pgTAP-style SQL tests: state machine, append-only, RLS isolation,
    corrections, outbox, hash-chain, identity.
  - `seed.sql`, `config.toml`.
- **`packages/db/src/`** — the TS side of the store: `client.ts` (`TimeclockDb` over
  `pg`), `outboxStore.ts`, `contract.ts`, `errors.ts`.
- **`apps/api/src/`** — `worker.ts` (outbox drain against Postgres), `roster-stream.ts`
  (`pg` LISTEN/NOTIFY roster stream), `tokenProvider.ts`, `env.ts`.

## Why it does NOT compile in this tree yet (and is excluded from `tsc`)

The `bs5` fork and this tree diverged; a file copy is not a working merge:

1. **Module resolution** — `bs5` used `"moduleResolution": "node16"` (explicit `.js`
   import extensions); this tree uses `"bundler"` (extensionless). The ported files
   use `../../../packages/db/src/client`-style paths that need normalizing.
2. **Core/HRIS API drift** — the ported files import members from `@timeclock/core` /
   `@timeclock/hris` shaped for the `bs5` fork (e.g. its `TokenProvider`), which differ
   from this tree's exports. This tree's core is the feature-rich one (forecast,
   adherence, overtime); `bs5`'s was leaner.
3. **`pg` dependency** — `packages/db` and `roster-stream.ts` need the `pg` package
   (+ `@types/pg`), not yet in `package.json`.

To keep the known-good in-memory build green, these paths are listed under `exclude`
in `tsconfig.json`. `npm run typecheck` and the smoke/scheduling suites pass unchanged.

## Wiring plan (next)

1. Add `pg` + `@types/pg` to `apps/api` deps.
2. Normalize imports in `packages/db` + the four app files to this tree's `bundler`
   resolution and its actual `@timeclock/core` / `@timeclock/hris` exports.
3. Implement the `postgres` branch of `createStore()` (`apps/api/src/store/…`, per
   ADR 0001) using `TimeclockDb` so `MemoryDb`'s `Store` contract is satisfied against
   Postgres. Keep Time-Clock's data isolated from any CRM (no cross-schema FKs).
4. Run the `supabase/tests` in CI against a throwaway Postgres, then remove the
   `tsconfig` exclude for the files as each compiles.

Provenance: copied 2026-09-06 from
`SYSAPP/TimeClock/timeclock` (the `bs5` Supabase variant). The shared app code there
was byte-identical to this repo; only this persistence layer was additive.
