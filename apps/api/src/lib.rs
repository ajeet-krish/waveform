//! Waveform API library: modules plus the `run` entrypoint.
//!
//! The binary in `main.rs` is a thin wrapper around [`run`]; the library
//! target exists so the integration tests in `apps/api/tests` can build
//! the real router and exercise it in process.

pub mod auth;
pub mod config;
pub mod error;
pub mod extractors;
pub mod rate_limit;
pub mod routes;
pub mod state;

use std::sync::Arc;

use anyhow::Context;
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::rate_limit::LoginLimiter;
use crate::state::AppState;

/// Load configuration, connect the pool, and serve the router. Passing
/// `migrate` as an argument applies migrations and exits (used by CI and
/// deploy hooks); that path only needs `DATABASE_URL`.
pub async fn run() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    init_tracing();

    // The migrate subcommand only needs the database: session and CORS
    // config are validated when serving, so CI and deploy hooks stay
    // env-light (DATABASE_URL alone).
    if std::env::args().any(|arg| arg == "migrate") {
        let database_url =
            Config::database_url_from_env().context("failed to load configuration")?;
        let pool = waveform_db::connect(&database_url)
            .await
            .context("failed to connect to Postgres")?;
        waveform_db::run_migrations(&pool)
            .await
            .context("failed to run migrations")?;
        tracing::info!("migrations applied, exiting");
        return Ok(());
    }

    let config = Arc::new(Config::from_env().context("failed to load configuration")?);
    tracing::info!(origin = %config.allowed_web_origin, "web origin configured");
    tracing::debug!(
        secret_len = config.session_secret.len(),
        "session secret loaded"
    );
    let pool = waveform_db::connect(&config.database_url)
        .await
        .context("failed to connect to Postgres")?;

    if config.run_migrations {
        waveform_db::run_migrations(&pool)
            .await
            .context("failed to run migrations")?;
    }

    let app = routes::router(AppState {
        pool,
        config: Arc::clone(&config),
        login_limiter: LoginLimiter::new(),
    });
    let listener = tokio::net::TcpListener::bind((config.host.as_str(), config.port))
        .await
        .context("failed to bind TCP listener")?;
    let address = listener.local_addr().context("listener has no address")?;
    tracing::info!("api listening on http://{address}");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("server exited with an error")?;
    Ok(())
}

/// Structured logging to stdout, filtered by RUST_LOG.
fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("waveform_api=info,sqlx=warn"));
    tracing_subscriber::fmt().with_env_filter(filter).init();
}

/// Resolve on Ctrl+C so the server drains in-flight requests.
async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("failed to install Ctrl+C handler");
    tracing::info!("shutdown signal received");
}
