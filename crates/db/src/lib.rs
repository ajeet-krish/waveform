//! Database access for LiftLog.
//!
//! Owns the SQLx pool setup, the embedded migration runner (repository-level
//! `migrations/` directory), and the shared row models. Models derive
//! `ts_rs::TS` and are exported to `packages/api-types/src/generated.ts` by
//! the `export_ts` test; CI fails when the committed file drifts.

pub mod models;

use std::time::Duration;

use sqlx::migrate::Migrator;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

pub use models::*;

/// Embedded migrations, applied in filename order by [`run_migrations`].
pub static MIGRATOR: Migrator = sqlx::migrate!("../../migrations");

/// Maximum pooled connections per process.
const MAX_CONNECTIONS: u32 = 10;

/// How long to wait for a free connection before failing.
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(5);

/// Connect a pool to `database_url` (for example
/// `postgres://liftlog:liftlog@localhost:5432/liftlog`).
pub async fn connect(database_url: &str) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(MAX_CONNECTIONS)
        .acquire_timeout(ACQUIRE_TIMEOUT)
        .connect(database_url)
        .await
}

/// Apply all pending migrations. sqlx tracks applied versions in the
/// `_sqlx_migrations` table, so repeat calls are no-ops. Assumes a single
/// instance runs migrations at a time (one Railway service, one CI job):
/// concurrent multi-instance startups can race inside sqlx's migration
/// lock. Production should prefer the explicit `migrate` subcommand over
/// startup migration (`RUN_MIGRATIONS` defaults to false).
pub async fn run_migrations(pool: &PgPool) -> Result<(), sqlx::migrate::MigrateError> {
    MIGRATOR.run(pool).await
}

#[cfg(test)]
mod export_tests {
    use crate::{
        Activity, ActivityType, BodyStats, Challenge, Exercise, ExerciseEntry, Group, GroupMember,
        GroupRole, Kudos, PublicUser, Routine, RoutineEntry, SetEntry, User, WorkoutSession,
    };
    use ts_rs::TS;

    /// Regenerates `packages/api-types/src/generated.ts`. CI runs
    /// `cargo test export_ts` and fails if the committed file drifts from
    /// the Rust models.
    #[test]
    fn export_ts() {
        for result in [
            Activity::export(),
            ActivityType::export(),
            BodyStats::export(),
            Challenge::export(),
            Exercise::export(),
            ExerciseEntry::export(),
            Group::export(),
            GroupMember::export(),
            GroupRole::export(),
            Kudos::export(),
            PublicUser::export(),
            Routine::export(),
            RoutineEntry::export(),
            SetEntry::export(),
            User::export(),
            WorkoutSession::export(),
        ] {
            result.expect("ts-rs export failed");
        }
    }
}
