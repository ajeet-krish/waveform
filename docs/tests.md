# LiftLog Test Results

Last updated: 2026-10-14

## 2026-10-14 - Phase 0: Test Report (Tester agent)

Expanded Phase 0 coverage from 24 Rust tests to 66 and from 5 Vitest tests to 15. No
production code was changed; only test code was added (test files and dev-dependencies
in `crates/db`).

### Commands run

```sh
docker compose -f infra/docker-compose.yml up -d postgres   # Postgres 16-alpine, healthy
LIFTLOG_TEST_DATABASE_URL=postgres://liftlog:liftlog@localhost:5432/liftlog cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings       # clean
cargo fmt --check                                            # clean
npx pnpm@10.14.0 --filter ./apps/web test
npx pnpm@10.14.0 --filter ./apps/web lint                    # tsc --noEmit, clean
```

### Rust results (66 passed, 0 failed)

| Suite | Tests | Verdict | Notes |
|-------|-------|---------|-------|
| liftlog-analytics unit | 3 | PASS | pre-existing |
| analytics `tests/week_boundaries` (new) | 3 | PASS | year-boundary week_start, Monday invariant sweep over leap year 2024, order-independence |
| liftlog-db `export_ts` | 1 | PASS | regenerates api-types; no drift in `packages/` |
| db `tests/schema` (new, real Postgres) | 7 | PASS | fresh apply, idempotent re-run, generated e1rm vs Rust scoring, CHECK/UNIQUE constraints, tombstones + partial index, seed catalog |
| liftlog-scoring unit | 16 | PASS | pre-existing |
| scoring `tests/brzycki_domain` (new) | 7 | PASS | rep domain 1..=36, guards 0/37/u32::MAX, monotonic in reps, linear in weight |
| scoring `tests/climbing_domain` (new) | 6 | PASS | 2^grade table, doubling, order-independence, hard-send dominance |
| scoring `tests/effort_domain` (new) | 10 | PASS | intensities, per-bonus caps, 100/day cap inclusive, zero/negative days, [0,100] property sweep |
| liftlog-sync unit | 4 | PASS | pre-existing |
| sync `tests/outbox_contract` (new) | 9 | PASS | op idempotency, LWW tie-break, tombstone + resurrection, out-of-order, pull cursor |

The db `tests/schema` suite requires Postgres. Without
`LIFTLOG_TEST_DATABASE_URL` (or `DATABASE_URL`) each of its 7 tests prints a
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
  insert/select) matches `liftlog_scoring::e1rm_brzycki` to numeric(6,2)
  rounding at reps 1, 2, 5, 10, 20, 36 and two weights.
- The schema CHECK ceiling (reps 36) is the last Brzycki domain point with a
  positive denominator; the Rust guard at 37+ is defensive only.
- The sync crate is contract-only in phase 0; `tests/outbox_contract.rs` pins
  the documented semantics over an in-memory engine built on `incoming_wins`.
  Phase 1 should replay these scenarios against the Postgres push handler.
- CI gap to watch: schema tests skip silently without `LIFTLOG_TEST_DATABASE_URL`;
  a CI Postgres service (or `DATABASE_URL`) is required to get real coverage,
  and the skip is only visible with `-- --nocapture`.
- There is no sport-grade normalization in `crates/scoring`; `activities.climb_grade`
  is stored as a raw label with `climb_grade_value` numeric(4,1). If a VB/V17+
  or Font mapping is added later, it needs its own tests here.
- Minor ergonomics: `DAILY_EP_CAP` is public via `liftlog_scoring::effort` but
  not re-exported at the crate root like the other effort items.
