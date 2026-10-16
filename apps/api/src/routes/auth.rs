//! Auth surface: email + password signup and login with opaque bearer
//! sessions (ADR 2026-10-15). Open sign-up, no invites, no OTP, no MFA,
//! no email verification, no GitHub OAuth.
//!
//! * `POST /auth/signup` validates against `RuleConstants`, hashes the
//!   password with Argon2id off the async runtime (`spawn_blocking`),
//!   and answers 201 with a fresh session; a taken address answers 409.
//! * `POST /auth/login` throttles per email, answers one byte-identical
//!   401 for unknown email, wrong password, and NULL-hash accounts, and
//!   purges expired sessions best-effort on success.
//! * `POST /auth/logout` deletes the session by token hash and is always
//!   204, idempotent.
//! * `GET /auth/me` resolves the bearer session to the user; the `User`
//!   model never serializes `password_hash`.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{Duration, Utc};
use waveform_db::dto::{AuthResponse, LoginRequest, RuleConstants, SignupRequest};
use waveform_db::models::User;
use waveform_db::queries::{
    create_session, create_user, delete_session_by_token_hash, find_user_by_email, find_user_by_id,
    purge_expired_sessions, InsertError,
};

use crate::auth::{generate_token, hash_password, verify_password, DUMMY_PHC, SESSION_TTL_DAYS};
use crate::error::ApiError;
use crate::extractors::{bearer_token, session_token_hash, ApiJson, AuthUser};
use crate::state::AppState;

/// Email bounds: RFC 2821 caps the path at 254 bytes; 3 covers "a@b".
const MIN_EMAIL_BYTES: usize = 3;
const MAX_EMAIL_BYTES: usize = 254;
/// Password bounds in bytes (not characters): the minimum comes from
/// `RuleConstants`, the ceiling keeps Argon2 input sane.
const MAX_PASSWORD_BYTES: usize = 1024;
/// Display names are human labels: 1 to 60 characters after trimming.
const MAX_DISPLAY_NAME_CHARS: usize = 60;

/// The one message every login failure returns; unknown email, wrong
/// password, and tombstoned or NULL-hash accounts are indistinguishable.
const INVALID_CREDENTIALS: &str = "invalid email or password";

/// Router for the auth surface.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/auth/signup", post(signup))
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/auth/me", get(me))
}

/// `POST /auth/signup`: open registration with an email + password
/// account. Duplicate addresses (in any casing) answer 409.
async fn signup(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<SignupRequest>,
) -> Result<(StatusCode, Json<AuthResponse>), ApiError> {
    if state.login_limiter.is_limited(&request.email) {
        return Err(ApiError::RateLimited(
            "too many attempts from this address, try again later".to_owned(),
        ));
    }

    if let Err(message) = validate_signup(&RuleConstants::default(), &request) {
        state.login_limiter.record_failure(&request.email);
        return Err(ApiError::InvalidPayload(message));
    }

    let password_hash = spawn_hash_password(request.password.clone()).await?;

    let user = match create_user(
        &state.pool,
        &request.email,
        request.display_name.trim(),
        &password_hash,
    )
    .await
    {
        Ok(user) => user,
        Err(InsertError::DuplicateEmail) => {
            state.login_limiter.record_failure(&request.email);
            return Err(ApiError::Conflict(
                "an account with that email already exists".to_owned(),
            ));
        }
        Err(InsertError::Database(database)) => return Err(database.into()),
    };

    state.login_limiter.clear(&request.email);
    let response = issue_session(&state, user).await?;
    Ok((StatusCode::CREATED, Json(response)))
}

