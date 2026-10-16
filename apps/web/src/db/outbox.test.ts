import type { Exercise } from "@waveform/api-types";
import { describe, expect, it } from "vitest";
import {
  buildOutboxOp,
  createOutboxRepo,
  markOutboxFailed,
  subscribeOutboxWrites,
  watchOutboxWrites,
} from "./outbox";
import { createWaveformDb } from "./schema";
import type { LocalRow, OutboxOp } from "./types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function exerciseRow(id: string): LocalRow<Exercise> {
  return {
    id,
    owner_id: "user-1",
    name: "Bench Press (Barbell)",
    muscle_group: "chest",
    equipment: "barbell",
    created_at: "2026-10-14T00:00:00.000Z",
    updated_at: "2026-10-14T00:00:00.000Z",
    deleted_at: null,
  };
}

function makeOp(op_id: string, stamp: string): OutboxOp {
  return {
    op_id,
    entity: "exercises",
    action: "create",
    payload: exerciseRow("row-1"),
    updated_at: stamp,
    created_at: stamp,
  };
}

describe("buildOutboxOp", () => {
  it("builds the exact wire shape with shared timestamps and a random op id", () => {
    const now = new Date("2026-10-14T09:30:00.000Z");
    const row = exerciseRow("row-1");
    const op = buildOutboxOp("exercises", "create", row, now);

    expect(Object.keys(op).sort()).toEqual([
      "action",
      "created_at",
      "entity",
      "op_id",
      "payload",
      "updated_at",
    ]);
    expect(op.op_id).toMatch(UUID_PATTERN);
    expect(op.entity).toBe("exercises");
    expect(op.action).toBe("create");
    expect(op.payload).toEqual(row);
    expect(op.updated_at).toBe("2026-10-14T09:30:00.000Z");
    expect(op.created_at).toBe("2026-10-14T09:30:00.000Z");

    const other = buildOutboxOp("exercises", "create", row, now);
    expect(other.op_id).not.toBe(op.op_id);
  });

  it("takes updated_at from lwwAt, not created_at or the import clock", () => {
    const now = new Date("2026-10-15T09:00:00.000Z");
    const row = exerciseRow("row-1"); // updated_at 2026-10-14T00:00:00.000Z
    const lwwAt = "2026-10-13T07:00:00.000Z";
    const op = buildOutboxOp("exercises", "update", row, now, lwwAt);

    expect(op.updated_at).toBe(lwwAt);
    expect(op.updated_at).not.toBe(row.updated_at);
    expect(op.created_at).toBe("2026-10-15T09:00:00.000Z");
    expect(op.created_at).not.toBe(op.updated_at);
  });
});

