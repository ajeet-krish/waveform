//! Offline-first sync engine (contract only in phase 0).
//!
//! The sync contract, from docs/architecture.md plus the phase 0 review
//! fixes (docs/reviews.md):
//!
//! * Local-first writes: the UI mutates an IndexedDB mirror, then appends
//!   `{op_id, entity, action, payload, updated_at}` to a client outbox.
//!   Push batches are capped server-side by a documented ops-per-request
//!   limit.
//! * Push: `POST /sync/push` replays outbox ops into Postgres. Each op is
//!   applied in ONE transaction: the row upsert and the `client_ops`
//!   insert commit together or not at all, so a crash can never leave an
//!   op that is half applied but unreplayable. The row's `user_id` always
//!   comes from the session, never from the payload.
//! * Idempotency: `client_ops.id` stores the client-generated `op_id`, and
//!   the lookup is USER-SCOPED ([`idempotency_check`]). Replaying your own
//!   stored op is a no-op success; presenting an `op_id` that already
//!   exists under a DIFFERENT user is rejected with HTTP 409
//!   ([`ApplyOutcome::RejectedForeignOp`]), so a learned foreign `op_id`
//!   cannot pre-claim and suppress the victim's op.
//! * Conflict resolution: last-write-wins on the client's `updated_at`.
//!   Client timestamps are untrusted: they are clamped
//!   ([`clamp_client_timestamp`]) to at most [`MAX_CLIENT_CLOCK_SKEW_MINUTES`]
//!   ahead of the server clock before they drive LWW, so a future-skewed
//!   device cannot pin a row years ahead. A newer incoming `updated_at`
//!   replaces the stored row; an older or equal one is discarded (ties keep
//!   the stored row so replicas converge deterministically).
//! * Deletes are tombstones: rows are soft-deleted via `deleted_at` so pull
//!   clients learn about deletions.
//! * Pull: `GET /sync/pull` uses a SERVER-AUTHORITATIVE cursor. Every
//!   synced row carries `applied_at`, which the server stamps with its own
//!   clock (a trigger forces `now()` on every insert and update, see
//!   migrations/0003_hardening.sql, so payloads cannot influence it). The
//!   cursor is the `(applied_at, id)` pair of the last row the client
//!   received; the next page returns rows where `(applied_at, id) > cursor`
//!   ordered by the same pair and scoped to the session user, typically
//!   `WHERE user_id = $1 AND (applied_at, id) > ($2, $3) ORDER BY applied_at, id`.
//!   The UUID tie-break ([`row_after_cursor`]) means rows sharing one
//!   `applied_at` across a page boundary are never dropped, and because
//!   `applied_at` comes from the server clock a future-skewed client
//!   `updated_at` can never starve a pull. Cursors are opaque to clients;
//!   they only echo them back.
//!
//! Phase 1 implements the push/pull handlers in `apps/api` on top of the
//! helpers here. This module only pins down the primitives.

use chrono::{DateTime, Duration, Utc};
use uuid::Uuid;

/// How far a client-supplied `updated_at` may lead the server clock before
/// it is clamped. Large enough for modest device skew, small enough that a
/// broken clock only delays that row's LWW window briefly.
pub const MAX_CLIENT_CLOCK_SKEW_MINUTES: i64 = 5;

/// Outcome of applying one client op during a push.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyOutcome {
    /// The incoming row replaced the stored row (or was inserted).
    Applied,
    /// The stored row is newer; the incoming op was discarded.
    DiscardedStale,
    /// The op was already processed by the same user; nothing changed.
    Duplicate,
    /// The `op_id` already exists under a different user. Nothing is
    /// stored; the push must respond HTTP 409 so the foreign replay
    /// cannot suppress the legitimate owner's op.
    RejectedForeignOp,
}

/// Result of the user-scoped idempotency check on `client_ops.id`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Idempotency {
    /// The `op_id` is unseen for this user; the op may be applied.
    New,
    /// The same user already landed this `op_id`; replay is a no-op
    /// success that must not re-apply the row write.
    Replay,
    /// The `op_id` belongs to a different user; reject the push with
    /// HTTP 409 and store nothing.
    ForeignConflict,
}

/// USER-SCOPED idempotency decision for one pushed op.
///
/// `existing_owner` is the `user_id` recorded on the stored `client_ops`
/// row for this `op_id`, if any. Only the rightful owner may treat a
/// collision as a replay; everyone else gets [`Idempotency::ForeignConflict`].
pub fn idempotency_check(existing_owner: Option<Uuid>, pushing_user: Uuid) -> Idempotency {
    match existing_owner {
        None => Idempotency::New,
        Some(owner) if owner == pushing_user => Idempotency::Replay,
        Some(_) => Idempotency::ForeignConflict,
    }
}

