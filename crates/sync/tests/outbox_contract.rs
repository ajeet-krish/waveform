//! Outbox-apply contract tests for offline-first sync.
//!
//! The Postgres-backed push handler lands in phase 1; phase 0 pins the
//! contract semantics (docs/architecture.md, crates/sync/src/lib.rs) over an
//! in-memory store that composes the public primitives (`incoming_wins`,
//! `clamp_client_timestamp`, `idempotency_check`, `row_after_cursor`,
//! `ApplyOutcome`): user-scoped idempotency by client op id, last-write-wins
//! on a clamped `updated_at` with ties keeping the stored row, tombstone
//! deletes, out-of-order delivery, and server-authoritative `(applied_at,
//! id)` pull paging that includes tombstones.

use std::collections::HashMap;

use chrono::{DateTime, Duration, TimeZone, Utc};
use uuid::Uuid;
use waveform_sync::{clamp_client_timestamp, incoming_wins, row_after_cursor, ApplyOutcome};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    Update,
    Delete,
}

#[derive(Clone, Debug)]
struct Op {
    op_id: String,
    user: Uuid,
    row_id: String,
    action: Action,
    payload: String,
    updated_at: DateTime<Utc>,
}

impl Op {
    /// Re-target an op at a different pushing user (for example to model
    /// a replayed foreign op_id).
    fn pushed_by(mut self, user: Uuid) -> Op {
        self.user = user;
        self
    }
}

#[derive(Clone, Debug)]
struct Row {
    payload: String,
    updated_at: DateTime<Utc>,
    applied_at: DateTime<Utc>,
    deleted_at: Option<DateTime<Utc>>,
}

/// A pull cursor: the `(applied_at, id)` of the last row the client
/// received. Opaque to clients in production; explicit here for tests.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Cursor {
    applied_at: DateTime<Utc>,
    row_id: String,
}

/// Minimal outbox-apply engine implementing the documented sync contract on
/// top of the crate's public primitives. `server_time` plays the role of
/// the server clock that stamps `applied_at` on every row write.
struct Outbox {
    rows: HashMap<String, Row>,
    /// op_id to the user that owns it: idempotency is user-scoped.
    processed_ops: HashMap<String, Uuid>,
    server_time: DateTime<Utc>,
}

fn user_a() -> Uuid {
    Uuid::from_u128(0xa)
}

fn user_b() -> Uuid {
    Uuid::from_u128(0xb)
}

impl Outbox {
    fn new() -> Self {
        Self {
            rows: HashMap::new(),
            processed_ops: HashMap::new(),
            server_time: at(0),
        }
    }

    fn set_server_time(&mut self, at: DateTime<Utc>) {
        self.server_time = at;
    }

    fn apply(&mut self, op: &Op) -> ApplyOutcome {
        self.apply_inner(op, true)
    }

    /// Apply an op at the current server instant without advancing the
    /// clock, so several rows can share one `applied_at` (one transaction).
    fn apply_same_instant(&mut self, op: &Op) -> ApplyOutcome {
        self.apply_inner(op, false)
    }

