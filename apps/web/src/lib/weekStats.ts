/**
 * Week stats: the three headline numbers a weekly dashboard strip
 * shows - sessions, working volume, and active days.
 *
 * Everything here is computed from already-loaded live rows (the workout
 * repo's trees and the activity repo's list); the week grid comes from
 * week.ts so the day columns and the active-day count agree.
 */

import type { Activity } from "@waveform/api-types";
import type { WorkoutTree } from "../db/repos/workouts";
import type { LocalRow } from "../db/types";
import type { WeekDay } from "./week";

export type WeekStatsInput = {
  /** Live workout trees, already filtered to the week by the caller. */
  trees: readonly WorkoutTree[];
  /** Live activities, already filtered to the week by the caller. */
  activities: readonly LocalRow<Activity>[];
  /** The seven Monday-first days of the target week (from weekDays()). */
  week: readonly WeekDay[];
};

export type WeekStats = {
  /** Number of live workout sessions in the week. */
  sessions: number;
  /** Sum of weight_kg * reps over non-warmup, live sets only. */
  workingVolumeKg: number;
  /** Distinct week days with a live session OR a live activity, 0..7. */
  activeDays: number;
};

/**
 * Builds the week's headline stats. `workingVolumeKg` counts only
 * working sets: warmups and non-finite weights or reps are skipped, and
 * every set that survives contributes weight * reps. `activeDays` unions
 * the local_dates of live sessions and live activities against the
 * week's day list and clamps to 0..7 so a stray out-of-week row can
 * never report more days than the week holds.
 */
export function buildWeekStats(input: WeekStatsInput): WeekStats {
  let sessions = 0;
  let workingVolumeKg = 0;

  for (const tree of input.trees) {
    sessions += 1;
    for (const slot of tree.entries) {
      for (const set of slot.sets) {
        if (set.is_warmup) {
          continue;
        }
        if (!Number.isFinite(set.weight_kg) || !Number.isFinite(set.reps)) {
          continue;
        }
        workingVolumeKg += set.weight_kg * set.reps;
      }
    }
  }

  const weekDays = new Set(input.week.map((day) => day.iso));
  const activeDates = new Set<string>();
  for (const tree of input.trees) {
    activeDates.add(tree.session.local_date);
  }
  for (const activity of input.activities) {
    activeDates.add(activity.local_date);
  }
  let activeDays = 0;
  for (const day of weekDays) {
    if (activeDates.has(day)) {
      activeDays += 1;
    }
  }
  activeDays = Math.min(7, Math.max(0, activeDays));

  return { sessions, workingVolumeKg, activeDays };
}
