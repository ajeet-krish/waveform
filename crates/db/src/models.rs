//! Row models for the core tables.
//!
//! Conventions (docs/architecture.md): client-generated UUID primary keys so
//! offline creates never collide; `updated_at` plus a `deleted_at` tombstone
//! on every synced row, and a server-stamped `applied_at` that drives the
//! sync pull cursor (migrations/0003_hardening.sql); weights in kg and
//! lengths in cm internally; Monday weeks and device-local `local_date` for
//! grouping. Server-internal rows (sessions, OTP codes, invites) are
//! deliberately not serializable so token and code hashes can never leak
//! into a JSON response; the API returns dedicated DTOs such as
//! [`PublicUser`] for anything another user may see.

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use ts_rs::TS;
use uuid::Uuid;

/// A registered user. Signup is invite-only. Owner-only surface: renders
/// other users through [`PublicUser`] in feeds, leaderboards, and heatmaps.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export_to = "generated.ts")]
pub struct User {
    pub id: Uuid,
    pub email: String,
    pub display_name: String,
    /// Linked GitHub account for OAuth login, if any.
    pub github_id: Option<String>,
    pub avatar_url: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

/// A user as other members see them: the only fields safe for cross-user
/// surfaces (feed, leaderboard, heatmap, kudos). Never carries email or
/// GitHub identity.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export_to = "generated.ts")]
pub struct PublicUser {
    pub id: Uuid,
    pub display_name: String,
    pub avatar_url: Option<String>,
}

/// An opaque server-side session. Only the sha256 token hash is stored.
/// Not serializable: a dedicated response DTO never exposes the hash.
#[derive(Debug, Clone, FromRow)]
pub struct Session {
    pub id: Uuid,
    pub user_id: Uuid,
    pub token_hash: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

/// A hashed email OTP with attempt limiting. Not serializable.
#[derive(Debug, Clone, FromRow)]
pub struct OtpCode {
    pub id: Uuid,
    pub email: String,
    pub code_hash: String,
    pub attempts: i32,
    pub expires_at: DateTime<Utc>,
    pub consumed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

/// A single-use invite code. There is no public signup. Redemption is
/// atomic (`UPDATE ... WHERE used_by IS NULL`, migrations/0003) and a set
/// `email` binds the account it may create. Not serializable: sha256 of a
/// short code must never reach a response body.
#[derive(Debug, Clone, FromRow)]
pub struct Invite {
    pub id: Uuid,
    pub code_hash: String,
    pub email: Option<String>,
    pub created_by: Uuid,
    pub used_by: Option<Uuid>,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

/// A private friend group used for challenges and feeds.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export_to = "generated.ts")]
pub struct Group {
    pub id: Uuid,
    pub name: String,
    pub created_by: Uuid,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

/// Membership role inside a group.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type, TS)]
#[sqlx(type_name = "text", rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
#[ts(export_to = "generated.ts")]
pub enum GroupRole {
    Owner,
    Member,
}

/// Membership of a user in a group.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export_to = "generated.ts")]
pub struct GroupMember {
    pub group_id: Uuid,
    pub user_id: Uuid,
    pub role: GroupRole,
    pub joined_at: DateTime<Utc>,
}

/// An exercise: a global catalog row (`owner_id` null) or a per-user custom
/// exercise.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export_to = "generated.ts")]
pub struct Exercise {
    pub id: Uuid,
    /// Null marks a global catalog exercise visible to everyone.
    pub owner_id: Option<Uuid>,
    pub name: String,
    pub muscle_group: String,
    pub equipment: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

/// A completed (or in-progress) workout on a local date.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export_to = "generated.ts")]
pub struct WorkoutSession {
    pub id: Uuid,
    pub user_id: Uuid,
    /// Device-local calendar day; drives heatmap and history grouping.
    pub local_date: NaiveDate,
    pub started_at: Option<DateTime<Utc>>,
    pub duration_min: Option<i32>,
    /// Routine this workout was forked from, if any.
    pub routine_id: Option<Uuid>,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Server-stamped sync cursor timestamp; never client-writable.
    pub applied_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

/// One exercise slot inside a workout.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export_to = "generated.ts")]
pub struct ExerciseEntry {
    pub id: Uuid,
    pub workout_id: Uuid,
    pub exercise_id: Uuid,
    pub order_index: i32,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Server-stamped sync cursor timestamp; never client-writable.
    pub applied_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

/// A single set. `e1rm_kg` is a stored generated column (Brzycki) written by
/// Postgres, never by the client.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export_to = "generated.ts")]
pub struct SetEntry {
    pub id: Uuid,
    pub exercise_entry_id: Uuid,
    pub set_index: i32,
    pub weight_kg: f64,
    /// Reps are constrained to 1..=36 in the schema.
    pub reps: i32,
    pub is_warmup: bool,
    /// Brzycki e1RM, generated and stored by Postgres.
    pub e1rm_kg: f64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Server-stamped sync cursor timestamp; never client-writable.
    pub applied_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

/// Discipline of a non-lifting activity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type, TS)]
#[sqlx(type_name = "text", rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
#[ts(export_to = "generated.ts")]
pub enum ActivityType {
    Cycling,
    Climbing,
    Running,
    Hike,
    Swim,
}

/// A cycling, climbing, running, hike, or swim session.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export_to = "generated.ts")]
pub struct Activity {
    pub id: Uuid,
    pub user_id: Uuid,
    #[sqlx(rename = "type")]
    #[serde(rename = "type")]
    pub activity_type: ActivityType,
    pub local_date: NaiveDate,
    pub started_at: Option<DateTime<Utc>>,
    pub duration_min: Option<i32>,
    pub distance_km: Option<f64>,
    pub elevation_m: Option<f64>,
    /// Climbing grade label (for example "V4") as logged.
    pub climb_grade: Option<String>,
    /// Numeric climbing grade used for V-points (sum of `2^grade`).
    pub climb_grade_value: Option<f64>,
    /// Number of routes sent.
    pub routes_sent: Option<i32>,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Server-stamped sync cursor timestamp; never client-writable.
    pub applied_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

/// A body measurement entry. Owner-private: never included in feeds or
/// leaderboards, scoped strictly to the session user.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export_to = "generated.ts")]
pub struct BodyStats {
    pub id: Uuid,
    pub user_id: Uuid,
    pub local_date: NaiveDate,
    /// Weight in kg.
    pub weight_kg: Option<f64>,
    /// Body fat percentage.
    pub bodyfat_pct: Option<f64>,
    /// Circumferences in cm.
    pub neck_cm: Option<f64>,
    pub shoulders_cm: Option<f64>,
    pub chest_cm: Option<f64>,
    pub bicep_cm: Option<f64>,
    pub waist_cm: Option<f64>,
    pub hips_cm: Option<f64>,
    pub thigh_cm: Option<f64>,
    pub calf_cm: Option<f64>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Server-stamped sync cursor timestamp; never client-writable.
    pub applied_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

/// A reusable workout template.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export_to = "generated.ts")]
pub struct Routine {
    pub id: Uuid,
    pub user_id: Uuid,
    pub name: String,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Server-stamped sync cursor timestamp; never client-writable.
    pub applied_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

/// One planned exercise slot inside a routine.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export_to = "generated.ts")]
pub struct RoutineEntry {
    pub id: Uuid,
    pub routine_id: Uuid,
    pub exercise_id: Uuid,
    pub order_index: i32,
    pub target_sets: i32,
    pub target_reps: i32,
    pub target_weight_kg: Option<f64>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Server-stamped sync cursor timestamp; never client-writable.
    pub applied_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

/// A kudos reaction to someone else's workout. One per (workout, user).
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export_to = "generated.ts")]
pub struct Kudos {
    pub id: Uuid,
    pub workout_id: Uuid,
    pub user_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Server-stamped sync cursor timestamp; never client-writable.
    pub applied_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

/// A time-boxed group or global challenge. Scoring lands in phase 4.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export_to = "generated.ts")]
pub struct Challenge {
    pub id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub start_date: NaiveDate,
    pub end_date: NaiveDate,
    /// Optional scoping to a group; null means the whole cohort.
    pub group_id: Option<Uuid>,
    pub created_by: Uuid,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Server-stamped sync cursor timestamp; never client-writable.
    pub applied_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}
