//! Schema integration tests against a real Postgres.
//!
//! These verify what unit tests cannot: that `migrations/0001_init.sql`,
//! `0002_seed_catalog.sql`, and `0003_hardening.sql` apply to a fresh
//! database, that re-running the migrator is idempotent, that the generated
//! `set_entries.e1rm_kg` column computes Brzycki exactly like
//! `liftlog-scoring`, and that the CHECK/UNIQUE constraints and tombstone
//! contract hold in SQL.
//!
//! Requirements: a Postgres the test user can `CREATE DATABASE` on, e.g. the
//! compose stack from `infra/docker-compose.yml`:
//!
//! ```text
//! docker compose -f infra/docker-compose.yml up -d postgres
//! LIFTLOG_TEST_DATABASE_URL=postgres://liftlog:liftlog@localhost:5432/liftlog \
//!     cargo test -p liftlog-db --test schema
//! ```
//!
//! When the env var is missing every test prints a skip notice and returns,
//! so `cargo test --workspace` stays green without infra. Each test runs in
//! its own throwaway database, dropped on completion.

use chrono::NaiveDate;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use uuid::Uuid;

const SYNCED_TABLES: &[&str] = &[
    "users",
    "sessions",
    "otp_codes",
    "invites",
    "groups",
    "group_members",
    "exercises",
    "routines",
    "routine_entries",
    "workout_sessions",
    "exercise_entries",
    "set_entries",
    "activities",
    "body_stats",
    "kudos",
    "challenges",
    "client_ops",
];

fn base_url() -> Option<String> {
    std::env::var("LIFTLOG_TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()
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
    let name = format!("liftlog_test_{}", Uuid::new_v4().simple());
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

    let pool = liftlog_db::connect(&with_database(&base_url, &name))
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
    // FORCE terminates leftover connections on Postgres 13+.
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
            Some(db) => db,
            None => {
                eprintln!(
                    "SKIPPED: set LIFTLOG_TEST_DATABASE_URL (or DATABASE_URL) to a Postgres \
                     URL with CREATE DATABASE rights to run schema tests"
                );
                return;
            }
        }
    };
}

#[tokio::test]
async fn fresh_database_gets_every_table() {
    let db = skip_without_db!();
    liftlog_db::run_migrations(&db.pool)
        .await
        .expect("migrations must apply to a fresh database");

    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    )
    .fetch_all(&db.pool)
    .await
    .expect("list tables");
    for expected in SYNCED_TABLES {
        assert!(
            tables.contains(&expected.to_string()),
            "missing table {expected}; found {tables:?}"
        );
    }

    // 0002_seed_catalog.sql must have seeded the global exercise catalog.
    let global_exercises: i64 =
        sqlx::query_scalar("SELECT count(*) FROM exercises WHERE owner_id IS NULL")
            .fetch_one(&db.pool)
            .await
            .expect("count seeded catalog");
    assert!(
        global_exercises > 0,
        "seed migration must populate the global catalog"
    );

    drop_scratch(db).await;
}

#[tokio::test]
async fn migrations_are_idempotent_on_rerun() {
    let db = skip_without_db!();
    liftlog_db::run_migrations(&db.pool)
        .await
        .expect("first run");

    let count_after_first: i64 = sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations")
        .fetch_one(&db.pool)
        .await
        .expect("count migrations");
    assert!(
        count_after_first >= 2,
        "expected at least both phase-0 files"
    );

    // Second run must succeed and apply nothing.
    liftlog_db::run_migrations(&db.pool)
        .await
        .expect("second run must be a no-op success");
    let count_after_second: i64 = sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations")
        .fetch_one(&db.pool)
        .await
        .expect("count migrations again");
    assert_eq!(count_after_first, count_after_second);

    drop_scratch(db).await;
}

