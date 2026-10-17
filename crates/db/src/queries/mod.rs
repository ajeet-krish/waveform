//! The entity-generic sync engine: registry, apply, and pull.
//!
//! * [`spec`] holds the per-entity SQL registry (static builders only).
//! * [`sync_apply`] claims each pushed op into `client_ops` and upserts
//!   the row in one transaction.
//! * [`sync_pull`] pages rows out on the `(applied_at, id)` cursor.
//! * [`boards`] serves the read-only social boards aggregates.

pub mod auth;
pub mod boards;
pub mod spec;
pub mod sync_apply;
pub mod sync_pull;

pub use auth::{
    create_session, create_user, delete_session_by_token_hash, find_user_by_email, find_user_by_id,
    find_user_by_session_token_hash, purge_expired_sessions, InsertError,
};
pub use boards::{
    active_days, climbing_sends, crew, cycling_totals, latest_bodyweight, lifting_volume,
    marquee_best_e1rm, weekly_active_days,
};
pub use spec::{spec_for, EntitySpec, ParentCheck};
pub use sync_apply::{apply_op, apply_ops, ApplyError};
pub use sync_pull::{parse_cursor, pull_page, PullParams};
