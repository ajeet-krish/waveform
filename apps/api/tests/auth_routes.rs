//! Auth route integration tests: the real router (`healthz` plus the
//! auth surface, CORS layer included) driven with `tower::oneshot`
//! against a scratch Postgres.
//!
//! Requirements: a Postgres the test user can `CREATE DATABASE` on, e.g.
//! the compose stack from `infra/docker-compose.yml`:
//!
//! ```text
//! docker compose -f infra/docker-compose.yml up -d postgres
//! WAVEFORM_TEST_DATABASE_URL=postgres://waveform:waveform@localhost:5432/waveform \
//!     cargo test -p waveform-api --test auth_routes
//! ```
//!
//! Without the env var every test prints a skip notice and returns.

use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{header, Request, Response, StatusCode};
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;
use waveform_api::auth::hash_token;
use waveform_api::config::Config;
use waveform_api::rate_limit::LoginLimiter;
use waveform_api::routes;
use waveform_api::state::AppState;

// Shared scratch-DB support lives with the db suite; including it here
// keeps one implementation of the throwaway-database pattern.
#[path = "../../../crates/db/tests/support/mod.rs"]
mod support;

/// The deployed web origin this suite pins CORS to.
const TEST_ORIGIN: &str = "https://ajeet-krish.github.io";
/// A valid-length session secret; tests derive token hashes with it.
const TEST_SECRET: &str = "test-session-secret-0123456789abcdef0123456789abcdef";
/// The password every fixture account uses.
const PASSWORD: &str = "correct horse battery staple";
/// Enough headroom for any response body in this suite.
const BODY_LIMIT: usize = 1_000_000;

fn test_state(db: &support::ScratchDb) -> AppState {
    AppState {
        pool: db.pool.clone(),
        config: Arc::new(Config {
            database_url: db.url(),
            host: "0.0.0.0".to_owned(),
            port: 8080,
            run_migrations: false,
            session_secret: TEST_SECRET.to_owned(),
            allowed_web_origin: TEST_ORIGIN.to_owned(),
        }),
        login_limiter: LoginLimiter::new(),
    }
}

fn json_request(method: &str, uri: &str, body: Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .expect("build request")
}

fn signup_request(email: &str, display_name: &str, password: &str) -> Request<Body> {
    json_request(
        "POST",
        "/auth/signup",
        json!({ "email": email, "password": password, "display_name": display_name }),
    )
}

fn login_request(email: &str, password: &str) -> Request<Body> {
    json_request(
        "POST",
        "/auth/login",
        json!({ "email": email, "password": password }),
    )
}

fn bearer(uri: &str, method: &str, token: &str) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .expect("build request")
}

async fn send(app: &axum::Router, request: Request<Body>) -> Response<Body> {
    app.to_owned()
        .oneshot(request)
        .await
        .expect("router is infallible")
}

async fn body_bytes(response: Response<Body>) -> Vec<u8> {
    to_bytes(response.into_body(), BODY_LIMIT)
        .await
        .expect("read body")
        .to_vec()
}

async fn body_json(response: Response<Body>) -> Value {
    let bytes = body_bytes(response).await;
    serde_json::from_slice(&bytes).expect("response body is JSON")
}

/// Sign a fixture account up and return its bearer token.
async fn signed_up_token(app: &axum::Router, email: &str) -> String {
    let response = send(app, signup_request(email, "Fixture", PASSWORD)).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let body = body_json(response).await;
    body["token"].as_str().expect("token").to_owned()
}

