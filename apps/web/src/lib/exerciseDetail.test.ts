import { describe, expect, it } from "vitest";
import { e1rmBrzycki } from "@waveform/scoring";
import type { ExerciseEntry, SetEntry, WorkoutSession } from "@waveform/api-types";
import type { WorkoutTree } from "../db/repos/workouts";
import type { LocalRow } from "../db/types";
import { exerciseSetRows } from "./exerciseDetail";

type SetSpec = {
  weight_kg: number;
  reps: number;
  is_warmup?: boolean;
  deleted_at?: string | null;
};

function makeTree(
  id: string,
  localDate: string,
  slots: Array<{ exerciseId: string; sets: SetSpec[]; deletedAt?: string | null }>,
  options: { startedAt?: string; deletedAt?: string | null } = {},
): WorkoutTree {
  const startedAt = options.startedAt ?? `${localDate}T08:00:00.000Z`;
  const session: LocalRow<WorkoutSession> = {
    id,
    user_id: "user-1",
    local_date: localDate,
    started_at: startedAt,
    duration_min: 45,
    routine_id: null,
    notes: null,
    created_at: startedAt,
    updated_at: startedAt,
    deleted_at: options.deletedAt ?? null,
  };
  const entries = slots.map((slot, slotIndex) => {
    const entry: LocalRow<ExerciseEntry> = {
      id: `${id}-e${slotIndex}`,
      workout_id: id,
      exercise_id: slot.exerciseId,
      order_index: slotIndex,
      notes: null,
      created_at: startedAt,
      updated_at: startedAt,
      deleted_at: slot.deletedAt ?? null,
    };
    const sets: LocalRow<SetEntry>[] = slot.sets.map((spec, setIndex) => ({
      id: `${entry.id}-s${setIndex}`,
      exercise_entry_id: entry.id,
      set_index: setIndex,
      weight_kg: spec.weight_kg,
      reps: spec.reps,
      is_warmup: spec.is_warmup ?? false,
      e1rm_kg: e1rmBrzycki(spec.weight_kg, spec.reps),
      created_at: startedAt,
      updated_at: startedAt,
      deleted_at: spec.deleted_at ?? null,
    }));
    return { entry, sets };
  });
  return { session, entries };
}

describe("exerciseSetRows", () => {
  it("keeps warmups and working sets for one exercise, newest day first", () => {
    const older = makeTree("s1", "2026-10-08", [
      { exerciseId: "ex-bench", sets: [{ weight_kg: 60, reps: 5, is_warmup: true }, { weight_kg: 100, reps: 5 }] },
      { exerciseId: "ex-squat", sets: [{ weight_kg: 80, reps: 5 }] },
    ]);
    const newer = makeTree("s2", "2026-10-14", [
      { exerciseId: "ex-bench", sets: [{ weight_kg: 102.5, reps: 3 }] },
    ]);

    const rows = exerciseSetRows([newer, older], "ex-bench");
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.id)).toEqual(["s2-e0-s0", "s1-e0-s0", "s1-e0-s1"]);
    expect(rows.map((row) => row.isWarmup)).toEqual([false, true, false]);
    expect(rows[0]).toEqual({
      id: "s2-e0-s0",
      localDate: "2026-10-14",
      startedAt: "2026-10-14T08:00:00.000Z",
      weightKg: 102.5,
      reps: 3,
      isWarmup: false,
      e1rmKg: e1rmBrzycki(102.5, 3),
    });
  });

  it("ignores other exercises entirely", () => {
    const tree = makeTree("s1", "2026-10-14", [
      { exerciseId: "ex-squat", sets: [{ weight_kg: 80, reps: 5 }] },
    ]);
    expect(exerciseSetRows([tree], "ex-bench")).toEqual([]);
  });

  it("puts the newest session first when two sessions share a day", () => {
    const early = makeTree("s-early", "2026-10-14", [
      { exerciseId: "ex-bench", sets: [{ weight_kg: 60, reps: 5 }] },
    ], { startedAt: "2026-10-14T07:00:00.000Z" });
    const late = makeTree("s-late", "2026-10-14", [
      { exerciseId: "ex-bench", sets: [{ weight_kg: 65, reps: 5 }] },
    ], { startedAt: "2026-10-14T18:00:00.000Z" });

    const rows = exerciseSetRows([late, early], "ex-bench");
    expect(rows.map((row) => row.id)).toEqual(["s-late-e0-s0", "s-early-e0-s0"]);
  });

  it("skips tombstoned sessions, entries, and sets", () => {
    const gone = makeTree("s1", "2026-10-14", [
      { exerciseId: "ex-bench", sets: [{ weight_kg: 100, reps: 5 }] },
    ], { deletedAt: "2026-10-15T00:00:00.000Z" });
    const entryGone = makeTree("s2", "2026-10-13", [
      {
        exerciseId: "ex-bench",
        sets: [{ weight_kg: 100, reps: 5 }],
        deletedAt: "2026-10-15T00:00:00.000Z",
      },
    ]);
    const setGone = makeTree("s3", "2026-10-12", [
      {
        exerciseId: "ex-bench",
        sets: [
          { weight_kg: 100, reps: 5, deleted_at: "2026-10-15T00:00:00.000Z" },
          { weight_kg: 95, reps: 5 },
        ],
      },
    ]);

    const rows = exerciseSetRows([gone, entryGone, setGone], "ex-bench");
    expect(rows.map((row) => row.id)).toEqual(["s3-e0-s1"]);
  });
});
