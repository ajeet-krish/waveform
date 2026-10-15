import { describe, expect, it } from "vitest";
import { e1rmBrzycki } from "@waveform/scoring";
import type { WorkoutDraft } from "../db/types";
import {
  addExerciseToDraft,
  addSetToDraft,
  bestE1rm,
  computeDurationMin,
  createEmptyDraft,
  draftTotals,
  isWorkingSet,
  removeExerciseFromDraft,
  removeSetFromDraft,
  updateSetInDraft,
} from "./workoutLog";

const NOW = new Date(2026, 9, 14, 18, 30);

/** A ready-made draft with one exercise and two working sets. */
function baseDraft(): WorkoutDraft {
  const draft = createEmptyDraft(NOW);
  const withExercise = addExerciseToDraft(draft, "exercise-1");
  const first = withExercise.entries[0];
  if (!first) {
    throw new Error("expected an entry");
  }
  let next = addSetToDraft(withExercise, first.id, { weight_kg: 60, reps: 5 });
  next = addSetToDraft(next, first.id, { weight_kg: 65, reps: 5 });
  return next;
}

describe("createEmptyDraft", () => {
  it("starts a fresh, timestamped draft on the device-local day", () => {
    const draft = createEmptyDraft(NOW);
    expect(draft.local_date).toBe("2026-10-14");
    expect(draft.started_at).toBe(NOW.toISOString());
    expect(draft.updated_at).toBe(NOW.toISOString());
    expect(draft.entries).toEqual([]);
    expect(draft.duration_min).toBeNull();
    expect(draft.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("draft reducers", () => {
  it("appends exercises with sequential order_index and pre-generated ids", () => {
    const draft = addExerciseToDraft(addExerciseToDraft(createEmptyDraft(NOW), "a"), "b");
    expect(draft.entries.map((entry) => entry.exercise_id)).toEqual(["a", "b"]);
    expect(draft.entries.map((entry) => entry.order_index)).toEqual([0, 1]);
    const ids = draft.entries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id.length === 36)).toBe(true);
  });

  it("never mutates the input draft", () => {
    const draft = baseDraft();
    const snapshot = JSON.stringify(draft);
    const entry = draft.entries[0];
    expect(entry).toBeDefined();
    if (!entry) {
      return;
    }

    const grown = addSetToDraft(draft, entry.id, { weight_kg: 70, reps: 3 });
    expect(JSON.stringify(draft)).toBe(snapshot);
    expect(grown).not.toBe(draft);

    const renamed = removeExerciseFromDraft(draft, entry.id);
    expect(JSON.stringify(draft)).toBe(snapshot);
    expect(renamed.entries).toHaveLength(0);
    expect(draft.entries).toHaveLength(1);
  });

  it("adds sets to one slot only and ignores unknown ids", () => {
    const draft = baseDraft();
    const entry = draft.entries[0];
    expect(entry?.sets).toHaveLength(2);

    const other = addExerciseToDraft(draft, "exercise-2");
    const second = other.entries[1];
    expect(second).toBeDefined();
    if (!entry || !second) {
      return;
    }

    const missing = addSetToDraft(draft, "no-such-entry", { weight_kg: 10, reps: 10 });
    expect(missing).toBe(draft);

    const added = addSetToDraft(other, second.id, { weight_kg: 40, reps: 8, is_warmup: true });
    expect(added.entries[1]?.sets).toHaveLength(1);
    expect(added.entries[0]?.sets).toHaveLength(2);
    expect(added.entries[1]?.sets[0]?.set_index).toBe(0);
    expect(added.entries[1]?.sets[0]?.is_warmup).toBe(true);
  });

  it("patches a set in place and leaves unknown ids alone", () => {
    const draft = baseDraft();
    const set = draft.entries[0]?.sets[1];
    expect(set).toBeDefined();
    if (!set) {
      return;
    }

    expect(updateSetInDraft(draft, "no-such-set", { reps: 8 })).toBe(draft);

    const patched = updateSetInDraft(draft, set.id, { weight_kg: 70, reps: 8, is_warmup: true });
    const next = patched.entries[0]?.sets[1];
    expect(next).toMatchObject({ weight_kg: 70, reps: 8, is_warmup: true, id: set.id });
    expect(patched.entries[0]?.sets[0]).toBe(draft.entries[0]?.sets[0]);
  });

  it("removes a set and renumbers the survivors from zero", () => {
    const draft = baseDraft();
    const first = draft.entries[0]?.sets[0];
    expect(first).toBeDefined();
    if (!first) {
      return;
    }

    expect(removeSetFromDraft(draft, "no-such-set")).toBe(draft);

    const trimmed = removeSetFromDraft(draft, first.id);
    expect(trimmed.entries[0]?.sets.map((set) => set.set_index)).toEqual([0]);
    expect(trimmed.entries[0]?.sets.map((set) => set.weight_kg)).toEqual([65]);
    expect(draft.entries[0]?.sets).toHaveLength(2);
  });

  it("removes an exercise and renumbers the survivors from zero", () => {
    const draft = addExerciseToDraft(addExerciseToDraft(createEmptyDraft(NOW), "a"), "b");
    const first = draft.entries[0];
    expect(first).toBeDefined();
    if (!first) {
      return;
    }

    const trimmed = removeExerciseFromDraft(draft, first.id);
    expect(trimmed.entries.map((entry) => entry.exercise_id)).toEqual(["b"]);
    expect(trimmed.entries.map((entry) => entry.order_index)).toEqual([0]);
    expect(draft.entries).toHaveLength(2);
  });
});

describe("bestE1rm", () => {
  it("uses working sets only: no warmups, no bodyweight-only sets", () => {
    expect(isWorkingSet({ weight_kg: 60, reps: 5, is_warmup: false })).toBe(true);
    expect(isWorkingSet({ weight_kg: 60, reps: 5, is_warmup: true })).toBe(false);
    expect(isWorkingSet({ weight_kg: 0, reps: 12, is_warmup: false })).toBe(false);

    const best = bestE1rm([
      { weight_kg: 40, reps: 8, is_warmup: true },
      { weight_kg: 0, reps: 15, is_warmup: false },
      { weight_kg: 60, reps: 5, is_warmup: false },
      { weight_kg: 70, reps: 3, is_warmup: false },
    ]);
    expect(best).toBe(e1rmBrzycki(70, 3));
  });

  it("returns undefined when nothing qualifies", () => {
    expect(bestE1rm([])).toBeUndefined();
    expect(bestE1rm([{ weight_kg: 20, reps: 10, is_warmup: true }])).toBeUndefined();
    expect(bestE1rm([{ weight_kg: 0, reps: 10, is_warmup: false }])).toBeUndefined();
  });
});

describe("draftTotals", () => {
  it("counts every set but only weighs working sets into volume and top e1RM", () => {
    const draft = createEmptyDraft(NOW);
    let next = addExerciseToDraft(draft, "exercise-1");
    const entry = next.entries[0];
    expect(entry).toBeDefined();
    if (!entry) {
      return;
    }
    next = addSetToDraft(next, entry.id, { weight_kg: 20, reps: 10, is_warmup: true });
    next = addSetToDraft(next, entry.id, { weight_kg: 60, reps: 5 });
    next = addSetToDraft(next, entry.id, { weight_kg: 65, reps: 5 });
    next = addSetToDraft(next, entry.id, { weight_kg: 0, reps: 15 });

    expect(draftTotals(next)).toEqual({
      sets: 4,
      volumeKg: 625,
      topE1rmKg: e1rmBrzycki(65, 5),
    });
  });

  it("reports no top e1RM when no set carries a load", () => {
    const totals = draftTotals(createEmptyDraft(NOW));
    expect(totals).toEqual({ sets: 0, volumeKg: 0 });
    expect(totals).not.toHaveProperty("topE1rmKg");
  });
});

describe("computeDurationMin", () => {
  it("rounds to whole minutes and returns null when an endpoint is missing", () => {
    expect(computeDurationMin("2026-10-14T10:00:00.000Z", "2026-10-14T10:45:20.000Z")).toBe(45);
    expect(computeDurationMin("2026-10-14T10:00:00.000Z", "2026-10-14T10:00:29.000Z")).toBe(0);
    expect(computeDurationMin(null, "2026-10-14T10:00:00.000Z")).toBeNull();
    expect(computeDurationMin("2026-10-14T10:00:00.000Z", null)).toBeNull();
    expect(computeDurationMin("nonsense", "2026-10-14T10:00:00.000Z")).toBeNull();
  });

  it("clamps inside 0..1440 like the SQL CHECK", () => {
    expect(computeDurationMin("2026-10-14T10:00:00.000Z", "2026-10-14T09:00:00.000Z")).toBe(0);
    expect(computeDurationMin("2026-10-14T00:00:00.000Z", "2026-10-15T12:00:00.000Z")).toBe(1440);
    expect(computeDurationMin("2026-10-14T00:00:00.000Z", "2026-10-14T01:00:00.000Z")).toBe(60);
  });
});