/// Seed the parent rows a set entry hangs off: one user, one per-user custom
/// exercise, one workout, one exercise entry. Custom exercises set owner_id,
/// which exempts them from the global-catalog name uniqueness index.
async fn seed_set_scaffold(pool: &PgPool) -> (Uuid, Uuid, Uuid, Uuid) {
    let user_id = Uuid::new_v4();
    let exercise_id = Uuid::new_v4();
    let workout_id = Uuid::new_v4();
    let entry_id = Uuid::new_v4();

    sqlx::query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)")
        .bind(user_id)
        .bind(format!("{user_id}@test.invalid"))
        .bind("Schema Tester")
        .execute(pool)
        .await
        .expect("insert user");

    sqlx::query(
        "INSERT INTO exercises (id, owner_id, name, muscle_group) \
         VALUES ($1, $2, 'Back Squat', 'legs')",
    )
    .bind(exercise_id)
    .bind(user_id)
    .execute(pool)
    .await
    .expect("insert per-user exercise");

    let local_date = NaiveDate::from_ymd_opt(2026, 10, 14).expect("valid date");
    sqlx::query("INSERT INTO workout_sessions (id, user_id, local_date) VALUES ($1, $2, $3)")
        .bind(workout_id)
        .bind(user_id)
        .bind(local_date)
        .execute(pool)
        .await
        .expect("insert workout");

    sqlx::query("INSERT INTO exercise_entries (id, workout_id, exercise_id) VALUES ($1, $2, $3)")
        .bind(entry_id)
        .bind(workout_id)
        .bind(exercise_id)
        .execute(pool)
        .await
        .expect("insert exercise entry");

    (user_id, exercise_id, workout_id, entry_id)
}

#[tokio::test]
async fn global_catalog_names_are_unique_but_custom_exercises_are_not() {
    let db = skip_without_db!();
    liftlog_db::run_migrations(&db.pool).await.expect("migrate");

    // 0002_seed_catalog.sql seeds global 'Bench Press (Barbell)'; a
    // differently-cased global twin must collide through the partial index
    // on lower(name).
    let case_variant = sqlx::query(
        "INSERT INTO exercises (id, owner_id, name, muscle_group) \
         VALUES ($1, NULL, 'bENCH pRESS (bARBELL)', 'chest')",
    )
    .bind(Uuid::new_v4())
    .execute(&db.pool)
    .await;
    assert!(
        case_variant.is_err(),
        "case-variant global catalog name must be rejected"
    );

    // A per-user custom exercise may reuse a global name: the unique index
    // only covers owner_id IS NULL rows.
    let (user_id, ..) = seed_set_scaffold(&db.pool).await;
    let custom = sqlx::query(
        "INSERT INTO exercises (id, owner_id, name, muscle_group) \
         VALUES ($1, $2, 'Bench Press (Barbell)', 'chest')",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .execute(&db.pool)
    .await;
    assert!(
        custom.is_ok(),
        "per-user custom exercise must not hit the global index"
    );

    drop_scratch(db).await;
}

#[tokio::test]
async fn generated_e1rm_column_matches_rust_scoring() {
    let db = skip_without_db!();
    liftlog_db::run_migrations(&db.pool).await.expect("migrate");
    let (_user, _exercise, _workout, entry_id) = seed_set_scaffold(&db.pool).await;

    // e1rm_kg is double precision (0003) and stores the full value; 0.01
    // still covers the difference to the rounded reference table below.
    let tolerance = 0.01;
    let cases: &[(f64, u32, f64)] = &[
        (100.0, 1, 100.0),
        (100.0, 2, 102.859494),
        (100.0, 5, 112.511251),
        (100.0, 10, 133.368898),
        (100.0, 20, 211.954218),
        (100.0, 36, 3703.703704),
        (60.0, 10, 80.021339),
        (200.0, 20, 423.908436),
    ];

    for &(weight, reps, expected) in cases {
        let set_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO set_entries (id, exercise_entry_id, set_index, weight_kg, reps) \
             VALUES ($1, $2, 0, $3::numeric, $4)",
        )
        .bind(set_id)
        .bind(entry_id)
        .bind(weight)
        .bind(reps as i32)
        .execute(&db.pool)
        .await
        .unwrap_or_else(|e| panic!("insert {weight} kg x {reps}: {e}"));

        let stored: f64 =
            sqlx::query_scalar("SELECT e1rm_kg::float8 FROM set_entries WHERE id = $1")
                .bind(set_id)
                .fetch_one(&db.pool)
                .await
                .expect("select e1rm");

        let rust_value = liftlog_scoring::e1rm_brzycki(weight, reps);
        assert!(
            (stored - rust_value).abs() < tolerance,
            "SQL e1rm {stored} diverges from Rust scoring {rust_value} at {weight} kg x {reps}"
        );
        assert!(
            (stored - expected).abs() < tolerance,
            "SQL e1rm {stored} diverges from the reference value {expected} at {weight} kg x {reps}"
        );
    }

    drop_scratch(db).await;
}

