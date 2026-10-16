# Waveform Decision Records

Last updated: 2026-10-15

Status markers: [LOCKED] current and binding, [SUPERSEDED] replaced by a later ADR (kept for
history only), [SUPERSEDED IN PART], [HISTORICAL] provisional record later finalized.

## 2026-10-13 - Phase 1: Multi-user path via vanilla JS + Supabase [SUPERSEDED]

**Status: SUPERSEDED 2026-10-14** by the C-2 full rebuild ADRs below. Kept for history only;
the keep-the-PWA / Supabase path is off the table and must not be re-proposed.

**Context**: Ship accounts, multi-activity logging (lifting/cycling/climbing), leaderboard and
heatmap for a small friend group, without losing the offline-first PWA or existing data.

**Decision**: Keep the vanilla JS PWA (refactor `app.js` into ES modules, zero build step); add
Supabase (GoTrue auth + Postgres + RLS) as managed backend; localStorage outbox + `updated_at`
pull for offline-first sync; keep GitHub Pages static hosting.

**Rationale**: Auth + per-user isolation is the riskiest thing to hand-roll (iOS PWA quirks,
token refresh); RLS gives it structurally. Social queries are trivial SQL. Near-zero cost at
friend scale.

**Trade-offs**: Vendor coupling and one vendored dependency (supabase-js); outbox/sync logic is
owned in all options.

## 2026-10-13 - Phase 1: Dual-layer leaderboard scoring [SUPERSEDED IN PART]

**Status: SUPERSEDED IN PART 2026-10-14**: EP survives but is heatmap currency only, never a
ranked board; the universal ranked board is Consistency. See "Scoring model finalized" below.

**Context**: Rank weightlifting, cycling, and climbing on one board without a physiological
model.

**Decision**: Overall board ranks Effort Points (EP): duration x per-discipline intensity
(strength 1.0, climbing 1.1, cycling 0.9) + bounded bonuses (PRs, elevation, sends), capped at
100 EP/day. Per-discipline boards show native numbers (volume/e1RM, distance/elevation,
grade/V-points).

**Rationale**: Minutes-based effort is honest cross-sport currency for amateurs; daily cap
blocks grinding; native numbers stay visible where they matter.

**Trade-offs**: EP is gamification, not physiology. Accepted: per-discipline boards carry the
real metrics.

## 2026-10-13 - Phase 0: Full rebuild (C-2) chosen [HISTORICAL]

**Status: Provisional; finalized by the 2026-10-14 stack-lock ADR below.**

**Context**: User explicitly chose to rebuild infrastructure as a long-term portfolio
centerpiece. The keep-the-PWA recommendation is withdrawn.

**Decision**: C-2 rebuild: SolidJS + Vite PWA frontend; Rust (Axum + SQLx) backend in a
pnpm + Turbo + Cargo monorepo; managed Postgres (Railway); opaque-session + OTP/GitHub-OAuth
invite-only auth; offline-first writes (IndexedDB outbox) with server-aggregated social reads.

**Rationale**: Proven Rust + SolidJS code in `fitness_control_center` ports directly (analytics
SQL, UI system). Postgres buys multi-user aggregation; Tauri-command patterns map to REST
handlers.

**Trade-offs**: Slower than a TypeScript stack; auth has no drop-in Rust library (own thin
session/OTP glue, integration-tested).

## 2026-10-13 - Phase 0: Unify e1RM on Brzycki (retire Epley) [RATIFIED 2026-10-14]

**Status (2026-10-15)**: extended, not superseded. `packages/scoring` ports this formula and is
fenced against `crates/scoring` by shared golden vectors; see the 2026-10-15 scoring-parity ADR.

**Context**: v1 (liftlog) used Epley (`w * (1 + r/30)`); `fitness_control_center` analytics
uses Brzycki (`w / (1.0278 - 0.0278 * r)`). Two formulas would corrupt PR comparisons once
analytics is ported.

**Decision**: Brzycki everywhere. Implemented once in `crates/scoring` and in the Postgres
generated column `set_entries.e1rm_kg`. On import of v1 data, e1RM recomputes from preserved
kg x reps. The UI labels the metric "e1RM (Brzycki)".

