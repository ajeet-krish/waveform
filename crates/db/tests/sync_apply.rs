//! Outbox-apply and pull contract tests against a real Postgres.
//!
//! Mirrors every scenario from `crates/sync/tests/outbox_contract.rs`
//! (user-scoped idempotency, clamped last-write-wins, tombstone deletes,
//! out-of-order delivery, server-stamped pull paging) through the real
//! `waveform-db::queries::apply_op` / `pull_page` engine, plus the
//! database-only rules: session user overriding the payload owner, the
//! server-owned catalog, parent ordering, CHECK rejections that leave no
//! trace, cross-user isolation, tombstones for unknown rows, and rows
//! sharing one `applied_at` across a page boundary.
//!
//! Requirements: a Postgres the test user can `CREATE DATABASE` on, e.g.
//! the compose stack from `infra/docker-compose.yml`:
//!
//! ```text
//! docker compose -f infra/docker-compose.yml up -d postgres
//! WAVEFORM_TEST_DATABASE_URL=postgres://waveform:waveform@localhost:5432/waveform \
//!     cargo test -p waveform-db --test sync_apply
//! ```
//!
//! When the env var is missing every test prints a skip notice and returns,
//! so `cargo test --workspace` stays green without infra. Each test runs in
//! its own throwaway database, dropped on completion.

use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use uuid::Uuid;

use waveform_db::dto::{ApiErrorCode, OpAction, OpResult, OpStatus, PushOp, SyncEntity};
use waveform_db::queries::{apply_op, apply_ops, pull_page, ApplyError, PullParams};

fn base_url() -> Option<String> {
    std::env::var("WAVEFORM_TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()
        .filter(|url| !url.is_empty())
}

fn with_database(base_url: &str, database: &str) -> String {
    let (prefix, _) = base_url
        .rsplit_once('/')
        .expect("url needs a database path");
    format!("{prefix}/{database}")
}

struct ScratchDb {
    pool: PgPool,
    base_url: String,
    name: String,
}

async fn scratch() -> Option<ScratchDb> {
    let base_url = base_url()?;
    let name = format!("waveform_test_{}", Uuid::new_v4().simple());
    let admin = PgPoolOptions::new()
        .max_connections(1)
        .connect(&with_database(&base_url, "postgres"))
        .await
        .expect("connect to maintenance database");
    sqlx::query(&format!(r#"CREATE DATABASE "{name}""#))
        .execute(&admin)
        .await
        .expect("create scratch database");
    admin.close().await;

    let pool = waveform_db::connect(&with_database(&base_url, &name))
        .await
        .expect("connect to scratch database");
    Some(ScratchDb {
        pool,
        base_url,
        name,
    })
}

async fn drop_scratch(db: ScratchDb) {
    let admin = PgPoolOptions::new()
        .max_connections(1)
        .connect(&with_database(&db.base_url, "postgres"))
        .await
        .expect("reconnect to maintenance database");
    sqlx::query(&format!(
        r#"DROP DATABASE IF EXISTS "{}" WITH (FORCE)"#,
        db.name
    ))
    .execute(&admin)
    .await
    .expect("drop scratch database");
    admin.close().await;
}

macro_rules! skip_without_db {
    () => {
        match scratch().await {
            Some(db) => {
                waveform_db::run_migrations(&db.pool)
                    .await
                    .expect("migrations must apply to a fresh database");
                db
            }
            None => {
                eprintln!(
                    "SKIPPED: set WAVEFORM_TEST_DATABASE_URL (or DATABASE_URL) to a Postgres \
                     URL with CREATE DATABASE rights to run sync apply tests"
                );
                return;
            }
        }
    };
}

/// Deterministic op ids: readable in the source, stable per test.
fn op_id(label: &str) -> Uuid {
    Uuid::new_v5(&Uuid::NAMESPACE_URL, label.as_bytes())
}

/// A client timestamp: past relative to the server, so it passes the
/// clamp untouched and drives LWW by itself.
fn at(second: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 14, 12, 0, 0).unwrap() + Duration::seconds(i64::from(second))
}

fn local_date() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 10, 14).expect("valid date")
}

async fn seed_user(pool: &PgPool, label: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users (id, email, display_name, password_hash) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(id)
    .bind(format!("{label}-{}@test.invalid", id.simple()))
    .bind(label)
    .bind("$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g")
    .execute(pool)
    .await
    .expect("insert user");
    id
}

/// A full client row payload for a workout session (the outbox contract:
/// delete and update payloads always carry the full row).
fn workout_payload(id: Uuid, owner: Uuid, notes: &str) -> Value {
    json!({
        "id": id,
        "user_id": owner,
        "local_date": "2026-10-14",
        "started_at": null,
        "duration_min": null,
        "routine_id": null,
        "notes": notes,
        "created_at": "2026-10-14T09:30:00.000Z",
    })
}

fn push_op(
    label: &str,
    entity: SyncEntity,
    action: OpAction,
    payload: Value,
    updated_at: DateTime<Utc>,
) -> PushOp {
    PushOp {
        op_id: op_id(label),
        entity,
        action,
        payload,
        updated_at,
    }
}

fn workout_op(
    label: &str,
    action: OpAction,
    row_id: Uuid,
    owner: Uuid,
    notes: &str,
    updated_at: DateTime<Utc>,
) -> PushOp {
    push_op(
        label,
        SyncEntity::WorkoutSessions,
        action,
        workout_payload(row_id, owner, notes),
        updated_at,
    )
}

async fn apply(pool: &PgPool, user: Uuid, op: &PushOp) -> OpResult {
    apply_op(pool, user, op)
        .await
        .unwrap_or_else(|error| panic!("apply must not abort: {error}"))
}

