# Waveform Reviews

Last updated: 2026-10-15

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
