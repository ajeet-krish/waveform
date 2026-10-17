//! Read-only aggregate queries behind the social boards.
//!
//! Each function returns raw per-member numbers for one trailing window
//! (`start` through `end`, inclusive) so the pure ranking in
//! `waveform-analytics` can order them. Every query is scoped to
//! non-tombstoned users and non-tombstoned rows, and every metric is
//! grouped by the owning user.
//!
//! Privacy: [`latest_bodyweight`] reads `body_stats.weight_kg` only so the
//! handler can divide it out server-side. The bodyweight never travels in
//! a response, no other query here touches `body_stats`, and the relative
//! board rounds its ratio so the divisor is only approximately recoverable
//! from the published absolute board (docs/decisions.md 2026-10-16
//! "Relative e1RM board rounds the ratio").

use chrono::NaiveDate;
use sqlx::PgPool;
use uuid::Uuid;

use crate::models::PublicUser;

/// One active day is a local date with a workout session or an activity.
/// Both branches dedupe on `(user_id, local_date)` before counting.
const ACTIVE_DAY_ROWS: &str = "SELECT user_id, local_date FROM workout_sessions \
     WHERE deleted_at IS NULL AND local_date BETWEEN $1 AND $2 \
     UNION \
     SELECT user_id, local_date FROM activities \
     WHERE deleted_at IS NULL AND local_date BETWEEN $1 AND $2";

/// Every live member of the implicit crew, ordered for a stable response.
pub async fn crew(pool: &PgPool) -> Result<Vec<PublicUser>, sqlx::Error> {
    sqlx::query_as::<_, PublicUser>(
        "SELECT id, display_name, avatar_url FROM users \
         WHERE deleted_at IS NULL ORDER BY display_name, id",
    )
    .fetch_all(pool)
    .await
}

/// Active days per member across the window, counting each local date
/// once whether it holds a workout session, an activity, or both.
pub async fn active_days(
    pool: &PgPool,
    start: NaiveDate,
    end: NaiveDate,
) -> Result<Vec<(Uuid, i32)>, sqlx::Error> {
    let sql = format!(
        "SELECT days.user_id, count(DISTINCT days.local_date)::int AS active_days \
         FROM ({ACTIVE_DAY_ROWS}) AS days \
         JOIN users u ON u.id = days.user_id AND u.deleted_at IS NULL \
         GROUP BY days.user_id"
    );
    sqlx::query_as::<_, (Uuid, i32)>(&sql)
        .bind(start)
        .bind(end)
        .fetch_all(pool)
        .await
}

/// Per-week active-day counts for the Consistency streak: one row per
/// member and Monday-start week present in the window.
pub async fn weekly_active_days(
    pool: &PgPool,
    start: NaiveDate,
    end: NaiveDate,
) -> Result<Vec<(Uuid, NaiveDate, i32)>, sqlx::Error> {
    let sql = format!(
        "SELECT days.user_id, date_trunc('week', days.local_date)::date AS week_start, \
                count(DISTINCT days.local_date)::int AS active_days \
         FROM ({ACTIVE_DAY_ROWS}) AS days \
         JOIN users u ON u.id = days.user_id AND u.deleted_at IS NULL \
         GROUP BY days.user_id, date_trunc('week', days.local_date)::date \
         ORDER BY days.user_id, week_start"
    );
    sqlx::query_as::<_, (Uuid, NaiveDate, i32)>(&sql)
        .bind(start)
        .bind(end)
        .fetch_all(pool)
        .await
}

/// Lifting volume per member in the window: `sum(weight_kg * reps)` over
/// working sets (warmups excluded), matching the analytics volume metric.
pub async fn lifting_volume(
    pool: &PgPool,
    start: NaiveDate,
    end: NaiveDate,
) -> Result<Vec<(Uuid, f64)>, sqlx::Error> {
    sqlx::query_as::<_, (Uuid, f64)>(
        "SELECT ws.user_id, COALESCE(sum(se.weight_kg * se.reps), 0)::float8 AS volume_kg \
         FROM set_entries se \
         JOIN exercise_entries ee ON ee.id = se.exercise_entry_id \
         JOIN workout_sessions ws ON ws.id = ee.workout_id \
         JOIN users u ON u.id = ws.user_id AND u.deleted_at IS NULL \
         WHERE se.deleted_at IS NULL AND ee.deleted_at IS NULL AND ws.deleted_at IS NULL \
           AND se.is_warmup = false \
           AND ws.local_date BETWEEN $1 AND $2 \
         GROUP BY ws.user_id",
    )
    .bind(start)
    .bind(end)
    .fetch_all(pool)
    .await
}

