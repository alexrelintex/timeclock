# Deploying Time-Clock (independent instance)

This service is self-contained and deploys as a single container. Each customer /
tenant gets its **own instance** (own container, own env, own data).

## What's in the box
- One HTTP service (`apps/api`) that serves the agent widget (`/embed`), the
  supervisor panel (`/supervisor`), the JSON/SSE API, the embed loader
  (`/loader.js`), and a health check (`/healthz`).
- Runs the TypeScript entrypoint directly via **tsx** (a runtime dependency) — no
  separate compile step.
- Binds `0.0.0.0:$PORT`, handles `SIGTERM`/`SIGINT` for clean container stops.

## Quick start (Docker)
```bash
cp .env.example .env      # then edit secrets
docker build -t timeclock:latest .
docker run --rm -p 8787:8787 --env-file .env timeclock:latest
# → http://localhost:8787/healthz
```

Or with Compose:
```bash
cp .env.example .env
docker compose up --build -d
docker compose logs -f
```

## Configuration (env)
| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `STORE_DRIVER` | `memory` | Persistence: `memory` (ephemeral) · `postgres` / `embedded` (durable, planned). Time-Clock keeps its own isolated system of record on every driver — see `docs/adr/0001`. |
| `NODE_ENV` | `development` | `production` disables the `?user=` demo auth path |
| `SEED_DEMO` | on in dev, off in prod | `true` loads the demo tenant/agents on boot |
| `TIMECLOCK_IDENTITY_SECRET` | dev default | HMAC secret for host-minted identity JWTs (set a real value) |
| `TIMECLOCK_WEBHOOK_SECRET` | dev default | HMAC secret for the `/webhooks/hris` receiver |
| `ANTHROPIC_API_KEY` | unset | Enables Claude-written forecast summaries; falls back to the deterministic template when unset |
| `ANTHROPIC_MODEL` | `claude-opus-5` | Override the summary model |

A **pilot/demo instance**: run with `SEED_DEMO=true` and without
`NODE_ENV=production` so the `?user=<hostUserId>` explore path works.
A **real instance**: set `NODE_ENV=production`, set both secrets, leave
`SEED_DEMO` off, and integrate the host identity-JWT flow (see `widget/loader.js`
and `apps/api/src/identity.ts`).

## Platform notes
- **Fly.io / Render / Railway / Cloud Run / ECS / k8s**: point them at this
  `Dockerfile`. Expose `$PORT`, wire the health check to `GET /healthz`, and set
  the env vars above as secrets. The container is stateless-per-process (see
  caveat) so it scales horizontally only once persistence is added.
- **Reverse proxy / TLS**: terminate TLS at the platform's load balancer; the app
  speaks plain HTTP. The embed widget requires the host CRM to allow
  `frame-src`/`script-src` for this instance's origin (see `widget/loader.js`).

## ⚠️ Before this is production-grade
1. **Persistence.** State is currently **in-memory** — a restart wipes all
   punches, employees, schedules, and exceptions. Do **not** run a real payroll
   workload until a durable store is wired (Prisma/Postgres stores exist at
   `apps/api/src/stores/prismaStores.ts`; the Supabase design in the bs5_1 zip is
   the fuller path). This also means you cannot run more than one replica yet.
2. **Auth.** Production disables the demo `?user=` path; the host must mint
   identity JWTs. Set the two HMAC secrets to strong random values.
3. **Inactive/archived punch block** and the other P0 items in `HANDOFF.md`.

## Health & lifecycle
- Liveness/readiness: `GET /healthz` → `{ "ok": true, "tenants": N }`.
- The container stops cleanly on `SIGTERM` (drains connections, 10s force-exit).
- Background loops (compliance sweep, outbox drain, forecast, archival) are
  in-process and `unref()`'d — they don't block shutdown.
