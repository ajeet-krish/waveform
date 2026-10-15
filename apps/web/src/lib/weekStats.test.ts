import { describe, expect, it } from "vitest";
import type { Activity, WorkoutSession } from "@waveform/api-types";
import type { WorkoutTree } from "../db/repos/workouts";
import type { LocalRow } from "../db/types";
import { weekDays } from "./week";
import { buildWeekStats } from "./weekStats";

const STAMP = "2026-10-14T00:00:00.000Z";

function session(local_date: string, id = `sess-${local_date}`): LocalRow<WorkoutSession> {
  return {
    id,
    user_id: "user-1",
    local_date,
    started_at: null,
    duration_min: null,
    routine_id: null,
    notes: null,
    created_at: STAMP,
    updated_at: STAMP,
    deleted_at: null,
  };
}

function tree(
  local_date: string,
  sets: Array<{ weight_kg: number; reps: number; is_warmup: boolean }> = [],
): WorkoutTree {
  return {
    session: session(local_date),
    entries: [
      {
        entry: {
          id: `entry-${local_date}`,
          workout_id: `sess-${local_date}`,
          exercise_id: "ex-1",
          order_index: 0,
          notes: null,
          created_at: STAMP,
          updated_at: STAMP,
          deleted_at: null,
        },
        sets: sets.map((set, index) => ({
          id: `set-${local_date}-${index}`,
          exercise_entry_id: `entry-${local_date}`,
          set_index: index,
          weight_kg: set.weight_kg,
          reps: set.reps,
          is_warmup: set.is_warmup,
          e1rm_kg: 100,
          created_at: STAMP,
          updated_at: STAMP,
          deleted_at: null,
        })),
      },
    ],
  };
}

function activity(local_date: string, id = `act-${local_date}`): LocalRow<Activity> {
  return {
    id,
    user_id: "user-1",
    type: "cycling",
    local_date,
    started_at: null,
    duration_min: null,
    distance_km: 10,
    elevation_m: null,
    climb_grade: null,
    climb_grade_value: null,
    routes_sent: null,
    notes: null,
    created_at: STAMP,
    updated_at: STAMP,
    deleted_at: null,
  };
}

// The week of 2026-10-14 (a Wednesday) runs Mon 2026-10-12 to Sun 2026-10-18.
const WEEK = weekDays(new Date(2026, 9, 14));

describe("buildWeekStats", () => {
  it("counts sessions, sums working volume (warmups excluded), and unions active days", () => {
    const stats = buildWeekStats({
      trees: [
        tree("2026-10-13", [
          { weight_kg: 100, reps: 5, is_warmup: false },
          { weight_kg: 100, reps: 5, is_warmup: false },
          { weight_kg: 40, reps: 10, is_warmup: true },
        ]),
        tree("2026-10-14", [{ weight_kg: 60, reps: 8, is_warmup: false }]),
      ],
      activities: [activity("2026-10-15")],
      week: WEEK,
    });

    expect(stats.sessions).toBe(2);
    // (100*5) + (100*5) + (60*8) = 500 + 500 + 480 = 1480; the warmup is skipped.
    expect(stats.workingVolumeKg).toBe(1480);
    // Tue, Wed, Thu: three distinct days with a session or an activity.
    expect(stats.activeDays).toBe(3);
  });

  it("returns zeros for an empty week", () => {
    const stats = buildWeekStats({ trees: [], activities: [], week: WEEK });
    expect(stats).toEqual({ sessions: 0, workingVolumeKg: 0, activeDays: 0 });
  });

  it("skips non-finite weights and reps", () => {
    const stats = buildWeekStats({
      trees: [
        tree("2026-10-13", [
          { weight_kg: Number.NaN, reps: 5, is_warmup: false },
          { weight_kg: 100, reps: 5, is_warmup: false },
        ]),
      ],
      activities: [],
      week: WEEK,
    });
    expect(stats.workingVolumeKg).toBe(500);
  });

  it("counts a day with both a session and an activity once", () => {
    const stats = buildWeekStats({
      trees: [tree("2026-10-14")],
      activities: [activity("2026-10-14")],
      week: WEEK,
    });
    expect(stats.activeDays).toBe(1);
  });

  it("clamps activeDays to at most 7 even if rows fall outside the week", () => {
    const trees = ["2026-10-01", "2026-10-02", "2026-10-03"].map((day) => tree(day));
    const stats = buildWeekStats({ trees, activities: [], week: WEEK });
    // None of those days are in the target week, so zero days are active.
    expect(stats.activeDays).toBe(0);
    expect(stats.sessions).toBe(3);
  });
});
