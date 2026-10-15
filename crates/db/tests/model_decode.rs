//! Model decode and hardening integration tests against a real Postgres.
//!
//! The phase 0 review (docs/reviews.md, High) found that SQLx 0.8 cannot
//! decode Postgres NUMERIC into Rust f64, so every float measurement column
//! was moved to `double precision` in migrations/0003_hardening.sql. These
//! tests prove the fix the way the review demanded: insert rows through raw
//! SQL, read them back with `query_as` into the shared models, and assert
//! the values survive. They also pin the 0003 hardening semantics the sync
//! contract relies on (server-stamped `applied_at`, composite pull paging
//! with tombstones) and the new constraints.
//!
//! Requirements: a Postgres the test user can `CREATE DATABASE` on, e.g. the
//! compose stack from `infra/docker-compose.yml`:
//!
//! ```text
//! docker compose -f infra/docker-compose.yml up -d postgres
//! LIFTLOG_TEST_DATABASE_URL=postgres://liftlog:liftlog@localhost:5432/liftlog \
//!     cargo test -p liftlog-db --test model_decode
//! ```
//!
//! When the env var is missing every test prints a skip notice and returns,
//! so `cargo test --workspace` stays green without infra. Each test runs in
//! its own throwaway database, dropped on completion.

use chrono::{DateTime, Duration, NaiveDate, Utc};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use uuid::Uuid;

use liftlog_db::{Activity, BodyStats, RoutineEntry, SetEntry};

fn base_url() -> Option<String> {
    std::env::var("LIFTLOG_TEST_DATABASE_URL")
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
                     URL with CREATE DATABASE rights to run model decode tests"
                );
                return;
            }
        }
    };
}

fn local_date() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 10, 14).expect("valid date")
}

/// The Unix epoch cursor every pull starts from.
fn epoch() -> DateTime<Utc> {
    DateTime::from_timestamp(0, 0).expect("epoch timestamp")
}

/// Seed the user, exercise, workout, and exercise entry that the synced
/// rows hang off, plus a routine for routine entries.
async fn seed_scaffold(pool: &PgPool) -> (Uuid, Uuid, Uuid, Uuid, Uuid) {
    let user_id = Uuid::new_v4();
    let exercise_id = Uuid::new_v4();
    let workout_id = Uuid::new_v4();
    let entry_id = Uuid::new_v4();
    let routine_id = Uuid::new_v4();

    sqlx::query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)")
        .bind(user_id)
        .bind(format!("{user_id}@test.invalid"))
        .bind("Decode Tester")
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

    sqlx::query("INSERT INTO workout_sessions (id, user_id, local_date) VALUES ($1, $2, $3)")
        .bind(workout_id)
        .bind(user_id)
        .bind(local_date())
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

    sqlx::query("INSERT INTO routines (id, user_id, name) VALUES ($1, $2, 'Push day')")
        .bind(routine_id)
        .bind(user_id)
        .execute(pool)
        .await
        .expect("insert routine");

    (user_id, exercise_id, workout_id, entry_id, routine_id)
}