async fn stored_workout(
    pool: &PgPool,
    id: Uuid,
) -> (String, DateTime<Utc>, Option<DateTime<Utc>>, Uuid) {
    sqlx::query_as(
        "SELECT notes, updated_at, deleted_at, user_id FROM workout_sessions WHERE id = $1",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .expect("select workout")
}

async fn claim_count(pool: &PgPool, id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM client_ops WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("count client_ops")
}

/// Two pushes need distinct server stamps for strict order assertions;
/// the stamp resolution is a microsecond, so a few milliseconds is an
/// eternity in comparison.
fn pace() {
    std::thread::sleep(std::time::Duration::from_millis(5));
}

#[tokio::test]
async fn same_op_applied_twice_is_a_noop_success() {
    let db = skip_without_db!();
    let user = seed_user(&db.pool, "alice").await;
    let row = Uuid::new_v4();
    let op = workout_op("op-1", OpAction::Create, row, user, "v1", at(10));

    assert_eq!(apply(&db.pool, user, &op).await.status, OpStatus::Applied);
    assert_eq!(apply(&db.pool, user, &op).await.status, OpStatus::Duplicate);
    assert_eq!(apply(&db.pool, user, &op).await.status, OpStatus::Duplicate);

    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM workout_sessions WHERE id = $1")
        .bind(row)
        .fetch_one(&db.pool)
        .await
        .expect("count rows");
    assert_eq!(rows, 1, "a replay never duplicates the row");
    assert_eq!(claim_count(&db.pool, op.op_id).await, 1);

    drop_scratch(db).await;
}

#[tokio::test]
async fn a_foreign_op_id_is_rejected_and_never_suppresses_the_owner() {
    let db = skip_without_db!();
    let owner = seed_user(&db.pool, "alice").await;
    let attacker = seed_user(&db.pool, "mallory").await;
    let row = Uuid::new_v4();

    let shared = op_id("op-1");
    let victim = workout_op(
        "op-1",
        OpAction::Update,
        row,
        owner,
        "from-the-owner",
        at(10),
    );
    let replayed = workout_op(
        "op-1",
        OpAction::Update,
        row,
        owner,
        "replayed-by-attacker",
        at(20),
    );

    assert_eq!(
        apply(&db.pool, owner, &victim).await.status,
        OpStatus::Applied
    );
    let outcome = apply_op(&db.pool, attacker, &replayed)
        .await
        .expect_err("a foreign op id must abort");
    assert!(
        matches!(outcome, ApplyError::ForeignOpId),
        "expected ForeignOpId, got {outcome:?}"
    );

    let (notes, ..) = stored_workout(&db.pool, row).await;
    assert_eq!(notes, "from-the-owner", "the stored row must be untouched");
    let stored_owner: Uuid = sqlx::query_scalar("SELECT user_id FROM client_ops WHERE id = $1")
        .bind(shared)
        .fetch_one(&db.pool)
        .await
        .expect("claim owner");
    assert_eq!(
        stored_owner, owner,
        "the claim stays with the rightful owner"
    );

    // The rightful owner keeps replaying as a no-op success.
    assert_eq!(
        apply(&db.pool, owner, &victim).await.status,
        OpStatus::Duplicate
    );

    drop_scratch(db).await;
}

#[tokio::test]
async fn a_pre_claimed_op_id_gets_a_conflict_not_a_silent_noop() {
    // The attack the review found: an attacker who learns a victim op_id
    // pushes it first, so a first-writer-wins rule would let the victim's
    // real push "succeed" as a no-op while the victim's write silently
    // never lands. User-scoped idempotency turns the victim's push into
    // a batch-aborting conflict, and the client recovers by re-issuing
    // the op under a fresh op_id.
    let db = skip_without_db!();
    let victim = seed_user(&db.pool, "alice").await;
    let attacker = seed_user(&db.pool, "mallory").await;
    let victim_row = Uuid::new_v4();
    let attacker_row = Uuid::new_v4();

    let stolen = workout_op(
        "op-stolen",
        OpAction::Create,
        attacker_row,
        attacker,
        "attacker-noise",
        at(10),
    );
    assert_eq!(
        apply(&db.pool, attacker, &stolen).await.status,
        OpStatus::Applied
    );

    let victim_try = workout_op(
        "op-stolen",
        OpAction::Update,
        victim_row,
        victim,
        "the-real-write",
        at(20),
    );
    let outcome = apply_op(&db.pool, victim, &victim_try)
        .await
        .expect_err("stolen op id must abort the batch");
    assert!(matches!(outcome, ApplyError::ForeignOpId));

    // The victim re-issues the op under a fresh op_id and it lands.
    let retry = workout_op(
        "op-1",
        OpAction::Create,
        victim_row,
        victim,
        "the-real-write",
        at(20),
    );
    assert_eq!(
        apply(&db.pool, victim, &retry).await.status,
        OpStatus::Applied
    );
    let (notes, ..) = stored_workout(&db.pool, victim_row).await;
    assert_eq!(notes, "the-real-write");

    drop_scratch(db).await;
}

#[tokio::test]
async fn batch_aborts_on_a_foreign_op_id() {
    let db = skip_without_db!();
    let owner = seed_user(&db.pool, "alice").await;
    let attacker = seed_user(&db.pool, "mallory").await;
    let first_row = Uuid::new_v4();
    let second_row = Uuid::new_v4();
    let attacker_row = Uuid::new_v4();

    // The attacker pre-claims the shared op id under their own account
    // (landing it on their own row), so the owner's batch hits a foreign
    // op id instead of a duplicate.
    let pre_claim = workout_op(
        "batch-2",
        OpAction::Create,
        attacker_row,
        attacker,
        "attacker-noise",
        at(11),
    );
    assert_eq!(
        apply(&db.pool, attacker, &pre_claim).await.status,
        OpStatus::Applied
    );

    let good = workout_op("batch-1", OpAction::Create, first_row, owner, "v1", at(10));
    let foreign = workout_op(
        "batch-2",
        OpAction::Create,
        second_row,
        owner,
        "victim-write",
        at(11),
    );
    let trailing = workout_op(
        "batch-3",
        OpAction::Create,
        second_row,
        owner,
        "never",
        at(12),
    );

    let error = apply_ops(&db.pool, owner, &[good, foreign, trailing])
        .await
        .expect_err("the batch must abort");
    assert!(matches!(error, ApplyError::ForeignOpId));

    // The op before the foreign one committed; the one after never ran.
    let (notes, ..) = stored_workout(&db.pool, first_row).await;
    assert_eq!(notes, "v1");
    let owner_rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM workout_sessions WHERE id = $1 AND user_id = $2")
            .bind(second_row)
            .bind(owner)
            .fetch_one(&db.pool)
            .await
            .expect("count");
    assert_eq!(owner_rows, 0, "the trailing op must not be attempted");
    let claim_owner: Uuid = sqlx::query_scalar("SELECT user_id FROM client_ops WHERE id = $1")
        .bind(op_id("batch-2"))
        .fetch_one(&db.pool)
        .await
        .expect("claim stays with the attacker");
    assert_eq!(claim_owner, attacker);

    drop_scratch(db).await;
}

#[tokio::test]
async fn replaying_an_old_op_cannot_clobber_newer_state() {
    let db = skip_without_db!();
    let user = seed_user(&db.pool, "alice").await;
    let row = Uuid::new_v4();

    assert_eq!(
        apply(
            &db.pool,
            user,
            &workout_op("op-1", OpAction::Update, row, user, "v1", at(10))
        )
        .await
        .status,
        OpStatus::Applied
    );
    assert_eq!(
        apply(
            &db.pool,
            user,
            &workout_op("op-2", OpAction::Update, row, user, "v2", at(20))
        )
        .await
        .status,
        OpStatus::Applied
    );

    // A flaky client re-pushes op-1 after op-2 landed.
    assert_eq!(
        apply(
            &db.pool,
            user,
            &workout_op("op-1", OpAction::Update, row, user, "v1", at(10))
        )
        .await
        .status,
        OpStatus::Duplicate
    );
    let (notes, updated_at, ..) = stored_workout(&db.pool, row).await;
    assert_eq!(notes, "v2");
    assert_eq!(updated_at, at(20));

    drop_scratch(db).await;
}

#[tokio::test]
async fn out_of_order_newer_then_older_discards_the_stale_op() {
    let db = skip_without_db!();
    let user = seed_user(&db.pool, "alice").await;
    let row = Uuid::new_v4();

    assert_eq!(
        apply(
            &db.pool,
            user,
            &workout_op("op-2", OpAction::Update, row, user, "v2", at(20))
        )
        .await
        .status,
        OpStatus::Applied
    );
    let stale = apply(
        &db.pool,
        user,
        &workout_op("op-1", OpAction::Update, row, user, "v1", at(10)),
    )
    .await;
    assert_eq!(stale.status, OpStatus::DiscardedStale);
    assert_eq!(stale.error, None);
    let (notes, ..) = stored_workout(&db.pool, row).await;
    assert_eq!(notes, "v2");
    // The stale op still claimed its id: a replay is a duplicate.
    assert_eq!(
        apply(
            &db.pool,
            user,
            &workout_op("op-1", OpAction::Update, row, user, "v1", at(10))
        )
        .await
        .status,
        OpStatus::Duplicate
    );

    drop_scratch(db).await;
}

#[tokio::test]
async fn out_of_order_older_then_newer_applies_both() {
    let db = skip_without_db!();
    let user = seed_user(&db.pool, "alice").await;
    let row = Uuid::new_v4();

    assert_eq!(
        apply(
            &db.pool,
            user,
            &workout_op("op-1", OpAction::Update, row, user, "v1", at(10))
        )
        .await
        .status,
        OpStatus::Applied
    );
    assert_eq!(
        apply(
            &db.pool,
            user,
            &workout_op("op-2", OpAction::Update, row, user, "v2", at(20))
        )
        .await
        .status,
        OpStatus::Applied
    );
    let (notes, ..) = stored_workout(&db.pool, row).await;
    assert_eq!(notes, "v2");

    drop_scratch(db).await;
}

#[tokio::test]
async fn equal_timestamp_ties_keep_the_stored_row_deterministically() {
    // Two devices edit the same row at the same instant; the first op
    // that reaches the server wins and the loser is discarded on every
    // replay, so both replicas converge after push and pull.
    let db = skip_without_db!();
    let user = seed_user(&db.pool, "alice").await;

    let forward_row = Uuid::new_v4();
    assert_eq!(
        apply(
            &db.pool,
            user,
            &workout_op(
                "op-x",
                OpAction::Update,
                forward_row,
                user,
                "from-x",
                at(30)
            )
        )
        .await
        .status,
        OpStatus::Applied
    );
    let loser = apply(
        &db.pool,
        user,
        &workout_op(
            "op-y",
            OpAction::Update,
            forward_row,
            user,
            "from-y",
            at(30),
        ),
    )
    .await;
    assert_eq!(loser.status, OpStatus::DiscardedStale);
    assert_eq!(
        apply(
            &db.pool,
            user,
            &workout_op(
                "op-y",
                OpAction::Update,
                forward_row,
                user,
                "from-y",
                at(30)
            )
        )
        .await
        .status,
        OpStatus::Duplicate
    );
    let (notes, ..) = stored_workout(&db.pool, forward_row).await;
    assert_eq!(notes, "from-x");

    // The reverse push order flips which payload survives, but the rule
    // stays deterministic: first arrival at equal timestamps wins.
    let reverse_row = Uuid::new_v4();
    assert_eq!(
        apply(
            &db.pool,
            user,
            &workout_op(
                "op-y2",
                OpAction::Update,
                reverse_row,
                user,
                "from-y",
                at(30)
            )
        )
        .await
        .status,
        OpStatus::Applied
    );
    assert_eq!(
        apply(
            &db.pool,
            user,
            &workout_op(
                "op-x2",
                OpAction::Update,
                reverse_row,
                user,
                "from-x",
                at(30)
            )
        )
        .await
        .status,
        OpStatus::DiscardedStale
    );
    let (notes, ..) = stored_workout(&db.pool, reverse_row).await;
    assert_eq!(notes, "from-y");

    drop_scratch(db).await;
}

#[tokio::test]
async fn delete_tombstones_the_row_and_blocks_older_updates() {
    let db = skip_without_db!();
    let user = seed_user(&db.pool, "alice").await;
    let row = Uuid::new_v4();

    assert_eq!(
        apply(
            &db.pool,
            user,
            &workout_op("op-1", OpAction::Update, row, user, "v1", at(10))
        )
        .await
        .status,
        OpStatus::Applied
    );
    assert_eq!(
        apply(
            &db.pool,
            user,
            &workout_op("op-2", OpAction::Update, row, user, "v2", at(20))
        )
        .await
        .status,
        OpStatus::Applied
    );
    // Deletes are soft tombstones carrying the full row.
    let delete = workout_op("op-3", OpAction::Delete, row, user, "v2", at(30));
    assert_eq!(
        apply(&db.pool, user, &delete).await.status,
        OpStatus::Applied
    );

    let (_, updated_at, deleted_at, _) = stored_workout(&db.pool, row).await;
    assert_eq!(deleted_at, Some(at(30)), "delete must set the tombstone");
    assert_eq!(updated_at, at(30), "tombstone advances updated_at");

    // An out-of-order stale update must not resurrect the deleted row
    // or touch its payload.
    let stale = apply(
        &db.pool,
        user,
        &workout_op(
            "op-2b",
            OpAction::Update,
            row,
            user,
            "stale-resurrect",
            at(20),
        ),
    )
    .await;
    assert_eq!(stale.status, OpStatus::DiscardedStale);
    let (notes, _, deleted_at, _) = stored_workout(&db.pool, row).await;
    assert_eq!(deleted_at, Some(at(30)));
    assert_eq!(notes, "v2");

    drop_scratch(db).await;
}

#[tokio::test]
async fn a_newer_update_after_a_delete_resurrects_the_row() {
    // Last-write-wins applies uniformly: deletes are rows with
    // deleted_at set, not special-cased, so a newer update wins the
    // tombstone and clears it.
    let db = skip_without_db!();
    let user = seed_user(&db.pool, "alice").await;
    let row = Uuid::new_v4();

    apply(
        &db.pool,
        user,
        &workout_op("op-1", OpAction::Update, row, user, "v1", at(10)),
    )
    .await;
    apply(
        &db.pool,
        user,
        &workout_op("op-2", OpAction::Delete, row, user, "v1", at(20)),
    )
    .await;
    let resurrect = apply(
        &db.pool,
        user,
        &workout_op("op-3", OpAction::Update, row, user, "v2", at(30)),
    )
    .await;
    assert_eq!(resurrect.status, OpStatus::Applied);

    let (notes, updated_at, deleted_at, _) = stored_workout(&db.pool, row).await;
    assert_eq!(deleted_at, None, "the newer update clears the tombstone");
    assert_eq!(notes, "v2");
    assert_eq!(updated_at, at(30));

    drop_scratch(db).await;
}

#[tokio::test]
async fn out_of_order_batch_lands_on_the_newest_state() {
    // Delivery order [t3, t1, t2] inside one push batch.
    let db = skip_without_db!();
    let user = seed_user(&db.pool, "alice").await;
    let row = Uuid::new_v4();

    let batch = [
        workout_op("op-3", OpAction::Update, row, user, "v3", at(30)),
        workout_op("op-1", OpAction::Update, row, user, "v1", at(10)),
        workout_op("op-2", OpAction::Update, row, user, "v2", at(20)),
    ];
    let results = apply_ops(&db.pool, user, &batch)
        .await
        .expect("batch applies");
    let statuses: Vec<OpStatus> = results.iter().map(|result| result.status).collect();
    assert_eq!(
        statuses,
        vec![
            OpStatus::Applied,
            OpStatus::DiscardedStale,
            OpStatus::DiscardedStale
        ]
    );
    let (notes, ..) = stored_workout(&db.pool, row).await;
    assert_eq!(notes, "v3");

    drop_scratch(db).await;
}

#[tokio::test]
async fn pull_pages_on_server_applied_at_including_tombstones() {
    let db = skip_without_db!();
    let user = seed_user(&db.pool, "alice").await;
    let mut rows = Vec::new();
    for second in [10_u32, 20, 30, 40] {
        let row_id = Uuid::new_v4();
        let op = workout_op(
            &format!("pull-{second}"),
            OpAction::Create,
            row_id,
            user,
            &format!("v{second}"),
            at(second),
        );
        assert_eq!(apply(&db.pool, user, &op).await.status, OpStatus::Applied);
        rows.push(row_id);
        pace();
    }

    // Pull order is the server stamp, agreed with plain SQL.
    let expected: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM workout_sessions WHERE user_id = $1 ORDER BY applied_at, id",
    )
    .bind(user)
    .fetch_all(&db.pool)
    .await
    .expect("expected order");

    let page_one = pull_page(
        &db.pool,
        SyncEntity::WorkoutSessions,
        PullParams {
            user_id: user,
            cursor: None,
            limit: 2,
        },
    )
    .await
    .expect("page one");
    assert_eq!(page_one.rows.len(), 2, "limit is honored");
    let cursor = page_one
        .next_cursor
        .as_deref()
        .expect("a full page hands out a cursor");
    for row in &page_one.rows {
        assert_eq!(row.entity, SyncEntity::WorkoutSessions);
        assert!(
            row.payload.get("applied_at").is_none(),
            "payload is the row minus applied_at"
        );
        assert!(row.payload.get("notes").is_some());
    }

    let page_two = pull_page(
        &db.pool,
        SyncEntity::WorkoutSessions,
        PullParams {
            user_id: user,
            cursor: Some(cursor),
            limit: 2,
        },
    )
    .await
    .expect("page two");
    assert_eq!(page_two.rows.len(), 2);

    let mut seen: Vec<Uuid> = page_one
        .rows
        .iter()
        .map(|row| row.id)
        .chain(page_two.rows.iter().map(|row| row.id))
        .collect();
    seen.sort();
    let mut want = expected.clone();
    want.sort();
    assert_eq!(seen, want, "pages are disjoint and complete");

    // The tip cursor returns nothing.
    let tip = page_two.next_cursor.as_deref().expect("page two is full");
    let page_three = pull_page(
        &db.pool,
        SyncEntity::WorkoutSessions,
        PullParams {
            user_id: user,
            cursor: Some(tip),
            limit: 2,
        },
    )
    .await
    .expect("page three");
    assert!(page_three.rows.is_empty());
    assert!(page_three.next_cursor.is_none());

    // Tombstoned rows are pulled too: the delete restamps applied_at
    // through the trigger, so clients that already had the row learn the
    // removal on their very next pull.
    let victim = expected[2];
    let delete = workout_op(
        "pull-delete",
        OpAction::Delete,
        victim,
        user,
        "gone",
        at(50),
    );
    assert_eq!(
        apply(&db.pool, user, &delete).await.status,
        OpStatus::Applied
    );
    pace();
    let after_delete = pull_page(
        &db.pool,
        SyncEntity::WorkoutSessions,
        PullParams {
            user_id: user,
            cursor: Some(tip),
            limit: 2,
        },
    )
    .await
    .expect("pull after delete");
    assert_eq!(after_delete.rows.len(), 1, "the tombstone crosses the tip");
    assert_eq!(after_delete.rows[0].id, victim);
    assert!(
        after_delete.rows[0]
            .payload
            .get("deleted_at")
            .is_some_and(|v| !v.is_null()),
        "the tombstone is visible in the payload"
    );

    drop_scratch(db).await;
}