    fn apply_inner(&mut self, op: &Op, advance_clock: bool) -> ApplyOutcome {
        // User-scoped idempotency: replaying your own op is a no-op
        // success; a foreign op_id is rejected and stores nothing, so the
        // legitimate owner can still push their op afterwards.
        if let Some(owner) = self.processed_ops.get(&op.op_id) {
            if *owner != op.user {
                return ApplyOutcome::RejectedForeignOp;
            }
            return ApplyOutcome::Duplicate;
        }

        // Client timestamps are untrusted; clamp before they drive LWW.
        let updated_at = clamp_client_timestamp(op.updated_at, self.server_time);
        // The server clock stamps the pull cursor timestamp.
        let applied_at = self.server_time;
        if advance_clock {
            self.server_time += Duration::seconds(1);
        }

        let existing = self.rows.get(&op.row_id).cloned();
        let outcome = match &existing {
            // LWW: equal timestamps keep the stored row (ties converge).
            Some(stored) if !incoming_wins(stored.updated_at, updated_at) => {
                ApplyOutcome::DiscardedStale
            }
            // A delete keeps the last known payload and adds the tombstone;
            // an update replaces payload and clears any tombstone.
            Some(stored) => {
                let (payload, deleted_at) = match op.action {
                    Action::Update => (op.payload.clone(), None),
                    Action::Delete => (stored.payload.clone(), Some(updated_at)),
                };
                self.rows.insert(
                    op.row_id.clone(),
                    Row {
                        payload,
                        updated_at,
                        applied_at,
                        deleted_at,
                    },
                );
                ApplyOutcome::Applied
            }
            // Creates, and deletes for rows this server has never seen, both
            // insert a (possibly tombstoned) row so pulls propagate state.
            None => {
                let deleted_at = matches!(op.action, Action::Delete).then_some(updated_at);
                self.rows.insert(
                    op.row_id.clone(),
                    Row {
                        payload: op.payload.clone(),
                        updated_at,
                        applied_at,
                        deleted_at,
                    },
                );
                ApplyOutcome::Applied
            }
        };
        self.processed_ops.insert(op.op_id.clone(), op.user);
        outcome
    }

    /// Pull contract: rows with `(applied_at, id) > cursor`, ordered by the
    /// same composite pair so paging is stable and tombstones are included.
    fn pull(&self, cursor: &Cursor) -> Vec<(&str, &Row)> {
        let mut rows: Vec<(&str, &Row)> = self
            .rows
            .iter()
            .filter(|(id, row)| {
                row_after_cursor(
                    row.applied_at,
                    id.as_str(),
                    cursor.applied_at,
                    cursor.row_id.as_str(),
                )
            })
            .map(|(id, row)| (id.as_str(), row))
            .collect();
        rows.sort_by_key(|(id, row)| (row.applied_at, *id));
        rows
    }

    /// Cursor a client would echo after receiving `row_id`.
    fn cursor_after(&self, row_id: &str) -> Cursor {
        let row = self
            .rows
            .get(row_id)
            .expect("cursor row must have been pulled");
        Cursor {
            applied_at: row.applied_at,
            row_id: row_id.to_string(),
        }
    }
}

fn at(second: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 14, 12, 0, 0).unwrap() + Duration::seconds(i64::from(second))
}

fn update(op_id: &str, row_id: &str, payload: &str, updated_at: DateTime<Utc>) -> Op {
    Op {
        op_id: op_id.to_string(),
        user: user_a(),
        row_id: row_id.to_string(),
        action: Action::Update,
        payload: payload.to_string(),
        updated_at,
    }
}

fn delete(op_id: &str, row_id: &str, updated_at: DateTime<Utc>) -> Op {
    Op {
        op_id: op_id.to_string(),
        user: user_a(),
        row_id: row_id.to_string(),
        action: Action::Delete,
        payload: String::new(),
        updated_at,
    }
}

#[test]
fn same_op_applied_twice_is_a_noop_success() {
    let mut outbox = Outbox::new();
    let op = update("op-1", "row-a", "v1", at(10));

    assert_eq!(outbox.apply(&op), ApplyOutcome::Applied);
    assert_eq!(outbox.apply(&op), ApplyOutcome::Duplicate);
    assert_eq!(outbox.apply(&op), ApplyOutcome::Duplicate);

    assert_eq!(outbox.rows.len(), 1);
    assert_eq!(outbox.rows["row-a"].payload, "v1");
    assert_eq!(outbox.processed_ops.len(), 1);
}

