# LiftLog Decision Records

Last updated: 2026-10-14

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

## 2026-10-14 - Phase 0: Fork + Pull Requests contribution model [LOCKED]

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