#[tokio::test]
async fn rows_sharing_one_applied_at_survive_page_boundaries() {
    // One server transaction stamps several rows with the same
    // applied_at (now() is the transaction time). The id tie-break must
    // still deliver every row even when a page boundary lands between
    // them, which a timestamp-only cursor would silently drop.
    let db = skip_without_db!();
    let user = seed_user(&db.pool, "alice").await;

    let row_a = Uuid::new_v4();
    let row_b = Uuid::new_v4();
    let row_c = Uuid::new_v4();

    let mut tx = db.pool.begin().await.expect("begin shared-stamp tx");
    for (id, notes) in [(row_a, "v1"), (row_b, "v2")] {
        sqlx::query(
            "INSERT INTO workout_sessions (id, user_id, local_date, notes) VALUES ($1, $2, $3, $4)",
        )
        .bind(id)
        .bind(user)
        .bind(local_date())
        .bind(notes)
        .execute(&mut *tx)
        .await
        .expect("insert row in shared transaction");
    }
    tx.commit().await.expect("commit shared-stamp tx");
    pace();
    sqlx::query(
        "INSERT INTO workout_sessions (id, user_id, local_date, notes) VALUES ($1, $2, $3, 'v3')",
    )
    .bind(row_c)
    .bind(user)
    .bind(local_date())
    .execute(&db.pool)
    .await
    .expect("insert later row");

    let (stamp_a, stamp_b): (DateTime<Utc>, DateTime<Utc>) =
        sqlx::query_as("SELECT a.applied_at, b.applied_at FROM workout_sessions a, workout_sessions b WHERE a.id = $1 AND b.id = $2")
            .bind(row_a)
            .bind(row_b)
            .fetch_one(&db.pool)
            .await
            .expect("read stamps");
    assert_eq!(stamp_a, stamp_b, "the shared transaction stamps both rows");

    // Page through with limit 1; the cursor rides on (applied_at, id), so
    // row_b is still delivered after a boundary that lands on row_a.
    let expected: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM workout_sessions WHERE user_id = $1 ORDER BY applied_at, id",
    )
    .bind(user)
    .fetch_all(&db.pool)
    .await
    .expect("expected order");
    assert_eq!(expected.len(), 3);

    let mut cursor: Option<String> = None;
    let mut seen = Vec::new();
    for _ in 0..3 {
        let page = pull_page(
            &db.pool,
            SyncEntity::WorkoutSessions,
            PullParams {
                user_id: user,
                cursor: cursor.as_deref(),
                limit: 1,
            },
        )
        .await
        .expect("page");
        assert_eq!(page.rows.len(), 1, "limit 1 pages one row at a time");
        seen.push(page.rows[0].id);
        cursor = page.next_cursor;
        assert!(cursor.is_some() || seen.len() == 3);
    }
    assert_eq!(seen, expected, "no row sharing a stamp is dropped");
    assert!(
        pull_page(
            &db.pool,
            SyncEntity::WorkoutSessions,
            PullParams {
                user_id: user,
                cursor: cursor.as_deref(),
                limit: 1
            },
        )
        .await
        .expect("tip page")
        .rows
        .is_empty(),
        "cursor at the tip is empty"
    );

    drop_scratch(db).await;
}

