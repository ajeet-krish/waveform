/**
 * One-time outbox compaction.
 *
 * The Phase 1 outbox has never drained against a server, so it may hold
 * many ops for the same row where only the newest still matters. Once
 * (guarded by the `outbox_compacted_v1` flag set in the SAME transaction
 * as the deletions), compactOutbox keeps only the newest op per
 * `(entity, payload.id)`, ordered by `(created_at, op_id)` exactly like
 * the drain order, and hard-deletes the superseded ones. Idempotent by
 * construction: after the flag is set the function is a no-op, and even
 * without the flag a second pass would find nothing superseded.
 */

import type { WaveformDb } from "../../db/schema";
import type { OutboxOp } from "../../db/types";
import { OUTBOX_COMPACTED_V1_KEY, setMeta } from "./meta";

export type CompactResult = {
  /** Ops deleted as superseded (0 when the outbox was already lean). */
  removed: number;
};

/** True when `a` is newer than `b` by the drain-order rule. */
function isNewer(a: OutboxOp, b: OutboxOp): boolean {
  if (a.created_at !== b.created_at) {
    return a.created_at > b.created_at;
  }
  return a.op_id > b.op_id;
}

export async function compactOutbox(db: WaveformDb): Promise<CompactResult> {
  return db.transaction("rw", db.outbox, db.sync_meta, async () => {
    const flag = await db.sync_meta.get(OUTBOX_COMPACTED_V1_KEY);
    if (flag !== undefined) {
      return { removed: 0 };
    }

    const ops = await db.outbox.toArray();
    const keep = new Map<string, OutboxOp>();
    const superseded: string[] = [];
    for (const op of ops) {
      const key = `${op.entity}:${op.payload.id}`;
      const current = keep.get(key);
      if (current === undefined) {
        keep.set(key, op);
        continue;
      }
      // Newest by (created_at, op_id) wins; the loser is superseded.
      const winner = isNewer(op, current) ? op : current;
      const loser = winner === op ? current : op;
      keep.set(key, winner);
      superseded.push(loser.op_id);
    }

    if (superseded.length > 0) {
      await db.outbox.bulkDelete(superseded);
    }
    await setMeta(db, OUTBOX_COMPACTED_V1_KEY, true);
    return { removed: superseded.length };
  });
}