**Rationale**: Raw kg x reps are preserved, so history recomputes losslessly. Brzycki behaves
better at higher rep counts and matches the analytics code being ported.

**Trade-offs**: Historical PR badges on imported data may reorder (high-rep sets shift slightly
against the old Epley numbers). Accepted: comparisons stay internally consistent, which is what
users perceive.

**Rejected**: Keeping Epley for cosmetic continuity. It would fork the formula set across the
ported analytics and the new schema, permanently double-implementing e1RM to preserve badge
numbers that are themselves estimates.

## 2026-10-14 - Phase 0: C-2 stack locked (SolidJS + Axum/SQLx + Postgres) [LOCKED]

**Context**: Stack justified on performance and functionality merits only (team-size arguments
excluded), against the evidence dossier in `docs/research.md`. Workload: ~25 REST endpoints,
JSON CRUD, read-heavy Postgres aggregates (leaderboard/heatmap), idempotent batch-upsert sync,
future WS feed.

**Decision**: Frontend SolidJS + Vite + @solidjs/router + vite-plugin-pwa (Workbox), static SPA
PWA. Backend Rust, Axum + SQLx + Postgres on Railway. Shared types via `ts-rs` into
`packages/api-types` (committed; CI drift check). Tooling: pnpm workspaces + Turborepo (JS) and
a Cargo workspace (Rust).

**Rationale**: Rust/Axum leads on workload-matched benchmarks (TechEmpower R23 Fortunes,
axum/postgresql 1,114,265 RPS, 2nd overall; app + Postgres comparison: Axum 15,363 vs
FastAPI 2,267 rps), compile-time SQL correctness (sqlx `query!`; only Go sqlc rivals it),
footprint (~5 MB image, 11 MiB peak RSS), WS headroom (tokio-tungstenite 327k msg/s), native
f64 scoring compute, and direct reuse of `fitness_control_center` analytics. SolidJS wins on
update performance (fine-grained signals, no VDOM; ~1.1x vanilla vs React ~1.8x) and transfer
size (TodoMVC 19 KB vs React 189 KB), and its components + cyberpunk CSS port directly.

**Explicit weighting note**: at <=10 users raw RPS is immaterial (every candidate is 1000x
over-provisioned). The decisive criteria are compile-time SQL correctness, deployment
footprint, auth ecosystem, WS/compute headroom, and code reuse. Rust's single weak column is
auth ecosystem; the invite-only OTP + one OAuth provider surface bounds that cost.

**Trade-offs**: Own thin auth glue (OTP + sessions, integration-tested); thinner chart-wrapper
ecosystem than React (accepted: charts are hand-rolled SVG); `ts-rs` output can drift (CI
fails the build).

**Rejected**: Go (near-peer; wins on x/oauth2 hardening, loses on SQL compile-checking and
analytics reuse); TypeScript/Node (deepest auth ecosystem, but no compile-time SQL, larger
footprint); TypeScript/Bun (immature Postgres tooling); Python/FastAPI (~7x slower in the
matched benchmark, GIL); React, Svelte 5, Vue, Angular (React loses update perf and transfer
size; Svelte 5 loses component inventory and template typing; Vue/Angular trail on both).

## 2026-10-14 - Phase 0: Fork + Pull Requests contribution model [SUPERSEDED IN PART 2026-10-14]

**Status: SUPERSEDED IN PART 2026-10-14**: the origin repo was renamed from ajeet-krish/liftlog to ajeet-krish/waveform on 2026-10-14; the fork and PR model itself is unchanged.

**Context**: v1 lives at atma99/liftlog (original author). The rebuild is a long-term
portfolio centerpiece maintained in the user's own space.

**Decision**: Fork + PR model. Remotes: `origin` = ajeet-krish/liftlog (the fork; work lands
here), `upstream` = atma99/liftlog (canonical v1 repo). Every change merges through a PR,
including solo work, with required CI checks (pnpm lint/test, cargo test, ts-rs drift, sqlx
migration check).

**Rationale**: Preserves attribution to the original author; PRs provide a CI gate, review
trail, and clean revert points; matches the public portfolio narrative.

**Trade-offs**: Merge ceremony per change; upstream sync is manual (rare, v1 is in
maintenance). Accepted: the CI gate alone pays for the ceremony in a rewrite of this size.

