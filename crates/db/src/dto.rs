//! Wire DTOs for the sync and auth surfaces, exported to TypeScript with
//! ts-rs (`packages/api-types/src/generated.ts`, committed; CI fails on
//! drift).
//!
//! Conventions: snake_case Rust fields serialize to the exact strings the
//! client already writes (the `OutboxEntity` union in
//! `apps/web/src/db/types.ts`), camelCase for the rule trees so they
//! deep-equal `apps/web/src/db/validation.ts`. Auth is email + password
//! with an opaque bearer token (ADR 2026-10-15): these are the request
//! and response shapes only, the signup and login handlers land in
//! bucket 2.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::models::{PublicUser, User};

/// Syncable entity names, byte for byte the client's `OutboxEntity`
/// strings plus the routine pair Phase 2 adds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export_to = "generated.ts")]
pub enum SyncEntity {
    Exercises,
    WorkoutSessions,
    ExerciseEntries,
    SetEntries,
    Activities,
    BodyStats,
    Routines,
    RoutineEntries,
}

impl SyncEntity {
    /// Every entity, in pull-safe order (parents before children).
    pub const ALL: [SyncEntity; 8] = [
        SyncEntity::Exercises,
        SyncEntity::Routines,
        SyncEntity::WorkoutSessions,
        SyncEntity::RoutineEntries,
        SyncEntity::ExerciseEntries,
        SyncEntity::SetEntries,
        SyncEntity::Activities,
        SyncEntity::BodyStats,
    ];

    /// The wire string; also the `client_ops.entity` value.
    pub fn as_str(self) -> &'static str {
        match self {
            SyncEntity::Exercises => "exercises",
            SyncEntity::WorkoutSessions => "workout_sessions",
            SyncEntity::ExerciseEntries => "exercise_entries",
            SyncEntity::SetEntries => "set_entries",
            SyncEntity::Activities => "activities",
            SyncEntity::BodyStats => "body_stats",
            SyncEntity::Routines => "routines",
            SyncEntity::RoutineEntries => "routine_entries",
        }
    }

    /// Parse the wire string; used by handlers and tests.
    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|entity| entity.as_str() == raw)
    }
}

/// One outbox op action as it travels on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export_to = "generated.ts")]
pub enum OpAction {
    Create,
    Update,
    Delete,
}

impl OpAction {
    /// The wire string; also the `client_ops.action` value.
    pub fn as_str(self) -> &'static str {
        match self {
            OpAction::Create => "create",
            OpAction::Update => "update",
            OpAction::Delete => "delete",
        }
    }
}

/// Per-op outcome reported back to the client inside `PushResponse`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export_to = "generated.ts")]
pub enum OpStatus {
    /// The incoming row replaced (or inserted) the stored row.
    Applied,
    /// The stored row is newer; the op was claimed but changed nothing.
    DiscardedStale,
    /// The same user already landed this op id; a no-op success.
    Duplicate,
    /// The payload broke a constraint or targeted foreign data; nothing
    /// was stored and the op id was not claimed.
    Rejected,
    /// A parent row has not arrived yet (or a transient failure); nothing
    /// was stored, the client may retry the same op id.
    Retryable,
}

/// One pushed op: the wire shape of a client outbox entry. `created_at`
/// is local-only and never crosses the wire.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "generated.ts")]
pub struct PushOp {
    pub op_id: Uuid,
    pub entity: SyncEntity,
    pub action: OpAction,
    /// The full row (tombstone payloads carry the full row too). Server
    /// columns (`user_id`/`owner_id`, `updated_at`, `deleted_at`,
    /// `applied_at`, `e1rm_kg`) are never trusted from here.
    #[ts(type = "Record<string, unknown>")]
    pub payload: serde_json::Value,
    /// The row's LWW timestamp; clamped server-side before it drives
    /// last-write-wins.
    pub updated_at: DateTime<Utc>,
}

/// `POST /sync/push` request body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "generated.ts")]
pub struct PushRequest {
    pub ops: Vec<PushOp>,
}

/// Outcome of one op, in request order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "generated.ts")]
pub struct OpResult {
    pub op_id: Uuid,
    pub status: OpStatus,
    /// Set for [`OpStatus::Rejected`]; `null` otherwise.
    pub error: Option<ApiErrorCode>,
}

/// `POST /sync/push` response body: one result per op, in order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "generated.ts")]
pub struct PushResponse {
    pub results: Vec<OpResult>,
}

/// One pulled row. `payload` is the stored row as JSON minus the
/// server-stamped `applied_at`, which is exposed here instead so the
/// client can echo the cursor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "generated.ts")]
pub struct PullRow {
    pub entity: SyncEntity,
    pub id: Uuid,
    pub applied_at: DateTime<Utc>,
    #[ts(type = "Record<string, unknown>")]
    pub payload: serde_json::Value,
}