#[tokio::test]
async fn float_measurement_models_decode_from_double_precision() {
    let db = skip_without_db!();
    liftlog_db::run_migrations(&db.pool).await.expect("migrate");
    let (user_id, exercise_id, _workout_id, entry_id, routine_id) = seed_scaffold(&db.pool).await;

    // A working set: the generated e1rm_kg column must decode as f64 too.
    let set_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO set_entries (id, exercise_entry_id, set_index, weight_kg, reps) \
         VALUES ($1, $2, 0, $3, 5)",
    )
    .bind(set_id)
    .bind(entry_id)
    .bind(102.5_f64)
    .execute(&db.pool)
    .await
    .expect("insert set");

    // A cycling activity with floats, and a climbing one with a grade.
    let ride_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO activities (id, user_id, type, local_date, duration_min, distance_km, elevation_m) \
         VALUES ($1, $2, 'cycling', $3, 90, $4, $5)",
    )
    .bind(ride_id)
    .bind(user_id)
    .bind(local_date())
    .bind(42.75_f64)
    .bind(850.25_f64)
    .execute(&db.pool)
    .await
    .expect("insert ride");

    let climb_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO activities (id, user_id, type, local_date, climb_grade, climb_grade_value, routes_sent) \
         VALUES ($1, $2, 'climbing', $3, 'V4', $4, 7)",
    )
    .bind(climb_id)
    .bind(user_id)
    .bind(local_date())
    .bind(4.5_f64)
    .execute(&db.pool)
    .await
    .expect("insert climb");

    // Body stats: every circumference column is a float.
    let body_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO body_stats \
         (id, user_id, local_date, weight_kg, bodyfat_pct, neck_cm, shoulders_cm, chest_cm, \
          bicep_cm, waist_cm, hips_cm, thigh_cm, calf_cm) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
    )
    .bind(body_id)
    .bind(user_id)
    .bind(local_date())
    .bind(82.5_f64)
    .bind(14.25_f64)
    .bind(38.5_f64)
    .bind(120.75_f64)
    .bind(100.5_f64)
    .bind(36.75_f64)
    .bind(82.5_f64)
    .bind(95.5_f64)
    .bind(60.25_f64)
    .bind(39.75_f64)
    .execute(&db.pool)
    .await
    .expect("insert body stats");

    // A routine entry with a float target weight.
    let routine_entry_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO routine_entries (id, routine_id, exercise_id, target_weight_kg) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(routine_entry_id)
    .bind(routine_id)
    .bind(exercise_id)
    .bind(60.5_f64)
    .execute(&db.pool)
    .await
    .expect("insert routine entry");

    let set = sqlx::query_as::<_, SetEntry>("SELECT * FROM set_entries WHERE id = $1")
        .bind(set_id)
        .fetch_one(&db.pool)
        .await
        .expect("decode SetEntry");
    assert_eq!(set.weight_kg, 102.5);
    assert_eq!(set.reps, 5);
    assert!(!set.is_warmup);
    let expected_e1rm = liftlog_scoring::e1rm_brzycki(102.5, 5);
    assert!(
        (set.e1rm_kg - expected_e1rm).abs() < 1e-9,
        "generated e1rm_kg {} must match Rust scoring {expected_e1rm}",
        set.e1rm_kg
    );

    let ride = sqlx::query_as::<_, Activity>("SELECT * FROM activities WHERE id = $1")
        .bind(ride_id)
        .fetch_one(&db.pool)
        .await
        .expect("decode cycling Activity");
    assert_eq!(ride.duration_min, Some(90));
    assert_eq!(ride.distance_km, Some(42.75));
    assert_eq!(ride.elevation_m, Some(850.25));
    assert_eq!(ride.climb_grade_value, None);

    let climb = sqlx::query_as::<_, Activity>("SELECT * FROM activities WHERE id = $1")
        .bind(climb_id)
        .fetch_one(&db.pool)
        .await
        .expect("decode climbing Activity");
    assert_eq!(climb.climb_grade.as_deref(), Some("V4"));
    assert_eq!(climb.climb_grade_value, Some(4.5));
    assert_eq!(climb.routes_sent, Some(7));
    assert_eq!(climb.distance_km, None);

    let body = sqlx::query_as::<_, BodyStats>("SELECT * FROM body_stats WHERE id = $1")
        .bind(body_id)
        .fetch_one(&db.pool)
        .await
        .expect("decode BodyStats");
    assert_eq!(body.weight_kg, Some(82.5));
    assert_eq!(body.bodyfat_pct, Some(14.25));
    assert_eq!(body.neck_cm, Some(38.5));
    assert_eq!(body.shoulders_cm, Some(120.75));
    assert_eq!(body.chest_cm, Some(100.5));
    assert_eq!(body.bicep_cm, Some(36.75));
    assert_eq!(body.waist_cm, Some(82.5));
    assert_eq!(body.hips_cm, Some(95.5));
    assert_eq!(body.thigh_cm, Some(60.25));
    assert_eq!(body.calf_cm, Some(39.75));

    let routine_entry =
        sqlx::query_as::<_, RoutineEntry>("SELECT * FROM routine_entries WHERE id = $1")
            .bind(routine_entry_id)
            .fetch_one(&db.pool)
            .await
            .expect("decode RoutineEntry");
    assert_eq!(routine_entry.target_weight_kg, Some(60.5));

    drop_scratch(db).await;
}

