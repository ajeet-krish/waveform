import { afterEach, describe, expect, it } from "vitest";
import { createRepos, type Repos } from "./index";
import { createWaveformDb, type WaveformDb } from "../schema";
import type { LocalRow } from "../types";
import { LocalValidationError } from "../validation";
import type { Routine, RoutineEntry } from "@waveform/api-types";

type Harness = { db: WaveformDb; repos: Repos };

const openDbs: WaveformDb[] = [];

/** Fresh database plus repos on an advancing one-second test clock. */
function harness(name: string): Harness {
  const db = createWaveformDb(`routines-${name}-${crypto.randomUUID()}`);
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

const STAMP = "2026-10-14T00:00:00.000Z";

function foreignRoutine(id = "routine-other", user_id = "other"): LocalRow<Routine> {
  return {
    id,
    user_id,
    name: "Someone Else's Routine",
    notes: null,
    created_at: STAMP,
    updated_at: STAMP,
    deleted_at: null,
  };
}

function foreignEntry(
  id = "routine-entry-other",
  routine_id = "routine-other",
): LocalRow<RoutineEntry> {
  return {
    id,
    routine_id,
    exercise_id: "exercise-1",
    order_index: 0,
    target_sets: 3,
    target_reps: 8,
    target_weight_kg: null,
    created_at: STAMP,
    updated_at: STAMP,
    deleted_at: null,
  };
}

describe("routines repo: create and read", () => {
  it("creates the routine and its entries in one transaction with one op per row", async () => {
    const { db, repos } = harness("create");
    const created = await repos.routines.create({
      name: "Push Day",
      notes: "chest and triceps",
      entries: [
        { exercise_id: "exercise-bench", target_sets: 5, target_reps: 5, target_weight_kg: 80 },
        { exercise_id: "exercise-dip", order_index: 1 },
      ],
    });

    expect(created.row.user_id).toBe("user-1");
    expect(created.row.name).toBe("Push Day");
    expect(created.row.deleted_at).toBeNull();
    expect(await db.routines.get(created.row.id)).toEqual(created.row);

    // The entry omitted fields take the schema defaults; the explicit ones stand.
    expect(created.entries).toHaveLength(2);
    const [first, second] = created.entries;
    expect(first?.row.order_index).toBe(0);
    expect(first?.row.target_sets).toBe(5);
    expect(first?.row.target_reps).toBe(5);
    expect(first?.row.target_weight_kg).toBe(80);
    expect(second?.row.order_index).toBe(1);
    expect(second?.row.target_sets).toBe(3);
    expect(second?.row.target_reps).toBe(8);
    expect(second?.row.target_weight_kg).toBeNull();

    // Everything shares one timestamp: row, entry rows, and ops in lockstep.
    expect(created.row.updated_at).toBe(created.row.created_at);
    expect(first?.row.updated_at).toBe(created.row.updated_at);
    expect(created.op.updated_at).toBe(created.row.updated_at);
    expect(first?.op.updated_at).toBe(created.row.updated_at);
    expect(second?.op.updated_at).toBe(created.row.updated_at);

    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(3);
    expect(ops.map((op) => op.entity).sort()).toEqual([
      "routine_entries",
      "routine_entries",
      "routines",
    ]);
    expect(ops.every((op) => op.action === "create")).toBe(true);
    expect(await db.routine_entries.count()).toBe(2);
  });

  it("trims the name on create", async () => {
    const { repos } = harness("trim");
    const created = await repos.routines.create({ name: "  Leg Day  " });
    expect(created.row.name).toBe("Leg Day");
  });

  it("listLive hides tombstones and sorts by name then id", async () => {
    const { repos } = harness("list-live");
    await repos.routines.create({ name: "Zulu Day" });
    await repos.routines.create({ name: "Alpha Day" });
    const mike = await repos.routines.create({ name: "Mike Day" });
    await repos.routines.softDelete(mike.row.id);

    const live = await repos.routines.listLive();
    expect(live.map((row) => row.name)).toEqual(["Alpha Day", "Zulu Day"]);
  });

  it("getWithEntries orders live entries by order_index and drops tombstones", async () => {
    const { db, repos } = harness("get-with-entries");
    const created = await repos.routines.create({
      name: "Pull Day",
      entries: [
        { exercise_id: "exercise-c", order_index: 2 },
        { exercise_id: "exercise-a", order_index: 0 },
        { exercise_id: "exercise-b", order_index: 1 },
      ],
    });
    const dead = created.entries[0];
    expect(dead).toBeDefined();
    if (dead) {
      await repos.routines.removeEntry(dead.row.id);
    }

    const tree = await repos.routines.getWithEntries(created.row.id);
    expect(tree?.routine.id).toBe(created.row.id);
    expect(tree?.entries.map((entry) => entry.exercise_id)).toEqual(["exercise-a", "exercise-b"]);

    await repos.routines.softDelete(created.row.id);
    expect(await repos.routines.getWithEntries(created.row.id)).toBeUndefined();
    expect(await repos.routines.getWithEntries("missing")).toBeUndefined();
  });
});

describe("routines repo: update and delete", () => {
  it("update patches name and notes and queues one update op", async () => {
    const { db, repos } = harness("update");
    const created = await repos.routines.create({ name: "Push Day", notes: "v1" });

    const { row, op } = await repos.routines.update(created.row.id, {
      name: "  Push Day v2 ",
      notes: null,
    });
    expect(row.id).toBe(created.row.id);
    expect(row.name).toBe("Push Day v2");
    expect(row.notes).toBeNull();
    expect(row.created_at).toBe(created.row.created_at);
    expect(row.updated_at > created.row.updated_at).toBe(true);
    expect(await db.routines.get(row.id)).toEqual(row);
    expect(op.action).toBe("update");
    expect(op.payload).toEqual(row);

    const ops = await repos.outbox.listPending();
    expect(ops.map((queued) => queued.action)).toEqual(["create", "update"]);
  });

  it("update rejects a blank name and leaves the row unchanged", async () => {
    const { db, repos } = harness("update-blank");
    const created = await repos.routines.create({ name: "Push Day" });
    await expect(repos.routines.update(created.row.id, { name: "   " })).rejects.toThrow(
      LocalValidationError,
    );
    expect((await db.routines.get(created.row.id))?.name).toBe("Push Day");
  });

  it("update on a missing routine throws", async () => {
    const { repos } = harness("update-missing");
    await expect(repos.routines.update("missing", { name: "Nope" })).rejects.toThrow(
      LocalValidationError,
    );
  });

  it("update refuses a tombstoned routine and queues nothing", async () => {
    const { db, repos } = harness("update-tombstoned");
    const created = await repos.routines.create({ name: "Push Day" });
    await repos.routines.softDelete(created.row.id);
    const opsBefore = await db.outbox.count();

    await expect(
      repos.routines.update(created.row.id, { name: "Nope" }),
    ).rejects.toThrow(LocalValidationError);
    expect(await db.outbox.count()).toBe(opsBefore);
    expect((await db.routines.get(created.row.id))?.name).toBe("Push Day");
  });

  it("softDelete tombstones the routine and its entries with one delete op per live row", async () => {
    const { db, repos } = harness("soft-delete");
    const created = await repos.routines.create({
      name: "Push Day",
      entries: [{ exercise_id: "exercise-a" }, { exercise_id: "exercise-b" }],
    });
    const dead = created.entries[0];
    if (dead) {
      await repos.routines.removeEntry(dead.row.id);
    }
    const opsBefore = await db.outbox.count();

    const ops = await repos.routines.softDelete(created.row.id);
    // The routine plus the one still-live entry (the tombstoned entry is skipped).
    expect(ops).toHaveLength(2);
    expect(ops.map((op) => op.entity).sort()).toEqual(["routine_entries", "routines"]);
    expect(ops.every((op) => op.action === "delete")).toBe(true);

    const routine = await db.routines.get(created.row.id);
    expect(routine?.deleted_at).not.toBeNull();
    expect(routine?.deleted_at).toBe(routine?.updated_at);
    const entries = await db.routine_entries.toArray();
    expect(entries.every((entry) => entry.deleted_at !== null)).toBe(true);
    expect(await db.outbox.count()).toBe(opsBefore + 2);

    // A second delete is a no-op.
    expect(await repos.routines.softDelete(created.row.id)).toHaveLength(0);
  });

  it("softDelete on a missing routine throws", async () => {
    const { repos } = harness("delete-missing");
    await expect(repos.routines.softDelete("missing")).rejects.toThrow(LocalValidationError);
  });
});

describe("routines repo: entry operations", () => {
  it("addEntry applies defaults and queues one create op", async () => {
    const { db, repos } = harness("add-entry");
    const routine = await repos.routines.create({ name: "Push Day" });
    const { row, op } = await repos.routines.addEntry({
      routine_id: routine.row.id,
      exercise_id: "exercise-1",
      order_index: 3,
      target_sets: 4,
      target_reps: 6,
      target_weight_kg: 100,
    });

    expect(row.routine_id).toBe(routine.row.id);
    expect(row.order_index).toBe(3);
    expect(row.target_sets).toBe(4);
    expect(row.target_reps).toBe(6);
    expect(row.target_weight_kg).toBe(100);
    expect(await db.routine_entries.get(row.id)).toEqual(row);
    expect(op.entity).toBe("routine_entries");
    expect(op.action).toBe("create");
  });

  it("addEntry defaults order_index after the last live entry", async () => {
    const { repos } = harness("add-entry-default-order");
    const routine = await repos.routines.create({
      name: "Push Day",
      entries: [{ exercise_id: "exercise-a" }, { exercise_id: "exercise-b" }],
    });
    const added = await repos.routines.addEntry({
      routine_id: routine.row.id,
      exercise_id: "exercise-c",
    });
    expect(added.row.order_index).toBe(2);

    // The first entry in an empty routine still starts at 0.
    const empty = await repos.routines.create({ name: "Pull Day" });
    const first = await repos.routines.addEntry({
      routine_id: empty.row.id,
      exercise_id: "exercise-d",
    });
    expect(first.row.order_index).toBe(0);
  });

  it("addEntry refuses a tombstoned routine and queues nothing", async () => {
    const { db, repos } = harness("add-entry-tombstoned");
    const routine = await repos.routines.create({ name: "Push Day" });
    await repos.routines.softDelete(routine.row.id);
    const opsBefore = await db.outbox.count();

    await expect(
      repos.routines.addEntry({ routine_id: routine.row.id, exercise_id: "exercise-1" }),
    ).rejects.toThrow(LocalValidationError);
    expect(await db.outbox.count()).toBe(opsBefore);
    expect(await db.routine_entries.count()).toBe(0);
  });

  it("addEntry rejects an out-of-range target and writes nothing", async () => {
    const { db, repos } = harness("add-entry-invalid");
    const routine = await repos.routines.create({ name: "Push Day" });
    const opsBefore = await db.outbox.count();
    await expect(
      repos.routines.addEntry({
        routine_id: routine.row.id,
        exercise_id: "exercise-1",
        target_sets: 99,
      }),
    ).rejects.toThrow(LocalValidationError);
    expect(await db.routine_entries.count()).toBe(0);
    expect(await db.outbox.count()).toBe(opsBefore);
  });

  it("updateEntry patches targets and queues one update op", async () => {
    const { db, repos } = harness("update-entry");
    const routine = await repos.routines.create({
      name: "Push Day",
      entries: [{ exercise_id: "exercise-1" }],
    });
    const entry = routine.entries[0];
    expect(entry).toBeDefined();
    if (!entry) {
      return;
    }

    const { row, op } = await repos.routines.updateEntry(entry.row.id, {
      target_sets: 5,
      target_weight_kg: 120,
    });
    expect(row.target_sets).toBe(5);
    expect(row.target_weight_kg).toBe(120);
    expect(row.target_reps).toBe(8);
    expect(row.created_at).toBe(entry.row.created_at);
    expect(await db.routine_entries.get(row.id)).toEqual(row);
    expect(op.action).toBe("update");
  });

  it("updateEntry rejects an out-of-range weight and leaves the row unchanged", async () => {
    const { db, repos } = harness("update-entry-invalid");
    const routine = await repos.routines.create({
      name: "Push Day",
      entries: [{ exercise_id: "exercise-1" }],
    });
    const entry = routine.entries[0];
    if (!entry) {
      return;
    }
    await expect(
      repos.routines.updateEntry(entry.row.id, { target_weight_kg: 0 }),
    ).rejects.toThrow(LocalValidationError);
    expect((await db.routine_entries.get(entry.row.id))?.target_weight_kg).toBeNull();
  });

  it("removeEntry tombstones the row with a delete op", async () => {
    const { db, repos } = harness("remove-entry");
    const routine = await repos.routines.create({
      name: "Push Day",
      entries: [{ exercise_id: "exercise-1" }],
    });
    const entry = routine.entries[0];
    if (!entry) {
      return;
    }

    const { row, op } = await repos.routines.removeEntry(entry.row.id);
    expect(row.deleted_at).toBe(row.updated_at);
    expect(op?.action).toBe("delete");
    expect((await db.routine_entries.get(entry.row.id))?.deleted_at).not.toBeNull();
  });

  it("removeEntry is idempotent: a second remove returns the tombstone with no new op", async () => {
    const { db, repos } = harness("remove-entry-idempotent");
    const routine = await repos.routines.create({
      name: "Push Day",
      entries: [{ exercise_id: "exercise-1" }],
    });
    const entry = routine.entries[0];
    if (!entry) {
      return;
    }
    const first = await repos.routines.removeEntry(entry.row.id);
    const opsAfterFirst = await db.outbox.count();

    const second = await repos.routines.removeEntry(entry.row.id);
    expect(second.row).toEqual(first.row);
    expect(second.op).toBeUndefined();
    expect(await db.outbox.count()).toBe(opsAfterFirst);
  });

  it("updateEntry refuses a tombstoned entry and queues nothing", async () => {
    const { db, repos } = harness("update-entry-tombstoned");
    const routine = await repos.routines.create({
      name: "Push Day",
      entries: [{ exercise_id: "exercise-1" }],
    });
    const entry = routine.entries[0];
    if (!entry) {
      return;
    }
    await repos.routines.removeEntry(entry.row.id);
    const opsBefore = await db.outbox.count();

    await expect(
      repos.routines.updateEntry(entry.row.id, { target_sets: 5 }),
    ).rejects.toThrow(LocalValidationError);
    expect(await db.outbox.count()).toBe(opsBefore);
  });

  it("reorderEntries rewrites order_index and queues one update op per entry", async () => {
    const { db, repos } = harness("reorder");
    const routine = await repos.routines.create({
      name: "Push Day",
      entries: [
        { exercise_id: "exercise-a" },
        { exercise_id: "exercise-b" },
        { exercise_id: "exercise-c" },
      ],
    });
    const ids = routine.entries.map((entry) => entry.row.id);
    const [a, b, c] = ids;
    if (!a || !b || !c) {
      return;
    }

    const mutations = await repos.routines.reorderEntries(routine.row.id, [c, a, b]);
    expect(mutations).toHaveLength(3);
    expect(mutations.every((mutation) => mutation.op.action === "update")).toBe(true);
    expect((await db.routine_entries.get(c))?.order_index).toBe(0);
    expect((await db.routine_entries.get(a))?.order_index).toBe(1);
    expect((await db.routine_entries.get(b))?.order_index).toBe(2);

    const tree = await repos.routines.getWithEntries(routine.row.id);
    expect(tree?.entries.map((entry) => entry.exercise_id)).toEqual([
      "exercise-c",
      "exercise-a",
      "exercise-b",
    ]);
  });

  it("reorderEntries refuses an entry that belongs to another routine", async () => {
    const { repos } = harness("reorder-wrong-routine");
    const first = await repos.routines.create({
      name: "Push Day",
      entries: [{ exercise_id: "exercise-a" }],
    });
    const second = await repos.routines.create({
      name: "Pull Day",
      entries: [{ exercise_id: "exercise-b" }],
    });
    const foreignId = second.entries[0]?.row.id;
    if (!foreignId) {
      return;
    }
    await expect(
      repos.routines.reorderEntries(first.row.id, [foreignId]),
    ).rejects.toThrow(LocalValidationError);
  });

  it("reorderEntries rejects a partial id list and writes nothing", async () => {
    const { db, repos } = harness("reorder-partial");
    const routine = await repos.routines.create({
      name: "Push Day",
      entries: [{ exercise_id: "exercise-a" }, { exercise_id: "exercise-b" }],
    });
    const firstId = routine.entries[0]?.row.id;
    if (!firstId) {
      return;
    }
    const opsBefore = await db.outbox.count();

    await expect(repos.routines.reorderEntries(routine.row.id, [firstId])).rejects.toThrow(
      LocalValidationError,
    );
    expect(await db.outbox.count()).toBe(opsBefore);
    // No partial rewrite: the listed entry keeps its original index.
    expect((await db.routine_entries.get(firstId))?.order_index).toBe(0);
  });

  it("reorderEntries rejects a duplicate id and writes nothing", async () => {
    const { db, repos } = harness("reorder-duplicate");
    const routine = await repos.routines.create({
      name: "Push Day",
      entries: [{ exercise_id: "exercise-a" }, { exercise_id: "exercise-b" }],
    });
    const firstId = routine.entries[0]?.row.id;
    if (!firstId) {
      return;
    }
    const opsBefore = await db.outbox.count();

    await expect(
      repos.routines.reorderEntries(routine.row.id, [firstId, firstId]),
    ).rejects.toThrow(LocalValidationError);
    expect(await db.outbox.count()).toBe(opsBefore);
  });

  it("reorderEntries rejects a tombstoned entry and writes nothing", async () => {
    const { db, repos } = harness("reorder-tombstoned");
    const routine = await repos.routines.create({
      name: "Push Day",
      entries: [{ exercise_id: "exercise-a" }, { exercise_id: "exercise-b" }],
    });
    const [first, second] = routine.entries;
    if (!first || !second) {
      return;
    }
    await repos.routines.removeEntry(first.row.id);
    const opsBefore = await db.outbox.count();

    await expect(
      repos.routines.reorderEntries(routine.row.id, [first.row.id, second.row.id]),
    ).rejects.toThrow(LocalValidationError);
    expect(await db.outbox.count()).toBe(opsBefore);
    expect((await db.routine_entries.get(second.row.id))?.order_index).toBe(1);
  });
});

describe("routines repo: transactional atomicity", () => {
  it("writes nothing when an entry is invalid", async () => {
    const { db, repos } = harness("atomic-invalid");
    await expect(
      repos.routines.create({
        name: "Push Day",
        entries: [{ exercise_id: "exercise-a" }, { exercise_id: "exercise-b", target_reps: 0 }],
      }),
    ).rejects.toThrow(LocalValidationError);

    expect(await db.routines.count()).toBe(0);
    expect(await db.routine_entries.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });

  it("rolls back the routine and entries when an outbox append fails mid-create", async () => {
    const { db, repos } = harness("atomic-outbox");
    const boom = new Error("outbox write failed");
    db.outbox.add = () => {
      throw boom;
    };

    await expect(
      repos.routines.create({ name: "Push Day", entries: [{ exercise_id: "exercise-a" }] }),
    ).rejects.toThrow("outbox write failed");

    expect(await db.routines.count()).toBe(0);
    expect(await db.routine_entries.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });
});

describe("routines repo: foreign-owner guards", () => {
  it("refuses to update or delete a routine owned by another account", async () => {
    const { db, repos } = harness("foreign-routine");
    await db.routines.put(foreignRoutine());

    await expect(repos.routines.update("routine-other", { name: "Hijacked" })).rejects.toThrow(
      LocalValidationError,
    );
    await expect(repos.routines.softDelete("routine-other")).rejects.toThrow(LocalValidationError);

    expect(await db.routines.get("routine-other")).toEqual(foreignRoutine());
    expect(await db.outbox.count()).toBe(0);
  });

  it("refuses entry mutations under a foreign routine", async () => {
    const { db, repos } = harness("foreign-entry");
    await db.routines.put(foreignRoutine());
    await db.routine_entries.put(foreignEntry());

    await expect(
      repos.routines.updateEntry("routine-entry-other", { target_reps: 10 }),
    ).rejects.toThrow(LocalValidationError);
    await expect(repos.routines.removeEntry("routine-entry-other")).rejects.toThrow(
      LocalValidationError,
    );
    await expect(
      repos.routines.addEntry({ routine_id: "routine-other", exercise_id: "exercise-1" }),
    ).rejects.toThrow(LocalValidationError);
    await expect(
      repos.routines.reorderEntries("routine-other", ["routine-entry-other"]),
    ).rejects.toThrow(LocalValidationError);

    expect(await db.routine_entries.get("routine-entry-other")).toEqual(foreignEntry());
    expect(await db.outbox.count()).toBe(0);
  });
});
