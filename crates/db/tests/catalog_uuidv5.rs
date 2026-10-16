//! Catalog UUIDv5 convergence tests: the SQL helper in migration 0006
//! must produce byte for byte the ids the client derives with
//! `apps/web/src/db/seed/uuidV5.ts`.
//!
//! The migration files are executed from disk (not through the embedded
//! migrator) so the test can snapshot the catalog between 0005 and 0006,
//! prove the remap changes no counts and orphans no children, and prove a
//! second run of 0006 is a no-op. The same golden vectors are asserted in
//! the client vitest suite (`apps/web/src/db/seed/uuidV5Golden.test.ts`),
//! so a divergence between SQL and TypeScript fails both suites.
//!
//! Requirements: a Postgres the test user can `CREATE DATABASE` on:
//!
//! ```text
//! docker compose -f infra/docker-compose.yml up -d postgres
//! WAVEFORM_TEST_DATABASE_URL=postgres://waveform:waveform@localhost:5432/waveform \
//!     cargo test -p waveform-db --test catalog_uuidv5
//! ```

use std::path::{Path, PathBuf};

use chrono::NaiveDate;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use uuid::Uuid;

/// Migrations applied before the convergence file, in filename order.
const BEFORE: &[&str] = &[
    "0001_init.sql",
    "0002_seed_catalog.sql",
    "0003_hardening.sql",
    "0004_catalog_cleanup.sql",
    "0005_catalog_dedup.sql",
];

/// The convergence file under test.
const CONVERGENCE: &str = "0006_sync_foundation.sql";

/// Golden vectors pinned in SQL, Rust (`uuid::new_v5`), and TypeScript
/// (the client vitest file). `expected` was computed with Python's
/// `uuid.uuid5(NAMESPACE_DNS, lower(name))`.
const GOLDEN: &[(&str, &str)] = &[
    (
        "Bench Press (Barbell)",
        "0b665f42-5389-5d9b-8bf2-dfe9b5b56bff",
    ),
    ("Squat (Barbell)", "d0c0f79e-583c-55a9-a9df-45498fa4053b"),
    ("Ab Wheel", "eef99294-6327-5685-8fb0-19659c2dab34"),
    (
        "Bicep Curl (Dumbbell)",
        "65e59651-9dd9-53dd-8afc-3f5e52b049e4",
    ),
];

/// The RFC 4122 DNS namespace, matching uuidV5.ts.
fn dns_namespace() -> Uuid {
    Uuid::parse_str("6ba7b810-9dad-11d1-80b4-00c04fd430c8").expect("DNS namespace")
}

/// The reference UUIDv5 every leg must agree on.
fn reference_id(name: &str) -> Uuid {
    Uuid::new_v5(&dns_namespace(), name.to_lowercase().as_bytes())
}

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
            Some(db) => db,
            None => {
                eprintln!(
                    "SKIPPED: set WAVEFORM_TEST_DATABASE_URL (or DATABASE_URL) to a Postgres \
                     URL with CREATE DATABASE rights to run catalog uuidv5 tests"
                );
                return;
            }
        }
    };
}

fn migration_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../migrations")
        .join(name)
}

/// Execute migration files exactly as written, each file in one
/// (implicit) transaction, mirroring the sqlx runner.
async fn run_files(pool: &PgPool, names: &[&str]) {
    for name in names {
        let sql = std::fs::read_to_string(migration_path(name))
            .unwrap_or_else(|error| panic!("read {name}: {error}"));
        sqlx::raw_sql(&sql)
            .execute(pool)
            .await
            .unwrap_or_else(|error| panic!("execute {name}: {error}"));
    }
}

/// Everything the remap could touch: global catalog (name, id) pairs,
/// child links by parent name, and row counts.
struct Snapshot {
    globals: Vec<(String, Uuid)>,
    links: Vec<(String, String, String)>,
    global_count: i64,
    entry_count: i64,
    routine_entry_count: i64,
}

async fn snapshot(pool: &PgPool) -> Snapshot {
    let globals =
        sqlx::query_as("SELECT name, id FROM exercises WHERE owner_id IS NULL ORDER BY name")
            .fetch_all(pool)
            .await
            .expect("read globals");
    let global_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM exercises WHERE owner_id IS NULL")
            .fetch_one(pool)
            .await
            .expect("count globals");
    let links = sqlx::query_as(
        "SELECT 'exercise_entries'::text AS child, ee.id::text, e.name \
         FROM exercise_entries ee JOIN exercises e ON e.id = ee.exercise_id \
         UNION ALL \
         SELECT 'routine_entries', re.id::text, e.name \
         FROM routine_entries re JOIN exercises e ON e.id = re.exercise_id \
         ORDER BY 1, 2",
    )
    .fetch_all(pool)
    .await
    .expect("read child links");
    let entry_count: i64 = sqlx::query_scalar("SELECT count(*) FROM exercise_entries")
        .fetch_one(pool)
        .await
        .expect("count entries");
    let routine_entry_count: i64 = sqlx::query_scalar("SELECT count(*) FROM routine_entries")
        .fetch_one(pool)
        .await
        .expect("count routine entries");
    Snapshot {
        globals,
        links,
        global_count,
        entry_count,
        routine_entry_count,
    }
}

