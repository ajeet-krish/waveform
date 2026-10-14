//! Router assembly.
//!
//! Feature routers (auth, workout, activity, social) live in sibling
//! modules; each exposes `router()` and is merged here as its handlers land
//! in later phases.

pub mod activity;
pub mod auth;
pub mod social;
pub mod workout;

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::json;

use crate::state::AppState;

/// Build the full application router.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .merge(auth::router())
        .merge(workout::router())
        .merge(activity::router())
        .merge(social::router())
        .with_state(state)
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
