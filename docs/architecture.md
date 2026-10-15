# Waveform Architecture

Last updated: 2026-10-14

## Decision Status

Stack is LOCKED (see docs/decisions.md, ADRs dated 2026-10-14). Full rebuild ("C-2"): the
vanilla-JS PWA is replaced; its domain conventions survive, its code does not. The
keep-the-PWA / Supabase path is superseded and must not be re-proposed.

Locked stack: SolidJS + Vite PWA frontend, Rust (Axum + SQLx) API, Postgres, offline-first sync,
invite-only auth (OTP + GitHub OAuth), Brzycki e1RM, Fork + PR workflow. The web app deploys to
GitHub Pages; the API and Postgres are deferred and run locally for development (see Deployment).

## Stack

- **Frontend**: SolidJS + Vite + @solidjs/router + vite-plugin-pwa (Workbox). Static SPA, PWA
  installable. UI system (cyberpunk theme, SVG charts, body map) ported from
  `fitness_control_center/src/styles` + `src/components`.
- **Backend**: Rust. Axum + SQLx + Postgres. Managed hosting is deferred; development runs
  Postgres locally (see Deployment). Crates: `db` (pool, models, queries), `analytics` (ported
  from `fitness_control_center/commands/analytics.rs`), `scoring` (pure, unit-tested), `sync`
  (outbox apply, LWW). `apps/api` wires axum handlers; the handler pattern mirrors the Tauri
  `commands/*` modules being ported.
- **Shared types**: `ts-rs` exports Rust structs to `packages/api-types/src/generated.ts`
  (committed; CI fails on drift).
- **Tooling**: pnpm workspaces + Turborepo (JS) and a Cargo workspace (Rust) at repo root.

## Domain Conventions (carried over from v1)

- Weights stored in **kg** internally, lengths in **cm**; lb/in is display-only conversion.
- **Monday-start** weeks. `local_date` (device timezone) groups heatmap and leaderboard days.
- **4-tab mental model** survives: Workout, History, Exercises, Body (extended by Activities
  and Social tabs).
- The **JSON backup schema** survives as the import/export format.
- e1RM is **Brzycki**: `w / (1.0278 - 0.0278 * r)`, labeled "e1RM (Brzycki)" in the UI. v1's
  Epley is retired; raw kg x reps are preserved so history recomputes losslessly (imported PR
  badges may reorder slightly).

## Monorepo Layout

```
waveform/
├── Cargo.toml                  # Rust workspace: crates/*
├── pnpm-workspace.yaml         # apps/*, packages/*
├── turbo.json
├── apps/
│   ├── web/                    # SolidJS PWA (routes/, stores/, sync/, lib/api.ts)
│   └── api/                    # Axum binary: routers, extractors, handlers
├── crates/
│   ├── db/                     # SQLx pool, migrations runner, models (ts-rs), queries
│   ├── analytics/              # port of fitness_control_center analytics.rs
│   ├── scoring/                # Brzycki e1RM, Effort Points, V-points (pure)
│   └── sync/                   # outbox apply (idempotent), LWW, tombstones, cursors
├── packages/
│   ├── api-types/              # generated TS from Rust (committed; CI drift check)
│   ├── ui/                     # SolidJS components: charts, heatmap grid, body map
│   └── config/                 # shared tsconfig/eslint
├── migrations/                 # SQLx .sql (0001_init.sql, ...)
├── infra/                      # docker-compose (local Postgres + Mailpit), railway.toml
│                               # (API service reference), .github/workflows (ci, pages)
├── scripts/                    # invite CLI (api subcommand), restore drill
└── docs/                       # architecture.md, decisions.md, research.md
```

## Data Model

Tables: `users`, `sessions`, `otp_codes`, `invites`, `groups`/`group_members`, `exercises`
(global catalog + per-user custom), `workout_sessions`, `exercise_entries`, `set_entries`
(generated STORED `e1rm_kg`, Brzycki, CHECK reps 1..36), `activities` (type in
cycling/climbing/running/hike/swim; `distance_km`, `elevation_m`, `climb_grade` +
`climb_grade_value`, `routes_sent`), `body_stats` (**owner-private**), `routines`/
`routine_entries`, `kudos`, `challenges`, `client_ops` (idempotent sync dedupe).

