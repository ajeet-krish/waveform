/**
 * Outbox: the queue of mutations waiting to be pushed to the server.
 *
 * Rows are appended by the repos inside the same IndexedDB transaction as
 * the row writes they describe, so a crash can never leave a row change
 * without its op (or vice versa). The drain order is `created_at` with
 * `op_id` as tie-break.
 *
 * Transport bookkeeping rides along: `markOutboxFailed` bumps `attempts`
 * and quarantines an op after three failures so one poisoned row cannot
 * wedge the queue. Quarantined ops stay stored (a later pass may inspect
 * or requeue them) but `listPending` and `count` skip them. A Dexie
 * `creating` hook on the outbox table publishes to `subscribeOutboxWrites`
 * subscribers so the sync engine can debounce a drain without editing
 * every repo.
 */

import type { WaveformDb } from "./schema";
import type { OutboxAction, OutboxEntity, OutboxOp, OutboxRowMap } from "./types";

/** Failed attempts before an op is quarantined out of the pending queue. */
export const OUTBOX_QUARANTINE_ATTEMPTS = 3;

/**
 * Builds one outbox op. `op_id` is client-generated so replays are
 * idempotent server-side; `created_at` and `updated_at` share `now` so a
 * row and its op always carry the same LWW timestamp. `lwwAt` overrides
 * `updated_at` for restores: a backup import must push the row's own
 * last-write-wins truth, not the import time, while `created_at` stays at
 * import time so the outbox drains in import order.
 */
export function buildOutboxOp<E extends OutboxEntity>(
  entity: E,
  action: OutboxAction,
  row: OutboxRowMap[E],
  now: Date,
  lwwAt?: string,
): OutboxOp<E> {
  const iso = now.toISOString();
  return {
    op_id: crypto.randomUUID(),
    entity,
    action,
    payload: row,
    updated_at: lwwAt ?? iso,
    created_at: iso,
  };
}

export type OutboxRepo = {
  /** Queued ops in drain order (`created_at`, then `op_id`), capped by `limit`. Quarantined ops are excluded. */
  listPending(limit?: number): Promise<OutboxOp[]>;
  /** Drops ops the server acknowledged. Unknown ids are ignored. */
  removeAcked(op_ids: string[]): Promise<void>;
  /** Number of queued ops, excluding quarantined ones. */
  count(): Promise<number>;
};

/**
 * Records one failed push for an op: increments `attempts`, stores
 * `last_error`, and sets `quarantined` once attempts reach
 * OUTBOX_QUARANTINE_ATTEMPTS. A missing op id is a no-op. Runs its own
 * small transaction so the drain can call it per rejected op.
 */
export async function markOutboxFailed(
  db: WaveformDb,
  op_id: string,
  error: string | null,
): Promise<void> {
  await db.transaction("rw", db.outbox, async () => {
    const op = await db.outbox.get(op_id);
    if (!op) {
      return;
    }
    const attempts = (op.attempts ?? 0) + 1;
    await db.outbox.put({
      ...op,
      attempts,
      last_error: error,
      quarantined: attempts >= OUTBOX_QUARANTINE_ATTEMPTS,
    });
  });
}

type OutboxWriteListener = () => void;

const outboxWriteListeners = new Set<OutboxWriteListener>();

/**
 * Databases that already carry the outbox `creating` hook. Guarding here
 * keeps the hook registered exactly once per Dexie instance no matter
 * how many repos are built on it.
 */
const hookedDbs = new WeakSet<WaveformDb>();

/** Publishes one write notification; a throwing listener cannot break the write. */
function publishOutboxWrite(): void {
  for (const listener of [...outboxWriteListeners]) {
    try {
      listener();
    } catch {
      // A subscriber's failure must never roll back an outbox append.
    }
  }
}

/**
 * Registers the outbox write hook on a database (idempotent per
 * instance). Called by createOutboxRepo so every app path that queues
 * ops also arms the notification seam; tests that drive the table
 * directly can call it too.
 */
export function watchOutboxWrites(db: WaveformDb): void {
  if (hookedDbs.has(db)) {
    return;
  }
  hookedDbs.add(db);
  db.outbox.hook("creating", () => {
    publishOutboxWrite();
  });
}

/**
 * Subscribes to outbox writes (every add, whatever repo made it). The
 * engine uses this to debounce a sync drain. The return value
 * unsubscribes.
 */
export function subscribeOutboxWrites(listener: OutboxWriteListener): () => void {
  outboxWriteListeners.add(listener);
  return () => {
    outboxWriteListeners.delete(listener);
  };
}

export function createOutboxRepo(db: WaveformDb): OutboxRepo {
  watchOutboxWrites(db);
  return {
    async listPending(limit?: number): Promise<OutboxOp[]> {
      const all = await db.outbox.orderBy("created_at").toArray();
      const ops = all.filter((op) => op.quarantined !== true);
      ops.sort((a, b) => {
        if (a.created_at !== b.created_at) {
          return a.created_at < b.created_at ? -1 : 1;
        }
        if (a.op_id === b.op_id) {
          return 0;
        }
        return a.op_id < b.op_id ? -1 : 1;
      });
      return limit === undefined ? ops : ops.slice(0, limit);
    },

    async removeAcked(op_ids: string[]): Promise<void> {
      if (op_ids.length === 0) {
        return;
      }
      await db.outbox.bulkDelete(op_ids);
    },

    async count(): Promise<number> {
      const ops = await db.outbox.toArray();
      return ops.filter((op) => op.quarantined !== true).length;
    },
  };
}