/// `POST /auth/login`: email + password sign-in. Failures are throttled
/// per normalized email; success clears the throttle.
async fn login(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<LoginRequest>,
) -> Result<(StatusCode, Json<AuthResponse>), ApiError> {
    if state.login_limiter.is_limited(&request.email) {
        return Err(ApiError::RateLimited(
            "too many failed attempts, try again later".to_owned(),
        ));
    }

    let user = find_user_by_email(&state.pool, &request.email).await?;
    // A NULL hash and a missing row both verify against DUMMY_PHC, so
    // every miss costs one Argon2id computation.
    let stored_hash = user.as_ref().and_then(|user| user.password_hash.clone());
    let password = request.password.clone();
    let verified = tokio::task::spawn_blocking(move || match stored_hash.as_deref() {
        Some(hash) => verify_password(&password, hash),
        None => {
            let _ = verify_password(&password, DUMMY_PHC);
            false
        }
    })
    .await
    .map_err(|error| {
        tracing::error!(%error, "password verification task failed");
        ApiError::Internal("failed to verify password".to_owned())
    })?;

    if !verified {
        state.login_limiter.record_failure(&request.email);
        return Err(ApiError::Unauthorized(INVALID_CREDENTIALS.to_owned()));
    }

    let Some(user) = user else {
        // Unreachable: verification only succeeds against a stored hash.
        tracing::error!(email = %request.email, "verified login without a user row");
        return Err(ApiError::Internal("failed to resolve account".to_owned()));
    };
    state.login_limiter.clear(&request.email);

    // Housekeeping, never on the critical path: expired sessions are
    // dropped whenever a login succeeds.
    if let Err(error) = purge_expired_sessions(&state.pool).await {
        tracing::warn!(%error, "expired session purge failed");
    }

    let response = issue_session(&state, user).await?;
    Ok((StatusCode::OK, Json(response)))
}

/// `POST /auth/logout`: revoke the presented session. Always 204 and
/// idempotent: a missing, invalid, or already-revoked token is a no-op.
async fn logout(State(state): State<AppState>, headers: HeaderMap) -> StatusCode {
    if let Some(token) = bearer_token(&headers) {
        let token_hash = session_token_hash(&state, token);
        if let Err(error) = delete_session_by_token_hash(&state.pool, &token_hash).await {
            tracing::error!(%error, "session delete failed");
        }
    }
    StatusCode::NO_CONTENT
}

/// `GET /auth/me`: the authenticated user behind a valid session. The
/// `User` model never serializes `password_hash`.
async fn me(State(state): State<AppState>, auth_user: AuthUser) -> Result<Json<User>, ApiError> {
    match find_user_by_id(&state.pool, auth_user.user_id).await? {
        Some(user) => Ok(Json(user)),
        None => Err(ApiError::Unauthorized(
            "invalid or expired session".to_owned(),
        )),
    }
}

/// Generate the opaque token, store only its HMAC hash, and answer with
/// the bearer token plus expiry.
async fn issue_session(state: &AppState, user: User) -> Result<AuthResponse, ApiError> {
    let token = generate_token();
    let token_hash = session_token_hash(state, &token);
    let expires_at = Utc::now() + Duration::days(SESSION_TTL_DAYS);
    let session = create_session(&state.pool, user.id, &token_hash, expires_at).await?;
    Ok(AuthResponse {
        token,
        expires_at: session.expires_at,
        user,
    })
}

/// Argon2id hashing is deliberately CPU-heavy; run it off the async
/// runtime so one signup cannot stall the whole executor.
async fn spawn_hash_password(password: String) -> Result<String, ApiError> {
    tokio::task::spawn_blocking(move || hash_password(&password))
        .await
        .map_err(|error| {
            tracing::error!(%error, "password hashing task failed");
            ApiError::Internal("failed to hash password".to_owned())
        })?
        .map_err(|error| {
            tracing::error!(%error, "password hashing failed");
            ApiError::Internal("failed to hash password".to_owned())
        })
}

