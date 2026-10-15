import { e1rmBrzycki } from "@waveform/scoring";
import { afterEach, describe, expect, it } from "vitest";
import { createRepos, type Repos } from "./repos";
import { createWaveformDb, type WaveformDb } from "./schema";
import type { WorkoutDraft } from "./types";
import {
  LocalValidationError,
  assertValidEntry,
  assertValidSet,
  assertValidWorkout,
} from "./validation";

type Harness = { db: WaveformDb; repos: Repos };

const openDbs: WaveformDb[] = [];

/** Fresh database plus repos on an advancing one-second test clock. */
function harness(name: string): Harness {
  const db = createWaveformDb(`repos-${name}-${crypto.randomUUID()}`);
  openDbs.push(db);
  let current = Date.UTC(2026, 9, 14, 12, 0, 0);
  const repos = createRepos(db, {
    userId: "user-1",
    now: () => {
      const stamp = new Date(current);
      current += 1000;
      return stamp;
    },
  });
  return { db, repos };
}

afterEach(() => {
  for (const db of openDbs) {
    db.close();
  }
  openDbs.length = 0;
});

function makeDraft(overrides: Partial<WorkoutDraft> = {}): WorkoutDraft {
  return {
    id: crypto.randomUUID(),
    local_date: "2026-10-14",
    started_at: "2026-10-14T12:00:00.000Z",
    duration_min: 45,
    routine_id: null,
    notes: null,
    entries: [
      {
        id: crypto.randomUUID(),
        exercise_id: "exercise-1",
        order_index: 0,
        notes: null,
        sets: [
          { id: crypto.randomUUID(), set_index: 0, weight_kg: 60, reps: 5, is_warmup: false },
          { id: crypto.randomUUID(), set_index: 1, weight_kg: 65, reps: 5, is_warmup: false },
        ],
      },
    ],
    updated_at: "2026-10-14T12:00:00.000Z",
    ...overrides,
  };
}

function capture(fn: () => void): LocalValidationError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(LocalValidationError);
    return error as LocalValidationError;
  }
  throw new Error("expected a LocalValidationError");
}

