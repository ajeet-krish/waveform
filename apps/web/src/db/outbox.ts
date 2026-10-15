/**
 * Outbox: the queue of mutations waiting to be pushed to the server.
 *
 * Rows are appended by the repos inside the same IndexedDB transaction as
 * the row writes they describe, so a crash can never leave a row change
 * without its op (or vice versa). The drain order is `created_at` with
 * `op_id` as tie-break.
 */

import type { WaveformDb } from "./schema";
import type { OutboxAction, OutboxEntity, OutboxOp, OutboxRowMap } from "./types";

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
  /** Queued ops in drain order (`created_at`, then `op_id`), capped by `limit`. */
  listPending(limit?: number): Promise<OutboxOp[]>;
  /** Drops ops the server acknowledged. Unknown ids are ignored. */
  removeAcked(op_ids: string[]): Promise<void>;
  /** Number of queued ops. */
  count(): Promise<number>;
};

export function createOutboxRepo(db: WaveformDb): OutboxRepo {
  return {
    async listPending(limit?: number): Promise<OutboxOp[]> {
      const ops = await db.outbox.orderBy("created_at").toArray();
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
      return db.outbox.count();
    },
  };
}
