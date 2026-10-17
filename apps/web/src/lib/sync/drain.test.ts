import { afterEach, describe, expect, it } from "vitest";
import type { OpResult, PushOp } from "@waveform/api-types";
import { createOutboxRepo } from "../../db/outbox";
import { createWaveformDb, type WaveformDb } from "../../db/schema";
import type { LocalRow, OutboxOp } from "../../db/types";
import type { WorkoutSession as WireWorkout } from "@waveform/api-types";
import { ApiError } from "../api";
import { drainOutbox, toPushOp, type SyncPushApi } from "./drain";

const openDbs: WaveformDb[] = [];

function harness(name: string): WaveformDb {
  const db = createWaveformDb(`drain-${name}-${crypto.randomUUID()}`);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDbs) {
    db.close();
  }
  openDbs.length = 0;
});

function sessionPayload(id: string, updated_at: string): LocalRow<WireWorkout> {
  return {
    id,
    user_id: "user-1",
    local_date: "2026-10-14",
    started_at: null,
    duration_min: null,
    routine_id: null,
    notes: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at,
    deleted_at: null,
  };
}

function op(id: string, created_at: string, op_id: string): OutboxOp {
  return {
    op_id,
    entity: "workout_sessions",
    action: "update",
    payload: sessionPayload(id, created_at),
    updated_at: created_at,
    created_at,
  };
}

/** An outbox op for a server-owned catalog exercise (owner_id null). */
function catalogOp(op_id: string): OutboxOp {
  return {
    op_id,
    entity: "exercises",
    action: "create",
    payload: {
      id: "ex-catalog",
      owner_id: null,
      name: "Bench Press (Barbell)",
      muscle_group: "chest",
      equipment: "barbell",
      created_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-01T00:00:00.000Z",
      deleted_at: null,
    },
    updated_at: "2026-10-01T00:00:00.000Z",
    created_at: "2026-10-01T00:00:00.000Z",
  };
}

/** Mirrors a server that acknowledges every op as applied. */
function allApplied(ops: PushOp[]): OpResult[] {
  return ops.map((o) => ({ op_id: o.op_id, status: "applied" as const, error: null }));
}

describe("toPushOp", () => {
  it("maps the wire shape and drops created_at", () => {
    const source = op("w1", "2026-10-01T00:00:00.000Z", "op-a");
    const wire = toPushOp(source);
    expect(wire).toEqual({
      op_id: "op-a",
      entity: "workout_sessions",
      action: "update",
      payload: source.payload,
      updated_at: "2026-10-01T00:00:00.000Z",
    });
    expect(Object.keys(wire)).not.toContain("created_at");
  });
});

