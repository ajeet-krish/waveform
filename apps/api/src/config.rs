//! Configuration loaded from the process environment.
//!
//! `DATABASE_URL` and `PORT` are provided by Docker Compose in development
//! and by Railway in production; `.env` loading is handled by `dotenvy` in
//! `main`.

use anyhow::{Context, Result};

/// Runtime configuration for one API process.
#[derive(Debug, Clone)]
pub struct Config {
    /// Postgres connection string.
    pub database_url: String,
    /// Interface to bind. Defaults to `0.0.0.0`.
    pub host: String,
    /// TCP port to bind. Railway injects `PORT`; defaults to 8080 locally.
    pub port: u16,
    /// Whether to apply pending migrations during startup.
    pub run_migrations: bool,
}

impl Config {
    /// Read configuration from environment variables.
    pub fn from_env() -> Result<Self> {
        let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL must be set")?;
        let host = std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_owned());
        let port = std::env::var("PORT")
            .unwrap_or_else(|_| "8080".to_owned())
            .parse::<u16>()
            .context("PORT must be a valid u16")?;
        let run_migrations = match std::env::var("RUN_MIGRATIONS") {
            Ok(value) => !(value == "0" || value.eq_ignore_ascii_case("false")),
            Err(_) => true,
        };
        Ok(Self {
            database_url,
            host,
            port,
            run_migrations,
        })
    }
}
