//! Analytics metrics for Waveform.
//!
//! This crate ports the SQL aggregation logic from
//! `fitness_control_center/src-tauri/src/commands/analytics.rs` (weekly
//! volume, e1RM progression, consistency windows) into pure Rust functions
//! that the API handlers call with rows fetched by `waveform-db`. Weekly
//! volume landed in phase 0; the boards (7d / 4w / 12w windows) land here.

pub mod boards;
pub mod volume;

pub use boards::{
    climbing_board, climbing_points, consistency_board, hardest_grade, marquee_lift_alias_pairs,
    metric_board, relative_e1rm_board, relative_e1rm_ratio, weekly_streak, BoardMember,
    ClimbingEntry, ClimbingInput, ConsistencyEntry, ConsistencyInput, RankedEntry,
    RelativeE1rmEntry, RelativeE1rmInput, MARQUEE_LIFTS, MARQUEE_LIFT_ALIASES,
    MIN_STREAK_WEEK_ACTIVE_DAYS, RELATIVE_E1RM_RATIO_DECIMALS,
};
pub use volume::{weekly_volume, WeeklyVolume};
