//! Pure scoring functions for Waveform.
//!
//! Everything in this crate is deterministic math with no I/O so it can be
//! unit tested exhaustively and reused from the API, the analytics crate, and
//! (later) import tooling. The Postgres schema mirrors the Brzycki formula in
//! the generated column `set_entries.e1rm_kg`, so any change here must also
//! change `migrations/0001_init.sql`.

pub mod brzycki;
pub mod climbing;
pub mod effort;

pub use brzycki::e1rm_brzycki;
pub use climbing::{total_v_points, v_points, MAX_V_GRADE};
pub use effort::{
    effort_points, effort_points_daily, Discipline, EffortBonuses, SessionEffort, DAILY_EP_CAP,
};
