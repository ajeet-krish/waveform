//! Shared application state threaded through every handler.

use std::sync::Arc;

use sqlx::PgPool;

use crate::config::Config;

/// State available to all route handlers.
#[derive(Clone)]
pub struct AppState {
    /// SQLx connection pool.
    pub pool: PgPool,
    /// Immutable process configuration (session secret, web origin, ...).
    /// Read by the bucket 2 auth and sync handlers through their
    /// extractors; unused until then.
    #[allow(dead_code)]
    pub config: Arc<Config>,
}
