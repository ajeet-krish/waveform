# Waveform Reviews

Last updated: 2026-10-16

## 2026-10-14 - Phase 0: Foundation review (full-stack)

Verdict: PASS WITH ISSUES

Scope: apps/api, crates/{db,scoring,analytics,sync}, migrations/0001 and 0002, apps/web,
packages/api-types, CI, infra, root tooling, docs consistency. Review basis: static analysis
against docs/architecture.md and docs/decisions.md. No code was modified.

### Findings

| Severity | File:Line | Issue | Fix |
|----------|-----------|-------|-----|
| High | crates/db/src/models.rs:153,158,189,190,194,212-223,252 | SQLx cannot decode Postgres NUMERIC into Rust f64 (sqlx 0.8.6 type compatibility covers FLOAT8 only, see sqlx-postgres types/float.rs). Every model with a numeric column (SetEntry, Activity, BodyStats, RoutineEntry) will fail at runtime with "mismatched types" on first query. Phase 1 is blocked on this and no CI job exercises it. | Either add the rust_decimal or bigdecimal sqlx feature and use that type, or change the columns to double precision, or add `#[sqlx(try_from = "BigDecimal")]` wrappers. |
| High | crates/sync/src/lib.rs:14-16,39-41; migrations/0001_init.sql:259-261 | Pull cursor `updated_at > cursor` over client-supplied timestamps is unsafe as specified: (1) one device with a future-skewed clock writes one row and every subsequent pull is starved until that wall-clock time passes; (2) rows sharing a timestamp across a page boundary are silently skipped by a strictly-greater cursor; (3) JS Date truncates to milliseconds while timestamptz stores microseconds, so ties are common. | Make the cursor server-authoritative (a server `applied_at` sequence), page on (updated_at, id) composite, and clamp or reject client updated_at values more than a few minutes in the future. Document the rule in the sync contract. |
| Medium | migrations/0001_init.sql:136,150,172,195,219,232,104,120 | The partial `updated_at` indexes (`WHERE deleted_at IS NULL`) cannot serve sync-pull queries, which must return tombstones so clients learn about deletes. They also lack `user_id`, so per-user pulls scan globally and filter. Architecture.md claims these indexes serve sync-pull. | Add per-entity `(user_id, updated_at)` indexes that include tombstones, or a dedicated sync index per table. Keep the partial indexes for live-row reads if useful. |
| Medium | migrations/0001_init.sql:221-229 | `kudos` UNIQUE (workout_id, user_id) conflicts with the tombstone contract: a soft-deleted kudos still occupies the unique slot, so un-kudos followed by re-kudos (new client-generated id) violates the constraint and the push fails. | Make the unique index partial (`WHERE deleted_at IS NULL`) or specify resurrect semantics (upsert on (workout_id, user_id), undelete the tombstone) in the sync contract. |
| Medium | migrations/0001_init.sql:160-165 | `e1rm_kg numeric(6,2)` overflows for plausible mistyped data (for example weight_kg 300.00 at 36 reps computes 11111, exceeding 9999.99). The generated column computes before CHECK validation, so a bad row aborts with an opaque numeric-overflow error instead of a clean constraint violation. | Bound `weight_kg` with a realistic upper CHECK (for example <= 1500) and widen e1rm_kg to numeric(7,2). |
| Medium | migrations/0001_init.sql:160-165 vs crates/scoring/src/brzycki.rs:19-29 | DB rounds e1rm to 2 decimals (numeric(6,2)); Rust returns full f64. The "keep the two in sync" claim holds for the formula but not for the value. Phase 1 PR detection comparing Rust-computed to DB-stored e1RM will disagree at the 0.01 level. | Document the rounding boundary (DB is authoritative, compare with 0.01 tolerance) or round in the Rust helper. |
| Medium | crates/db/src/lib.rs:56-71; crates/db/src/models.rs:205-227 | `BodyStats` derives TS but is missing from the `export_ts` list and therefore absent from packages/api-types/src/generated.ts. The Body product surface has no generated type. | Add `BodyStats::export()` to the export loop and regenerate. |
| Medium | apps/web/src/routes/Body.tsx:22-27 vs migrations/0001_init.sql:199-216 | Body UI shows "Height ... cm" and the lede says "Weight, height, and body fat", but `body_stats` has no height column and the BodyStats model has none either. | Decide now: add `height_cm` in an append-only migration (0003) or drop Height from the UI copy. |
| Medium | migrations/0001_init.sql:138-147 | `exercise_entries.exercise_id` references `exercises` ON DELETE CASCADE, so a hard delete of a custom exercise destroys workout history (entries and, transitively, set_entries). History must outlive exercise catalog rows. | Use ON DELETE RESTRICT (or SET NULL with a snapshot of the name) and rely on the deleted_at soft-delete discipline for catalog rows. |
| Medium | crates/sync/src/lib.rs:7-9 | Idempotency is specified only as "replay of a stored op_id is a no-op". Two gaps: (1) the dedupe check must verify the op row belongs to the pushing user, otherwise a replayed foreign op_id silently suppresses a victim's op (first writer wins); (2) the row upsert and the client_ops insert must commit in one transaction or a crash between them makes the op unreplayable. | Specify: reject (409) on op_id collision with a different user_id, and apply each op atomically with its client_ops row. |
| Medium | apps/web/src/lib/nav.ts:10-25; apps/web/src/App.tsx:21-36 | The documented 4-tab mental model (Workout, History, Exercises, Body) survives the rebuild, but there is no Exercises route or nav entry anywhere in the route tree. | Add an /exercises route stub and an Exercises entry in SECTIONS (and TABS if the 4-tab model is literal). |
| Medium | docs/architecture.md:120-121 | Session-cookie auth across unrelated origins (Cloudflare Pages SPA plus Railway API) means cross-site cookies, which Safari blocks (including inside iOS home-screen PWAs). The auth design as written will fail on iOS unless a custom domain makes app and API share an eTLD+1 (same-site cookies) or tokens move to an Authorization header. | Decide the domain layout before Phase 1 auth lands; document it in a new ADR. |
| Medium | migrations/0001_init.sql:14 | `users.email` UNIQUE is case-sensitive; Foo@x.com and foo@x.com become distinct accounts and OTP lookups keyed by exact string behave differently per casing. | Replace with `CREATE UNIQUE INDEX ... ON users (lower(email))`. |
| Low | crates/db/src/models.rs:32-63 | Session, OtpCode, and Invite derive Serialize while holding `token_hash` / `code_hash`; a handler that serializes these rows directly would leak hashes in responses. | Add `#[serde(skip_serializing)]` on the hash fields or use dedicated response DTOs. |
| Low | migrations/0001_init.sql:127,180-187,204 | No CHECK bounds on duration_min (>= 0), bodyfat_pct (0..100), climb_grade_value, routes_sent (>= 0); only reps and weight_kg are constrained. | Add range CHECKs in a later append-only migration as handlers land. |
| Low | crates/scoring/src/climbing.rs:9-15 | `v_points` accepts negative grades (fractional points) and very large grades (infinity) with no validation; schema allows climb_grade_value to 999.9. | Validate or clamp grade to the documented 0..=16 V-scale at the API boundary. |
| Low | README.md:22-38,70-71 | README says "The SolidJS app (apps/web) arrives in phase 1" and its layout block omits apps/web, both stale for Phase 0. | Refresh README to match the repo. |
| Low | .github/workflows/ci.yml:36-40 | ts-rs regeneration merges into the existing generated.ts, so decls for types later removed from Rust linger forever and the drift check stays green. | `rm packages/api-types/src/generated.ts` before `cargo test export_ts` in the drift job. |
| Low | apps/web/src/components/WeekStrip.tsx:10; apps/web/src/routes/Heatmap.tsx:41 | `new Date()` is captured once per render; a long-lived session does not roll over at midnight or across week boundaries. | Drive "today" from a signal refreshed on visibilitychange or a midnight timer. |
| Low | apps/web/src/routes/Login.tsx:37-74 | One form with two submit buttons; when Phase 1 wires handlers, Enter-key submits resolve to the first button and `SubmitEvent.submitter` must disambiguate. | Split into two forms or branch on `event.submitter`. |
| Low | apps/web/src/routes/Profile.tsx:35 | "Sessions survive reinstalls on the home screen app" is unverified; iOS typically wipes home-screen app storage on removal (cookies may survive; IndexedDB mirror will not). | Verify the claim before shipping or soften the copy. |
| Low | infra/docker-compose.yml:21 | `axllent/mailpit:latest` is unpinned; a floating tag can break dev environments. | Pin a version tag. |
| Low | crates/sync/Cargo.toml:9 | `serde` is an unused dependency in waveform-sync (and lint-level "unused" will not catch it). | Drop it or use it when op payloads get typed. |
| Low | packages/api-types/package.json:12 | The "test" script is `tsc --noEmit`, identical to lint; it asserts nothing new. | Acceptable placeholder; replace with real tests or drop the script when the pipeline needs it. |
| Low | migrations/0001_init.sql:253-263 | `client_ops` grows forever; replay dedupe history has no retention policy. | Prune processed ops older than the maximum offline window (for example 30 days) in a scheduled job. |
| Low | apps/web/src/components/TabBar.tsx:11 | Active nav links use only a class; screen readers get no current-page indication. | Add `aria-current="page"` on the active link. |
| Low | crates/db/src/lib.rs:39-41 | `run_migrations` is documented safe on every startup, but concurrent multi-instance startup can race in sqlx's migration lock; fine for a single Railway instance. | Note the single-instance assumption in the doc comment. |

### Checks

| Check | Verdict | Notes |
|-------|---------|-------|
| Brzycki formula: SQL generated column vs Rust vs docs | PASS | `w / (1.0278 - 0.0278*r)` identical in migrations/0001_init.sql:160-165 and crates/scoring/src/brzycki.rs:19-29; reps <= 1 branch equals the formula at r=1 exactly under numeric arithmetic. |
| Reps bounds and division guards | PASS (note) | CHECK (reps BETWEEN 1 AND 36) keeps the denominator >= 0.0270; Rust adds a defensive non-positive-denominator fallback the SQL lacks, but out-of-range reps cannot exist. |
| Schema constraints vs crates/db models | FAIL | Field names and shapes match, but NUMERIC-to-f64 decoding is unsupported (High above) and BodyStats is not exported. |
| Claimed invariants (kg/cm, Monday weeks, Brzycki only, client UUID PKs) | PASS | Verified in schema, models, volume.rs:21-24, week.ts:34-39, and seed; Epley survives only in docs history and legacy/. |
| Migrations correctness and discipline | PASS WITH ISSUES | 17 tables matches the CI assertion; seed is idempotent (ON CONFLICT on the partial unique index, 118 rows >= the CI floor of 50); append-only so far. Index and FK issues above. |
| Sync contract internal consistency | FAIL | LWW, tombstone, and idempotency pieces are individually sound but the pull cursor semantics and the kudos unique constraint are not implementable safely as written. |
| Frontend route tree vs product surfaces | PASS WITH ISSUES | Covers dashboard, workout, history, activities (cycling, climbing), body, social (leaderboard, heatmap, feed), profile, login; missing Exercises (and later routines, challenges). |
| Design tokens vs hardcoded values | PASS | Hex values only in tokens.css; manifest and index.html hardcode theme color, which is expected for static config. |
| Accessibility basics | PASS | Skip link (Shell.tsx:11), :focus-visible (base.css:54), prefers-reduced-motion (base.css:138-146), semantic header/nav/main/section/ol, aria labels, keyboard-scrollable heatmap. |
| PWA config | PASS | vite.config.ts manifest is coherent (separate maskable icon, id/scope/start_url, workbox precache plus font caching); registerSW({ immediate: true }) with autoUpdate. |
| CI gates and passability | PASS | fmt, clippy -D warnings, cargo test, ts-rs drift (git diff plus untracked check), pnpm frozen lockfile lint/test/build, and migrations against ephemeral Postgres are wired correctly; TS_RS_EXPORT_DIR resolves via .cargo/config.toml as ts-rs documents. Build artifacts on disk indicate the pipelines ran clean locally. |
| Conventions (em dashes, Rust style) | PASS | No em dashes or stray double hyphens in new prose (legacy/ excepted); 4-space K&R, snake_case/PascalCase/SCREAMING_SNAKE consistent. |
| Docs consistency (architecture, decisions, AGENTS) | PASS WITH ISSUES | Code faithfully implements the ADRs (Brzycki, EP caps, V-points, shared ranks copy); README drift and the Body height copy mismatch above. |

### Recurring patterns for other agents

- Numeric columns are mapped to Rust f64 everywhere; resolve the sqlx type mapping once (0003 migration or model attributes) before Phase 1 writes any query.
- Anything the sync layer reads by `updated_at` must include tombstones and a user scope; do not reuse the partial live-row indexes for pull queries.
- Client-supplied timestamps need a trust boundary (clamping or server clocks) before they drive cursors or LWW.
- UI copy is currently the de facto spec in several places (Body height, session survival); treat copy changes as schema-affecting decisions.

## 2026-10-14 - Security Review - Phase 0

Verdict: PASS WITH ISSUES

