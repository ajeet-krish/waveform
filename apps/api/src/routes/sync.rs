//! Sync surface: authenticated outbox push and cursor-paged pull over
//! the entity-generic engine in `waveform_db::queries`.
//!
//! * `POST /sync/push` replays a client outbox batch as the session
//!   user. The batch cap from `RuleConstants` is checked before the
//!   database is touched, so an oversized push answers 413 with zero
//!   side effects. Per-op outcomes come back in [`PushResponse`]; a
//!   foreign `op_id` aborts the batch with 409 through the existing
//!   `From<ApplyError>` mapping.
//! * `GET /sync/pull` pages one entity on the server-stamped
//!   `(applied_at, id)` cursor, tombstones included. The entity name and
//!   the cursor are validated up front so a bad request answers 400
//!   instead of surfacing as an internal decode error, and the limit
//!   defaults to (and clamps to) `pull_page_size`.

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use waveform_db::dto::{PullPage, PushRequest, PushResponse, RuleConstants, SyncEntity};
use waveform_db::queries::{apply_ops, parse_cursor, pull_page, PullParams};

use crate::error::ApiError;
use crate::extractors::{ApiJson, ApiQuery, AuthUser};
use crate::state::AppState;

/// Router for the sync surface.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/sync/push", post(push))
        .route("/sync/pull", get(pull))
}

/// `GET /sync/pull` query parameters.
#[derive(Debug, Deserialize)]
pub struct PullQuery {
    /// Entity wire name; [`SyncEntity::parse`] rejects unknown names.
    pub entity: String,
    /// Opaque cursor echoed back from the previous page; absent starts
    /// over from the beginning.
    pub cursor: Option<String>,
    /// Requested page size; absent means `pull_page_size`.
    pub limit: Option<i64>,
}

/// `POST /sync/push`: apply one outbox batch in request order. The
/// payload's `user_id`/`owner_id` never counts: `apply_ops` forces the
/// session user onto every row. Answers 200 with one result per op, 413
/// for a batch over the cap (no database work), and 409 when an `op_id`
/// already belongs to another user.
async fn push(
    State(state): State<AppState>,
    auth: AuthUser,
    ApiJson(request): ApiJson<PushRequest>,
) -> Result<Json<PushResponse>, ApiError> {
    let rules = RuleConstants::default();
    // The cap is a positive i32, so the conversion cannot fail on any
    // supported target; the fallback rejects every batch rather than
    // opening the door if it ever did.
    let max_ops = usize::try_from(rules.sync.max_ops_per_push).unwrap_or(0);
    if request.ops.len() > max_ops {
        return Err(ApiError::PayloadTooLarge(format!(
            "push carries {} ops, the cap is {}",
            request.ops.len(),
            rules.sync.max_ops_per_push
        )));
    }

    let results = apply_ops(&state.pool, auth.user_id, &request.ops).await?;
    Ok(Json(PushResponse { results }))
}

/// `GET /sync/pull`: one page of one entity for the session user.
/// Tombstones are included; rows are ordered by `(applied_at, id)` after
/// the cursor, and `next_cursor` is null once the page was not filled.
async fn pull(
    State(state): State<AppState>,
    auth: AuthUser,
    ApiQuery(query): ApiQuery<PullQuery>,
) -> Result<Json<PullPage>, ApiError> {
    let entity = SyncEntity::parse(&query.entity)
        .ok_or_else(|| ApiError::BadRequest(format!("unknown sync entity: {}", query.entity)))?;
    // Decode the cursor up front: `pull_page` would surface a corrupt
    // one as a database decode error (500) instead of the 400 it is.
    if let Some(raw) = query.cursor.as_deref() {
        parse_cursor(raw)
            .map_err(|error| ApiError::BadRequest(format!("invalid cursor: {error}")))?;
    }
    let page_size = i64::from(RuleConstants::default().sync.pull_page_size);
    let limit = query.limit.unwrap_or(page_size).clamp(1, page_size);

    let page = pull_page(
        &state.pool,
        entity,
        PullParams {
            user_id: auth.user_id,
            cursor: query.cursor.as_deref(),
            limit,
        },
    )
    .await?;
    Ok(Json(page))
}
