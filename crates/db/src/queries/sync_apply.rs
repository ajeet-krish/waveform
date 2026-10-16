//! Generic outbox apply: one transaction per op against `client_ops` and
//! the entity table.
//!
//! The flow mirrors the contract in `waveform-sync`: claim the op id by
//! primary key insert, clamp the client timestamp against the server
//! clock, prove the payload's row id and parents belong to the session
//! user, resolve last-write-wins, then upsert through
//! [`upsert_sql`](super::spec::upsert_sql). Outcomes split cleanly:
//! [`OpStatus::Applied`] and [`OpStatus::DiscardedStale`] claim the op
//! (commit), [`OpStatus::Rejected`] and [`OpStatus::Retryable`] leave no
//! trace (rollback, so the client may safely retry a retryable op under
//! the same id), and a foreign `op_id` aborts the whole batch.

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::dto::{ApiErrorCode, OpAction, OpResult, OpStatus, PushOp};
use crate::queries::spec::{spec_for, upsert_sql, EntitySpec};
use waveform_sync::{clamp_client_timestamp, idempotency_check, incoming_wins, Idempotency};

/// Batch-aborting apply failures. Everything else resolves to an
/// [`OpResult`] inside the batch.
#[derive(Debug)]
pub enum ApplyError {
    /// The `op_id` already exists under a different user. Nothing is
    /// stored and the remaining ops in the batch are not attempted; the
    /// push must respond HTTP 409 so a learned foreign `op_id` cannot
    /// suppress the legitimate owner's op.
    ForeignOpId,
    /// A database failure outside the classified payload violations
    /// (connection trouble, statement timeout). The caller decides:
    /// [`apply_ops`] downgrades it to a retryable result.
    Database(sqlx::Error),
}

impl std::fmt::Display for ApplyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApplyError::ForeignOpId => write!(f, "op id already used by another user"),
            ApplyError::Database(error) => write!(f, "database error during apply: {error}"),
        }
    }
}

impl std::error::Error for ApplyError {}

impl From<sqlx::Error> for ApplyError {
    fn from(error: sqlx::Error) -> Self {
        ApplyError::Database(error)
    }
}

/// What to do with the op's transaction after the row phase.
enum Verdict {
    /// Upsert landed: commit the row and the claim.
    Write,
    /// The stored row is newer: commit the claim only.
    DiscardStale,
    /// Nothing may be stored: roll back row and claim.
    Reject(ApiErrorCode),
    /// A parent has not arrived yet (or a transient failure): roll back,
    /// the client retries the same `op_id` later.
    Retry,
}

/// How a SQLSTATE maps onto an outcome.
enum Violation {
    /// CHECK, data conversion, not-null, or a secondary unique index:
    /// the payload itself is malformed.
    Payload,
    /// Foreign key: the parent may still be in flight.
    MissingParent,
    /// Anything else is infrastructure trouble, not a client mistake.
    Fatal,
}

fn classify(error: &sqlx::Error) -> Violation {
    match error {
        sqlx::Error::Database(database) => {
            let code = database
                .code()
                .map(|code| code.into_owned())
                .unwrap_or_default();
            if code == "23514" || code == "23502" || code == "23505" || code.starts_with("22") {
                Violation::Payload
            } else if code == "23503" {
                Violation::MissingParent
            } else {
                Violation::Fatal
            }
        }
        _ => Violation::Fatal,
    }
}

fn result(op: &PushOp, status: OpStatus, error: Option<ApiErrorCode>) -> OpResult {
    OpResult {
        op_id: op.op_id,
        status,
        error,
    }
}

fn rejected(op: &PushOp, code: ApiErrorCode) -> OpResult {
    result(op, OpStatus::Rejected, Some(code))
}

/// What the payload says about a uuid column.
enum PayloadId {
    /// The key is absent or `null` (allowed for optional parents).
    Missing,
    /// The key holds something that is not a uuid string.
    Invalid,
    /// A parseable uuid.
    Found(Uuid),
}

fn payload_uuid(payload: &Value, key: &str) -> PayloadId {
    match payload.get(key) {
        None | Some(Value::Null) => PayloadId::Missing,
        Some(Value::String(raw)) => match Uuid::parse_str(raw) {
            Ok(id) => PayloadId::Found(id),
            Err(_) => PayloadId::Invalid,
        },
        Some(_) => PayloadId::Invalid,
    }
}

