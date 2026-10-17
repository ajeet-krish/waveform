# Waveform Platform

Comprehensive fitness tracker for strength training plus running, cycling, climbing,
hiking, and swimming, with a consistency grid and crew leaderboards. Rust
(Axum + SQLx) API on Postgres, SolidJS + Vite frontend, in a pnpm + Turbo (JS)
and Cargo (Rust) monorepo. Weights in kg, lengths in cm, Brzycki e1RM.

## Quick Commands

Backend, Cargo workspace:

- `cargo build --workspace` builds the Rust workspace.
- `cargo test --workspace` runs all Rust tests (api, db, scoring, analytics, sync). Set `WAVEFORM_TEST_DATABASE_URL=postgres://waveform:waveform@localhost:5432/waveform` to also run the Postgres-backed suites; without it they skip.
- `cargo clippy --workspace --all-targets -- -D warnings` lints; warnings fail.
- `cargo fmt --check` verifies formatting.
- `cargo run -p waveform-api -- migrate` applies migrations and exits.
- `cargo run -p waveform-api` serves the API on port 8080; migration on startup is opt-in (`RUN_MIGRATIONS=true`, default false).
- `cargo test export_ts` regenerates `packages/api-types/src/generated.ts`; commit it, CI fails on drift.

Frontend, pnpm workspace (`apps/web`, `packages/*`):

- `pnpm install` installs JS dependencies (use `npx pnpm@10 install` if pnpm is not global; `packageManager` pins pnpm@10.14.0).
- `pnpm build` runs the Turbo build pipeline.
- `pnpm lint` runs the Turbo lint pipeline.
- `pnpm test` runs the Turbo test pipeline.
- `pnpm dev` runs the Turbo dev pipeline (persistent, uncached).

Local infra:

- `docker compose -f infra/docker-compose.yml up -d` starts Postgres (and Mailpit, inert Phase 0 residue) for local development.
- Web deploys to GitHub Pages; the API deploys to Render from the repo-root `Dockerfile` against Neon Postgres (`render.yaml`), and runs locally via Docker.

## Conventions

- Rust: 4-space indent, K&R braces; snake_case functions and modules, PascalCase types and traits, SCREAMING_SNAKE_CASE consts.
- `unsafe_code` is forbidden workspace-wide; clippy warnings are errors in CI.
- TypeScript and SolidJS: strict TS, no `any`; edit generated API types in Rust, never by hand.
- SQLx migrations are append-only: one new file per change, never edit an applied one.
- Store weights in kg and lengths in cm internally; lb and in are display-only.
- e1RM is Brzycki (`w / (1.0278 - 0.0278 * r)`), defined once in `crates/scoring` and in the `set_entries.e1rm_kg` generated column.
- Weeks start Monday; device-timezone `local_date` groups heatmap and board days.
- Conventional Commits. Every change merges through a PR with required CI checks.
- No em dashes or double hyphens in prose; command flags keep their leading `--`.

## Project Map

- `apps/api` - Axum library plus thin binary: auth routes (signup, login, logout, me), extractors, rate limiter, config, state.
- `apps/web` - SolidJS + Vite: routes, the IndexedDB data core (`src/db`), and `src/lib` modules. Phase 1 done.
- `crates/db` - SQLx pool, migration runner, row models (ts-rs), queries.
- `crates/scoring` - Brzycki e1RM, Effort Points, V-points (pure, unit-tested).
- `crates/analytics` - aggregation metrics ported from fitness_control_center.
- `crates/sync` - outbox apply, last-write-wins, tombstone contract.
- `packages/api-types` - TypeScript types generated from Rust (committed).
- `packages/scoring` - TS Brzycki e1RM, V-points, Effort Points; shared golden vectors fence the Rust crate.
- `packages/ui` - SolidJS components: charts, heatmap grid, body map. Planned.
- `migrations` - SQLx SQL: `0001_init.sql` (schema), `0002_seed_catalog.sql` (seed).
- `infra` - `docker-compose.yml` (Postgres + Mailpit), `railway.toml` (superseded by `render.yaml`).
- `Dockerfile` and `render.yaml` - Render deploy: multi-stage API image, free web service, pre-deploy `waveform-api migrate`.
- `docs` - architecture, decision records, research.

## Status

| Phase | Description | Status |
|-------|-------------|--------|
| Phase 0 Foundation | Monorepo, schema and migrations, CI/CD, GitHub Pages deploy | Complete |
| Phase 1 Local-first training core | Workouts, exercises, body stats, climbing, cycling, dashboard, settings and backup (no backend) | Complete |
| Phase 2 Backend + auth + sync | Live API (Neon + Render), email and password auth, multi-device sync (buckets 1-3), shared-device safety, routines, and all five activity types; quarantine requeue open | In progress |
| Phase 3 Social | Leaderboards, heatmap, feed, kudos | Not started |
| Phase 4 Challenges + hardening | Challenges, hardening, backup and restore drill | Not started |

## Deep Docs

- [Architecture](docs/architecture.md) - stack, data model, sync, scoring, phases.
- [Decisions](docs/decisions.md) - ADRs (stack lock, scoring, PR model).
- [Research](docs/research.md) - stack evaluation evidence dossier.
- [Reviews](docs/reviews.md) - code review findings and resolutions.
- [Tests](docs/tests.md) - test inventory and coverage notes.
