//! Request extractors shared by the authenticated routes.
//!
//! [`AuthUser`] resolves the `Authorization: Bearer` header into the
//! session's user; [`ApiJson`] turns body-parse failures into the
//! standard [`ApiError`] envelope instead of axum's plain-text rejections.

use axum::extract::{FromRequest, FromRequestParts, Request};
use axum::http::{header::AUTHORIZATION, request::Parts, HeaderMap};
use axum::Json;
use serde::de::DeserializeOwned;
use uuid::Uuid;

use crate::auth::hash_token;
use crate::error::ApiError;
use crate::state::AppState;

/// The stored form of a presented bearer token: HMAC-SHA256 keyed by
/// `SESSION_SECRET`, hex-encoded. Used by the extractor, logout, and
/// the session-issuing handlers so every path hashes identically.
pub fn session_token_hash(state: &AppState, token: &str) -> String {
    hash_token(&state.config.session_secret, token)
}

/// The authenticated user's id, resolved from a valid, unexpired session.
#[derive(Debug, Clone, Copy)]
pub struct AuthUser {
    /// `users.id` owning the presented session token.
    pub user_id: Uuid,
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = bearer_token(&parts.headers).ok_or_else(|| {
            ApiError::Unauthorized("missing bearer token in Authorization header".to_owned())
        })?;
        let token_hash = session_token_hash(state, token);
        let user =
            waveform_db::queries::find_user_by_session_token_hash(&state.pool, &token_hash).await?;
        match user {
            Some(user) => Ok(AuthUser { user_id: user.id }),
            // Unknown, expired, or tombstoned sessions are one 401.
            None => Err(ApiError::Unauthorized(
                "invalid or expired session".to_owned(),
            )),
        }
    }
}

/// The token from an `Authorization: Bearer <token>` header, if the
/// header is well-formed.
pub fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(AUTHORIZATION)?.to_str().ok()?;
    let mut parts = value.split_ascii_whitespace();
    match (parts.next(), parts.next(), parts.next()) {
        (Some(scheme), Some(token), None) if scheme.eq_ignore_ascii_case("bearer") => Some(token),
        _ => None,
    }
}

/// A JSON body extractor whose failures land in the shared error
/// envelope: malformed or mismatched JSON becomes
/// [`ApiError::InvalidPayload`] (HTTP 422, `invalid_payload`).
pub struct ApiJson<T>(pub T);

impl<S, T> FromRequest<S> for ApiJson<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(value)) => Ok(ApiJson(value)),
            Err(rejection) => Err(ApiError::InvalidPayload(rejection.body_text())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::bearer_token;
    use axum::http::{HeaderMap, HeaderValue};

    fn headers_with(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            HeaderValue::from_str(value).expect("header"),
        );
        headers
    }

    #[test]
    fn bearer_token_parses_the_header_shape() {
        assert_eq!(bearer_token(&headers_with("Bearer abc123")), Some("abc123"));
        assert_eq!(bearer_token(&headers_with("bearer abc123")), Some("abc123"));
        assert_eq!(
            bearer_token(&headers_with("BEARER  spaced-token")),
            Some("spaced-token")
        );
        assert_eq!(bearer_token(&headers_with("Basic dXNlcjpwYXNz")), None);
        assert_eq!(bearer_token(&headers_with("Bearer")), None);
        assert_eq!(bearer_token(&headers_with("Bearer one two")), None);
        assert_eq!(bearer_token(&HeaderMap::new()), None);
    }
}