#[test]
fn a_foreign_op_id_is_rejected_and_never_suppresses_the_owner() {
    let mut outbox = Outbox::new();
    let victim = update("op-1", "row-a", "from-the-owner", at(10)).pushed_by(user_a());
    let attacker = update("op-1", "row-a", "replayed-by-attacker", at(20)).pushed_by(user_b());

    // The owner lands the op first; a replayed op_id from another user is
    // rejected outright and cannot touch the stored row.
    assert_eq!(outbox.apply(&victim), ApplyOutcome::Applied);
    assert_eq!(outbox.apply(&attacker), ApplyOutcome::RejectedForeignOp);
    assert_eq!(outbox.rows["row-a"].payload, "from-the-owner");
    assert_eq!(outbox.processed_ops["op-1"], user_a());
    // The rightful owner keeps replaying as a no-op success.
    assert_eq!(outbox.apply(&victim), ApplyOutcome::Duplicate);
}

#[test]
fn a_pre_claimed_op_id_gets_a_conflict_not_a_silent_noop() {
    // The attack the review found: an attacker who learns a victim op_id
    // pushes it first, so the old first-writer-wins rule would let the
    // victim's real push "succeed" as a no-op while the victim's write
    // silently never lands. User-scoped idempotency turns the victim's
    // push into a 409 conflict, and the client recovers by re-issuing the
    // op under a fresh op_id.
    let mut outbox = Outbox::new();
    let attacker = update("op-stolen", "row-b", "attacker-noise", at(10)).pushed_by(user_b());
    let victim = update("op-stolen", "row-b", "the-real-write", at(20)).pushed_by(user_a());

    assert_eq!(outbox.apply(&attacker), ApplyOutcome::Applied);
    assert_eq!(outbox.apply(&victim), ApplyOutcome::RejectedForeignOp);

    // The victim re-issues the op under a fresh op_id and it lands.
    let retry = update("op-1", "row-b", "the-real-write", at(20)).pushed_by(user_a());
    assert_eq!(outbox.apply(&retry), ApplyOutcome::Applied);
    assert_eq!(outbox.rows["row-b"].payload, "the-real-write");
}

#[test]
fn replaying_an_old_op_cannot_clobber_newer_state() {
    let mut outbox = Outbox::new();
    assert_eq!(
        outbox.apply(&update("op-1", "row-a", "v1", at(10))),
        ApplyOutcome::Applied
    );
    assert_eq!(
        outbox.apply(&update("op-2", "row-a", "v2", at(20))),
        ApplyOutcome::Applied
    );

    // A flaky client re-pushes op-1 after op-2 landed.
    assert_eq!(
        outbox.apply(&update("op-1", "row-a", "v1", at(10))),
        ApplyOutcome::Duplicate
    );
    assert_eq!(outbox.rows["row-a"].payload, "v2");
    assert_eq!(outbox.rows["row-a"].updated_at, at(20));
}

#[test]
fn out_of_order_newer_then_older_discards_the_stale_op() {
    let mut outbox = Outbox::new();
    assert_eq!(
        outbox.apply(&update("op-2", "row-a", "v2", at(20))),
        ApplyOutcome::Applied
    );
    assert_eq!(
        outbox.apply(&update("op-1", "row-a", "v1", at(10))),
        ApplyOutcome::DiscardedStale
    );
    assert_eq!(outbox.rows["row-a"].payload, "v2");
}

#[test]
fn out_of_order_older_then_newer_applies_both() {
    let mut outbox = Outbox::new();
    assert_eq!(
        outbox.apply(&update("op-1", "row-a", "v1", at(10))),
        ApplyOutcome::Applied
    );
    assert_eq!(
        outbox.apply(&update("op-2", "row-a", "v2", at(20))),
        ApplyOutcome::Applied
    );
    assert_eq!(outbox.rows["row-a"].payload, "v2");
}

