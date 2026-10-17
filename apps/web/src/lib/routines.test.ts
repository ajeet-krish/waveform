import { describe, expect, it } from "vitest";
import type { Routine, RoutineEntry } from "@waveform/api-types";
import type { LocalRow } from "../db/types";
import {
  DELETED_ROUTINE_LABEL,
  formatTargetHint,
  moveEntryOrder,
  parseTargetCountInput,
  parseTargetWeightInput,
  routineProvenance,
  routineRepsField,
  routineSetsField,
  seedDraftFromRoutine,
} from "./routines";

const NOW = new Date(2026, 9, 16, 18, 30);

function routine(overrides: Partial<LocalRow<Routine>> = {}): LocalRow<Routine> {
  return {
    id: "routine-1",
    user_id: "user-1",
    name: "Push day",
    notes: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    deleted_at: null,
    ...overrides,
  };
}

function entry(overrides: Partial<LocalRow<RoutineEntry>> = {}): LocalRow<RoutineEntry> {
  return {
    id: "entry-1",
    routine_id: "routine-1",
    exercise_id: "exercise-bench",
    order_index: 0,
    target_sets: 5,
    target_reps: 5,
    target_weight_kg: 80,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    deleted_at: null,
    ...overrides,
  };
}

describe("seedDraftFromRoutine", () => {
  it("copies entries in order_index order with targets and the routine id", () => {
    const draft = seedDraftFromRoutine(
      {
        routine: routine(),
        entries: [
          entry({
            id: "b",
            exercise_id: "exercise-dip",
            order_index: 2,
            target_sets: 3,
            target_reps: 10,
            target_weight_kg: null,
          }),
          entry({
            id: "a",
            exercise_id: "exercise-bench",
            order_index: 1,
            target_sets: 5,
            target_reps: 5,
            target_weight_kg: 80,
          }),
        ],
      },
      NOW,
    );

    expect(draft.routine_id).toBe("routine-1");
    expect(draft.local_date).toBe("2026-10-16");
    expect(draft.started_at).toBe(NOW.toISOString());
    expect(draft.updated_at).toBe(NOW.toISOString());
    expect(draft.duration_min).toBeNull();
    expect(draft.notes).toBeNull();
    expect(draft.entries.map((row) => row.exercise_id)).toEqual([
      "exercise-bench",
      "exercise-dip",
    ]);
    expect(draft.entries.map((row) => row.order_index)).toEqual([0, 1]);
    expect(draft.entries[0]?.target).toEqual({ sets: 5, reps: 5, weight_kg: 80 });
    expect(draft.entries[1]?.target).toEqual({ sets: 3, reps: 10, weight_kg: null });
    // A target is a plan, not a performed set.
    expect(draft.entries.every((row) => row.sets.length === 0)).toBe(true);
    // Ids are pre-generated so the commit path can reuse them.
    expect(draft.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(draft.entries.map((row) => row.id)).size).toBe(2);
  });

  it("seeds an empty draft for a routine with no entries", () => {
    const draft = seedDraftFromRoutine({ routine: routine(), entries: [] }, NOW);
    expect(draft.entries).toEqual([]);
    expect(draft.routine_id).toBe("routine-1");
  });
});

describe("routineProvenance", () => {
  it("names the routine while it lives", () => {
    expect(routineProvenance("routine-1", routine())).toBe("Push day");
  });

  it("falls back to the deleted label for a tombstoned or missing routine", () => {
    expect(routineProvenance("routine-1", routine({ deleted_at: "2026-10-02T00:00:00.000Z" }))).toBe(
      DELETED_ROUTINE_LABEL,
    );
    expect(routineProvenance("routine-1", undefined)).toBe(DELETED_ROUTINE_LABEL);
    expect(routineProvenance("routine-1", null)).toBe(DELETED_ROUTINE_LABEL);
    expect(DELETED_ROUTINE_LABEL).toBe("Deleted routine");
  });

  it("shows nothing for a session that never carried a routine", () => {
    expect(routineProvenance(null, undefined)).toBeNull();
    expect(routineProvenance(null, routine())).toBeNull();
  });
});