/// Clamp an untrusted client-supplied `updated_at` against the server
/// clock before it drives last-write-wins. Values ahead of
/// `server_now + MAX_CLIENT_CLOCK_SKEW_MINUTES` collapse to that ceiling;
/// values in the past pass through untouched because offline edits carry
/// their original device time by design.
pub fn clamp_client_timestamp(incoming: DateTime<Utc>, server_now: DateTime<Utc>) -> DateTime<Utc> {
    let ceiling = server_now + Duration::minutes(MAX_CLIENT_CLOCK_SKEW_MINUTES);
    if incoming > ceiling {
        ceiling
    } else {
        incoming
    }
}

/// Last-write-wins decision for a single row.
///
/// `true` when the incoming `updated_at` is strictly newer than the stored
/// one. Ties go to the stored row so two devices replaying the same instant
/// converge deterministically. Callers clamp the incoming timestamp with
/// [`clamp_client_timestamp`] first.
pub fn incoming_wins(stored_updated_at: DateTime<Utc>, incoming_updated_at: DateTime<Utc>) -> bool {
    incoming_updated_at > stored_updated_at
}

/// Composite pull predicate: does the row at `(applied_at, id)` come after
/// the cursor `(cursor_applied_at, cursor_id)` in `(applied_at, id)`
/// order? The id tie-break guarantees rows that share one server timestamp
/// are never dropped across a page boundary.
pub fn row_after_cursor<I: Ord>(
    applied_at: DateTime<Utc>,
    id: I,
    cursor_applied_at: DateTime<Utc>,
    cursor_id: I,
) -> bool {
    (applied_at, id) > (cursor_applied_at, cursor_id)
}

/// Placeholder for the batch outbox apply loop. Phase 1 wires this to
/// `client_ops` and the per-entity upsert queries; until then it reports
/// nothing applied so callers cannot accidentally treat it as implemented.
pub fn apply_outbox_ops_noop() -> Vec<ApplyOutcome> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::{
        apply_outbox_ops_noop, clamp_client_timestamp, idempotency_check, incoming_wins,
        row_after_cursor, ApplyOutcome, Idempotency, MAX_CLIENT_CLOCK_SKEW_MINUTES,
    };
    use chrono::{Duration, TimeZone, Utc};
    use uuid::Uuid;

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

    #[test]
    fn clamp_caps_future_timestamps_only() {
        let server_now = Utc.with_ymd_and_hms(2026, 10, 14, 12, 0, 0).unwrap();
        let ceiling = server_now + Duration::minutes(MAX_CLIENT_CLOCK_SKEW_MINUTES);

        // Past and present values pass through untouched.
        let past = server_now - Duration::days(3);
        assert_eq!(clamp_client_timestamp(past, server_now), past);
        assert_eq!(clamp_client_timestamp(server_now, server_now), server_now);
        // Just inside the tolerance window is kept.
        let inside = server_now + Duration::minutes(2);
        assert_eq!(clamp_client_timestamp(inside, server_now), inside);
        // A future-skewed clock collapses to the ceiling instead of
        // poisoning LWW or the pull cursor.
        let far_future = Utc.with_ymd_and_hms(2099, 1, 1, 0, 0, 0).unwrap();
        assert_eq!(clamp_client_timestamp(far_future, server_now), ceiling);
    }

    #[test]
    fn idempotency_is_user_scoped() {
        let alice = Uuid::new_v4();
        let mallory = Uuid::new_v4();

        // Unseen op ids are free to apply.
        assert_eq!(idempotency_check(None, alice), Idempotency::New);
        // The rightful owner replays as a no-op success.
        assert_eq!(idempotency_check(Some(alice), alice), Idempotency::Replay);
        // A foreign op_id is a conflict, never a silent no-op, so a
        // learned op_id cannot suppress the victim's op.
        assert_eq!(
            idempotency_check(Some(alice), mallory),
            Idempotency::ForeignConflict
        );
    }

    #[test]
    fn cursor_pages_on_applied_at_with_id_tiebreak() {
        let at = |second: u32| {
            Utc.with_ymd_and_hms(2026, 10, 14, 12, 0, 0).unwrap()
                + Duration::seconds(i64::from(second))
        };
        let id = |n: u8| Uuid::from_u128(u128::from(n));

        // Strictly newer applied_at always follows the cursor.
        assert!(row_after_cursor(at(1), id(1), at(0), id(9)));
        // Equal applied_at: the smaller id was on the previous page, the
        // larger id still gets delivered instead of being dropped.
        assert!(!row_after_cursor(at(1), id(1), at(1), id(2)));
        assert!(row_after_cursor(at(1), id(3), at(1), id(2)));
        // A stale row behind the cursor stays hidden.
        assert!(!row_after_cursor(at(0), id(9), at(1), id(1)));
    }

    #[test]
    fn apply_outcome_variants_are_distinct() {
        let outcomes = [
            ApplyOutcome::Applied,
            ApplyOutcome::DiscardedStale,
            ApplyOutcome::Duplicate,
            ApplyOutcome::RejectedForeignOp,
        ];
        for (index, left) in outcomes.iter().enumerate() {
            for (other_index, right) in outcomes.iter().enumerate() {
                assert_eq!(left == right, index == other_index);
            }
        }
    }
}
