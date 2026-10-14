//! Analytics metrics for LiftLog.
//!
//! This crate will port the SQL aggregation logic from
//! `fitness_control_center/src-tauri/src/commands/analytics.rs` (weekly
//! volume, e1RM progression, consistency windows) into pure Rust functions
//! that the API handlers call with rows fetched by `liftlog-db`. Phase 0
//! starts with weekly volume; the boards (7d / 4w / 12w windows) land in
//! phase 3.

pub mod volume;

pub use volume::{weekly_volume, WeeklyVolume};