#[tokio::test]
async fn pull_pages_on_applied_at_with_server_stamps_and_tombstones() {
    let db = skip_without_db!();
    liftlog_db::run_migrations(&db.pool).await.expect("migrate");
    let (_user, _exercise, _workout, entry_id, _) = seed_scaffold(&db.pool).await;

    // A hostile or skewed client tries to write a future applied_at; the
    // trigger forces it back to the server clock, so the pull cursor can
    // never be poisoned. updated_at stays client-owned for LWW.
    let future = "2099-01-01T00:00:00+00:00";
    let skewed_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO set_entries \
         (id, exercise_entry_id, set_index, weight_kg, reps, updated_at, applied_at) \
         VALUES ($1, $2, 0, 100, 5, $3::timestamptz, $3::timestamptz)",
    )
    .bind(skewed_id)
    .bind(entry_id)
    .bind(future)
    .execute(&db.pool)
    .await
    .expect("insert with client-supplied applied_at");

    let second_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO set_entries (id, exercise_entry_id, set_index, weight_kg, reps) \
         VALUES ($1, $2, 1, 60, 5)",
    )
    .bind(second_id)
    .bind(entry_id)
    .execute(&db.pool)
    .await
    .expect("insert second set");

    let third_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO set_entries (id, exercise_entry_id, set_index, weight_kg, reps) \
         VALUES ($1, $2, 2, 70, 5)",
    )
    .bind(third_id)
    .bind(entry_id)
    .execute(&db.pool)
    .await
    .expect("insert third set");

    // The trigger overrode the client-supplied future applied_at.
    let stamps: (DateTime<Utc>, DateTime<Utc>) =
        sqlx::query_as("SELECT applied_at, updated_at FROM set_entries WHERE id = $1")
            .bind(skewed_id)
            .fetch_one(&db.pool)
            .await
            .expect("read stamps");
    let now = Utc::now();
    assert!(
        stamps.0 < now + Duration::seconds(2),
        "applied_at must be server-stamped, got {}",
        stamps.0
    );
    let expected_client_time = DateTime::parse_from_rfc3339(future)
        .expect("rfc3339")
        .with_timezone(&Utc);
    assert_eq!(stamps.1, expected_client_time);

    // Pull pages on (applied_at, id): the future updated_at did not hide
    // the row from a fresh cursor, and paging never drops ties.
    let page_one = sqlx::query_as::<_, SetEntry>(
        "SELECT * FROM set_entries \
         WHERE exercise_entry_id = $1 AND (applied_at, id) > ($2, $3) \
         ORDER BY applied_at, id LIMIT 2",
    )
    .bind(entry_id)
    .bind(epoch())
    .bind(Uuid::nil())
    .fetch_all(&db.pool)
    .await
    .expect("pull page one");
    assert_eq!(page_one.len(), 2);
    assert_eq!(page_one[0].id, skewed_id, "future updated_at still pulled");
    let last = page_one.last().expect("page one is not empty");

    let page_two = sqlx::query_as::<_, SetEntry>(
        "SELECT * FROM set_entries \
         WHERE exercise_entry_id = $1 AND (applied_at, id) > ($2, $3) \
         ORDER BY applied_at, id LIMIT 2",
    )
    .bind(entry_id)
    .bind(last.applied_at)
    .bind(last.id)
    .fetch_all(&db.pool)
    .await
    .expect("pull page two");
    assert_eq!(page_two.len(), 1, "the third row lands on page two");
    assert_eq!(page_two[0].id, third_id);

    // Tombstoning advances applied_at through the trigger, so the delete
    // shows up on the next pull for clients that already had the row.
    sqlx::query("UPDATE set_entries SET deleted_at = now() WHERE id = $1")
        .bind(third_id)
        .execute(&db.pool)
        .await
        .expect("tombstone third set");
    let page_three = sqlx::query_as::<_, SetEntry>(
        "SELECT * FROM set_entries \
         WHERE exercise_entry_id = $1 AND (applied_at, id) > ($2, $3) \
         ORDER BY applied_at, id LIMIT 2",
    )
    .bind(entry_id)
    .bind(page_two[0].applied_at)
    .bind(page_two[0].id)
    .fetch_all(&db.pool)
    .await
    .expect("pull page three");
    assert_eq!(page_three.len(), 1);
    assert_eq!(page_three[0].id, third_id);
    assert!(
        page_three[0].deleted_at.is_some(),
        "pull returns tombstones"
    );

    // The pull index is non-partial (tombstones included) and scoped.
    let index_def: String = sqlx::query_scalar(
        "SELECT indexdef FROM pg_indexes \
         WHERE schemaname = 'public' AND indexname = 'set_entries_sync_idx'",
    )
    .fetch_one(&db.pool)
    .await
    .expect("sync pull index must exist");
    assert!(
        index_def.contains("(exercise_entry_id, applied_at, id)"),
        "sync index must page on the composite pair, got: {index_def}"
    );
    assert!(
        !index_def.contains("WHERE"),
        "sync index must include tombstones, got: {index_def}"
    );

    drop_scratch(db).await;
}