describe("formatTargetHint", () => {
  it("reads the target in the display unit", () => {
    expect(formatTargetHint({ sets: 3, reps: 8, weight_kg: 80 }, "kg")).toBe(
      "3 sets of 8 reps at 80 kg",
    );
    expect(formatTargetHint({ sets: 1, reps: 1, weight_kg: 100 }, "kg")).toBe(
      "1 set of 1 rep at 100 kg",
    );
    expect(formatTargetHint({ sets: 5, reps: 5, weight_kg: null }, "kg")).toBe("5 sets of 5 reps");
  });

  it("converts stored kg to lb for display", () => {
    expect(formatTargetHint({ sets: 3, reps: 8, weight_kg: 100 }, "lb")).toBe(
      "3 sets of 8 reps at 220.5 lb",
    );
  });
});

describe("parseTargetWeightInput", () => {
  it("treats an empty box as no target", () => {
    expect(parseTargetWeightInput("", "kg")).toEqual({ ok: true, weight_kg: null });
    expect(parseTargetWeightInput("   ", "kg")).toEqual({ ok: true, weight_kg: null });
  });

  it("converts a display-unit weight to stored kg", () => {
    expect(parseTargetWeightInput("80", "kg")).toEqual({ ok: true, weight_kg: 80 });
    // toKg rounds lb to exactly two decimals: 220 lb is 99.79 kg.
    expect(parseTargetWeightInput("220", "lb")).toEqual({ ok: true, weight_kg: 99.79 });
  });

  it("accepts the max and rejects zero, over-max, and non-numbers", () => {
    expect(parseTargetWeightInput("1500", "kg")).toEqual({ ok: true, weight_kg: 1500 });
    expect(parseTargetWeightInput("0", "kg").ok).toBe(false);
    expect(parseTargetWeightInput("1501", "kg").ok).toBe(false);
    expect(parseTargetWeightInput("heavy", "kg").ok).toBe(false);
    // 0.01 lb rounds to 0 kg, below the strictly-positive minimum.
    expect(parseTargetWeightInput("0.01", "lb").ok).toBe(false);
  });
});

describe("parseTargetCountInput", () => {
  it("accepts counts inside ROUTINE_RULES and rejects the rest", () => {
    expect(parseTargetCountInput("5", routineSetsField)).toEqual({ ok: true, value: 5 });
    expect(parseTargetCountInput("0", routineSetsField).ok).toBe(false);
    expect(parseTargetCountInput("21", routineSetsField).ok).toBe(false);
    expect(parseTargetCountInput("4.5", routineRepsField).ok).toBe(false);
    expect(parseTargetCountInput("", routineRepsField).ok).toBe(false);
  });
});

describe("moveEntryOrder", () => {
  const ids = ["a", "b", "c"];

  it("swaps the entry with its neighbour in each direction", () => {
    expect(moveEntryOrder(ids, 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveEntryOrder(ids, 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveEntryOrder(ids, 1, -1)).toEqual(["b", "a", "c"]);
  });

  it("returns an exact permutation and never mutates its input", () => {
    const next = moveEntryOrder(ids, 0, 1);
    expect(next).not.toBeNull();
    expect([...(next ?? [])].sort()).toEqual([...ids].sort());
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("returns null when the move would fall off either end", () => {
    expect(moveEntryOrder(ids, 0, -1)).toBeNull();
    expect(moveEntryOrder(ids, 2, 1)).toBeNull();
    expect(moveEntryOrder(ids, -1, 1)).toBeNull();
    expect(moveEntryOrder(ids, 3, -1)).toBeNull();
    expect(moveEntryOrder([], 0, 1)).toBeNull();
  });
});