describe("exercises repo", () => {
  it("createCustom writes the row plus exactly one create op sharing id and updated_at", async () => {
    const { db, repos } = harness("create-custom");
    const { row, op } = await repos.exercises.createCustom({
      name: "Zettel Curl",
      muscle_group: "biceps",
      equipment: "dumbbell",
    });

    expect(row.owner_id).toBe("user-1");
    expect(row.deleted_at).toBeNull();
    expect(await db.exercises.get(row.id)).toEqual(row);

    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    const queued = ops[0];
    expect(queued?.entity).toBe("exercises");
    expect(queued?.action).toBe("create");
    expect(queued?.op_id).toBe(op.op_id);
    expect(queued?.payload.id).toBe(row.id);
    expect(queued?.updated_at).toBe(row.updated_at);
  });

  it("listLive hides tombstones and sorts by name", async () => {
    const { repos } = harness("list-live");
    await repos.exercises.createCustom({ name: "Zulu Row", muscle_group: "back" });
    await repos.exercises.createCustom({ name: "Alpha Row", muscle_group: "back" });
    const mike = await repos.exercises.createCustom({ name: "Mike Row", muscle_group: "back" });
    await repos.exercises.softDelete(mike.row.id);

    const live = await repos.exercises.listLive();
    expect(live.map((row) => row.name)).toEqual(["Alpha Row", "Zulu Row"]);
  });

  it("updateCustom patches a custom row and queues one update op", async () => {
    const { db, repos } = harness("update-custom");
    const created = await repos.exercises.createCustom({
      name: "Zettel Curl",
      muscle_group: "biceps",
      equipment: "dumbbell",
    });

    const { row, op } = await repos.exercises.updateCustom(created.row.id, {
      name: "Zettel Curl 2",
    });
    expect(row.id).toBe(created.row.id);
    expect(row.name).toBe("Zettel Curl 2");
    expect(row.muscle_group).toBe("biceps");
    expect(row.equipment).toBe("dumbbell");
    expect(row.owner_id).toBe("user-1");
    expect(row.created_at).toBe(created.row.created_at);
    expect(row.updated_at > created.row.updated_at).toBe(true);
    expect(await db.exercises.get(row.id)).toEqual(row);

    const ops = await repos.outbox.listPending();
    expect(ops.map((queued) => queued.action)).toEqual(["create", "update"]);
    const queued = ops[1];
    expect(queued?.entity).toBe("exercises");
    expect(queued?.op_id).toBe(op.op_id);
    expect(queued?.payload).toEqual(row);
    expect(queued?.updated_at).toBe(row.updated_at);

    // equipment accepts an explicit null to clear the column.
    const cleared = await repos.exercises.updateCustom(created.row.id, { equipment: null });
    expect(cleared.row.equipment).toBeNull();
    expect(cleared.row.name).toBe("Zettel Curl 2");
    expect(cleared.op.action).toBe("update");
  });

  it("updateCustom refuses catalog rows and writes nothing", async () => {
    const { db, repos } = harness("update-custom-catalog");
    const catalogId = crypto.randomUUID();
    const stamp = "2026-10-14T00:00:00.000Z";
    await db.exercises.put({
      id: catalogId,
      owner_id: null,
      name: "Bench Press (Barbell)",
      muscle_group: "chest",
      equipment: "barbell",
      created_at: stamp,
      updated_at: stamp,
      deleted_at: null,
    });

    await expect(
      repos.exercises.updateCustom(catalogId, { name: "Renamed", muscle_group: "legs" }),
    ).rejects.toThrow(LocalValidationError);
    expect(await db.outbox.count()).toBe(0);
    const row = await db.exercises.get(catalogId);
    expect(row?.name).toBe("Bench Press (Barbell)");
    expect(row?.updated_at).toBe(stamp);
  });

  it("softDelete refuses catalog rows and tombstones custom rows with a delete op", async () => {
    const { db, repos } = harness("soft-delete");
    const catalogId = crypto.randomUUID();
    const stamp = "2026-10-14T00:00:00.000Z";
    await db.exercises.put({
      id: catalogId,
      owner_id: null,
      name: "Bench Press (Barbell)",
      muscle_group: "chest",
      equipment: "barbell",
      created_at: stamp,
      updated_at: stamp,
      deleted_at: null,
    });

    await expect(repos.exercises.softDelete(catalogId)).rejects.toThrow(LocalValidationError);
    expect(await db.outbox.count()).toBe(0);
    expect((await db.exercises.get(catalogId))?.deleted_at).toBeNull();

    const custom = await repos.exercises.createCustom({
      name: "Custom Curl",
      muscle_group: "biceps",
    });
    const { row, op } = await repos.exercises.softDelete(custom.row.id);

    expect(row.deleted_at).toBe(row.updated_at);
    expect(row.owner_id).toBe("user-1");
    expect(op.action).toBe("delete");
    expect(op.payload.deleted_at).toBe(row.deleted_at);

    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(2);
    expect(ops.filter((queued) => queued.action === "delete")).toHaveLength(1);
    expect((await db.exercises.get(custom.row.id))?.deleted_at).toBe(row.deleted_at);
  });
});