/// Best working-set e1RM per member per marquee lift in the window.
/// `aliases` and `canonicals` are parallel lists from
/// `waveform_analytics::boards::marquee_lift_alias_pairs`: a catalog name
/// whose `lower(name)` equals an alias is folded into the canonical lift
/// at the same index. A tombstoned exercise stops feeding the board.
pub async fn marquee_best_e1rm(
    pool: &PgPool,
    start: NaiveDate,
    end: NaiveDate,
    aliases: &[&str],
    canonicals: &[&str],
) -> Result<Vec<(Uuid, String, f64)>, sqlx::Error> {
    sqlx::query_as::<_, (Uuid, String, f64)>(
        "SELECT ws.user_id, m.canonical AS lift, max(se.e1rm_kg)::float8 AS best_e1rm_kg \
         FROM set_entries se \
         JOIN exercise_entries ee ON ee.id = se.exercise_entry_id \
         JOIN workout_sessions ws ON ws.id = ee.workout_id \
         JOIN exercises e ON e.id = ee.exercise_id \
         JOIN users u ON u.id = ws.user_id AND u.deleted_at IS NULL \
         CROSS JOIN unnest($3::text[], $4::text[]) AS m(alias, canonical) \
         WHERE se.deleted_at IS NULL AND ee.deleted_at IS NULL AND ws.deleted_at IS NULL \
           AND e.deleted_at IS NULL \
           AND se.is_warmup = false \
           AND ws.local_date BETWEEN $1 AND $2 \
           AND lower(e.name) = m.alias \
         GROUP BY ws.user_id, m.canonical",
    )
    .bind(start)
    .bind(end)
    .bind(aliases)
    .bind(canonicals)
    .fetch_all(pool)
    .await
}

/// Most recent bodyweight per member on or before `end`. Owner-private:
/// the handler divides by this to compute the relative-e1RM ratio and
/// never returns the weight itself.
pub async fn latest_bodyweight(
    pool: &PgPool,
    end: NaiveDate,
) -> Result<Vec<(Uuid, f64)>, sqlx::Error> {
    sqlx::query_as::<_, (Uuid, f64)>(
        "SELECT DISTINCT ON (bs.user_id) bs.user_id, bs.weight_kg::float8 AS weight_kg \
         FROM body_stats bs \
         JOIN users u ON u.id = bs.user_id AND u.deleted_at IS NULL \
         WHERE bs.deleted_at IS NULL AND bs.weight_kg IS NOT NULL AND bs.local_date <= $1 \
         ORDER BY bs.user_id, bs.local_date DESC, bs.created_at DESC",
    )
    .bind(end)
    .fetch_all(pool)
    .await
}

/// Cycling distance and elevation totals per member in the window.
pub async fn cycling_totals(
    pool: &PgPool,
    start: NaiveDate,
    end: NaiveDate,
) -> Result<Vec<(Uuid, f64, f64)>, sqlx::Error> {
    sqlx::query_as::<_, (Uuid, f64, f64)>(
        "SELECT a.user_id, COALESCE(sum(a.distance_km), 0)::float8 AS distance_km, \
                COALESCE(sum(a.elevation_m), 0)::float8 AS elevation_m \
         FROM activities a \
         JOIN users u ON u.id = a.user_id AND u.deleted_at IS NULL \
         WHERE a.deleted_at IS NULL AND a.type = 'cycling' AND a.local_date BETWEEN $1 AND $2 \
         GROUP BY a.user_id",
    )
    .bind(start)
    .bind(end)
    .fetch_all(pool)
    .await
}

/// Climbing sends per member and grade in the window: `(grade, sends)`.
/// A fractional logged grade floors to the integer V scale so a 4.5 does
/// not inflate to 5. A logged grade with a null `routes_sent` counts as
/// one send; an explicit zero stays zero; same-grade activities sum.
pub async fn climbing_sends(
    pool: &PgPool,
    start: NaiveDate,
    end: NaiveDate,
) -> Result<Vec<(Uuid, i32, i32)>, sqlx::Error> {
    sqlx::query_as::<_, (Uuid, i32, i32)>(
        "SELECT a.user_id, floor(a.climb_grade_value)::int AS grade, \
                sum(GREATEST(COALESCE(a.routes_sent, 1), 0))::int AS sends \
         FROM activities a \
         JOIN users u ON u.id = a.user_id AND u.deleted_at IS NULL \
         WHERE a.deleted_at IS NULL AND a.type = 'climbing' \
           AND a.climb_grade_value IS NOT NULL \
           AND a.local_date BETWEEN $1 AND $2 \
         GROUP BY a.user_id, floor(a.climb_grade_value)::int \
         ORDER BY a.user_id, grade",
    )
    .bind(start)
    .bind(end)
    .fetch_all(pool)
    .await
}