/// Server-owned timestamps never come from the payload: for every
/// `spec.timestamp_columns` entry, `updated_at` and `deleted_at` are
/// stripped and bound from the clamp and the action, a missing
/// `created_at` (NOT NULL everywhere) defaults to the clamped
/// `updated_at` so a sparse create does not trip the constraint, and
/// the remaining stamps (`started_at`) pass through or stay NULL.
fn normalize_payload(raw: &Value, updated_at: DateTime<Utc>, spec: &EntitySpec) -> Value {
    let mut payload = raw.clone();
    let Some(object) = payload.as_object_mut() else {
        return payload;
    };
    for column in spec.timestamp_columns {
        match *column {
            "updated_at" | "deleted_at" => {
                object.remove(*column);
            }
            "created_at" => {
                let missing = object
                    .get("created_at")
                    .map(|value| value.is_null())
                    .unwrap_or(true);
                if missing {
                    if let Ok(stamp) = serde_json::to_value(updated_at) {
                        object.insert((*column).to_owned(), stamp);
                    }
                }
            }
            _ => {}
        }
    }
    payload
}

/// Apply a single op in its own transaction.
///
/// Claim first: a unique violation means the op id is already taken, so
/// the owner decides between a duplicate no-op success and a batch
/// aborting [`ApplyError::ForeignOpId`]. Everything after the claim runs
/// inside that transaction and commits only on [`OpStatus::Applied`] or
/// [`OpStatus::DiscardedStale`].
pub async fn apply_op(pool: &PgPool, user_id: Uuid, op: &PushOp) -> Result<OpResult, ApplyError> {
    let spec = spec_for(op.entity);
    let mut tx = pool.begin().await.map_err(ApplyError::Database)?;

    // 1. Claim the op id.
    let claim = sqlx::query(
        "INSERT INTO client_ops (id, user_id, entity, action, payload, updated_at, processed_at) \
         VALUES ($1, $2, $3, $4, $5, $6, now())",
    )
    .bind(op.op_id)
    .bind(user_id)
    .bind(op.entity.as_str())
    .bind(op.action.as_str())
    .bind(&op.payload)
    .bind(op.updated_at)
    .execute(&mut *tx)
    .await;

    if let Err(error) = claim {
        let unique = matches!(&error, sqlx::Error::Database(db) if db.is_unique_violation());
        if !unique {
            tx.rollback().await.map_err(ApplyError::Database)?;
            return Err(ApplyError::Database(error));
        }
        // The transaction is aborted by the violation; drop it before
        // reading the stored owner from the pool.
        tx.rollback().await.map_err(ApplyError::Database)?;
        let owner: Option<Uuid> =
            sqlx::query_scalar("SELECT user_id FROM client_ops WHERE id = $1")
                .bind(op.op_id)
                .fetch_optional(pool)
                .await
                .map_err(ApplyError::Database)?;
        return match idempotency_check(owner, user_id) {
            Idempotency::Replay => Ok(result(op, OpStatus::Duplicate, None)),
            Idempotency::ForeignConflict => Err(ApplyError::ForeignOpId),
            // The row vanished between the conflict and the read (a
            // retention prune race); nothing applied, safe to retry.
            Idempotency::New => Ok(result(op, OpStatus::Retryable, None)),
        };
    }

    // 2..n: everything else shares the claim's transaction.
    let verdict = apply_payload(&mut tx, user_id, op, spec).await;
    match verdict {
        Ok(Verdict::Write) => {
            tx.commit().await.map_err(ApplyError::Database)?;
            Ok(result(op, OpStatus::Applied, None))
        }
        Ok(Verdict::DiscardStale) => {
            tx.commit().await.map_err(ApplyError::Database)?;
            Ok(result(op, OpStatus::DiscardedStale, None))
        }
        Ok(Verdict::Reject(code)) => {
            tx.rollback().await.map_err(ApplyError::Database)?;
            Ok(rejected(op, code))
        }
        Ok(Verdict::Retry) => {
            tx.rollback().await.map_err(ApplyError::Database)?;
            Ok(result(op, OpStatus::Retryable, None))
        }
        Err(error) => {
            tx.rollback().await.map_err(ApplyError::Database)?;
            Err(ApplyError::Database(error))
        }
    }
}

/// Apply a batch in order. Only [`ApplyError::ForeignOpId`] aborts the
/// batch (the remaining ops are not attempted); database trouble inside
/// one op downgrades that op to [`OpStatus::Retryable`] so a transient
/// failure never loses the rest of the push.
pub async fn apply_ops(
    pool: &PgPool,
    user_id: Uuid,
    ops: &[PushOp],
) -> Result<Vec<OpResult>, ApplyError> {
    let mut results = Vec::with_capacity(ops.len());
    for op in ops {
        match apply_op(pool, user_id, op).await {
            Ok(op_result) => results.push(op_result),
            Err(ApplyError::ForeignOpId) => return Err(ApplyError::ForeignOpId),
            Err(ApplyError::Database(_)) => {
                results.push(result(op, OpStatus::Retryable, None));
            }
        }
    }
    Ok(results)
}

