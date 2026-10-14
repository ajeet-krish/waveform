//! Shared application state threaded through every handler.

use sqlx::PgPool;

/// State available to all route handlers.
#[derive(Clone)]
pub struct AppState {
    /// SQLx connection pool.
    pub pool: PgPool,
}