/// `GET /sync/pull` response page: rows ordered by `(applied_at, id)`,
/// cursor exclusive. `next_cursor` is `null` when the page was not filled,
/// so an empty follow-up page is not required to detect the tip.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "generated.ts")]
pub struct PullPage {
    pub rows: Vec<PullRow>,
    pub next_cursor: Option<String>,
}

/// Stable machine-readable error codes; the HTTP status mapping lives in
/// `apps/api/src/error.rs`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export_to = "generated.ts")]
pub enum ApiErrorCode {
    BadRequest,
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    InvalidPayload,
    PayloadTooLarge,
    RateLimited,
    Internal,
}

/// The error envelope every failing endpoint returns.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "generated.ts")]
pub struct ApiErrorBody {
    pub code: ApiErrorCode,
    pub message: String,
}

/// `POST /auth/signup`: email + password account creation (bucket 2
/// lands the handler; no invite codes, no OTP).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export_to = "generated.ts")]
pub struct SignupRequest {
    pub email: String,
    pub password: String,
    pub display_name: String,
}

/// `POST /auth/login`: email + password sign-in. A NULL
/// `users.password_hash` never authenticates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export_to = "generated.ts")]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

/// Sign-in response: the opaque bearer token travels in
/// `Authorization: Bearer <token>` from here on, never as a cookie.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export_to = "generated.ts")]
pub struct AuthResponse {
    pub token: String,
    pub expires_at: DateTime<Utc>,
    pub user: User,
}

/// Board windows: trailing days ending today, Monday-start weeks. `7d` is
/// one week, `4w` and `12w` are 28 and 84 days.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export_to = "generated.ts")]
pub enum BoardWindow {
    #[serde(rename = "7d")]
    Days7,
    #[serde(rename = "4w")]
    Weeks4,
    #[serde(rename = "12w")]
    Weeks12,
}

impl BoardWindow {
    /// Every window, shortest first.
    pub const ALL: [BoardWindow; 3] = [
        BoardWindow::Days7,
        BoardWindow::Weeks4,
        BoardWindow::Weeks12,
    ];

    /// The wire string; also the `?window=` query value.
    pub fn as_str(self) -> &'static str {
        match self {
            BoardWindow::Days7 => "7d",
            BoardWindow::Weeks4 => "4w",
            BoardWindow::Weeks12 => "12w",
        }
    }

    /// Parse the wire string; unknown values are rejected by the handler.
    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|window| window.as_str() == raw)
    }

    /// Length of the trailing window in days.
    pub fn days(self) -> i64 {
        match self {
            BoardWindow::Days7 => 7,
            BoardWindow::Weeks4 => 28,
            BoardWindow::Weeks12 => 84,
        }
    }
}

/// One ranked member on the Consistency board.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "generated.ts")]
pub struct ConsistencyBoardEntry {
    pub rank: u32,
    pub user: PublicUser,
    pub active_days: i32,
    pub weekly_streak: i32,
}

/// One ranked member on the lifting-volume board.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "generated.ts")]
pub struct LiftingVolumeEntry {
    pub rank: u32,
    pub user: PublicUser,
    pub volume_kg: f64,
}

/// The absolute-e1RM board for one marquee lift.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "generated.ts")]
pub struct MarqueeLiftBoard {
    pub lift: String,
    pub entries: Vec<MarqueeLiftEntry>,
}

/// One ranked member on one marquee-lift e1RM board.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "generated.ts")]
pub struct MarqueeLiftEntry {
    pub rank: u32,
    pub user: PublicUser,
    pub best_e1rm_kg: f64,
}

/// One ranked member on the relative-e1RM board. Only the ratio travels,
/// rounded to two decimals; the bodyweight it divides out is never
/// exposed and is only approximately recoverable from the published
/// absolute board.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "generated.ts")]
pub struct RelativeE1rmEntry {
    pub rank: u32,
    pub user: PublicUser,
    /// Best marquee-lift e1RM divided by bodyweight, rounded to two
    /// decimals.
    pub ratio: f64,
}

/// One ranked member on the cycling-distance board.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "generated.ts")]
pub struct CyclingDistanceEntry {
    pub rank: u32,
    pub user: PublicUser,
    pub distance_km: f64,
}

/// One ranked member on the cycling-elevation board.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "generated.ts")]
pub struct CyclingElevationEntry {
    pub rank: u32,
    pub user: PublicUser,
    pub elevation_m: f64,
}