#[tokio::test]
async fn a_future_skewed_updated_at_cannot_starve_pulls() {
    let db = skip_without_db!();
    let user = seed_user(&db.pool, "alice").await;
    let row_a = Uuid::new_v4();
    let row_b = Uuid::new_v4();

    apply(
        &db.pool,
        user,
        &workout_op("op-a", OpAction::Create, row_a, user, "v1", at(10)),
    )
    .await;
    pace();

    // A device with a wildly wrong clock pushes once.
    let skewed = Utc.with_ymd_and_hms(2099, 1, 1, 0, 0, 0).unwrap();
    let pushed = apply(
        &db.pool,
        user,
        &workout_op("op-b", OpAction::Create, row_b, user, "v2", skewed),
    )
    .await;
    assert_eq!(pushed.status, OpStatus::Applied);

    // The stored LWW timestamp is clamped near the server clock (the
    // sync contract's ceiling), so it cannot pin the row years ahead.
    let stored_at: DateTime<Utc> =
        sqlx::query_scalar("SELECT updated_at FROM workout_sessions WHERE id = $1")
            .bind(row_b)
            .fetch_one(&db.pool)
            .await
            .expect("read updated_at");
    let test_now = Utc::now();
    assert!(
        stored_at <= test_now + Duration::minutes(6),
        "clamped updated_at must hug the server clock, got {stored_at}"
    );
    assert!(stored_at >= test_now - Duration::minutes(1));
    assert_eq!(
        waveform_sync::clamp_client_timestamp(skewed, test_now),
        test_now + Duration::minutes(waveform_sync::MAX_CLIENT_CLOCK_SKEW_MINUTES),
        "the clamp ceiling matches the sync crate"
    );

    // A client that had already synced row_a still receives row_b on its
    // very next pull: the cursor rides on the server stamp.
    let page_a = pull_page(
        &db.pool,
        SyncEntity::WorkoutSessions,
        PullParams {
            user_id: user,
            cursor: None,
            limit: 1,
        },
    )
    .await
    .expect("page a");
    let first_id = page_a.rows[0].id;
    let cursor = page_a.next_cursor.as_deref().expect("full page");
    let page_b = pull_page(
        &db.pool,
        SyncEntity::WorkoutSessions,
        PullParams {
            user_id: user,
            cursor: Some(cursor),
            limit: 5,
        },
    )
    .await
    .expect("page b");
    let received: Vec<Uuid> = page_b.rows.iter().map(|row| row.id).collect();
    let other = if first_id == row_a { row_b } else { row_a };
    assert!(
        received.contains(&other),
        "the row pushed by the skewed device must still arrive"
    );

    drop_scratch(db).await;
}

