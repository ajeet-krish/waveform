# Waveform Architecture

Last updated: 2026-10-15

## Decision Status

Stack is LOCKED (see docs/decisions.md, ADRs dated 2026-10-14). Full rebuild ("C-2"): the
vanilla-JS PWA is replaced; its domain conventions survive, its code does not.

Phase 1 shipped as a **local-first, single-user client**: the app runs entirely on IndexedDB
(via Dexie) with no backend in the request path. The Rust API, the Postgres schema, auth, and the
`sync` crate are in the repo from Phase 0 but are **deferred**: sync push/pull and the v1 import
converter are Phase 2. See Deployment.

Locked stack: SolidJS + Vite PWA frontend, Rust (Axum + SQLx) API, Postgres, offline-first sync,
invite-only auth (OTP + GitHub OAuth), Brzycki e1RM, Fork + PR workflow. The web app deploys to
GitHub Pages; the API and Postgres are deferred and run locally for development.

## Stack

- **Frontend**: SolidJS + Vite + @solidjs/router + vite-plugin-pwa (Workbox). Static SPA, PWA
  installable, base-path aware for GitHub Pages. Local persistence is Dexie (IndexedDB); charts
  are hand-rolled SVG.
- **Shared scoring**: `packages/scoring` (`@waveform/scoring`) holds Brzycki e1RM, V-points, and
  Effort Points in TypeScript, fenced against `crates/scoring` by a shared golden vector file.
- **Backend (deferred)**: Rust, Axum + SQLx + Postgres. Crates: `db` (pool, models, queries),
  `analytics` (ported from `fitness_control_center/commands/analytics.rs`), `scoring` (pure),
  `sync` (outbox apply, LWW). `apps/api` wires the axum handlers.
- **Shared types**: `ts-rs` exports Rust structs to `packages/api-types/src/generated.ts`
  (committed; CI fails on drift).
- **Tooling**: pnpm workspaces + Turborepo (JS) and a Cargo workspace (Rust) at repo root.

## Domain Conventions (carried over from v1)

- Weights stored in **kg** internally, lengths in **cm**; lb/in conversion happens once, at the
  `lib/format.ts` and `lib/setInput.ts` boundary.
- **Monday-start** weeks. `local_date` (device timezone) groups history, the week strip, and the
  heatmap days.
- **4-tab mental model** survives, extended by Activities and Social.
- The **Waveform backup JSON** is the portable format; v1 backup import maps onto it in Phase 2.
- e1RM is **Brzycki**: `w / (1.0278 - 0.0278 * r)`, labeled "e1RM (Brzycki)". v1's Epley is
  retired; raw kg x reps are preserved so history recomputes losslessly.

## Monorepo Layout

```
waveform/
├── Cargo.toml                  # Rust workspace: crates/*
├── pnpm-workspace.yaml         # apps/*, packages/*
├── turbo.json
├── apps/
│   ├── web/                    # SolidJS PWA
│   │   └── src/
│   │       ├── db/             # local-first data core: Dexie schema, repos, validation, seed
│   │       ├── lib/            # pure view models + browser glue (backup, storage, forms)
│   │       ├── routes/         # one file per screen
│   │       └── components/     # Shell, panels, workout/activity/body widgets
│   └── api/                    # Axum binary: routers, extractors, handlers (deferred)
├── crates/
│   ├── db/                     # SQLx pool, migrations runner, models (ts-rs), queries
│   ├── analytics/              # port of fitness_control_center analytics.rs
│   ├── scoring/                # Brzycki e1RM, Effort Points, V-points (pure)
│   └── sync/                   # outbox apply (idempotent), LWW, tombstones, cursors
├── packages/
│   ├── api-types/              # generated TS from Rust (committed; CI drift check)
│   ├── scoring/                # @waveform/scoring: TS scoring + shared golden vectors
│   └── config/                 # shared tsconfig/eslint
├── migrations/                 # SQLx .sql (0001_init.sql, 0002_seed_catalog.sql, ...)
├── infra/                      # docker-compose (Postgres + Mailpit), railway.toml, workflows
├── scripts/                    # invite CLI (api subcommand), restore drill
├── legacy/                     # v1 PWA, kept untouched as the Phase 2 import source
└── docs/                       # architecture.md, decisions.md, research.md, reviews.md, tests.md
```