Key properties: client-generated UUID PKs (offline creates never collide); `updated_at` +
`deleted_at` tombstones on every synced row; `local_date` on workouts and activities.
Indexes on `(user_id, local_date)` and on `updated_at` (partial, excluding tombstones) serve
leaderboard, heatmap, and sync-pull queries. Full DDL lives in `migrations/0001_init.sql`.

## Offline-First Sync

Hybrid: **local-first writes, server-aggregated reads**.

```
UI action -> mutate IndexedDB (Dexie) mirror -> render
          -> append {op_id, entity, action, payload, updated_at} -> outbox
sync loop: POST /sync/push (idempotent via client_ops, LWW on updated_at) -> drop acked ops
           GET /sync/pull?since=cursor -> merge into mirror -> render -> advance cursor
```

The in-progress workout lives locally until finished. iOS PWAs lack Background Sync, so the
loop triggers on `online`, `visibilitychange`, app-open, and pull-to-refresh. Social reads
(leaderboard, heatmap, feed) always come from the server.

## Auth

Invite-only (no public signup). Login via email 6-digit OTP, typed manually (magic links break
iOS Add-to-Home-Screen), or GitHub OAuth. Opaque session cookie, sha256 token stored in
`sessions`; OTP codes Argon2id-hashed with attempt limits and rate limiting. All repository
functions scope by session `user_id`; `body_stats` is owner-only; cross-tenant access is
asserted negative by integration tests.

## API Surface (summary)

Auth + invites; `POST /sync/push` + `GET /sync/pull`; JSON CRUD for workouts, activities,
body stats, routines, exercises; social reads (`/leaderboard`, `/heatmap`, `/feed`) and kudos;
`/challenges`; `POST /import/liftlog` (v1 JSON backup schema, idempotent per legacy id);
`/healthz`.

## Scoring

- **Effort Points (EP)** is the heatmap currency only: `minutes x intensity (lift 1.0,
  climb 1.1, ride 0.9) + bounded bonuses (PR, sends, elevation)`, capped at 100/day. Heatmap
  levels: 0, 1-25, 26-50, 51-75, 76-100.
- **Boards** (7d / 4w / 12w windows): universal **Consistency** (active days; tie-break weekly
  streak of weeks with >=3 active days) plus per-discipline boards: lifting (weekly volume,
  absolute best e1RM per marquee lift, relative e1RM / bodyweight), cycling (distance,
  elevation), climbing (V-points = sum of 2^grade, hardest grade). Ties share rank (1, 2, 2, 4).

## Deployment

Web is a static SPA on GitHub Pages at the project site https://ajeet-krish.github.io/waveform/,
built from `apps/web` and deployed by `.github/workflows/pages.yml`. The build sets Vite `base`
to `/waveform/` and ships a `404.html` fallback, so client-side routes survive deep links. API +
Postgres are deferred: Phase 0 stores no data and the app is offline-first, so managed hosting is
not needed yet. Development runs locally with Postgres and Mailpit via
`docker compose -f infra/docker-compose.yml up -d` and the API on localhost:8080. When
multi-device or group access is needed, add a free-tier managed Postgres (Neon or Supabase) and a
free web-service tier (Render or Fly), with `infra/railway.toml` kept as the reference for the
API service. CI gates: pnpm lint/test, cargo test, ts-rs drift check, sqlx migration check.

## Phase Plan

- Phase 0: monorepo, schema + migrations, CI/CD, deploy skeleton, auth shell.
- Phase 1: training core (workouts, exercises), offline sync, v1 data import.
- Phase 2: activities (cycling/climbing), body stats, routines.
- Phase 3: social (boards, heatmap, feed, kudos).
- Phase 4: challenges, hardening, backup/restore drill.