/// Validate the signup payload against the shared rule tree. Returns the
/// message to reject with, or nothing when the payload is sound.
fn validate_signup(rules: &RuleConstants, request: &SignupRequest) -> Result<(), String> {
    let min_password_bytes = usize::try_from(rules.password.min_password_length).unwrap_or(10);
    let password_len = request.password.len();
    if !(min_password_bytes..=MAX_PASSWORD_BYTES).contains(&password_len) {
        return Err(format!(
            "password must be {min_password_bytes} to {MAX_PASSWORD_BYTES} bytes"
        ));
    }
    validate_email(&request.email)?;
    let display_name = request.display_name.trim();
    if display_name.is_empty() || display_name.chars().count() > MAX_DISPLAY_NAME_CHARS {
        return Err(format!(
            "display name must be 1 to {MAX_DISPLAY_NAME_CHARS} characters"
        ));
    }
    Ok(())
}

/// Structural email checks: bounded length, no whitespace, one `@`, a
/// dotted domain, and no consecutive dots. Deliverability is not
/// verified (no email verification by design).
fn validate_email(email: &str) -> Result<(), String> {
    if !(MIN_EMAIL_BYTES..=MAX_EMAIL_BYTES).contains(&email.len()) {
        return Err(format!(
            "email must be {MIN_EMAIL_BYTES} to {MAX_EMAIL_BYTES} bytes"
        ));
    }
    if email.chars().any(char::is_whitespace) {
        return Err("email must not contain whitespace".to_owned());
    }
    let Some((local, domain)) = email.split_once('@') else {
        return Err("email must look like name@example.com".to_owned());
    };
    if local.is_empty() || domain.contains('@') || local.contains("..") || domain.contains("..") {
        return Err("email must look like name@example.com".to_owned());
    }
    if !domain.contains('.') || domain.starts_with('.') || domain.ends_with('.') {
        return Err("email domain must contain a dot, for example example.com".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{validate_email, validate_signup, INVALID_CREDENTIALS};
    use waveform_db::dto::{RuleConstants, SignupRequest};

    fn request(email: &str, password: &str, display_name: &str) -> SignupRequest {
        SignupRequest {
            email: email.to_owned(),
            password: password.to_owned(),
            display_name: display_name.to_owned(),
        }
    }

    #[test]
    fn password_bounds_come_from_the_rule_tree() {
        let rules = RuleConstants::default();
        let valid = request("a@example.com", "1234567890", "A");
        assert!(validate_signup(&rules, &valid).is_ok());
        let short = request("a@example.com", "123456789", "A");
        assert!(validate_signup(&rules, &short).is_err());
        let long = request("a@example.com", &"x".repeat(1025), "A");
        assert!(validate_signup(&rules, &long).is_err());
        let edge = request("a@example.com", &"x".repeat(1024), "A");
        assert!(validate_signup(&rules, &edge).is_ok());
    }

    #[test]
    fn email_needs_one_at_sign_and_a_dotted_domain() {
        assert!(validate_email("name@example.com").is_ok());
        assert!(validate_email("n@e.co").is_ok());
        assert!(validate_email("not-an-email").is_err());
        assert!(validate_email("a@@example.com").is_err());
        assert!(validate_email("a@nodot").is_err());
        assert!(validate_email("@example.com").is_err());
        assert!(validate_email("a@example..com").is_err());
        assert!(validate_email("a b@example.com").is_err());
        assert!(validate_email("a@example.com ").is_err());
        assert!(validate_email("a@.com").is_err());
        assert!(validate_email("a@.example.com").is_err());
        assert!(validate_email("ab").is_err());
    }

    #[test]
    fn display_names_trim_to_one_to_sixty_chars() {
        let rules = RuleConstants::default();
        let padded = request("a@example.com", "1234567890", "   Trimmed Name   ");
        assert!(validate_signup(&rules, &padded).is_ok());
        let blank = request("a@example.com", "1234567890", "     ");
        assert!(validate_signup(&rules, &blank).is_err());
        let long = request("a@example.com", "1234567890", &"n".repeat(61));
        assert!(validate_signup(&rules, &long).is_err());
        let edge = request("a@example.com", "1234567890", &"n".repeat(60));
        assert!(validate_signup(&rules, &edge).is_ok());
    }

    #[test]
    fn login_failures_share_one_message() {
        assert_eq!(INVALID_CREDENTIALS, "invalid email or password");
    }
}