## 2026-10-14 - Phase 0: Scoring model finalized [LOCKED]

**Context**: Cross-discipline ranking (lifting, cycling, climbing) must motivate without
pretending to physiology. Finalizes and supersedes the ranked-EP idea from 2026-10-13.

**Decision**: Per-discipline boards (lifting: weekly volume, absolute best e1RM per marquee
lift, relative e1RM / bodyweight; cycling: distance, elevation; climbing: V-points sum of
2^grade plus hardest grade) plus one universal Consistency board (active days in window;
tie-break weekly streak of weeks with >=3 active days). Effort Points (EP): minutes x intensity
(lift 1.0, climb 1.1, ride 0.9) plus bounded bonuses (PR, sends, elevation), capped at 100/day.
EP is the heatmap currency only and never a ranked board. Ties share rank (1, 2, 2, 4).

**Rationale**: EP as a ranked board distorts cross-sport comparison; as heatmap currency it
rewards consistency of effort without crowning one "best athlete". Shared ranks avoid false
precision among friends.

**Trade-offs**: No single overall champion. Deliberate: native metrics carry the real meaning
per discipline.

## 2026-10-14 - Phase 0: Product renamed to Waveform [LOCKED]

**Context**: The product inherited the name "LiftLog" from v1 and the upstream project. The
rebuild is a distinct product, so it carries its own identity rather than the inherited one.

**Decision**: Full rename of the display name and of all identifiers that name our project: Rust
crates `waveform-*` (api, db, scoring, sync, analytics), npm packages `waveform`, `@waveform/web`,
and `@waveform/api-types`, Postgres database/user/password/volume, environment variables (for
example `WAVEFORM_TEST_DATABASE_URL`), infra, CI, and docs. The GitHub fork was renamed from
ajeet-krish/liftlog to ajeet-krish/waveform; upstream atma99/liftlog is unchanged. `legacy/` is
preserved untouched as the historical v1 artifact and the import source.

**Rationale**: A distinct product identity for the rebuild, while preserving attribution to the
original author and keeping the v1 import source intact.

**Trade-offs**: Rename churn across the whole tree once; stale local `.env` files and Docker
volumes named for the old project must be recreated.

## 2026-10-14 - Phase 0: Hosting pivot to GitHub Pages, backend and Postgres deferred [LOCKED]

**Context**: The prior plan targeted Cloudflare Pages for the web app plus Railway Hobby for the
API and Postgres (about $5/mo).

**Decision**: Deploy the static SPA to GitHub Pages as the project site
(ajeet-krish.github.io/waveform/) with an env-driven Vite base, a relative PWA scope, and a
`404.html` SPA fallback. Defer the managed API and Postgres. Run Postgres and Mailpit locally via
Docker for development. Revisit free-tier managed hosting (Neon or Supabase for Postgres, Render
or Fly for the web service) in a later phase.

**Rationale**: Zero host cost. Phase 0 stores no data and the app is offline-first, so a deployed
backend adds nothing yet.

**Trade-offs**: Sign-in, sync, and social stay non-functional in the deployed site until the
backend lands (they are non-functional everywhere today). Accepted: the deployed site is a preview
shell and local development carries the real work.

## 2026-10-15 - Phase 1: Local-first single-user core, backend deferred to Phase 2 [LOCKED]

**Context**: The phase plan had Phase 1 as the training core plus offline sync plus the v1 data
import, which bundled a backend dependency (auth, push/pull) into the first user-facing phase and
delayed every usable surface.

**Decision**: Rescope Phase 1 to a local-first, single-user client on IndexedDB with no backend in
the path: workouts, exercises and history, the exercise catalog, body stats, climbing, cycling, the
dashboard, settings, and local backup. Sync push/pull, the v1 import converter, routines, and the
remaining activity types (running/hike/swim) move to Phase 2.

**Rationale**: The hard Phase 1 risks are client data modeling, offline UX, and scoring parity;
none of them need a server. Shipping the local core first makes the app real and demoable on
GitHub Pages while keeping auth plus sync as an isolated Phase 2.

**Trade-offs**: Phase 1 is single-user and single-device, with no leaderboards or cross-device
data. Accepted: writes are already outbox-shaped, so sync lands as a drain loop rather than a
rewrite.

