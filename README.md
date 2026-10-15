# Waveform Platform

Offline-first workout, cycling, and climbing tracker for a small friend
group. The Phase 1 app is a SolidJS PWA that runs entirely on-device
(IndexedDB); a Rust API on Postgres with invite-only accounts and sync
lands in Phase 2. The rebuild replaces the v1 vanilla-JS PWA (preserved in
`legacy/` as the Phase 2 import source) while keeping its domain
conventions: weights in kg, lengths in cm, Monday-start weeks, and Brzycki
e1RM everywhere.

Design docs are authoritative and live in `docs/` (`architecture.md`,
`decisions.md`, `research.md`). Do not edit them casually.

## Phase status

- Phase 0: monorepo, schema + migrations, CI/CD, web deploy to GitHub Pages, local API + Postgres (implemented)
- Phase 1: local-first training core: workouts, exercises, history, body stats, climbing, cycling, dashboard, settings, and backup (implemented)
- Phase 2: backend + auth + sync push/pull, the v1 import converter, routines, and running/hike/swim (not started)
- Phase 3: social (boards, heatmap, feed, kudos) (not started)
- Phase 4: challenges, hardening, backup/restore drill (not started)

## Repository layout

```
waveform/
|- apps/
|  |- api/            Axum HTTP API (routers, handlers, extractors); lands in phase 2
|  |- web/            SolidJS + Vite PWA (local-first data core in src/db)
|- crates/
|  |- db/             SQLx pool, migrations runner, row models (ts-rs)
|  |- analytics/      Aggregation metrics (ports fitness_control_center)
|  |- scoring/        Brzycki e1RM, Effort Points, V-points (pure, tested)
|  |- sync/           Outbox apply, last-write-wins, tombstone contract
|- packages/
|  |- api-types/      TypeScript types generated from Rust (committed)
|  |- scoring/        @waveform/scoring: TS scoring + shared golden vectors
|- migrations/        SQLx migrations (schema + catalog seed + hardening)
|- infra/             docker-compose.yml (Postgres + Mailpit), railway.toml (API ref)
|- legacy/            v1 PWA, kept only for the phase 2 import converter
|- docs/              Architecture, decision records, research
\- .github/workflows/ CI: rust, ts-rs drift, JS workspace, migrations; Pages deploy
```

## Prerequisites

- Rust stable (`rustup`), with `rustfmt` and `clippy` components
- Node.js 22+ and pnpm 10 (`corepack enable` then `corepack prepare pnpm@10.14.0 activate`)
- Docker (for local Postgres and the Mailpit OTP inbox)

## Quick start

1. Install JS dependencies: `pnpm install`
2. Start local services: `docker compose -f infra/docker-compose.yml up -d`
3. Copy the environment template: `cp .env.example .env`
4. Apply migrations: `cargo run -p waveform-api -- migrate`
5. Run the API (serves on port 8080): `cargo run -p waveform-api`
   (startup migration is opt-in: `.env` sets `RUN_MIGRATIONS=true`)
6. Check it: `curl http://localhost:8080/healthz`

Mailpit captures dev OTP emails at `http://localhost:8025`.

Hosting: the web app deploys as a static SPA to GitHub Pages at
https://ajeet-krish.github.io/waveform/. The API and Postgres are deferred:
Phase 1 runs entirely on local storage, so managed hosting is not needed yet.
Run both locally with the steps above; Phase 2 adds auth and sync, and a later
phase adds a free-tier managed Postgres (Neon or Supabase) and web service
(Render or Fly).

## Common commands

Rust:

- `cargo build` builds the whole workspace.
- `cargo test` runs all Rust tests (scoring, analytics, sync, db).
- `cargo clippy` and `cargo fmt` handle linting and formatting.
- `cargo test export_ts` regenerates `packages/api-types/src/generated.ts`
  from the Rust models. Commit the result; CI fails on drift.
- `cargo test -p waveform-db` runs the schema and model decode tests; it
  needs a Postgres URL (see the header of `crates/db/tests/schema.rs`).

JavaScript:

- `pnpm build`, `pnpm lint`, `pnpm test` run the Turborepo pipelines.
- The SolidJS app (`apps/web`) runs on the local-first IndexedDB data core
  (`apps/web/src/db`); syncing to the API is Phase 2.
- `packages/scoring` ports the Rust scoring formulas and is fenced against
  `crates/scoring` by shared golden vectors in `packages/scoring/golden/`.

Database:

- `migrations/0001_init.sql` is the full schema, `migrations/0002_seed_catalog.sql`
  seeds the global exercise catalog (v1 names preserved exactly for import),
  and `migrations/0003_hardening.sql` applies the phase 0 review hardening
  (float8 measurement columns, sync pull indexes, constraint ranges).
- Migrations run through the explicit `cargo run -p waveform-api -- migrate`
  subcommand; `RUN_MIGRATIONS=true` opts into startup migration (default
  is false so production never runs DDL on boot).

## Legacy v1

`legacy/` holds the original single-file PWA (`index.html`, `app.js`,
`styles.css`, `sw.js`, `manifest.webmanifest`, `icons/`). It is not served
anymore. It exists so the Phase 2 import converter can reproduce the v1 JSON
backup schema and map its exercise names onto the global catalog.
