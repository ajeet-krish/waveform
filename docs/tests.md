# Waveform Test Results

Last updated: 2026-10-15

## 2026-10-15 - Phase 1: Test Inventory (Tester agent)

Phase 1 shipped the local-first client in four sub-phases (1a data core, 1b bootstrap and logger,
1c schema v2 and activities, 1d import and storage resilience). This section records the suites
and counts; the Phase 0 and rebrand entries below are kept for history, and their totals
(66/15 and 78/19) are now superseded.

### Totals

| Suite | Files | Tests | Notes |
|-------|-------|-------|-------|
| Web (`apps/web`) | 36 | 315 | vitest over the db core and lib view models |
| Scoring (`packages/scoring`) | 4 | 42 | Brzycki, climbing, effort, and the golden fence |
| Scoring fence (Rust) | 1 | 6 | `crates/scoring/tests/golden.rs`, part of the Rust workspace total |
| Rust workspace | - | 84 | unit plus integration across the four crates |

The scoring golden fence spans both languages: `packages/scoring/golden/scoring.golden.json` is
consumed by the TS suite (`golden.test.ts`) and by `crates/scoring/tests/golden.rs`. Flipping one
vector fails both suites, so the two implementations cannot silently diverge.

### Key guarantees fenced by tests

- **Scoring parity**: the shared golden vectors pin e1RM, V-points, total V-points, Effort Points,
  and daily Effort Points identically in TypeScript and Rust; one edited expected value fails both
  suites.
- **Catalog migration parity**: `catalogParity.test.ts` parses `migrations/0002_seed_catalog.sql`
  and fails on any content or order drift from the 118-row `CATALOG_SEED`.
- **Outbox atomicity**: `repos.test.ts` commits a draft with one invalid set and asserts every
  table and the outbox roll back together, with the draft untouched. Repo writes and their ops
  share one IndexedDB transaction.
- **Dexie v1 to v2 upgrade**: `schema.test.ts` opens a v1 database, upgrades it, and asserts the
  data is preserved while the three new stores (`activities`, `body_stats`, `climb_sends`) appear
  with their indexes.
- **Import merge idempotence**: `backupImport.test.ts` proves a second identical merge writes
  nothing and queues no ops.
- **Import replace atomicity under injected quota**: a quota failure during replace (and merge)
  leaves every store unchanged; the failure is published once on the storage bus.

### Commands run

```sh
npx pnpm@10 --filter @waveform/web test
npx pnpm@10 --filter @waveform/scoring test
cargo test --workspace
WAVEFORM_TEST_DATABASE_URL=postgres://waveform:waveform@localhost:5432/waveform cargo test --workspace
```

## 2026-10-14 - Phase 0: Test Report (Tester agent)

Expanded Phase 0 coverage from 24 Rust tests to 66 and from 5 Vitest tests to 15. No
production code was changed; only test code was added (test files and dev-dependencies
in `crates/db`).

### Commands run

```sh
docker compose -f infra/docker-compose.yml up -d postgres   # Postgres 16-alpine, healthy
WAVEFORM_TEST_DATABASE_URL=postgres://waveform:waveform@localhost:5432/waveform cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings       # clean
cargo fmt --check                                            # clean
npx pnpm@10.14.0 --filter ./apps/web test
npx pnpm@10.14.0 --filter ./apps/web lint                    # tsc --noEmit, clean
```

### Rust results (66 passed, 0 failed)