/// A user plus one child row per FK that migration 0006 remaps: an
/// exercise entry and a routine entry, each pointing at a different
/// global catalog row.
async fn seed_children(pool: &PgPool) -> Vec<String> {
    let user_id = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Catalog Tester')")
        .bind(user_id)
        .bind(format!("catalog-{}@test.invalid", user_id.simple()))
        .execute(pool)
        .await
        .expect("insert user");

    let first: (Uuid, String) = sqlx::query_as(
        "SELECT id, name FROM exercises WHERE owner_id IS NULL ORDER BY name LIMIT 1",
    )
    .fetch_one(pool)
    .await
    .expect("pick first catalog row");
    let second: (Uuid, String) = sqlx::query_as(
        "SELECT id, name FROM exercises WHERE owner_id IS NULL ORDER BY name OFFSET 1 LIMIT 1",
    )
    .fetch_one(pool)
    .await
    .expect("pick second catalog row");

    let workout_id = Uuid::new_v4();
    let entry_id = Uuid::new_v4();
    let routine_id = Uuid::new_v4();
    let routine_entry_id = Uuid::new_v4();
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
        .bind(first.0)
        .execute(pool)
        .await
        .expect("insert exercise entry");
    sqlx::query("INSERT INTO routines (id, user_id, name) VALUES ($1, $2, 'Push day')")
        .bind(routine_id)
        .bind(user_id)
        .execute(pool)
        .await
        .expect("insert routine");
    sqlx::query("INSERT INTO routine_entries (id, routine_id, exercise_id) VALUES ($1, $2, $3)")
        .bind(routine_entry_id)
        .bind(routine_id)
        .bind(second.0)
        .execute(pool)
        .await
        .expect("insert routine entry");

    vec![first.1, second.1]
}

#[tokio::test]
async fn sql_uuidv5_matches_the_uuid_crate_and_the_client() {
    let db = skip_without_db!();
    run_files(&db.pool, BEFORE).await;
    run_files(&db.pool, &[CONVERGENCE]).await;

    // waveform_catalog_id(name) == uuid::new_v5(DNS, lower(name)) == the
    // id uuidV5.ts computes in the browser.
    for (name, expected) in GOLDEN {
        let sql_id: Uuid = sqlx::query_scalar("SELECT waveform_catalog_id($1)")
            .bind(name)
            .fetch_one(&db.pool)
            .await
            .expect("catalog id");
        assert_eq!(
            sql_id,
            reference_id(name),
            "SQL and the uuid crate disagree on {name}"
        );
        assert_eq!(
            sql_id.to_string(),
            *expected,
            "golden vector drifted for {name}"
        );
    }

    // The lower() fold mirrors the SQL unique key and the client's
    // toLowerCase: case variants land on one id.
    let lower: Uuid = sqlx::query_scalar("SELECT waveform_catalog_id('bench press (barbell)')")
        .fetch_one(&db.pool)
        .await
        .expect("lowercase id");
    let upper: Uuid = sqlx::query_scalar("SELECT waveform_catalog_id('BENCH PRESS (BARBELL)')")
        .fetch_one(&db.pool)
        .await
        .expect("uppercase id");
    assert_eq!(lower, upper);
    assert_eq!(lower, reference_id("Bench Press (Barbell)"));

    // waveform_uuidv5 itself against the RFC example the client test also
    // pins: www.example.com under the DNS namespace.
    let www: Uuid = sqlx::query_scalar(
        "SELECT waveform_uuidv5('6ba7b810-9dad-11d1-80b4-00c04fd430c8'::uuid, 'www.example.com')",
    )
    .fetch_one(&db.pool)
    .await
    .expect("www id");
    assert_eq!(www.to_string(), "2ed6657d-e927-568b-95e1-2665a8aea6a2");
    assert_eq!(www, Uuid::new_v5(&dns_namespace(), b"www.example.com"));

    drop_scratch(db).await;
}

