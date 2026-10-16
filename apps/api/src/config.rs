//! Configuration loaded from the process environment.
//!
//! `DATABASE_URL` and `PORT` are provided by Docker Compose in development
//! and by Railway in production; `.env` loading is handled by `dotenvy` in
//! `main`. `SESSION_SECRET` is required to serve (never for the
//! `migrate` subcommand, which only needs the database URL).

use anyhow::{bail, Context, Result};

/// Minimum length of `SESSION_SECRET`: it keys opaque bearer sessions, so
/// a short value would be guessable.
const MIN_SESSION_SECRET_LENGTH: usize = 32;

/// Runtime configuration for one API process.
#[derive(Debug, Clone)]
pub struct Config {
    /// Postgres connection string.
    pub database_url: String,
    /// Interface to bind. Defaults to `0.0.0.0`.
    pub host: String,
    /// TCP port to bind. Railway injects `PORT`; defaults to 8080 locally.
    pub port: u16,
    /// Whether to apply pending migrations during startup. Defaults to
    /// false so production never runs DDL on boot; deploys apply
    /// migrations as an explicit release step via the API's `migrate`
    /// subcommand. Local development can opt in with `RUN_MIGRATIONS=true`.
    pub run_migrations: bool,
    /// Server-side secret for opaque bearer sessions (Authorization:
    /// Bearer header, never a cross-site cookie). Required, minimum 32
    /// characters; bucket 2 derives and hashes session tokens with it.
    pub session_secret: String,
    /// Browser origin allowed to call the API (CORS). Defaults to the
    /// local Vite dev server; override with `ALLOWED_WEB_ORIGIN` for the
    /// GitHub Pages deployment.
    pub allowed_web_origin: String,
}

impl Config {
    /// Read configuration from environment variables.
    pub fn from_env() -> Result<Self> {
        let database_url = Self::database_url_from_env()?;
        let host = std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_owned());
        let port = std::env::var("PORT")
            .unwrap_or_else(|_| "8080".to_owned())
            .parse::<u16>()
            .context("PORT must be a valid u16")?;
        let run_migrations = match std::env::var("RUN_MIGRATIONS") {
            Ok(value) => value == "1" || value.eq_ignore_ascii_case("true"),
            Err(_) => false,
        };
        let session_secret = std::env::var("SESSION_SECRET")
            .context("SESSION_SECRET must be set (minimum 32 characters)")?;
        if session_secret.chars().count() < MIN_SESSION_SECRET_LENGTH {
            bail!(
                "SESSION_SECRET must be at least {MIN_SESSION_SECRET_LENGTH} characters, got {}",
                session_secret.chars().count()
            );
        }
        let allowed_web_origin = std::env::var("ALLOWED_WEB_ORIGIN")
            .unwrap_or_else(|_| "http://localhost:5173".to_owned());
        Ok(Self {
            database_url,
            host,
            port,
            run_migrations,
            session_secret,
            allowed_web_origin,
        })
    }

    /// Just the connection string, for the `migrate` subcommand: applying
    /// migrations needs no session secret, so CI and deploy hooks only
    /// provide `DATABASE_URL`.
    pub fn database_url_from_env() -> Result<String> {
        std::env::var("DATABASE_URL").context("DATABASE_URL must be set")
    }
}
