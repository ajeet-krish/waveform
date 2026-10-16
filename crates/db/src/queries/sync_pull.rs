//! Cursor-paged pull: rows after `(applied_at, id)`, owner-scoped,
//! tombstones included.
//!
//! The cursor rides on the server's `applied_at` stamp (a trigger forces
//! `now()` on every write), so a future-skewed client `updated_at` can
//! never starve a pull and rows sharing one transaction's timestamp are
//! never dropped across a page boundary: the `(applied_at, id)` row
//! comparison is exclusive and the order is the same pair.

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use crate::dto::{PullPage, PullRow, RuleConstants, SyncEntity};
use crate::queries::spec::{pull_sql, spec_for};
use waveform_sync::cursor::{decode_cursor, encode_cursor, Cursor};

/// The Unix epoch: an unset cursor means "everything from the start".
fn epoch() -> DateTime<Utc> {
    DateTime::from_timestamp(0, 0).expect("epoch timestamp")
}

/// Pull parameters for one page.
#[derive(Debug, Clone, Copy)]
pub struct PullParams<'a> {
    /// Session user; every row is scoped to this owner.
    pub user_id: Uuid,
    /// Exclusive cursor from the previous page; `None` starts over.
    pub cursor: Option<&'a str>,
    /// Requested page size, clamped to
    /// `RuleConstants::default().sync.pull_page_size`.
    pub limit: i64,
}

/// Fetch one page of one entity. Tombstones are included; custom
/// exercises only (`owner_id` set) for the exercises entity.
pub async fn pull_page(
    pool: &PgPool,
    entity: SyncEntity,
    params: PullParams<'_>,
) -> Result<PullPage, sqlx::Error> {
    let spec = spec_for(entity);
    let page_size = i64::from(RuleConstants::default().sync.pull_page_size);
    let limit = params.limit.clamp(1, page_size);

    let (cursor_at, cursor_id) = match params.cursor {
        Some(raw) => {
            let cursor = decode_cursor(raw).map_err(|_| {
                let message: Box<dyn std::error::Error + Send + Sync + 'static> =
                    format!("invalid cursor: {raw}").into();
                sqlx::Error::Decode(message)
            })?;
            (cursor.applied_at, cursor.id)
        }
        None => (epoch(), Uuid::nil()),
    };

    let rows: Vec<(Value, DateTime<Utc>, Uuid)> = sqlx::query_as(&pull_sql(spec))
        .bind(params.user_id)
        .bind(cursor_at)
        .bind(cursor_id)
        .bind(limit)
        .fetch_all(pool)
        .await?;

    let next_cursor = if rows.len() as i64 == limit {
        rows.last().map(|(_, applied_at, id)| {
            encode_cursor(&Cursor {
                applied_at: *applied_at,
                id: *id,
            })
        })
    } else {
        None
    };

    let rows = rows
        .into_iter()
        .map(|(payload, applied_at, id)| PullRow {
            entity,
            id,
            applied_at,
            payload,
        })
        .collect();
    Ok(PullPage { rows, next_cursor })
}

/// Decode a cursor string, exported so handlers validate before use.
pub fn parse_cursor(raw: &str) -> Result<Cursor, waveform_sync::CursorError> {
    decode_cursor(raw)
}