#[tokio::test]
async fn hardening_constraints_hold_in_sql() {
    let db = skip_without_db!();
    liftlog_db::run_migrations(&db.pool).await.expect("migrate");
    let (user_id, exercise_id, workout_id, entry_id, routine_id) = seed_scaffold(&db.pool).await;

    // Exercise history survives exercise deletion (FK is RESTRICT).
    let delete_exercise = sqlx::query("DELETE FROM exercises WHERE id = $1")
        .bind(exercise_id)
        .execute(&db.pool)
        .await;
    assert!(
        delete_exercise.is_err(),
        "deleting an exercise with history must be restricted"
    );

    // Email uniqueness is case-insensitive: the same address with a
    // different casing collides through the lower(email) unique index.
    let upper_email = user_id.to_string().to_uppercase() + "@TEST.INVALID";
    let case_variant =
        sqlx::query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Other')")
            .bind(Uuid::new_v4())
            .bind(upper_email)
            .execute(&db.pool)
            .await;
    assert!(case_variant.is_err(), "case-variant email must be rejected");

    // Kudos uniqueness is tombstone-aware: un-kudos then re-kudos works.
    let kudos_id = Uuid::new_v4();
    sqlx::query("INSERT INTO kudos (id, workout_id, user_id) VALUES ($1, $2, $3)")
        .bind(kudos_id)
        .bind(workout_id)
        .bind(user_id)
        .execute(&db.pool)
        .await
        .expect("insert kudos");
    sqlx::query("UPDATE kudos SET deleted_at = now() WHERE id = $1")
        .bind(kudos_id)
        .execute(&db.pool)
        .await
        .expect("tombstone kudos");
    let re_kudos = sqlx::query("INSERT INTO kudos (id, workout_id, user_id) VALUES ($1, $2, $3)")
        .bind(Uuid::new_v4())
        .bind(workout_id)
        .bind(user_id)
        .execute(&db.pool)
        .await;
    assert!(
        re_kudos.is_ok(),
        "re-kudos after a tombstone must not hit a unique constraint"
    );

    // Invites always expire.
    let immortal_invite =
        sqlx::query("INSERT INTO invites (id, code_hash, created_by) VALUES ($1, 'hash', $2)")
            .bind(Uuid::new_v4())
            .bind(user_id)
            .execute(&db.pool)
            .await;
    assert!(
        immortal_invite.is_err(),
        "an invite without expires_at must be rejected"
    );

    // OTP codes: attempt cap and one live code per email.
    let otp_id = Uuid::new_v4();
    let capped_email = format!("{otp_id}@test.invalid");
    sqlx::query(
        "INSERT INTO otp_codes (id, email, code_hash, attempts, expires_at) \
         VALUES ($1, $2, 'h', 5, now() + interval '10 minutes')",
    )
    .bind(otp_id)
    .bind(&capped_email)
    .execute(&db.pool)
    .await
    .expect("insert otp at the cap");
    let over_cap = sqlx::query(
        "INSERT INTO otp_codes (id, email, code_hash, attempts, expires_at) \
         VALUES ($1, $2, 'h', 6, now() + interval '10 minutes')",
    )
    .bind(Uuid::new_v4())
    .bind(&capped_email)
    .execute(&db.pool)
    .await;
    assert!(over_cap.is_err(), "attempts above 5 must be rejected");

    let live_email = format!("live-{otp_id}@test.invalid");
    sqlx::query(
        "INSERT INTO otp_codes (id, email, code_hash, expires_at) \
         VALUES ($1, $2, 'h', now() + interval '10 minutes')",
    )
    .bind(Uuid::new_v4())
    .bind(&live_email)
    .execute(&db.pool)
    .await
    .expect("insert live otp");
    let second_live = sqlx::query(
        "INSERT INTO otp_codes (id, email, code_hash, expires_at) \
         VALUES ($1, $2, 'h', now() + interval '10 minutes')",
    )
    .bind(Uuid::new_v4())
    .bind(&live_email)
    .execute(&db.pool)
    .await;
    assert!(
        second_live.is_err(),
        "a second live code for the same email must be rejected"
    );

    // Range checks: weights, body fat, climbing grade, routes, durations.
    async fn insert_set(
        pool: &PgPool,
        entry_id: Uuid,
        weight: f64,
        reps: i32,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO set_entries (id, exercise_entry_id, set_index, weight_kg, reps) \
             VALUES ($1, $2, 9, $3, $4)",
        )
        .bind(Uuid::new_v4())
        .bind(entry_id)
        .bind(weight)
        .bind(reps)
        .execute(pool)
        .await
        .map(|_| ())
    }
    assert!(
        insert_set(&db.pool, entry_id, 1500.0, 5).await.is_ok(),
        "domain edge inserts"
    );
    assert!(
        insert_set(&db.pool, entry_id, 1500.01, 5).await.is_err(),
        "absurd weights must be rejected"
    );

    let bad_body = sqlx::query(
        "INSERT INTO body_stats (id, user_id, local_date, weight_kg, bodyfat_pct) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(local_date())
    .bind(80.0_f64)
    .bind(150.0_f64)
    .execute(&db.pool)
    .await;
    assert!(bad_body.is_err(), "body fat above 100 must be rejected");

    let bad_grade = sqlx::query(
        "INSERT INTO activities (id, user_id, type, local_date, climb_grade_value) \
         VALUES ($1, $2, 'climbing', $3, $4)",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(local_date())
    .bind(20.0_f64)
    .execute(&db.pool)
    .await;
    assert!(bad_grade.is_err(), "climb grades above 16 must be rejected");

    let bad_routes = sqlx::query(
        "INSERT INTO activities (id, user_id, type, local_date, routes_sent) \
         VALUES ($1, $2, 'climbing', $3, -1)",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(local_date())
    .execute(&db.pool)
    .await;
    assert!(bad_routes.is_err(), "negative routes_sent must be rejected");

    let bad_duration = sqlx::query(
        "INSERT INTO workout_sessions (id, user_id, local_date, duration_min) \
         VALUES ($1, $2, $3, 2000)",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(local_date())
    .execute(&db.pool)
    .await;
    assert!(
        bad_duration.is_err(),
        "durations beyond a day must be rejected"
    );

    // Routine entries share the float column conversion.
    let routine_ok = sqlx::query(
        "INSERT INTO routine_entries (id, routine_id, exercise_id, target_weight_kg) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(Uuid::new_v4())
    .bind(routine_id)
    .bind(exercise_id)
    .bind(100.25_f64)
    .execute(&db.pool)
    .await;
    assert!(routine_ok.is_ok(), "float target weights insert cleanly");

    drop_scratch(db).await;
}
