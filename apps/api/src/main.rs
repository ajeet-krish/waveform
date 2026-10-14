//! LiftLog API entrypoint.
//!
//! Loads configuration from the environment, connects the SQLx pool, applies
//! pending migrations, and serves the router. Pass `migrate` as an argument
//! to apply migrations and exit (used by CI and deploy hooks).

mod config;
mod routes;
mod state;

use anyhow::Context;
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    init_tracing();

    let config = Config::from_env().context("failed to load configuration")?;
    let pool = liftlog_db::connect(&config.database_url)
        .await
        .context("failed to connect to Postgres")?;

    if std::env::args().any(|arg| arg == "migrate") {
        liftlog_db::run_migrations(&pool)
            .await
            .context("failed to run migrations")?;
        tracing::info!("migrations applied, exiting");
        return Ok(());
    }

    if config.run_migrations {
        liftlog_db::run_migrations(&pool)
            .await
            .context("failed to run migrations")?;
    }

    let app = routes::router(AppState { pool });
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
        .unwrap_or_else(|_| EnvFilter::new("liftlog_api=info,sqlx=warn"));
    tracing_subscriber::fmt().with_env_filter(filter).init();
}

/// Resolve on Ctrl+C so the server drains in-flight requests.
async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("failed to install Ctrl+C handler");
    tracing::info!("shutdown signal received");
}