| Suite | Tests | Verdict | Notes |
|-------|-------|---------|-------|
| waveform-analytics unit | 3 | PASS | pre-existing |
| analytics `tests/week_boundaries` (new) | 3 | PASS | year-boundary week_start, Monday invariant sweep over leap year 2024, order-independence |
| waveform-db `export_ts` | 1 | PASS | regenerates api-types; no drift in `packages/` |
| db `tests/schema` (new, real Postgres) | 7 | PASS | fresh apply, idempotent re-run, generated e1rm vs Rust scoring, CHECK/UNIQUE constraints, tombstones + partial index, seed catalog |
| waveform-scoring unit | 16 | PASS | pre-existing |
| scoring `tests/brzycki_domain` (new) | 7 | PASS | rep domain 1..=36, guards 0/37/u32::MAX, monotonic in reps, linear in weight |
| scoring `tests/climbing_domain` (new) | 6 | PASS | 2^grade table, doubling, order-independence, hard-send dominance |
| scoring `tests/effort_domain` (new) | 10 | PASS | intensities, per-bonus caps, 100/day cap inclusive, zero/negative days, [0,100] property sweep |
| waveform-sync unit | 4 | PASS | pre-existing |
| sync `tests/outbox_contract` (new) | 9 | PASS | op idempotency, LWW tie-break, tombstone + resurrection, out-of-order, pull cursor |

The db `tests/schema` suite requires Postgres. Without
`WAVEFORM_TEST_DATABASE_URL` (or `DATABASE_URL`) each of its 7 tests prints a
skip notice and returns, so `cargo test --workspace` stays green with no infra.
Verified both modes: 7 skipped without the env var, 7 passed (0.5 s) with the
compose Postgres.

### Frontend results (15 passed, 0 failed; 4 files)

| Suite | Tests | Verdict | Notes |
|-------|-------|---------|-------|
| `heat.test.ts` | 2 | PASS | pre-existing |
| `week.test.ts` (extended) | 5 | PASS | +3: month-spanning week ISO formatting, week 53 years, Tuesday year-end rolling to W01 |
| `nav.test.ts` (new) | 4 | PASS | five unique tabs, Home exact-match, icon coverage, sections = tabs + Activities |
| `activities.test.ts` (new) | 3 | PASS | cards cover exactly the five schema activity types; only cycling/climbing linked |

### Failure analysis

| Test | Root cause | Fix |
|------|-----------|-----|
| `e1rm_scales_linearly_in_weight` (new test) | test typo: decomposition `62.5 + 137.5 = 200`, asserted equal to the 100 kg base | changed to `62.5 + 37.5` (test bug, not a production bug) |
| 4 db schema tests (new tests) | scaffold inserted a global "Back Squat", colliding with the partial unique index fed by `0002_seed_catalog.sql` | scaffold now inserts a per-user exercise (`owner_id` set); the interaction is codified in `global_catalog_names_are_unique_but_custom_exercises_are_not` |
| `delete_tombstones_the_row_and_blocks_older_updates` (new test) | in-memory harness wiped payload on delete; contract expects last-known payload preserved under the tombstone | harness keeps the stored payload for delete ops |

All three failures were in newly added test code. No production defect was found.

### Coverage summary and notes for other agents

- Brzycki parity is now enforced end to end: `set_entries.e1rm_kg` (real SQL
  insert/select) matches `waveform_scoring::e1rm_brzycki` to numeric(6,2)
  rounding at reps 1, 2, 5, 10, 20, 36 and two weights.
- The schema CHECK ceiling (reps 36) is the last Brzycki domain point with a
  positive denominator; the Rust guard at 37+ is defensive only.
- The sync crate is contract-only in phase 0; `tests/outbox_contract.rs` pins
  the documented semantics over an in-memory engine built on `incoming_wins`.
  Phase 1 should replay these scenarios against the Postgres push handler.
- CI gap to watch: schema tests skip silently without `WAVEFORM_TEST_DATABASE_URL`;
  a CI Postgres service (or `DATABASE_URL`) is required to get real coverage,
  and the skip is only visible with `-- --nocapture`.
- There is no sport-grade normalization in `crates/scoring`; `activities.climb_grade`
  is stored as a raw label with `climb_grade_value` numeric(4,1). If a VB/V17+
  or Font mapping is added later, it needs its own tests here.
- Minor ergonomics: `DAILY_EP_CAP` is public via `waveform_scoring::effort` but
  not re-exported at the crate root like the other effort items.

## 2026-10-14 - Waveform rebrand + Pages deploy: Test Report (Tester agent)