#[tokio::test]
async fn payload_user_id_is_overridden_by_the_session_user() {
    let db = skip_without_db!();
    let session_user = seed_user(&db.pool, "alice").await;
    let spoofed = seed_user(&db.pool, "mallory").await;
    let row = Uuid::new_v4();

    // The payload claims the row belongs to someone else; the session
    // user always wins.
    let mut payload = workout_payload(row, spoofed, "mine");
    payload["user_id"] = json!(spoofed);
    let op = push_op(
        "spoof",
        SyncEntity::WorkoutSessions,
        OpAction::Create,
        payload,
        at(10),
    );
    assert_eq!(
        apply(&db.pool, session_user, &op).await.status,
        OpStatus::Applied
    );
    let owner: Uuid = sqlx::query_scalar("SELECT user_id FROM workout_sessions WHERE id = $1")
        .bind(row)
        .fetch_one(&db.pool)
        .await
        .expect("read owner");
    assert_eq!(owner, session_user, "the payload user_id never lands");

    // The same for exercises: a payload with owner_id NULL cannot mint a
    // global catalog row; it lands as the session user's custom row.
    let exercise_id = Uuid::new_v4();
    let exercise_payload = json!({
        "id": exercise_id,
        "owner_id": null,
        "name": "Session Machine",
        "muscle_group": "chest",
        "equipment": "cable",
        "created_at": "2026-10-14T09:30:00.000Z",
    });
    let op = push_op(
        "custom-exercise",
        SyncEntity::Exercises,
        OpAction::Create,
        exercise_payload,
        at(11),
    );
    assert_eq!(
        apply(&db.pool, session_user, &op).await.status,
        OpStatus::Applied
    );
    let owner: Option<Uuid> = sqlx::query_scalar("SELECT owner_id FROM exercises WHERE id = $1")
        .bind(exercise_id)
        .fetch_one(&db.pool)
        .await
        .expect("read exercise owner");
    assert_eq!(owner, Some(session_user), "custom rows are always owned");

    drop_scratch(db).await;
}

