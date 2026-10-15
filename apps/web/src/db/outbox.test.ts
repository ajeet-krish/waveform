import type { Exercise } from "@waveform/api-types";
import { describe, expect, it } from "vitest";
import { buildOutboxOp, createOutboxRepo } from "./outbox";
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
});