describe("createOutboxRepo", () => {
  it("lists pending ops by created_at then op_id and honours the limit", async () => {
    const db = createWaveformDb(`outbox-order-${crypto.randomUUID()}`);
    const repo = createOutboxRepo(db);
    await db.outbox.bulkAdd([
      makeOp("op-b", "2026-10-14T00:00:02.000Z"),
      makeOp("op-c", "2026-10-14T00:00:01.000Z"),
      makeOp("op-a", "2026-10-14T00:00:02.000Z"),
      makeOp("op-d", "2026-10-14T00:00:00.000Z"),
    ]);

    const pending = await repo.listPending();
    expect(pending.map((op) => op.op_id)).toEqual(["op-d", "op-c", "op-a", "op-b"]);

    const limited = await repo.listPending(2);
    expect(limited.map((op) => op.op_id)).toEqual(["op-d", "op-c"]);

    expect(await repo.count()).toBe(4);
    db.close();
  });

  it("removes acknowledged ops by id, ignoring unknown ids", async () => {
    const db = createWaveformDb(`outbox-ack-${crypto.randomUUID()}`);
    const repo = createOutboxRepo(db);
    await db.outbox.bulkAdd([
      makeOp("op-1", "2026-10-14T00:00:00.000Z"),
      makeOp("op-2", "2026-10-14T00:00:01.000Z"),
      makeOp("op-3", "2026-10-14T00:00:02.000Z"),
    ]);

    expect(await repo.count()).toBe(3);
    await repo.removeAcked(["op-1", "op-3", "op-does-not-exist"]);
    expect(await repo.count()).toBe(1);

    const pending = await repo.listPending();
    expect(pending.map((op) => op.op_id)).toEqual(["op-2"]);
    db.close();
  });

  it("markOutboxFailed counts attempts and quarantines at 3", async () => {
    const db = createWaveformDb(`outbox-failed-${crypto.randomUUID()}`);
    const repo = createOutboxRepo(db);
    await db.outbox.add(makeOp("op-1", "2026-10-14T00:00:00.000Z"));

    await markOutboxFailed(db, "op-1", "invalid_payload");
    let stored = await db.outbox.get("op-1");
    expect(stored?.attempts).toBe(1);
    expect(stored?.last_error).toBe("invalid_payload");
    expect(stored?.quarantined).toBe(false);
    // Still pending after one failure.
    expect(await repo.listPending()).toHaveLength(1);

    await markOutboxFailed(db, "op-1", "invalid_payload");
    stored = await db.outbox.get("op-1");
    expect(stored?.attempts).toBe(2);
    expect(stored?.quarantined).toBe(false);

    await markOutboxFailed(db, "op-1", "invalid_payload");
    stored = await db.outbox.get("op-1");
    expect(stored?.attempts).toBe(3);
    expect(stored?.quarantined).toBe(true);
    // Quarantined ops leave the pending queue but stay stored.
    expect(await repo.listPending()).toHaveLength(0);
    expect(await repo.count()).toBe(0);
    expect(await db.outbox.get("op-1")).toBeDefined();

    // An unknown op id is a no-op, not a crash.
    await markOutboxFailed(db, "op-missing", null);
    db.close();
  });

  it("listPending and count exclude quarantined ops but keep healthy ones", async () => {
    const db = createWaveformDb(`outbox-quarantine-${crypto.randomUUID()}`);
    const repo = createOutboxRepo(db);
    await db.outbox.bulkAdd([
      makeOp("op-healthy", "2026-10-14T00:00:00.000Z"),
      { ...makeOp("op-dead", "2026-10-14T00:00:01.000Z"), quarantined: true },
    ]);

    const pending = await repo.listPending();
    expect(pending.map((op) => op.op_id)).toEqual(["op-healthy"]);
    expect(await repo.count()).toBe(1);
    db.close();
  });

  it("subscribeOutboxWrites fires on outbox adds, not on other tables", async () => {
    const db = createWaveformDb(`outbox-watch-${crypto.randomUUID()}`);
    watchOutboxWrites(db);
    const seen: number[] = [];
    const unsubscribe = subscribeOutboxWrites(() => seen.push(seen.length + 1));

    await db.workout_drafts.add({
      id: "draft-1",
      local_date: "2026-10-14",
      started_at: null,
      duration_min: null,
      routine_id: null,
      notes: null,
      entries: [],
      updated_at: "2026-10-14T00:00:00.000Z",
    });
    expect(seen).toHaveLength(0);

    await db.outbox.add(makeOp("op-1", "2026-10-14T00:00:00.000Z"));
    expect(seen).toHaveLength(1);

    // A bulk add publishes one notification per appended op.
    await db.outbox.bulkAdd([
      makeOp("op-2", "2026-10-14T00:00:01.000Z"),
      makeOp("op-3", "2026-10-14T00:00:02.000Z"),
    ]);
    expect(seen).toHaveLength(3);

    // An update (put over an existing key) is not a "creating" write.
    const existing = await db.outbox.get("op-1");
    if (existing === undefined) {
      throw new Error("op-1 vanished");
    }
    await db.outbox.put({ ...existing, last_error: "x" });
    expect(seen).toHaveLength(3);

    unsubscribe();
    await db.outbox.add(makeOp("op-4", "2026-10-14T00:00:03.000Z"));
    expect(seen).toHaveLength(3);
    db.close();
  });

  it("watchOutboxWrites arms a database once no matter how often it is called", async () => {
    const db = createWaveformDb(`outbox-once-${crypto.randomUUID()}`);
    watchOutboxWrites(db);
    watchOutboxWrites(db);
    const seen: number[] = [];
    const unsubscribe = subscribeOutboxWrites(() => seen.push(1));

    await db.outbox.add(makeOp("op-1", "2026-10-14T00:00:00.000Z"));
    // One notification, not two: the hook was registered once.
    expect(seen).toHaveLength(1);
    unsubscribe();
    db.close();
  });
});
