/**
 * Outbox drain: push queued ops to the server until the queue is lean.
 *
 * One drain takes batches of at most `cap` ops in `(created_at, op_id)`
 * order, pushes them, and settles each result by op_id: applied,
 * duplicate, and discarded_stale are acknowledged (removed), rejected
 * ops are recorded through markOutboxFailed (quarantine at 3), and
 * retryable ops stay queued but are skipped for the rest of this drain
 * so the loop always makes progress. Deferred ids (retryable or never
 * answered) are excluded from the later batches' query, so the loop
 * walks past them and still attempts the rest of the queue. Results are
 * keyed by op_id, so a partial response is safe: an op the server never
 * answered simply stays queued. Any transport error or non-2xx response
 * aborts the drain with a reason; work already settled in earlier
 * batches stands.
 *
 * Contract of a return without `aborted`: every queued op was attempted
 * at least once this drain. Deferred ops can still remain stored (they
 * are retried by a later drain), but no op went unattempted because of
 * an earlier batch's deferrals.
 */

import { RULE_CONSTANTS, type OpResult, type PushOp, type PushResponse } from "@waveform/api-types";
import { createOutboxRepo, markOutboxFailed } from "../../db/outbox";
import type { WaveformDb } from "../../db/schema";
import type { OutboxOp } from "../../db/types";
import { ApiError } from "../api";

/** Why a drain stopped early; absent means the queue fully drained. */
export type DrainAbortReason = "auth-expired" | "offline" | "error";

/** The push surface the drain needs (a stub-able subset of ApiClient). */
export type SyncPushApi = {
  push(ops: PushOp[]): Promise<PushResponse>;
};

export type DrainOptions = {
  db: WaveformDb;
  api: SyncPushApi;
  /** Batch cap; defaults to the server-agreed maxOpsPerPush (200). */
  cap?: number;
};

export type DrainResult = {
  /** Ops sent to the server across all batches of this drain. */
  pushed: number;
  /** Ops removed from the outbox after an acked status. */
  acked: number;
  /** Ops recorded through markOutboxFailed after a rejected status. */
  rejected: number;
  /**
   * Present when the drain stopped early instead of emptying the
   * queue. Absent means every queued op was attempted at least once
   * (deferred ones may remain stored; see the module contract).
   */
  aborted?: DrainAbortReason;
};

/** Maps an outbox op to its wire shape (`created_at` never crosses). */
export function toPushOp(op: OutboxOp): PushOp {
  return {
    op_id: op.op_id,
    entity: op.entity,
    action: op.action,
    payload: op.payload as Record<string, unknown>,
    updated_at: op.updated_at,
  };
}

/** Classifies an ApiError kind into the drain's abort vocabulary. */
function abortReason(error: ApiError): DrainAbortReason {
  if (error.kind === "auth-expired") {
    return "auth-expired";
  }
  if (error.kind === "offline" || error.kind === "timeout") {
    return "offline";
  }
  return "error";
}

/**
 * Pushes the outbox queue toward empty. Deferred ids are filtered out
 * of the query (not just the batch) so ops behind a deferred first
 * batch still get attempted; see the module contract for what a return
 * without `aborted` guarantees.
 */
export async function drainOutbox(options: DrainOptions): Promise<DrainResult> {
  const { db, api } = options;
  const cap = options.cap ?? RULE_CONSTANTS.sync.maxOpsPerPush;
  const outbox = createOutboxRepo(db);
  const result: DrainResult = { pushed: 0, acked: 0, rejected: 0 };
  // Retryable ops this drain saw; skipped in later batches so the loop
  // always terminates. They stay queued for the next drain call.
  const deferred = new Set<string>();

  for (;;) {
    // Excluding deferred ids here (not only when slicing the batch) is
    // what lets the loop reach ops sitting behind a deferred first
    // batch instead of exiting with them unattempted.
    const pending = await outbox.listPending();
    const batch = pending.filter((op) => !deferred.has(op.op_id)).slice(0, cap);
    if (batch.length === 0) {
      return result;
    }

    let response: PushResponse;
    try {
      response = await api.push(batch.map(toPushOp));
    } catch (cause) {
      if (cause instanceof ApiError) {
        return { ...result, aborted: abortReason(cause) };
      }
      // Anything else is a client-side bug, not a server answer.
      return { ...result, aborted: "error" };
    }
    result.pushed += batch.length;

    // Results keyed by op_id: a partial response leaves the rest queued
    // (deferred like retryable ones so this drain still terminates).
    const byId = new Map<string, OpResult>();
    for (const op of response.results) {
      byId.set(op.op_id, op);
    }
    const acked: string[] = [];
    for (const op of batch) {
      const outcome = byId.get(op.op_id);
      if (outcome === undefined) {
        // The server never answered this op; it stays queued for later.
        deferred.add(op.op_id);
        continue;
      }
      switch (outcome.status) {
        case "applied":
        case "duplicate":
        case "discarded_stale":
          acked.push(op.op_id);
          break;
        case "rejected":
          await markOutboxFailed(db, op.op_id, outcome.error);
          result.rejected += 1;
          break;
        case "retryable":
          deferred.add(op.op_id);
          break;
      }
    }
    await outbox.removeAcked(acked);
    result.acked += acked.length;
  }
}