## Local Data Core (`apps/web/src/db`)

The client's system of record. `db` is a lazy `WaveformDb` IndexedDB singleton.

**Schema (Dexie v2, eleven stores).** Synced rows mirror their SQL table minus server-stamped
`applied_at`: `exercises` (id, owner_id), `workout_sessions` (id, local_date), `exercise_entries`
(id, workout_id), `set_entries` (id, exercise_entry_id), `activities` (id, local_date, type),
`body_stats` (id, local_date). Device-local stores: `workout_drafts`, `outbox` (op_id,
created_at), `local_profile`, `sync_meta`, and `climb_sends` (activity_id). The v1 to v2 upgrade
is lossless: Dexie only adds the three new stores and leaves existing data untouched.

**Outbox contract.** Every repo mutation writes its row(s) and appends one op inside the same
`db.transaction`. An op carries `op_id` (client UUID, idempotent on replay), `entity`, `action`
(create/update/delete), `payload`, `updated_at` (the row's LWW timestamp, equal to the row's, or
overridden on restore), and `created_at` (local only, orders the drain). A crash can never leave
a row change without its op. Deletes are soft tombstones carrying the full row. Catalog rows are
the one documented exception: the server owns them, so seeding writes no ops.

**Repositories** (`createRepos(db, { userId, now })`): `exercises` (catalog read plus custom CRUD),
`workouts` (sessions, entries, sets, and date-range trees), `drafts` (local-only scratch; `commit`
expands a draft into synced rows atomically), `profile` (local-only, writes no ops), `activities`
(cycling and climbing; derives `climb_grade`, `climb_grade_value`, and `routes_sent` from a send
histogram), `body` (one live row per `local_date`), and `outbox` (listPending/removeAcked/count).

**Validation** (`validation.ts`): client guards mirror the SQL CHECKs (`SET_RULES` reps 1..36,
weight 0..1500 kg; `ACTIVITY_RULES` duration 0..1440, grade 0..16, routes >= 0; `BODY_RULES`
weight > 0, bodyfat 0..100), so a bad row fails inside the writing transaction instead of at
sync-push time. The form layer validates against the same constants.

**Catalog seed** (`seed/`): `CATALOG_SEED` transcribes the 111 live global catalog rows in file
order from `0002_seed_catalog.sql`, which seeds 118 rows; the seven duplicates that
`0004_catalog_cleanup.sql` soft-deletes are named in `CATALOG_REMOVED_NAMES` and absent here.
`ensureCatalog` bulk-inserts the seed idempotently when a device has none, then reconciles the
retired names on every bootstrap (neither step writes ops); `catalogSeedId` derives a
deterministic RFC 4122 UUIDv5 over `lower(name)`, mirroring the SQL `lower(name)` unique key.
`catalogParity.test.ts` parses both migrations and fails on any content or order drift, including
drift between `CATALOG_REMOVED_NAMES` and the 0004 cleanup list.

**Reactive bridge** (`query.ts`): `createLocalQuery(querier)` materializes a Dexie `liveQuery`
into Solid signals (`latest`, `error`, `loading`) and unsubscribes on cleanup; `observeQuery` is
the framework-free core.

## Scoring

- **One formula, two implementations, one fence.** `@waveform/scoring` ports `crates/scoring`
  (`e1rmBrzycki`, `vPoints`/`totalVPoints`, `effortPoints`/`effortPointsDaily`). Both run
  `packages/scoring/golden/scoring.golden.json`, a versioned vector file with a tolerance, from
  the vitest suite and from `crates/scoring/tests/golden.rs`. Change one expected value and both
  suites fail. Brzycki is also the Postgres generated column `set_entries.e1rm_kg`.