describe("drainOutbox", () => {
  it("pushes in (created_at, op_id) drain order", async () => {
    const db = harness("order");
    // Same created_at on the first two: op_id breaks the tie.
    await db.outbox.bulkAdd([
      op("w3", "2026-10-03T00:00:00.000Z", "op-3"),
      op("w1", "2026-10-01T00:00:00.000Z", "op-b"),
      op("w2", "2026-10-01T00:00:00.000Z", "op-a"),
    ]);
    const calls: PushOp[][] = [];
    const api: SyncPushApi = {
      async push(ops) {
        calls.push(ops);
        return { results: allApplied(ops) };
      },
    };

    const result = await drainOutbox({ db, api });
    expect(result).toEqual({ pushed: 3, acked: 3, rejected: 0 });
    expect(calls[0]?.map((o) => o.op_id)).toEqual(["op-a", "op-b", "op-3"]);
    expect(await db.outbox.count()).toBe(0);
  });

  it("batches at the cap, repeating until the queue is empty", async () => {
    const db = harness("cap");
    const ops: OutboxOp[] = [];
    for (let i = 0; i < 5; i += 1) {
      ops.push(
        op(`w${i}`, `2026-10-0${i + 1}T00:00:00.000Z`, `op-${i}`),
      );
    }
    await db.outbox.bulkAdd(ops);
    const calls: PushOp[][] = [];
    const api: SyncPushApi = {
      async push(batch) {
        calls.push(batch);
        return { results: allApplied(batch) };
      },
    };

    const result = await drainOutbox({ db, api, cap: 2 });
    expect(result).toEqual({ pushed: 5, acked: 5, rejected: 0 });
    expect(calls.map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(await db.outbox.count()).toBe(0);
  });

  it("stops between batches on shouldStop, keeping settled work", async () => {
    const db = harness("stop");
    await db.outbox.bulkAdd([
      op("w1", "2026-10-01T00:00:00.000Z", "op-1"),
      op("w2", "2026-10-02T00:00:00.000Z", "op-2"),
      op("w3", "2026-10-03T00:00:00.000Z", "op-3"),
      op("w4", "2026-10-04T00:00:00.000Z", "op-4"),
    ]);
    const calls: PushOp[][] = [];
    let stop = false;
    const api: SyncPushApi = {
      async push(batch) {
        calls.push(batch);
        // The first batch settles, then a stop lands before the next one.
        stop = true;
        return { results: allApplied(batch) };
      },
    };

    const result = await drainOutbox({ db, api, cap: 2, shouldStop: () => stop });

    // A partial result with no abort reason: the first batch's acks stand,
    // the rest stay queued for a later drain.
    expect(result).toEqual({ pushed: 2, acked: 2, rejected: 0 });
    expect(result.aborted).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);
    expect(await db.outbox.count()).toBe(2);
  });

  it("acks applied, duplicate, and discarded_stale", async () => {
    const db = harness("ack");
    await db.outbox.bulkAdd([
      op("w1", "2026-10-01T00:00:00.000Z", "op-a"),
      op("w2", "2026-10-02T00:00:00.000Z", "op-b"),
      op("w3", "2026-10-03T00:00:00.000Z", "op-c"),
    ]);
    const api: SyncPushApi = {
      async push(ops) {
        const statuses = ["applied", "duplicate", "discarded_stale"] as const;
        return {
          results: ops.map((o, i) => ({
            op_id: o.op_id,
            status: statuses[i] ?? "applied",
            error: null,
          })),
        };
      },
    };

    const result = await drainOutbox({ db, api });
    expect(result).toEqual({ pushed: 3, acked: 3, rejected: 0 });
    expect(await db.outbox.count()).toBe(0);
  });

  it("attempts a rejected op once per drain and quarantines it after three drains", async () => {
    const db = harness("quarantine");
    await db.outbox.add(op("w1", "2026-10-01T00:00:00.000Z", "op-a"));
    const calls: PushOp[][] = [];
    const api: SyncPushApi = {
      async push(ops) {
        calls.push(ops);
        return { results: ops.map((o) => ({ op_id: o.op_id, status: "rejected" as const, error: "invalid_payload" as const })) };
      },
    };

    const first = await drainOutbox({ db, api });
    // A rejected op is attempted once per drain, not repeatedly inside one.
    expect(first).toEqual({ pushed: 1, acked: 0, rejected: 1 });
    expect(calls).toHaveLength(1);
    const afterOne = await db.outbox.get("op-a");
    expect(afterOne?.attempts).toBe(1);
    expect(afterOne?.quarantined).toBe(false);

    // Two more separate drains reach the quarantine threshold.
    await drainOutbox({ db, api });
    await drainOutbox({ db, api });
    expect(calls).toHaveLength(3);

    const stored = await db.outbox.get("op-a");
    expect(stored?.attempts).toBe(3);
    expect(stored?.last_error).toBe("invalid_payload");
    expect(stored?.quarantined).toBe(true);
    // Quarantined: no longer pending, but not deleted either.
    const repo = createOutboxRepo(db);
    expect(await repo.listPending()).toHaveLength(0);
    expect(await db.outbox.get("op-a")).toBeDefined();

    // A fresh drain skips it entirely.
    const again = await drainOutbox({ db, api });
    expect(again).toEqual({ pushed: 0, acked: 0, rejected: 0 });
    expect(calls).toHaveLength(3);
  });

  it("clean-drops a rejected server-owned catalog op with no quarantine", async () => {
    const db = harness("catalog-reject");
    await db.outbox.add(catalogOp("op-cat"));
    const api: SyncPushApi = {
      async push(ops) {
        return {
          results: ops.map((o) => ({
            op_id: o.op_id,
            status: "rejected" as const,
            error: "invalid_payload" as const,
          })),
        };
      },
    };

    const result = await drainOutbox({ db, api });
    // Acknowledged and removed, with no failed attempt recorded.
    expect(result).toEqual({ pushed: 1, acked: 1, rejected: 0 });
    expect(await db.outbox.get("op-cat")).toBeUndefined();
    expect(await db.outbox.count()).toBe(0);
    const repo = createOutboxRepo(db);
    expect(await repo.listPending()).toHaveLength(0);
  });

  it("defers a rejected op so later ops still sync in the same drain", async () => {
    const db = harness("reject-defer");
    await db.outbox.bulkAdd([
      op("w1", "2026-10-01T00:00:00.000Z", "op-a"),
      op("w2", "2026-10-02T00:00:00.000Z", "op-b"),
    ]);
    const calls: PushOp[][] = [];
    const api: SyncPushApi = {
      async push(ops) {
        calls.push(ops);
        return {
          results: ops.map((o) =>
            o.op_id === "op-a"
              ? { op_id: o.op_id, status: "rejected" as const, error: "invalid_payload" as const }
              : { op_id: o.op_id, status: "applied" as const, error: null },
          ),
        };
      },
    };

    const result = await drainOutbox({ db, api, cap: 1 });
    // The rejected op is deferred; op-b still gets its own push.
    expect(calls.map((batch) => batch.map((o) => o.op_id))).toEqual([["op-a"], ["op-b"]]);
    expect(result).toEqual({ pushed: 2, acked: 1, rejected: 1 });
    expect(result.aborted).toBeUndefined();
    const remaining = await db.outbox.toArray();
    expect(remaining.map((o) => o.op_id)).toEqual(["op-a"]);
    expect((await db.outbox.get("op-a"))?.attempts).toBe(1);
  });

  it("leaves retryable ops queued without burning an attempt", async () => {
    const db = harness("retryable");
    await db.outbox.add(op("w1", "2026-10-01T00:00:00.000Z", "op-a"));
    const calls: PushOp[][] = [];
    const api: SyncPushApi = {
      async push(ops) {
        calls.push(ops);
        return { results: ops.map((o) => ({ op_id: o.op_id, status: "retryable" as const, error: null })) };
      },
    };

    const result = await drainOutbox({ db, api });
    expect(result).toEqual({ pushed: 1, acked: 0, rejected: 0 });
    // Deferred, not re-pushed, within the same drain.
    expect(calls).toHaveLength(1);

    const stored = await db.outbox.get("op-a");
    expect(stored?.attempts).toBeUndefined();
    expect(stored?.quarantined).toBeUndefined();
    const repo = createOutboxRepo(db);
    expect(await repo.listPending()).toHaveLength(1);
  });

  it("settles each batch by op_id so a partial response is safe", async () => {
    const db = harness("partial");
    await db.outbox.bulkAdd([
      op("w1", "2026-10-01T00:00:00.000Z", "op-a"),
      op("w2", "2026-10-02T00:00:00.000Z", "op-b"),
    ]);
    const api: SyncPushApi = {
      // Answers only op-a; op-b is never mentioned.
      async push() {
        return { results: [{ op_id: "op-a", status: "applied", error: null }] };
      },
    };

    const result = await drainOutbox({ db, api, cap: 5 });
    // op-b stays queued (deferred, not acked, not failed) and the drain ends.
    expect(result).toEqual({ pushed: 2, acked: 1, rejected: 0 });
    const remaining = await db.outbox.toArray();
    expect(remaining.map((o) => o.op_id)).toEqual(["op-b"]);
  });

  it("attempts ops past a deferred first batch instead of exiting early", async () => {
    const db = harness("past-deferred");
    await db.outbox.bulkAdd([
      op("w1", "2026-10-01T00:00:00.000Z", "op-a"),
      op("w2", "2026-10-02T00:00:00.000Z", "op-b"),
    ]);
    const calls: PushOp[][] = [];
    const api: SyncPushApi = {
      async push(ops) {
        calls.push(ops);
        return {
          results: ops.map((o) =>
            o.op_id === "op-a"
              ? { op_id: o.op_id, status: "retryable" as const, error: null }
              : { op_id: o.op_id, status: "applied" as const, error: null },
          ),
        };
      },
    };

    const result = await drainOutbox({ db, api, cap: 1 });
    // op-a deferred after its own batch; op-b still earned a push of its
    // own rather than being skipped behind the deferred row.
    expect(calls.map((batch) => batch.map((o) => o.op_id))).toEqual([["op-a"], ["op-b"]]);
    expect(result).toEqual({ pushed: 2, acked: 1, rejected: 0 });
    expect(result.aborted).toBeUndefined();
    const remaining = await db.outbox.toArray();
    expect(remaining.map((o) => o.op_id)).toEqual(["op-a"]);
  });

  it("aborts with the right reason on transport and non-2xx failures", async () => {
    const offline = await (async () => {
      const db = harness("offline");
      await db.outbox.add(op("w1", "2026-10-01T00:00:00.000Z", "op-a"));
      const api: SyncPushApi = {
        async push() {
          throw new ApiError("offline", "The server could not be reached.");
        },
      };
      return drainOutbox({ db, api });
    })();
    expect(offline.aborted).toBe("offline");
    expect(offline.pushed).toBe(0);

    const expiredDb = harness("auth");
    await expiredDb.outbox.add(op("w1", "2026-10-01T00:00:00.000Z", "op-a"));
    const expiredApi: SyncPushApi = {
      async push() {
        throw new ApiError("auth-expired", "session expired", { status: 401 });
      },
    };
    const expired = await drainOutbox({ db: expiredDb, api: expiredApi });
    expect(expired.aborted).toBe("auth-expired");

    const serverDb = harness("server");
    await serverDb.outbox.add(op("w1", "2026-10-01T00:00:00.000Z", "op-a"));
    const serverApi: SyncPushApi = {
      async push() {
        throw new ApiError("server", "boom", { status: 500, code: "internal" });
      },
    };
    const server = await drainOutbox({ db: serverDb, api: serverApi });
    expect(server.aborted).toBe("error");

    // On an abort the op stays queued, untouched.
    const stored = await serverDb.outbox.get("op-a");
    expect(stored?.attempts).toBeUndefined();
  });

  it("keeps already-settled batches when a later batch aborts", async () => {
    const db = harness("mid-abort");
    await db.outbox.bulkAdd([
      op("w1", "2026-10-01T00:00:00.000Z", "op-a"),
      op("w2", "2026-10-02T00:00:00.000Z", "op-b"),
    ]);
    let first = true;
    const api: SyncPushApi = {
      async push(ops) {
        if (first) {
          first = false;
          return { results: allApplied(ops) };
        }
        throw new ApiError("offline", "gone");
      },
    };

    const result = await drainOutbox({ db, api, cap: 1 });
    expect(result.aborted).toBe("offline");
    expect(result.pushed).toBe(1);
    expect(result.acked).toBe(1);
    // op-a was acked before the abort; op-b stays queued.
    const remaining = await db.outbox.toArray();
    expect(remaining.map((o) => o.op_id)).toEqual(["op-b"]);
  });
});
