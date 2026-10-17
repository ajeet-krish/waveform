//! Board aggregate query integration tests against a real Postgres.
//!
//! Covers the contract `routes/social.rs` relies on: crew scoping to live
//! users, active days across workouts and activities, per-week counts for
//! the streak, working-set volume, marquee-lift base-name matching, the
//! owner-private bodyweight read, cycling totals, and climbing sends.
//!
//! Requirements: a Postgres the test user can `CREATE DATABASE` on, e.g.
//! the compose stack from `infra/docker-compose.yml`:
//!
//! ```text
//! docker compose -f infra/docker-compose.yml up -d postgres
//! WAVEFORM_TEST_DATABASE_URL=postgres://waveform:waveform@localhost:5432/waveform \
//!     cargo test -p waveform-db --test boards_queries
//! ```
//!
//! Without the env var every test prints a skip notice and returns.

use chrono::NaiveDate;
use sqlx::PgPool;
use uuid::Uuid;

use waveform_db::queries::boards;

mod support;

fn date(y: i32, m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(y, m, d).expect("valid date")
}

/// A live user with a unique email.
async fn insert_user(pool: &PgPool, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)")
        .bind(id)
        .bind(format!("{id}@boards.test"))
        .bind(name)
        .execute(pool)
        .await
        .expect("insert user");
    id
}

async fn insert_workout(pool: &PgPool, user_id: Uuid, local_date: NaiveDate) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO workout_sessions (id, user_id, local_date) VALUES ($1, $2, $3)")
        .bind(id)
        .bind(user_id)
        .bind(local_date)
        .execute(pool)
        .await
        .expect("insert workout");
    id
}

async fn insert_exercise(pool: &PgPool, owner_id: Option<Uuid>, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO exercises (id, owner_id, name, muscle_group) VALUES ($1, $2, $3, 'test')",
    )
    .bind(id)
    .bind(owner_id)
    .bind(name)
    .execute(pool)
    .await
    .expect("insert exercise");
    id
}

async fn insert_entry(pool: &PgPool, workout_id: Uuid, exercise_id: Uuid) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO exercise_entries (id, workout_id, exercise_id) VALUES ($1, $2, $3)")
        .bind(id)
        .bind(workout_id)
        .bind(exercise_id)
        .execute(pool)
        .await
        .expect("insert exercise entry");
    id
}

async fn insert_set(
    pool: &PgPool,
    entry_id: Uuid,
    weight_kg: f64,
    reps: i32,
    warmup: bool,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO set_entries (id, exercise_entry_id, set_index, weight_kg, reps, is_warmup) \
         VALUES ($1, $2, 0, $3, $4, $5)",
    )
    .bind(id)
    .bind(entry_id)
    .bind(weight_kg)
    .bind(reps)
    .bind(warmup)
    .execute(pool)
    .await
    .expect("insert set");
    id
}

async fn insert_cycling(
    pool: &PgPool,
    user_id: Uuid,
    local_date: NaiveDate,
    distance_km: f64,
    elevation_m: f64,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO activities \
         (id, user_id, type, local_date, distance_km, elevation_m) \
         VALUES ($1, $2, 'cycling', $3, $4, $5)",
    )
    .bind(id)
    .bind(user_id)
    .bind(local_date)
    .bind(distance_km)
    .bind(elevation_m)
    .execute(pool)
    .await
    .expect("insert cycling activity");
    id
}

async fn insert_climbing(
    pool: &PgPool,
    user_id: Uuid,
    local_date: NaiveDate,
    grade: Option<f64>,
    routes_sent: Option<i32>,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO activities \
         (id, user_id, type, local_date, climb_grade_value, routes_sent) \
         VALUES ($1, $2, 'climbing', $3, $4, $5)",
    )
    .bind(id)
    .bind(user_id)
    .bind(local_date)
    .bind(grade)
    .bind(routes_sent)
    .execute(pool)
    .await
    .expect("insert climbing activity");
    id
}

async fn insert_bodyweight(
    pool: &PgPool,
    user_id: Uuid,
    local_date: NaiveDate,
    weight_kg: f64,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO body_stats (id, user_id, local_date, weight_kg) VALUES ($1, $2, $3, $4)",
    )
    .bind(id)
    .bind(user_id)
    .bind(local_date)
    .bind(weight_kg)
    .execute(pool)
    .await
    .expect("insert bodyweight");
    id
}

