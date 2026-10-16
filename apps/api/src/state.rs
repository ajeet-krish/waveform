//! Shared application state threaded through every handler.

use std::sync::Arc;

use sqlx::PgPool;

use crate::config::Config;
use crate::rate_limit::LoginLimiter;

/// State available to all route handlers.
#[derive(Clone)]
pub struct AppState {
    /// SQLx connection pool.
    pub pool: PgPool,
    /// Immutable process configuration: session secret (HMAC key for
    /// bearer tokens) and the allowed web origin (CORS).
    pub config: Arc<Config>,
    /// Failed-login throttle shared by the login and signup handlers.
    pub login_limiter: LoginLimiter,
}