## 2026-10-15 - Phase 1: Dexie/IndexedDB local mirror with outbox-shaped writes [LOCKED]

**Context**: Phase 1 needs durable, offline, transactional local storage with no backend, and
Phase 2 needs sync to be a drop-in rather than a re-model.

**Decision**: Local rows are the SQL row shape minus the server-stamped `applied_at`, stored in
Dexie (IndexedDB). Every mutation writes its row(s) and appends one outbox op (`op_id`, `entity`,
`action`, `payload`, `updated_at`, `created_at`) inside the same IndexedDB transaction. Deletes are
soft tombstones carrying the full row; catalog rows are server-owned and write no ops.

**Rationale**: The outbox is exactly the Phase 2 push payload, and `user_id`/`updated_at`/
`deleted_at` are already stamped, so sync becomes a drain loop plus a pull merge. Transactional
co-writes mean a crash can never leave a row without its op or an op without its row.

**Trade-offs**: Local storage is per-browser and evictable (see the storage ADR), and writes carry
some bookkeeping. Accepted: it is the price of a drop-in sync and crash safety.

## 2026-10-15 - Phase 1: Client scoring parity via shared golden vectors [LOCKED]

**Context**: The client needs e1RM, V-points, and Effort Points without a server call, and a second
implementation of the formulas risks silent divergence from `crates/scoring`.

**Decision**: Add `packages/scoring` (`@waveform/scoring`), a TypeScript port of `crates/scoring`.
Fence both with `packages/scoring/golden/scoring.golden.json`, a versioned vector file for e1RM,
V-points, total V-points, Effort Points, and daily Effort Points. The vitest suite and
`crates/scoring/tests/golden.rs` run the same file, so changing one expected value fails both.

**Rationale**: A shared, language-neutral vector file turns divergence into a test failure instead
of a drift bug, and is stricter and cheaper than hand-mirroring unit tests across two languages.

**Trade-offs**: Two implementations of the same math. Accepted: the golden fence keeps them honest,
and the Rust side stays authoritative for the future server.

## 2026-10-15 - Phase 1: Canonical backup v2 with merge LWW and typed replace [LOCKED]

**Context**: With no server, backup and restore are the only durability story, and Phase 2 sync has
to reconcile the same data.

**Decision**: `format: "waveform-backup"`, `version: 2` carries raw rows (tombstones included) for
the profile, the three workout tables, the catalog, activities, body stats, and the device-local
`climb_sends` histogram. Parse validates the envelope and every row against the repo guards,
all-or-nothing. Merge writes only strictly newer rows (LWW on parsed instants) and never touches
existing outbox rows; replace requires a typed confirmation, wipes the data stores, outbox, and
`sync_meta` (drafts survive), then restores. Every written row queues one op with `updated_at` equal
to the row's own LWW time and `created_at` at import time; `e1rm_kg` is recomputed.

**Rationale**: One format and one apply path serve both local restore and the later server import.
LWW on parsed instants makes equal timestamps compare equal whatever their ISO spelling; row-time
`updated_at` with import-time `created_at` preserves both sync truth and drain order.

**Trade-offs**: A backup is a raw device dump, not a merged cross-device view. Accepted: it is
exactly what a restore needs, and v1 backups route to the Phase 2 legacy converter.

## 2026-10-15 - Phase 1: Deterministic UUIDv5 catalog identity [LOCKED]

**Context**: The server seeds the catalog with random `gen_random_uuid()` ids. The client needs ids
that survive a wipe and let the Phase 2 v1 import map legacy exercise names onto catalog rows.

**Decision**: Derive catalog ids client-side with RFC 4122 UUIDv5 over the DNS namespace and
`lower(name)`, so a name always maps to the same id. `ensureCatalog` seeds the 118-row catalog
idempotently; `catalogParity.test.ts` parses `0002_seed_catalog.sql` and fails on any content or
order drift. Server and client id convergence is deferred to the sync phase.

**Rationale**: Deterministic ids make re-seeding and legacy mapping stable without a server call,
and mirror the SQL `lower(name)` unique key.

