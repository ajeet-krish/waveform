# Waveform Reviews

Last updated: 2026-10-14

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