- **Effort Points (EP)** is the heatmap currency only: `minutes x intensity (lift 1.0, climb 1.1,
  ride 0.9) + bounded bonuses (PR, sends, elevation)`, capped at 100/day. Heatmap levels: 0,
  1-25, 26-50, 51-75, 76-100.
- **Boards** (7d / 4w / 12w windows, Phase 3): universal **Consistency** (active days; tie-break
  weekly streak of weeks with >=3 active days) plus per-discipline boards: lifting (weekly volume,
  best e1RM per marquee lift, relative e1RM / bodyweight), cycling (distance, elevation), climbing
  (V-points = sum of 2^grade, hardest grade). Ties share rank (1, 2, 2, 4).

## App Shell, Routes, and lib Modules

**Shell** (`components/Shell.tsx` + `lib/appData.tsx`): `AppDataProvider` opens the DB, seeds the
catalog, and resolves status `loading`/`setup`/`ready`/`error`. No profile means first-run
`Setup`; otherwise the routed console. A blocked or failed log renders `StorageBlocked` (retry
re-runs bootstrap); a quota failure renders the `StorageAlert` bar above the page.

**Routes** (`routes/`): Dashboard (week-at-a-glance plus quick actions), Setup (first run),
Workout (draft-first logger with live e1RM and debounced autosave), History (Monday-start week
sections) plus HistoryDetail, Exercises (catalog plus custom CRUD) plus ExerciseHistory
(per-exercise sets and sparkline), Activities overview plus Cycling and Climbing, Body (weight,
body fat, and tape log), Profile (settings, backup export and import), Setup/Login/NotFound, and
the deferred Social placeholders (Leaderboard, Heatmap, Feed).

**lib modules** (pure view models plus thin browser glue):
- Dates and format: `week.ts` (Monday math), `today.ts` (live "today" signal), `format.ts` (kg/cm
  display and dates), `history.ts` (week-grouped session summaries), `weekStats.ts` (sessions,
  volume, active days).
- Workout: `workoutLog.ts` (draft reducers plus working-set stats), `draftAutosave.ts` (debounced,
  serialized saves), `setInput.ts` (typed text to numbers against `SET_RULES`), `exerciseDetail.ts`
  and `exerciseStats.ts` (per-exercise history and stats).
- Activities: `climbing.ts` (17-slot histogram and V-points via scoring), `activities.ts`
  (discipline cards and window summaries), `activitySummary.ts` (spoken ride and climb summaries).
- Body: `bodyReadings.ts` (field model), `bodyChart.ts` (weight and body-fat series).
- Heat: `heat.ts` (Effort Points to heat levels, matching `crates/scoring`).
- Forms and UI: `forms.ts` (signal-based form state), `formInputs.ts`, `errors.ts` (issue copy),
  `nav.ts` (tabs and sections), `catalog.ts` (muscle groups plus custom-exercise rules),
  `sparkline.ts`.
- Backup and storage: `backup.ts`, `backupImport.ts`, `importSummary.ts`, `importConverters.ts`,
  `storage.ts`.

**Components** (`components/`): Shell, CommandBar, TabBar, WeekStrip, PageHeader, Panel,
EmptyState, ConfirmDialog, StorageAlert, StorageBlocked, Sparkline, Icon, Logo, plus
`workout/` (ActiveSession, ExercisePicker, SetLog), `activity/` (ActivityCard, ClimbForm,
RideForm, GradePicker), and `body/` (BodyChart, BodyForm).

## Backup and Import

**Format v2** (`lib/backup.ts`): one JSON envelope (`format: "waveform-backup"`, `version: 2`,
`app.schema_version`, `exported_at`) carrying raw rows, tombstones included, for the profile, the
three workout tables, the catalog, activities, body stats, and the device-local `climb_sends`
histogram. Export runs in the browser (Blob download), no network hop.

