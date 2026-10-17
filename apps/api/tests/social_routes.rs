//! Social boards route integration tests: the real router driven with
//! `tower::oneshot` against a scratch Postgres.
//!
//! Requirements: a Postgres the test user can `CREATE DATABASE` on, e.g.
//! the compose stack from `infra/docker-compose.yml`:
//!
//! ```text
//! docker compose -f infra/docker-compose.yml up -d postgres
//! WAVEFORM_TEST_DATABASE_URL=postgres://waveform:waveform@localhost:5432/waveform \
//!     cargo test -p waveform-api --test social_routes
//! ```
//!
//! Without the env var every test prints a skip notice and returns.

use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{header, Request, Response, StatusCode};
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;
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
/// A valid-length session secret; token hashes derive from it.
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

fn boards_request(token: Option<&str>, query: &str) -> Request<Body> {
    let mut builder = Request::builder()
        .method("GET")
        .uri(format!("/social/boards?{query}"));
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    builder.body(Body::empty()).expect("build request")
}

async fn send(app: &axum::Router, request: Request<Body>) -> Response<Body> {
    app.to_owned()
        .oneshot(request)
        .await
        .expect("router is infallible")
}

async fn body_json(response: Response<Body>) -> Value {
    let bytes = to_bytes(response.into_body(), BODY_LIMIT)
        .await
        .expect("read body");
    serde_json::from_slice(&bytes).expect("response body is JSON")
}

/// A signed-up fixture account: its bearer token, user id, and email.
struct Account {
    token: String,
    user_id: Uuid,
    email: String,
}

/// Sign a fixture account up; returns its bearer token, user id, and email.
async fn sign_up(app: &axum::Router, display_name: &str) -> Account {
    let email = format!("{}@social.test", Uuid::new_v4().simple());
    let request = Request::builder()
        .method("POST")
        .uri("/auth/signup")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({
                "email": email,
                "password": PASSWORD,
                "display_name": display_name,
            })
            .to_string(),
        ))
        .expect("build request");
    let response = send(app, request).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let body = body_json(response).await;
    let token = body["token"].as_str().expect("token").to_owned();
    let user_id = body["user"]["id"]
        .as_str()
        .expect("user id")
        .parse()
        .expect("user id is a uuid");
    Account {
        token,
        user_id,
        email,
    }
}

/// Insert a bodyweight reading for a user on `local_date`.
async fn seed_bodyweight(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    local_date: chrono::NaiveDate,
    weight_kg: f64,
) {
    sqlx::query(
        "INSERT INTO body_stats (id, user_id, local_date, weight_kg) VALUES ($1, $2, $3, $4)",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(local_date)
    .bind(weight_kg)
    .execute(pool)
    .await
    .expect("insert bodyweight");
}

/// Insert one working bench-press set for a user on `local_date`.
async fn seed_bench(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    local_date: chrono::NaiveDate,
    weight_kg: f64,
    reps: i32,
) {
    let exercise = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO exercises (id, owner_id, name, muscle_group) \
         VALUES ($1, $2, 'Bench Press (Barbell)', 'test')",
    )
    .bind(exercise)
    .bind(user_id)
    .execute(pool)
    .await
    .expect("insert exercise");

    let workout = Uuid::new_v4();
    sqlx::query("INSERT INTO workout_sessions (id, user_id, local_date) VALUES ($1, $2, $3)")
        .bind(workout)
        .bind(user_id)
        .bind(local_date)
        .execute(pool)
        .await
        .expect("insert workout");

    let entry = Uuid::new_v4();
    sqlx::query("INSERT INTO exercise_entries (id, workout_id, exercise_id) VALUES ($1, $2, $3)")
        .bind(entry)
        .bind(workout)
        .bind(exercise)
        .execute(pool)
        .await
        .expect("insert exercise entry");

    sqlx::query(
        "INSERT INTO set_entries (id, exercise_entry_id, set_index, weight_kg, reps, is_warmup) \
         VALUES ($1, $2, 0, $3, $4, false)",
    )
    .bind(Uuid::new_v4())
    .bind(entry)
    .bind(weight_kg)
    .bind(reps)
    .execute(pool)
    .await
    .expect("insert set");
}