/// One ranked member on the climbing board.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "generated.ts")]
pub struct ClimbingBoardEntry {
    pub rank: u32,
    pub user: PublicUser,
    pub v_points: f64,
    pub hardest_grade: Option<i32>,
}

/// The lifting discipline's three boards.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "generated.ts")]
pub struct LiftingBoards {
    pub volume: Vec<LiftingVolumeEntry>,
    pub e1rm: Vec<MarqueeLiftBoard>,
    pub relative_e1rm: Vec<RelativeE1rmEntry>,
}

/// The cycling discipline's two boards.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "generated.ts")]
pub struct CyclingBoards {
    pub distance: Vec<CyclingDistanceEntry>,
    pub elevation: Vec<CyclingElevationEntry>,
}

/// `GET /social/boards` response: every ranked board for one window, plus
/// the marquee-lift list so the client never duplicates it. No entry ever
/// carries an email or a body_stats column; members appear as
/// [`PublicUser`] only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "generated.ts")]
pub struct BoardsResponse {
    pub window: BoardWindow,
    pub marquee_lifts: Vec<String>,
    pub consistency: Vec<ConsistencyBoardEntry>,
    pub lifting: LiftingBoards,
    pub cycling: CyclingBoards,
    pub climbing: Vec<ClimbingBoardEntry>,
}

/// `set_entries` CHECK bounds, mirroring `SET_RULES` in
/// `apps/web/src/db/validation.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "generated.ts")]
pub struct SetRules {
    pub reps_min: i32,
    pub reps_max: i32,
    pub weight_min_kg: i32,
    pub weight_max_kg: i32,
}

impl Default for SetRules {
    fn default() -> Self {
        Self {
            reps_min: 1,
            reps_max: 36,
            weight_min_kg: 0,
            weight_max_kg: 1500,
        }
    }
}

/// `activities` CHECK bounds, mirroring `ACTIVITY_RULES`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "generated.ts")]
pub struct ActivityRules {
    pub duration_min: i32,
    pub duration_max: i32,
    pub climb_grade_value_min: i32,
    pub climb_grade_value_max: i32,
    pub routes_sent_min: i32,
}

impl Default for ActivityRules {
    fn default() -> Self {
        Self {
            duration_min: 0,
            duration_max: 1440,
            climb_grade_value_min: 0,
            climb_grade_value_max: 16,
            routes_sent_min: 0,
        }
    }
}

/// `body_stats` CHECK bounds, mirroring `BODY_RULES`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "generated.ts")]
pub struct BodyRules {
    /// Strict lower bound: 0 kg is not a plausible human weight, so the
    /// SQL CHECK is `weight_kg > 0`.
    pub weight_min_kg_exclusive: i32,
    pub weight_max_kg: i32,
    pub bodyfat_min_pct: i32,
    pub bodyfat_max_pct: i32,
}

impl Default for BodyRules {
    fn default() -> Self {
        Self {
            weight_min_kg_exclusive: 0,
            weight_max_kg: 1500,
            bodyfat_min_pct: 0,
            bodyfat_max_pct: 100,
        }
    }
}

/// `routine_entries` target bounds, mirroring `ROUTINE_RULES` in
/// `apps/web/src/db/validation.ts`. `target_sets` and `target_reps` carry
/// no SQL CHECK of their own, so these bounds are the shared contract the
/// client form and repo guards enforce; `target_weight_kg` mirrors the
/// `routine_entries_target_weight_kg_range` CHECK (null or strictly
/// positive and at most 1500).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "generated.ts")]
pub struct RoutineRules {
    pub target_sets_min: i32,
    pub target_sets_max: i32,
    pub target_reps_min: i32,
    pub target_reps_max: i32,
    /// Strict lower bound: 0 kg is not a plausible target, so the SQL
    /// CHECK is `target_weight_kg > 0`.
    pub target_weight_min_kg_exclusive: i32,
    pub target_weight_max_kg: i32,
}

impl Default for RoutineRules {
    fn default() -> Self {
        Self {
            target_sets_min: 1,
            target_sets_max: 20,
            target_reps_min: 1,
            target_reps_max: 36,
            target_weight_min_kg_exclusive: 0,
            target_weight_max_kg: 1500,
        }
    }
}

/// Server sync limits agreed with the client: batch cap, pull page size,
/// and the client clock skew tolerance used by
/// `waveform_sync::clamp_client_timestamp`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "generated.ts")]
pub struct SyncLimits {
    pub max_ops_per_push: i32,
    pub pull_page_size: i32,
    pub max_client_clock_skew_minutes: i32,
}