**Trade-offs**: Client catalog ids do not match the server's random ids yet, so the Phase 2 sync
must reconcile them (for example by matching on `lower(name)`). Accepted: catalog rows are
server-owned and write no ops, so nothing collides before sync lands.

## 2026-10-15 - Phase 1: Local-only climb_sends histogram in Dexie v2 [LOCKED]

**Context**: The climbing UX needs per-grade send counts (the grade picker and V-points), but the
locked `activities` table stores only `climb_grade`, `climb_grade_value`, and `routes_sent`.

**Decision**: Dexie v2 adds a device-local `climb_sends` store keyed by `activity_id`, holding a
17-slot count array (V0..V16). It never enters the outbox; the activity repo derives the row's
summary columns from it, and V-points come from the histogram. The v1 to v2 upgrade is lossless
because Dexie only adds stores.

**Rationale**: Keeps the server schema unchanged while giving the client the richer input it
needs, and the derived summary columns mean the synced row stays consistent even if the histogram
is lost.

**Trade-offs**: The histogram does not sync (it is carried only in the v2 backup file) and can
diverge per device. Accepted: the summary columns it derives are the synced truth.

## 2026-10-15 - Phase 1: Storage persistence and a guarded write boundary [LOCKED]

**Context**: IndexedDB is evictable when storage is tight and unavailable in some modes (private
browsing), and the local log is the only copy of the data.