#[tokio::test]
async fn migration_converges_catalog_ids_without_counts_or_orphans() {
    let db = skip_without_db!();
    run_files(&db.pool, BEFORE).await;
    let child_names = seed_children(&db.pool).await;
    let before = snapshot(&db.pool).await;
    assert_eq!(
        before.global_count, 91,
        "the live catalog is the 91 rows after the 0005 dedup"
    );
    assert_eq!(before.entry_count, 1);
    assert_eq!(before.routine_entry_count, 1);

    run_files(&db.pool, &[CONVERGENCE]).await;
    let after = snapshot(&db.pool).await;

    // Counts unchanged; nothing inserted, nothing deleted.
    assert_eq!(after.global_count, before.global_count);
    assert_eq!(after.entry_count, before.entry_count);
    assert_eq!(after.routine_entry_count, before.routine_entry_count);

    // Every global row now carries the client-derived id...
    for (name, id) in &after.globals {
        assert_eq!(
            *id,
            reference_id(name),
            "global row {name} must converge to the client id"
        );
    }
    // ... under the same names as before (the remap only moves ids).
    let before_names: Vec<String> = before
        .globals
        .iter()
        .map(|(name, _)| name.clone())
        .collect();
    let after_names: Vec<String> = after.globals.iter().map(|(name, _)| name.clone()).collect();
    assert_eq!(before_names, after_names);
    let before_ids: Vec<Uuid> = before.globals.iter().map(|(_, id)| *id).collect();
    let after_ids: Vec<Uuid> = after.globals.iter().map(|(_, id)| *id).collect();
    assert_ne!(before_ids, after_ids, "the ids must actually move");

    // The children followed their parents: same child, same parent name.
    assert_eq!(
        before.links, after.links,
        "children keep pointing at the same exercise"
    );
    assert_eq!(
        after
            .links
            .iter()
            .map(|(_, _, name)| name.clone())
            .collect::<Vec<_>>(),
        child_names,
        "the seeded parents are the remapped parents"
    );

    // No orphans (the FKs guarantee it; assert anyway).
    let orphans: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM exercise_entries ee \
         WHERE NOT EXISTS (SELECT 1 FROM exercises e WHERE e.id = ee.exercise_id)",
    )
    .fetch_one(&db.pool)
    .await
    .expect("count orphans");
    assert_eq!(orphans, 0);
    let routine_orphans: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM routine_entries re \
         WHERE NOT EXISTS (SELECT 1 FROM exercises e WHERE e.id = re.exercise_id)",
    )
    .fetch_one(&db.pool)
    .await
    .expect("count routine orphans");
    assert_eq!(routine_orphans, 0);

    // The FKs are deferrable but initially immediate, and the rekeyed
    // children left no dangling references.
    let constraints: Vec<(String, bool, bool)> = sqlx::query_as(
        "SELECT conname, condeferrable, condeferred FROM pg_constraint \
         WHERE conname IN ('exercise_entries_exercise_id_fkey', \
                           'routine_entries_exercise_id_fkey') \
         ORDER BY conname",
    )
    .fetch_all(&db.pool)
    .await
    .expect("read constraints");
    assert_eq!(constraints.len(), 2);
    for (name, deferrable, deferred) in constraints {
        assert!(deferrable, "{name} must be deferrable");
        assert!(!deferred, "{name} must be initially immediate");
    }

    // Custom exercises now participate in pull: the column, trigger, and
    // owner index landed.
    let has_column: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns \
         WHERE table_schema = 'public' AND table_name = 'exercises' \
           AND column_name = 'applied_at')",
    )
    .fetch_one(&db.pool)
    .await
    .expect("check applied_at");
    assert!(has_column, "exercises.applied_at must exist");
    let has_trigger: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM pg_trigger \
         WHERE tgname = 'exercises_applied_at' AND NOT tgisinternal)",
    )
    .fetch_one(&db.pool)
    .await
    .expect("check trigger");
    assert!(has_trigger, "the stamp_applied_at trigger must be attached");
    let index_def: String = sqlx::query_scalar(
        "SELECT indexdef FROM pg_indexes \
         WHERE schemaname = 'public' AND indexname = 'exercises_sync_idx'",
    )
    .fetch_one(&db.pool)
    .await
    .expect("read index");
    assert!(
        index_def.contains("(owner_id, applied_at, id)"),
        "pull index mismatch: {index_def}"
    );

    drop_scratch(db).await;
}

#[tokio::test]
async fn migration_0006_is_reentrant() {
    let db = skip_without_db!();
    run_files(&db.pool, BEFORE).await;
    seed_children(&db.pool).await;
    run_files(&db.pool, &[CONVERGENCE]).await;
    let first = snapshot(&db.pool).await;

    // A second run of the whole file must be a no-op: guards pass, every
    // remap UPDATE matches zero rows, ids and counts stand.
    run_files(&db.pool, &[CONVERGENCE]).await;
    let second = snapshot(&db.pool).await;

    assert_eq!(first.globals, second.globals, "ids must not move twice");
    assert_eq!(first.links, second.links, "children must not move twice");
    assert_eq!(first.global_count, second.global_count);
    assert_eq!(first.entry_count, second.entry_count);
    assert_eq!(first.routine_entry_count, second.routine_entry_count);

    drop_scratch(db).await;
}