#[tokio::test]
async fn signup_answers_201_and_the_token_works_on_me() {
    let Some(db) = support::migrated_scratch("signup round trip").await else {
        return;
    };
    let app = routes::router(test_state(&db));

    let email = format!("{}@routes.test", Uuid::new_v4().simple());
    let response = send(&app, signup_request(&email, "  Round Trip  ", PASSWORD)).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let body = body_json(response).await;
    let token = body["token"].as_str().expect("token").to_owned();
    assert_eq!(token.len(), 64, "tokens are 32 random bytes, hex-encoded");
    assert!(body["expires_at"].is_string(), "expiry travels in the body");
    assert_eq!(body["user"]["email"], email);
    assert_eq!(body["user"]["display_name"], "Round Trip", "names trim");
    assert!(
        body["user"].get("password_hash").is_none(),
        "the hash must never reach the wire: {body}"
    );

    let response = send(&app, bearer("/auth/me", "GET", &token)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let me = body_json(response).await;
    assert_eq!(me["email"], email);
    assert!(
        me.get("password_hash").is_none(),
        "/auth/me must not leak the hash: {me}"
    );

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn signup_rejects_short_passwords_and_bad_emails_with_422() {
    let Some(db) = support::migrated_scratch("signup validation").await else {
        return;
    };
    let app = routes::router(test_state(&db));

    let email = format!("{}@routes.test", Uuid::new_v4().simple());
    let response = send(&app, signup_request(&email, "Shorty", "too-short")).await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = body_json(response).await;
    assert_eq!(body["code"], "invalid_payload");

    let response = send(&app, signup_request("not-an-email", "Shorty", PASSWORD)).await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body_json(response).await["code"], "invalid_payload");

    let response = send(&app, signup_request("a@nodot", "Shorty", PASSWORD)).await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn repeated_invalid_signups_throttle_the_email_with_429() {
    let Some(db) = support::migrated_scratch("signup throttle").await else {
        return;
    };
    let app = routes::router(test_state(&db));

    // A well-formed signup that fails validation: each attempt counts
    // toward the shared per-email window without creating an account.
    let email = format!("{}@routes.test", Uuid::new_v4().simple());
    for attempt in 1..=10 {
        let response = send(&app, signup_request(&email, "Throttled", "too-short")).await;
        assert_eq!(
            response.status(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "attempt {attempt} must answer 422"
        );
        assert_eq!(body_json(response).await["code"], "invalid_payload");
    }

    // The eleventh attempt lands inside the locked window: 429 before
    // any validation or hashing work.
    let response = send(&app, signup_request(&email, "Throttled", "too-short")).await;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body_json(response).await["code"], "rate_limited");

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn duplicate_email_answers_409_with_the_specific_message() {
    let Some(db) = support::migrated_scratch("duplicate signup").await else {
        return;
    };
    let app = routes::router(test_state(&db));

    let email = format!("{}@routes.test", Uuid::new_v4().simple());
    let response = send(&app, signup_request(&email, "First", PASSWORD)).await;
    assert_eq!(response.status(), StatusCode::CREATED);

    // The same address in another casing is still the same account.
    let response = send(
        &app,
        signup_request(&email.to_uppercase(), "Second", PASSWORD),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body = body_json(response).await;
    assert_eq!(body["code"], "conflict");
    assert_eq!(body["message"], "an account with that email already exists");

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn login_succeeds_without_leaking_the_password_hash() {
    let Some(db) = support::migrated_scratch("login success").await else {
        return;
    };
    let app = routes::router(test_state(&db));

    let email = format!("{}@routes.test", Uuid::new_v4().simple());
    let token = signed_up_token(&app, &email).await;

    let response = send(&app, login_request(&email, PASSWORD)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    assert!(body["token"].as_str().expect("token").len() == 64);
    assert!(body["expires_at"].is_string());
    assert_eq!(body["user"]["email"], email);
    assert!(
        body["user"].get("password_hash").is_none(),
        "the login body must not leak the hash: {body}"
    );

    let response = send(
        &app,
        bearer("/auth/me", "GET", body["token"].as_str().unwrap()),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    // The signup token still resolves: login mints a second session.
    let response = send(&app, bearer("/auth/me", "GET", &token)).await;
    assert_eq!(response.status(), StatusCode::OK);

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn every_login_miss_is_one_byte_identical_401() {
    let Some(db) = support::migrated_scratch("login misses").await else {
        return;
    };
    let app = routes::router(test_state(&db));

    let email = format!("{}@routes.test", Uuid::new_v4().simple());
    signed_up_token(&app, &email).await;

    // A bucket 1 era account with no password hash: it can never log in.
    let no_hash_email = format!("nohash-{}@routes.test", Uuid::new_v4().simple());
    sqlx::query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'No Hash')")
        .bind(Uuid::new_v4())
        .bind(&no_hash_email)
        .execute(&db.pool)
        .await
        .expect("insert NULL-hash user");

    let misses = [
        ("nobody-ever-registered@routes.test", "any password at all"),
        (email.as_str(), "definitely the wrong password"),
        (no_hash_email.as_str(), PASSWORD),
    ];
    let mut bodies: Vec<Vec<u8>> = Vec::new();
    for (miss_email, miss_password) in misses {
        let response = send(&app, login_request(miss_email, miss_password)).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        bodies.push(body_bytes(response).await);
    }

    assert_eq!(
        bodies[0], bodies[1],
        "unknown and wrong-password must match"
    );
    assert_eq!(bodies[0], bodies[2], "unknown and NULL-hash must match");
    let parsed: Value = serde_json::from_slice(&bodies[0]).expect("error envelope");
    assert_eq!(parsed["code"], "unauthorized");
    assert_eq!(parsed["message"], "invalid email or password");

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn expired_sessions_get_401_on_me() {
    let Some(db) = support::migrated_scratch("expired session").await else {
        return;
    };
    let app = routes::router(test_state(&db));

    let email = format!("{}@routes.test", Uuid::new_v4().simple());
    let token = signed_up_token(&app, &email).await;
    let response = send(&app, bearer("/auth/me", "GET", &token)).await;
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "the fresh token resolves"
    );

    // Hand-insert a session that is already past its expiry.
    let user_id: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE lower(email) = lower($1)")
        .bind(&email)
        .fetch_one(&db.pool)
        .await
        .expect("find user id");
    let expired_token = format!("{:064x}", 7);
    let expired_hash = hash_token(TEST_SECRET, &expired_token);
    sqlx::query(
        "INSERT INTO sessions (id, user_id, token_hash, expires_at) \
         VALUES ($1, $2, $3, now() - interval '1 day')",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(&expired_hash)
    .execute(&db.pool)
    .await
    .expect("insert expired session");

    let response = send(&app, bearer("/auth/me", "GET", &expired_token)).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn logout_is_idempotent_and_revokes_the_session() {
    let Some(db) = support::migrated_scratch("logout").await else {
        return;
    };
    let app = routes::router(test_state(&db));

    let email = format!("{}@routes.test", Uuid::new_v4().simple());
    let token = signed_up_token(&app, &email).await;

    let response = send(&app, bearer("/auth/logout", "POST", &token)).await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let response = send(&app, bearer("/auth/me", "GET", &token)).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "revoked");

    // Idempotent: the second logout is another 204, not an error.
    let response = send(&app, bearer("/auth/logout", "POST", &token)).await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    // Even without a token, logout stays a no-op 204.
    let response = send(
        &app,
        Request::builder()
            .method("POST")
            .uri("/auth/logout")
            .body(Body::empty())
            .expect("build request"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn me_requires_a_valid_bearer_session() {
    let Some(db) = support::migrated_scratch("me guards").await else {
        return;
    };
    let app = routes::router(test_state(&db));

    let response = send(
        &app,
        Request::builder()
            .method("GET")
            .uri("/auth/me")
            .body(Body::empty())
            .expect("build request"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "no header");

    let response = send(&app, bearer("/auth/me", "GET", &format!("{:064x}", 9))).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "unknown token");

    let wrong_scheme = Request::builder()
        .method("GET")
        .uri("/auth/me")
        .header(header::AUTHORIZATION, "Basic dXNlcjpwYXNz")
        .body(Body::empty())
        .expect("build request");
    let response = send(&app, wrong_scheme).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "wrong scheme");

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn eleventh_failed_login_is_429_and_success_clears_the_window() {
    let Some(db) = support::migrated_scratch("login rate limit").await else {
        return;
    };
    let app = routes::router(test_state(&db));

    let email = format!("{}@routes.test", Uuid::new_v4().simple());
    signed_up_token(&app, &email).await;

    // A few failures, then a success: the success must clear the window.
    for _ in 0..3 {
        let response = send(&app, login_request(&email, "wrong password")).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    let response = send(&app, login_request(&email, PASSWORD)).await;
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "success is not throttled"
    );

    // The window restarted at zero: ten more failures all answer 401.
    for attempt in 1..=10 {
        let response = send(&app, login_request(&email, "still wrong")).await;
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "attempt {attempt} must answer 401, proving the window reset"
        );
    }

    // The eleventh failure inside the window is throttled.
    let response = send(&app, login_request(&email, "wrong again")).await;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body_json(response).await["code"], "rate_limited");

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn cors_preflight_allows_only_the_configured_origin() {
    let Some(db) = support::migrated_scratch("cors").await else {
        return;
    };
    let app = routes::router(test_state(&db));

    let preflight = Request::builder()
        .method("OPTIONS")
        .uri("/auth/login")
        .header(header::ORIGIN, TEST_ORIGIN)
        .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
        .header(
            header::ACCESS_CONTROL_REQUEST_HEADERS,
            "authorization,content-type",
        )
        .body(Body::empty())
        .expect("build request");
    let response = send(&app, preflight).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("access-control-allow-origin")
            .map(|value| value.to_str().expect("ascii").to_owned()),
        Some(TEST_ORIGIN.to_owned()),
        "the configured origin is echoed on preflight"
    );
    let allow_methods = response
        .headers()
        .get("access-control-allow-methods")
        .expect("allow-methods header")
        .to_str()
        .expect("ascii")
        .to_owned();
    assert!(allow_methods.contains("POST"), "POST must be allowed");
    assert_eq!(
        response
            .headers()
            .get("access-control-max-age")
            .map(|value| value.to_str().expect("ascii").to_owned()),
        Some("600".to_owned())
    );

    // Any other origin gets no allow-origin header at all.
    let foreign = Request::builder()
        .method("OPTIONS")
        .uri("/auth/login")
        .header(header::ORIGIN, "https://evil.example.com")
        .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
        .body(Body::empty())
        .expect("build request");
    let response = send(&app, foreign).await;
    assert!(
        response
            .headers()
            .get("access-control-allow-origin")
            .is_none(),
        "a foreign origin must not be allowed"
    );

    // Regular responses carry the header for the configured origin too.
    let response = send(
        &app,
        Request::builder()
            .method("GET")
            .uri("/healthz")
            .header(header::ORIGIN, TEST_ORIGIN)
            .body(Body::empty())
            .expect("build request"),
    )
    .await;
    assert_eq!(
        response
            .headers()
            .get("access-control-allow-origin")
            .map(|value| value.to_str().expect("ascii").to_owned()),
        Some(TEST_ORIGIN.to_owned())
    );

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn malformed_json_returns_the_error_envelope() {
    let Some(db) = support::migrated_scratch("malformed json").await else {
        return;
    };
    let app = routes::router(test_state(&db));

    let request = Request::builder()
        .method("POST")
        .uri("/auth/login")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{\"email\": \"a@example.com\", "))
        .expect("build request");
    let response = send(&app, request).await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = body_json(response).await;
    assert_eq!(body["code"], "invalid_payload");
    assert!(
        body["message"]
            .as_str()
            .is_some_and(|message| !message.is_empty()),
        "the envelope carries a human message: {body}"
    );

    // Well-formed JSON that misses required fields lands in the same
    // envelope.
    let response = send(
        &app,
        json_request("POST", "/auth/login", json!({ "email": "a@example.com" })),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body_json(response).await["code"], "invalid_payload");

    support::drop_scratch(db).await;
}