**Decision**: `lib/storage.ts` asks for persistent storage once per `StorageManager` handle, wraps
every repo write method (`guardRepos`), and on a quota (`QuotaExceededError`) or unavailable
(`InvalidStateError`/`SecurityError`) failure publishes exactly one `StorageFailure` on a small bus
while rethrowing unchanged. Writes outside the wrapped repos (the import's whole-transaction apply)
publish through `reportStorageFailure`. The shell shows a quota alert with a backup export, or a
blocked screen with a retry.

**Rationale**: One guarded boundary means the app never silently drops a write, and the failure bus
turns an opaque DOMException into an actionable backup prompt.

**Trade-offs**: Persistence is a request, not a guarantee, and `persist()` may be refused.
Accepted: the alert plus backup export is the honest fallback.

## 2026-10-15 - Phase 1: Drop the v1 import path entirely [LOCKED]

**Context**: The `legacy/` folder (the original single-file v1 PWA) and the `importConverters.ts`
converter registry were kept as a deferred seam for migrating v1 users onto the Waveform backup
format. The product owner never used the old app, so there is no v1 data to migrate.

**Decision**: Remove the seam entirely: `legacy/` and `apps/web/src/lib/importConverters.ts` (plus
its test) are deleted, and `parseImportFile` no longer sniffs foreign exports. A JSON file that
does not carry the Waveform backup format is rejected with an honest "does not look like a
Waveform backup file" issue.

**Rationale**: A seam with no users is dead weight: it is code, docs, and test surface for a
migration that will never run. Deleting it now keeps the importer honest about what it accepts.

**Trade-offs**: A real v1 export in the wild can no longer be imported. Accepted: there is no v1
data to import, and the Waveform backup format is the only import path.

## 2026-10-15 - Phase 2: Email + password accounts with bearer sessions [LOCKED]

**Status: LOCKED. Supersedes the invite-only auth design (email 6-digit OTP typed manually, or
GitHub OAuth) recorded in the 2026-10-13 C-2 rebuild ADR and repeated in the stack-lock ADR's
explicit-weighting note; those ADRs stay as written for history.**

**Context**: The auth surface planned in Phase 0 assumed an invite-only friend group and an
email inbox in the loop (Mailpit in dev). Phase 2 needs signup and login for a small group
that does not want to type OTP codes, and the OTP/invite/OAuth machinery (otp_codes, invites,
GitHub id linking, email verification) is a large surface for a product with no public
registration.

**Decision**: Accounts are email + password, nothing else:
- Signup and login are `POST /auth/signup` and `POST /auth/login` with an email and a
  password; the password is stored as an Argon2id PHC string in `users.password_hash`
  (nullable column, added by migration 0006; login rejects NULL because no bucket 1
  account has a hash yet).
- No OTP, no MFA, no email verification, no GitHub OAuth. The `github_id` column stays in
  the schema as a retired column rather than a migration target; invites and OTP tables
  remain from Phase 0 but are dead until a later decision revives them.
- Sessions are opaque bearer tokens presented in an `Authorization: Bearer` header, never
  a cross-site cookie, so no CSRF surface and no cookie plumbing; the server stores only a
  hash of the token (the existing `sessions.token_hash` shape).
- Bucket 1 ships only the groundwork: the column plus the auth DTOs (`SignupRequest`,
  `LoginRequest`, `AuthResponse`). The signup and login handlers land in bucket 2.

**Rationale**: One auth path with one failure mode beats three. Password auth needs no
inbox, no OAuth app registration, and no invite CLI; bearer headers sidestep the cookie
CSRF class entirely, which matters more than the (available, but heavier) cookie patterns
at friend-group scale.

**Trade-offs**: Passwords put breach hygiene on us (Argon2id plus a future rate limit and
password reset story). Accepted: no email verification means anyone can claim an unowned
address until reset flows land, and the retired OTP/invite tables linger in the schema
until a cleanup ADR removes them.

## 2026-10-15 - Phase 2: Server catalog ids converge on client UUIDv5 [LOCKED]

**Status: LOCKED. Completes the 2026-10-15 "Deterministic UUIDv5 catalog identity" ADR,
which deferred server/client id convergence to the sync phase.**

**Context**: The server seeded the global exercise catalog with random `gen_random_uuid()`
ids while the client derives deterministic RFC 4122 UUIDv5 ids over the DNS namespace and
`lower(name)` (`apps/web/src/db/seed/uuidV5.ts`). With sync landing, two id spaces for one
catalog would force a name-based reconciliation on every pull.

**Decision**: Migration 0006 converges the server on the client derivation:
- A core-Postgres `waveform_uuidv5(namespace, name)` (plpgsql SHA-1 plus `set_byte` for the
  version and variant bits, no pgcrypto) and `waveform_catalog_id(name)` =
  `uuidv5(DNS, lower(name))`, byte for byte what `uuidV5.ts` computes.
- Every global catalog row is remapped to `waveform_catalog_id(name)`, and
  `exercise_entries.exercise_id` / `routine_entries.exercise_id` follow in the same
  transaction. The two FKs become `DEFERRABLE INITIALLY IMMEDIATE` and the migration runs
  `SET CONSTRAINTS ALL DEFERRED` so parent and child updates coexist; guard blocks raise a
  clear exception on a catalog name collision or an occupied target id, and the whole file
  is re-entrant (a second run matches zero rows).
- The parity fence has three legs: the SQL helper, `crates/db/tests/catalog_uuidv5.rs`
  (SQL versus `uuid::new_v5`, before/after counts, orphans, re-entrancy), and the same
  golden vectors in the client vitest suite (`uuidV5Golden.test.ts`).

**Rationale**: Deterministic ids computed twice and fenced by tests beat ids reconciled at
runtime: pulls carry ids the client already knows, the Phase 2 import can map names onto
catalog rows without a lookup table, and re-seeding stays idempotent on both sides.

**Trade-offs**: One irreversible data migration (remapped ids) and a plpgsql SHA-1 to
maintain in SQL. Accepted: the dev reversibility path is `docker compose down -v` plus a
re-run, the helper is fenced against the Rust and TypeScript implementations, and the
alternative (per-pull name matching) would live forever in the sync engine.

## 2026-10-15 - Phase 2 bucket 2: Session token hashing, login throttle, and the Render deploy target [LOCKED]

**Status: LOCKED. Implements the email + password auth ADR above; the OTP/invite tables and
`github_id` column stay retired as that ADR records.**

**Context**: Bucket 2 lands the real auth handlers on top of the bucket 1 groundwork
(`users.password_hash` plus the auth DTOs). Three operational questions were open: how the
opaque session token is stored, how login resists password spraying at friend-group scale,
and where the API actually runs now that it needs to be reachable from the deployed
GitHub Pages site.

**Decision**:
- **Session token hashing**: the server generates a 256-bit random token, returns it in
  `AuthResponse`, and stores only `HMAC-SHA256(token)` keyed by `SESSION_SECRET` (a long
  random string, generated with `openssl rand -hex 32`) in `sessions.token_hash`.
  `SESSION_SECRET` therefore has a real role beyond minimum length, and **rotating it
  invalidates every active session** (a deliberate global logout). Plain SHA-256 was
  rejected: an attacker with database read access could not invert it, but HMAC keyed by a
  secret the database never sees adds a second factor to a database-only breach. Sessions
  live `SESSION_TTL_DAYS = 30` from login; `POST /auth/logout` deletes by hash and is
  always 204 (idempotent), and `GET /auth/me` re-resolves the session per call, so expiry
  and revocation are immediate. The HMAC is implemented over `sha2` per RFC 2104 and
  fenced by the RFC 4231 vectors in the unit tests, keeping one shared `hash_token`
  primitive across issuance, lookup, and logout so the paths can never disagree on the
  encoding.
- **Login throttle**: an in-memory limiter (10 failed attempts per 15 minutes, keyed by
  `trim` then lowercase email) guards `POST /auth/login` and `POST /auth/signup`; a
  successful login clears the window. It is process-local by choice: a shared store would
  add infrastructure for a one-instance free-tier deployment, and restarts resetting
  counters is an accepted trade-off. Login answers one byte-identical 401 "invalid email or
  password" for unknown email, wrong password, and NULL-hash accounts, and verifies against
  a constant dummy Argon2 PHC string so misses cost the same time as real checks.
- **Handler surface**: `POST /auth/signup` is open (no invite) and validates against
  `RuleConstants` (password 10 to 1024 bytes, email 3 to 254 bytes with a dotted domain
  and no whitespace, display name trimmed to 1 to 60 characters); passwords hash with
  Argon2id (m=19456, t=3, p=1, 32-byte output) in `spawn_blocking`, and a duplicate
  address answers 409 with exactly "an account with that email already exists". A valid
  signup answers 201 and login 200, both carrying `AuthResponse` (token, expiry, user;
  the user never serializes `password_hash`). CORS is one exact allow-list layer over the
  whole router (GET/POST/OPTIONS, Authorization and Content-Type, no credentials, 600s
  max age).
- **Deploy target**: Postgres on Neon (free tier), API on Render (free web service) built
  from the repo-root `Dockerfile` (multi-stage rust:1-bookworm to debian:bookworm-slim).
  `render.yaml` pins `preDeployCommand: waveform-api migrate` so migrations are an explicit
  release step (never DDL on boot; `RUN_MIGRATIONS=false`), with a documented fallback
  `startCommand: waveform-api`, `healthCheckPath: /healthz`, and the GitHub Pages origin as
  the exact CORS allow-list. `infra/railway.toml` is header-marked as superseded.

**Rationale**: Keyed HMAC makes the session secret enforceable (rotation kills sessions)
instead of decorative; the throttle is the smallest thing that stops online password
spraying without new infrastructure; Neon + Render + Docker keeps the whole backend on
free tiers while matching the CI image story (one Dockerfile, one binary, migrate as a
subcommand that only needs `DATABASE_URL`).

**Trade-offs**: Rotating `SESSION_SECRET` logs users out (accepted: it doubles as the
"revoke all sessions" lever); sessions have no sliding expiration, living 30 days from
login regardless of activity (accepted for now; refresh mechanics would revisit); the
in-memory throttle is per-process and resets on deploy (accepted at one instance; a shared
limiter can revisit with multi-instance hosting); free-tier cold starts and the 750-hour
limit are acceptable for a friend group.
- **Per-email lockout DoS**: because the throttle is keyed by email, an attacker who knows
  a victim's address can lock that address out of login and signup by failing logins
  against it, keeping it limited through repeated 15-minute windows for as long as they
  keep going. Mitigations planned: the window is already short (15 minutes), a per-IP
  failure counter keyed off `X-Forwarded-For` (trusted only behind the platform proxy)
  would cap what one source can do to one victim, and a DB-backed `login_attempts` table
  would survive restarts and serve multiple instances.

## 2026-10-16 - Phase 2 bucket 3: Client sync engine (single flight, compaction, quarantine, per-entity cursors, adoption) [LOCKED]

**Status: LOCKED. Client half of the Phase 1 outbox shape and the bucket 1 server sync
engine; the sign-in surface rides the 2026-10-15 email + password auth ADR.**

**Context**: The server can now accept pushes and serve cursor pages (bucket 1), and the
browser can create sessions (bucket 2), but nothing joined them: the Phase 1 outbox only
grew, pull cursors were never walked, and every local row carried a made-up user id the
server would never recognize. The loop that closes this must stay honest under a flaky
phone network (queue never drops a write, retries never stampede), must not push data the
user chose to discard on first sign-in, and must keep working with no account at all.

**Decision**:
- **Single-flight runs**: one run at a time, `compactOutbox` (once) then `drainOutbox` to
  empty in `maxOpsPerPush` batches then `pullAll`. `requestSync(reason)` joins an in-flight
  run and queues exactly one follow-up round under the newest trigger's reason, so a burst
  of triggers collapses to at most one extra pass. Triggers: bootstrap on `start()` while
  signed in, a 2 s debounce on `subscribeOutboxWrites`, `window online`,
  `visibilitychange` to visible, and a manual sync. Transport failures set "offline" and
  back off exponentially (1 s base, x2, 5 minute cap, reset on success) on injectable
  timers; a 401 sets "auth-expired" and halts the engine; a run still in flight after 2 s
  reads as "waking" so a cold free-tier wake looks alive instead of frozen.
- **Outbox compaction**: the first run after this lands compacts the Phase 1 queue once
  (flagged in the same transaction as the deletions), keeping only the newest op per
  `(entity, id)` in drain order. Without a server, that queue may hold dozens of edits to
  one row where only the newest matters.
- **Quarantine stays authoritative**: an op the server rejects three times is parked
  (`quarantined`, stored, excluded from pending) so one poisoned row cannot wedge the
  queue. The engine surfaces parked counts on the Account screen and the chip; requeueing
  parked ops is a later pass.
- **Per-entity cursors**: `pullAll` resumes each of the six entities from
  `pull_cursor:{entity}`, parents first, persisting each page's merges and its next cursor
  in one IndexedDB transaction; a completed tip stamps `last_synced_at`. Merges are
  last-write-wins on `updated_at`; a winner drops the queued ops it supersedes into the
  capped `conflict_log` so conflicts stay observable. Pull errors are read through a
  watching wrapper because `pullAll` folds ApiErrors into `complete: false`.
- **Adoption**: first sign-in asks "Upload my existing local data" (default; rewrites
  `owner_id`/`user_id`, outbox payloads, and re-keys `local_profile` onto the server id)
  or "Start empty" (typed "empty" confirmation; wipes the synced stores, clears cursors,
  re-seeds the catalog, pulls the account down fresh). Both stamp `adopted_user_id`; the
  engine is gated until the choice lands, then the repos rebind via
  `createRepos(db, { userId })` so later writes stamp the real owner.
- **Address resolution**: `sync_meta` `api_base_url` override, then `VITE_API_BASE_URL`
  (baked by the Pages workflow), then the localhost default; Account > Advanced can set or
  clear the override at runtime.

**Rationale**: Single flight with one queued round is the smallest structure that cannot
race itself while still not losing a write that lands mid-run; exponential backoff with a
hard cap keeps a dead network from hammering a free-tier instance, and the reset on
success makes the schedule reflect the network as it is now. Compacting before the first
push keeps the wire honest (one newest op per row) instead of replaying a year of local
churn. Quarantining at three matches the server's reject semantics: retrying a rejected
payload forever would only burn the push budget. Adoption must run before sync because the
server force-writes owners from the bearer session: pushing first would resurrect exactly
the rows "Start empty" exists to drop, and merging later would still leave this device's
profile id disagreeing with its account.

**Trade-offs**: The device shows "local only" until the first-sign-in choice is answered
(accepted: correctness of "Start empty" beats a silent auto-upload, and the prompt is one
tap for the default). Backoff is per-device with no jitter (accepted at one device per
person; a shared schedule would matter for many devices on one account). Quarantined ops
park indefinitely with no requeue UI yet (accepted for bucket 3; the count is visible and
a review pass is listed as follow-up). The conflict log is capped at 200 entries and is
observability, not history (accepted: LWW means a dropped op is already resolved). The
engine's count refresh defers a macrotask past Dexie's write transaction rather than
joining it (accepted: a 0 ms hop keeps `sync_meta` reads in scope without restructuring
the hook).