#[test]
fn equal_timestamp_ties_keep_the_stored_row_deterministically() {
    // Two devices edit the same row at the same instant; the first op that
    // reaches the server wins and the loser is discarded on every replay, so
    // both replicas converge to the stored value after push and pull.
    let device_x = update("op-x", "row-a", "from-x", at(30));
    let device_y = update("op-y", "row-a", "from-y", at(30));

    let mut forward = Outbox::new();
    assert_eq!(forward.apply(&device_x), ApplyOutcome::Applied);
    assert_eq!(forward.apply(&device_y), ApplyOutcome::DiscardedStale);
    assert_eq!(forward.apply(&device_y), ApplyOutcome::Duplicate);
    assert_eq!(forward.rows["row-a"].payload, "from-x");

    // The reverse push order flips which payload survives, but the rule is
    // still deterministic: first arrival at equal timestamps wins.
    let mut reverse = Outbox::new();
    assert_eq!(reverse.apply(&device_y), ApplyOutcome::Applied);
    assert_eq!(reverse.apply(&device_x), ApplyOutcome::DiscardedStale);
    assert_eq!(reverse.rows["row-a"].payload, "from-y");

    // Sub-second timestamps also tie-break on exact equality.
    let sub_second =
        Utc.with_ymd_and_hms(2026, 10, 14, 12, 0, 0).unwrap() + Duration::milliseconds(250);
    assert!(!incoming_wins(sub_second, sub_second));
    assert!(incoming_wins(
        sub_second,
        sub_second + Duration::nanoseconds(1)
    ));
}

#[test]
fn delete_tombstones_the_row_and_blocks_older_updates() {
    let mut outbox = Outbox::new();
    assert_eq!(
        outbox.apply(&update("op-1", "row-a", "v1", at(10))),
        ApplyOutcome::Applied
    );
    assert_eq!(
        outbox.apply(&update("op-2", "row-a", "v2", at(20))),
        ApplyOutcome::Applied
    );
    assert_eq!(
        outbox.apply(&delete("op-3", "row-a", at(30))),
        ApplyOutcome::Applied
    );

    let row = &outbox.rows["row-a"];
    assert_eq!(
        row.deleted_at,
        Some(at(30)),
        "delete must set the tombstone"
    );
    assert_eq!(row.updated_at, at(30), "tombstone advances updated_at");

    // An out-of-order stale update must not resurrect the deleted row or
    // touch its payload.
    assert_eq!(
        outbox.apply(&update("op-2b", "row-a", "stale-resurrect", at(20))),
        ApplyOutcome::DiscardedStale
    );
    assert_eq!(outbox.rows["row-a"].deleted_at, Some(at(30)));
    assert_eq!(outbox.rows["row-a"].payload, "v2");
}

#[test]
fn a_newer_update_after_a_delete_resurrects_the_row() {
    // Last-write-wins applies uniformly: deletes are rows with deleted_at
    // set, not special-cased, so a newer update wins the tombstone.
    let mut outbox = Outbox::new();
    outbox.apply(&update("op-1", "row-a", "v1", at(10)));
    outbox.apply(&delete("op-2", "row-a", at(20)));
    assert_eq!(
        outbox.apply(&update("op-3", "row-a", "v2", at(30))),
        ApplyOutcome::Applied
    );

    let row = &outbox.rows["row-a"];
    assert_eq!(row.deleted_at, None);
    assert_eq!(row.payload, "v2");
    assert_eq!(row.updated_at, at(30));
}

#[test]
fn out_of_order_batch_lands_on_the_newest_state() {
    // Delivery order [t3, t1, t2] across push batches.
    let mut outbox = Outbox::new();
    let batch = [
        update("op-3", "row-a", "v3", at(30)),
        update("op-1", "row-a", "v1", at(10)),
        update("op-2", "row-a", "v2", at(20)),
    ];
    let mut outcomes = Vec::new();
    for op in &batch {
        outcomes.push(outbox.apply(op));
    }

    assert_eq!(
        outcomes,
        vec![
            ApplyOutcome::Applied,
            ApplyOutcome::DiscardedStale,
            ApplyOutcome::DiscardedStale
        ]
    );
    assert_eq!(outbox.rows["row-a"].payload, "v3");
}

