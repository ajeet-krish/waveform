# LiftLog Platform

Offline-first workout, cycling, and climbing tracker for a small friend
group. Invite-only accounts, a SolidJS PWA, and a Rust API on Postgres.
The rebuild replaces the v1 vanilla-JS PWA (preserved in `legacy/` for the
phase 1 import wizard) while keeping its domain conventions: weights in kg,
lengths in cm, Monday-start weeks, and Brzycki e1RM everywhere.

Design docs are authoritative and live in `docs/` (`architecture.md`,
`decisions.md`, `research.md`). Do not edit them casually.

## Phase status

- Phase 0: monorepo, schema + migrations, CI/CD, deploy skeleton (in progress)
- Phase 1: training core (workouts, exercises), offline sync, v1 data import (not started)
- Phase 2: activities (cycling, climbing), body stats, routines (not started)
- Phase 3: social (boards, heatmap, feed, kudos) (not started)
- Phase 4: challenges, hardening, backup/restore drill (not started)

## Repository layout

```
liftlog/
|- apps/
|  |- api/            Axum HTTP API (routers, handlers, extractors)
|- crates/
|  |- db/             SQLx pool, migrations runner, row models (ts-rs)
|  |- analytics/      Aggregation metrics (ports fitness_control_center)
|  |- scoring/        Brzycki e1RM, Effort Points, V-points (pure, tested)
|  |- sync/           Outbox apply, last-write-wins, tombstone contract
|- packages/
|  |- api-types/      TypeScript types generated from Rust (committed)
|- migrations/        SQLx migrations (schema + catalog seed)
|- infra/             docker-compose.yml (Postgres + Mailpit), railway.toml
|- legacy/            v1 PWA, kept only for the phase 1 import wizard
|- docs/              Architecture, decision records, research
\- .github/workflows/ CI: rust, ts-rs drift, JS workspace, migrations
```

## Prerequisites

- Rust stable (`rustup`), with `rustfmt` and `clippy` components
- Node.js 22+ and pnpm 10 (`corepack enable` then `corepack prepare pnpm@10.14.0 activate`)
- Docker (for local Postgres and the Mailpit OTP inbox)

## Quick start

1. Install JS dependencies: `pnpm install`
2. Start local services: `docker compose -f infra/docker-compose.yml up -d`
3. Copy the environment template: `cp .env.example .env`
4. Run the API (applies migrations on startup, serves on port 8080):
   `cargo run -p liftlog-api`
5. Check it: `curl http://localhost:8080/healthz`

Mailpit captures dev OTP emails at `http://localhost:8025`.

## Common commands

Rust:

- `cargo build` builds the whole workspace.
- `cargo test` runs all Rust tests (scoring, analytics, sync).
- `cargo clippy` and `cargo fmt` handle linting and formatting.
- `cargo test export_ts` regenerates `packages/api-types/src/generated.ts`
  from the Rust models. Commit the result; CI fails on drift.

JavaScript:

- `pnpm build`, `pnpm lint`, `pnpm test` run the Turborepo pipelines.
- The SolidJS app (`apps/web`) arrives in phase 1; the JS workspace is
  scaffolded now with `packages/api-types`.

Database:

- `migrations/0001_init.sql` is the full schema; `migrations/0002_seed_catalog.sql`
  seeds the global exercise catalog (v1 names preserved exactly for import).
- `cargo run -p liftlog-api` re-runs pending migrations automatically.

## Legacy v1

`legacy/` holds the original single-file PWA (`index.html`, `app.js`,
`styles.css`, `sw.js`, `manifest.webmanifest`, `icons/`). It is not served
anymore. It exists so the phase 1 import wizard can reproduce the v1 JSON
backup schema and map its exercise names onto the global catalog.
