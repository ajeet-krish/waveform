//! Sync route integration tests: the real router (healthz, auth, and
//! the sync surface, CORS plus the body limit included) driven with
//! `tower::oneshot` against a scratch Postgres.
//!
//! Requirements: a Postgres the test user can `CREATE DATABASE` on, e.g.
//! the compose stack from `infra/docker-compose.yml`:
//!
//! ```text
//! docker compose -f infra/docker-compose.yml up -d postgres
//! WAVEFORM_TEST_DATABASE_URL=postgres://waveform:waveform@localhost:5432/waveform \
//!     cargo test -p waveform-api --test sync_routes
//! ```
//!
//! Without the env var every test prints a skip notice and returns.

use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{header, Request, Response, StatusCode};
use chrono::{DateTime, Duration, TimeZone, Utc};
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;
use waveform_api::config::Config;
use waveform_api::rate_limit::LoginLimiter;
use waveform_api::routes;
use waveform_api::state::AppState;
use waveform_db::dto::RuleConstants;

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

fn signup_request(email: &str, display_name: &str) -> Request<Body> {
    Request::builder()
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
        .expect("build request")
}

fn push_request(token: Option<&str>, body: &str) -> Request<Body> {
    let mut builder = Request::builder()
        .method("POST")
        .uri("/sync/push")
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    builder
        .body(Body::from(body.to_owned()))
        .expect("build request")
}

fn pull_request(token: Option<&str>, query: &str) -> Request<Body> {
    let mut builder = Request::builder()
        .method("GET")
        .uri(format!("/sync/pull?{query}"));
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

/// Sign a fixture account up; returns its bearer token and user id.
async fn sign_up(app: &axum::Router, display_name: &str) -> (String, Uuid) {
    let email = format!("{}@sync.test", Uuid::new_v4().simple());
    let response = send(app, signup_request(&email, display_name)).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let body = body_json(response).await;
    let token = body["token"].as_str().expect("token").to_owned();
    let user_id = body["user"]["id"]
        .as_str()
        .expect("user id")
        .parse()
        .expect("user id is a uuid");
    (token, user_id)
}

/// POST one push batch; the response is checked per test (413, 409, and
/// 422 paths all reach this helper too).
async fn send_push(app: &axum::Router, token: &str, ops: &[Value]) -> Response<Body> {
    let body = json!({ "ops": ops });
    send(app, push_request(Some(token), &body.to_string())).await
}

/// The `results` array of a successful (HTTP 200) push.
async fn push_results(app: &axum::Router, token: &str, ops: &[Value]) -> Vec<Value> {
    let response = send_push(app, token, ops).await;
    assert_eq!(response.status(), StatusCode::OK, "push must land");
    let body = body_json(response).await;
    body["results"]
        .as_array()
        .expect("results array")
        .to_owned()
}

/// The page body of a successful (HTTP 200) pull.
async fn pull_page(app: &axum::Router, token: &str, query: &str) -> Value {
    let response = send(app, pull_request(Some(token), query)).await;
    assert_eq!(response.status(), StatusCode::OK, "pull must succeed");
    body_json(response).await
}

fn status_of(result: &Value) -> &str {
    result["status"].as_str().expect("op status")
}

fn error_of(result: &Value) -> Option<&str> {
    result["error"].as_str()
}

/// Row ids of one pull page, in page order.
fn row_ids(page: &Value) -> Vec<Uuid> {
    page["rows"]
        .as_array()
        .expect("rows")
        .iter()
        .map(|row| {
            row["id"]
                .as_str()
                .expect("row id")
                .parse()
                .expect("row id is a uuid")
        })
        .collect()
}

/// Deterministic op ids: readable in the source, stable per test.
fn op_id(label: &str) -> Uuid {
    Uuid::new_v5(&Uuid::NAMESPACE_URL, label.as_bytes())
}

/// A client LWW timestamp in the past, so the server clamp passes it
/// untouched and it drives last-write-wins by itself.
fn at(second: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 14, 12, 0, 0).unwrap() + Duration::seconds(i64::from(second))
}