#[test]
fn pull_pages_on_server_applied_at_including_tombstones() {
    let mut outbox = Outbox::new();
    for second in [10_u32, 20, 30, 40] {
        outbox.apply(&update(
            &format!("op-{second}"),
            &format!("row-{second}"),
            &format!("v{second}"),
            at(second),
        ));
    }

    let epoch = Cursor {
        applied_at: Utc.with_ymd_and_hms(1970, 1, 1, 0, 0, 0).unwrap(),
        row_id: String::new(),
    };
    let all = outbox.pull(&epoch);
    assert_eq!(all.len(), 4, "epoch cursor returns everything");
    // Pull order is the server stamp, not the client's write time.
    let ids: Vec<&str> = all.iter().map(|(id, _)| *id).collect();
    assert_eq!(ids, vec!["row-10", "row-20", "row-30", "row-40"]);

    let page = outbox.pull(&outbox.cursor_after("row-20"));
    let ids: Vec<&str> = page.iter().map(|(id, _)| *id).collect();
    assert_eq!(ids, vec!["row-30", "row-40"], "cursor is exclusive");

    assert!(
        outbox.pull(&outbox.cursor_after("row-40")).is_empty(),
        "cursor at the tip is empty"
    );
    // Tombstoned rows are pulled too, so clients learn about deletions.
    outbox.apply(&delete("op-del", "row-30", at(50)));
    let after_delete = outbox.pull(&outbox.cursor_after("row-40"));
    assert_eq!(after_delete.len(), 1);
    assert_eq!(after_delete[0].0, "row-30");
    assert!(after_delete[0].1.deleted_at.is_some());
}

#[test]
fn rows_sharing_one_applied_at_survive_page_boundaries() {
    // One server transaction can stamp several rows with the same
    // applied_at (now() is the transaction time). The id tie-break must
    // still deliver every row even when a page boundary lands between
    // them, which a timestamp-only cursor would silently drop.
    let mut outbox = Outbox::new();
    outbox.set_server_time(at(60));
    outbox.apply_same_instant(&update("op-1", "row-a", "v1", at(10)));
    outbox.apply_same_instant(&update("op-2", "row-b", "v2", at(11)));
    outbox.set_server_time(at(61));
    outbox.apply(&update("op-3", "row-c", "v3", at(12)));

    assert_eq!(
        outbox.rows["row-a"].applied_at,
        outbox.rows["row-b"].applied_at
    );

    // Page one ended on row-a, which shares applied_at with row-b.
    let page: Vec<&str> = outbox
        .pull(&outbox.cursor_after("row-a"))
        .iter()
        .map(|(id, _)| *id)
        .collect();
    assert_eq!(page, vec!["row-b", "row-c"]);
}

#[test]
fn a_future_skewed_updated_at_cannot_starve_pulls() {
    let mut outbox = Outbox::new();
    outbox.apply(&update("op-a", "row-a", "v1", at(10)));

    // A device with a wildly wrong clock pushes once.
    let skewed = Utc.with_ymd_and_hms(2099, 1, 1, 0, 0, 0).unwrap();
    assert_eq!(
        outbox.apply(&update("op-b", "row-b", "v2", skewed)),
        ApplyOutcome::Applied
    );

    // The stored LWW timestamp is clamped near the server clock, so it
    // cannot pin a row years ahead of everyone else's writes.
    let ceiling = outbox.server_time - Duration::seconds(1)
        + Duration::minutes(waveform_sync::MAX_CLIENT_CLOCK_SKEW_MINUTES);
    assert_eq!(outbox.rows["row-b"].updated_at, ceiling);

    // And a client that had already synced row-a still receives row-b on
    // its very next pull: the cursor rides on the server stamp.
    let page = outbox.pull(&outbox.cursor_after("row-a"));
    let ids: Vec<&str> = page.iter().map(|(id, _)| *id).collect();
    assert_eq!(ids, vec!["row-b"]);
}
