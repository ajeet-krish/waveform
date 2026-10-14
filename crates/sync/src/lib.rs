//! Offline-first sync engine (contract only in phase 0).
//!
//! The sync contract, from docs/architecture.md:
//!
//! * Local-first writes: the UI mutates an IndexedDB mirror, then appends
//!   `{op_id, entity, action, payload, updated_at}` to a client outbox.
//! * Push: `POST /sync/push` replays outbox ops into Postgres. Ops are
//!   idempotent via `client_ops.id` (the client-generated `op_id`); replaying
//!   an already-stored op is a no-op success.
//! * Conflict resolution: last-write-wins on `updated_at`. A newer incoming
//!   `updated_at` replaces the stored row; an older or equal one is dropped.
//! * Deletes are tombstones: rows are soft-deleted via `deleted_at` so pull
//!   clients learn about deletions.
//! * Pull: `GET /sync/pull?since=cursor` returns rows with
//!   `updated_at > cursor` per entity, ordered by `updated_at`, so the
//!   client can advance a monotonic cursor.
//!
//! Phase 1 implements the push/pull handlers in `apps/api` on top of the
//! helpers here. This module only pins down the primitives.

use chrono::{DateTime, Utc};

/// Outcome of applying one client op during a push.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyOutcome {
    /// The incoming row replaced the stored row (or was inserted).
    Applied,
    /// The stored row is newer; the incoming op was discarded.
    DiscardedStale,
    /// The op was already processed (same `op_id`); nothing changed.
    Duplicate,
}

/// Last-write-wins decision for a single row.
///
/// `true` when the incoming `updated_at` is strictly newer than the stored
/// one. Ties go to the stored row so two devices replaying the same instant
/// converge deterministically.
pub fn incoming_wins(stored_updated_at: DateTime<Utc>, incoming_updated_at: DateTime<Utc>) -> bool {
    incoming_updated_at > stored_updated_at
}

/// Placeholder for the batch outbox apply loop. Phase 1 wires this to
/// `client_ops` and the per-entity upsert queries; until then it reports
/// nothing applied so callers cannot accidentally treat it as implemented.
pub fn apply_outbox_ops_noop() -> Vec<ApplyOutcome> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::{apply_outbox_ops_noop, incoming_wins};
    use chrono::{TimeZone, Utc};

    #[test]
    fn newer_incoming_wins() {
        let stored = Utc.with_ymd_and_hms(2026, 10, 14, 12, 0, 0).unwrap();
        let newer = Utc.with_ymd_and_hms(2026, 10, 14, 12, 1, 0).unwrap();
        assert!(incoming_wins(stored, newer));
    }

    #[test]
    fn older_incoming_loses() {
        let stored = Utc.with_ymd_and_hms(2026, 10, 14, 12, 0, 0).unwrap();
        let older = Utc.with_ymd_and_hms(2026, 10, 14, 11, 59, 0).unwrap();
        assert!(!incoming_wins(stored, older));
    }

    #[test]
    fn ties_keep_the_stored_row() {
        let at = Utc.with_ymd_and_hms(2026, 10, 14, 12, 0, 0).unwrap();
        assert!(!incoming_wins(at, at));
    }

    #[test]
    fn noop_returns_no_outcomes() {
        assert!(apply_outbox_ops_noop().is_empty());
    }
}