#[tokio::test]
async fn pushing_a_catalog_row_id_is_rejected() {
    let db = skip_without_db!();
    let user = seed_user(&db.pool, "alice").await;

    let (catalog_id, catalog_name, catalog_stamp): (Uuid, String, DateTime<Utc>) =
        sqlx::query_as("SELECT id, name, updated_at FROM exercises WHERE owner_id IS NULL LIMIT 1")
            .fetch_one(&db.pool)
            .await
            .expect("pick a catalog row");

    let hijack = json!({
        "id": catalog_id,
        "owner_id": null,
        "name": "Hijacked",
        "muscle_group": "nothing",
        "equipment": null,
        "created_at": "2026-10-14T09:30:00.000Z",
    });
    let op = push_op(
        "hijack",
        SyncEntity::Exercises,
        OpAction::Update,
        hijack,
        at(10),
    );
    let outcome = apply(&db.pool, user, &op).await;
    assert_eq!(outcome.status, OpStatus::Rejected);
    assert_eq!(outcome.error, Some(ApiErrorCode::Forbidden));
    assert_eq!(
        claim_count(&db.pool, op.op_id).await,
        0,
        "a rejection stores nothing"
    );

    let (name, stamp, owner): (String, DateTime<Utc>, Option<Uuid>) =
        sqlx::query_as("SELECT name, updated_at, owner_id FROM exercises WHERE id = $1")
            .bind(catalog_id)
            .fetch_one(&db.pool)
            .await
            .expect("re-read catalog row");
    assert_eq!(name, catalog_name, "the catalog row is untouched");
    assert_eq!(stamp, catalog_stamp);
    assert_eq!(owner, None);

    drop_scratch(db).await;
}

#[tokio::test]
async fn set_entry_before_parent_is_retryable_then_succeeds() {
    let db = skip_without_db!();
    let user = seed_user(&db.pool, "alice").await;
    let workout_id = Uuid::new_v4();
    let exercise_id: Uuid =
        sqlx::query_scalar("SELECT id FROM exercises WHERE owner_id IS NULL LIMIT 1")
            .fetch_one(&db.pool)
            .await
            .expect("pick a catalog exercise");
    let entry_id = Uuid::new_v4();
    let set_id = Uuid::new_v4();

    // The set's parent entry has not arrived yet: retryable, no claim.
    let set_payload = json!({
        "id": set_id,
        "exercise_entry_id": entry_id,
        "set_index": 0,
        "weight_kg": 100.0,
        "reps": 5,
        "is_warmup": false,
        "created_at": "2026-10-14T09:30:00.000Z",
    });
    let set_op = push_op(
        "set-1",
        SyncEntity::SetEntries,
        OpAction::Create,
        set_payload.clone(),
        at(20),
    );
    let outcome = apply(&db.pool, user, &set_op).await;
    assert_eq!(outcome.status, OpStatus::Retryable);
    assert_eq!(outcome.error, None);
    let sets: i64 = sqlx::query_scalar("SELECT count(*) FROM set_entries WHERE id = $1")
        .bind(set_id)
        .fetch_one(&db.pool)
        .await
        .expect("count sets");
    assert_eq!(sets, 0, "a retryable op writes nothing");
    assert_eq!(
        claim_count(&db.pool, set_op.op_id).await,
        0,
        "and claims nothing"
    );

    // Parents arrive in order: workout, then entry.
    let day_op = workout_op("w-1", OpAction::Create, workout_id, user, "day", at(10));
    assert_eq!(
        apply(&db.pool, user, &day_op).await.status,
        OpStatus::Applied
    );
    let entry_payload = json!({
        "id": entry_id,
        "workout_id": workout_id,
        "exercise_id": exercise_id,
        "order_index": 0,
        "notes": null,
        "created_at": "2026-10-14T09:30:00.000Z",
    });
    let entry_op = push_op(
        "e-1",
        SyncEntity::ExerciseEntries,
        OpAction::Create,
        entry_payload,
        at(11),
    );
    assert_eq!(
        apply(&db.pool, user, &entry_op).await.status,
        OpStatus::Applied
    );

    // The very same op id retries and lands: nothing was claimed while
    // retryable.
    let retry = apply(&db.pool, user, &set_op).await;
    assert_eq!(retry.status, OpStatus::Applied);
    let sets: i64 = sqlx::query_scalar("SELECT count(*) FROM set_entries WHERE id = $1")
        .bind(set_id)
        .fetch_one(&db.pool)
        .await
        .expect("count sets");
    assert_eq!(sets, 1);
    let e1rm: f64 = sqlx::query_scalar("SELECT e1rm_kg FROM set_entries WHERE id = $1")
        .bind(set_id)
        .fetch_one(&db.pool)
        .await
        .expect("generated e1rm");
    assert!((e1rm - waveform_scoring::e1rm_brzycki(100.0, 5)).abs() < 1e-9);

    // And the set joins the user's pull through its parent chain.
    let page = pull_page(
        &db.pool,
        SyncEntity::SetEntries,
        PullParams {
            user_id: user,
            cursor: None,
            limit: 10,
        },
    )
    .await
    .expect("pull sets");
    assert_eq!(page.rows.len(), 1);
    assert_eq!(page.rows[0].id, set_id);
    assert!(page.rows[0].payload.get("applied_at").is_none());

    drop_scratch(db).await;
}

#[tokio::test]
async fn check_violation_is_rejected_and_leaves_no_trace() {
    let db = skip_without_db!();
    let user = seed_user(&db.pool, "alice").await;
    let workout_id = Uuid::new_v4();
    let entry_id = Uuid::new_v4();
    let exercise_id: Uuid =
        sqlx::query_scalar("SELECT id FROM exercises WHERE owner_id IS NULL LIMIT 1")
            .fetch_one(&db.pool)
            .await
            .expect("pick a catalog exercise");

    let day_op = workout_op("cv-w", OpAction::Create, workout_id, user, "day", at(10));
    assert_eq!(
        apply(&db.pool, user, &day_op).await.status,
        OpStatus::Applied
    );
    let entry_op = push_op(
        "cv-e",
        SyncEntity::ExerciseEntries,
        OpAction::Create,
        json!({
            "id": entry_id,
            "workout_id": workout_id,
            "exercise_id": exercise_id,
            "order_index": 0,
            "notes": null,
            "created_at": "2026-10-14T09:30:00.000Z",
        }),
        at(11),
    );
    assert_eq!(
        apply(&db.pool, user, &entry_op).await.status,
        OpStatus::Applied
    );

    // reps 40 breaks CHECK (reps BETWEEN 1 AND 36).
    let set_id = Uuid::new_v4();
    let bad_set = push_op(
        "cv-bad",
        SyncEntity::SetEntries,
        OpAction::Create,
        json!({
            "id": set_id,
            "exercise_entry_id": entry_id,
            "set_index": 0,
            "weight_kg": 100.0,
            "reps": 40,
            "is_warmup": false,
            "created_at": "2026-10-14T09:30:00.000Z",
        }),
        at(20),
    );
    let outcome = apply(&db.pool, user, &bad_set).await;
    assert_eq!(outcome.status, OpStatus::Rejected);
    assert_eq!(outcome.error, Some(ApiErrorCode::InvalidPayload));

    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM set_entries WHERE id = $1")
        .bind(set_id)
        .fetch_one(&db.pool)
        .await
        .expect("count sets");
    assert_eq!(rows, 0, "the rejected row must not exist");
    assert_eq!(
        claim_count(&db.pool, bad_set.op_id).await,
        0,
        "a rejected op leaves no client_ops trace either"
    );

    // A data error (unparseable date) rejects the same way.
    let bad_date = push_op(
        "cv-date",
        SyncEntity::WorkoutSessions,
        OpAction::Create,
        json!({
            "id": Uuid::new_v4(),
            "user_id": user,
            "local_date": "not-a-date",
            "created_at": "2026-10-14T09:30:00.000Z",
        }),
        at(21),
    );
    let outcome = apply(&db.pool, user, &bad_date).await;
    assert_eq!(outcome.status, OpStatus::Rejected);
    assert_eq!(outcome.error, Some(ApiErrorCode::InvalidPayload));
    assert_eq!(claim_count(&db.pool, bad_date.op_id).await, 0);

    drop_scratch(db).await;
}

