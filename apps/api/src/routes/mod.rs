//! Router assembly.
//!
//! Feature routers (auth, sync, workout, activity, social) live in
//! sibling modules; each exposes `router()` and is merged here as its
//! handlers land. The whole surface sits behind one CORS layer pinned to
//! the deployed web origin (ADR 2026-10-15, bucket 2) and one request
//! body limit (bucket 3), both applied after every route is registered
//! because layers only wrap the routes that exist when they are added.

pub mod activity;
pub mod auth;
pub mod social;
pub mod sync;
pub mod workout;

use std::time::Duration;

use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::json;
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::state::AppState;

/// Preflight cache lifetime in seconds.
const CORS_MAX_AGE: Duration = Duration::from_secs(600);

/// Maximum request body in bytes. A full push batch (the 200-op cap) is
/// tens of kilobytes, so anything approaching 2 MB is garbage; the limit
/// rejects it before a handler or extractor touches the body.
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

/// Build the full application router: every route plus the CORS layer
/// (the outermost layer, so preflights never reach a handler).
pub fn router(state: AppState) -> Router {
    let cors = cors_layer(&state.config.allowed_web_origin);
    Router::new()
        .route("/healthz", get(healthz))
        .merge(auth::router())
        .merge(sync::router())
        .merge(workout::router())
        .merge(activity::router())
        .merge(social::router())
        .with_state(state)
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(cors)
}

/// Exact-origin CORS: only `ALLOWED_WEB_ORIGIN` may call with GET, POST,
/// and preflight OPTIONS, carrying at most `Authorization` and
/// `Content-Type`. Credentials stay off (bearer headers, never cookies),
/// and the browser may cache a preflight for 10 minutes. The allow-list
/// (rather than a constant echo) means a foreign origin gets no
/// `access-control-allow-origin` header at all.
fn cors_layer(allowed_origin: &str) -> CorsLayer {
    let mut layer = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
        .allow_credentials(false)
        .max_age(CORS_MAX_AGE);
    match HeaderValue::from_str(allowed_origin) {
        // `AllowOrigin::list` rejects wildcards with a panic; a wildcard
        // here would defeat the point of pinning one origin, so it is
        // treated as misconfiguration instead.
        Ok(origin) if origin != "*" => {
            layer = layer.allow_origin(AllowOrigin::list([origin]));
        }
        Ok(_) => {
            tracing::error!("ALLOWED_WEB_ORIGIN must be a concrete origin, not a wildcard; CORS allows no origin");
        }
        Err(error) => {
            tracing::error!(%error, allowed_origin, "ALLOWED_WEB_ORIGIN is not a valid header value; CORS allows no origin");
        }
    }
    layer
}

/// Liveness plus database reachability probe.
async fn healthz(State(state): State<AppState>) -> Response {
    match sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.pool)
        .await
    {
        Ok(_) => (StatusCode::OK, Json(json!({ "status": "ok", "db": "up" }))).into_response(),
        Err(error) => {
            tracing::error!(%error, "healthz database probe failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "status": "degraded", "db": "down" })),
            )
                .into_response()
        }
    }
}