#[tokio::test]
async fn set_entries_constraints_hold_in_sql() {
    async fn insert_set(
        pool: &PgPool,
        entry_id: Uuid,
        reps: i32,
        weight: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO set_entries (id, exercise_entry_id, weight_kg, reps) \
             VALUES ($1, $2, $3::numeric, $4)",
        )
        .bind(Uuid::new_v4())
        .bind(entry_id)
        .bind(weight)
        .bind(reps)
        .execute(pool)
        .await
        .map(|_| ())
    }

    let db = skip_without_db!();
    liftlog_db::run_migrations(&db.pool).await.expect("migrate");
    let (_user, _exercise, _workout, entry_id) = seed_set_scaffold(&db.pool).await;

    // CHECK (reps BETWEEN 1 AND 36).
    assert!(
        insert_set(&db.pool, entry_id, 0, "100").await.is_err(),
        "reps 0 must be rejected"
    );
    assert!(
        insert_set(&db.pool, entry_id, 37, "100").await.is_err(),
        "reps 37 must be rejected"
    );
    assert!(
        insert_set(&db.pool, entry_id, -1, "100").await.is_err(),
        "negative reps must be rejected"
    );
    // CHECK (weight_kg >= 0).
    assert!(
        insert_set(&db.pool, entry_id, 5, "-0.01").await.is_err(),
        "negative weight must be rejected"
    );
    // e1rm_kg is GENERATED ALWAYS, so clients cannot hand-write estimates.
    let generated = sqlx::query(
        "INSERT INTO set_entries (id, exercise_entry_id, weight_kg, reps, e1rm_kg) \
         VALUES ($1, $2, 100::numeric, 5, 999::numeric)",
    )
    .bind(Uuid::new_v4())
    .bind(entry_id)
    .execute(&db.pool)
    .await;
    assert!(
        generated.is_err(),
        "writing e1rm_kg explicitly must be rejected"
    );

    // The happy path at the domain edges still works. 250 kg x 36 yields a
    // generated e1rm near 9259.26, which double precision (0003) holds
    // without the old numeric(6,2) overflow.
    assert!(
        insert_set(&db.pool, entry_id, 36, "250").await.is_ok(),
        "domain edges must insert"
    );

    drop_scratch(db).await;
}

#[tokio::test]
async fn client_ops_primary_key_dedupes_replayed_ops() {
    let db = skip_without_db!();
    liftlog_db::run_migrations(&db.pool).await.expect("migrate");
    let (user_id, ..) = seed_set_scaffold(&db.pool).await;

    let op_id = Uuid::new_v4();
    let insert_op = || {
        let id = op_id;
        let pool = db.pool.clone();
        async move {
            sqlx::query(
                "INSERT INTO client_ops (id, user_id, entity, action, payload, updated_at) \
                 VALUES ($1, $2, 'set_entries', 'create', '{}'::jsonb, now())",
            )
            .bind(id)
            .bind(user_id)
            .execute(&pool)
            .await
        }
    };

    insert_op().await.expect("first replay inserts");
    let duplicate = insert_op()
        .await
        .expect_err("second replay must violate the PK");
    let db_err = match duplicate {
        sqlx::Error::Database(err) => err,
        other => panic!("expected a database error, got {other}"),
    };
    assert!(db_err.is_unique_violation(), "expected unique violation");

    drop_scratch(db).await;
}

#[tokio::test]
async fn deletes_are_soft_tombstones_with_partial_pull_indexes() {
    let db = skip_without_db!();
    liftlog_db::run_migrations(&db.pool).await.expect("migrate");
    let (_user, _exercise, _workout, entry_id) = seed_set_scaffold(&db.pool).await;

    let set_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO set_entries (id, exercise_entry_id, weight_kg, reps) \
         VALUES ($1, $2, 100::numeric, 5)",
    )
    .bind(set_id)
    .bind(entry_id)
    .execute(&db.pool)
    .await
    .expect("insert set");

    // Delete = tombstone; the row must survive so pull clients learn about it.
    sqlx::query("UPDATE set_entries SET deleted_at = now() WHERE id = $1")
        .bind(set_id)
        .execute(&db.pool)
        .await
        .expect("tombstone the set");
    let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM set_entries WHERE id = $1")
        .bind(set_id)
        .fetch_one(&db.pool)
        .await
        .expect("count tombstoned set");
    assert_eq!(remaining, 1, "tombstoned row must remain queryable");

    // The pull index must exclude tombstones, per the schema contract.
    let index_def: String = sqlx::query_scalar(
        "SELECT indexdef FROM pg_indexes \
         WHERE schemaname = 'public' AND indexname = 'set_entries_updated_at_idx'",
    )
    .fetch_one(&db.pool)
    .await
    .expect("partial index must exist");
    assert!(
        index_def.contains("WHERE (deleted_at IS NULL)"),
        "pull index must exclude tombstones, got: {index_def}"
    );

    drop_scratch(db).await;
}