/// The row phase: clock, ownership, parents, LWW, upsert.
async fn apply_payload(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    op: &PushOp,
    spec: &EntitySpec,
) -> Result<Verdict, sqlx::Error> {
    // Server clock first: the clamp ceiling and this op's LWW window come
    // from Postgres, not from the API process.
    let server_now: DateTime<Utc> = sqlx::query_scalar("SELECT now()")
        .fetch_one(&mut **tx)
        .await?;
    let updated_at = clamp_client_timestamp(op.updated_at, server_now);

    // The payload must be an object carrying its own row id.
    if !op.payload.is_object() {
        return Ok(Verdict::Reject(ApiErrorCode::InvalidPayload));
    }
    let row_id = match payload_uuid(&op.payload, "id") {
        PayloadId::Found(id) => id,
        PayloadId::Missing | PayloadId::Invalid => {
            return Ok(Verdict::Reject(ApiErrorCode::InvalidPayload));
        }
    };

    // Ownership of the payload's row id: foreign rows and the server-owned
    // global catalog are rejected outright.
    let owner: Option<Option<Uuid>> = sqlx::query_scalar(spec.owner_probe)
        .bind(row_id)
        .fetch_optional(&mut **tx)
        .await?;
    if let Some(existing_owner) = owner {
        match existing_owner {
            Some(owner) if owner == user_id => {}
            _ => return Ok(Verdict::Reject(ApiErrorCode::Forbidden)),
        }
    }

    // Parent checks: a parent that has not arrived is retryable without
    // claiming the op; a parent under another user is rejected.
    for check in spec.parents {
        let parent_id = match payload_uuid(&op.payload, check.column) {
            PayloadId::Missing => {
                if check.required {
                    return Ok(Verdict::Reject(ApiErrorCode::InvalidPayload));
                }
                continue;
            }
            PayloadId::Found(id) => id,
            PayloadId::Invalid => return Ok(Verdict::Reject(ApiErrorCode::InvalidPayload)),
        };
        let (exists, owned): (bool, bool) = sqlx::query_as(check.probe)
            .bind(parent_id)
            .bind(user_id)
            .fetch_one(&mut **tx)
            .await?;
        if !exists {
            return Ok(Verdict::Retry);
        }
        if !owned {
            return Ok(Verdict::Reject(ApiErrorCode::Forbidden));
        }
    }

    // Last-write-wins on the clamped client timestamp; ties keep the
    // stored row so replicas converge deterministically.
    let stored_sql = format!("SELECT updated_at FROM {} WHERE id = $1", spec.table);
    let stored: Option<DateTime<Utc>> = sqlx::query_scalar(&stored_sql)
        .bind(row_id)
        .fetch_optional(&mut **tx)
        .await?;
    if let Some(stored_at) = stored {
        if !incoming_wins(stored_at, updated_at) {
            return Ok(Verdict::DiscardStale);
        }
    }

    // The upsert. Timestamps and the forced owner are bound; the payload
    // only ever fills payload columns.
    let tombstone = op.action == OpAction::Delete;
    let payload = normalize_payload(&op.payload, updated_at, spec);
    let deleted_at = tombstone.then_some(updated_at);
    let sql = upsert_sql(spec, tombstone);
    let executed = if spec.owner_column.is_some() {
        sqlx::query(&sql)
            .bind(&payload)
            .bind(row_id)
            .bind(user_id)
            .bind(updated_at)
            .bind(deleted_at)
            .execute(&mut **tx)
            .await
    } else {
        sqlx::query(&sql)
            .bind(&payload)
            .bind(row_id)
            .bind(updated_at)
            .bind(deleted_at)
            .execute(&mut **tx)
            .await
    };
    match executed {
        Ok(outcome) => {
            if outcome.rows_affected() == 0 {
                // The race guard saw a newer row land between the LWW
                // read and the write; the claim still sticks.
                Ok(Verdict::DiscardStale)
            } else {
                Ok(Verdict::Write)
            }
        }
        Err(error) => match classify(&error) {
            Violation::Payload => Ok(Verdict::Reject(ApiErrorCode::InvalidPayload)),
            Violation::MissingParent => Ok(Verdict::Retry),
            Violation::Fatal => Err(error),
        },
    }
}
