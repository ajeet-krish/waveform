import { describe, expect, it } from "vitest";
import { e1rmBrzycki } from "@waveform/scoring";
import type { Exercise, ExerciseEntry, SetEntry, WorkoutSession } from "@waveform/api-types";
import type { WorkoutTree } from "../db/repos/workouts";
import type { LocalRow } from "../db/types";
import { bestE1rmByDay, filterExercises, setsForExercise } from "./exerciseStats";

function makeExercise(name: string, muscle_group: string): LocalRow<Exercise> {
  const iso = "2026-10-01T00:00:00.000Z";
  return {
    id: `id-${name}`,
    owner_id: null,
    name,
    muscle_group,
    equipment: null,
    created_at: iso,
    updated_at: iso,
    deleted_at: null,
  };
}

type SetSpec = { id: string; weight_kg: number; reps: number; is_warmup?: boolean };

function makeTree(
  id: string,
  localDate: string,
  slots: Array<{ exerciseId: string; sets: SetSpec[] }>,
): WorkoutTree {
  const iso = `${localDate}T08:00:00.000Z`;
  const session: LocalRow<WorkoutSession> = {
    id,
    user_id: "user-1",
    local_date: localDate,
    started_at: iso,
    duration_min: null,
    routine_id: null,
    notes: null,
    created_at: iso,
    updated_at: iso,
    deleted_at: null,
  };
  const entries = slots.map((slot, slotIndex) => {
    const entry: LocalRow<ExerciseEntry> = {
      id: `${id}-e${slotIndex}`,
      workout_id: id,
      exercise_id: slot.exerciseId,
      order_index: slotIndex,
      notes: null,
      created_at: iso,
      updated_at: iso,
      deleted_at: null,
    };
    const sets: LocalRow<SetEntry>[] = slot.sets.map((spec, setIndex) => ({
      id: spec.id,
      exercise_entry_id: entry.id,
      set_index: setIndex,
      weight_kg: spec.weight_kg,
      reps: spec.reps,
      is_warmup: spec.is_warmup ?? false,
      e1rm_kg: e1rmBrzycki(spec.weight_kg, spec.reps),
      created_at: iso,
      updated_at: iso,
      deleted_at: null,
    }));
    return { entry, sets };
  });
  return { session, entries };
}

describe("filterExercises", () => {
  const rows = [
    makeExercise("Back Squat", "legs"),
    makeExercise("Bench Press (Barbell)", "chest"),
    makeExercise("Bent Row", "back"),
    makeExercise("Hip Thrust", "glutes"),
  ];

  it("matches a case-insensitive substring on the name and keeps input order", () => {
    const found = filterExercises(rows, { search: "bEn" });
    expect(found.map((row) => row.name)).toEqual(["Bench Press (Barbell)", "Bent Row"]);
  });

  it("trims the search and treats empty as no search", () => {
    expect(filterExercises(rows, { search: "  row  " })).toHaveLength(1);
    expect(filterExercises(rows, { search: "" })).toHaveLength(4);
    expect(filterExercises(rows, {})).toHaveLength(4);
  });

  it("filters by muscle group exactly, case-insensitively", () => {
    expect(filterExercises(rows, { muscleGroup: "CHEST" }).map((row) => row.name)).toEqual([
      "Bench Press (Barbell)",
    ]);
    expect(filterExercises(rows, { muscleGroup: "chest", search: "bench" })).toHaveLength(1);
    expect(filterExercises(rows, { muscleGroup: "chest", search: "squat" })).toHaveLength(0);
  });
});

describe("bestE1rmByDay", () => {
  it("keeps working sets only and the best value per day", () => {
    const trees = [
      makeTree("s1", "2026-10-14", [
        {
          exerciseId: "ex-bench",
          sets: [
            { id: "w1", weight_kg: 40, reps: 8, is_warmup: true },
            { id: "b1", weight_kg: 100, reps: 5 },
            { id: "b2", weight_kg: 90, reps: 5 },
          ],
        },
        { exerciseId: "ex-other", sets: [{ id: "o1", weight_kg: 200, reps: 1 }] },
      ]),
      makeTree("s2", "2026-10-14", [
        { exerciseId: "ex-bench", sets: [{ id: "b3", weight_kg: 102.5, reps: 3 }] },
      ]),
      makeTree("s3", "2026-10-07", [
        {
          exerciseId: "ex-bench",
          sets: [
            { id: "b4", weight_kg: 0, reps: 20 },
            { id: "b5", weight_kg: 95, reps: 5 },
          ],
        },
      ]),
      makeTree("s4", "2026-10-08", [
        { exerciseId: "ex-bench", sets: [{ id: "b6", weight_kg: 30, reps: 10, is_warmup: true }] },
      ]),
    ];

    const byDay = bestE1rmByDay(trees, "ex-bench");
    expect(byDay.size).toBe(2);
    expect(byDay.get("2026-10-14")).toBe(e1rmBrzycki(100, 5));
    expect(byDay.get("2026-10-07")).toBe(e1rmBrzycki(95, 5));
    expect(byDay.has("2026-10-08")).toBe(false);
  });

  it("returns an empty map for an exercise nobody has logged", () => {
    const trees = [makeTree("s1", "2026-10-14", [{ exerciseId: "ex-bench", sets: [] }])];
    expect(bestE1rmByDay(trees, "ex-squat").size).toBe(0);
  });
});

describe("setsForExercise", () => {
  it("returns working sets chronologically and skips warmups and other exercises", () => {
    const trees = [
      makeTree("s2", "2026-10-14", [
        { exerciseId: "ex-bench", sets: [{ id: "b3", weight_kg: 102.5, reps: 3 }] },
      ]),
      makeTree("s1", "2026-10-07", [
        {
          exerciseId: "ex-bench",
          sets: [
            { id: "b1", weight_kg: 40, reps: 8, is_warmup: true },
            { id: "b2", weight_kg: 100, reps: 5 },
            { id: "b4", weight_kg: 0, reps: 15 },
          ],
        },
        { exerciseId: "ex-other", sets: [{ id: "o1", weight_kg: 999, reps: 5 }] },
      ]),
    ];

    const stats = setsForExercise(trees, "ex-bench");
    expect(stats.map((stat) => stat.id)).toEqual(["b2", "b3"]);
    expect(stats.map((stat) => stat.localDate)).toEqual(["2026-10-07", "2026-10-14"]);
    expect(stats[0]).toMatchObject({ weightKg: 100, reps: 5, e1rmKg: e1rmBrzycki(100, 5) });
  });
});
