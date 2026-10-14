//! Auth surface: invite redemption, email OTP, GitHub OAuth, and the opaque
//! session cookie. Phase 1 adds `POST /auth/otp/request`,
//! `POST /auth/otp/verify`, and logout; this module only reserves the
//! namespace.

use axum::Router;

/// Router for the auth surface. Empty until handlers land in phase 1.
pub fn router<S: Clone + Send + Sync + 'static>() -> Router<S> {
    Router::new()
}