impl Default for SyncLimits {
    fn default() -> Self {
        Self {
            max_ops_per_push: 200,
            pull_page_size: 500,
            max_client_clock_skew_minutes: i32::try_from(
                waveform_sync::MAX_CLIENT_CLOCK_SKEW_MINUTES,
            )
            .expect("clock skew fits i32"),
        }
    }
}

/// Password policy for email + password accounts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "generated.ts")]
pub struct PasswordRules {
    pub min_password_length: i32,
}

impl Default for PasswordRules {
    fn default() -> Self {
        Self {
            min_password_length: 10,
        }
    }
}

/// The whole rule tree in one value. Field names deep-equal the client
/// constants in `apps/web/src/db/validation.ts`; the vitest parity test
/// (`apps/web/src/db/rulesParity.test.ts`) and `export_ts_rules` keep the
/// two sides honest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "generated.ts")]
pub struct RuleConstants {
    pub set: SetRules,
    pub activity: ActivityRules,
    pub body: BodyRules,
    pub routine: RoutineRules,
    pub sync: SyncLimits,
    pub password: PasswordRules,
}

#[cfg(test)]
mod tests {
    use super::RuleConstants;

    #[test]
    fn client_clock_skew_matches_the_sync_crate() {
        // The rules tree is the client-visible copy of the sync contract;
        // if it ever drifts from waveform_sync, devices would clamp with
        // one number and the server with another. i32 in the tree (the
        // TS wire type is `number`), i64 in the sync crate.
        assert_eq!(
            i64::from(RuleConstants::default().sync.max_client_clock_skew_minutes),
            waveform_sync::MAX_CLIENT_CLOCK_SKEW_MINUTES,
        );
    }

    #[test]
    fn rule_values_match_the_client_guards() {
        let rules = RuleConstants::default();
        assert_eq!((rules.set.reps_min, rules.set.reps_max), (1, 36));
        assert_eq!(
            (rules.set.weight_min_kg, rules.set.weight_max_kg),
            (0, 1500)
        );
        assert_eq!(
            (rules.activity.duration_min, rules.activity.duration_max),
            (0, 1440)
        );
        assert_eq!(
            (
                rules.activity.climb_grade_value_min,
                rules.activity.climb_grade_value_max,
                rules.activity.routes_sent_min,
            ),
            (0, 16, 0),
        );
        assert_eq!(
            (
                rules.body.weight_min_kg_exclusive,
                rules.body.weight_max_kg,
                rules.body.bodyfat_min_pct,
                rules.body.bodyfat_max_pct,
            ),
            (0, 1500, 0, 100),
        );
        assert_eq!(
            (
                rules.routine.target_sets_min,
                rules.routine.target_sets_max,
                rules.routine.target_reps_min,
                rules.routine.target_reps_max,
            ),
            (1, 20, 1, 36),
        );
        assert_eq!(
            (
                rules.routine.target_weight_min_kg_exclusive,
                rules.routine.target_weight_max_kg,
            ),
            (0, 1500),
        );
        assert_eq!(
            (rules.sync.max_ops_per_push, rules.sync.pull_page_size),
            (200, 500),
        );
        assert_eq!(rules.password.min_password_length, 10);
    }

    #[test]
    fn board_window_parses_and_measures_its_days() {
        assert_eq!(
            super::BoardWindow::parse("7d"),
            Some(super::BoardWindow::Days7)
        );
        assert_eq!(
            super::BoardWindow::parse("4w"),
            Some(super::BoardWindow::Weeks4)
        );
        assert_eq!(
            super::BoardWindow::parse("12w"),
            Some(super::BoardWindow::Weeks12)
        );
        assert_eq!(super::BoardWindow::parse("1d"), None);
        assert_eq!(super::BoardWindow::parse(""), None);
        assert_eq!(super::BoardWindow::Days7.days(), 7);
        assert_eq!(super::BoardWindow::Weeks4.days(), 28);
        assert_eq!(super::BoardWindow::Weeks12.days(), 84);
        assert_eq!(super::BoardWindow::Days7.as_str(), "7d");
    }

    #[test]
    fn sync_entity_strings_match_the_client_outbox_union() {
        // apps/web/src/db/types.ts OutboxEntity plus routines and
        // routine_entries; the first six must match exactly.
        let client_side = [
            "exercises",
            "workout_sessions",
            "exercise_entries",
            "set_entries",
            "activities",
            "body_stats",
        ];
        for name in client_side {
            let entity = super::SyncEntity::parse(name).expect("client entity must parse");
            assert_eq!(entity.as_str(), name);
        }
        assert_eq!(super::SyncEntity::Routines.as_str(), "routines");
        assert_eq!(
            super::SyncEntity::RoutineEntries.as_str(),
            "routine_entries"
        );
    }
}
