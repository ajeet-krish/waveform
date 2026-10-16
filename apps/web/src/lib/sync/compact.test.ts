import { afterEach, describe, expect, it } from "vitest";
import { createWaveformDb, type WaveformDb } from "../../db/schema";
import { OUTBOX_COMPACTED_V1_KEY, getMeta } from "./meta";
import { compactOutbox } from "./compact";
import type { OutboxOp } from "../../db/types";
import type { LocalRow } from "../../db/types";
import type { WorkoutSession as WireWorkout } from "@waveform/api-types";

const openDbs: WaveformDb[] = [];

function harness(name: string): WaveformDb {
  const db = createWaveformDb(`compact-${name}-${crypto.randomUUID()}`);
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

function op(
  entity: OutboxOp["entity"],
  id: string,
  created_at: string,
  updated_at: string,
  op_id: string,
): OutboxOp {
  return {
    op_id,
    entity,
    action: "update",
    payload: sessionPayload(id, updated_at),
    updated_at,
    created_at,
  };
}

describe("compactOutbox", () => {
  it("keeps only the newest op per (entity, payload.id) by (created_at, op_id)", async () => {
    const db = harness("supersede");
    await db.outbox.bulkAdd([
      // Three ops for the same session; op-c is newest by created_at.
      op("workout_sessions", "w1", "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", "op-a"),
      op("workout_sessions", "w1", "2026-10-02T00:00:00.000Z", "2026-10-02T00:00:00.000Z", "op-b"),
      op("workout_sessions", "w1", "2026-10-03T00:00:00.000Z", "2026-10-03T00:00:00.000Z", "op-c"),
      // A different session is untouched.
      op("workout_sessions", "w2", "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", "op-d"),
      // A same-id op in another entity is a different row entirely.
      op("activities", "w1", "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", "op-e"),
    ]);

    const result = await compactOutbox(db);
    expect(result.removed).toBe(2);

    const remaining = (await db.outbox.toArray()).map((entry) => entry.op_id).sort();
    expect(remaining).toEqual(["op-c", "op-d", "op-e"]);
  });

  it("breaks created_at ties by op_id and the kept op retains its own updated_at", async () => {
    const db = harness("tie");
    const stamp = "2026-10-01T00:00:00.000Z";
    // Same created_at: the larger op_id ("op-2") wins, and its
    // updated_at (a distinct LWW timestamp) must survive untouched.
    await db.outbox.bulkAdd([
      op("workout_sessions", "w1", stamp, "2026-09-01T00:00:00.000Z", "op-1"),
      op("workout_sessions", "w1", stamp, "2026-09-02T00:00:00.000Z", "op-2"),
    ]);

    const result = await compactOutbox(db);
    expect(result.removed).toBe(1);

    const survivor = await db.outbox.get("op-2");
    expect(survivor).toBeDefined();
    expect(survivor?.updated_at).toBe("2026-09-02T00:00:00.000Z");
    expect(await db.outbox.get("op-1")).toBeUndefined();
  });

  it("runs once: the second call is a no-op even over a fresh superseded pair", async () => {
    const db = harness("once");
    await db.outbox.bulkAdd([
      op("workout_sessions", "w1", "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", "op-a"),
      op("workout_sessions", "w1", "2026-10-02T00:00:00.000Z", "2026-10-02T00:00:00.000Z", "op-b"),
    ]);

    const first = await compactOutbox(db);
    expect(first.removed).toBe(1);
    expect(await getMeta(db, OUTBOX_COMPACTED_V1_KEY)).toBe(true);

    // A new superseded pair arrives after the flag: the one-time guard
    // means compaction never runs again.
    await db.outbox.bulkAdd([
      op("workout_sessions", "w2", "2026-10-03T00:00:00.000Z", "2026-10-03T00:00:00.000Z", "op-c"),
      op("workout_sessions", "w2", "2026-10-04T00:00:00.000Z", "2026-10-04T00:00:00.000Z", "op-d"),
    ]);
    const second = await compactOutbox(db);
    expect(second.removed).toBe(0);
    expect(await db.outbox.get("op-c")).toBeDefined();
    expect(await db.outbox.get("op-d")).toBeDefined();
  });

  it("an empty outbox still sets the flag and reports zero", async () => {
    const db = harness("empty");
    const result = await compactOutbox(db);
    expect(result.removed).toBe(0);
    expect(await getMeta(db, OUTBOX_COMPACTED_V1_KEY)).toBe(true);
  });
});