Verification matrix for the "Waveform rebrand + GitHub Pages deploy" change set on
branch `rebrand/waveform`. The counts in the Phase 0 entry above (66 Rust / 15 JS)
predate the rebrand and are now stale; the fresh totals from this run are 78 Rust /
19 JS. No production or test code was changed by this pass.

### Commands run

```sh
cargo test --workspace                                            # 78 passed, 0 failed
WAVEFORM_TEST_DATABASE_URL=postgres://waveform:waveform@localhost:5432/waveform cargo test --workspace  # 78 passed, 0 failed, 0 skipped
cargo test export_ts && git diff -- packages/api-types/src/generated.ts  # exit 0, empty diff
docker compose -f infra/docker-compose.yml up -d postgres         # already healthy
WAVEFORM_TEST_DATABASE_URL=postgres://waveform:waveform@localhost:5432/waveform cargo test -p waveform-db  # 11 passed
npx pnpm@10 install --frozen-lockfile                             # lockfile up to date
npx pnpm@10 build ; npx pnpm@10 lint ; npx pnpm@10 test           # 2/3/3 tasks ok
npx pnpm@10 lint --force ; npx pnpm@10 test --force               # uncached: clean, 19/19
VITE_BASE_PATH=/waveform/ npx pnpm@10 --filter @waveform/web run build
cp apps/web/dist/index.html apps/web/dist/404.html && cmp apps/web/dist/index.html apps/web/dist/404.html  # identical
grep -oE '(href|src)="/[^"]*"' apps/web/dist/index.html | grep -v '/waveform/'   # no matches
grep -rIl -i liftlog . --exclude-dir=node_modules --exclude-dir=target --exclude-dir=dist --exclude-dir=.turbo --exclude-dir=.git
npx pnpm@10 --filter @waveform/web run build                      # normal base restored, 404.html removed
```

### Rust results (78 passed, 0 failed)

| Crate / suite | Tests | Verdict | Notes |
|---------------|-------|---------|-------|
| waveform-analytics unit (`src/lib.rs`) | 3 | PASS | pre-existing |
| analytics `tests/week_boundaries` | 3 | PASS | pre-existing |
| waveform-api unit (`src/main.rs`) | 0 | PASS | binary has no tests |
| waveform-db unit (`export_ts`) | 1 | PASS | regenerates api-types |
| db `tests/model_decode` | 3 | PASS | new since Phase 0 (double-precision models, SQL hardening, pull paging) |
| db `tests/schema` (real Postgres) | 7 | PASS | genuinely executed only with a DB URL; see caveat below |
| waveform-scoring unit | 17 | PASS | was 16 in Phase 0 |
| scoring `tests/brzycki_domain` | 7 | PASS | pre-existing |
| scoring `tests/climbing_domain` | 6 | PASS | pre-existing |
| scoring `tests/effort_domain` | 10 | PASS | pre-existing |
| waveform-sync unit | 8 | PASS | was 4 in Phase 0 |
| sync `tests/outbox_contract` | 13 | PASS | was 9 in Phase 0 |
| Doc-tests (4 crates) | 0 | PASS | none defined |

`cargo test export_ts` passes and `git diff -- packages/api-types/src/generated.ts`
is empty, so the committed generated types are in sync with the Rust definitions.

DB verification ran three ways: (a) plain `cargo test --workspace` reports 78
passed but silently skips the 7 schema tests (skip notices are captured, visible
only with `-- --nocapture`, confirmed 7 SKIPPED lines); (b) with
`WAVEFORM_TEST_DATABASE_URL` the same run reports 78 passed, 0 failed, no skips;
(c) `cargo test -p waveform-db` with the URL runs 11/11 (export_ts 1,
model_decode 3, schema 7) against the compose Postgres 16-alpine container.

### Frontend results (19 passed, 0 failed, 4 files)