describe("workouts repo", () => {
  it("create and update round-trip through rows and ops", async () => {
    const { db, repos } = harness("round-trip");
    const created = await repos.workouts.create({
      local_date: "2026-10-14",
      duration_min: 45,
      notes: "push day",
    });

    expect(created.row.user_id).toBe("user-1");
    expect(created.row.deleted_at).toBeNull();
    expect(await db.workout_sessions.get(created.row.id)).toEqual(created.row);

    const updated = await repos.workouts.update(created.row.id, {
      duration_min: 60,
      notes: "push day v2",
    });

    expect(updated.row.duration_min).toBe(60);
    expect(updated.row.notes).toBe("push day v2");
    expect(updated.row.local_date).toBe("2026-10-14");
    expect(updated.op.action).toBe("update");
    expect(updated.op.updated_at).toBe(updated.row.updated_at);
    expect(await db.workout_sessions.get(created.row.id)).toEqual(updated.row);

    const ops = await repos.outbox.listPending();
    expect(ops.map((queued) => queued.action)).toEqual(["create", "update"]);
    expect(ops.every((queued) => queued.updated_at !== "")).toBe(true);
  });

  it("listByDateRange is inclusive on both bounds and skips tombstones", async () => {
    const { repos } = harness("date-range");
    const ids = new Map<string, string>();
    for (const local_date of ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"]) {
      const created = await repos.workouts.create({ local_date });
      ids.set(local_date, created.row.id);
    }

    const window = await repos.workouts.listByDateRange("2026-10-13", "2026-10-15");
    expect(window.map((row) => row.local_date)).toEqual(["2026-10-13", "2026-10-14", "2026-10-15"]);

    const thirteen = ids.get("2026-10-13");
    expect(thirteen).toBeDefined();
    if (thirteen) {
      await repos.workouts.remove(thirteen);
    }
    const after = await repos.workouts.listByDateRange("2026-10-13", "2026-10-15");
    expect(after.map((row) => row.local_date)).toEqual(["2026-10-14", "2026-10-15"]);
  });

  it("getTree orders entries by order_index and sets by set_index", async () => {
    const { repos } = harness("tree");
    const workout = await repos.workouts.create({ local_date: "2026-10-14" });
    await repos.workouts.addEntry({
      workout_id: workout.row.id,
      exercise_id: "exercise-c",
      order_index: 2,
    });
    const first = await repos.workouts.addEntry({
      workout_id: workout.row.id,
      exercise_id: "exercise-a",
      order_index: 0,
    });
    await repos.workouts.addEntry({
      workout_id: workout.row.id,
      exercise_id: "exercise-b",
      order_index: 1,
    });
    await repos.workouts.addSet({
      exercise_entry_id: first.row.id,
      set_index: 1,
      weight_kg: 100,
      reps: 5,
    });
    await repos.workouts.addSet({
      exercise_entry_id: first.row.id,
      set_index: 0,
      weight_kg: 90,
      reps: 5,
    });

    const tree = await repos.workouts.getTree(workout.row.id);
    expect(tree).toBeDefined();
    expect(tree?.entries.map((slot) => slot.entry.order_index)).toEqual([0, 1, 2]);
    expect(tree?.entries[0]?.sets.map((set) => set.set_index)).toEqual([0, 1]);
    expect(await repos.workouts.getTree("missing-workout")).toBeUndefined();
  });

  it("listAllTrees sorts local_date desc then id desc and skips tombstones", async () => {
    const { db, repos } = harness("all-trees-order");
    const stamp = "2026-10-14T00:00:00.000Z";
    const session = (id: string, local_date: string, deleted_at: string | null = null) => ({
      id,
      user_id: "user-1",
      local_date,
      started_at: null,
      duration_min: null,
      routine_id: null,
      notes: null,
      created_at: stamp,
      updated_at: stamp,
      deleted_at,
    });
    await db.workout_sessions.bulkPut([
      session("sess-a", "2026-10-10"),
      session("sess-b", "2026-10-14"),
      session("sess-c", "2026-10-14"),
      session("sess-d", "2026-10-15", stamp),
    ]);

    const trees = await repos.workouts.listAllTrees();
    expect(trees.map((tree) => tree.session.id)).toEqual(["sess-c", "sess-b", "sess-a"]);
    expect(trees.map((tree) => tree.session.local_date)).toEqual([
      "2026-10-14",
      "2026-10-14",
      "2026-10-10",
    ]);
  });

  it("listAllTrees nests live entries by order_index and live sets by set_index", async () => {
    const { db, repos } = harness("all-trees-nested");
    const stamp = "2026-10-14T00:00:00.000Z";
    await db.workout_sessions.put({
      id: "sess-1",
      user_id: "user-1",
      local_date: "2026-10-14",
      started_at: null,
      duration_min: null,
      routine_id: null,
      notes: null,
      created_at: stamp,
      updated_at: stamp,
      deleted_at: null,
    });
    const entry = (id: string, order_index: number, deleted_at: string | null = null) => ({
      id,
      workout_id: "sess-1",
      exercise_id: `exercise-${id}`,
      order_index,
      notes: null,
      created_at: stamp,
      updated_at: stamp,
      deleted_at,
    });
    await db.exercise_entries.bulkPut([
      entry("entry-2", 1),
      entry("entry-1", 0),
      entry("entry-dead", 2, stamp),
    ]);
    const set = (
      id: string,
      exercise_entry_id: string,
      set_index: number,
      deleted_at: string | null = null,
    ) => ({
      id,
      exercise_entry_id,
      set_index,
      weight_kg: 100,
      reps: 5,
      is_warmup: false,
      e1rm_kg: 112.5,
      created_at: stamp,
      updated_at: stamp,
      deleted_at,
    });
    await db.set_entries.bulkPut([
      set("set-1", "entry-1", 1),
      set("set-0", "entry-1", 0),
      set("set-dead", "entry-1", 2, stamp),
      set("set-2", "entry-2", 0),
    ]);

    const trees = await repos.workouts.listAllTrees();
    expect(trees).toHaveLength(1);
    expect(trees[0]?.session.id).toBe("sess-1");
    expect(trees[0]?.entries.map((slot) => slot.entry.id)).toEqual(["entry-1", "entry-2"]);
    expect(trees[0]?.entries[0]?.sets.map((setRow) => setRow.id)).toEqual(["set-0", "set-1"]);
    expect(trees[0]?.entries[1]?.sets).toHaveLength(1);
  });

  it("addSet stores e1rm_kg locally but keeps it out of the set_entries payload", async () => {
    const { db, repos } = harness("set-e1rm");
    const workout = await repos.workouts.create({ local_date: "2026-10-14" });
    const entry = await repos.workouts.addEntry({
      workout_id: workout.row.id,
      exercise_id: "exercise-1",
      order_index: 0,
    });
    const { row, op } = await repos.workouts.addSet({
      exercise_entry_id: entry.row.id,
      set_index: 0,
      weight_kg: 100,
      reps: 5,
    });

    expect(row.e1rm_kg).toBe(e1rmBrzycki(100, 5));
    expect((await db.set_entries.get(row.id))?.e1rm_kg).toBe(e1rmBrzycki(100, 5));
    expect(op.payload).not.toHaveProperty("e1rm_kg");

    const queued = await db.outbox.get(op.op_id);
    expect(queued).toBeDefined();
    expect(queued?.payload).not.toHaveProperty("e1rm_kg");
    expect(queued?.payload).toMatchObject({ id: row.id, weight_kg: 100, reps: 5 });

    // A later update recomputes the local copy.
    const updated = await repos.workouts.updateSet(row.id, { reps: 8 });
    expect(updated.row.e1rm_kg).toBe(e1rmBrzycki(100, 8));
    expect(updated.op.action).toBe("update");
    expect(updated.op.payload).not.toHaveProperty("e1rm_kg");
  });

  it("remove tombstones session, entries, and sets with one delete op per row", async () => {
    const { db, repos } = harness("cascade");
    const workout = await repos.workouts.create({ local_date: "2026-10-14" });
    const entry = await repos.workouts.addEntry({
      workout_id: workout.row.id,
      exercise_id: "exercise-1",
      order_index: 0,
    });
    await repos.workouts.addSet({
      exercise_entry_id: entry.row.id,
      set_index: 0,
      weight_kg: 60,
      reps: 5,
    });
    await repos.workouts.addSet({
      exercise_entry_id: entry.row.id,
      set_index: 1,
      weight_kg: 65,
      reps: 5,
    });

    const opsBefore = await db.outbox.count();
    expect(opsBefore).toBe(4);

    const deleteOps = await repos.workouts.remove(workout.row.id);
    expect(deleteOps).toHaveLength(4);
    expect(deleteOps.map((op) => op.action)).toEqual(Array(4).fill("delete"));
    expect([...deleteOps.map((op) => op.entity)].sort()).toEqual([
      "exercise_entries",
      "set_entries",
      "set_entries",
      "workout_sessions",
    ]);

    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(opsBefore + 4);
    expect(ops.filter((op) => op.action === "delete")).toHaveLength(4);

    const session = await db.workout_sessions.get(workout.row.id);
    expect(session?.deleted_at).not.toBeNull();
    expect(session?.deleted_at).toBe(session?.updated_at);
    const entries = await db.exercise_entries.toArray();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.deleted_at).not.toBeNull();
    const sets = await db.set_entries.toArray();
    expect(sets).toHaveLength(2);
    expect(sets.every((set) => set.deleted_at !== null)).toBe(true);
  });

  it("removeEntry cascades to its sets with one delete op per row", async () => {
    const { db, repos } = harness("entry-cascade");
    const workout = await repos.workouts.create({ local_date: "2026-10-14" });
    const entry = await repos.workouts.addEntry({
      workout_id: workout.row.id,
      exercise_id: "exercise-1",
      order_index: 0,
    });
    await repos.workouts.addSet({
      exercise_entry_id: entry.row.id,
      set_index: 0,
      weight_kg: 60,
      reps: 5,
    });

    const ops = await repos.workouts.removeEntry(entry.row.id);
    expect(ops).toHaveLength(2);
    expect(ops.map((op) => op.entity).sort()).toEqual(["exercise_entries", "set_entries"]);
    expect((await db.exercise_entries.get(entry.row.id))?.deleted_at).not.toBeNull();
    expect((await db.set_entries.toArray())[0]?.deleted_at).not.toBeNull();
  });
});