Scope: apps/api (main.rs, config.rs, state.rs, routes/*), crates/{db,scoring,analytics,sync},
migrations/0001 and 0002, apps/web session/login placeholders and PWA config,
.github/workflows/ci.yml, infra/, .env.example, root configs. Design-level review of the auth and
privacy model in docs/architecture.md and docs/decisions.md against commit d433fbc. Handlers are
stubs, so findings target the DESIGN and the foundation. No code was modified.

### Findings

| Severity | File:Line | Issue | Fix |
|----------|-----------|-------|-----|
| High | docs/architecture.md:96-97,120-121 | The auth model places a SameSite=Lax session cookie across two registrable domains (Cloudflare Pages SPA, Railway API). Cross-site fetch calls never carry a Lax cookie, and Safari (including iOS home-screen PWAs) blocks cross-site cookies even at SameSite=None. As specified the auth cannot work on iOS, and the tempting fix (SameSite=None + CORS credentials) widens the CSRF surface without fixing iOS. | Put app and API under one eTLD+1 via a custom domain (app.example.com + api.example.com), keep the cookie Secure, HttpOnly, SameSite=Lax, Path=/, add the __Host- prefix, and keep the X-Requested-With check and exact-origin CORS as defense in depth. Record the decision in an ADR before Phase 1 auth lands. |
| Medium | crates/db/src/models.rs:32-63 | Session, OtpCode, and Invite derive Serialize while holding token_hash / code_hash. Any handler that serializes these rows directly leaks hashes. For invites this is worse than leakage: sha256 of a short invite code is offline-crackable, and a cracked code forges access to the invite-only system. | Add #[serde(skip_serializing)] to every hash field (or dedicated response DTOs), and either hash invite codes with Argon2id like OTP codes or make invite codes 128+ bits of CSPRNG output where sha256 is acceptable. |
| Medium | migrations/0001_init.sql:34-57; docs/architecture.md:97 | Auth schema gaps versus the stated model: (1) no rate-limit state anywhere although OTP flow promises rate limiting; (2) otp_codes allows unlimited live codes per email and no DB-enforced attempt cap (attempts must be incremented atomically via UPDATE ... RETURNING or concurrent verifies defeat the 10^6 search space); (3) invites single-use is unenforced (used_by IS NULL must be checked in the UPDATE WHERE clause inside a transaction), expires_at is nullable (immortal invites), and the email column is optional and unbound to the account it creates; (4) GitHub OAuth state and PKCE storage is undesigned. | One live OTP per email (partial unique index or supersede semantics), CHECK (attempts <= 5), atomic attempt increments, NOT NULL invite expires_at, atomic single-use redemption, enforce invite.email (case-insensitive) on the created account when set, store rate-limit counters (per email and per IP) or an equivalent limiter, and carry OAuth state in a short-lived signed cookie. |
| Medium | crates/sync/src/lib.rs:7-9; migrations/0001_init.sql:253-263 | Sync idempotency as specced is exploitable in two ways: a replayed foreign op_id is a silent no-op success, so anyone who learns a victim op_id can pre-claim it and suppress the victim op (first writer wins); and nothing states that apply must force row user_id from the session, so a payload-supplied user_id could write rows into another account (workout poisoning, body_stats injection). Also the row upsert and client_ops insert must commit atomically. | Return 409 when an op_id exists for a different user_id, overwrite or reject any user_id in payloads (session user wins), apply each op and its client_ops row in one transaction, and cap ops per push batch. |
| Medium | docs/architecture.md:105; legacy/ | POST /import/liftlog accepts arbitrary JSON with no specified defenses: no body size cap, no schema or range validation, and "idempotent per legacy id" is a global key, so one account's import can suppress another's if the same legacy backup is imported twice. | Set an explicit axum body limit for the import route (streaming cap above the JSON CRUD default), strict DTOs with range checks (weights, reps, dates), per-user namespacing of legacy ids (user_id, legacy_id), per-user rate limits, and one transactional all-or-nothing import. |
| Medium | .github/workflows/ci.yml:1-97 | No supply-chain vulnerability gates: cargo audit / cargo deny and pnpm audit are not run anywhere. The planned backup workflow (docs/architecture.md:59) will hold live database credentials and does not exist yet, so its secrets handling is undecided. | Add a rustsec audit job (cargo deny check advisories or rustsec/audit-check) and a pnpm audit step (warn-only at first), add workflow-level permissions: contents: read, and define secrets handling for the backup workflow (GitHub Environments secrets, no echo, masked logs). |
| Medium | apps/api/src/config.rs:31-34; infra/railway.toml:7-13 | RUN_MIGRATIONS defaults to true, so every production boot runs DDL with the API's database role. A future SQLi or RCE then escalates to schema control, and the app role must hold migration rights it should not need. | Default to false in production, run migrations as an explicit release step (cargo run -p waveform-api migrate) under a separate role, and give the serving role DML-only grants. |
| Low | crates/db/src/models.rs:17-29 | User derives Serialize and TS with email and github_id. Social surfaces (feed, leaderboard) must not echo other users' email addresses. | Introduce a PublicUser DTO (id, display_name, avatar_url) for anything rendered to other users; keep the full row owner-only. |
| Low | .github/workflows/ci.yml:17-21,52-55; infra/docker-compose.yml:21 | GitHub Actions are tag-pinned (mutable) and axllent/mailpit:latest floats; a compromised tag or upstream image can execute in CI. | Pin actions to commit SHAs and pin Mailpit to a version tag. Dev-only impact, but CI runs on every PR. |
| Low | crates/db/src/lib.rs:29-35; apps/api/src/config.rs:25 | connect() never requires TLS; a DATABASE_URL without sslmode=require silently sends traffic plaintext if Postgres is reached off the Railway internal network. | Validate or document sslmode=require for every non-internal connection string. |
| Low | apps/web/index.html:16-20; apps/web/vite.config.ts:32-47 | No Content-Security-Policy or security headers for the PWA, and Google Fonts are loaded third-party (CSS injection surface plus privacy). | Add a _headers file for Cloudflare Pages (CSP with connect-src limited to the API origin, frame-ancestors none), and self-host the fonts. |
| Low | migrations/0001_init.sql:23-32 | sessions has no expires_at cleanup index and no explicit revocation or rotation semantics; token entropy and constant-time verify rules are undocumented. | Index (expires_at) for the cleanup job, specify logout = row delete and rotation on login and OAuth link, require >= 128-bit CSPRNG session tokens, and require argon2::verify (constant time) for OTP checks. |
| Info | crates/db/tests/schema.rs:74-100 | SQL built with format! for CREATE / DROP DATABASE; names are internally generated UUIDs so there is no injection path. Keep this pattern out of application code. | None; acceptable in tests only. |
| Info | apps/api/src/routes/mod.rs:35-49 | healthz returns a generic body and logs DB errors server-side only. Good pattern, keep it as handlers land. | None. |

### Check Results

| Check | Verdict | Notes |
|-------|---------|-------|
| 1. Auth model as specified (schema design) | FAIL | Hashing and TTL bones are right (Argon2id OTP, sha256 session token, consumed_at, expires_at) but rate-limit state, atomic attempt caps, atomic single-use invites, invite email binding, and OAuth state are missing or unenforced. See Medium rows 3. |
| 2. Session/cookie security and CSRF model | FAIL | Cross-site SameSite=Lax cannot work as specified (High row 1). Assessment of fixes: custom domain + SameSite=Lax is the only option that is both secure and works on iOS. SameSite=None + CORS credentials works only in non-Safari browsers, keeps the whole CSRF surface open permanently, and any CORS misconfiguration (wildcard with credentials, reflected Origin) becomes full account takeover. The X-Requested-With custom-header CSRF model is sound as one layer (HTML forms cannot set it; cross-origin JS setting it forces a preflight that a strict allowlist rejects) but must not be the sole control: pair it with Origin / Sec-Fetch-Site validation on state-changing requests and forbid state-changing GETs. |
| 3. SQL injection / query safety | PASS | Application SQL is static and parameterized (routes/mod.rs:36 uses a literal, migrations are static files); no raw string SQL with external input anywhere. Mandate query! or .bind() and identifier whitelisting for future dynamic ORDER BY / LIMIT. |
| 4. Sensitive-data exposure | FAIL | Hash-bearing models derive Serialize (Medium row 2); User exports email (Low row 8). body_stats authorization is not enforced anywhere yet because no handler exists; Phase 1 must enforce owner-only in every repository query (WHERE user_id = session user), never emit body_stats in feed, leaderboard, heatmap, or cross-user sync pull, and grant no admin bypass even if an admin role appears later (schema has none today). Cross-tenant negative tests are promised in docs/architecture.md:98-99 and must land with the first body_stats handler. |
| 5. Secrets / config | PASS | No hardcoded secrets or keys; .env is gitignored; .env.example holds dev-only defaults; CI uses ephemeral service credentials; railway.toml holds no secrets. Residual Low notes on TLS and workflow permissions above. |
| 6. Input validation and limits (import, sync push) | FAIL | Not yet specified in the design; the idempotency contract as written has the foreign op_id suppression flaw and no payload user_id rule (Medium rows 4-5). axum 0.8 defaults to a 2 MB body limit, which is implicit rather than deliberate. |
| 7. Dependency / supply-chain posture | FAIL | No cargo audit, cargo deny, or pnpm audit in CI (Medium row 6); tag-pinned actions and floating mailpit tag (Low row 9). Mitigating: Cargo.lock and pnpm-lock.yaml are committed, pnpm install uses --frozen-lockfile, and the toolchain file and pnpm version are pinned. |
| 8. MIGRATOR / run_migrations gating | PASS | The migrate path is CLI and env gated and is not exposed over HTTP (no route serves it); the embedded Migrator is checksum-tracked at compile time. Residual Low: RUN_MIGRATIONS defaults on in production and the serving role is implicitly DDL-capable (Medium row 7 covers hardening). |

### Verification Checklist

- [x] No Critical findings
- [ ] No High findings (1: cross-site cookie design)
- [x] All Medium findings have mitigations (6 rows, each with a concrete fix)
- [x] Low findings documented (5 rows)
- [x] Phase security integrates with prior phases (findings mapped onto the foundation review above; items 17, 18, 26, 30 from that review re-confirmed from a security angle)

### Recurring patterns for other agents

- The auth design decisions (domain layout, cookie flags, invite code hashing) must be locked in an ADR before any Phase 1 auth handler is written; every finding in rows 1 to 3 is cheaper to fix now than after handlers exist.
- Serialization of database rows straight into responses is the standing leak risk: hash fields and PII need skip attributes or DTOs before the first handler lands (rows 2 and 8).
- Any client-supplied identifier (op_id, legacy import id, user_id in payloads) needs an ownership rule before it is trusted (rows 4 and 5).

## 2026-10-14 - Phase 0: Waveform rebrand + GitHub Pages deploy (code review)

Verdict: FAIL (one Medium; a one-line revert flips this to PASS)

Scope: uncommitted change set on branch `rebrand/waveform` (46 modified files, 2 untracked):
full LiftLog to Waveform rename across Rust crates, npm packages, infra, CI, and docs; new
env-driven Vite `base` with relative PWA manifest values; router base wiring; `.github/workflows/pages.yml`
GitHub Pages deployment with `404.html` SPA fallback; two new ADRs. `legacy/` confirmed untouched.
Verification basis: static review of every changed file plus full command runs
(`cargo build/clippy/fmt/test`, `cargo test export_ts` drift check, `pnpm install/build/lint/test`,
and a dedicated `VITE_BASE_PATH=/waveform/` production build inspected at the URL level). 9 of 9
commands exit 0; see docs/tests.md for the standing test record.

### Findings

| Severity | File:Line | Issue | Fix |
|----------|-----------|-------|-----|
| Medium | migrations/0001_init.sql:1 | The rebrand edits an applied migration (comment `/* LiftLog initial schema.` to `/* Waveform initial schema.`). sqlx checksums migration files, so any database that applied the pre-rebrand file hard-fails `run_migrations` and `sqlx migrate verify` with "previously applied but has been modified". This also violates AGENTS.md:38 ("migrations are append-only... never edit an applied one"). Practical exposure is limited today (compose volume rename forces fresh dev DBs, CI is ephemeral, no managed DB yet) but the trap is live for branch switches, non-compose Postgres, and future restores of old dumps. | Revert line 1 to its pre-rebrand text (historical attribution is defensible in a migration header). Branding is not worth checksum churn. If the edit is kept instead, document the mandatory DB reset in the rename ADR. |
| Low | heart-fitness.svg:1 | Untracked SVG Repo source asset (heart with ECG polyline) at the repo root, referenced nowhere in the tree; likely raw material for the favicon. | Delete before merge, or move to a design assets location and reference it (for example as an input to apps/web/scripts/generate-icons.mjs). |
| Low | AGENTS.md:74 | "docs/reviews.md and docs/tests.md will appear in later phases" is stale; both docs exist and are actively maintained. | Point Deep Docs at them as live documents. |
| Low | docs/tests.md:22-50 | Suite counts are stale versus the current tree: the doc claims 66 Rust and 15 JS tests (scoring 16, sync unit 4, outbox_contract 9, week 5, nav 4); the current suite runs 78 Rust and 19 JS (scoring 17, sync unit 8, outbox_contract 13, week 7, nav 7). Not introduced by this change set (its diff here is rename-only) but this file is the test record. | Refresh counts at the next test pass or append a dated addendum. |
| Low | .github/workflows/pages.yml:13-15 | `concurrency: group: pages` uses `cancel-in-progress: true`, which can abort an in-flight Pages deployment when a new push lands; GitHub's own Pages template uses `false` for deploy groups. | Set `cancel-in-progress: false`. |
| Low | README.md:38 | The layout comment "`.github/workflows/` CI: rust, ts-rs drift, JS workspace, migrations" omits the new Pages workflow. | Mention `pages` in the comment. |

### Check Results

| Check | Verdict | Notes |
|-------|---------|-------|
| Rebrand completeness (code, config, infra, CI) | PASS | Case-insensitive sweep finds `liftlog`-family tokens only in `legacy/` (out of scope) and sanctioned doc history: docs/decisions.md:66,122-128,159-166 (ADR context and superseded fork ADR), docs/architecture.md:107 (`POST /import/liftlog`), docs/reviews.md:88 (quoted prior finding). Nothing in apps/, crates/, migrations/, infra/, workflows, or lockfiles; the built bundle contains zero old-branding matches. |
| legacy/ untouched | PASS | No legacy/ file appears in `git status`; historical references deliberately preserved as required. |
| Rust crate rename consistency | PASS | Workspace members and path deps are `waveform-*` (Cargo.toml:11-14), binary `waveform-api` (apps/api/Cargo.toml:2,9), `use waveform_db::` paths and the EnvFilter target `waveform_api=info` (apps/api/src/main.rs:23,28,36,58) all agree; Cargo.lock regenerated cleanly. Non-rename delta in crates/ is rustfmt reflow of nine `run_migrations(...)` call sites only. |
| Rust conventions (fmt, clippy, style) | PASS | `cargo fmt --check` clean; `cargo clippy --workspace --all-targets -- -D warnings` clean; 4-space K&R, snake_case/PascalCase/SCREAMING_SNAKE hold in all touched files. |
| JS/TS package rename | PASS | `waveform`, `@waveform/web`, `@waveform/api-types` (package.json:2, apps/web/package.json:2,16, packages/api-types/package.json:2); import renamed at apps/web/src/types/api.ts:17; pnpm-lock.yaml coherent, frozen-lockfile install succeeds. |
| TS conventions (strict, no `any`) | PASS | No `any` anywhere in apps/ or packages/ (matches are prose and manifest strings); tsconfig gains `"node"` types (apps/web/tsconfig.json:4) paired with `@types/node` (apps/web/package.json:21), needed by `process.env` in vite.config.ts:8. |
| Prose conventions (no em dashes or double hyphens) | PASS | All markdown clean; remaining `--` are command flags and table separators; en/em dash matches occur only in legacy/ (out of scope). |
| Migration immutability (append-only discipline) | FAIL | migrations/0001_init.sql:1 comment edit changes the sqlx checksum of an applied migration. See Medium finding. Everything else about migrations is intact: 0002/0003 unchanged, 17-table CI assertion and seed floor still hold. |
| Vite base and PWA scope | PASS | Env-driven base (vite.config.ts:8) verified with a real `VITE_BASE_PATH=/waveform/` build: dist/index.html rebases every local URL under `/waveform/` (including the root-absolute icon links at source index.html:11-12), manifest `id`/`start_url`/`scope` stay relative (vite.config.ts:21-23) and resolve under `/waveform/`, and the worker registers at `/waveform/sw.js` with scope `/waveform/` while sw.js keeps relative precache URLs, so `createHandlerBoundToURL("index.html")` resolves to `/waveform/index.html`. |
| Router base handling | PASS | apps/web/src/App.tsx:22,26 strips BASE_URL trailing slashes; routerBase "" is the documented no-base behavior and is confirmed safe by @solidjs/router's `options.base \|\| ""` (node_modules routing.js:368), while "/waveform" avoids double-slash joins. |
| 404 SPA fallback | PASS | pages.yml:34-35 copies dist/index.html to dist/404.html; reproduced exactly, output is byte-identical with all asset URLs under `/waveform/`, so deep links to /waveform/<route> load the app and the router resolves them. |
| Pages workflow logic | PASS (note) | Ordering (checkout, pnpm setup before node setup with `cache: pnpm`, frozen-lockfile install, build with VITE_BASE_PATH, 404 copy, configure-pages, upload-pages-artifact, deploy job with github-pages environment and `page_url`) is sound; artifact path apps/web/dist matches the Vite outDir; permissions (contents: read, pages: write, id-token: write) are the correct minimal set; `pnpm/action-setup@v4` resolves pnpm@10.14.0 from packageManager (package.json:6). Note: concurrency `cancel-in-progress: true` (Low finding). |
| CI workflow correctness | PASS | ci.yml: minimal `contents: read`; ts-rs drift removes generated.ts first and fails on tracked or untracked drift (ci.yml:53-64); frozen lockfile (ci.yml:77); migrations job service creds, health check, and DATABASE_URL all consistent with the waveform rename (ci.yml:93-105) and it runs `cargo test -p waveform-db` against real Postgres, covering the schema suites that skip locally without WAVEFORM_TEST_DATABASE_URL. |
| Generated types drift | PASS | `cargo test export_ts` regenerates byte-identical output; packages/api-types/src/generated.ts stays clean and is not in the change set. |
| Doc accuracy versus reality | FAIL | The rename itself is accurate everywhere checked (README quick start vs .env.example RUN_MIGRATIONS nuance, architecture Deployment section, ADRs, railway.toml comment all match reality; the two new ADRs at docs/decisions.md:157-191 correctly record the rename and hosting pivot, and the fork ADR is properly marked superseded at line 122). Stale bits: AGENTS.md:74 and docs/tests.md counts (Low findings). |
| Change hygiene (stray files) | FAIL | Untracked heart-fitness.svg at the repo root (Low finding); pages.yml is the only intended new file. |
| Build and test verification | PASS | 9/9 exit 0: cargo build, clippy `-D warnings`, fmt --check, test (78/78), export_ts drift check, pnpm install/build/lint/test (19/19 JS). Caveats: db schema tests skip without WAVEFORM_TEST_DATABASE_URL (covered in the CI migrations job); local pnpm lint/test replayed turbo cache from a clean run of the current tree. |

### Verification Checklist

- [x] All checks passed (3 FAIL items: migration immutability, doc accuracy, change hygiene)
- [x] No critical issues found (no Critical or High; one Medium)
- [ ] Code follows project conventions (one violation: migrations/0001_init.sql edited despite the append-only rule)
- [x] No em dashes, double hyphens, or dash equivalents; use proper punctuation
- [x] Phase code integrates cleanly with prior phases (the only integration hazard is the migration checksum noted above)

### Recurring patterns for other agents

- Never edit an applied migration file, even a comment: sqlx checksums file contents and the edit breaks `migrate verify` and `run_migrations` on every database that applied the old bytes. Rebranding stops at the migration boundary.
- Deployment-sensitive config must be exercised in its deployment shape: the default-base build passing does not prove the `/waveform/` build works. Build once with `VITE_BASE_PATH=/waveform/` and inspect dist/index.html, manifest.webmanifest, and the sw registration URLs before merging Pages changes.
- Rename sweeps should end with a leftover-identifier grep (case-insensitive, whole tree) and a stray-file check (`git status` untracked entries); both caught items in this review that the diff itself did not flag.

## 2026-10-14 - Phase 0: Waveform rebrand + GitHub Pages deploy (re-review)

Verdict: PASS

Scope: fix verification for the 2026-10-14 rebrand review above. The four applied fixes were
checked one by one and the full command suite was re-run to confirm the change set has no
regressions after the edits.

### Fix verification

| Fix | Verdict | Details |
|-----|---------|---------|
| Medium: migrations/0001_init.sql:1 reverted to `/* LiftLog initial schema.` | PASS | `git diff -- migrations/0001_init.sql` is empty and `git status --porcelain -- migrations/` is empty; the applied migration is byte-identical to HEAD and no other migration file was edited. |
| Low: pages.yml concurrency | PASS | .github/workflows/pages.yml:13-15 is now `group: pages` with `cancel-in-progress: false`, matching GitHub's own Pages template. |
| Low: README.md repository layout | PASS | README.md:38 now reads "CI: rust, ts-rs drift, JS workspace, migrations; Pages deploy", covering the new workflow. |
| Low: AGENTS.md Deep Docs | PASS | AGENTS.md:74-75 link Reviews and Tests as live docs; the "will appear in later phases" wording is gone; the file is 75 lines (under the 80-line budget). |

### Regression verification

9 of 9 commands exit 0: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
`cargo test --workspace` (78 passed, 0 failed), `cargo test export_ts` (generated.ts byte-identical,
no drift), `npx pnpm@10 install --frozen-lockfile`, `build`, `lint`, `test` (19 passed, 0 failed).
`git status` shows 45 modified and 2 untracked files; `migrations/` is absent from the change set
(46 became 45, exactly the reverted file), so the Medium fix introduced no collateral edits.

### Findings (carried over, non-blocking)

| Severity | File:Line | Issue | Fix |
|----------|-----------|-------|-----|
| Low | heart-fitness.svg:1 | Still open from the prior review: untracked SVG asset at the repo root, referenced nowhere in the tree. Not a merge blocker but it is change hygiene. | Delete before merge, or move to a design assets location and reference it (for example as an input to apps/web/scripts/generate-icons.mjs). |
| Low | docs/tests.md:22-50 | Still open from the prior review: suite counts read 66 Rust and 15 JS versus the current 78 and 19 (scoring 17, sync unit 8, outbox_contract 13, week 7, nav 7). | Refresh counts at the next test pass or append a dated addendum. |

### Verification Checklist

- [x] All blocking checks passed (the Medium is resolved; two prior Low findings remain open and non-blocking)
- [x] No critical issues found
- [x] Code follows project conventions (migration immutability restored; the append-only rule at AGENTS.md:38 now holds)
- [x] No em dashes, double hyphens, or dash equivalents; use proper punctuation
- [x] Phase code integrates cleanly with prior phases (the migration checksum trap is gone; 9 of 9 commands green)

## 2026-10-14 - Phase 0: Waveform rebrand + GitHub Pages deploy (security review)

Verdict: PASS

Scope: uncommitted change set on branch `rebrand/waveform`. Security review of the LiftLog to
Waveform rename across Rust crates, npm packages, Postgres db/user/volume, env vars, CI, and docs,
plus the new `.github/workflows/pages.yml` GitHub Pages deploy and the two app-code deltas
(router `base` at apps/web/src/App.tsx:22-26 and env-driven Vite `base` with relative PWA manifest
values at apps/web/vite.config.ts:7-33). Focus: secret leakage in committed files, Actions
permission scope and triggers, injection and path traversal via the base handling, Pages artifact
exposure, the `@types/node` dependency addition, and action supply-chain pinning. Static review;
no code was modified.

### Findings

| Severity | File:Line | Issue | Fix |
|----------|-----------|-------|-----|
| Low | .github/workflows/pages.yml:8-11,22-35 | Workflow-level permissions grant `pages: write` and `id-token: write` to the build job, which executes project code (pnpm install lifecycle scripts, vite build). Only the deploy job needs `id-token: write`; a compromised dependency install script would otherwise run with a token that can mint OIDC tokens and alter Pages settings. This is the shape of GitHub's own static-deploy template, so it is consistent, but per-job scoping is stricter. | Scope permissions per job: build gets `contents: read` (plus `pages: write` only while `enablement` stays), deploy gets `pages: write` and `id-token: write`. |
| Low | .github/workflows/pages.yml:36-38 | `actions/configure-pages@v5` with `enablement: true` lets CI silently mutate repository settings (enabling Pages) on first run. | Enable Pages once in repo settings and drop `enablement: true` so CI never changes repo configuration implicitly. |
| Low | apps/web/vite.config.ts:8 | `VITE_BASE_PATH` flows into Vite `base` unvalidated. Not user-controlled today (set only by CI at pages.yml:33 or the developer shell), but a `//host/` or `https://host/` value would rebase every asset, manifest, and service-worker URL to a third-party origin at build time. | Assert the value matches `^\/[A-Za-z0-9._-]*\/$` (or is `/`) before returning the config; reject anything else at build time. |
| Low | .github/workflows/pages.yml:22-39 (carried) | Actions are major-tag pinned, not SHA pinned; a moved tag can execute arbitrary code in CI. Carried unchanged from the 2026-10-14 Phase 0 security review (row 9); pages.yml is consistent with ci.yml, so the posture did not regress. | Pin all actions to commit SHAs in a dedicated hardening pass across both workflows. |
| Info | .github/workflows/pages.yml:33 | Hardcoded `VITE_BASE_PATH: /waveform/` assumes the repo keeps its name; a future rename silently breaks the deployed site. Availability, not security. | Optionally derive from `${{ github.event.repository.name }}`. |

### Check Results

| Check | Verdict | Details |
|-------|---------|---------|
| Secret leakage in committed files | PASS | Whole-tree sweep for key, token, secret, password, private-key, and common API-key patterns finds no real credentials. `.env.example` holds development defaults only: local compose credentials (`waveform:waveform` at .env.example:5, matching infra/docker-compose.yml:7-9), bind address and port, a documented dev-only `RUN_MIGRATIONS=true` opt-in (:15) beside the production-safe default (apps/api/src/config.rs:21,34), and a log filter. `.env` is gitignored (.gitignore:10); ci.yml:95 and ci.yml:105 use ephemeral service-container credentials. railway.toml holds no secrets. |
| GitHub Actions permission scope (pages.yml) | PASS (note) | `contents: read, pages: write, id-token: write` (pages.yml:8-11) is the minimal correct set for a Pages deploy; no `contents: write`, no package or deployment scopes. Note: the set is workflow-level, so the build job also holds `id-token: write` it never uses (Low row 1). |
| Workflow trigger and branch appropriateness | PASS | `push: branches: [main]` plus `workflow_dispatch` (pages.yml:3-6). No `pull_request` trigger, so fork or PR code never builds or deploys with `pages: write` or `id-token: write`; push-to-main matches the every-change-through-a-PR model in docs/decisions.md:128-130 where required CI gates merges. `concurrency: group: pages` with `cancel-in-progress: false` (:13-15) never aborts an in-flight deploy. |
| Injection via router base (App.tsx) | PASS | apps/web/src/App.tsx:22 derives `routerBase` from `import.meta.env.BASE_URL`, a compile-time constant statically replaced by Vite at build time, with a static regex stripping trailing slashes. No runtime user input, no dynamic regex, no HTML or URL construction from external data; the value feeds only the router `base` prop (:26). |
| Injection or traversal via Vite base and Pages steps | PASS (note) | vite.config.ts:8 reads `process.env.VITE_BASE_PATH` at build config time only; no user input reaches it. Every pages.yml step uses fixed literal paths (`apps/web/dist`, `index.html`, `404.html` at :33-41); no input interpolation into paths or shell, so no traversal surface. Defensive validation of the base string recommended (Low row 3). Manifest `id`/`start_url`/`scope` are relative `.` (vite.config.ts:21-23), resolving strictly against the manifest URL under the served base. |
| Pages deploy exposure (source or unintended files) | PASS | The artifact is `apps/web/dist` only (pages.yml:39-41), which is minified build output: no sourcemaps (no `sourceMappingURL` anywhere in dist), no env values beyond the public base path, no `.env`, no source. `dist/` is gitignored (.gitignore:3) so it is never committed; the 404 fallback copies only index.html within dist (:34-35). The repo is public anyway (project Pages site), so the source is already visible. |
| Dependency change (`@types/node`) | PASS | Dev-only, types-only (apps/web/package.json:21), integrity-pinned to `@types/node@22.20.5` in pnpm-lock.yaml; required by the `"types": ["node", ...]` entry (apps/web/tsconfig.json:4) for `process.env` in vite.config.ts. No runtime code, no install scripts, no new transitive runtime dependencies. |
| Actions supply-chain consistency | PASS (note) | pages.yml uses actions/checkout@v4, pnpm/action-setup@v4, actions/setup-node@v4, actions/configure-pages@v5, actions/upload-pages-artifact@v3, actions/deploy-pages@v4: all official `actions/*` (plus the pnpm-org action already used in ci.yml:71), major-version pinned exactly like ci.yml. pnpm itself resolves to the pinned `packageManager: pnpm@10.14.0` (package.json:6) and installs run `--frozen-lockfile` (pages.yml:29). Tag pinning rather than SHA pinning is the known carried Low (row 4); posture is unchanged, not regressed. |
| Existing security posture unchanged | PASS | `unsafe_code = "forbid"` remains workspace-wide (Cargo.toml:37-38) and every member inherits it via `[lints] workspace = true` (apps/api/Cargo.toml:24-25 and all four crates); zero `unsafe` or raw-pointer matches in Rust sources. TS stays `strict` with `noUncheckedIndexedAccess` (tsconfig.base.json:11-12); no `any`, `@ts-ignore`, or `@ts-expect-error` in apps/ or packages/ (sole grep hit is the prose word "anyone" at Leaderboard.tsx:61). clippy `-D warnings` gate (ci.yml:28) unchanged. |
| Migration immutability holds | PASS | migrations/0001_init.sql:1 remains `/* LiftLog initial schema.` after the earlier revert; historical `liftlog` tokens survive only in `legacy/` (out of scope) and sanctioned doc history. |

### Verification Checklist

- [x] No Critical findings
- [x] No High findings
- [x] All Medium findings have mitigations (none raised)
- [x] Low findings documented (4 rows plus 1 Info)
- [x] Phase security integrates with prior phases (Phase 0 security review findings re-checked: secrets/config PASS unchanged, action tag-pinning Low carried as row 4, RUN_MIGRATIONS production default confirmed safe at apps/api/src/config.rs:21,34)

### Recurring patterns for other agents

- Workflow-level `permissions:` blocks are the right default, but any job that executes project code (install or build) should hold the narrowest set; `id-token: write` belongs only on jobs that perform OIDC deployment.
- Build-time env plumbing (`VITE_BASE_PATH` style) is not a runtime attack surface, but it is an origin-rebasing surface: validate the shape of anything that ends up in Vite `base`, `publicPath`, or manifest URLs so a mistyped value cannot point the bundle at a third-party origin.
- Nothing in this change set blocks merge. Prior open non-blocking items (untracked heart-fitness.svg at the repo root, stale docs/tests.md counts) remain open from the code review.

## 2026-10-15 - Phase 1a: local data core (code review)

Verdict: PASS

Scope: `packages/scoring/**` (TS scoring port + shared golden fence), `crates/scoring/tests/golden.rs`, `apps/web/src/db/**` (Dexie persistence layer), and supporting config (`apps/web/{package.json,tsconfig.json,vitest.config.ts,vitest.setup.ts}`, `turbo.json`, `pnpm-lock.yaml`, `Cargo.lock`, `crates/scoring/Cargo.toml`). No UI or legacy files touched.

### Check Results

| Check | Verdict | Details |
|-------|---------|---------|
| 1. Transactional contract | PASS | Every mutating synced-row repo fn wraps row writes plus outbox appends in ONE `db.transaction("rw", ...)`: exercises.ts:65,75; workouts.ts:132,142,167,261,271,294,338,348,375; drafts.ts:72. Deletes are soft tombstones with a delete op carrying the full tombstoned row: exercises.ts:87-94, workouts.ts:180-203,301-315,380-383. drafts.save/discard (drafts.ts:46-49,150-152), profile.save (profile.ts:26-33), and ensureCatalog (ensureCatalog.ts:24-48) write no ops. The atomicity test (repos.test.ts:337-372) is genuine: commit writes session + entry + 2 sets + 4 ops before the invalid third set (reps 0) throws, and all four tables are asserted back to their pre-commit state with the draft intact. |
| 2. Outbox payload shapes | PASS | `SetEntryWrite` omits e1rm_kg (types.ts:22; toSetWrite workouts.ts:91-93); asserted at repos.test.ts:251,256 and drafts.test.ts:132-142. Op fields are exactly op_id/entity/action/payload/updated_at plus local created_at (types.ts:46-53; key-set assertion outbox.test.ts:39-46). Timestamps are ISO 8601 UTC via `toISOString()` (outbox.ts:24,30-31); row and op share one timestamp (deps.ts:16-20). user_id stamped from deps.userId (workouts.ts:120, drafts.ts:88; asserted repos.test.ts:84, drafts.test.ts:109). |
| 3. Scoring parity | PASS | Golden JSON is the single source; golden.test.ts and golden.rs (include_str at golden.rs:15) both consume it and both pass. Guards/clamps/caps match the Rust crate exactly (brzycki.ts:15-24 vs brzycki.rs:19-29; climbing.ts:13-16 vs climbing.rs:16-18; effort.ts:72-106 vs effort.rs:74-106). Daily cap inclusive and unrounded, covered by vectors (scoring.golden.json:528-569) and effort.test.ts:158-167. Vectors are meaningful: 45 e1rm rows cover all 36 schema rep counts plus guard rows (reps 0/37/40 fall back to raw weight), 19 vPoints rows cover the full 0..16 scale plus clamp rows (-3, 10000), effort rows cover every bonus cap boundary. Tolerance 1e-6 against 6-decimal expectations (max rounding error 5e-7) is sane. |
| 4. Catalog parity test | PASS | catalogParity.test.ts:22-34 parses migrations/0002_seed_catalog.sql with a tuple regex; drift fails loudly (length mismatch or first-mismatch diff, :41-63). Exact file order enforced index-by-index (:118-121) and duplicated as a sorted signature check (:123-132). One INSERT with expected columns and the lower(name) conflict clause asserted (:88-94). Seed list faithful: 118 rows in both sources; spot checks (first 18 rows, Ab Wheel, Thruster, last row Foam Rolling) match exactly; the v1 legacy names from legacy/app.js:8-12 occupy seed rows 1-45 in the same order (catalog.ts:18-62). |
| 5. Validation vs SQL CHECKs | PASS | reps integer 1..36 and weight 0..1500 (validation.ts:45-61 vs 0001_init.sql:157 and 0003_hardening.sql:210-211), duration_min null or 0..1440 (validation.ts:75-88 vs 0003_hardening.sql:224-225), set_index/order_index integer >= 0 (validation.ts:55-57,64-72), local_date YYYY-MM-DD (validation.ts:8,77-79). Boundary tests at repos.test.ts:374-435. Grade bounds have no local CHECK to mirror in 1a (activities arrive in Phase 2); the only grade surface is the scoring clamp 0..16 matching activities_climb_grade_value_range (climbing.ts:6,14 vs 0003_hardening.sql:218-219). |
| 6. Types | PASS | LocalRow omits applied_at (types.ts:15); repos never write it. strict + noUncheckedIndexedAccess (tsconfig.base.json:11-12) with correct narrow handling (uuidV5.ts:57-58, catalogParity.test.ts:28-30). `import type` used throughout (verbatimModuleSyntax enforces it); no `any`. SetEntryWrite correctly derived from the generated SetEntry (generated.ts:136-148 has e1rm_kg + applied_at). |
| 7. Schema | PASS | Exactly eight stores at version 1 (schema.ts:31-40); schema.test.ts:31-46 asserts store list, primary keys, and secondary indexes exactly (exercises/owner_id, workout_sessions/local_date, exercise_entries/workout_id, set_entries/exercise_entry_id, outbox/created_at; drafts/profile/sync_meta primary-only). |
| 8. Conventions | PASS | Rust golden.rs: 4-space indent, K&R braces, snake_case. No em dashes or double hyphens in prose anywhere in the change set (only legitimate `--noEmit` flags in package.json scripts). Tests are substantive (monotonicity, linearity, cap boundaries, clamp edges) and co-located with sources. |
| 9. Regressions and cleanliness | PASS | git status shows only 7 config/lockfile modifications and the new db/scoring/golden files; nothing under apps/web/src/routes, components, styles, or legacy/. `pnpm install --frozen-lockfile` clean; lockfiles coherent (dexie 4.4.6, fake-indexeddb 6.2.5, scoring workspace link; Cargo.lock adds serde/serde_json dev-deps). `cargo test --workspace` 84/84, clippy `-D warnings` clean, `cargo fmt --check` clean, `cargo test export_ts` passes with zero generated.ts drift. `pnpm test --force` 100/100 (scoring 42, web 58), `pnpm build` and `pnpm lint` clean. |

### Findings (non-blocking)

| Severity | File:Line | Issue | Fix |
|----------|-----------|-------|-----|
| Low | apps/web/src/db/repos/profile.ts:26-33 | The "profile.save writes NO ops" contract from the sub-phase checklist has no test asserting `outbox.count() === 0` (drafts and ensureCatalog both have one). | Add a small profile repo test alongside drafts.test.ts. |
| Low | apps/web/src/db/repos/profile.ts:23,31 | `get()` reads `local_profile` keyed by `deps.userId` but `save()` stores the row under `profile.id` verbatim; a mismatched id makes the saved row unreachable through `get()`. | Force `id: deps.userId` in save, or validate `profile.id === deps.userId`. |
| Low | turbo.json:7 | Turbo warns "no output files found for task @waveform/scoring#build" because its build is `tsc --noEmit` while the shared outputs key is `dist/**`. Cosmetic cache warning. | Add a package-level turbo task override or accept the warning for the typecheck-only package. |
| Info | apps/web/src/db/types.ts:12-14 | LocalRow doc says "server row minus applied_at", but exercises has no applied_at column at all (0003_hardening.sql:84-118 adds it to nine tables, not exercises), so Omit is a no-op there. Harmless. | Optional doc tweak. |
| Info | apps/web/src/db/seed/catalogParity.test.ts:24 | The tuple regex assumes names contain no SQL-escaped quotes; such a row would be skipped and trip the length check, so drift still fails loudly rather than silently passing. | None required; noted for future seed edits. |

### Verification Checklist
- [x] All checks passed
- [x] No critical issues found
- [x] Code follows project conventions
- [x] No em dashes, double hyphens, or dash equivalents; use proper punctuation
- [x] Phase code integrates cleanly with prior phases (Phase 0 review items unaffected; generated.ts drift check clean)

### Recurring patterns for other agents

- The shared golden fence is the pattern to keep: one JSON vector file, consumed by both the Rust test and the TS test, with a version field and a single declared tolerance. Any future formula change must move both implementations and the vectors together or one side of the fence fails.
- The repo transactional contract (row writes and outbox appends in one `db.transaction("rw", ..., db.outbox)`, soft deletes with full-tombstone delete payloads, generated columns stripped from wire payloads via a `*Write` type) should be followed exactly by any new entity repo in later sub-phases.
- SQL-derived constants seeded into TS (catalog names, CHECK bounds) need a parsing parity test like catalogParity.test.ts, and the SQL file must land in turbo.json `globalDependencies` or the test cache will serve stale results.

## 2026-10-15 - Phase 1b: workout core (code review)

Verdict: PASS (execution gates NOT RUN)

Scope: uncommitted sub-phase 1b change set on branch `main`: new `apps/web/src/lib/{format,forms,
workoutLog,history,exerciseStats,draftAutosave,backup,catalog,setInput,sparkline,exerciseDetail,
errors}.ts` plus tests, `lib/appData.tsx`, routes `Setup`/`HistoryDetail`/`ExerciseHistory`,
components `ConfirmDialog`/`Sparkline` and `workout/{ActiveSession,SetLog,ExercisePicker}`, edited
`routes/{Workout,History,Exercises,Profile}.tsx`, `App.tsx`, `components/{Shell,EmptyState}.tsx`,
`styles/{shell,app}.css`, `vite.config.ts`, and the three 1a data-core additions
(`exercises.updateCustom`, `workouts.listAllTrees`, `validation.SET_RULES`). Deleted
`components/PreviewBanner.tsx`. Static review of every file in scope. IMPORTANT: this review
environment had no shell tool, so `git status`/`git diff`, `pnpm install/build/lint/test`, and the
cargo suite (`test`, `clippy -D warnings`, `fmt --check`, `test export_ts`) could NOT be executed;
the git-level cleanliness checks (legacy/ and Rust untouched, generated.ts drift) are equally
unverified and must be run before commit.

### Check Results

| Check | Verdict | Details |
|-------|---------|---------|
| 1. Data wiring (repos via `useAppData`, no `createDefaultRepos`, reducer-only draft mutations, autosave lifecycle, finish flow, `LocalValidationError`) | PASS | All screens read through `useAppData().repos()` (Workout.tsx:47, History.tsx:68, Exercises.tsx:48, Profile.tsx:17, HistoryDetail.tsx:39, ExerciseHistory.tsx:39, Setup.tsx:21) with `createLocalQuery` for reads; `createDefaultRepos` has zero call sites (db/index.ts:24). Draft edits flow only through `mutate` + workoutLog reducers (Workout.tsx:123-134; ActiveSession.tsx:87-104,130-132). Autosave debounces 400ms and flushes on pagehide, visibilitychange hidden, and cleanup (Workout.tsx:83-110). `finishSession` computes `computeDurationMin`, persists via `schedule()` + `flush()`, then atomic `drafts.commit` (drafts.ts:69-148); failure keeps the draft and surfaces `LocalValidationError.issues` in a role=alert region (Workout.tsx:149-171, 207-215; errors.ts:14-22). `discardSession` settles the autosave chain before delete (Workout.tsx:173-190). |
| 2. 1a additions correct and non-regressing | PASS | `updateCustom` is one `db.transaction("rw", db.exercises, db.outbox)` with catalog refusal for edit and delete (exercises.ts:81-134), asserted at repos.test.ts:109-202 (refusals write nothing, outbox count 0). `listAllTrees` filters all three tombstone layers and sorts local_date desc then id desc (workouts.ts:257-274; repos.test.ts:293-384). `SET_RULES` mirrors the SQL CHECKs and is shared by forms.ts and setInput.ts (validation.ts:15-20; repos.test.ts:526-591). 1a behavior intact; `LocalValidationError.issues` is additive. Low: guards compare `owner_id` to null but never to `deps.userId`. |
| 3. History grouping and exercise stats fence | PASS | Monday-start weeks and day headings verified (week.ts:35-50, format.ts:128-140, history.ts:90-137; history.test.ts:104-138 pins week starts, ISO week numbers 42/41, and heading order). Warmups and weight-0 sets excluded from best e1RM and volume everywhere via `isWorkingSet` (workoutLog.ts:33-41; history.ts:53-64; exerciseStats.ts:43-107); warmups remain visible only in tables. All e1RM values come from `@waveform/scoring` `e1rmBrzycki` or its stored copy, so the scoring fence is untouched. |
| 4. Export | PASS | `WaveformBackupV1` covers profile, exercises, workout_sessions, exercise_entries, set_entries with tombstones and a versioned envelope (backup.ts:16-45; backup.test.ts:92-118). `downloadBackup` is Blob plus object URL plus anchor click with revoke (backup.ts:62-73); zero network APIs exist anywhere in apps/web/src. Filename `waveform-backup-YYYY-MM-DD.json`, pretty JSON with trailing newline, both tested (backup.test.ts:121-144). |
| 5. Accessibility | PASS | Labels (for/id via createUniqueId, aria-labels on row inputs and forms), aria-invalid plus aria-describedby on invalid fields (SetLog.tsx:212-242; Setup.tsx:105-112), role=alert on every status region, ConfirmDialog with initial focus on Cancel, Escape, Tab trap, focus restore with document.contains guard, role=dialog and aria-modal (ConfirmDialog.tsx:59-111), sparkline role=img with generated spoken summary (Sparkline.tsx:55-60; sparkline.ts:84-119), sr-only table captions and warmup expansions. Native controls throughout, so keyboard reachability is complete. Info notes below. |
| 6. Conventions | PASS | strict + noUncheckedIndexedAccess + verbatimModuleSyntax (tsconfig.base.json:10-12); no `any`, `@ts-ignore`, or `@ts-expect-error`; `import type` throughout; for...of with zero forEach/for-in. Class vocabulary reused and every class exists in CSS. No new design tokens: hex only in tokens.css; app.css additions use var() except one hardcoded rgb backdrop (app.css:623) matching the pre-existing shell.css:33 pattern. No em dashes or double hyphens in prose; "Nothing is saved yet" copy fully removed (zero matches). |
| 7. 404 SPA fallback | PASS | `spaDeepLinkFallback` copies dist/index.html to dist/404.html in closeBundle (vite.config.ts:16-23), after vite-plugin-pwa generates the service worker (plugin order vite.config.ts:29-76), so 404.html is correctly outside the precache while navigateFallback covers offline. Deep links to /waveform/<route> resolve through the router base (App.tsx:25, verified in the rebrand review). Info: path assumes dist under the config dir, and pages.yml:34-35 duplicates the copy. |
| 8. Cleanliness and regressions | NOT RUN | Needs git and cargo (see scope note). Static evidence matches the stated scope: everything inspected is under apps/web plus docs; no new dependencies; generated.ts is consumed read-only; no Rust code touched by the new modules; scoring imported, never forked. |
| Command gates (pnpm install/build/lint/test; cargo test, clippy, fmt, export_ts) | NOT RUN | No shell in this review environment. Static proxy: web tests now enumerate 163 `it(...)` blocks (58 at the 1a baseline, +105 new); scoring tests untouched (42 expected); Rust out of the change set (prior 84/84). Static counts only, not executed results. |

### Findings (non-blocking)

| Severity | File:Line | Issue | Fix |
|----------|-----------|-------|-----|
| Low | apps/web/src/routes/HistoryDetail.tsx:67,85; apps/web/src/db/repos/workouts.ts:249-255 | `getTree` returns tombstoned sessions (only entries/sets are filtered), so a deep link to a deleted session renders an empty session view instead of the "Session not found" state the route promises at HistoryDetail.tsx:52-63. | Return undefined from `getTree` when `session.deleted_at !== null`, or skip the render in SessionView. |
| Low | apps/web/src/components/workout/SetLog.tsx:98-99,209-210 | Weight inputs carry `min`/`max` in kg (0..1500) while holding the display unit: a lb field claims a 1500 lb ceiling (about 680 kg) and understates the real bound. Parsing is correct (setInput.ts:31-38 converts first; novalidate prevents blocking) but the attributes misstate the constraint, and the max error copy reads "1500 kg or less" in lb mode (setInput.ts:36). | Convert the bounds with `toDisplayWeight` for the attributes, or drop min/max and rely on the parse layer. |
| Low | apps/web/src/db/repos/exercises.ts:89,117 | Catalog refusal checks `owner_id === null` only; a custom row owned by another `user_id` would pass `updateCustom` and `softDelete`. workouts mutations likewise never compare `session.user_id` to `deps.userId` (workouts.ts:162-232). Same ownership pattern flagged in the Phase 0 security review for sync ops. | Require `owner_id === deps.userId` / `user_id === deps.userId` in every mutation guard. |
| Info | apps/web/vite.config.ts:20 | Fallback copy hardcodes `dist` under the config dir while Vite resolves outDir from `root`; correct in-repo but fragile to a foreign cwd. pages.yml:34-35 duplicates the copy. | Derive from resolved root/outDir; keep one source of truth for the copy. |
| Info | apps/web/src/db/index.ts:24 | `createDefaultRepos` has zero call sites after the appData bootstrap replaced it. | Delete or document as a helper. |
| Info | apps/web/src/lib/forms.ts; apps/web/src/lib/exerciseStats.ts:81 | `createForm` family and `setsForExercise` are consumed only by tests; Setup.tsx:53-76 and Exercises.tsx ExerciseForm hand-roll the same lifecycle. | Wire screens to forms.ts later or note it as the upcoming form layer. |
| Info | apps/web/src/components/workout/ActiveSession.tsx:82; apps/web/src/routes/Exercises.tsx:163 | `panel-body` class has no CSS rule; `.panel` supplies the padding. | Style it or drop it. |
| Info | apps/web/src/components/ConfirmDialog.tsx:104-141 | Background content is not inert/aria-hidden while the modal is open; aria-modal is the only isolation. | Toggle aria-hidden on siblings or use native `dialog`.showModal(). |
| Info | apps/web/src/routes/HistoryDetail.tsx:115 | `summarizeSession(props.tree, new Map())` passes an empty name map; the computed names are discarded. | Pass the real map or add a names-free summary variant. |
| Info | apps/web/src/routes/Setup.tsx:53; apps/web/src/lib/today.ts:14,19 | Missing explicit return types where the rest of the new code annotates them. | Consistency pass. |

### Verification Checklist

- [x] All code checks passed (7 PASS, 1 NOT RUN)
- [ ] Command gates re-run (impossible in this review environment; must run before commit)
- [x] No critical issues found (no Critical, High, or Medium)
- [x] Code follows project conventions
- [x] No em dashes, double hyphens, or dash equivalents; use proper punctuation
- [x] Phase code integrates cleanly with prior phases (1a additive; scoring fence untouched; zero new dependencies)

### Recurring patterns for other agents

- The draft pipeline is the template for future write paths: pure reducers (no clock, ids pre-generated at insert), a debounced serialized autosave flushing on pagehide/visibilitychange/cleanup, and one atomic commit where a `LocalValidationError` aborts the transaction and leaves the draft intact.
- Repo mutation guards must compare `owner_id`/`user_id` to `deps.userId`, not just to null; the null check protects catalog rows but not cross-user rows.
- UI constraints in display units must be converted at the same boundary that converts values back to storage units; validator bounds in kg cannot be pasted onto a lb input's min/max.
- View-model tests (Monday grouping, warmup exclusion, "no top e1RM without a load") are acting as the spec for the pure lib layer; keep them beside every new module.

## 2026-10-15 - Phase 1c: body, climbing, cycling, dashboard (code review)

Verdict: PASS (execution gates NOT RUN)

Scope: uncommitted sub-phase 1c change set on branch `main`, layered on the committed 1a data
core and 1b workout core: `apps/web/src/db/**` (schema v2 with `activities`/`body_stats`/
`climb_sends`, types widening, `ACTIVITY_RULES`/`BODY_RULES`, `repos/activities.ts`,
`repos/body.ts`, `workouts.listTreesByDateRange`, `repos/index.ts`, `db/index.ts`), new
`apps/web/src/lib/{climbing,bodyChart,weekStats,formInputs,activitySummary,bodyReadings}.ts`
plus edits to `lib/{activities,forms,backup}.ts`, new components
`activity/{GradePicker,ClimbForm,RideForm,ActivityCard}` and `body/{BodyForm,BodyChart}`,
rewritten routes `{Body,Climbing,Cycling,Activities,Dashboard}`, `styles/app.css` additions,
and tests. IMPORTANT: this review environment has no shell tool, so `git status`/`git diff`,
`npx pnpm@10 install --frozen-lockfile`, `pnpm build/lint/test`, and the cargo suite
(`cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`,
`cargo fmt --check`, `cargo test export_ts`) could NOT be executed. Every check below is
static analysis of the working tree; the git-level cleanliness checks (legacy/ and Rust
untouched, no generated.ts drift) and the command gates must be run before commit.

### Check Results

| Check | Verdict | Details |
|-------|---------|---------|
| 1. Schema v2 correctness | PASS | schema.ts:46-55 keeps the version(1) declaration (eight stores, exact key strings and order) matching the 1a-declared shape recorded in the 2026-10-15 Phase 1a review and the raw-v1 copy embedded in schema.test.ts:75-84; version(2) (schema.ts:56-68) appends exactly `activities: "id, local_date, type"`, `body_stats: "id, local_date"`, `climb_sends: "activity_id"` and repeats the v1 stores verbatim. The upgrade test (schema.test.ts:69-122) is genuine: a raw Dexie with only the v1 declaration seeds local_profile and workout_sessions rows, closes, reopens through WaveformDb, asserts both rows `toEqual` their originals, the eleven-store list, and that the three new stores exist and are empty. The companion test (schema.test.ts:38-53) pins every primary and secondary index against INDEXES. Byte-identity of version(1) versus the committed 1a file is confirmed by internal evidence only (the embedded test copy and the 1a review record agree exactly); `git diff` could not be run here. |
| 2. Activities repo contract and derivation | PASS | All three mutators wrap row writes plus outbox appends in ONE `db.transaction("rw", db.activities, db.climb_sends, db.outbox, ...)`: logActivity (activities.ts:173-180), update (:186-222), remove (:228-239). remove tombstones the row, queues one delete op carrying the full tombstone, and hard-deletes climb_sends in the same transaction; a repeat or missing id is a no-op returning no ops (:230-232). Derivation (toClimbFields, :82-90) produces `climb_grade: "V{n}"` of the hardest send, `climb_grade_value: n`, and `routes_sent` as the histogram total, all via lib/climbing helpers; the empty histogram yields null grades and routes_sent 0. The create payload is the LocalRow<Activity> exactly (no sends field, no applied_at), asserted key-set-exact at activities.test.ts:35-51,97-99. Cycling writes null climb fields and never touches climb_sends (:146,154-158; test :116-138). Timestamps shared across row, sends row, and op (:102-114 test). Validation runs before any write (:164, :208; test :334-346). |
| 3. Body repo upsert contract | PASS | upsertBodyStat (body.ts:69-120) runs in one rw transaction over body_stats and outbox; a live row for the date is patched in place with merge semantics (undefined keeps, null clears via mergeField :63-65) and one update op; no live row (never logged or only tombstoned) creates a fresh uuid with one create op, so exactly one live row per local_date holds. All contract points are tested: merge (:58-92), fresh id on tombstoned date with exactly one live row remaining (:94-113), remove tombstones with one delete op and second-remove no-op while a missing id throws (:115-132), listRange inclusive both bounds sorted ascending (:134-147), listAll date desc (:149-157), and CHECK-mirroring validation including strictly positive weight (:159-185). |
| 4. V-points fence | PASS | The only V-point math in apps/web is `vPointsForSends` (climbing.ts:85-87) delegating to `totalVPoints`/`MAX_V_GRADE` from `@waveform/scoring` (climbing.ts:13); activitySummary.ts:53 and activities.ts:104 consume that helper. No `2 **`, `Math.pow`, or hand-rolled point formula anywhere in apps/web/src. packages/scoring/climbing.ts and golden/scoring.golden.json are untouched by this change set (static read), so the golden fence stands. `climb_grade_value` clamps to 0..16 both in the histogram (17 slots, climbing.ts:17,30-39) and in ACTIVITY_RULES (validation.ts:31-32), matching activities_climb_grade_value_range (0003_hardening.sql:218-219). |
| 5. weekStats semantics | PASS | workingVolumeKg skips warmup sets and non-finite weights/reps (weekStats.ts:49-54); dead sets cannot enter because trees come from loadTree, which filters all three tombstone layers (workouts.ts:96-110) via listTreesByDateRange (:282-289). activeDays unions live session and activity local_dates against the week's day list and clamps 0..7 (:60-74). Tests pin warmup exclusion, non-finite skipping, same-day union counted once, and the clamp (weekStats.test.ts:84-139). Info note below on the "live" guarantee living in tree construction. |
| 6. UI wiring and accessibility | PASS | Every screen reads through `useAppData().repos()` with `createLocalQuery` (Dashboard.tsx:24,113-118; Body.tsx:29,59-60; Climbing.tsx:21,41; Cycling.tsx:22,42; Activities.tsx:29,61-68). All writes go through createForm, which marks touched and blocks submit until every field validates (forms.ts:340-356); ClimbForm additionally refuses a zero-send session before the repo call (ClimbForm.tsx:40-45) and BodyForm requires at least one figure (BodyForm.tsx:82-88). Both delete surfaces confirm via ConfirmDialog (ActivityCard.tsx:97-106; Body.tsx:233-246). BodyChart reuses buildSparkline geometry (BodyChart.tsx:52-63) with role="img" and the spoken bodyChartSummary as aria-label (:84-89, :69-75). Accessibility: stepper buttons carry aria-labels and aria-live footer (GradePicker.tsx:45,65,109), aria-invalid plus aria-describedby on every field error, sr-only table caption and action labels (Body.tsx:177-187), ConfirmDialog from 1b reused unchanged. |
| 7. Conventions | PASS | strict + noUncheckedIndexedAccess + verbatimModuleSyntax hold; zero `any`, `@ts-ignore`, `@ts-expect-error`, `eslint-disable`; `import type` throughout; loop style is for...of in lib/repo code with `.map` only in JSX/data transforms, consistent with the committed Heatmap.tsx pattern; zero forEach/for-in. New classes (grade-grid/grade-cell/grade-stepper/grade-step/grade-input, session-summary, row-actions, form-fieldset, form-details, discipline-window, spark-swatch) all land in app.css:653-767 using existing var() tokens; no new tokens, no hex outside tokens.css. No em dashes, en dashes, or spaced double hyphens in any ts/tsx/css/md file (repo-wide grep; CSS custom properties and command flags excluded). Backup bumps to a versioned v2 envelope with app.schema_version 2 and covers the new stores (backup.ts:24-58; backup.test.ts:151-183). |
| 8. Cleanliness (legacy/, Rust, export_ts) | NOT RUN | Requires git and cargo. Static evidence: every file inspected is under apps/web or docs; packages/api-types/src/generated.ts is consumed read-only; crates/db/src/models.rs:205-256 matches generated.ts:6-49 field for field including doc comments and applied_at placement, so the regenerated output should be byte-identical, but `cargo test export_ts` must confirm. The Activity/BodyStats generated types predate this change set, so no Rust edit was needed to support it. |

### Findings (non-blocking)

| Severity | File:Line | Issue | Fix |
|----------|-----------|-------|-----|
| Low | apps/web/src/components/activity/ClimbForm.tsx:71-74 vs RideForm.tsx:66-71 | Create-mode reset is inconsistent between the two log forms: RideForm clears every field after save, ClimbForm resets only date and sends. A second climb logged on the same form silently inherits the previous duration and notes. | Reset duration and notes in ClimbForm too, or document the carryover as intentional and mirror it in RideForm. |
| Low | apps/web/src/routes/Body.tsx (BodyForm.tsx:82-88) | The error copy "Enter at least a weight or a body fat percentage." undercounts the rule it guards: hasAnyFigure also accepts a circumference-only reading. | Reword to "Enter at least one measurement." |
| Low | apps/web/src/db/repos/activities.ts:183-223 | `update` can break the invariants `logActivity` guarantees: a patch can put non-null distance_km/elevation_m on a climbing row (assertValidActivity only checks finiteness, validation.ts:198-203), `patch.sends` on a cycling row is silently ignored (:201), and updates on tombstoned rows are accepted (remove correctly no-ops on them). The UI never exercises these paths, but the repo API allows them. | In `update`, reject or null distance/elevation for climbing rows, reject sends patches for non-climbing, and throw (or no-op) when `existing.deleted_at !== null`, matching the remove contract. |
| Low | apps/web/src/db/repos/workouts.ts:282-289 | `listTreesByDateRange` is a new public API used by the Dashboard but has no direct test (repos.test.ts covers listByDateRange and listAllTrees separately; the composition itself is unasserted). | Add one repo test pairing a range query with tree shape, beside the listAllTrees tests. |
| Info | apps/web/src/db/repos/activities.ts:143-155 | The discriminated union is narrowed with `input as ClimbLogInput` / `as RideLogInput` casts instead of `if (input.type === "climbing")` branches, which would remove both casts under strict TS. | Style only; prefer union narrowing. |
| Info | apps/web/src/routes/Activities.tsx:61 | The live-query binding is named `window`, shadowing the DOM global inside ActivitiesView. Harmless today (the global is unused there) but a trap for later edits. | Rename to `windowRows` or `windowActivity`. |
| Info | apps/web/src/lib/weekStats.ts:27-28,48-54 | The docstring says "non-warmup, live sets only" but the function itself only skips warmups and non-finite values; tombstoned-set exclusion happens upstream in loadTree. A hand-built tree would count dead sets. | Filter `set.deleted_at === null` in the loop too, or narrow the docstring to "trees from loadTree already exclude tombstones". |
| Info | apps/web/src/db/repos/activities.test.ts:348 | Test title "rejects a body-stat-like invalid local_date on a ride" reads like a copy-paste from the body suite. | Reword to "rejects a malformed local_date on a ride". |

### Verification Checklist

- [x] All code checks passed (7 PASS, 1 NOT RUN)
- [ ] Command gates re-run (impossible in this review environment; `npx pnpm@10 install --frozen-lockfile`, `pnpm build/lint/test`, `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`, `cargo test export_ts`, plus `git status`/`git diff` for legacy/ and Rust cleanliness, must run before commit)
- [x] No critical issues found (no Critical, High, or Medium)
- [x] Code follows project conventions
- [x] No em dashes, double hyphens, or dash equivalents; use proper punctuation
- [x] Phase code integrates cleanly with prior phases (1b patterns followed exactly: same transactional contract, same tombstone discipline, same forms layer, scoring fence untouched, generated.ts read-only)

### Recurring patterns for other agents

- New entity repos keep the 1a contract exactly as the 1b review prescribed: one rw transaction over the touched tables plus outbox, full-tombstone delete payloads, derived/generated columns kept out of wire payloads, and a key-set-exact payload assertion in the repo test. activities.ts and body.ts are now the second and third references; copy them.
- Derived summary columns (climb_grade, climb_grade_value, routes_sent) must be recomputed from the device-local source of truth (the climb_sends histogram) inside the same transaction that writes them, never patched independently, so a row can never disagree with its histogram.
- Client form validators mirror SQL CHECK bounds through shared rule constants (ACTIVITY_RULES, BODY_RULES, SET_RULES); keep new numeric inputs on `createOptionalNumberField` variants so the mirror cannot drift.
- Chart surfaces reuse the one geometry helper (buildSparkline) and always ship role="img" plus a spoken summary generated from the same numbers the chart plots; keep summary text and plotted data on shared helpers (bodyChartSummary, climbBreakdownSummary) so they cannot disagree.

## 2026-10-15 - Phase 1d: import, storage, settings (code review)

Verdict: FAIL (one Medium; a small row-shape guard in the parser flips this to PASS)

Scope: uncommitted sub-phase 1d change set on branch `main`: new `apps/web/src/lib/{backupImport,importConverters,storage,importSummary}.ts` plus tests, edits to `lib/{backup,setInput,appData}` (appData is .tsx), `db/outbox.ts` (buildOutboxOp lwwAt), `db/repos/workouts.ts` (getTree tombstone), `db/repos.test.ts`, new `components/{StorageBlocked,StorageAlert}.tsx`, edited `components/{Shell,ConfirmDialog,CommandBar}.tsx`, reworked `routes/Profile.tsx`, copy edits to `routes/{Workout,HistoryDetail,Dashboard,Leaderboard,Login,SocialLayout,Feed}.tsx`, `components/workout/SetLog.tsx` display-unit bounds, `styles/app.css`. IMPORTANT: this review environment has no shell tool (`git status`/`git diff`, `pnpm build/lint/test`, and the cargo suite including `cargo test export_ts` could NOT be executed). Every check below is static analysis of the working tree; git-level cleanliness (legacy/ and Rust untouched, generated.ts drift) and all command gates must run before commit. The same caveat applied to the 1b and 1c reviews.

### Check Results

| Check | Verdict | Details |
|-------|---------|---------|
| 1. Import parse: all-or-nothing and pure | FAIL | Format/version handling is exactly as specified: version 2 accepted (backupImport.ts:212-214), version 1 points at the legacy wizard (:206-209), numeric >= 3 says "newer Waveform" (:210-211), non-numeric/other versions rejected (:212-214); app block name and schema_version checked (:215-226); collections must be arrays (:236-254); ISO-timestamp checks on exported_at, created_at, updated_at, deleted_at (:117-140); every synced row goes through the repo guards assertValidWorkout/Entry/Set/Activity/BodyStat (:277-308) with a per-row issue label, and one bad row rejects the file (tests backupImport.test.ts:397-410). BUT the per-row loops trust array elements to be objects: `readRows` casts without an isRecord check (backupImport.ts:272-275), so a JSON-legal `[null]` element in any collection (say `exercises: [null]`) throws a TypeError at `String(row.id)` (:278, :282, :287, :292, :300, :305, :312) instead of returning `{ ok: false, issues }`, breaking the documented "parse is pure and returns issues, never throws" contract (:4-8, :354-357). The UI catch-all (Profile.tsx:383-384) turns it into the generic "The file could not be imported" and errorIssues (errors.ts:14-22) would leak the raw "Cannot read properties of null" message into the status region. Zero writes still hold (parse throws before any write), but the all-or-nothing issue-reporting contract does not. No test covers non-object rows. |
| 2. Merge semantics | PASS | Strict LWW on the ISO string: `row.updated_at <= local.updated_at` skips with no op (newer local wins and equal timestamps skip) at backupImport.ts:447-449 (mergeById), :468-470 (mergeSets), :491-493 (mergeClimbSends); newer incoming rows put and queue exactly one op (:450-452). Idempotence is real: the second identical import writes nothing and queues no ops (backupImport.test.ts:468-490). Local-only rows and the local profile survive a merge (:542-545 writes the backup profile only when no local profile exists; test :610-624). Set rows always recompute `e1rm_kg: e1rmBrzycki(raw.weight_kg, raw.reps)` from `@waveform/scoring` (:466, :599; scoring export at packages/scoring/src/brzycki.ts:15) and toSetWrite keeps e1rm_kg out of the payload (workouts.ts:91-93; test backupImport.test.ts:590-608). Op updated_at equals the ROW updated_at via the new lwwAt parameter (outbox.ts:21-37; backupImport.ts:452, :474-480) while created_at is import time (:28-35); asserted at backupImport.test.ts:462-463 (create), :523-524 (update), :730 (replace). |
| 3. Replace semantics | PASS | Refuses without confirmReplace true, throwing LocalValidationError before any write (backupImport.ts:650-655; test :649-667). One rw transaction spans the 8 data stores plus outbox and sync_meta (:556-569); workout_drafts is never touched (:574-583 wipe list; test :734 keeps the draft). Wipe then restore queues one op per restored synced row (:586-614; climb_sends correctly excluded as device-local, types.ts:51-55), clears outbox and sync_meta (:582-583), and restores the backup profile when present else the pre-wipe local profile (:573, :616-621; tests :669-751). |
| 4. Atomicity | PASS (design + tests; not executed) | Both modes run entirely inside one Dexie transaction (backupImport.ts:505-518, :556-569) with the injected-failure tests proving the contract: mid-merge quota rolls back every store and the outbox (:626-645), and a quota during replace restores every store count, the outbox, and sync_meta byte-identical from a full snapshot (:769-819). ensureCatalog self-heal runs after the transaction (:661), so a failed import never half-seeds. Gates must confirm under real Dexie/fake-indexeddb. |
| 5. Storage resilience | PASS | isQuotaExceeded matches the DOMException names, legacy code 22, and walks cause then inner chains with a cycle guard (storage.ts:34, :66-98; tests storage.test.ts:30-64). ensurePersistentStorage is one-shot per handle via a WeakMap of the in-flight promise (:160-191; test :79-89). wrapWrite attempts persist once per wrapper (the WeakMap dedupes across wrappers), rethrows the original error unchanged, and publishes exactly one StorageFailure per quota or unavailable failure and nothing otherwise (:219-238; tests :129-187). guardRepos recursively wraps every function-valued repo member (:240-265; test :189-214) and appData wires it at bootstrap and setup (appData.tsx:116, :145). Shell renders StorageBlocked on status error or a missing IndexedDB global (Shell.tsx:34, :62-64) and StorageAlert only on quota (:57-59). |
| 6. UI wiring | PASS | SettingsPanel saves through appData.saveSettings, which writes the profile row and setProfile(saved), so the reactive profile flips every consumer's display units without a reload (appData.tsx:168-184; Profile.tsx:112-135; consumers read `app.profile()?.settings.display_weight_unit`, e.g. HistoryDetail.tsx:34-35, Workout.tsx:58). The import UI drives parseImportFile then applyBackupImport and renders warnings, per-row issues, and the per-store summary (Profile.tsx:361-405, :498-541 with importSummary.ts:35-49). Replace is gated twice: ConfirmDialog's confirmPhrase "replace" unlocks Confirm (ConfirmDialog.tsx:58-59, :138-154, :166-173; Profile.tsx:543-554) and applyBackupImport re-enforces confirmReplace. SetLog weight inputs carry display-unit min/max from weightInputBounds (SetLog.tsx:100-101, :211-212; setInput.ts:27-32; tests setInput.test.ts:9-17). getTree returns undefined for tombstoned sessions (workouts.ts:255-260; repos.test.ts:370-385) and HistoryDetail renders "Session not found" on undefined (HistoryDetail.tsx:52-63, :85). |
| 7. Copy pass | PASS | `sync idle|syncs when|synced session` is empty across apps/web/src. Remaining future surfaces are honest about their state: CommandBar shows a "local only" chip (CommandBar.tsx:32), Login labels every action "Preview shell: ... switches on when the API is live" and says "The console works without an account" (Login.tsx:5-8, :35), Feed and SocialLayout say "arrive in Phase 3" (Feed.tsx:8-9, SocialLayout.tsx:17). No em dashes, en dashes, or spaced double hyphens in any ts/tsx prose (repo grep; CSS custom properties and SVG var() references excluded). |
| 8. Conventions and cleanliness | PASS (cleanliness NOT VERIFIED) | tsconfig.base.json:10-12 keeps strict, noUncheckedIndexedAccess, verbatimModuleSyntax. Zero `any`/`@ts-ignore`/`@ts-expect-error`/`eslint-disable`/`forEach`/for-in in apps/web/src (grep); `import type` throughout the new modules; for...of in all parse/merge/storage loops. Zero fetch/XHR/WebSocket/EventSource/sendBeacon in apps/web/src (grep). New CSS (storage-alert block app.css:557-590, dialog-phrase :706-714, plus stack-tight reuse) sits on existing var() tokens. legacy/ and Rust untouched and `cargo test export_ts` drift are NOT verifiable without git/cargo and must be confirmed before commit. |

### Findings

| Severity | File:Line | Issue | Fix |
|----------|-----------|-------|-----|
| Medium | apps/web/src/lib/backupImport.ts:272-275, :278 (and :282, :287, :292, :300, :305, :312) | The per-row loops assume every array element is an object. A JSON-legal `[null]` element in any collection makes `String(row.id)` throw a TypeError, so parseBackup/parseImportFile throw instead of returning `{ ok: false, issues }`, violating the pure all-or-nothing parse contract. The UI catch-all then shows the generic import failure (and errorIssues would surface the raw TypeError message). No test covers non-object rows. | Have `readRows` (or the loops) push `${label}: must be an object` for any element failing isRecord before touching its fields, and add a parse test with `exercises: [null]` and `climb_sends: [null]`. |
| Low | apps/web/src/lib/backupImport.ts:447, :468, :491 | LWW compares ISO strings lexicographically. Equal instants in different ISO shapes (for example `...T12:00:00Z` versus `...T12:00:00.000Z`) do not compare equal as strings (`Z` > `.`), so a second-precision backup row can win over an identical instant written by the app (which always uses toISOString with milliseconds). Local-only impact: one spurious write and one spurious op on a re-import of a mixed-format file. | Normalize timestamps before comparing (compare `Date.parse` values, or normalize both sides through `new Date(x).toISOString()` at parse time), or document the millisecond-ISO expectation in the parse contract. |
| Low | apps/web/src/lib/backupImport.ts:645-663 vs lib/storage.ts | applyBackupImport writes through raw Dexie tables, not the guardRepos-wrapped repos, so a quota failure during import never publishes a StorageFailure and StorageAlert will not appear; the user only sees Profile's issue list, where errorIssues reduces a DOMException to its raw browser message (errors.ts:18-19). | Publish a quota StorageFailure from the import failure path (or wrap the apply call), and map quota errors to the friendly copy in failureFor (storage.ts:206-212). |
| Low | apps/web/src/db/outbox.test.ts:33-57 | The new lwwAt parameter of buildOutboxOp has no direct unit test; it is covered only end-to-end by backupImport.test.ts:462-463, :523-524, :730. | Add one buildOutboxOp case passing lwwAt and asserting updated_at differs from created_at. |
| Low | apps/web/src/lib/importConverters.test.ts:59-71 vs :86 | The "Phase 2" dispatch test depends on running before the later test's registerLegacyConverter call, because the converter registry is module state. Vitest runs file tests sequentially so it holds today, but `-t` filtering or reordering flips the outcome. | Give registerLegacyConverter a matching unregister in afterEach (or run the stub registration in its own describe with beforeEach/afterEach cleanup). |
| Info | apps/web/src/lib/storage.ts:240-256 | guardValue copies every non-function member recursively. A Date/Map/Set inside a repo tree would be cloned into a plain object, and a cyclic tree would recurse forever. Today's repos are pure literal/function trees (db/repos/index.ts), so this is latent only. | Restrict wrapping to function members and pass non-plain objects (Date, Map, Set, RegExp) through by reference, or document the plain-tree assumption. |
| Info | apps/web/src/lib/backupImport.ts:521, :586-588 vs db/seed/ensureCatalog.ts | Import queues create/update/delete ops for catalog rows (owner_id null) while ensureCatalog deliberately writes no ops for server-owned rows (ensureCatalog.test.ts:14). The tests pin the current behavior as intended (backupImport.test.ts:452, :464-465), so this is a contract question for the phase 3 sync drain: a push of `create` for an existing server-owned catalog row must be acceptable server-side. | Confirm the server push contract for exercises with owner_id null in the sync phase; if unacceptable, skip ops for owner_id null rows during merge/restore. |

### Verification Checklist

- [x] All code checks passed (6 PASS, 1 FAIL, 1 PASS with cleanliness NOT VERIFIED)
- [ ] Command gates re-run (impossible in this review environment; `npx pnpm@10 install --frozen-lockfile`, `pnpm build/lint/test`, `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`, `cargo test export_ts`, plus `git status`/`git diff` for legacy/ and Rust cleanliness, must run before commit)
- [x] No critical issues found (no Critical or High; one Medium in check 1)
- [x] Code follows project conventions
- [x] No em dashes, double hyphens, or dash equivalents; use proper punctuation
- [x] Phase code integrates cleanly with prior phases (1a/1b transactional and tombstone contracts preserved; outbox lwwAt is a backward-compatible optional parameter; scoring fence untouched; generated.ts read-only)

### Recurring patterns for other agents

- Parsing external JSON must validate every array element with isRecord before touching its fields; a JSON array may legally contain null, and the parse layer's "returns issues, never throws" contract only holds if element shape is checked as eagerly as field shape.
- Any new write path that bypasses the guardRepos wrappers (direct Dexie access like applyBackupImport) will not publish StorageFailure events; either route writes through guarded repos or publish explicitly, or quota failures lose their alert surface.
- LWW timestamp comparisons are string comparisons on ISO text; keep one canonical timestamp shape (toISOString with milliseconds) across rows, ops, and imports, or normalize before comparing.

## 2026-10-15 - Phase 2 bucket 1: sync foundation (code review)

Verdict: PASS (static analysis; execution gates NOT RUN in this environment, list below)

Scope: uncommitted Phase 2 bucket 1 change set: `migrations/0006_sync_foundation.sql` (new);
`crates/db/src/{dto.rs, queries/{mod,spec,sync_apply,sync_pull}.rs}` (new), `models.rs`
(User.password_hash, Exercise.applied_at); `crates/sync/src/cursor.rs` (new) plus `lib.rs` module
wiring; `apps/api/src/{error.rs (new), config.rs, state.rs, main.rs}`; generated and hand-written
`packages/api-types/src/{generated.ts, rules.generated.ts, index.ts}`; new tests
`crates/db/tests/{catalog_uuidv5,sync_apply,model_decode,schema,password_hash}.rs`,
`crates/sync` cursor/spec/dto unit tests, and `apps/web/src/db/{rulesParity.test.ts, seed/uuidV5Golden.test.ts}`.
No HTTP behavior change (auth handlers and push/pull routes are later buckets). IMPORTANT: this
review environment has no shell tool, exactly like the 1b/1c/1d reviews: `git status`/`git diff`
and every command gate could NOT be executed. Everything below is static analysis of the working
tree. In lieu of a live Postgres, the migration's SHA-1 and UUIDv5 logic was verified
computationally: a sandbox re-implementation of FIPS 180-4 SHA-1 (fenced on the "abc" and empty
string vectors) and RFC 4122 UUIDv5 reproduced all four catalog golden vectors and the RFC
`www.example.com` vector byte for byte, confirming both the golden vectors in
crates/db/tests/catalog_uuidv5.rs and the algorithm as traced through the SQL.

### Check Results

| Check | Verdict | Details |
|-------|---------|---------|
| 1. Migration 0006: append-only and re-entrant | PASS | 0001 through 0005 are read intact and consistent with 0006's assumptions (FK names `exercise_entries_exercise_id_fkey` re-added at 0003:154-156 and auto-named `routine_entries_exercise_id_fkey` at 0001:109; `stamp_applied_at()` at 0003:76-82 is reused, not redefined). Byte-level immutability of 0001-0005 is NOT verifiable without git and must be confirmed before commit. Re-entrancy is designed in (IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER before CREATE TRIGGER, remap UPDATEs guarded by `id <> waveform_catalog_id(name)`) and proven by catalog_uuidv5.rs:448-468 (`migration_0006_is_reentrant` executes the file twice). `SET CONSTRAINTS ALL DEFERRED` (0006:194) works because both sanctioned runners send the file as one simple-query batch, which Postgres wraps in one implicit transaction (sqlx Migrator adds an explicit one); the catalog test's `run_files` comment (catalog_uuidv5.rs:146-147) documents this. |
| 2. UUIDv5 SQL helper byte-for-byte parity with uuidV5.ts | PASS | NAMESPACE_DNS literal identical (0006:180 vs uuidV5.ts:13); input is `namespace bytes \|\| UTF8(lower(name))` (0006:166-168 vs uuidV5.ts:46-52, `.toLowerCase()` at :47); version nibble `(b & 15) \| 80` and variant `(b & 63) \| 128` at the same byte offsets 6 and 8 (0006:170-171 vs uuidV5.ts:58-59); `substr(digest, 1, 16)` vs `digest.slice(0, 16)`. The plpgsql SHA-1 (0006:82-156) was traced line by line against FIPS 180-4: padding, big-endian bit length, 1-based message schedule equivalent to `w[t] = rot1(w[t-3]^w[t-8]^w[t-14]^w[t-16])`, the four round functions and constants, and per-round mod 2^32 masking; `waveform_rol32` shifts only non-negative 32-bit values so `>>` is a clean logical shift. The three-legged fence (SQL, `uuid::new_v5`, vitest) shares the four golden vectors, which an independent computation reproduced exactly. Minor caveat (Info below): SQL `lower()` and JS `toLowerCase()` can diverge for non-ASCII names. |
| 3. Catalog id remap and FK remap | PASS | Both FKs become DEFERRABLE INITIALLY IMMEDIATE (0006:187-192), children remap first under deferred constraints (0006:229-241), parents last (0006:243-246); the DO block (0006:198-225) guards both name-to-id collisions and occupied target ids (including targets held by custom rows, since `other.id` is checked regardless of owner) and aborts cleanly. Counts, names, child links, constraint flags, and no-orphans are asserted at catalog_uuidv5.rs:324-446. Applied at scale against the real 91-row catalog plus seeded children (catalog_uuidv5.rs:329-337). |
| 4. exercises.applied_at, trigger, index, child pull indexes, password_hash | PASS | Column with `DEFAULT now()` and NOT NULL (0006:58), `exercises_applied_at` BEFORE INSERT OR UPDATE trigger reusing `stamp_applied_at()` (0006:59-61, restamping so re-keyed rows re-pull), `(owner_id, applied_at, id)` index (0006:62, asserted at catalog_uuidv5.rs:433-443), plain `(applied_at, id)` pull indexes on exercise_entries, set_entries, routine_entries (0006:67-69) so the child pull ORDER BY is an index range scan after the join. `users.password_hash text` nullable (0006:52) with tests for nullability, round trip, serde skip, and generated.ts absence (password_hash.rs:103-217). |
| 5. Sync apply engine: one transaction per op and atomic claim | PASS | `apply_op` (sync_apply.rs:171-237) opens one transaction holding both the `client_ops` claim and the row upsert; only Applied and DiscardedStale commit. The claim (sync_apply.rs:176-187) conflicts only on the `client_ops.id` PK (0001:254), and the unique-violation path rolls back, reads the committed owner, and decides through `idempotency_check` (sync_apply.rs:189-211): same user is Duplicate, foreign user is `ApplyError::ForeignOpId` which aborts the batch and stores nothing (`apply_ops` :243-259; mapped to 409 in error.rs:116-118). A committed claim exists if and only if the op was Applied or DiscardedStale, so the client contract is exact. The concurrent same-op retry race is also safe: Postgres blocks the second claim INSERT on the first transaction until it commits or rolls back. |
| 6. Clamp, owner override, catalog rejection, parent checks | PASS | `clamp_client_timestamp` applied against the DB clock `SELECT now()` inside the op transaction (sync_apply.rs:270-273; contract in crates/sync/src/lib.rs:107-114, ceiling `server_now + 5 min`). Payload `user_id`/`owner_id` can never land: `jsonb_populate_record` fills only `spec.columns` and the owner is forced at bind `$3` (spec.rs:301-306, :327-330); the owner probe rejects rows owned by others and SQL NULL owners, so catalog rows can never be pushed (sync_apply.rs:288-297, Forbidden). Parent probes distinguish Retryable (missing, no claim) from Rejected (foreign) (sync_apply.rs:301-323), and `EXERCISE_PROBE` (spec.rs:73-74) correctly treats `owner_id IS NULL` catalog exercises as shared, so exercise_entries and routine_entries referencing the catalog pass. |
| 7. LWW, tombstones, race guard, applied_at, SQLSTATE split | PASS | `incoming_wins` is strict (ties keep stored), the upsert carries `ON CONFLICT (id) DO UPDATE ... WHERE table.updated_at < EXCLUDED.updated_at` and `rows_affected() == 0` degrades to DiscardStale with the claim kept (sync_apply.rs:362-377, spec.rs:336-343). Deletes insert or update a tombstone while keeping the stored payload (spec.rs:319-333, doc :285-290) and newer updates resurrect by clearing deleted_at; both directions are tested (sync_apply.rs:657-751). `applied_at` is never payload-writable (spec.rs:375-381) and the trigger stamps it. SQLSTATE classification (sync_apply.rs:79-96): 23514/23502/23505/22xxx to Rejected, 23503 to Retryable, everything else to Retryable via the batch downgrade. The Rejected-terminal versus Retryable-kept split is coherent: Rejected and Retryable both roll back claim and row, but Rejected (Forbidden, InvalidPayload) is deterministic on replay while Retryable (missing parent, transient DB) is designed to succeed later, and the tests pin the no-claim behavior for both (sync_apply.rs:1207-1401). |
| 8. pull_page and cursor codec | PASS | `pull_sql` (spec.rs:350-360) is entity-generic, owner-scoped per spec, exclusive `(applied_at, id)` cursor with the matching ORDER BY, tombstones included, payload is `to_jsonb(t) - 'applied_at'` with `applied_at` exposed as a column; exercises pull is `t.owner_id = $1`, custom only. Limit clamps to `RuleConstants::default().sync.pull_page_size` (sync_pull.rs:44-45), `next_cursor` is the last row of a full page and null otherwise (sync_pull.rs:67-76), covered by shared-applied_at page-boundary and clamp tests (sync_apply.rs:919-1014, :1587-1636). The cursor codec (cursor.rs) is `{unix_micros}-{uuid}` at Postgres microsecond resolution, splits from the right so negatives and garbage are handled, and every garbage shape in the test list is an error variant, never a panic (cursor.rs:152-168). |
| 9. DTOs, ts-rs exports, models | PASS | SyncEntity serde strings equal the client `OutboxEntity` union plus the routine pair (dto.rs:22-67 vs types.ts:33-39; fenced by dto.rs:407-427 and generated.ts:282). RuleConstants values deep-equal `apps/web/src/db/validation.ts` (1/36/0/1500, 0/1440/0/16/0, 0/1500/0/100) and the sync/password literals (200/500/5/10), fenced three ways: dto.rs:370-404, rulesParity.test.ts, and rules.generated.ts:4-32 whose formatting matches `serde_json::to_string_pretty` output of `export_ts_rules` exactly. generated.ts field order and shapes match the Rust declarations; `User` carries no `password_hash` (generated.ts:297-302), `Exercise` carries `applied_at` (generated.ts:100-109) which the client absorbs via `LocalRow<T> = Omit<T, "applied_at">` (types.ts:22). `index.ts` re-exports both generated files. Byte-identical regeneration is confirmed only by running the export tests (in the gate list). |
| 10. apps/api error, config, state | PASS | `ApiError` maps 401/403/404/409/422/413/429/500 with the snake_case wire codes (error.rs:45-70), 500 details stay in the log (error.rs:89-92), `From<sqlx::Error>` maps RowNotFound to 404 and everything else to 500 (error.rs:101-111), `From<ApplyError>` maps ForeignOpId to 409 Conflict (error.rs:113-125). config.rs validates `SESSION_SECRET` presence and 32-character minimum (config.rs:51-58) and keeps it out of the migrate path (config.rs:74-76). state.rs is unchanged in behavior (pool plus Arc config). routes/mod.rs still serves only healthz plus the existing auth router; no route behavior change. |
| 11. Test quality | PASS | sync_apply.rs mirrors every outbox_contract.rs scenario through the real engine (duplicate, foreign op id, pre-claimed op id, stale replay, out-of-order both ways, equal-timestamp ties both orders, tombstone blocks older, resurrect, batch order, pull with tombstones, shared applied_at boundary, future skew) and adds the DB-only cases the brief lists: session-user override (sync_apply.rs:1098-1156), catalog rejection with no trace (:1159-1204), child-before-parent retry then success with the same op id (:1207-1311), CHECK and data-error rejection with no claim (:1314-1401), cross-user pull isolation and foreign-row rejection (:1404-1533), delete of an unknown row inserting a tombstoned owned row (:1536-1584), limit clamping (:1587-1636), and the routines pair (:1639-1741). The UUIDv5 fence covers SQL (catalog_uuidv5.rs), Rust (`uuid::new_v5`), and TS (uuidV5Golden.test.ts) on shared vectors. password_hash.rs asserts JSON and generated.ts non-exposure. |
| 12. Conventions and cleanliness | PASS | 4-space K&R Rust throughout, snake_case/PascalCase/SCREAMING_SNAKE, no `unsafe` anywhere in crates/ or apps/api (grep), no em dashes, en dashes, or spaced double hyphens in any new file (the only `--` is the sanctioned `cargo run -p waveform-api -- migrate` flag in 0006:16), ts-rs export path resolves via .cargo/config.toml TS_RS_EXPORT_DIR. "No unintended edits" and migration immutability are NOT verifiable without git and must be confirmed before commit. |

### Findings (non-blocking)

| Severity | File:Line | Issue | Fix |
|----------|-----------|-------|-----|
| Low | docs/reviews.md:473 (1d Info) vs crates/db/src/queries/sync_apply.rs:288-297 | This bucket DEFINES the contract the 1d review asked about: a push targeting an existing server-owned catalog row (owner_id null) is Rejected with Forbidden and stores nothing. That resolves the question, but the client sync drain (later bucket) must treat Rejected on catalog exercises as a clean drop, and ideally the client stops queueing outbox ops for owner_id null rows at import time (backupImport.ts:521, :586-588), or every import will surface terminal rejections. | Handle Rejected by dropping the op in the drain; skip owner_id null rows when queuing import ops. |
| Low | crates/db/tests/{catalog_uuidv5,sync_apply,password_hash,schema,model_decode}.rs | The scratch-database scaffolding (base_url, with_database, ScratchDb, drop_scratch, skip_without_db) is duplicated across five test files, roughly 60 lines each. | Extract a shared test-support module (for example `tests/common/mod.rs`) once a sixth copy appears. |
| Low | docs/tests.md:82-185 | The standing test record does not yet list the new suites (catalog_uuidv5 3 tests, sync_apply 17, password_hash 3, export_ts_rules 1, plus the cursor, spec, and dto unit tests). Counts rows are stale again. | Append the new suites and counts at the next test pass (carried pattern from prior reviews). |
| Info | crates/db/src/queries/sync_apply.rs:185 vs migrations/0001_init.sql:259 | The claim stores the raw client `updated_at` in `client_ops.updated_at` while the 0001 comment calls it the row's LWW timestamp; the LWW value actually written is the clamped one. Audit semantics, not a bug, and the 0001 comment cannot change (append-only). | One-line comment at the claim bind noting the raw value is an audit record. |
| Info | migrations/0006_sync_foundation.sql:180 vs apps/web/src/db/seed/uuidV5.ts:47 | `lower(name)` is collation-dependent while `toLowerCase()` is Unicode default case folding; non-ASCII exercise names can theoretically derive different ids per side. All catalog names are ASCII today. | Keep catalog names ASCII, or normalize with a documented fold on both sides. |
| Info | crates/db/src/queries/spec.rs:285-290 | The delete-for-unknown-row tombstone INSERT requires the full-row payload contract (NOT NULL columns); a sparse delete payload for a row the server has never seen is Rejected via 23502 rather than inserting a minimal tombstone. Matches the documented contract (payloads carry the full row) and is tested. | None; noted so a future payload-slimming change revisits the tombstone insert shape. |

### Verification Checklist

- [x] All code checks passed (12 of 12 PASS; none FAIL)
- [ ] Command gates re-run (impossible in this review environment; the list below must run before commit: `docker compose -f infra/docker-compose.yml up -d postgres`, then `WAVEFORM_TEST_DATABASE_URL=postgres://waveform:waveform@localhost:5432/waveform cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`, the migrate-twice idempotence check (`cargo run -p waveform-api -- migrate` twice against a scratch database, plus the in-suite `migrations_are_idempotent_on_rerun` and `migration_0006_is_reentrant` under the test URL), the ts-rs drift recipe (remove `packages/api-types/src/generated.ts` and `rules.generated.ts`, run `cargo test export_ts`, require byte-identical files and no git drift), and `npx pnpm@10 install --frozen-lockfile` plus `pnpm lint`, `pnpm test`, `pnpm build`; `git status`/`git diff` must also confirm 0001-0005 untouched and no unintended edits)
- [x] No critical issues found (no Critical, High, or Medium; three Low, three Info)
- [x] Code follows project conventions
- [x] No em dashes, double hyphens, or dash equivalents; use proper punctuation
- [x] Phase code integrates cleanly with prior phases (engine mirrors the outbox contract scenario for scenario; the 1d catalog-op question now has a defined server answer; schema assumptions cross-checked against 0001-0005)

### Recurring patterns for other agents

- The claim-then-act pattern (insert the idempotency key first, decide on the unique violation, commit only outcomes that must persist) is the right shape for replayable work; keep Rejected and Retryable outcomes rollback-only so the client can retry retryable ops under the same id.
- Parity fences should be three-legged like the UUIDv5 one (SQL, Rust, TS sharing golden vectors) so a drift on any side fails two suites; rule constants use the same pattern through export_ts_rules plus the vitest deep-equal.
- Databases-level tests that execute migration files from disk (not through the embedded migrator) are how you prove re-entrancy and inspect intermediate states; keep the "one file per simple-query batch" assumption documented, since SET CONSTRAINTS depends on the implicit transaction.
- Everything a payload could spoof (owner columns, updated_at, deleted_at, applied_at, generated columns) must be bound or stripped before the write; `jsonb_populate_record` plus an explicit select list is a clean way to keep column lists in lock step while ignoring hostile keys.

## 2026-10-16 - Phase 2 bucket 2: auth core (code review)

Verdict: PASS WITH ISSUES (static analysis; execution gates NOT RUN in this environment, list below; one docs-only FAIL row, check 4b, a Low that lands before commit)

Scope: uncommitted Phase 2 bucket 2 change set (auth core + deploy readiness): new
`apps/api/src/{lib,auth,extractors,rate_limit}.rs`, rewritten `apps/api/src/routes/auth.rs`,
new `crates/db/src/queries/auth.rs`, new `crates/db/tests/{support/mod,auth_queries}.rs`, new
`apps/api/tests/auth_routes.rs`, new `Dockerfile` and `render.yaml`; edited
`apps/api/src/{main,state,error,routes/mod,config}.rs`, `crates/db/src/queries/mod.rs`,
`Cargo.toml`s, `Cargo.lock`, `.env.example`, `infra/railway.toml`, `docs/*`, `AGENTS.md`.
Product decision: email + password accounts, open sign-up, no OTP/MFA/email verification/OAuth;
session = opaque 256-bit token in `AuthResponse` sent as `Authorization: Bearer`, DB stores
HMAC-SHA256(SESSION_SECRET, token) hex, rotating `SESSION_SECRET` invalidates all sessions.
IMPORTANT: this review environment has no shell tool, exactly like the 1b/1c/1d and bucket 1
reviews: `git status`/`git diff` and every command gate could NOT be executed. Everything below
is static analysis of the working tree.

### Check Results

| Check | Verdict | Details |
|-------|---------|---------|
| 1a. Argon2id parameters and PHC round-trip | PASS | auth.rs:15-21 pins m=19456, t=3, p=1, 32-byte output; `hash_password` (auth.rs:40-53) builds `Params` explicitly with `SaltString::generate(OsRng)`; round-trip and wrong-password rejection tested at auth.rs:181-190. `verify_password` (auth.rs:57-64) returns false on malformed PHC and never panics; verification uses the params embedded in the PHC string (empirically pinned: the round-trip test would fail under instance defaults), so DUMMY_PHC (auth.rs:36-37, same m/t/p) makes a miss cost one real verification. |
| 1b. Byte-identical 401s, no login enumeration | PASS | One `INVALID_CREDENTIALS` constant (routes/auth.rs:44) and one code path (routes/auth.rs:114-129) for unknown email, wrong password, and NULL hash (DUMMY_PHC at routes/auth.rs:114-119). `every_login_miss_is_one_byte_identical_401` (auth_routes.rs:235-275) compares raw body bytes across all three. |
| 1c. Validation vs RuleConstants | PASS | Password 10 (rules) to 1024 bytes (routes/auth.rs:38, 204; dto.rs:334), email 3 to 254 bytes with one `@`, dotted domain, no whitespace or double dots (routes/auth.rs:224-243), display name trimmed 1 to 60 chars (routes/auth.rs:212-217); boundaries unit-tested (routes/auth.rs:258-298). |
| 1d. Case-insensitive uniqueness, race-safe insert | PASS | `lower(email) = lower($1)` lookups (queries/auth.rs:86-95) against `users_email_lower_key` (0003_hardening.sql:165); `create_user` has no pre-check and `classify_insert` (queries/auth.rs:50-61) maps unique violations on both email indexes to `DuplicateEmail` (409 at routes/auth.rs:83-88). Tested at auth_queries.rs:40-61 and auth_routes.rs:176-198. |
| 2a. Token generation and HMAC | PASS | 32 OsRng bytes hex-encoded (auth.rs:66-72). `hmac_sha256` (auth.rs:84-113) verified line by line against RFC 2104: H(K) then zero-pad for keys over B=64, zero-pad otherwise, 0x36/0x5c pads, H(opad \|\| H(ipad \|\| m)); correct including the exactly-64-byte boundary. RFC 4231 cases 1, 2, 6 reproduced byte for byte (auth.rs:128-149). The hand-rolled deviation is recorded in the ADR (decisions.md:427-429) and vector-fenced; acceptable. |
| 2b. Session lifecycle and secret hygiene | PASS | Lookup joins users, rejects expired and tombstoned rows (queries/auth.rs:129-145); logout deletes by hash, always 204, idempotent (routes/auth.rs:151-159; auth_routes.rs:319-350); TTL 30 days (auth.rs:30, routes/auth.rs:177); raw token only in `AuthResponse` (dto.rs:221-225); no token or hash logged (grep); `Session`/`OtpCode` not serializable (models.rs:56-75); `password_hash` serde+ts skipped (models.rs:31-33). |
| 3. Extractors and error mapping | PASS | `bearer_token` (extractors.rs:56-63) rejects missing, wrong-scheme, multi-token; `AuthUser` 401s them all (extractors.rs:38-50; auth_routes.rs:353-383). `ApiJson` envelopes JSON rejections (extractors.rs:77-82; auth_routes.rs:509-543). Status mapping correct (error.rs:47-57); 500 bodies carry only generic literals (Info row 5). |
| 4a. Rate limiter logic | PASS | 10 failures then lockout per 15-minute window keyed by trim-then-lowercase (rate_limit.rs:15-17, 92-94); success and signup clear (routes/auth.rs:92, 137); signup consults the limiter (routes/auth.rs:61-65); prune cap 10k keys (rate_limit.rs:21, 66-69); poisoned lock fails open (rate_limit.rs:49-54). Route 429 and reset tested (auth_routes.rs:386-423); unit tests at rate_limit.rs:102-146. |
| 4b. Per-email lockout DoS assessed and documented | FAIL | An attacker can lock one address out of login and signup for up to 15 minutes with 10 failed attempts against it. Acceptable at friend-group scale, but documented nowhere: ADR trade-offs (decisions.md:460-465) cover only process-local reset and session rotation, and grep for DoS/denial/lockout across docs returns nothing. Low, docs-only fix below. |
| 5. CORS | PASS | Exact single origin via `AllowOrigin::list` (routes/mod.rs:56-62), GET/POST/OPTIONS plus Authorization and Content-Type (routes/mod.rs:52-53), `allow_credentials(false)` explicit (routes/mod.rs:54), 600 s max age; wildcard or malformed origin fails closed (routes/mod.rs:60-68); foreign origins get no `access-control-allow-origin` header at all (auth_routes.rs:426-506). |
| 6. Deploy artifacts | PASS | Dockerfile multi-stage, `cargo build --release -p waveform-api` (Dockerfile:25), binary-only copy into debian:bookworm-slim with ca-certificates (Dockerfile:27-31), `CMD ["waveform-api"]` (Dockerfile:36). render.yaml: `healthCheckPath: /healthz` (line 10), `preDeployCommand: waveform-api migrate` (line 13; migrate needs only DATABASE_URL, config.rs:74-76), `RUN_MIGRATIONS: "false"` (lines 30-31), no committed secrets (DATABASE_URL and SESSION_SECRET are `sync: false`, lines 20-25); railway.toml header-marked superseded (lines 1-3). Hardening notes in the findings table. |
| 7. Models and ts-rs | PASS | `password_hash` `#[serde(skip)] #[ts(skip)]` (models.rs:31-33), absent from generated.ts `User` (generated.ts:297-302) and from signup/login/me bodies (auth_routes.rs:135-147, 216-219); DTO shapes match dto.rs:202-225 and generated.ts:49, 148, 276. Byte-identical `cargo test export_ts` regeneration NOT verifiable here; gate item 5. |
| 8. Test genuineness | PASS | Identical 401s by raw byte comparison (auth_routes.rs:258-272), expired session via hand-inserted past expiry (auth_routes.rs:293-313), logout idempotence including no-token no-op (auth_routes.rs:333-347), 429 on the 11th failure plus reset proven by 10 fresh 401s (auth_routes.rs:395-420), CORS preflight allow and foreign deny (auth_routes.rs:432-484), malformed JSON and missing-field envelopes (auth_routes.rs:509-541); auth_queries covers collision, tombstones, round trip, expiry, purge scope (auth_queries.rs:39-240). Counts match docs/tests.md:16-18 (15 unit, 11 route, 6 query). Gap: signup throttle path untested at route level (Low row 4). |
| 9. Conventions and cleanliness | PASS (git-dependent parts unverifiable) | 4-space K&R, snake_case/PascalCase/SCREAMING_SNAKE throughout; `unsafe_code = "forbid"` (Cargo.toml:44) and zero `unsafe` hits (grep); zero em or en dashes in the tree (grep), remaining `--` are command flags and table separators; HMAC deviation fenced per the ADR. "Migrations untouched", "no unintended edits", and export_ts drift are NOT verifiable without git and must be confirmed before commit. |

### Findings (FAIL items and non-blocking)

| Severity | File:Line | Issue | Fix |
|----------|-----------|-------|-----|
| Low (the 4b FAIL) | docs/decisions.md:460-465; apps/api/src/rate_limit.rs:1-8 | Per-email lockout DoS undocumented: 10 failed attempts against `lower(trim(email))` on /auth/login or /auth/signup lock that address out of both endpoints for up to 15 minutes (routes/auth.rs:61-65, 103-107; failures recorded at routes/auth.rs:68, 84, 128). Acceptable at friend-group scale, but the ADR trade-offs paragraph does not say so. | Add one ADR trade-offs bullet: per-email lockout is a small targeted DoS (one address, 15 minutes), accepted at friend-group scale; revisit with per-IP limits or by not counting signup validation and duplicate probes if abuse appears. Mirror one sentence in the rate_limit.rs module doc. |
| Low | Dockerfile:24 | No `.dockerignore`; `COPY . .` pulls `.env`, `.git`, `node_modules`, and `target` into the builder stage. The runtime image only receives the binary (Dockerfile:31), but `.env` lands in cached builder layers and builds are slow. | Add `.dockerignore` (`.git`, `node_modules`, `target`, `dist`, `.turbo`, `.env`, `.env.*`, `!.env.example`). |
| Low | apps/api/src/config.rs:15 | `Config` derives `Debug`, formatting `session_secret` in clear text; a future `tracing::debug!(?config)` would leak the HMAC key. Nothing logs it today (lib.rs:48-52 logs origin and secret length only). | Drop `Debug` or hand-implement a redacting `Debug`. |
| Low | apps/api/tests/auth_routes.rs (suite) vs routes/auth.rs:61-70, 83-88 | Signup throttle path has no route-level test: `is_limited` on signup (429) and `record_failure` on validation failure and `DuplicateEmail` are covered only by limiter unit tests. | Extend the rate-limit route test (or add one) with 10 failed signups then a 429 on /auth/signup. |
| Info | apps/api/src/error.rs:87-99 | `ApiError::Internal(String)` returns its message in the 500 body; "details not leaked" holds only because all constructors use generic literals (error.rs:108, 122; routes/auth.rs:124, 135, 193, 197). | Return a fixed `"internal error"` body message for 500 and keep the variant string log-only. |
| Info | apps/api/src/auth.rs:125-126; docs/tests.md:40-41 | RFC 4231 vector 2 is the 4-byte key "Jefe", not an "exact-block key" as both comments claim; the exactly-64-byte key boundary (the `>` test at auth.rs:88) is untested (vectors cover 20, 4, 131 byte keys). | Fix the comment; optionally add a 64-byte-key known-answer case. |
| Info | apps/api/src/rate_limit.rs:16 | Window documented as "sliding" but implemented as fixed, anchored at the first failure (rollover only, rate_limit.rs:75-78); unlock is 15 minutes after the first failure, not the last. Gentler than sliding; behavior fine. | Rename to "fixed window", or slide `opened_at` per failure. |
| Info | Dockerfile:19-25, 27-36 | `cargo fetch` downloads but does not compile, so the cache layer saves registry I/O only; deps recompile after `COPY . .`. Runtime container runs as root. | Optional: compile against placeholder sources in the cache layer; add `USER nobody` in the runtime stage. |
| Info | routes/auth.rs:83-88 with open sign-up | Signup 409 for taken addresses makes account existence probeable at signup; inherent to open sign-up and specified in the ADR. Login enumeration properly closed; docs/tests.md:25-27 correctly scopes its claim to the 401 bodies. | None; keep "no enumeration" claims scoped to login. |

### Verification Checklist

- [x] All code checks passed (8 of 8 code checks PASS; check 4b FAILs as a documentation gap only)
- [ ] Command gates re-run (impossible in this review environment; the list below must run before commit: `docker compose -f infra/docker-compose.yml up -d postgres`, `WAVEFORM_TEST_DATABASE_URL=postgres://waveform:waveform@localhost:5432/waveform cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`, `cargo test export_ts` plus an empty `git diff -- packages/api-types/src/generated.ts`, `git status`/`git diff` to confirm `migrations/0001-0006` untouched and no unintended edits, `npx pnpm@10 install --frozen-lockfile` plus `pnpm lint`, `pnpm test`, `pnpm build`, and the docs-only check 4b fix)
- [x] No critical issues found (no Critical, High, or Medium; four Low, five Info)
- [x] Code follows project conventions
- [x] No em dashes, double hyphens, or dash equivalents; use proper punctuation (tree grep clean; remaining `--` are command flags and markdown table separators)
- [x] Phase code integrates cleanly with prior phases (0006 `password_hash` and 0003 `users_email_lower_key` line up with queries/auth.rs; bucket 1 error/config/state extended not restructured; Session non-serializable posture from the bucket 1 review upheld)

### Recurring patterns for other agents

- The DUMMY_PHC pattern (verify unknown-email and NULL-hash misses against a real-parameter dummy hash, one shared error constant, one code path) is the right shape for timing-equalized credential checks; route every new auth failure mode through it so response bodies stay byte-identical.
- Hand-rolled crypto is acceptable only when fenced by published test vectors (RFC 4231 here) and recorded as an explicit deviation in the ADR. Keep both halves of the fence together.
- When a mitigation creates a new abuse surface (per-email lockout here), document the accepted trade-off in the ADR trade-offs next to the mitigation, not only the mechanism; reviewers asked to verify "documented" will grep for it.
- Multi-stage Docker builds need a `.dockerignore` from the first commit; `COPY . .` silently ingests `.env` and `.git` even when only a binary leaves the builder.

## 2026-10-16 - Phase 2 bucket 3a: sync routes (code review)

Verdict: PASS (static analysis; execution gates NOT RUN in this environment, list below)

Scope: uncommitted Phase 2 bucket 3a change set (server sync surface): new
`apps/api/src/routes/sync.rs` and `apps/api/tests/sync_routes.rs`; edited
`apps/api/src/routes/mod.rs`, `apps/api/src/extractors.rs`, `apps/api/src/error.rs`,
`crates/db/src/dto.rs`, `packages/api-types/src/generated.ts` (regenerated). Wires the
bucket 1 engine (`apply_ops`, `pull_page`) to two authenticated handlers; no engine or
client changes. IMPORTANT: this review environment has no shell tool, exactly like the
prior reviews: `git status`/`git diff` and every command gate could NOT be executed.
Everything below is static analysis of the working tree.

### Check Results

| Check | Verdict | Details |
|-------|---------|---------|
| 1a. Push pre-check, 413, zero side effects | PASS | `ops.len() > max_ops_per_push` checked at sync.rs:56-67 before `apply_ops` (sync.rs:69), so an oversized batch answers 413 with no database work; `usize::try_from(...).unwrap_or(0)` (sync.rs:60) fails closed on any conversion surprise. Test `a_push_over_the_ops_cap_is_413_with_zero_side_effects` (sync_routes.rs:447-497) pins the documented 200 cap (sync_routes.rs:457) and asserts zero `client_ops` claims and zero rows after a 201-op push. |
| 1b. ForeignOpId to 409, batch abort | PASS | `From<ApplyError>` (error.rs:121-133) maps `ForeignOpId` to `Conflict`/`conflict` and `Database` to `Internal`; the handler simply propagates with `?` (sync.rs:69). `a_foreign_op_id_aborts_the_batch_with_conflict` (sync_routes.rs:356-445) asserts 409 + envelope message, the trailing op never runs and is never claimed (sync_routes.rs:417-429), and Mallory's claim and row stay hers. Partial-commit semantics (ops before the foreign one stay committed, sync_routes.rs:408-415) match the bucket 1 engine contract and are explicitly asserted. |
| 1c. Pull request validation to 400 | PASS | `SyncEntity::parse` up front (sync.rs:81-82) and `parse_cursor` pre-decode (sync.rs:85-88) turn bad entity/cursor into `BadRequest` instead of the engine's internal `sqlx::Error::Decode` 500 (sync_pull.rs:49-53). Covered at sync_routes.rs:746-804: unknown entity, malformed cursor (message "invalid cursor"), non-numeric limit via the extractor, and missing entity, all 400 `bad_request`. |
| 1d. Limit clamping | PASS | `query.limit.unwrap_or(page_size).clamp(1, page_size)` (sync.rs:89-90) with `pull_page_size = 500` (dto.rs:315); engine re-clamps (sync_pull.rs:45), idempotent. `pull_clamps_the_limit_to_the_rule_bounds` (sync_routes.rs:994-1051) exercises limit 0, -5 (both behave as 1), page_size+10 (behaves as 500, null cursor), and the default. |
| 2. Error mapping table | PASS | Nine variants, one status and one code each (error.rs:51-77): 400/401/403/404/409/422/413/429/500 coherent. `ApiJson` keeps the axum body-limit 413 as `PayloadTooLarge` and maps every other rejection to `InvalidPayload` (extractors.rs:84-94); `ApiQuery` maps all query failures to `BadRequest` (extractors.rs:110-113). `rejection.status()`/`body_text()` are the documented axum 0.8.9 rejection accessors (axum pinned in Cargo.toml:18, Cargo.lock:69-70); compile confirmation is gate item 2. 500s log detail and return generic literals only (error.rs:97-105, 128-130). |
| 3. Router wiring | PASS | `sync::router()` merged at routes/mod.rs:45; `DefaultBodyLimit::max(2 * 1024 * 1024)` (routes/mod.rs:36, 50) applied after all merges, CORS still the last `.layer(cors)` so it stays outermost and preflights never reach a handler (routes/mod.rs:50-51, comment at 38-39). The body-limit layer placement is what the `an_oversized_body_is_413_with_the_error_envelope` test (sync_routes.rs:499-538) exercises end to end. |
| 4. DTO and generated types | PASS (drift gate pending) | `ApiErrorCode::BadRequest` added (dto.rs:180); `generated.ts:43` union is the full nine-value snake_case set in declaration order, `bad_request` first; `OpResult.error: ApiErrorCode \| null` (generated.ts:158-162) matches dto.rs:137-142. All other exported types inspected match their Rust sources. Byte-identical `cargo test export_ts` regeneration NOT verifiable here; gate item 5. |
| 5. Test genuineness | PASS | Exactly 14 `#[tokio::test]` cases (grep), each mapping to a required scenario: push/pull auth (sync_routes.rs:227-252, 726-743), payload-owner override (254-293), duplicate + discarded_stale incl. stale-op claim (295-354), foreign-op 409 abort (356-445), 200-op cap zero side effects (447-497), body-limit 413 (499-538), malformed JSON 422 (three shapes, 540-571), missing parent retryable with no claim (573-620), CHECK violation + catalog hijack rejected with no trace (622-724), unknown entity / bad cursor / bad query / missing entity 400s (745-804), paging with cursor round trip, tombstone at the tip and null `next_cursor` (806-899), two-user scoping incl. catalog exclusion (901-992), limit clamping (994-1051). All drive the real `routes::router` via `tower::oneshot` against a migrated scratch Postgres (`support::migrated_scratch`, crates/db/tests/support/mod.rs:55-86, included by `#[path]`, sync_routes.rs:32-33), skipping cleanly without `WAVEFORM_TEST_DATABASE_URL`. |
| 6. Conventions and cleanliness | PASS (git-dependent parts unverifiable) | 4-space K&R throughout, snake_case locals, PascalCase types, SCREAMING_SNAKE consts; zero `unsafe` in apps/api (grep); zero em or en dashes in rs/ts/md (grep); remaining `--` are command flags only (sync_routes.rs:11). Migrations dir holds exactly `0001`-`0006` (unchanged set); the handlers consume only the bucket 1 public engine surface (`apply_ops`, `pull_page`, `parse_cursor`, `PullParams`, `ApplyError`, queries/mod.rs:18-19) with no engine edits visible in the working tree. "No engine behavior change" and "no unintended edits" are NOT verifiable without git; gate item 6. |

### Findings (non-blocking)

| Severity | File:Line | Issue | Fix |
|----------|-----------|-------|-----|
| Info | apps/api/tests/sync_routes.rs (cap test) | The cap's success boundary is untested: exactly 200 ops passing is only implied by the `>` comparison (sync.rs:61) and the 201-op rejection. | Optionally assert one 200-op push returns 200 with 200 results. |
| Info | apps/api/src/routes/sync.rs:82 | The 400 message echoes raw `query.entity` input back to the client. Serde JSON-escapes it and the caller is authenticated, so there is no injection path; noting only as a pattern to keep escaped. | None required. |
| Info | apps/api/src/extractors.rs:112 | `ApiQuery` discards the underlying query rejection without a debug log; diagnosing a client with a mangled query string needs reproduction. | Optional: `tracing::debug!` the rejection alongside the generic message. |
| Info | apps/api/src/error.rs:40-43 | Variant declaration order interleaves 422 (`InvalidPayload`) before 413 (`PayloadTooLarge`); the mapping tables are coherent regardless. | Optional cosmetic reorder to match status order. |
| Note | apps/api/tests/sync_routes.rs:408-415 | A foreign `op_id` aborts the batch but ops before it stay committed (no batch-level transaction). This is the bucket 1 engine contract, now pinned by test; the web client retry loop must tolerate partial batch progress on 409. | None; keep the contract documented in the client sync design. |

### Verification Checklist

- [x] All checks passed (6 of 6 code checks PASS; five non-blocking observations above)
- [x] No critical issues found (no Critical, High, Medium, or Low findings)
- [x] Code follows project conventions
- [x] No em dashes, double hyphens, or dash equivalents; use proper punctuation (tree grep clean; remaining `--` are command flags and markdown table separators)
- [x] Phase code integrates cleanly with prior phases (bucket 1 engine surface used unchanged; bucket 2 extractors extended not restructured; the bucket 2 docs-only item (lockout DoS, decisions.md:466) has landed)
- [ ] Command gates re-run (impossible in this review environment; must run before commit: `docker compose -f infra/docker-compose.yml up -d postgres`; `WAVEFORM_TEST_DATABASE_URL=postgres://waveform:waveform@localhost:5432/waveform cargo test --workspace`; `cargo clippy --workspace --all-targets -- -D warnings`; `cargo fmt --check`; `cargo test export_ts` plus an empty `git diff -- packages/api-types/src/generated.ts`; `git status`/`git diff` to confirm no `crates/db/src/queries` behavior change, `migrations/0001-0006` untouched, and no unintended edits; `pnpm lint`, `pnpm test`, `pnpm build`)

### Recurring patterns for other agents

- Validate opaque wire tokens (cursors here) with the exported decoder before handing them to the engine, so a client mistake is a 400 and never an internal decode 500; keep the engine's decode as the second, unreachable line of defense.
- Pre-check payload sizes against `RuleConstants` caps in the handler before any database work; an envelope 413 with zero side effects is testable and honest, and the axum body limit stays a second, earlier net whose 413 must survive extractor rejection mapping.
- When a composite extractor rejection carries a status the envelope must preserve (413 from `DefaultBodyLimit`), branch on `rejection.status()` explicitly; folding every rejection into one code silently rewrites the status clients act on.
- Batch semantics deserve one integration test that pins the uncomfortable edges explicitly: partial commit before an abort, and no claim for rejected or retryable ops. Future buckets should keep that habit.

## 2026-10-16 - Phase 2 bucket 3b: client sync (code review)

Verdict: PASS WITH ISSUES (gates RUN this time via a delegated shell: install, lint, test, build,
and the production-style env build all green; one Low FAIL row, check 5b, a doc-versus-behavior
idempotence mismatch on a destructive path)

Scope: uncommitted Phase 2 bucket 3b change set (client sync engine, Account screen, wiring): new
`apps/web/src/lib/api.ts`, `lib/session.ts`, `lib/sync/{meta,compact,drain,adoption,pull,engine,chip}.ts`
with tests, `routes/Account.tsx`, `vite-env.d.ts`; edited `lib/appData.tsx`, `App.tsx`,
`components/CommandBar.tsx`, `lib/format.ts`, `styles/{shell,app}.css`, `db/{types,outbox,index}.ts`,
`db/outbox.test.ts`, `.github/workflows/pages.yml`, `docs/{architecture,decisions}.md`; deleted
`routes/Login.tsx`. Git status confirms no Rust, migration, or api-types changes. Unlike the prior
reviews, this environment reached a shell through a subagent: `npx pnpm@10 install
--frozen-lockfile`, `pnpm lint` (tsc noEmit, forced rerun, zero errors), `pnpm test --force`
(web: 45 files, 423 passed (423); scoring: 42 passed), `pnpm build`, and
`VITE_API_BASE_URL=... pnpm --filter @waveform/web run build` all exit 0; env inlining proven with
a distinctive probe URL because the production URL also ships as UI placeholder text.

### Check Results

| Check | Verdict | Details |
|-------|---------|---------|
| 1. API client | PASS | Resolution order is sync_meta override, then `VITE_API_BASE_URL`, then localhost (api.ts:91-108; override read from sync_meta at appData.tsx:311-314 and passed at appData.tsx:173). Bearer header on every call when a token exists plus JSON content type on bodies (api.ts:191-199). 401 fires `onAuthExpired` once then throws kind "auth-expired" (api.ts:212-219); transport failures map to "offline" or "timeout" by error name (api.ts:167-180); 5xx to "server", 4xx to "client" with the `{ code, message }` envelope parsed tolerantly (api.ts:149-165, 221-228). No logging anywhere in the new code (grep `console.` clean); the token touches only localStorage and the Authorization header. Every mapping is test-pinned (api.test.ts:43-232, incl. "onAuthExpired exactly once"). Info row 5 notes the loopback-only localhost fallback. |
| 2. Engine | PASS | Single-flight: one `currentRun` chain; concurrent requests join its promise and queue exactly one rerun that runs under the newest trigger's reason (engine.ts:410-450, pendingReason at 176, 419-420, 432-434). Triggers all present: start bootstraps (engine.ts:452-465), outbox writes debounce 2s (SYNC_DEBOUNCE_MS engine.ts:57; handler 276-288 via subscribeOutboxWrites), online (290-295), visibilitychange only when visible (297-302), manual (appData.tsx:477-479). Backoff 1s base, x2, 5min cap, reset on success and on online (engine.ts:62-69, 244-260, 320-335, 360-365) over injectable timers (engine.ts:86-88, 155-158). States idle/syncing/offline/waking/auth-expired/error (engine.ts:36, 234-242, 320-335). pending, quarantined, lastSyncedAt, conflicts recomputed after every run and on every queued write (engine.ts:190-211, 407). Ladder and states pinned test-by-test (engine.test.ts:319-545: 1000..300000 delays, waking at 2s, quarantine accounting). Low row 2 and Info row 9 below. |
| 3. Drain | PASS | `(created_at, op_id)` order (outbox.ts:138-151), batching at `maxOpsPerPush` 200 (drain.ts:73, engine.ts:383), acks applied/duplicate/discarded_stale removed (drain.ts:113-128), rejected routed to `markOutboxFailed` with quarantine at 3 (drain.ts:119-122; outbox.ts:22, 65-83), retryable left queued and deferred (drain.ts:123-125), abort reasons auth-expired/offline/error with timeout folded to offline (drain.ts:60-69), results keyed by op_id so unanswered ops simply stay queued and partial responses are safe (drain.ts:101-111), and the loop terminates because every iteration removes or defers at least one op. All pinned (drain.test.ts:71-257, incl. "keeps already-settled batches when a later batch aborts"). Low row 3 below. |
| 4. Pull merge | PASS | Strictly newer wins, tie keeps local (epoch rank, pull.ts:100-106, 243-247); tombstones merge through the same put since payloads carry `deleted_at` (pull.ts:141-168 against the generated.ts:188-193 payload contract); all writes are direct table puts with NO outbox op (pull.ts:141-168; pull.test.ts:121-137, 197-208); superseded queued ops (`op.updated_at <= incoming`) dropped with one conflict-log entry capped at 200 (pull.ts:170-207, 249-261, CONFLICT_LOG_CAP pull.ts:52); the per-entity cursor lands in the SAME transaction as the page merges (pull.ts:305-331) and the tail page leaves it unchanged (pull.ts:327-329); `last_synced_at` only after every entity reaches the tip (pull.ts:333-342). A queued NEWER op survives a conflict merge (pull.test.ts:340). |
| 5a. Adoption rewrite scope | PASS | One Dexie rw transaction over the synced stores, outbox, local_profile, and sync_meta (adoption.ts:94-107): `exercises.owner_id` only on custom rows (non-null, adoption.ts:118-123), `user_id` on workout_sessions/activities/body_stats (124-141), the same fields inside outbox payloads (143-162), local_profile re-keyed (69-80), `adopted_user_id` stamped (165). No new outbox ops (and ensureCatalog honors the same contract, seed/ensureCatalog.ts:4-5). adoptLocalUser is genuinely idempotent via its adopted guard (adoption.ts:108-115; adoption.test.ts:255-269). |
| 5b. adoptStartEmpty idempotence | FAIL (Low) | The module header claims "Both are idempotent" (adoption.ts:20-21) but adoptStartEmpty (adoption.ts:182-221) carries no adopted-user guard, so a second invocation wipes rows downloaded after the first. Wipe scope itself is correct: six synced stores + outbox + climb_sends (199-213), pull_cursor keys only (214), workout_drafts and non-cursor sync_meta kept (transaction list 183-196; adoption.test.ts:273-299). Exposure is narrow (the Account panel disables its buttons while busy and unmounts once the choice is answered), but this is destructive code contradicting its own doc. Fix row 1. |
| 5c. Engine start ordering | PASS | The engine is stopped while the first-sign-in choice is owed (appData.tsx:290-296) and starts only after adoption resolves (adoptionChoice awaits adoptLocalUser or adoptStartEmpty + ensureCatalog, then bindRepos and `engine.start()`, appData.tsx:399-416). |
| 6. UI wiring | PASS | Account.tsx carries signup/login (95-268), logout (271-312), the first-sign-in choice with "upload" as the primary default and start-empty behind the typed "empty" ConfirmDialog (319-399, phrase at 20), the sync readout (406-482), and the Advanced base-URL override with clear-to-default (489-585). `/account` routed and `/login` redirected via `Navigate` (App.tsx:1, router block). CommandBar chip derives from syncChip and links `/account` with an aria-label (CommandBar.tsx:14-20, 44-53). Accessibility: labels bound by for/id, `role="alert"` on failure and alert states, `role="status"` elsewhere (Account.tsx:46-48, 118-121, 418-441), aria-hidden lamp (427). Existing tokens reused throughout (btn/panel/def-list/form-status; `var(--steady/live/load)` tones at app.css:843-889, shell.css:74-124). |
| 7. pages.yml | PASS | `VITE_API_BASE_URL` present on the Build step (pages.yml:31-34). The production-style build inlines the value (verified with a distinctive probe URL since the real URL also appears as UI text at Account.tsx:548 and appData.tsx:435; mechanism appData.tsx:173). |
| 8. Cleanliness | PASS | Git status shows no Rust, migration, or api-types changes. The only network call is the api.ts factory against the resolved base (single `fetch(` at api.ts:184). Forced lint (tsc) zero errors; no `any` types anywhere (grep). Zero em or en dashes in the new code and docs (grep); remaining `--` are CSS custom properties, command flags, and table separators. Gates green: 423 web tests in 45 files pass and the claim is exact; every new module has real coverage (api.test 13 cases, session.test 12, engine.test 16, drain.test 8, pull.test 12, adoption.test 6, compact.test 4, chip.test 5, outbox.test additions 4, format.test `formatSyncStamp`). |

### Findings (FAIL items and non-blocking)

| Severity | File:Line | Issue | Fix |
|----------|-----------|-------|-----|
| Low (the 5b FAIL) | apps/web/src/lib/sync/adoption.ts:20-21, 182-221 | adoptStartEmpty has no adopted-user guard although the header claims "Both are idempotent"; a duplicate invocation (stale closure, programmatic call) wipes everything downloaded since the first, unlike adoptLocalUser's early return at adoption.ts:108-115. | Add the same guard: when `getMeta(db, ADOPTED_USER_ID_KEY) === userId`, return a zeroed summary without touching tables. Or narrow the header claim to adoptLocalUser only. |
| Low | apps/web/src/lib/sync/engine.ts:75, 427-435 | SYNC_MAX_ROUNDS (8) exits with `rerunQueued` still true and nothing reschedules, so a trigger that joined during the last round is silently dropped; a write landing mid-round-8 can sit unsent until the next external trigger (visibility, online, manual, or another write). | When the loop exits on the cap with `rerunQueued`, re-arm the debounce (or a backoff) timer so the dropped rerun still happens. |
| Low | apps/web/src/lib/sync/drain.ts:80-85 vs 44-46 | When the first `cap` pending ops are all deferred (retryable or unanswered in a partial response), the loop returns with `aborted` undefined while queued ops remain, contradicting the type doc "Present when the drain stopped early instead of emptying the queue"; ops beyond the first `cap` are never attempted in that drain. No data loss (the engine recomputes pending and later triggers retry), but the result contract is wrong and the engine reports a false "ok". | Exclude deferred op ids at query time (or fetch past them), or return a marker like `aborted: "deferred"`; at minimum align the doc comment. |
| Low | apps/web/src/lib/appData.tsx:418-425 | `setApiBaseUrl("")` clears the override and rebuilds the client but does not re-run `evaluateAuth()` (the non-empty path does, appData.tsx:441-446), so an engine halted on auth-expired or error stays stopped after clearing a bad address, contradicting the AccountActions doc ("re-evaluates sync", appData.tsx:82-86). | Run the same `if (auth.state() === "signed-in") void evaluateAuth()` after the clear. |
| Info | apps/web/src/lib/api.ts:102-107; docs/architecture.md:293-294; docs/decisions.md:516-517 | The localhost fallback is loopback-only and a deployed host with neither override nor env THROWS; both docs describe a flat "then the localhost default" chain. The stricter behavior is defensible (it never sends bearer tokens to the static host) and the tests pin it. | One doc sentence: the localhost default applies on loopback hosts only; elsewhere a missing address is a hard configuration error surfaced under Account. |
| Info | apps/web/src/lib/sync/drain.ts:33-35 | The `now?: Date` option is never read ("symmetry with pullAll"); dead API surface. | Drop it, or use it in a future timestamped drain summary. |
| Info | apps/web/src/lib/sync/adoption.ts:69-80 | `rewriteProfile` iterates a stale `toArray()`; with multiple local_profile rows the re-key put could clobber an existing target-id row. Single-row-per-device contract makes this theoretical. | Guard the put with a delete of the target id first, or assert the table holds at most one row. |
| Info | apps/web/src/lib/session.ts:175-177 | `markExpired` keeps the dead session in localStorage; a reload boots "signed-in" with a dead token and relies on the next 401 to re-park on "auth-expired". | Optionally downgrade or clear the stored session in `markExpired`. |
| Info | apps/web/src/lib/sync/engine.test.ts:215-249 | The coalescing test asserts one follow-up round and promise identity but not that the rerun runs under the newest joined reason (engine.ts:432-434); that path is only indirect coverage. | Assert the observed reason (for example through the online-join backoff reset) in one test. |

### Verification Checklist

- [x] All checks passed except one Low FAIL row (check 5b); every other area PASS
- [x] Gates re-run in this review environment (delegated shell): `npx pnpm@10 install --frozen-lockfile`, `pnpm lint` (forced, zero errors), `pnpm test --force` (423 web tests in 45 files and 42 scoring tests, all pass; the "423 web tests" claim is exact), `pnpm build`, and the production-style `VITE_API_BASE_URL` build with probe-verified inlining
- [x] No critical issues found (no Critical, High, or Medium; four Low, five Info)
- [x] Code follows project conventions (strict TS, no `any`, snake_case locals, PascalCase types, SCREAMING_SNAKE consts, existing design tokens)
- [x] No em dashes, double hyphens, or dash equivalents; use proper punctuation (greps clean; remaining `--` are CSS custom properties, command flags, and table separators)
- [x] Phase code integrates cleanly with prior phases (bucket 3a wire contracts honored: five-value OpStatus, PullRow payload minus applied_at, 200-op cap, tombstone soft deletes; Phase 1 repos unchanged apart from outbox bookkeeping hooks; `routes/Login.tsx` fully removed and `/login` redirected)

### Recurring patterns for other agents

- When a module header claims a safety property ("both are idempotent"), every destructive function in the module must carry the guard that delivers it; early-return on an adoption or migration marker is the pattern, as adoptLocalUser shows.
- Single-flight loops with a round cap need a defined end-of-cap behavior: re-arm a timer instead of dropping the queued rerun, or the cap silently becomes data deferral.
- Result contracts like "absent means fully drained" must hold on every exit path; if a loop can exit with work remaining, the result needs a marker the caller acts on.
- Env inlining cannot be proven by grepping the built bundle when the same literal ships as UI placeholder text; verify with a distinctive probe value and report both bundle hashes.

## 2026-10-16 - Full codebase review (standalone)

Verdict: PASS WITH ISSUES (gates RUN in this review via a delegated shell with the compose
Postgres up: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
`cargo test --workspace` 172 passed with `WAVEFORM_TEST_DATABASE_URL`, `cargo test export_ts`
zero drift, `npx pnpm@10 install --frozen-lockfile`/`lint`/`test` (468 passed)/`build` all
green, zero TODO/FIXME/unimplemented markers tree-wide; four Medium findings in the sync loop
and the adoption path, none blocking single-device use)

Scope: whole tree at `acf9e3a` (clean working tree), Phase 0 through Phase 2 buckets 1-3b.
Standalone review requested by the user: cross-check the phase plan against reality, audit
every prior finding in this file for RESOLVED/OPEN/REGRESSED, and fresh-review the client and
server sync engines, outbox atomicity, LWW, cursor paging, auth/session handling, and the
storage guard rather than trusting the per-bucket reviews. Prior bucket reviews already
covered buckets 1, 2, 3a, and 3b; this review independently re-verified their fix claims and
found every one of the 3b Low fixes landed.

### Check Results

| Check | Verdict | Details |
|-------|---------|---------|
| 1. Phase plan vs reality | PASS | Phase 0 complete (schema + 6 migrations, CI incl. rustsec/pnpm audit, Pages + Render deploys). Phase 1 complete (1a-1d: Dexie v2 core with 11 stores, repos with transactional outbox, workout core, activities, body, backup v2, storage resilience). Phase 2 in progress: buckets 1-3b landed and green (server sync engine, catalog UUIDv5 convergence, email + password auth with HMAC bearer sessions, sync routes, client sync engine, adoption, Account screen); open items are routines (server `EntitySpec` exists, no client repo/UI), running/hike/swim (schema and `ACTIVITY_RULES` allow them, client UI is cycling/climbing only), and the v1 import item is retired by ADR. Phase 3 placeholders only (Leaderboard/Heatmap/Feed/SocialLayout routes, empty `routes/social.rs`); Phase 4 not started. |
| 2. Prior-findings resolution | PASS | Full table in the standalone report; every Phase 0 High and Medium is RESOLVED (0003/0006 plus the auth ADR); only Low items remain open (CSP/_headers, action SHA pinning, DATABASE_URL TLS, client_ops retention job) plus docs/tests.md stale again (REGRESSED). |
| 3. Server sync engine (spec, sync_apply, sync_pull) | PASS | Re-verified independently: claim-then-act one transaction per op (sync_apply.rs:171-237), user-scoped idempotency with 409 on foreign op ids (sync_apply.rs:189-211), owner forced at bind and catalog rows Forbidden (spec.rs:301-306, sync_apply.rs:288-297), LWW with ON CONFLICT race guard (spec.rs:336-343), tombstones keep stored payload (spec.rs:319-333), server `(applied_at, id)` cursor with tombstones included (sync_pull.rs:59-76, spec.rs:350-360). One Medium: the cursor orders by transaction-start `applied_at` (0003:76-82) while visibility is commit order, so a row whose apply transaction commits after a pull snapshot can be skipped forever (finding 1). |
| 4. Client sync engine (engine, drain, pull, compact, adoption) | PASS | Single flight with round-floor re-arm (engine.ts:441-450, test engine.test.ts:320), deferred ids excluded from later batches (drain.ts:96-104), LWW merges with superseded-op drop and capped conflict log (pull.ts:218-267), per-page cursor + merges in one transaction (pull.ts:305-331), one-time compaction flagged in-transaction (compact.ts:31-61), adoption guarded idempotence on both paths (adoption.ts:111, 205). Mediums: no request timeout anywhere (finding 2), shared-device adoption can re-own or destroy another account's data (finding 3), import queues ops for server-owned catalog rows (finding 4). |
| 5. Outbox atomicity and LWW semantics | PASS | Row + op co-writes in one Dexie transaction hold across all repos (verified in 1a-1d reviews and re-read); op `updated_at` carries the row's LWW time with import-time `created_at` (outbox.ts:32-48); server clamps client timestamps to +5 min (sync lib.rs:107-114) and ties keep the stored row on both sides. Info: client `rank()` truncates to milliseconds while timestamptz is microseconds (pull.ts:100-106); theoretical today because every client stamp is `toISOString()` ms-precision. |
| 6. Auth and session handling | PASS | Argon2id m=19456 t=3 p=1 in spawn_blocking, byte-identical 401s with DUMMY_PHC, HMAC-SHA256 token hashing fenced on RFC 4231, 30-day TTL, case-insensitive email uniqueness, LoginLimiter with the documented per-email lockout trade-off, exact-origin CORS without credentials. Bearer tokens replaced the cross-site cookie design (the Phase 0 security High) and the model is implemented as recorded. `purge_expired_sessions` runs opportunistically on signup (routes/auth.rs:141); no scheduled sweep. |
| 7. Storage guard and import | PASS | `guardRepos` wraps every repo write, quota/unavailable failures publish exactly one StorageFailure (storage.ts, 1d review + re-read); the import parse now rejects non-object rows with an issue instead of throwing (backupImport.ts:294-307), closing the 1d Medium; merge and replace semantics and their rollback tests stand. |
| 8. Tests and gates | PASS | 172 Rust tests (Postgres-backed suites executed against the compose database), 468 JS tests (45 web files + scoring), export_ts byte-identical, clippy and fmt clean. Gaps below. |
| 9. Conventions and cleanliness | PASS | No em dashes or double hyphens in new prose, 4-space K&R, snake_case/PascalCase/SCREAMING_SNAKE hold, no `unsafe`, strict TS with no `any`. |

### Findings

| Severity | File:Line | Issue | Fix |
|----------|-----------|-------|-----|
| Medium | crates/db/src/queries/sync_pull.rs:59-65; migrations/0003_hardening.sql:76-82 | Pull cursor can permanently skip a row. `applied_at` is `now()` (transaction start) but a READ COMMITTED pull statement sees only committed rows: an apply transaction that begins at t1 and commits at t3 is invisible to a pull at t2, and if that page's cursor advances past t1 the row is never delivered to that client. The window is one apply transaction's lifetime (milliseconds normally, longer under row-lock contention between concurrent ops on one row), but the loss is silent and permanent until a full re-pull. | Cheapest correct fix at friend-group scale: treat the cursor as an optimization and schedule an occasional full re-pull (reset `pull_cursor:*`; LWW merges are idempotent). If commit-order delivery is required, enable `track_commit_timestamp` and page on commit timestamps. Document the residual window in the sync contract either way. |
| Medium | apps/web/src/lib/api.ts:205-210 (no AbortController anywhere in apps/web/src) | No request timeout. `transportError` maps AbortError/TimeoutError to "timeout" but nothing ever aborts, so a hung fetch (half-open socket after a phone network switch) wedges `performRun` forever: single-flight joins pile onto the hung promise, backoff never arms, and the engine sticks on "syncing"/"waking" until reload. | Wrap every call in an AbortController with a per-request timeout (30-60 s); the existing "timeout" to "offline" folding in drain.ts:75 and engine.ts:125 then works as designed. |
| Medium | apps/web/src/lib/sync/adoption.ts:56-62, 96-170; apps/web/src/routes/Account.tsx:349-399; apps/web/src/lib/appData.tsx:290-298 | Shared-device adoption leaks or destroys another account's data. `needsAdoption` keys only on the signing-in user id, so when user A adopted and signed out on a device, user B's first sign-in offers A's local log with "Upload my existing local data" as the primary action; `adoptLocalUser` rewrites every row (including A's owner-private body_stats) to B's owner and pushes them into B's account, while "Start empty" wipes A's local copy. The panel copy ("a training log before your account existed") presumes single ownership. | Detect foreign ownership: when the local rows' owner stamp or `adopted_user_id` names a different user, do not offer upload; show "this log belongs to another account" with export-then-wipe as the only path (or require the previous owner to sign in). Consider a "remove account data from this device" step on sign-out. |
| Medium | apps/web/src/lib/backupImport.ts:537, 602-604 (and the adoption upload rewrite) vs crates/db/src/queries/sync_apply.rs:288-297; apps/web/src/lib/sync/drain.ts:138-145 | Import queues outbox ops for server-owned catalog rows (owner_id null) that the server always rejects with Forbidden, so a replace-import seeds roughly 91 ops that burn three push rounds inside the first drain (rejected ops are not deferred, so each is re-pushed up to the quarantine threshold in one drain) and then surface as a large "quarantined" count on the Account screen. The bucket 1 review prescribed "treat Rejected on catalog exercises as a clean drop and stop queuing ops for owner_id null rows"; only the server half landed. | Skip ops for `owner_id === null` rows in the merge/restore loops (and the adoption payload rewrite), and/or drop `rejected` results for catalog rows cleanly in the drain. Also defer rejected ids for the rest of a drain so one poisoned batch is attempted once per run, not three times. |
| Low | apps/web/src/db/repos/exercises.ts:89, 117; apps/web/src/db/repos/workouts.ts:174-425 | Carried from the Phase 1b review: mutation guards compare `owner_id` only to null and never to `deps.userId` (workouts mutations check existence only), so repos bound to one user can mutate another user's rows in the same IndexedDB. Low while one account per device holds; finding 3 shows multi-account devices are already reachable through sign-out. | Require `existing.owner_id === deps.userId` / `user_id === deps.userId` in every mutation guard. |
| Low | apps/web/src/lib/sync/pull.ts:100-106 vs crates/db/src/queries/sync_apply.rs:327-336 | LWW tie precision differs: the server compares microsecond timestamptz while the client `rank()` truncates to milliseconds, so sub-millisecond distinct rows could resolve differently on each side. Theoretical today (all client stamps are `toISOString()` ms-precision) but latent. | Normalize timestamps to one precision at the pull boundary, or document the millisecond rule in the sync contract. |
| Low | AGENTS.md:57; docs/architecture.md:77; docs/tests.md:3 | Docs drift: AGENTS.md still says `render.yaml` uses "pre-deploy `waveform-api migrate`" (dropped for the free tier in `6e73685`, render.yaml:11-16); architecture.md lists `scripts/` (invite CLI, restore drill) which does not exist and whose invite CLI is moot under the email + password ADR; docs/tests.md is stale again (no bucket 3a/3b suites; current totals are 172 Rust and 468 JS). | Refresh all three at the next docs pass. |
| Low | .github/workflows/{ci,pages}.yml; apps/web/index.html | Carried hardening items still open: Actions are tag-pinned rather than SHA-pinned, there is no CSP or `_headers` for the Pages deploy and fonts load from Google third-party, and `client_ops_processed_at_idx` (0003:230) exists with no retention prune job. | One hardening pass: SHA-pin actions, add a `_headers` with CSP and self-host fonts, add the client_ops prune (30-day window) and a scheduled `purge_expired_sessions`. |
| Info | crates/analytics/src | The analytics crate (weekly volume) is built and tested but consumed by nothing; it is the Phase 3 boards engine. `routes/{workout,activity,social}.rs` are empty namespace stubs. | Wire into Phase 3 read endpoints; keep the stubs until then. |
| Info | migrations/0001_init.sql (otp_codes:40-57, invites, groups/group_members, challenges); models.rs:36 | Retired-but-live schema: OTP, invite, group, and challenge tables and `users.github_id` persist per the 2026-10-15 ADR ("dead until a later decision revives them"), and Mailpit plus `infra/railway.toml` are inert residue. | Phase 4 cleanup ADR: drop or formally sunset the unused tables and the Mailpit service. |
| Info | crates/db/tests (1 empty integration target, 4 zero-test bins in the gate run); apps/web/src/lib/sync/engine.test.ts:217 | Minor coverage texture: the coalescing test asserts the follow-up round but not that it runs under the newest joined reason (3b Info, still open); no cross-boundary test drives the client engine against the real axum routes (each side is fenced by generated types and rulesParity instead). | Optional: one contract test pairing `drainOutbox`/`pullAll` stubs against `routes::router` over tower::oneshot. |

### Verification Checklist

- [x] All checks passed (9 checks: 9 PASS; four Medium and three Low findings recorded above)
- [x] No critical issues found (no Critical)
- [x] Code follows project conventions
- [x] No em dashes, double hyphens, or dash equivalents; use proper punctuation
- [x] Phase code integrates cleanly with prior phases (every 3b Low fix verified landed: engine round-floor re-arm, drain deferred filtering, clear-override re-evaluation, adoption idempotence guard; 1d parse Medium fixed by `objectRows`)
- [x] Command gates executed in this review environment (172 Rust tests with live Postgres, 468 JS tests, clippy/fmt clean, export_ts drift zero, build green)

### Recurring patterns for other agents

- Timestamp-ordered pull cursors are only as correct as their ordering key: a cursor ordered by transaction-start time against commit-ordered visibility has a skip window. Any future cursor work should either order by commit order or keep the periodic full re-pull safety net that makes cursors an optimization only.
- The "timeout" failure kind is dead code until something aborts: every new network client needs a real AbortController timeout for the retry and backoff machinery to mean anything.
- Device-level ownership state (`adopted_user_id`, row owner stamps) must be checked against the SIGNING-IN user, not merely against presence, whenever destructive or re-owning flows run; "first sign-in" is not "first user on this device".
- Wire-contract mismatches surface as quarantine noise, not errors: when one side of a contract (the server's catalog Forbidden here) has a defined answer, the other side (import op queuing, drain handling) must implement its half in the same change, or the queue fills with terminally rejected ops.

### Owner clarification (2026-10-16)

The product owner confirmed that a device may be shared or handed down, so more than one account may
sign in on the same device over its lifetime. This elevates two findings above from Low to
**Medium, fix before multi-device sync widens**:

- Finding 3 (shared-device adoption leak): `needsAdoption` keys only on the signed-in user id, so a
  second account is offered the previous account's log with "Upload my existing local data" as the
  default, which re-owns every row (including owner-private `body_stats`) into the new account, and
  "Start empty" destroys the prior account's local copy. Must detect a foreign local owner and
  refuse the upload path.
- Finding 5 (repos compare owner to null only): a repo bound to one user can mutate another user's
  rows in the same IndexedDB, reachable through sign-out on a shared device. Guards must compare
  against `deps.userId`.

## 2026-10-16 - Sync poll trigger (code review)

Verdict: PASS WITH ISSUES (static analysis only: this review environment has no shell tool, so
`git diff` and `npx pnpm@10 --filter @waveform/web test` could NOT run; both files were read in
full and the timer and state machine traced by hand; four Low findings and two Info, none
blocking)

Scope: the uncommitted periodic poll trigger for the client sync engine: `apps/web/src/lib/sync/engine.ts`
(SYNC_POLL_MS 30000 at 75, `pollMs` dep at 104, "poll" reason at 49, `clearPoll` at 258-263,
`schedulePoll` at 306-315, halt clears the poll at 358, start arms it at 521, header docs at 13-19)
and `apps/web/src/lib/sync/engine.test.ts` (fakeTimers poll tagging at 61-119, the new `pendingSync()`
probe at 90-95, harness `pollMs`/`api` options at 152-155 and 183-194, six new "createSyncEngine
poll" tests at 364-479). Scope taken from the task brief; without git the literal diff could not
be confirmed. This review changed no production code.

### Check Results

| Check | Verdict | Details |
|-------|---------|---------|
| 1. Timer lifecycle (leak, double-arm, dropped ticks, clear paths) | PASS | `schedulePoll` (engine.ts:306-315) clears before arming and nulls the handle at tick start, so exactly one poll timer exists per running engine; the tick re-arms itself after the guard, so a tick that skips the run still re-arms and no cadence slot is dropped. `halt` clears the poll (358) and both `stop()` (526-532) and the auth-expired path (375-379) route through halt; `start()` arms only on the `!running` transition (511-522) and `schedulePoll` itself clears first, so restart cannot double-arm. One theoretical leak: the re-arm at 313 is unconditional, so a halt landing inside the tick's synchronous span (the `setStatus("syncing")` at 420 runs SolidJS reactions synchronously) would resurrect a timer that re-arms forever after stop; unreachable in today's appData wiring (no status reaction calls `stop()`), one-line fix row 1. |
| 2. Backoff and auth-expired interplay | PASS | Traced every state. `idle` implies no backoff pending: the only path to idle clears backoff (368-373), and every failure parks status on "offline"/"error" (381) so the tick guard `status() === "idle"` (310) skips and only the backoff chain retries (275-291). "syncing" and "waking" also skip (test engine.test.ts:392-426 pins both). Auth-expired halts (375-379), which clears the poll timer (358), so nothing polls after a 401 (tests at 553-590 assert `pending()` empty, poll included). The poll never resets `backoffAttempt` (only "online" and success do) and can never start a run while a retry is armed. |
| 3. Poll plus visibilitychange double-fire | PASS | A poll tick and a visibilitychange landing together collapse through single flight: the first caller starts the chain, the second joins `currentRun` and sets `rerunQueued` (462-469), costing one shared run plus exactly one follow-up round, the same burst semantics pinned by engine.test.ts:237-271. The tick guard also refuses to join a run whose status is "syncing"/"waking", so a slow run does not accumulate poll reruns. No stampede. Row 6 notes the millisecond-scale join window at the end of a run. |
| 4. Signed out or `api() === null` | PASS | `performRun` early-returns after `recompute()` (404-407), the tick still re-arms (313) at the fixed pollMs cadence, so there is no spin, loop, or status churn: worst case is two IndexedDB reads every 30 seconds. `requestSync` resolves without running (458-460 covers the halted case). appData stops the engine on sign-out (appData.tsx:269-272), so a live-but-clientless engine is transient. Untested path, row 3. |
| 5. Test quality of the six new tests | PASS with issues | All six prove their claims: "re-syncs on its own cadence" (365-375) and "re-arms after every tick" (377-390) pin the cadence and the self-reschedule; "does not sync while in flight" (392-426) gates the push, advances through both "syncing" and "waking" ticks, and holds pushes at 1; "stays parked while offline" (428-445) would see `runs()` climb past `runsSoFar` if the guard were bypassed (the stub records the exercises pull before rejecting, engine.test.ts:176-181, so a bypass run is observable); "skips while hidden" (447-464) proves the hidden skip and the visible fire; "cancels on stop" (466-478) asserts `pending()` empty, poll included, then advances three intervals with no run. `pendingSync()` is sound for today's delays but tags poll timers by `ms === pollMs` (73-75, 90-95), conflating delay with purpose: a future pollMs of 1000 or 2000 would silently hide real backoff, debounce, or waking timers from the probe (row 2, latent and real). Rows 4 and 5 are cheap strengthenings. |
| 6. Regression and public shape | PASS | `SyncEngine` is unchanged (119-135); additions are strictly additive (`pollMs?` dep at 104, `SYNC_POLL_MS` at 75, "poll" in `SyncReason` at 49). Grep shows `SyncReason` is consumed only inside engine.ts, so no exhaustive switch breaks. Existing tests keep every prior assertion through `pendingSync()` (356, 488, 501-534, 550, 604, 631) and use `pending()` where poll inclusion is the point (473, 568, 589). Header docs updated to match (13-19). No em dashes or double hyphens in either file (grep; the one hit is "back-to-back"). |

### Findings (FAIL items and non-blocking)

| Severity | File:Line | Issue | Fix |
|----------|-----------|-------|-----|
| Low | apps/web/src/lib/sync/engine.ts:313 (with 420) | The tick re-arms unconditionally ("re-arms unconditionally" is even the header claim at 303-304). If `halt()` runs inside the tick's synchronous span, reachable only through a SolidJS reaction to `setStatus("syncing")` at 420 calling `stop()`, the re-arm at 313 creates a timer while `running` is false; that tick skips and re-arms again, so one perpetual no-op timer survives stop() forever. Unreachable in the current appData wiring, but it is exactly the leak class check 1 asks about. | Gate the re-arm on liveness: `if (running) schedulePoll();`, or early-return at the top of `schedulePoll` when `!running`. Amend the header sentence to "re-arms on every tick while the engine runs". |
| Low | apps/web/src/lib/sync/engine.test.ts:73-75, 90-95 | `pendingSync()` identifies poll timers by `ms === pollMs`, conflating delay value with purpose. A future test with `pollMs: 1000` or `pollMs: 2000` would mis-tag backoff, debounce, or waking timers as poll and hide them from the probe, so assertions like `toEqual([1000])` would lie or fail confusingly. No current test collides (pollMs is 100 or 30000; backoff ladder 1000..300000; debounce and waking 2000), so nothing is wrong today; the risk is latent and real. | Tag by purpose, not delay: have `fakeTimers` throw when `pollMs` equals any configured sync delay, or split timer injection per purpose (a `pollTimeoutFn` seam), or at minimum assert non-collision in `harness()` and document the invariant. |
| Low | apps/web/src/lib/sync/engine.test.ts:364-479 | Two gaps in the poll suite: no test drives a poll tick with `api() === null` (the `performRun` early-return at engine.ts:404-407 under reason "poll"), and no test shows a poll tick plus a visibilitychange in the same window collapsing to one shared run plus one reround (the generic burst test covers the mechanics but not this pairing). | Add `harness({ api: null })` + `advance(SYNC_POLL_MS)` asserting runs 0, status "idle", and no non-poll timers; optionally fire `visibility.fire("visibilitychange")` with one poll tick and assert exactly two runs. |
| Low | apps/web/src/lib/sync/engine.test.ts:428-445 | "stays parked while offline" proves no new run and a stable status but never pins that the backoff timer survives the ticks untouched. A regression that clobbers the retry while skipping the run would pass. | After the two advances, add `expect(h.timers.pendingSync()).toEqual([1000])`, and optionally advance 1000 to observe the one backoff retry. |
| Info | apps/web/src/lib/sync/engine.test.ts:204-205 (relied on at 436-443) | `runs()` counts runs that reached pullAll's exercises request including those failing there (the stub records the entity before invoking the handler at 176-181, which the offline test depends on). The comment "Completed non-aborted runs" overstates this. | Reword to "runs that reached pullAll, success or failure: every run asks for exercises first". |
| Info | apps/web/src/lib/sync/engine.ts:310, 455, 462-469 | A tick landing while status is "idle" but a chain is still inside its post-outcome `recompute()` tail joins that chain and queues one extra full round that mostly duplicates the round just finished. Bounded by single flight and rare (a milliseconds-scale window every 30 s), so acceptable as is. | Optional: ignore a "poll" join while the chain is in its tail, or leave it and rely on the round cap. |

### Verification Checklist

- [x] All six requested checks PASS; findings above are four Low and two Info, no FAIL rows
- [ ] Command gates NOT RUN: no shell tool in this review environment, so `git diff` and `npx pnpm@10 --filter @waveform/web test` could not execute; static analysis of both full files plus grep cross-checks only. Recommend a green `pnpm test --filter @waveform/web` before merge.
- [x] No critical issues found (no Critical, High, or Medium)
- [x] Code follows project conventions (strict TS, no `any`, SCREAMING_SNAKE consts, snake_case locals, PascalCase types, K&R braces)
- [x] No em dashes, double hyphens, or dash equivalents; use proper punctuation (grep clean in both files; the single hit is the hyphenated "back-to-back")
- [x] Phase code integrates cleanly with prior phases (poll is additive; single flight, backoff, halt semantics, and the public SyncEngine shape unchanged; existing tests preserved through the `pendingSync()` probe)

### Recurring patterns for other agents

- A self-rescheduling timer must re-arm under the same liveness condition as its work. Gate the re-arm on the running flag (or re-check inside the scheduler) so a halt landing mid-tick cannot resurrect the timer after stop.
- Test fakes that classify timers by delay value conflate purpose with duration. Tag timers by call site or purpose, or fail fast on collision, so a later configuration change cannot silently hide a timer from a probe.
- A periodic trigger that must not fight backoff should gate on the state signal (status "idle"), not on absence of work, and the halt path must own the timer cleanup. Verify with one test per parked state: offline, error, waking, hidden, auth-expired.

## 2026-10-16 - Tier 1.1-1.2 correctness (code review)

Verdict: PASS WITH ISSUES (static analysis only: no shell tool in this review environment, so
`git diff` and the test runner could NOT run; every listed file was read in full and the timeout,
guard, and drain paths traced by hand; one Medium, six Low, three Info, no FAIL rows)

Scope: the uncommitted Tier 1.1 and 1.2 changes in apps/web: 1.1a per-request AbortController
timeout in `src/lib/api.ts` (REQUEST_TIMEOUT_MS at 63, `timeoutMs` at 147 and 194, timer at 218,
finally clear at 263-265, body-abort classification at 252-261); 1.1b foreign-owner guards in
`src/db/repos/exercises.ts` (89-100, 123-134), `workouts.ts` (115-154 and every mutating path),
`activities.ts` (194-199, 253-258), `body.ts` (76-81, 169-174); 1.2a catalog op hygiene via the new
`src/db/serverOwned.ts` consumed by `src/lib/backupImport.ts` (472, 611); 1.2b drain clean-drop and
once-per-drain rejection in `src/lib/sync/drain.ts` (144-155), with new `src/lib/api.test.ts` and
new/updated tests in `db/repos.test.ts`, `lib/backupImport.test.ts`, `lib/sync/drain.test.ts`,
`lib/sync/engine.test.ts`. No production code changed by this review.

### Check Results

| Check | Verdict | Details |
|-------|---------|---------|
| 1. Timeout arming and clearing on every path | PASS with issues | The timer (api.ts:218) is armed after payload serialization (a JSON.stringify throw at 208 cannot leak it) and cleared in `finally` (263-265), which unwinds through every path: success (250-251), 204 (247-249), 401 (228-235, including an `onAuthExpired` that throws), non-2xx (237-244), transport abort (224-226), unreadable body (250-262). The controller is request-local (210) and nothing retains it after `send` settles, so no spurious abort can reach a later request; api.test.ts:191-226 pins exactly that (two requests, `clearTimeout` per settle, both signals still un-aborted well past the deadline). A hang aborts and classifies "timeout" (api.test.ts:159-189). Two nits: the success-body `signal.aborted` branch (255) is sound (only the local timer aborts this controller) but routes through `transportError` (176-189), which re-derives "timeout" from the cause's error name; throwing `ApiError("timeout", ...)` directly would be exact. And an abort during `readEnvelope`'s body read on error paths (158-174) is swallowed into a null envelope, so such a failure keeps its "client"/"server"/"auth-expired" kind instead of "timeout". Both Low; behaviorally inert today since the drain and engine map "timeout" and "offline" identically (drain.ts:81, engine outcomeForFailure). |
| 2. Owner guards cover every mutation chain | PASS | Traced all chains. Creates stamp `deps.userId` (exercises.ts:65, workouts.ts:193, activities.ts:152, body.ts:104) so no create path can produce or touch a foreign row. Update and delete paths guard before any write: exercises 89-100 and 123-134; workouts update (220), remove (252), addEntry (360-364), updateEntry (385), removeEntry (416), addSet (463-467), updateSet (489), removeSet (524) via `assertSessionOwned`/`assertEntryOwned`/`assertSetOwned` (123-154) which walk set to entry to session; activities 194-199 and 253-258 before both the tombstone and the climb_sends delete; body 76-81 and 169-174. Cascades in `remove`/`removeEntry` only touch children of the already-guarded session or entry, so no descendant write can reach a foreign row. Every guard runs inside the same Dexie transaction it protects, and every table a guard reads is in that transaction's scope (checked each: workouts transactions include `workout_sessions` and `exercise_entries` where the guards read them), so the added scope is correct and the check and write are race-free. `LocalValidationError` is the established type (validation.ts:50) and is thrown consistently everywhere; `lib/errors.ts:15-17` surfaces its issues to the UI, so the refusal messages reach the user. |
| 3. Catalog op hygiene (import) | PASS with issues | `mergeById` writes the row before the predicate (backupImport.ts:470-474) and `runReplace` puts before the predicate (609-613), so catalog rows land locally with zero ops in both modes; opsQueued counts confirm (merge test backupImport.test.ts:481-514 with two exercises and one op, replace test 908-935 with `opsQueued` 0). A custom exercise can never be misclassified: `isServerOwnedRow` (serverOwned.ts:18-26) requires `entity === "exercises"` and a strict `owner_id === null`, and custom rows always carry a string owner (exercises.ts:65). Placement in `db/` is sensible since both `lib/backupImport` and `lib/sync/drain` consume it. One gap: the parse validates exercises rows only with `baseRowIssues` (backupImport.ts:320-323), so `owner_id` shape is never checked; a malformed row with a missing `owner_id` classifies as user-owned, queues an op, and eventually quarantines after three rejections. Low. |
| 4. Drain clean-drop, once-per-drain rejection, termination | PASS with issues | The rejected branch (drain.ts:144-155) clean-drops only a server-owned catalog op (acked, no `markOutboxFailed`, no quarantine) and otherwise records exactly one failure and defers. The module contract holds: `deferred` only grows within a drain (100, 135, 153, 157), batch selection filters only deferred ids (107), and each loop iteration either removes rows or grows `deferred`, so the loop terminates and every queued op earns at least one attempt per drain. A catalog rejection cannot suppress a non-catalog result: results are keyed by op_id (126-129) and the predicate is entity- and field-specific. Quarantine at 3 across separate drains holds (one `markOutboxFailed` per drain, outbox.ts:75-81 thresholds at 3) and is pinned by drain.test.ts:163-200. Count distortion: the engine consumes only `drained.aborted` (engine.ts:440) and computes pending/quarantined from local outbox state, so counting clean drops as `acked` distorts nothing user-visible; only the `DrainResult.acked` doc (drain.ts:53-54, "after an acked status") is now stale. Low. |
| 5. Test quality | PASS with issues | The new tests prove their claims: timeout classification and default deadline (api.test.ts:159-189), timer clearing and no spurious abort (191-226), per-store foreign rejection with row equality and `outbox.count()` 0 plus create-under-foreign-parent cases (repos.test.ts:591-786), zero catalog ops on replace with the row restored (backupImport.test.ts:908-935), custom-exercise op preserved on merge (516-540), one-attempt-per-drain with call counting and cross-drain quarantine with `attempts`/`quarantined` assertions (drain.test.ts:163-200), clean drop (202-224), and deferral past a rejected op (226-254). The adapted engine test (engine.test.ts:699-729) seeds the post-three-drain quarantined state instead of driving three runs and explains why in a comment; the end-to-end drive-to-quarantine lives in drain.test.ts, so nothing was weakened, only relocated. Gaps: no test for the success-body abort branch (api.ts:255), no proof that `timeoutMs` actually shortens the deadline (the override is used only in the clearing test), no `clearTimeout` assertion on error paths, and no direct unit test of `isServerOwnedRow` (a non-exercises entity carrying `owner_id: null` is untested). Without git the "adapted" set could not be diffed, so this is read-based only. |
| 6. Conventions and integration | PASS | Strict TS with no `any`, SCREAMING_SNAKE for `REQUEST_TIMEOUT_MS`, snake_case row fields, PascalCase types, K&R with 4-space indent. No em dashes or double hyphens in any changed file (grep). All changes are additive at the module boundaries; `SyncEngine`, `ApiClient`, and repo signatures are unchanged except the added optional `timeoutMs`. One style nit: workouts.ts:418-435 (the `removeEntry` cascade block) lost its indentation level relative to its enclosing transaction body. |

### Findings (FAIL items and non-blocking)

| Severity | File:Line | Issue | Fix |
|----------|-----------|-------|-----|
| Medium | apps/web/src/db/repos/body.ts:73-81 | The upsert's live-row lookup (`forDate.find((row) => row.deleted_at === null)`) is not owner-scoped. When two live rows share a `local_date` (reachable today by merging a foreign backup under another account), `find` picks whichever row Dexie returns first: it can throw "belongs to another account" even though the current user's own live row exists for that date, or silently pick the right one. Behavior is arbitrary per id order. | Prefer the current user's row: `forDate.find((row) => row.deleted_at === null && row.user_id === deps.userId)`, and apply the foreign-only guard (or the recommended create) only when no own live row exists. |
| Low | apps/web/src/lib/api.ts:252-261 | The body-read abort branch classifies via `transportError(cause)`, re-deriving "timeout" from the cause's error name. An abort surfacing under any other name would report "offline". Sound in principle (only the local timer aborts this controller) but inexact and untested. | In the `controller.signal.aborted` branch throw `new ApiError("timeout", "The request timed out.", { cause })` directly, and add a fake-timer test where the body read alone hangs past the deadline. |
| Low | apps/web/src/lib/api.test.ts | Three gaps around 1.1a: no test for the success-body abort branch (api.ts:255), no test that `timeoutMs` shortens the deadline (the override is exercised only in the clearing test), and no `clearTimeout` assertion on the 401 / non-2xx / unreadable-body paths. | Add: a body that never settles with `advanceTimersByTimeAsync(timeoutMs)` asserting kind "timeout"; a `timeoutMs: 1000` hang asserting abort at 1000; a `clearSpy` count on one error-path request. |
| Low | apps/web/src/lib/backupImport.ts:320-323 (with db/serverOwned.ts:25) | Exercises rows are checked only by `baseRowIssues`; `owner_id` shape (string or null) is never validated. A row with a missing `owner_id` fails `=== null`, classifies as user-owned, queues an op, and lands in quarantine after three rejections. Import is otherwise all-or-nothing on shape, so this is the one field the parse lets through unchecked. | Add an `owner_id` shape check to the exercises row loop (`string or null`), symmetric with `isServerOwnedRow`. |
| Low | apps/web/src/lib/sync/drain.ts:53-54 | `DrainResult.acked`'s doc ("Ops removed from the outbox after an acked status") is stale: clean-dropped catalog rejections increment `acked` on a "rejected" status. No engine surface consumes the count (engine.ts:432-441 reads only `aborted`), so nothing distorts, but the contract text now lies. | Reword to "ops removed from the outbox: acked statuses plus clean-dropped catalog rejections", or count drops in their own field. |
| Low | apps/web/src/db/repos/workouts.ts:116-121 | `foreignAccountError` says "this row belongs to another account" while exercises (99), activities (196), and body (78) use specific nouns. The generic wording reaches the UI status region through `lib/errors.ts` and reads vaguer than its siblings. | Use "this workout/entry/set belongs to another account" per call site, matching the other repos. |
| Low | apps/web/src/db/repos/workouts.ts:418-435 | The `removeEntry` cascade block sits one indent level outside its enclosing transaction body. Cosmetic, but it will churn `pnpm lint`/format gates and obscures the guard placement at 416. | Re-indent the block to match `remove` (253-281). |
| Info | apps/web/src/lib/api.ts:228-244 (readEnvelope 158-174) | On the 401 and non-2xx paths an abort during the error body's read is swallowed into a null envelope, so the failure keeps its "auth-expired"/"client"/"server" kind rather than becoming "timeout". Acceptable (a response did arrive; the message falls back), and inert today because drain and engine map timeout and offline identically. | Optional: mirror the `signal.aborted` check in `readEnvelope`, or note the intentional difference in the header comment. |
| Info | apps/web/src/db/repos/body.ts:166-168, activities.ts:250-252 | `remove` on an already-tombstoned foreign row returns `[]` before the owner check, so a caller probing ownership sees success for a foreign id. No write happens either way, so this is semantics, not safety. | Optional: check ownership before the tombstone short-circuit, or document the "already gone wins" precedence. |
| Info | apps/web/src/db/repos/exercises.ts:60-79 | Pre-existing and out of scope, but `createCustom` performs no field validation (name, muscle_group, equipment) while every other create path calls its assert guard. Malformed custom rows reach the outbox and the server. | Add an `assertValidExercise` guard for symmetry with the other repos. |

### Recommendation on the flagged behavior change (body upsert throws on a foreign live row)

Keep the throw for Tier 1. It preserves the documented "exactly one live row per local_date"
invariant (body.ts:4-8), and the read paths (`listRange` 128-141, `listAll` 143-156) are not
user-scoped, so create-instead would double-plot dates in bodyChart and weekStats and corrupt
"latest weight" picks with silent mixed-account data. The refusal is also user-legible: the
`LocalValidationError` issues surface in the status region (lib/errors.ts:15-17). Create-instead is
the right end state only when paired with (a) the own-row-first lookup from the Medium finding
above and (b) user-scoped reads across the repos; until then a loud refusal beats a quiet chart
corruption. Also worth a later pass: refuse to import a backup whose rows carry a foreign
`user_id`/`owner_id`, which is the realistic source of foreign rows on a device and would make this
guard unreachable in practice.

### Verification Checklist

- [x] All six requested checks PASS with issues; findings above are one Medium, six Low, three Info, no FAIL rows
- [ ] Command gates NOT RUN: no shell tool in this review environment, so `git diff` and the test runner could not execute; all listed files read in full and traced by hand. Recommend a green `pnpm test --filter @waveform/web` and `pnpm lint` before merge.
- [x] No critical issues found (no Critical or High)
- [x] Code follows project conventions (strict TS, no `any`, SCREAMING_SNAKE const, snake_case locals, PascalCase types, K&R braces; one indentation nit at workouts.ts:418-435)
- [x] No em dashes, double hyphens, or dash equivalents; use proper punctuation (grep clean across apps/web/src)
- [x] Phase code integrates cleanly with prior phases (guards are additive inside existing transactions, the timeout is additive to `ApiClientOptions`, the drain change is internal to the result loop, and the engine consumes only `aborted`, which is unchanged)

### Recurring patterns for other agents

- A request deadline must clear in `finally`, arm only after body serialization, and classify aborts
  from request-local state (a per-request AbortController), never from shared flags; when the abort
  source is unambiguous, throw the specific error directly instead of re-deriving the kind from the
  cause's error name.
- Ownership guards belong inside the transaction they protect and before the first write, and every
  table the guard reads must be in that transaction's scope. Check all ancestor chains for create
  paths too: stamping the owner on create is the guard for creates.
- A lookup keyed by a shared natural key (here `local_date`) must filter by owner before it finds,
  or a foreign row can shadow the caller's own row and turn a guard into a spurious refusal.
- A "clean drop" of server-owned rows needs one shared predicate used by every producer and
  consumer (import, drain), strict about the owned marker (`=== null`, not falsy), plus parse-time
  validation of that marker so malformed rows cannot pick their own classification.
- When a retry policy changes (rejected ops deferred to once per drain), pin both invariants
  separately: at-least-once per drain with call counting, and quarantine across drains with
  `attempts` assertions. If an adapted test must seed the end state instead of driving it, say why
  in a comment and keep the end-to-end drive in one suite.

## 2026-10-16 - Tier 1.3-1.4 shared-device ownership and cursor (code review)

**Scope**: uncommitted Tier 1 phases 1.3 and 1.4. `apps/web/src/lib/sync/ownership.ts` and
`ownership.test.ts` (new), `adoption.ts` and `adoption.test.ts`, `appData.tsx`, `session.ts` and
`session.test.ts`, `sync/meta.ts`, `sync/pull.ts` and `pull.test.ts`, `routes/Account.tsx`, and the
docs updates. Files read in full and traced by hand; no shell in this environment, so `git diff`
and the test runner were not executed. Recommend a green `pnpm test --filter @waveform/web`,
`pnpm lint`, and `cargo test export_ts` (unchanged here) before merge.

**Verdict: FAIL** (1 Critical, 1 High, 4 Medium, 3 Low). The one-transaction wipe, the
per-source classification, and the pull safety net are largely sound and well tested, but
sign-out by a non-owner account on a foreign device deletes the adoption marker while keeping
the foreign rows, which re-opens the exact cross-account adoption hole phase 1.3 exists to
close. `ownership.test.ts:439-456` currently pins that unsafe behavior.

### Check Results

| Check | Verdict | Details |
|-------|---------|---------|
| 1. Wipe correctness (isolation, orphans, one transaction, keep list, child-op scoping) | PASS with issues | One rw transaction over every touched table (ownership.ts:238-251), direct table deletes queue no ops, keep list correct (`local_profile`, `api_base_url`, tested at ownership.test.ts:433-436). Cascade is complete for live and tombstoned parents (deletes are soft, so parents are present in `sessionIdSet`/`entryIdSet`). FAILs on the unconditional marker delete (F1) and cross-account scratch clears (F4). |
| 2. classifyOwnership fresh/mine/foreign | FAIL | The normal first-sign-in upload path is safe (adoption.test.ts:280-288 plus one mine case per owner source), but a genuinely foreign log is misclassified as "mine" after the F1 marker loss, and backup imports can misclassify in both directions (F1, F6). |
| 3. Sign-out ordering and failure modes | FAIL | Server failure and wipe-throw paths are correct and tested (session.test.ts:183-226), but `engine.stop()` does not cancel an in-flight run and `account.logout` does not await one, so a pull mid-flight can repopulate wiped rows (F2). Fallback failure text also lies (F7). |
| 4. ForeignOwnerError enforcement | PASS with issues | Thrown as the first step of `adoptLocalUser`'s transaction before any write (adoption.ts:118-123), tested with untouched-state assertions (adoption.test.ts:272-296); UI is presentational. Softened by the evaluateAuth fail-open (F5) and by ordinary screens still writing through repos bound to the foreign id (F5). |
| 5. pullAll safety net | PASS with issues | Cursor clear then null-cursor walk re-delivers everything; LWW tie-keep is idempotent (pull.test.ts:324-353); stamp only on complete (pull.test.ts:355-376). An aborted due run re-clears cursors on every attempt (F3); clock step-back can delay the interval indefinitely (F8). |
| 6. Test quality | PASS with issues | All eight named claims are covered except the two that matter most for deletion safety: the cross-account sign-out sequence (F1) and an in-flight run during wipe (F2). The suite actively asserts the F1 bug. |

### Findings

| Severity | File:Line | Issue | Fix |
|----------|-----------|-------|-----|
| Critical | ownership.ts:324, ownership.ts:195-197, Account.tsx:449, appData.tsx:248-254 | `wipeAccountDataFromDevice` deletes `adopted_user_id` unconditionally, even when the marker names a different account. On a foreign device, ForeignOwnerPanel's Sign Out calls `logout` for the signed-in account (which owns no rows), so the wipe removes nothing of the foreign log but destroys its claim marker (and cursors, conflict log, all drafts). With the marker gone, `classifyOwnership` falls back to trusting `local_profile.id` (which adoption re-keyed to the foreign account's id) as "this device's own", so the next sign-in by ANYONE classifies the foreign log as "mine" and the first-sign-in panel offers "Upload my existing local data", silently rebasing and publishing one account's log under another. The ADR trade-off ("harmless because its rows were wiped") assumes the wiped rows belong to the marker's account, which is false on this path. ownership.test.ts:455 pins the unsafe clearing. | Delete `ADOPTED_USER_ID_KEY` only when its value is `userId` (a sign-out must never unclaim another account's device). Gate the scratch clears (at least `workout_drafts`) the same way. Change ownership.test.ts:439-456 to expect a foreign marker to survive, and add a regression: seed marker USER_B plus USER_B rows, `wipeAccountDataFromDevice(db, USER_A)`, expect marker kept and `classifyOwnership(db, USER_C)` still foreign. |
| High | engine.ts:530-536, engine.ts:427-450, pull.ts:346-393, appData.tsx:501-514 | `engine.stop()` only bumps the epoch and detaches triggers; the epoch is checked between phases (after compact, drain, pullAll) but never inside `pullAll`'s page loop or `drainOutbox`'s op loop. `account.logout` stops the engine and immediately awaits the server logout round trip plus the wipe, so a pull already in flight keeps merging pages during and after the wipe, re-landing the signed-out account's rows and `pull_cursor:*` keys on a device the wipe just cleaned (violates "sign-out ALWAYS removes the account's synced copy" and, combined with F1's marker loss, feeds the same misclassification hole). | Make `stop()` return a promise that resolves when `currentRun` settles and have `account.logout` await it before the server call; also thread the epoch (or an AbortSignal) into `pullAll`'s per-page loop and `drainOutbox`'s per-op loop so a stop takes effect within one page. |
| Medium | pull.ts:337-344, pull.ts:396-399 | Full re-pull storm: every due attempt clears all cursors and only a complete run stamps `last_full_pull_at`, so a device that repeatedly aborts mid-walk (flaky link, large account, free-tier wakeups) discards cross-run cursor progress on each attempt and re-downloads the full page set forever, potentially never completing (so the safety net "fires" but never lands). | Persist a `full_pull_pending` marker when the cursors are cleared; while it is set, skip the clear and resume the walk from the persisted cursors; remove it when stamping `last_full_pull_at`. |
| Medium | appData.tsx:305-313, appData.tsx:319-324, appData.tsx:361 | Enforcement fail-open and foreign writes: when `classifyOwnership` throws, `evaluateAuth` assumes "mine", binds repos, and starts the engine (a rare but real path onto a foreign device). Separately, on a foreign device the repos stay bound to the profile id (bootstrap), so ordinary screens still edit the foreign log and queue ops stamped with the foreign owner id, which push under that account when its owner signs back in, even though the panel deliberately offers no upload. | On a classification read failure, stop the engine and surface an "unknown" state instead of assuming mine. While `deviceOwnership` is foreign, bind repos to a null/limbo user or make them read-only so no edit can be queued against the foreign log. |
| Medium | ownership.ts:323-326 | Cross-account scratch collateral: a wipe for a user with no data on the device still clears ALL `workout_drafts`, the conflict log, and every cursor. On the foreign sign-out path this destroys another account's in-progress drafts (the sign-out dialog never warns about them). | Scope the scratch clears to a wipe that actually names the device's owner (see F1 fix), or at minimum keep drafts when the marker names a different account. |
| Medium | backupImport.ts:570-574, backupImport.ts:647-648, ownership.ts:195-197 | Classification vs backup restore: merging a backup from another device (rows stamped with that device's pre-account profile id) yields mixed stamps and a "foreign" verdict that locks the user out of their own restored data with no adopt action; conversely replace mode restores the backup's profile row, so someone else's account backup classifies as "mine" and adopts. | Treat an imported backup's stamps as adoptable (re-stamp to the local profile id at import, or record an import provenance marker `classifyOwnership` accepts), and never restore a foreign profile id when a local one exists. |
| Low | Account.tsx:18 | The `SIGNOUT_FAILURE` fallback claims "you are signed out on this device" but it is shown when the local wipe threw, in which case the session is deliberately kept and the user is still signed in. | Split the message: a wipe failure should say the local copy could not be removed and sign-out did not happen, and offer retry. |
| Low | ownership.ts:321-326, ownership.test.ts:436 | `last_synced_at` survives the wipe, so the next account on the device sees the previous account's "Last synced" stamp; `last_full_pull_at` survives too (harmless: cleared cursors force a full walk regardless). | Delete `last_synced_at` with the other per-account bookkeeping, or label it device-scoped in the UI. |
| Low | pull.ts:86-93 | `dueForFullRepull` never fires while the client clock sits behind the stored stamp (a backward step of more than 12h delays the safety net by the skew). | Clamp `now - last` at zero is not enough; also treat `last > now + interval` as due (a stamp from the future is drift). |

### Test gaps that matter for a data-deletion feature

- No test drives the foreign-panel sign-out sequence: marker USER_B plus USER_B rows, wipe as
  USER_A, then `classifyOwnership` for a third account must still be foreign (currently the
  opposite is asserted at ownership.test.ts:455).
- No test pins that an in-flight `pullAll` cannot write after `stop()` plus wipe (an engine test
  with a stub api whose pull resolves after `stop()` would pin F2).
- No test for the aborted-due-run retry loop (two consecutive incomplete due runs both clearing
  cursors), which is the F3 storm behavior.
- Child-op scoping is tested for live parents only; a `set_entries` op whose `exercise_entry_id`
  names a row already gone (hard-purged parent) is out of scope of the delete rules and survives.
  Benign today because deletes are soft tombstones, but worth one test if hard purges ever land.
- Covered well and worth keeping: one mine case per owner source, mixed-stamp foreign, two-user
  wipe isolation for rows and ops, no ops queued, profile and `api_base_url` kept, foreign
  adoption refusal with untouched state, full re-pull tie-keep idempotence, stamp only on
  complete, cursor and page atomicity.

### Verification Checklist

- [ ] All checks passed (2 FAIL, 4 PASS with issues)
- [ ] No critical issues found (1 Critical: F1)
- [x] Code follows project conventions (strict TS, no `any`, SCREAMING_SNAKE consts, snake_case
      locals, PascalCase types, K&R braces, `#pragma`-free module docs in the house style)
- [x] No em dashes, double hyphens, or dash equivalents; use proper punctuation
- [x] Phase code integrates cleanly with prior phases (adoption, engine, and pull extensions are
      additive; `ForeignOwnerError` reuses `LocalValidationError` handling; `meta.ts` keys are
      namespaced and backward compatible)
- [ ] Command gates NOT RUN: no shell in this review environment

### Recurring patterns for other agents

- A device-level marker that gates a trust rule (here `adopted_user_id` gating the
  `local_profile.id` acceptance) must only be removable by the account it names; an
  unconditional delete in a "cleanup everything" path silently downgrades the trust rule.
- "Stop the engine" must mean "the run loop observes the stop within one unit of work"; a phase
  level epoch check does not bound work inside a page or op loop, and any destructive local
  operation that races sync must await the in-flight run, not just detach triggers.
- When a safety net retries from scratch on every aborted attempt, pin the retry storm
  separately from the single-retry behavior the ADR describes; the two differ exactly on flaky
  links where the feature matters most.

## 2026-10-16 - Tier 1.3-1.4 fix verification

Verdict: PASS. All Critical and High findings (F1, F2) are resolved as prescribed; F3, F5
(fail-open half), F6, and F7 are fixed; F4 and F8 are resolved by the F1 gate. Static
verification only, no shell in this environment.

| Fix | Verdict | Details |
|-----|---------|---------|
| F1 wipe gating (Critical) | PASS | `deviceOwnedByUser` (ownership.ts:233-243) gates all six scratch items behind a check computed before any delete (ownership.ts:291, 365-372). Foreign-panel regression test wipes as USER_A on a USER_B device and asserts marker, cursors, conflict log, drafts, last_synced_at survive and `classifyOwnership(db, USER_C)` is still "foreign" (ownership.test.ts:461-488); the old bug-pinning expectation was flipped (ownership.test.ts:441-459). |
| F2 stop/abort (High) | PASS | `stop()` resolves only after `currentRun` settles (engine.ts:541-553); `shouldStop` threaded into drain batches (drain.ts:115) and pull pages (pull.ts:365); `account.logout` awaits it before the server call and wipe (appData.tsx:513-527). engine.test.ts:308-346 pins the wait and the between-page abort; drain.test.ts:138-166 and pull.test.ts:440-461 pin settled work standing. |
| F3 full re-pull flag (Medium) | PASS | `full_pull_pending` set on a due run, walk from null cursor without deleting stored cursors (pull.ts:352-363), pending resumes incrementally, completion stamps and clears (pull.ts:416-421). Tests at pull.test.ts:325-410 cover all three legs. |
| F5 fail-closed unknown (Medium) | PASS with issues | classifyOwnership throw yields "unknown", stops the engine, binds no repos (appData.tsx:308-324). No automated test covers this path. The prior finding's second clause (foreign-device repos stay bound to the profile id) is carried over, unchanged. |
| F6 import re-stamping (Medium) | PASS with issues | Rows re-stamped to the local profile id in both modes, catalog owner_id stays null, op payloads carry the restamped rows (backupImport.ts:543-738); existing local_profile id never replaced (backupImport.ts:717-720). Tests at backupImport.test.ts:559-590, 928-960. Edge: a profile-less device importing a profile-less backup keeps the file's stamps (backupImport.ts:589, 663). |
| F7 sign-out copy (Low) | PASS | SIGNOUT_FAILURE now says the local copy could not be removed and the user is still signed in (Account.tsx:18-19), matching session.test.ts:209-226. |

Residual findings (no Critical or High):

| Severity | File:Line | Issue | Fix |
|----------|-----------|-------|-----|
| Medium (carried) | appData.tsx:373, 330-335 | On a foreign device the repos stay bound to the local_profile id from bootstrap, so ordinary screens can still edit the foreign log and queue ops stamped with the foreign owner id (prior F5 second clause, out of this fix scope). | Unbind repos or make them read-only while deviceOwnership is foreign or unknown. |
| Low | ownership.ts:365-372 | The owned wipe does not delete `FULL_PULL_PENDING_KEY`; behaviorally inert today (cleared cursors force a from-null walk anyway) but stale state. | Delete it in the same `if (owned)` block. |
| Low | appData.tsx:308-324 | The F5 "unknown" path has no automated test (no appData test harness), so fail-closed behavior is proven only by reading. | Extract the decision or add a provider-level test that makes classifyOwnership throw. |
| Low | backupImport.ts:589, 663 | A profile-less device importing a backup with no profile keeps the file's foreign stamps (nothing to re-stamp to), so a later sign-in classifies the restored log foreign and refuses adoption. | Stamp nothing and record an import provenance marker, or document the corner. |
| Low (carried) | pull.ts:86-99 | dueForFullRepull never fires while the client clock sits behind a stored stamp (prior F9, out of this fix scope). | Treat a stamp in the future as due. |
| Low | engine.ts:521 | A re-entrant stop() during requestSync's synchronous prefix resolves before `currentRun` is registered; theoretical (only reachable via a synchronous effect on the status signal) and the logout flow is still safe because the wipe follows the awaited server call. | Set `currentRun` before the chain body runs, or have stop() also consult `running`. |

Regression sweep: no new correctness or data-loss bug found in the wipe (owned deletes cover
exactly the target's rows and scoped child ops), the stop/abort threading (partial drain and
pull results stand, cursors and merges stay atomic per page), the import re-stamping (rows and
op payloads match, catalog rows stay null), or the pending-flag lifecycle.