| Suite | Tests | Verdict | Notes |
|-------|-------|---------|-------|
| `activities.test.ts` | 3 | PASS | pre-existing from Phase 0 |
| `heat.test.ts` | 2 | PASS | pre-existing |
| `nav.test.ts` | 7 | PASS | was 4 in Phase 0 |
| `week.test.ts` | 7 | PASS | was 5 in Phase 0 |

`@waveform/api-types` "test" and "lint" tasks are `tsc --noEmit` (no JS cases);
build and lint tasks pass in both packages. Turbo cache hits were re-verified with
`--force` (fresh Vitest run: 4 files, 19 passed, exit 0).

### Pages artifact checks (all PASS)

| Check | Verdict | Evidence |
|-------|---------|----------|
| Production build with `VITE_BASE_PATH=/waveform/` | PASS | exit 0, PWA v2.0.0, 15 precache entries, assets emitted |
| All root-absolute refs in `dist/index.html` under `/waveform/` | PASS | 5 root-absolute refs (favicon, apple-touch-icon, JS, CSS, manifest), 0 outside `/waveform/`; only other refs are `https://fonts.googleapis.com*` absolute URLs |
| SW registration honors base path | PASS (bonus) | bundle registers `new Workbox('/waveform/sw.js', {scope: '/waveform/'})`; Vite preload helper prefixes `/waveform/` |
| `manifest.webmanifest` relative fields | PASS | `"start_url":"."`, `"scope":"."`, `"id":"."`; icon srcs relative (`icon-192.png`, etc.) |
| `cp index.html 404.html` byte-identical | PASS | `cmp` exit 0, both 1448 bytes |
| dist free of old branding | PASS (bonus) | 0 case-insensitive `liftlog` matches in `index.html`, `sw.js`, `assets/` |
| Matches CI Pages workflow | PASS | `.github/workflows/pages.yml` sets `VITE_BASE_PATH: /waveform/` and runs the same `cp` fallback step |
| Normal build restored afterward | PASS | rebuilt without `VITE_BASE_PATH` (refs back to `/assets/...`), stale `404.html` removed; `apps/web/dist` is gitignored |

### Rebrand completeness (PASS)

`grep -rIl -i liftlog .` (excluding node_modules, target, dist, .turbo, .git) hits
exactly 9 files, every one an intended historical or out-of-scope reference:

| File(s) | Classification |
|---------|----------------|
| `legacy/index.html`, `legacy/manifest.webmanifest`, `legacy/app.js`, `legacy/sw.js` | legacy v1 app, explicitly out of scope |
| `docs/decisions.md` | intended history: "v1 (liftlog)", `atma99/liftlog` upstream, fork-rename ADR |
| `docs/architecture.md:107` | intended: the `POST /import/liftlog` endpoint contract |
| `docs/reviews.md` | intended: quoted prior findings and the rename review log |
| `migrations/0001_init.sql:1` | intended historical header `/* LiftLog initial schema.`; `git diff` and `git status` for `migrations/` are empty, so it is the pre-rebrand text (the rebrand edit was reverted per docs/reviews.md to preserve sqlx checksums) |

Nothing in `apps/`, `crates/`, `infra/`, `.github/`, lockfiles, or built output.

### Failure analysis

None. Zero tests failed across the matrix; no fix was required.

### Coverage summary and notes for other agents

- Fresh totals: 78 Rust (16 suites) and 19 JS (4 files). The 66/15 figures in the
  Phase 0 entry above predate the rebrand; new coverage since then is
  `db/tests/model_decode` (3), scoring unit +1, sync unit +4,
  `outbox_contract` +4, `nav.test.ts` +3, `week.test.ts` +2.
- Recurring pattern: the 7 schema tests still skip silently without
  `WAVEFORM_TEST_DATABASE_URL`, and `cargo test --workspace` counts them as
  passed. CI needs a Postgres service plus the env var (or `DATABASE_URL`) for the
  count of 78 to mean 78 executed tests.
- Recurring pattern: Turbo cache hits can mask a fresh run. Use `--force` when a
  green lint/test result must prove current inputs.