describe("draft commit atomicity", () => {
  it("rolls back every table and the outbox when one set is invalid", async () => {
    const { db, repos } = harness("atomicity");
    const invalid = makeDraft();
    const goodEntry = invalid.entries[0];
    expect(goodEntry).toBeDefined();
    if (!goodEntry) {
      return;
    }
    // One valid set followed by a set that violates reps BETWEEN 1 AND 36.
    goodEntry.sets.push({
      id: crypto.randomUUID(),
      set_index: 2,
      weight_kg: 70,
      reps: 0,
      is_warmup: false,
    });
    await repos.drafts.save(invalid);

    const sessionsBefore = await db.workout_sessions.toArray();
    const entriesBefore = await db.exercise_entries.toArray();
    const setsBefore = await db.set_entries.toArray();
    const opsBefore = await db.outbox.toArray();

    await expect(repos.drafts.commit(invalid.id)).rejects.toThrow(LocalValidationError);

    expect(await db.workout_sessions.toArray()).toEqual(sessionsBefore);
    expect(await db.exercise_entries.toArray()).toEqual(entriesBefore);
    expect(await db.set_entries.toArray()).toEqual(setsBefore);
    expect(await db.outbox.toArray()).toEqual(opsBefore);

    const draft = await db.workout_drafts.get(invalid.id);
    expect(draft).toBeDefined();
    expect(draft?.entries).toHaveLength(1);
  });
});

