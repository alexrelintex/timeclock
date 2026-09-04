# Handoff — Time-Clock (updated 2026-08-27)

Pick-up notes for the next session. Everything below is about
`~/Downloads/timeclock` (the in-memory Node/TypeScript build).

## Where it stands

Fully working demo, all green: `npx tsc --noEmit` clean, `npm test` +
`tsx tests/scheduling.test.ts` pass, no server errors.

```bash
cd ~/Downloads/timeclock
npm install         # if node_modules is missing
npm start           # http://localhost:8787  (agent /embed · supervisor /supervisor)
```

Demo tenant seeds on boot (agents, schedules, a mock HRIS). **State is
in-memory — every restart resets it.**

### Shipped this week (all verified end-to-end)
- Advisory break/lunch recommender (no hard constraints; meal/coverage risk flags)
- Orphan clock-out gate (estimated time + reason before re-clock-in)
- Per-department coverage; History view with date filter (agent + supervisor)
- 10-minute paid break policy
- State-aware CA lunch rules (CA vs TX via `agent.locationState` → state_rule)
- Scheduler: weekly patterns + per-date exceptions + resolver; adherence + overtime
- Schedule editor UI (repeating week + day override + clear)
- AI forecast (coverage / overtime / meal-deadline / adherence → alerts + summary)
- Claude-backed `SummaryProvider` (opus-5, effort low; falls back to template)
- Employees "user menu": create (local or HRIS-synced), pull from HRIS (mock),
  link/unlink sync, edit, deactivate
- Retention & archival: soft-delete (5-yr punch retention), 90-day archive, no
  hard delete; HRIS vs timeclock retention authority
- Active-state ("lit") header pills

## Decisions needed from you (these gate the big work)

1. **Persistence / system-of-record.** THE big one. The app runs entirely on an
   in-memory store (`apps/api/src/db.ts`) — resets on restart, single process,
   no durability. Two real paths:
   - **Adopt the bs5_1 Supabase build** as the base (its `supabase/migrations/*`
     are the real system of record: append-only punch stream, tamper-evident hash
     chain, RLS + FORCE RLS, transactional outbox, immutability triggers). We
     ported its *policy logic* (rules/adherence/overtime/forecast) into this
     build but NOT those integrity guarantees.
   - **Wire this build to Postgres via Prisma** (`apps/api/src/stores/prismaStores.ts`
     already implements the two ports) and add the integrity pieces ourselves.
   → Recommendation: adopt Supabase for the write path; keep the TS core as-is.
2. **Claude summary model.** Defaulted to `claude-opus-5` (skill-mandated) — heavy
   for a one-sentence summary. Keep, or set `ANTHROPIC_MODEL=claude-haiku-4-5`?
3. **Real HRIS (Paycor) vs mock.** Demo uses `hrisProvider:'mock'`. Going live
   needs: Paycor OAuth token endpoint (TokenProvider — TBD), `listEmployees` path
   confirmed against the portal, real subscription key + activation.

## Next work, prioritized

### P0 — before this is more than a demo
- [ ] Decide + implement persistence (see decision #1). Nothing survives a
      restart today.
- [ ] Integrity the in-memory build lacks vs the Supabase design: append-only
      enforcement, tamper-evident hash chain, DB-level tenant isolation (RLS).
- [ ] Block punches for **inactive/archived** employees (identity resolution
      currently doesn't check `active` — a deactivated user could still punch).

### P1 — correctness & coverage
- [ ] Tests for the new surface: employees CRUD, archival 90-day gate, state-aware
      meal rules (CA vs TX), forecast wiring, orphan correction. Only core smoke +
      scheduling tests exist today.
- [ ] Scheduler edge cases in the in-memory port: overnight shifts + DST. The
      bs5_1 SQL tests (`supabase/tests/90_scheduler.sql`) pin these; our TS port
      has basic two-pass tz handling but no tests.
- [ ] Real host-identity auth flow (today the demo uses `?user=`; JWT verify
      exists in `identity.ts` but needs a real host integration + JWKS).

### P2 — polish / nice-to-have
- [ ] Adherence day-view panel in the supervisor UI (planned-vs-actual per agent);
      the data + core (`adherence.ts`) exist, no dedicated panel yet.
- [ ] `git init` the project — `~/Downloads/timeclock` is NOT its own git repo
      (git resolves to a parent). No project history / commits.
- [ ] Live Claude summary check with a real `ANTHROPIC_API_KEY` (only verified
      against a mock endpoint so far).

## Fast resume checklist
1. `cd ~/Downloads/timeclock && npm start` → open `/supervisor`.
2. Skim this file's Decisions section — answer #1 first; it unblocks most P0.
3. `README.md` has the architecture + file map; `docs/` (in the bs5_1 zip at
   `/tmp/tc-sb/timeclock`, or re-extract `~/Downloads/timeclock-supabase-bs5_1.zip`)
   has the Supabase design if we go that route.
