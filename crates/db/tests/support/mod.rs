//! Shared scratch-database support for the integration suites.
//!
//! Every suite gets its own throwaway Postgres database (created with a
//! UUID name, migrated, dropped with FORCE on completion), so tests run
//! in parallel without touching each other. When
//! `WAVEFORM_TEST_DATABASE_URL` (or `DATABASE_URL`) is missing, the
//! scratch helpers return `None` and callers print a skip notice, so
//! `cargo test --workspace` stays green without infra.
//!
//! This module is shared: `crates/db/tests/auth_queries.rs` includes it
//! with `mod support;`, and `apps/api/tests/auth_routes.rs` reaches the
//! same file through a `#[path]` include rather than duplicating the
//! pattern (there is no test-support crate yet).

// The module is shared, so not every including suite uses every helper
// (`url` is only needed by the api route suite); keep the unused ones
// from tripping the dead-code lint in the other suites.
#![allow(dead_code)]

use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use uuid::Uuid;

/// A migrated throwaway database plus what is needed to drop it again.
pub struct ScratchDb {
    /// Pool connected to the scratch database.
    pub pool: PgPool,
    base_url: String,
    name: String,
}

impl ScratchDb {
    /// The connection URL of this scratch database.
    pub fn url(&self) -> String {
        with_database(&self.base_url, &self.name)
    }
}

fn base_url() -> Option<String> {
    std::env::var("WAVEFORM_TEST_DATABASE_URL")
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

/// Create (and migrate) a scratch database, or print a skip notice and
/// return `None` when no test database URL is configured.
pub async fn migrated_scratch(context: &str) -> Option<ScratchDb> {
    let Some(base_url) = base_url() else {
        eprintln!(
            "SKIPPED ({context}): set WAVEFORM_TEST_DATABASE_URL (or DATABASE_URL) to a Postgres \
             URL with CREATE DATABASE rights to run this suite"
        );
        return None;
    };
    let name = format!("waveform_test_{}", Uuid::new_v4().simple());
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

    let pool = waveform_db::connect(&with_database(&base_url, &name))
        .await
        .expect("connect to scratch database");
    waveform_db::run_migrations(&pool)
        .await
        .expect("migrations must apply to a fresh database");
    Some(ScratchDb {
        pool,
        base_url,
        name,
    })
}

/// Drop the scratch database, terminating leftover connections.
pub async fn drop_scratch(db: ScratchDb) {
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
