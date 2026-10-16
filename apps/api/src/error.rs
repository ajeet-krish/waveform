//! HTTP error envelope: the `ApiError` enum, its mapping onto the wire
//! error body (`waveform_db::dto::ApiErrorBody`), and the status codes
//! the client switches on.
//!
//! The auth handlers (bucket 2) construct most variants; `Forbidden` and
//! `PayloadTooLarge` are reserved for the sync push handlers (bucket 3),
//! so the module keeps its dead-code allowance until then.

// The sync handlers in bucket 3 construct `Forbidden` and
// `PayloadTooLarge`; until then the enum would trip the dead-code lint
// even though the mapping is exercised by IntoResponse.
#![allow(dead_code)]

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use waveform_db::{
    dto::{ApiErrorBody, ApiErrorCode},
    queries::ApplyError,
};

/// Every failing request resolves to this envelope:
/// `{"code": "...", "message": "..."}` with a matching HTTP status.
#[derive(Debug)]
pub enum ApiError {
    /// 401: no or invalid bearer session.
    Unauthorized(String),
    /// 403: authenticated but not allowed (foreign rows, foreign parents).
    Forbidden(String),
    /// 404: the addressed row or route does not exist.
    NotFound(String),
    /// 409: conflicting state, for example a foreign `op_id` replay.
    Conflict(String),
    /// 422: the payload violates a constraint or fails validation.
    InvalidPayload(String),
    /// 413: the push batch exceeds the documented cap.
    PayloadTooLarge(String),
    /// 429: too many requests (login throttling).
    RateLimited(String),
    /// 500: anything the client must not see the details of.
    Internal(String),
}

impl ApiError {
    fn status(&self) -> StatusCode {
        match self {
            ApiError::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            ApiError::Forbidden(_) => StatusCode::FORBIDDEN,
            ApiError::NotFound(_) => StatusCode::NOT_FOUND,
            ApiError::Conflict(_) => StatusCode::CONFLICT,
            ApiError::InvalidPayload(_) => StatusCode::UNPROCESSABLE_ENTITY,
            ApiError::PayloadTooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
            ApiError::RateLimited(_) => StatusCode::TOO_MANY_REQUESTS,
            ApiError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    fn code(&self) -> ApiErrorCode {
        match self {
            ApiError::Unauthorized(_) => ApiErrorCode::Unauthorized,
            ApiError::Forbidden(_) => ApiErrorCode::Forbidden,
            ApiError::NotFound(_) => ApiErrorCode::NotFound,
            ApiError::Conflict(_) => ApiErrorCode::Conflict,
            ApiError::InvalidPayload(_) => ApiErrorCode::InvalidPayload,
            ApiError::PayloadTooLarge(_) => ApiErrorCode::PayloadTooLarge,
            ApiError::RateLimited(_) => ApiErrorCode::RateLimited,
            ApiError::Internal(_) => ApiErrorCode::Internal,
        }
    }

    fn message(&self) -> &str {
        match self {
            ApiError::Unauthorized(message)
            | ApiError::Forbidden(message)
            | ApiError::NotFound(message)
            | ApiError::Conflict(message)
            | ApiError::InvalidPayload(message)
            | ApiError::PayloadTooLarge(message)
            | ApiError::RateLimited(message)
            | ApiError::Internal(message) => message,
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.status();
        if status == StatusCode::INTERNAL_SERVER_ERROR {
            // Details stay in the log; the client only gets the envelope.
            tracing::error!(message = %self.message(), "request failed");
        }
        let body = ApiErrorBody {
            code: self.code(),
            message: self.message().to_owned(),
        };
        (status, Json(body)).into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        match error {
            sqlx::Error::RowNotFound => ApiError::NotFound("row not found".to_owned()),
            other => {
                tracing::error!(error = %other, "database error");
                ApiError::Internal("database error".to_owned())
            }
        }
    }
}

impl From<ApplyError> for ApiError {
    fn from(error: ApplyError) -> Self {
        match error {
            ApplyError::ForeignOpId => {
                ApiError::Conflict("op id already used by another user".to_owned())
            }
            ApplyError::Database(database) => {
                tracing::error!(error = %database, "sync apply database error");
                ApiError::Internal("sync apply failed".to_owned())
            }
        }
    }
}