#[tokio::test]
async fn boards_require_a_valid_bearer_session() {
    let Some(db) = support::migrated_scratch("boards auth").await else {
        return;
    };
    let app = routes::router(test_state(&db));

    let response = send(&app, boards_request(None, "window=7d")).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "no header");
    assert_eq!(body_json(response).await["code"], "unauthorized");

    let bad = format!("{:064x}", 9);
    let response = send(&app, boards_request(Some(&bad), "window=7d")).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "unknown token");
    assert_eq!(body_json(response).await["code"], "unauthorized");

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn boards_return_ranked_boards_for_the_crew() {
    let Some(db) = support::migrated_scratch("boards payload").await else {
        return;
    };
    let app = routes::router(test_state(&db));
    let alice = sign_up(&app, "Alice").await;

    let response = send(&app, boards_request(Some(&alice.token), "window=4w")).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;

    assert_eq!(body["window"], "4w");
    assert_eq!(
        body["marquee_lifts"],
        json!(["Back Squat", "Bench Press", "Deadlift", "Overhead Press"])
    );
    // The crew is the whole cohort, so the fresh account appears on the
    // Consistency board at zero active days.
    let consistency = body["consistency"].as_array().expect("consistency array");
    assert_eq!(consistency.len(), 1);
    assert_eq!(consistency[0]["user"]["id"], json!(alice.user_id));
    assert_eq!(consistency[0]["user"]["display_name"], "Alice");
    assert_eq!(consistency[0]["active_days"], 0);
    assert_eq!(consistency[0]["rank"], 1);
    // The three lifting boards plus the discipline groups are present.
    assert!(body["lifting"]["volume"].is_array());
    assert!(body["lifting"]["e1rm"].as_array().expect("e1rm").len() == 4);
    assert!(body["cycling"]["distance"].is_array());
    assert!(body["climbing"].is_array());

    // Privacy: no email and no body_stats column anywhere in the body.
    let serialized = body.to_string();
    assert!(
        !serialized.contains(&alice.email),
        "email leaked: {serialized}"
    );
    assert!(
        !serialized.contains("@social.test"),
        "email leaked: {serialized}"
    );
    assert!(
        !serialized.contains("weight_kg"),
        "weight leaked: {serialized}"
    );
    assert!(
        !serialized.contains("bodyweight"),
        "bodyweight leaked: {serialized}"
    );
    assert!(
        !serialized.contains("bodyfat"),
        "bodyfat leaked: {serialized}"
    );

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn boards_reject_unknown_windows_with_400() {
    let Some(db) = support::migrated_scratch("boards window").await else {
        return;
    };
    let app = routes::router(test_state(&db));
    let alice = sign_up(&app, "Alice").await;

    for query in ["window=1d", "window=", "window=month"] {
        let response = send(&app, boards_request(Some(&alice.token), query)).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "query {query}");
        assert_eq!(body_json(response).await["code"], "bad_request");
    }

    // Absent window defaults to 7d.
    let response = send(&app, boards_request(Some(&alice.token), "")).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await["window"], "7d");

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn boards_never_serialize_a_bodyweight_or_email() {
    let Some(db) = support::migrated_scratch("boards privacy").await else {
        return;
    };
    let app = routes::router(test_state(&db));
    let alice = sign_up(&app, "Alice").await;
    let bob = sign_up(&app, "Bob").await;

    // Alice carries a distinctive bodyweight and one marquee set; Bob is a
    // second account whose email must never travel.
    let today = chrono::Utc::now().date_naive();
    seed_bodyweight(&db.pool, alice.user_id, today, 72.5).await;
    seed_bench(&db.pool, alice.user_id, today, 80.0, 5).await;

    let response = send(&app, boards_request(Some(&alice.token), "window=4w")).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;

    // The absolute bench best drives the relative ratio.
    let bench = body["lifting"]["e1rm"]
        .as_array()
        .expect("e1rm array")
        .iter()
        .find(|board| board["lift"] == "Bench Press")
        .expect("bench board");
    let best_e1rm = bench["entries"][0]["best_e1rm_kg"]
        .as_f64()
        .expect("best e1rm");

    let relative = body["lifting"]["relative_e1rm"]
        .as_array()
        .expect("relative array");
    assert_eq!(
        relative.len(),
        1,
        "only Alice has a marquee best and weight"
    );
    let ratio = relative[0]["ratio"].as_f64().expect("ratio");
    // The ratio tracks best e1RM / 72.5 (rounded to two decimals), so
    // inversion recovers 72.5 only approximately.
    let expected = best_e1rm / 72.5;
    assert!(
        (ratio - expected).abs() < 0.01,
        "ratio {ratio} should track best / 72.5 = {expected}"
    );
    assert_ne!(
        best_e1rm / ratio,
        72.5,
        "rounding must keep the bodyweight only approximately recoverable"
    );

    let serialized = body.to_string();
    assert!(
        !serialized.contains("72.5"),
        "bodyweight leaked: {serialized}"
    );
    assert!(
        !serialized.contains(&alice.email),
        "email leaked: {serialized}"
    );
    assert!(
        !serialized.contains(&bob.email),
        "second account email leaked: {serialized}"
    );

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn tied_members_share_a_rank_over_the_wire() {
    let Some(db) = support::migrated_scratch("boards ties").await else {
        return;
    };
    let app = routes::router(test_state(&db));
    let alice = sign_up(&app, "Alice").await;
    let bob = sign_up(&app, "Bob").await;

    // Identical bodyweight and marquee set, so the boards tie.
    let today = chrono::Utc::now().date_naive();
    seed_bodyweight(&db.pool, alice.user_id, today, 75.0).await;
    seed_bodyweight(&db.pool, bob.user_id, today, 75.0).await;
    seed_bench(&db.pool, alice.user_id, today, 80.0, 5).await;
    seed_bench(&db.pool, bob.user_id, today, 80.0, 5).await;

    let response = send(&app, boards_request(Some(&alice.token), "window=4w")).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;

    // Lifting volume: both logged 80 x 5 = 400 kg, so both rank 1.
    let volume = body["lifting"]["volume"].as_array().expect("volume array");
    assert_eq!(volume.len(), 2);
    let volume_ranks: Vec<u64> = volume
        .iter()
        .map(|entry| entry["rank"].as_u64().expect("rank"))
        .collect();
    assert_eq!(volume_ranks, vec![1, 1], "tied volume shares rank 1");

    // The relative board ties on the rounded ratio too.
    let relative = body["lifting"]["relative_e1rm"]
        .as_array()
        .expect("relative array");
    assert_eq!(relative.len(), 2);
    let relative_ranks: Vec<u64> = relative
        .iter()
        .map(|entry| entry["rank"].as_u64().expect("rank"))
        .collect();
    assert_eq!(relative_ranks, vec![1, 1]);

    support::drop_scratch(db).await;
}