/// Soft-delete one row. `table` is always a test-local literal.
async fn tombstone(pool: &PgPool, table: &str, id: Uuid) {
    sqlx::query(&format!(
        "UPDATE {table} SET deleted_at = now() WHERE id = $1"
    ))
    .bind(id)
    .execute(pool)
    .await
    .expect("tombstone row");
}

#[tokio::test]
async fn crew_lists_only_live_users() {
    let Some(db) = support::migrated_scratch("boards crew").await else {
        return;
    };
    let live = insert_user(&db.pool, "Live").await;
    let ghost = insert_user(&db.pool, "Ghost").await;
    sqlx::query("UPDATE users SET deleted_at = now() WHERE id = $1")
        .bind(ghost)
        .execute(&db.pool)
        .await
        .expect("tombstone user");

    let members = boards::crew(&db.pool).await.expect("crew");
    assert_eq!(members.len(), 1);
    assert_eq!(members[0].id, live);
    assert_eq!(members[0].display_name, "Live");

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn active_days_count_distinct_dates_across_sources() {
    let Some(db) = support::migrated_scratch("boards active days").await else {
        return;
    };
    let user = insert_user(&db.pool, "Active").await;
    let other = insert_user(&db.pool, "Other").await;
    let start = date(2026, 1, 5);
    let end = date(2026, 1, 18);

    // Day A has both a workout and an activity: one active day.
    insert_workout(&db.pool, user, date(2026, 1, 6)).await;
    insert_cycling(&db.pool, user, date(2026, 1, 6), 20.0, 0.0).await;
    // Day B has one activity.
    insert_cycling(&db.pool, user, date(2026, 1, 8), 10.0, 0.0).await;
    // Outside the window.
    insert_workout(&db.pool, user, date(2025, 12, 1)).await;
    // Another user inside the window.
    insert_workout(&db.pool, other, date(2026, 1, 7)).await;

    let rows: std::collections::HashMap<Uuid, i32> = boards::active_days(&db.pool, start, end)
        .await
        .expect("active days")
        .into_iter()
        .collect();
    assert_eq!(rows.get(&user).copied(), Some(2));
    assert_eq!(rows.get(&other).copied(), Some(1));

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn weekly_active_days_group_on_monday_start() {
    let Some(db) = support::migrated_scratch("boards weekly").await else {
        return;
    };
    let user = insert_user(&db.pool, "Weekly").await;
    // 2026-01-05 is a Monday; 2026-01-11 the Sunday that closes it.
    insert_workout(&db.pool, user, date(2026, 1, 5)).await;
    insert_workout(&db.pool, user, date(2026, 1, 6)).await;
    insert_workout(&db.pool, user, date(2026, 1, 12)).await;

    let rows = boards::weekly_active_days(&db.pool, date(2026, 1, 1), date(2026, 1, 18))
        .await
        .expect("weekly active days");
    assert_eq!(
        rows,
        vec![(user, date(2026, 1, 5), 2), (user, date(2026, 1, 12), 1),]
    );

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn lifting_volume_sums_working_sets_only() {
    let Some(db) = support::migrated_scratch("boards volume").await else {
        return;
    };
    let user = insert_user(&db.pool, "Lifter").await;
    let exercise = insert_exercise(&db.pool, Some(user), "Back Squat").await;
    let workout = insert_workout(&db.pool, user, date(2026, 1, 6)).await;
    let entry = insert_entry(&db.pool, workout, exercise).await;
    insert_set(&db.pool, entry, 100.0, 5, false).await;
    insert_set(&db.pool, entry, 100.0, 5, false).await;
    // A warmup must not count.
    insert_set(&db.pool, entry, 60.0, 5, true).await;

    let rows: std::collections::HashMap<Uuid, f64> =
        boards::lifting_volume(&db.pool, date(2026, 1, 1), date(2026, 1, 18))
            .await
            .expect("volume")
            .into_iter()
            .collect();
    assert_eq!(rows.get(&user).copied(), Some(1000.0));

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn marquee_best_e1rm_matches_catalog_aliases() {
    let Some(db) = support::migrated_scratch("boards marquee").await else {
        return;
    };
    let user = insert_user(&db.pool, "Bench").await;
    // The catalog carries an equipment suffix; it still belongs to the
    // base "Bench Press" lift. Custom-owned rows avoid the global
    // lower(name) uniqueness of the seeded catalog.
    let bench = insert_exercise(&db.pool, Some(user), "Bench Press (Barbell)").await;
    let squat = insert_exercise(&db.pool, Some(user), "Squat (Barbell)").await;
    let workout = insert_workout(&db.pool, user, date(2026, 1, 6)).await;

    let bench_entry = insert_entry(&db.pool, workout, bench).await;
    // A heavy warmup would dominate the working set if `is_warmup` were
    // ignored; the working-set best must win.
    insert_set(&db.pool, bench_entry, 200.0, 1, true).await;
    insert_set(&db.pool, bench_entry, 80.0, 5, false).await;
    let squat_entry = insert_entry(&db.pool, workout, squat).await;
    insert_set(&db.pool, squat_entry, 120.0, 3, false).await;

    let aliases = [
        "squat (barbell)",
        "back squat",
        "bench press (barbell)",
        "bench press",
        "deadlift (barbell)",
        "deadlift",
        "overhead press (barbell)",
        "overhead press",
    ];
    let canonicals = [
        "Back Squat",
        "Back Squat",
        "Bench Press",
        "Bench Press",
        "Deadlift",
        "Deadlift",
        "Overhead Press",
        "Overhead Press",
    ];
    let rows = boards::marquee_best_e1rm(
        &db.pool,
        date(2026, 1, 1),
        date(2026, 1, 18),
        &aliases,
        &canonicals,
    )
    .await
    .expect("marquee e1rm");

    let bench_row = rows
        .iter()
        .find(|(_, lift, _)| lift == "Bench Press")
        .expect("bench row");
    assert_eq!(bench_row.0, user);
    // 80 kg for 5 reps, Brzycki: 80 / (1.0278 - 0.0278 * 5) ~= 89.99.
    assert!((bench_row.2 - 89.99).abs() < 0.1, "got {}", bench_row.2);
    assert!(
        rows.iter().any(|(_, lift, _)| lift == "Back Squat"),
        "the squat maps onto the Back Squat board"
    );
    assert!(
        !rows.iter().any(|(_, lift, _)| lift == "Deadlift"),
        "no deadlift sets means no deadlift row"
    );

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn latest_bodyweight_is_the_most_recent_per_user() {
    let Some(db) = support::migrated_scratch("boards bodyweight").await else {
        return;
    };
    let user = insert_user(&db.pool, "Body").await;
    sqlx::query(
        "INSERT INTO body_stats (id, user_id, local_date, weight_kg) VALUES ($1, $2, $3, $4)",
    )
    .bind(Uuid::new_v4())
    .bind(user)
    .bind(date(2026, 1, 1))
    .bind(70.0)
    .execute(&db.pool)
    .await
    .expect("insert early weight");
    sqlx::query(
        "INSERT INTO body_stats (id, user_id, local_date, weight_kg) VALUES ($1, $2, $3, $4)",
    )
    .bind(Uuid::new_v4())
    .bind(user)
    .bind(date(2026, 1, 10))
    .bind(72.5)
    .execute(&db.pool)
    .await
    .expect("insert late weight");

    let rows: std::collections::HashMap<Uuid, f64> =
        boards::latest_bodyweight(&db.pool, date(2026, 1, 18))
            .await
            .expect("bodyweight")
            .into_iter()
            .collect();
    assert_eq!(rows.get(&user).copied(), Some(72.5));

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn cycling_totals_sum_distance_and_elevation() {
    let Some(db) = support::migrated_scratch("boards cycling").await else {
        return;
    };
    let user = insert_user(&db.pool, "Rider").await;
    insert_cycling(&db.pool, user, date(2026, 1, 6), 30.0, 400.0).await;
    insert_cycling(&db.pool, user, date(2026, 1, 8), 20.0, 250.0).await;
    // A climb is not cycling.
    insert_climbing(&db.pool, user, date(2026, 1, 9), Some(4.0), Some(2)).await;

    let rows: std::collections::HashMap<Uuid, (f64, f64)> =
        boards::cycling_totals(&db.pool, date(2026, 1, 1), date(2026, 1, 18))
            .await
            .expect("cycling totals")
            .into_iter()
            .map(|(id, distance, elevation)| (id, (distance, elevation)))
            .collect();
    assert_eq!(rows.get(&user).copied(), Some((50.0, 650.0)));

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn climbing_sends_report_grade_and_count() {
    let Some(db) = support::migrated_scratch("boards climbing").await else {
        return;
    };
    let user = insert_user(&db.pool, "Climber").await;
    insert_climbing(&db.pool, user, date(2026, 1, 6), Some(4.0), Some(3)).await;
    // A null routes_sent counts as one send.
    insert_climbing(&db.pool, user, date(2026, 1, 7), Some(2.0), None).await;
    // An ungraded climb contributes no sends.
    insert_climbing(&db.pool, user, date(2026, 1, 8), None, Some(5)).await;

    let rows = boards::climbing_sends(&db.pool, date(2026, 1, 1), date(2026, 1, 18))
        .await
        .expect("climbing sends");
    assert_eq!(rows, vec![(user, 2, 1), (user, 4, 3)]);

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn marquee_best_e1rm_excludes_tombstoned_exercises() {
    let Some(db) = support::migrated_scratch("boards marquee tombstones").await else {
        return;
    };
    let user = insert_user(&db.pool, "Ghost lift").await;
    let live = insert_exercise(&db.pool, Some(user), "Bench Press (Barbell)").await;
    let dead = insert_exercise(&db.pool, Some(user), "Deadlift (Barbell)").await;
    let workout = insert_workout(&db.pool, user, date(2026, 1, 6)).await;
    let live_entry = insert_entry(&db.pool, workout, live).await;
    insert_set(&db.pool, live_entry, 80.0, 5, false).await;
    let dead_entry = insert_entry(&db.pool, workout, dead).await;
    insert_set(&db.pool, dead_entry, 200.0, 1, false).await;
    tombstone(&db.pool, "exercises", dead).await;

    let aliases = [
        "squat (barbell)",
        "back squat",
        "bench press (barbell)",
        "bench press",
        "deadlift (barbell)",
        "deadlift",
        "overhead press (barbell)",
        "overhead press",
    ];
    let canonicals = [
        "Back Squat",
        "Back Squat",
        "Bench Press",
        "Bench Press",
        "Deadlift",
        "Deadlift",
        "Overhead Press",
        "Overhead Press",
    ];
    let rows = boards::marquee_best_e1rm(
        &db.pool,
        date(2026, 1, 1),
        date(2026, 1, 18),
        &aliases,
        &canonicals,
    )
    .await
    .expect("marquee e1rm");

    assert!(rows.iter().any(|(_, lift, _)| lift == "Bench Press"));
    assert!(
        !rows.iter().any(|(_, lift, _)| lift == "Deadlift"),
        "a tombstoned exercise must not feed the marquee: {rows:?}"
    );

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn tombstoned_rows_never_move_a_board_number() {
    let Some(db) = support::migrated_scratch("boards tombstones").await else {
        return;
    };
    let start = date(2026, 1, 1);
    let end = date(2026, 1, 18);
    let user = insert_user(&db.pool, "Live").await;

    // Live rows: one of each kind the boards read.
    let exercise = insert_exercise(&db.pool, Some(user), "Back Squat").await;
    let workout = insert_workout(&db.pool, user, date(2026, 1, 6)).await;
    let entry = insert_entry(&db.pool, workout, exercise).await;
    insert_set(&db.pool, entry, 100.0, 5, false).await;
    insert_cycling(&db.pool, user, date(2026, 1, 6), 30.0, 400.0).await;
    insert_climbing(&db.pool, user, date(2026, 1, 7), Some(4.0), Some(2)).await;
    insert_bodyweight(&db.pool, user, date(2026, 1, 5), 70.0).await;

    // Tombstoned rows of every kind, each of which would move a number if
    // its deleted_at filter were missing.
    let dead_workout = insert_workout(&db.pool, user, date(2026, 1, 8)).await;
    let dead_entry = insert_entry(&db.pool, workout, exercise).await;
    insert_set(&db.pool, dead_entry, 70.0, 5, false).await;
    let entry_with_dead_set = insert_entry(&db.pool, workout, exercise).await;
    let dead_set = insert_set(&db.pool, entry_with_dead_set, 70.0, 5, false).await;
    let dead_activity = insert_cycling(&db.pool, user, date(2026, 1, 9), 100.0, 1000.0).await;
    let dead_bodyweight = insert_bodyweight(&db.pool, user, date(2026, 1, 10), 99.9).await;

    tombstone(&db.pool, "workout_sessions", dead_workout).await;
    tombstone(&db.pool, "exercise_entries", dead_entry).await;
    tombstone(&db.pool, "set_entries", dead_set).await;
    tombstone(&db.pool, "activities", dead_activity).await;
    tombstone(&db.pool, "body_stats", dead_bodyweight).await;

    let crew = boards::crew(&db.pool).await.expect("crew");
    assert_eq!(crew.len(), 1, "only the live user is in the crew");

    let active: std::collections::HashMap<Uuid, i32> = boards::active_days(&db.pool, start, end)
        .await
        .expect("active days")
        .into_iter()
        .collect();
    assert_eq!(active.get(&user).copied(), Some(2));

    let weekly = boards::weekly_active_days(&db.pool, start, end)
        .await
        .expect("weekly active days");
    assert_eq!(weekly, vec![(user, date(2026, 1, 5), 2)]);

    let volume: std::collections::HashMap<Uuid, f64> = boards::lifting_volume(&db.pool, start, end)
        .await
        .expect("volume")
        .into_iter()
        .collect();
    assert_eq!(volume.get(&user).copied(), Some(500.0));

    let aliases = [
        "squat (barbell)",
        "back squat",
        "bench press (barbell)",
        "bench press",
        "deadlift (barbell)",
        "deadlift",
        "overhead press (barbell)",
        "overhead press",
    ];
    let canonicals = [
        "Back Squat",
        "Back Squat",
        "Bench Press",
        "Bench Press",
        "Deadlift",
        "Deadlift",
        "Overhead Press",
        "Overhead Press",
    ];
    let marquee = boards::marquee_best_e1rm(&db.pool, start, end, &aliases, &canonicals)
        .await
        .expect("marquee e1rm");
    assert_eq!(marquee.len(), 1);
    assert_eq!(marquee[0].1, "Back Squat");

    let bodyweight: std::collections::HashMap<Uuid, f64> = boards::latest_bodyweight(&db.pool, end)
        .await
        .expect("bodyweight")
        .into_iter()
        .collect();
    assert_eq!(
        bodyweight.get(&user).copied(),
        Some(70.0),
        "the tombstoned 99.9 must not become the latest weight"
    );

    let cycling: std::collections::HashMap<Uuid, (f64, f64)> =
        boards::cycling_totals(&db.pool, start, end)
            .await
            .expect("cycling totals")
            .into_iter()
            .map(|(id, distance, elevation)| (id, (distance, elevation)))
            .collect();
    assert_eq!(cycling.get(&user).copied(), Some((30.0, 400.0)));

    let climbing = boards::climbing_sends(&db.pool, start, end)
        .await
        .expect("climbing sends");
    assert_eq!(climbing, vec![(user, 4, 2)]);

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn climbing_sends_group_by_member_and_grade() {
    let Some(db) = support::migrated_scratch("boards climbing group").await else {
        return;
    };
    let user = insert_user(&db.pool, "Climber").await;
    let other = insert_user(&db.pool, "Other").await;
    // The same grade on two activities sums into one row per member.
    insert_climbing(&db.pool, user, date(2026, 1, 6), Some(4.0), Some(2)).await;
    insert_climbing(&db.pool, user, date(2026, 1, 7), Some(4.0), Some(3)).await;
    insert_climbing(&db.pool, user, date(2026, 1, 8), Some(2.0), Some(1)).await;
    insert_climbing(&db.pool, other, date(2026, 1, 6), Some(4.0), Some(5)).await;

    let rows: std::collections::HashMap<(Uuid, i32), i32> =
        boards::climbing_sends(&db.pool, date(2026, 1, 1), date(2026, 1, 18))
            .await
            .expect("climbing sends")
            .into_iter()
            .map(|(id, grade, sends)| ((id, grade), sends))
            .collect();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows.get(&(user, 4)).copied(), Some(5));
    assert_eq!(rows.get(&(user, 2)).copied(), Some(1));
    assert_eq!(rows.get(&(other, 4)).copied(), Some(5));

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn climbing_sends_floor_fractional_grades() {
    let Some(db) = support::migrated_scratch("boards climbing floor").await else {
        return;
    };
    let user = insert_user(&db.pool, "Climber").await;
    // 4.5 floors to 4 and merges with the 4.0 send instead of rounding
    // up to V5 and inflating V-points and hardest grade.
    insert_climbing(&db.pool, user, date(2026, 1, 6), Some(4.5), Some(2)).await;
    insert_climbing(&db.pool, user, date(2026, 1, 7), Some(4.0), Some(1)).await;

    let rows = boards::climbing_sends(&db.pool, date(2026, 1, 1), date(2026, 1, 18))
        .await
        .expect("climbing sends");
    assert_eq!(rows, vec![(user, 4, 3)]);

    support::drop_scratch(db).await;
}