#[tokio::test]
async fn cross_user_rows_never_leak_into_a_pull() {
    let db = skip_without_db!();
    let alice = seed_user(&db.pool, "alice").await;
    let mallory = seed_user(&db.pool, "mallory").await;

    let alice_workout = Uuid::new_v4();
    let mallory_workout = Uuid::new_v4();
    assert_eq!(
        apply(
            &db.pool,
            alice,
            &workout_op(
                "a-w",
                OpAction::Create,
                alice_workout,
                alice,
                "alice day",
                at(10)
            ),
        )
        .await
        .status,
        OpStatus::Applied
    );
    pace();
    assert_eq!(
        apply(
            &db.pool,
            mallory,
            &workout_op(
                "m-w",
                OpAction::Create,
                mallory_workout,
                mallory,
                "mallory day",
                at(11)
            ),
        )
        .await
        .status,
        OpStatus::Applied
    );

    let alice_exercise = Uuid::new_v4();
    let mallory_exercise = Uuid::new_v4();
    for (owner, id, name) in [
        (alice, alice_exercise, "Alice Lift"),
        (mallory, mallory_exercise, "Mallory Lift"),
    ] {
        let op = push_op(
            &format!("ex-{id}"),
            SyncEntity::Exercises,
            OpAction::Create,
            json!({
                "id": id,
                "name": name,
                "muscle_group": "chest",
                "equipment": null,
                "created_at": "2026-10-14T09:30:00.000Z",
            }),
            at(12),
        );
        assert_eq!(apply(&db.pool, owner, &op).await.status, OpStatus::Applied);
    }

    // Alice's pull: her workout and her custom exercise only. The global
    // catalog (owner_id NULL) and every foreign row stay invisible.
    let workouts = pull_page(
        &db.pool,
        SyncEntity::WorkoutSessions,
        PullParams {
            user_id: alice,
            cursor: None,
            limit: 100,
        },
    )
    .await
    .expect("pull workouts");
    let ids: Vec<Uuid> = workouts.rows.iter().map(|row| row.id).collect();
    assert_eq!(ids, vec![alice_workout]);

    let exercises = pull_page(
        &db.pool,
        SyncEntity::Exercises,
        PullParams {
            user_id: alice,
            cursor: None,
            limit: 1000,
        },
    )
    .await
    .expect("pull exercises");
    let ids: Vec<Uuid> = exercises.rows.iter().map(|row| row.id).collect();
    assert_eq!(
        ids,
        vec![alice_exercise],
        "custom exercises only, no catalog"
    );

    let mallory_pull = pull_page(
        &db.pool,
        SyncEntity::WorkoutSessions,
        PullParams {
            user_id: mallory,
            cursor: None,
            limit: 100,
        },
    )
    .await
    .expect("pull workouts as mallory");
    let ids: Vec<Uuid> = mallory_pull.rows.iter().map(|row| row.id).collect();
    assert_eq!(ids, vec![mallory_workout]);

    // Updating the other user's row is rejected outright.
    let steal = workout_op(
        "a-steal",
        OpAction::Update,
        mallory_workout,
        alice,
        "stolen",
        at(30),
    );
    let outcome = apply(&db.pool, alice, &steal).await;
    assert_eq!(outcome.status, OpStatus::Rejected);
    assert_eq!(outcome.error, Some(ApiErrorCode::Forbidden));
    let (notes, ..) = stored_workout(&db.pool, mallory_workout).await;
    assert_eq!(notes, "mallory day");

    drop_scratch(db).await;
}

#[tokio::test]
async fn tombstone_delete_for_an_unknown_row_inserts_a_tombstoned_row() {
    // Creates, and deletes for rows this server has never seen, both
    // insert a (possibly tombstoned) row so pulls propagate state.
    let db = skip_without_db!();
    let user = seed_user(&db.pool, "alice").await;
    let row = Uuid::new_v4();

    let payload = json!({
        "id": row,
        "name": "Ghost Exercise",
        "muscle_group": "chest",
        "equipment": null,
        "created_at": "2026-10-14T09:30:00.000Z",
    });
    let op = push_op(
        "ghost-delete",
        SyncEntity::Exercises,
        OpAction::Delete,
        payload,
        at(10),
    );
    assert_eq!(apply(&db.pool, user, &op).await.status, OpStatus::Applied);

    let (name, deleted_at, owner): (String, Option<DateTime<Utc>>, Option<Uuid>) =
        sqlx::query_as("SELECT name, deleted_at, owner_id FROM exercises WHERE id = $1")
            .bind(row)
            .fetch_one(&db.pool)
            .await
            .expect("the tombstoned row exists");
    assert_eq!(name, "Ghost Exercise");
    assert!(deleted_at.is_some(), "the unknown row lands tombstoned");
    assert_eq!(owner, Some(user), "even a tombstone is owned by the pusher");

    let page = pull_page(
        &db.pool,
        SyncEntity::Exercises,
        PullParams {
            user_id: user,
            cursor: None,
            limit: 10,
        },
    )
    .await
    .expect("pull exercises");
    let ids: Vec<Uuid> = page.rows.iter().map(|row| row.id).collect();
    assert_eq!(ids, vec![row], "the tombstone is pulled");

    drop_scratch(db).await;
}

#[tokio::test]
async fn pull_clamps_the_limit_to_the_rule_constant() {
    let db = skip_without_db!();
    let user = seed_user(&db.pool, "alice").await;
    for second in [10_u32, 20] {
        let row_id = Uuid::new_v4();
        let op = workout_op(
            &format!("clamp-{second}"),
            OpAction::Create,
            row_id,
            user,
            &format!("v{second}"),
            at(second),
        );
        assert_eq!(apply(&db.pool, user, &op).await.status, OpStatus::Applied);
        pace();
    }

    let rules = waveform_db::dto::RuleConstants::default();
    // limit 0 clamps up to 1; a huge limit clamps down to the page size,
    // which still returns every (fewer) row.
    let page = pull_page(
        &db.pool,
        SyncEntity::WorkoutSessions,
        PullParams {
            user_id: user,
            cursor: None,
            limit: 0,
        },
    )
    .await
    .expect("pull with limit 0");
    assert_eq!(page.rows.len(), 1);
    assert!(page.next_cursor.is_some());

    let page = pull_page(
        &db.pool,
        SyncEntity::WorkoutSessions,
        PullParams {
            user_id: user,
            cursor: None,
            limit: i64::from(rules.sync.pull_page_size) + 10,
        },
    )
    .await
    .expect("pull with oversized limit");
    assert_eq!(page.rows.len(), 2);
    assert!(page.next_cursor.is_none());

    drop_scratch(db).await;
}