**Import** (`lib/backupImport.ts`): `parseImportFile`/`parseBackup` validate the envelope and
every row against the same repo guards, all-or-nothing (one bad row rejects the file, zero
writes). `applyBackupImport` runs one Dexie transaction per mode: **merge** writes only rows whose
incoming `updated_at` is strictly newer (LWW on parsed instants) and leaves existing outbox rows
alone; **replace** requires a typed confirmation, wipes the data stores, outbox, and `sync_meta`
(drafts survive), then restores every row. Each written row queues one op whose `updated_at` is
the row's own LWW time and whose `created_at` is import time, so the outbox drains in import
order. `e1rm_kg` is recomputed on import. `importConverters.ts` is the seam for the Phase 2 v1
converter (deterministic UUIDv5 over `liftlog:<id>`); an unregistered source returns an honest
"arrives in Phase 2" issue.

## Storage Resilience

`lib/storage.ts` is framework-free: `ensurePersistentStorage` asks `navigator.storage.persist()`
once per handle; `guardRepos` wraps every repo write method so the first call persists, and a
quota (`QuotaExceededError`) or unavailable (`InvalidStateError`/`SecurityError`) failure publishes
exactly one `StorageFailure` on a small bus while rethrowing unchanged. Writes outside the wrapped
repos (the import's whole-transaction apply) classify and publish through `reportStorageFailure`.
`appData.tsx` subscribes to the bus; `StorageAlert` offers a backup export, `StorageBlocked`
offers a retry.

## Deferred Backend Design (Phase 2 target)

Tables: `users`, `sessions`, `otp_codes`, `invites`, `groups`/`group_members`, `exercises`
(global catalog plus per-user custom), `workout_sessions`, `exercise_entries`, `set_entries`
(generated STORED `e1rm_kg`, Brzycki, CHECK reps 1..36), `activities` (type in
cycling/climbing/running/hike/swim; `distance_km`, `elevation_m`, `climb_grade` +
`climb_grade_value`, `routes_sent`), `body_stats` (**owner-private**), `routines`/
`routine_entries`, `kudos`, `challenges`, `client_ops` (idempotent sync dedupe). Client-generated
UUID PKs, `updated_at` + `deleted_at` tombstones on every synced row, `local_date` on workouts and
activities. Sync is local-first writes with server-aggregated reads: push is idempotent via
`client_ops`, pull is by cursor, LWW resolves on `updated_at`; the local outbox drains to
`POST /sync/push`. Auth is invite-only (email 6-digit OTP typed manually, or GitHub OAuth),
opaque session cookie, sha256 token, Argon2id-hashed OTP codes; `body_stats` is owner-only. Full
DDL lives in `migrations/0001_init.sql`.

## Phase Plan

- Phase 0: monorepo, schema + migrations, CI/CD, deploy skeleton, auth shell.
- Phase 1: local-first training core (workouts, exercises, history, body stats, climbing,
  cycling, dashboard, settings and backup). Shipped client-side on IndexedDB; no backend.
- Phase 2: backend + auth + sync push/pull, the v1 import converter, routines, and the remaining
  activity types (running/hike/swim).
- Phase 3: social (boards, heatmap, feed, kudos).
- Phase 4: challenges, hardening, backup/restore drill.

## Deployment

Web is a static SPA on GitHub Pages at the project site https://ajeet-krish.github.io/waveform/,
built from `apps/web` and deployed by `.github/workflows/pages.yml`. The build sets Vite `base`
to `/waveform/` and ships a `404.html` fallback, so client-side routes survive deep links. API +
Postgres are deferred: Phase 1 runs entirely on local storage, so managed hosting is not needed
yet. Development runs locally with Postgres and Mailpit via
`docker compose -f infra/docker-compose.yml up -d` and the API on localhost:8080. When
multi-device or group access is needed, add a free-tier managed Postgres (Neon or Supabase) and a
free web-service tier (Render or Fly), with `infra/railway.toml` kept as the reference for the
API service. CI gates: pnpm lint/test, cargo test, ts-rs drift check, sqlx migration check.
