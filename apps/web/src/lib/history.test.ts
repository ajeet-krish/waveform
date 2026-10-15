import { describe, expect, it } from "vitest";
import { e1rmBrzycki } from "@waveform/scoring";
import type { ExerciseEntry, SetEntry, WorkoutSession } from "@waveform/api-types";
import type { WorkoutTree } from "../db/repos/workouts";
import type { LocalRow } from "../db/types";
import { groupSessionsByWeek, summarizeSession, type ExerciseNameMap } from "./history";

type SetSpec = { weight_kg: number; reps: number; is_warmup?: boolean };

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
    duration_min: 45,
    routine_id: null,
    notes: "felt strong",
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
      id: `${entry.id}-s${setIndex}`,
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

const NAMES: ExerciseNameMap = new Map([
  ["ex-bench", "Bench Press (Barbell)"],
  ["ex-squat", "Back Squat"],
]);

describe("summarizeSession", () => {
  it("flattens a tree into counts, tonnage, top e1RM, and names", () => {
    const tree = makeTree("s1", "2026-10-14", [
      {
        exerciseId: "ex-bench",
        sets: [
          { weight_kg: 40, reps: 8, is_warmup: true },
          { weight_kg: 100, reps: 5 },
          { weight_kg: 102.5, reps: 3 },
        ],
      },
      { exerciseId: "ex-squat", sets: [{ weight_kg: 0, reps: 15 }] },
      { exerciseId: "ex-unknown", sets: [{ weight_kg: 60, reps: 5 }] },
    ]);

    const summary = summarizeSession(tree, NAMES);
    expect(summary).toEqual({
      id: "s1",
      localDate: "2026-10-14",
      startedAt: "2026-10-14T08:00:00.000Z",
      durationMin: 45,
      exerciseCount: 3,
      setCount: 5,
      volumeKg: 100 * 5 + 102.5 * 3 + 60 * 5,
      topE1rmKg: e1rmBrzycki(100, 5),
      exerciseNames: ["Bench Press (Barbell)", "Back Squat", "Unknown exercise"],
      notes: "felt strong",
    });
  });

  it("reports no top e1RM when no set carries a load", () => {
    const tree = makeTree("s2", "2026-10-14", [
      { exerciseId: "ex-bench", sets: [{ weight_kg: 0, reps: 12 }] },
    ]);
    const summary = summarizeSession(tree, NAMES);
    expect(summary).not.toHaveProperty("topE1rmKg");
    expect(summary.volumeKg).toBe(0);
  });
});

describe("groupSessionsByWeek", () => {
  const today = new Date(2026, 9, 14, 20, 0);

  it("builds Monday-start sections, newest week and day first", () => {
    const trees = [
      makeTree("s-thu", "2026-10-14", [{ exerciseId: "ex-bench", sets: [{ weight_kg: 60, reps: 5 }] }]),
      makeTree("s-mon", "2026-10-12", [{ exerciseId: "ex-squat", sets: [{ weight_kg: 80, reps: 5 }] }]),
      makeTree("s-tue", "2026-10-13", [{ exerciseId: "ex-squat", sets: [{ weight_kg: 82.5, reps: 5 }] }]),
      makeTree("s-last", "2026-10-05", [{ exerciseId: "ex-bench", sets: [{ weight_kg: 55, reps: 5 }] }]),
      makeTree("s-thu-2", "2026-10-14", [{ exerciseId: "ex-squat", sets: [{ weight_kg: 90, reps: 3 }] }]),
    ];

    const weeks = groupSessionsByWeek(trees, NAMES, today);
    expect(weeks).toHaveLength(2);

    const current = weeks[0];
    expect(current).toBeDefined();
    expect(current?.weekStart).toBe("2026-10-12");
    expect(current?.weekEnd).toBe("2026-10-18");
    expect(current?.weekNumber).toBe(42);
    expect(current?.days.map((day) => day.localDate)).toEqual([
      "2026-10-14",
      "2026-10-13",
      "2026-10-12",
    ]);
    expect(current?.days.map((day) => day.heading)).toEqual([
      "Today",
      "Yesterday",
      "Monday 12 Oct",
    ]);
    expect(current?.days.map((day) => day.sessions.length)).toEqual([2, 1, 1]);

    const previous = weeks[1];
    expect(previous?.weekStart).toBe("2026-10-05");
    expect(previous?.weekEnd).toBe("2026-10-11");
    expect(previous?.weekNumber).toBe(41);
    expect(previous?.days.map((day) => day.heading)).toEqual(["Monday 5 Oct"]);
  });

  it("returns no sections when there is nothing to show", () => {
    expect(groupSessionsByWeek([], NAMES, today)).toEqual([]);
  });

  it("keeps every session of one day under a single heading", () => {
    const trees = [
      makeTree("a", "2026-10-14", [{ exerciseId: "ex-bench", sets: [] }]),
      makeTree("b", "2026-10-14", [{ exerciseId: "ex-squat", sets: [] }]),
      makeTree("c", "2026-10-14", [{ exerciseId: "ex-bench", sets: [] }]),
    ];
    const weeks = groupSessionsByWeek(trees, NAMES, today);
    const sessions = weeks[0]?.days[0]?.sessions;
    expect(sessions?.map((session) => session.id)).toEqual(["a", "b", "c"]);
    expect(weeks[0]?.days).toHaveLength(1);
  });
});