#[tokio::test]
async fn routines_and_routine_entries_apply_and_pull() {
    let db = skip_without_db!();
    let user = seed_user(&db.pool, "alice").await;
    let routine_id = Uuid::new_v4();
    let entry_id = Uuid::new_v4();
    let exercise_id: Uuid =
        sqlx::query_scalar("SELECT id FROM exercises WHERE owner_id IS NULL LIMIT 1")
            .fetch_one(&db.pool)
            .await
            .expect("pick a catalog exercise");

    let routine_op = push_op(
        "r-1",
        SyncEntity::Routines,
        OpAction::Create,
        json!({
            "id": routine_id,
            "user_id": Uuid::new_v4(),
            "name": "Push day",
            "notes": null,
            "created_at": "2026-10-14T09:30:00.000Z",
        }),
        at(10),
    );
    assert_eq!(
        apply(&db.pool, user, &routine_op).await.status,
        OpStatus::Applied
    );

    // A routine entry whose exercise is missing is retryable...
    let entry_op = push_op(
        "r-e-1",
        SyncEntity::RoutineEntries,
        OpAction::Create,
        json!({
            "id": entry_id,
            "routine_id": routine_id,
            "exercise_id": Uuid::new_v4(),
            "order_index": 0,
            "target_sets": 3,
            "target_reps": 8,
            "target_weight_kg": null,
            "created_at": "2026-10-14T09:30:00.000Z",
        }),
        at(11),
    );
    assert_eq!(
        apply(&db.pool, user, &entry_op).await.status,
        OpStatus::Retryable
    );

    // ... and lands once the exercise it names exists.
    let landed = push_op(
        "r-e-2",
        SyncEntity::RoutineEntries,
        OpAction::Create,
        json!({
            "id": entry_id,
            "routine_id": routine_id,
            "exercise_id": exercise_id,
            "order_index": 0,
            "target_sets": 3,
            "target_reps": 8,
            "target_weight_kg": 72.5,
            "created_at": "2026-10-14T09:30:00.000Z",
        }),
        at(12),
    );
    assert_eq!(
        apply(&db.pool, user, &landed).await.status,
        OpStatus::Applied
    );

    let routines = pull_page(
        &db.pool,
        SyncEntity::Routines,
        PullParams {
            user_id: user,
            cursor: None,
            limit: 10,
        },
    )
    .await
    .expect("pull routines");
    assert_eq!(routines.rows.len(), 1);
    assert_eq!(routines.rows[0].id, routine_id);

    let entries = pull_page(
        &db.pool,
        SyncEntity::RoutineEntries,
        PullParams {
            user_id: user,
            cursor: None,
            limit: 10,
        },
    )
    .await
    .expect("pull routine entries");
    assert_eq!(entries.rows.len(), 1);
    assert_eq!(entries.rows[0].id, entry_id);

    drop_scratch(db).await;
}

#[tokio::test]
async fn user_owned_entities_force_the_session_owner() {
    // activities and body_stats are user_id tables: a spoofed owner in
    // the payload never lands, and foreign rows reject.
    let db = skip_without_db!();
    let user = seed_user(&db.pool, "alice").await;
    let spoofed = seed_user(&db.pool, "mallory").await;
    let activity_id = Uuid::new_v4();
    let body_id = Uuid::new_v4();

    let activity_op = push_op(
        "act-1",
        SyncEntity::Activities,
        OpAction::Create,
        json!({
            "id": activity_id,
            "user_id": spoofed,
            "type": "cycling",
            "local_date": "2026-10-14",
            "started_at": null,
            "duration_min": 90,
            "distance_km": 42.5,
            "elevation_m": 500.0,
            "climb_grade": null,
            "climb_grade_value": null,
            "routes_sent": null,
            "notes": "ride",
            "created_at": "2026-10-14T09:30:00.000Z",
        }),
        at(10),
    );
    assert_eq!(
        apply(&db.pool, user, &activity_op).await.status,
        OpStatus::Applied
    );
    let owner: Uuid = sqlx::query_scalar("SELECT user_id FROM activities WHERE id = $1")
        .bind(activity_id)
        .fetch_one(&db.pool)
        .await
        .expect("activity owner");
    assert_eq!(owner, user);

    // A CHECK violation on activities rejects (climb_grade_value > 16).
    let bad_grade = push_op(
        "act-bad",
        SyncEntity::Activities,
        OpAction::Create,
        json!({
            "id": Uuid::new_v4(),
            "user_id": user,
            "type": "climbing",
            "local_date": "2026-10-14",
            "started_at": null,
            "duration_min": null,
            "distance_km": null,
            "elevation_m": null,
            "climb_grade": "V20",
            "climb_grade_value": 20.0,
            "routes_sent": null,
            "notes": null,
            "created_at": "2026-10-14T09:30:00.000Z",
        }),
        at(11),
    );
    let outcome = apply(&db.pool, user, &bad_grade).await;
    assert_eq!(outcome.status, OpStatus::Rejected);
    assert_eq!(outcome.error, Some(ApiErrorCode::InvalidPayload));

    let body_op = push_op(
        "body-1",
        SyncEntity::BodyStats,
        OpAction::Create,
        json!({
            "id": body_id,
            "user_id": spoofed,
            "local_date": "2026-10-14",
            "weight_kg": 82.5,
            "bodyfat_pct": 14.0,
            "neck_cm": null,
            "shoulders_cm": null,
            "chest_cm": null,
            "bicep_cm": null,
            "waist_cm": null,
            "hips_cm": null,
            "thigh_cm": null,
            "calf_cm": null,
            "created_at": "2026-10-14T09:30:00.000Z",
        }),
        at(12),
    );
    assert_eq!(
        apply(&db.pool, user, &body_op).await.status,
        OpStatus::Applied
    );
    let owner: Uuid = sqlx::query_scalar("SELECT user_id FROM body_stats WHERE id = $1")
        .bind(body_id)
        .fetch_one(&db.pool)
        .await
        .expect("body owner");
    assert_eq!(owner, user);

    // Body stats are owner-private: mallory's pull never sees them.
    let page = pull_page(
        &db.pool,
        SyncEntity::BodyStats,
        PullParams {
            user_id: spoofed,
            cursor: None,
            limit: 10,
        },
    )
    .await
    .expect("pull body stats as mallory");
    assert!(page.rows.is_empty());

    drop_scratch(db).await;
}