fn op(label: &str, entity: &str, action: &str, payload: Value, updated_at: DateTime<Utc>) -> Value {
    json!({
        "op_id": op_id(label),
        "entity": entity,
        "action": action,
        "payload": payload,
        "updated_at": updated_at.to_rfc3339(),
    })
}

/// A full client row payload for a workout session (the outbox contract:
/// create, update, and delete payloads all carry the full row).
fn workout_payload(row: Uuid, owner: Uuid, notes: &str) -> Value {
    json!({
        "id": row,
        "user_id": owner,
        "local_date": "2026-10-14",
        "started_at": null,
        "duration_min": null,
        "routine_id": null,
        "notes": notes,
        "created_at": "2026-10-14T09:30:00.000Z",
    })
}

/// Two pushes need distinct server stamps for strict order assertions;
/// the stamp resolution is a microsecond, so a few milliseconds is an
/// eternity in comparison.
fn pace() {
    std::thread::sleep(std::time::Duration::from_millis(5));
}

async fn row_count(pool: &sqlx::PgPool, sql: &str, id: Uuid) -> i64 {
    sqlx::query_scalar(sql)
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("count")
}

#[tokio::test]
async fn push_requires_a_valid_bearer_session() {
    let Some(db) = support::migrated_scratch("push auth").await else {
        return;
    };
    let app = routes::router(test_state(&db));
    let empty = json!({ "ops": [] }).to_string();

    let response = send(&app, push_request(None, &empty)).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "no header");
    assert_eq!(body_json(response).await["code"], "unauthorized");

    let bad = format!("{:064x}", 9);
    let response = send(&app, push_request(Some(&bad), &empty)).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "unknown token");
    assert_eq!(body_json(response).await["code"], "unauthorized");

    // A valid session takes the empty batch all the way through: 200
    // with one result per op (none).
    let (token, _) = sign_up(&app, "Alice").await;
    let response = send_push(&app, &token, &[]).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await["results"], json!([]));

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn push_forces_the_session_user_onto_the_stored_row() {
    let Some(db) = support::migrated_scratch("push round trip").await else {
        return;
    };
    let app = routes::router(test_state(&db));
    let (token, session_user) = sign_up(&app, "Alice").await;
    let (_, foreign_user) = sign_up(&app, "Mallory").await;

    // The payload claims someone else owns the row; the session user
    // always wins.
    let row = Uuid::new_v4();
    let ops = [op(
        "spoof-owner",
        "workout_sessions",
        "create",
        workout_payload(row, foreign_user, "mine"),
        at(10),
    )];
    let results = push_results(&app, &token, &ops).await;
    assert_eq!(results.len(), 1);
    assert_eq!(status_of(&results[0]), "applied");

    // The stored row belongs to the session user...
    let owner: Uuid = sqlx::query_scalar("SELECT user_id FROM workout_sessions WHERE id = $1")
        .bind(row)
        .fetch_one(&db.pool)
        .await
        .expect("stored row");
    assert_eq!(owner, session_user, "the payload user_id never lands");

    // ... and a pull as the session user echoes the session user too.
    let page = pull_page(&app, &token, "entity=workout_sessions&limit=10").await;
    let rows = page["rows"].as_array().expect("rows");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], json!(row));
    assert_eq!(rows[0]["payload"]["user_id"], json!(session_user));

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn replay_is_duplicate_and_an_older_op_is_discarded_stale() {
    let Some(db) = support::migrated_scratch("replay and stale").await else {
        return;
    };
    let app = routes::router(test_state(&db));
    let (token, user) = sign_up(&app, "Alice").await;
    let row = Uuid::new_v4();

    // First delivery applies.
    let first = op(
        "lww-1",
        "workout_sessions",
        "create",
        workout_payload(row, user, "v1"),
        at(10),
    );
    let results = push_results(&app, &token, std::slice::from_ref(&first)).await;
    assert_eq!(status_of(&results[0]), "applied");

    // The exact same op id is a no-op success, never a second write.
    let results = push_results(&app, &token, &[first]).await;
    assert_eq!(status_of(&results[0]), "duplicate");
    assert_eq!(error_of(&results[0]), None);

    // A newer write lands...
    let newer = op(
        "lww-2",
        "workout_sessions",
        "update",
        workout_payload(row, user, "v2"),
        at(20),
    );
    let results = push_results(&app, &token, &[newer]).await;
    assert_eq!(status_of(&results[0]), "applied");

    // ... and an older one is discarded, leaving v2 untouched.
    let stale = op(
        "lww-3",
        "workout_sessions",
        "update",
        workout_payload(row, user, "v1.5"),
        at(15),
    );
    let results = push_results(&app, &token, std::slice::from_ref(&stale)).await;
    assert_eq!(status_of(&results[0]), "discarded_stale");
    assert_eq!(error_of(&results[0]), None);
    let notes: String = sqlx::query_scalar("SELECT notes FROM workout_sessions WHERE id = $1")
        .bind(row)
        .fetch_one(&db.pool)
        .await
        .expect("stored notes");
    assert_eq!(notes, "v2");

    // The stale op still claimed its id: replaying it is a duplicate.
    let results = push_results(&app, &token, &[stale]).await;
    assert_eq!(status_of(&results[0]), "duplicate");

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn a_foreign_op_id_aborts_the_batch_with_conflict() {
    let Some(db) = support::migrated_scratch("foreign op id").await else {
        return;
    };
    let app = routes::router(test_state(&db));
    let (alice_token, _) = sign_up(&app, "Alice").await;
    let (mallory_token, _) = sign_up(&app, "Mallory").await;

    // Mallory lands the shared op id on her own row first.
    let shared_row = Uuid::new_v4();
    let shared = op(
        "shared-op",
        "workout_sessions",
        "create",
        workout_payload(shared_row, Uuid::nil(), "mallory day"),
        at(10),
    );
    let results = push_results(&app, &mallory_token, &[shared]).await;
    assert_eq!(status_of(&results[0]), "applied");

    // Alice's batch: a good op, then Mallory's op id, then a trailing op
    // that must never run.
    let good_row = Uuid::new_v4();
    let trailing_row = Uuid::new_v4();
    let good = op(
        "alice-good",
        "workout_sessions",
        "create",
        workout_payload(good_row, Uuid::nil(), "v1"),
        at(11),
    );
    let foreign = op(
        "shared-op",
        "workout_sessions",
        "update",
        workout_payload(good_row, Uuid::nil(), "spoofed"),
        at(12),
    );
    let trailing = op(
        "alice-trailing",
        "workout_sessions",
        "create",
        workout_payload(trailing_row, Uuid::nil(), "never"),
        at(13),
    );
    let response = send_push(&app, &alice_token, &[good, foreign, trailing]).await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body = body_json(response).await;
    assert_eq!(body["code"], "conflict");
    assert_eq!(body["message"], "op id already used by another user");

    // The op before the conflict committed; the one after never ran.
    let landed = row_count(
        &db.pool,
        "SELECT count(*) FROM workout_sessions WHERE id = $1",
        good_row,
    )
    .await;
    assert_eq!(landed, 1, "ops before the foreign one still commit");
    let trailing_rows = row_count(
        &db.pool,
        "SELECT count(*) FROM workout_sessions WHERE id = $1",
        trailing_row,
    )
    .await;
    assert_eq!(trailing_rows, 0, "ops after the foreign one never run");
    let trailing_claims = row_count(
        &db.pool,
        "SELECT count(*) FROM client_ops WHERE id = $1",
        op_id("alice-trailing"),
    )
    .await;
    assert_eq!(trailing_claims, 0, "the trailing op id is not claimed");

    // Mallory's claim and row stay hers.
    let claim_owner: Uuid = sqlx::query_scalar("SELECT user_id FROM client_ops WHERE id = $1")
        .bind(op_id("shared-op"))
        .fetch_one(&db.pool)
        .await
        .expect("claim owner");
    let mallory_id: Uuid = sqlx::query_scalar("SELECT user_id FROM workout_sessions WHERE id = $1")
        .bind(shared_row)
        .fetch_one(&db.pool)
        .await
        .expect("stored owner");
    assert_eq!(claim_owner, mallory_id, "the claim stays with the owner");

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn a_push_over_the_ops_cap_is_413_with_zero_side_effects() {
    let Some(db) = support::migrated_scratch("ops cap").await else {
        return;
    };
    let app = routes::router(test_state(&db));
    let (token, user) = sign_up(&app, "Alice").await;

    let cap =
        usize::try_from(RuleConstants::default().sync.max_ops_per_push).expect("cap fits usize");
    assert_eq!(cap, 200, "the documented cap");
    let ops: Vec<Value> = (0..=cap)
        .map(|index| {
            op(
                &format!("over-cap-{index}"),
                "workout_sessions",
                "create",
                workout_payload(Uuid::new_v4(), user, "x"),
                at(10),
            )
        })
        .collect();
    assert_eq!(ops.len(), 201);

    let response = send_push(&app, &token, &ops).await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let body = body_json(response).await;
    assert_eq!(body["code"], "payload_too_large");
    assert!(
        body["message"]
            .as_str()
            .is_some_and(|message| message.contains("cap")),
        "the envelope explains the cap: {body}"
    );

    // Zero side effects: nothing claimed, nothing stored.
    let claims: i64 = sqlx::query_scalar("SELECT count(*) FROM client_ops WHERE user_id = $1")
        .bind(user)
        .fetch_one(&db.pool)
        .await
        .expect("count claims");
    assert_eq!(claims, 0, "an oversized batch never touches client_ops");
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM workout_sessions WHERE user_id = $1")
        .bind(user)
        .fetch_one(&db.pool)
        .await
        .expect("count rows");
    assert_eq!(rows, 0, "an oversized batch stores no rows");

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn an_oversized_body_is_413_with_the_error_envelope() {
    // The router's DefaultBodyLimit rejects a body over 2 MB before the
    // handler runs; ApiJson keeps that 413 instead of folding it into
    // the 422 envelope.
    let Some(db) = support::migrated_scratch("body limit").await else {
        return;
    };
    let app = routes::router(test_state(&db));
    let (token, user) = sign_up(&app, "Alice").await;

    let padding = "x".repeat(3 * 1024 * 1024);
    let ops = [op(
        "body-limit",
        "workout_sessions",
        "create",
        json!({
            "id": Uuid::new_v4(),
            "user_id": user,
            "local_date": "2026-10-14",
            "notes": padding,
            "created_at": "2026-10-14T09:30:00.000Z",
        }),
        at(10),
    )];
    let body = json!({ "ops": ops }).to_string();
    let response = send(&app, push_request(Some(&token), &body)).await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let envelope = body_json(response).await;
    assert_eq!(envelope["code"], "payload_too_large");

    let claims: i64 = sqlx::query_scalar("SELECT count(*) FROM client_ops WHERE user_id = $1")
        .bind(user)
        .fetch_one(&db.pool)
        .await
        .expect("count claims");
    assert_eq!(claims, 0, "the limit rejects before any database work");

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn malformed_push_json_is_422_invalid_payload() {
    let Some(db) = support::migrated_scratch("malformed push").await else {
        return;
    };
    let app = routes::router(test_state(&db));
    let (token, _) = sign_up(&app, "Alice").await;

    // Truncated JSON.
    let response = send(&app, push_request(Some(&token), "{\"ops\": [")).await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = body_json(response).await;
    assert_eq!(body["code"], "invalid_payload");
    assert!(
        body["message"]
            .as_str()
            .is_some_and(|message| !message.is_empty()),
        "the envelope carries a human message: {body}"
    );

    // Well-formed JSON that misses the required field lands the same way.
    let response = send(&app, push_request(Some(&token), "{\"nope\": []}")).await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body_json(response).await["code"], "invalid_payload");

    // Right shape, wrong type for ops.
    let response = send(&app, push_request(Some(&token), "{\"ops\": \"nope\"}")).await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body_json(response).await["code"], "invalid_payload");

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn a_missing_parent_is_retryable_and_stores_nothing() {
    let Some(db) = support::migrated_scratch("missing parent").await else {
        return;
    };
    let app = routes::router(test_state(&db));
    let (token, _) = sign_up(&app, "Alice").await;

    // The set's parent entry has not arrived yet: retryable, no claim,
    // no row, so the client can push the same op id again later.
    let set_id = Uuid::new_v4();
    let orphan_entry = Uuid::new_v4();
    let set_op = op(
        "orphan-set",
        "set_entries",
        "create",
        json!({
            "id": set_id,
            "exercise_entry_id": orphan_entry,
            "set_index": 0,
            "weight_kg": 100.0,
            "reps": 5,
            "is_warmup": false,
            "created_at": "2026-10-14T09:30:00.000Z",
        }),
        at(10),
    );
    let results = push_results(&app, &token, &[set_op]).await;
    assert_eq!(status_of(&results[0]), "retryable");
    assert_eq!(error_of(&results[0]), None);

    let sets = row_count(
        &db.pool,
        "SELECT count(*) FROM set_entries WHERE id = $1",
        set_id,
    )
    .await;
    assert_eq!(sets, 0, "a retryable op writes nothing");
    let claims = row_count(
        &db.pool,
        "SELECT count(*) FROM client_ops WHERE id = $1",
        op_id("orphan-set"),
    )
    .await;
    assert_eq!(claims, 0, "and claims nothing");

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn check_violations_and_catalog_rows_are_rejected_in_the_batch() {
    let Some(db) = support::migrated_scratch("rejections").await else {
        return;
    };
    let app = routes::router(test_state(&db));
    let (token, _) = sign_up(&app, "Alice").await;

    let (catalog_id, catalog_name): (Uuid, String) =
        sqlx::query_as("SELECT id, name FROM exercises WHERE owner_id IS NULL LIMIT 1")
            .fetch_one(&db.pool)
            .await
            .expect("pick a catalog row");

    let workout_id = Uuid::new_v4();
    let entry_id = Uuid::new_v4();
    let set_id = Uuid::new_v4();
    let ops = [
        op(
            "check-w",
            "workout_sessions",
            "create",
            workout_payload(workout_id, Uuid::nil(), "day"),
            at(10),
        ),
        op(
            "check-e",
            "exercise_entries",
            "create",
            json!({
                "id": entry_id,
                "workout_id": workout_id,
                "exercise_id": catalog_id,
                "order_index": 0,
                "notes": null,
                "created_at": "2026-10-14T09:30:00.000Z",
            }),
            at(11),
        ),
        // reps 40 breaks CHECK (reps BETWEEN 1 AND 36).
        op(
            "check-set",
            "set_entries",
            "create",
            json!({
                "id": set_id,
                "exercise_entry_id": entry_id,
                "set_index": 0,
                "weight_kg": 100.0,
                "reps": 40,
                "is_warmup": false,
                "created_at": "2026-10-14T09:30:00.000Z",
            }),
            at(12),
        ),
        // The server-owned global catalog is never writable.
        op(
            "check-hijack",
            "exercises",
            "update",
            json!({
                "id": catalog_id,
                "name": "Hijacked",
                "muscle_group": "chest",
                "equipment": null,
                "created_at": "2026-10-14T09:30:00.000Z",
            }),
            at(13),
        ),
    ];
    let results = push_results(&app, &token, &ops).await;
    assert_eq!(results.len(), 4, "every op is answered, in order");
    assert_eq!(status_of(&results[0]), "applied");
    assert_eq!(status_of(&results[1]), "applied");
    assert_eq!(status_of(&results[2]), "rejected");
    assert_eq!(error_of(&results[2]), Some("invalid_payload"));
    assert_eq!(status_of(&results[3]), "rejected");
    assert_eq!(error_of(&results[3]), Some("forbidden"));

    // Both rejections leave no trace.
    let sets = row_count(
        &db.pool,
        "SELECT count(*) FROM set_entries WHERE id = $1",
        set_id,
    )
    .await;
    assert_eq!(sets, 0, "the rejected row must not exist");
    let claims = row_count(
        &db.pool,
        "SELECT count(*) FROM client_ops WHERE id = $1",
        op_id("check-set"),
    )
    .await;
    assert_eq!(claims, 0, "a rejected op leaves no client_ops trace");
    let name_now: String = sqlx::query_scalar("SELECT name FROM exercises WHERE id = $1")
        .bind(catalog_id)
        .fetch_one(&db.pool)
        .await
        .expect("re-read catalog row");
    assert_eq!(name_now, catalog_name, "the catalog row is untouched");

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn pull_requires_a_bearer_session() {
    let Some(db) = support::migrated_scratch("pull auth").await else {
        return;
    };
    let app = routes::router(test_state(&db));

    let response = send(&app, pull_request(None, "entity=workout_sessions")).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "no header");
    assert_eq!(body_json(response).await["code"], "unauthorized");

    let bad = format!("{:064x}", 9);
    let response = send(&app, pull_request(Some(&bad), "entity=workout_sessions")).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "unknown token");
    assert_eq!(body_json(response).await["code"], "unauthorized");

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn pull_rejects_unknown_entities_bad_cursors_and_bad_queries() {
    let Some(db) = support::migrated_scratch("pull 400s").await else {
        return;
    };
    let app = routes::router(test_state(&db));
    let (token, _) = sign_up(&app, "Alice").await;

    // Unknown entity name.
    let response = send(&app, pull_request(Some(&token), "entity=bogus")).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = body_json(response).await;
    assert_eq!(body["code"], "bad_request");
    assert!(
        body["message"]
            .as_str()
            .is_some_and(|message| message.contains("unknown sync entity")),
        "the envelope names the problem: {body}"
    );

    // A malformed cursor is a 400 here, not an internal decode 500.
    let response = send(
        &app,
        pull_request(Some(&token), "entity=workout_sessions&cursor=not-a-cursor"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = body_json(response).await;
    assert_eq!(body["code"], "bad_request");
    assert!(
        body["message"]
            .as_str()
            .is_some_and(|message| message.contains("invalid cursor")),
        "the envelope names the cursor: {body}"
    );

    // An undeserializable query value (limit is not a number) is the
    // extractor's 400 too.
    let response = send(
        &app,
        pull_request(Some(&token), "entity=workout_sessions&limit=abc"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = body_json(response).await;
    assert_eq!(body["code"], "bad_request");
    assert!(
        body["message"]
            .as_str()
            .is_some_and(|message| message.contains("invalid query parameters")),
        "the envelope names the query failure: {body}"
    );

    // A missing entity is the same 400.
    let response = send(&app, pull_request(Some(&token), "limit=10")).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body_json(response).await["code"], "bad_request");

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn pull_pages_with_the_limit_and_delivers_the_tombstone_at_the_tip() {
    let Some(db) = support::migrated_scratch("pull paging").await else {
        return;
    };
    let app = routes::router(test_state(&db));
    let (token, user) = sign_up(&app, "Alice").await;

    let rows = [
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    ];
    for (index, row) in rows.iter().enumerate() {
        let ops = [op(
            &format!("page-{index}"),
            "workout_sessions",
            "create",
            workout_payload(*row, user, &format!("v{index}")),
            at(10 + u32::try_from(index).expect("index fits u32")),
        )];
        let results = push_results(&app, &token, &ops).await;
        assert_eq!(status_of(&results[0]), "applied");
        pace();
    }

    // Page one: the limit is honored and a full page hands out a cursor.
    let page = pull_page(&app, &token, "entity=workout_sessions&limit=2").await;
    let page_rows = page["rows"].as_array().expect("rows");
    assert_eq!(page_rows.len(), 2, "limit 2 pages two rows");
    assert_eq!(page_rows[0]["id"], json!(rows[0]));
    assert_eq!(page_rows[1]["id"], json!(rows[1]));
    for row in page_rows {
        assert!(
            row["payload"].get("applied_at").is_none(),
            "payload is the row minus applied_at"
        );
        assert_eq!(row["payload"]["user_id"], json!(user));
    }
    let cursor = page["next_cursor"]
        .as_str()
        .expect("a full page hands out a cursor")
        .to_owned();

    // Page two: the remaining rows, full again, so paging continues.
    let page = pull_page(
        &app,
        &token,
        &format!("entity=workout_sessions&limit=2&cursor={cursor}"),
    )
    .await;
    let page_rows = page["rows"].as_array().expect("rows");
    assert_eq!(page_rows.len(), 2);
    assert_eq!(page_rows[0]["id"], json!(rows[2]));
    assert_eq!(page_rows[1]["id"], json!(rows[3]));
    let tip_cursor = page["next_cursor"]
        .as_str()
        .expect("page two is full too")
        .to_owned();

    // Delete the last row: its tombstone crosses the tip, and the page
    // it arrives on was not filled, so next_cursor is null.
    let delete = op(
        "page-delete",
        "workout_sessions",
        "delete",
        workout_payload(rows[3], user, "v3"),
        at(20),
    );
    let results = push_results(&app, &token, &[delete]).await;
    assert_eq!(status_of(&results[0]), "applied");
    pace();

    let page = pull_page(
        &app,
        &token,
        &format!("entity=workout_sessions&limit=2&cursor={tip_cursor}"),
    )
    .await;
    let page_rows = page["rows"].as_array().expect("rows");
    assert_eq!(page_rows.len(), 1, "only the tombstone crossed the tip");
    assert_eq!(page_rows[0]["id"], json!(rows[3]));
    assert!(
        page_rows[0]["payload"]["deleted_at"].is_string(),
        "the tombstone is visible in the payload: {page_rows:?}"
    );
    assert!(
        page["next_cursor"].is_null(),
        "an unfilled page ends paging with a null cursor: {page}"
    );

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn pull_is_scoped_to_the_session_user() {
    let Some(db) = support::migrated_scratch("pull scoping").await else {
        return;
    };
    let app = routes::router(test_state(&db));
    let (alice_token, alice) = sign_up(&app, "Alice").await;
    let (mallory_token, mallory) = sign_up(&app, "Mallory").await;

    let alice_workout = Uuid::new_v4();
    let mallory_workout = Uuid::new_v4();
    let results = push_results(
        &app,
        &alice_token,
        &[op(
            "scope-a",
            "workout_sessions",
            "create",
            workout_payload(alice_workout, alice, "alice day"),
            at(10),
        )],
    )
    .await;
    assert_eq!(status_of(&results[0]), "applied");
    pace();
    let results = push_results(
        &app,
        &mallory_token,
        &[op(
            "scope-m",
            "workout_sessions",
            "create",
            workout_payload(mallory_workout, mallory, "mallory day"),
            at(11),
        )],
    )
    .await;
    assert_eq!(status_of(&results[0]), "applied");
    pace();

    // Custom exercises: each user sees only their own; the global
    // catalog (owner_id NULL) never crosses a pull either.
    let alice_exercise = Uuid::new_v4();
    let mallory_exercise = Uuid::new_v4();
    for (token, id, name) in [
        (&alice_token, alice_exercise, "Alice Lift"),
        (&mallory_token, mallory_exercise, "Mallory Lift"),
    ] {
        let results = push_results(
            &app,
            token,
            &[op(
                &format!("scope-ex-{id}"),
                "exercises",
                "create",
                json!({
                    "id": id,
                    "name": name,
                    "muscle_group": "chest",
                    "equipment": null,
                    "created_at": "2026-10-14T09:30:00.000Z",
                }),
                at(12),
            )],
        )
        .await;
        assert_eq!(status_of(&results[0]), "applied");
    }

    let ids = row_ids(&pull_page(&app, &alice_token, "entity=workout_sessions&limit=100").await);
    assert_eq!(
        ids,
        [alice_workout],
        "alice sees her row only, never mallory's"
    );

    let ids = row_ids(&pull_page(&app, &mallory_token, "entity=workout_sessions&limit=100").await);
    assert_eq!(
        ids,
        [mallory_workout],
        "mallory sees her row only, never alice's"
    );

    let ids = row_ids(&pull_page(&app, &alice_token, "entity=exercises&limit=1000").await);
    assert_eq!(
        ids,
        [alice_exercise],
        "custom exercises only, no catalog, no foreign rows"
    );

    support::drop_scratch(db).await;
}

#[tokio::test]
async fn pull_clamps_the_limit_to_the_rule_bounds() {
    let Some(db) = support::migrated_scratch("pull clamp").await else {
        return;
    };
    let app = routes::router(test_state(&db));
    let (token, user) = sign_up(&app, "Alice").await;

    let first = Uuid::new_v4();
    let second = Uuid::new_v4();
    for (label, row) in [("clamp-a", first), ("clamp-b", second)] {
        let ops = [op(
            label,
            "workout_sessions",
            "create",
            workout_payload(row, user, label),
            at(10),
        )];
        let results = push_results(&app, &token, &ops).await;
        assert_eq!(status_of(&results[0]), "applied");
        pace();
    }

    // limit 0 clamps up to 1: one row, cursor still going.
    let page = pull_page(&app, &token, "entity=workout_sessions&limit=0").await;
    let rows = page["rows"].as_array().expect("rows");
    assert_eq!(rows.len(), 1, "limit 0 behaves as 1");
    assert_eq!(rows[0]["id"], json!(first));
    assert!(page["next_cursor"].is_string());

    // Negative limits clamp up to 1 too.
    let page = pull_page(&app, &token, "entity=workout_sessions&limit=-5").await;
    let rows = page["rows"].as_array().expect("rows");
    assert_eq!(rows.len(), 1, "a negative limit behaves as 1");
    assert_eq!(rows[0]["id"], json!(first));
    assert!(page["next_cursor"].is_string());

    // Oversized limits clamp down to pull_page_size, which still returns
    // every row with a null cursor (the page was not filled).
    let page_size = i64::from(RuleConstants::default().sync.pull_page_size);
    let page = pull_page(
        &app,
        &token,
        &format!("entity=workout_sessions&limit={}", page_size + 10),
    )
    .await;
    let rows = page["rows"].as_array().expect("rows");
    assert_eq!(rows.len(), 2, "the clamp still returns everything");
    assert!(page["next_cursor"].is_null());

    // No limit parameter defaults to the page size, same result.
    let page = pull_page(&app, &token, "entity=workout_sessions").await;
    let rows = page["rows"].as_array().expect("rows");
    assert_eq!(rows.len(), 2, "the default is the page size");
    assert!(page["next_cursor"].is_null());

    support::drop_scratch(db).await;
}