describe("validation boundaries mirroring the SQL CHECKs", () => {
  it("accepts reps 1 and 36 and rejects 0, 37, and non-integers", () => {
    expect(() => assertValidSet({ set_index: 0, weight_kg: 100, reps: 1 })).not.toThrow();
    expect(() => assertValidSet({ set_index: 0, weight_kg: 100, reps: 36 })).not.toThrow();
    expect(() => assertValidSet({ set_index: 0, weight_kg: 100, reps: 0 })).toThrow(
      LocalValidationError,
    );
    expect(() => assertValidSet({ set_index: 0, weight_kg: 100, reps: 37 })).toThrow(
      LocalValidationError,
    );
    expect(() => assertValidSet({ set_index: 0, weight_kg: 100, reps: 5.5 })).toThrow(
      LocalValidationError,
    );
  });

  it("accepts weight_kg 0 and 1500 and rejects 1500.01 and negatives", () => {
    expect(() => assertValidSet({ set_index: 0, weight_kg: 0, reps: 5 })).not.toThrow();
    expect(() => assertValidSet({ set_index: 0, weight_kg: 1500, reps: 5 })).not.toThrow();
    expect(() => assertValidSet({ set_index: 0, weight_kg: 1500.01, reps: 5 })).toThrow(
      LocalValidationError,
    );
    expect(() => assertValidSet({ set_index: 0, weight_kg: -1, reps: 5 })).toThrow(
      LocalValidationError,
    );
  });

  it("accepts duration_min 0, 1440, and null and rejects 2000", () => {
    expect(() => assertValidWorkout({ local_date: "2026-10-14", duration_min: 0 })).not.toThrow();
    expect(() => assertValidWorkout({ local_date: "2026-10-14", duration_min: 1440 })).not.toThrow();
    expect(() => assertValidWorkout({ local_date: "2026-10-14", duration_min: null })).not.toThrow();
    expect(() => assertValidWorkout({ local_date: "2026-10-14", duration_min: 2000 })).toThrow(
      LocalValidationError,
    );
  });

  it("accepts non-negative set_index and order_index and rejects negatives", () => {
    expect(() => assertValidSet({ set_index: 0, weight_kg: 100, reps: 5 })).not.toThrow();
    expect(() => assertValidSet({ set_index: -1, weight_kg: 100, reps: 5 })).toThrow(
      LocalValidationError,
    );
    expect(() => assertValidEntry({ order_index: 0 })).not.toThrow();
    expect(() => assertValidEntry({ order_index: -1 })).toThrow(LocalValidationError);
    expect(() => assertValidEntry({ order_index: 1.5 })).toThrow(LocalValidationError);
  });

  it("accepts bare YYYY-MM-DD local dates and rejects anything else", () => {
    expect(() => assertValidWorkout({ local_date: "2026-10-14", duration_min: null })).not.toThrow();
    expect(() => assertValidWorkout({ local_date: "2026-10-14T00:00:00Z", duration_min: null })).toThrow(
      LocalValidationError,
    );
    expect(() => assertValidWorkout({ local_date: "14/10/2026", duration_min: null })).toThrow(
      LocalValidationError,
    );
  });

  it("reports issues on the error", () => {
    const error = capture(() => assertValidSet({ set_index: 0, weight_kg: 100, reps: 0 }));
    expect(error.issues.length).toBeGreaterThan(0);
    expect(error.issues.some((issue) => issue.includes("reps"))).toBe(true);
    expect(error.name).toBe("LocalValidationError");
  });
});
