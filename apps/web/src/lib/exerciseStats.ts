/**
 * Exercise-level views for the catalog: filtering rows for a list, and
 * per-exercise stats across sessions (working sets only, so warmups and
 * bodyweight work never flatter a number).
 */

import type { Exercise } from "@waveform/api-types";
import type { WorkoutTree } from "../db/repos/workouts";
import type { LocalRow } from "../db/types";
import { e1rmBrzycki } from "@waveform/scoring";
import { isWorkingSet } from "./workoutLog";

export type ExerciseFilter = {
  /** Case-insensitive substring match on the exercise name. */
  search?: string;
  /** Exact (case-insensitive) muscle group, empty for all groups. */
  muscleGroup?: string;
};

/** Filters in place order (callers pass the list already sorted by name). */
export function filterExercises(
  rows: readonly LocalRow<Exercise>[],
  filter: ExerciseFilter,
): LocalRow<Exercise>[] {
  const search = (filter.search ?? "").trim().toLowerCase();
  const group = (filter.muscleGroup ?? "").trim().toLowerCase();
  return rows.filter((row) => {
    if (search !== "" && !row.name.toLowerCase().includes(search)) {
      return false;
    }
    if (group !== "" && row.muscle_group.toLowerCase() !== group) {
      return false;
    }
    return true;
  });
}

/**
 * Best working e1RM per calendar day for one exercise. Days without a
 * qualifying set are absent from the map; a day in two sessions keeps its
 * best set.
 */
export function bestE1rmByDay(
  trees: readonly WorkoutTree[],
  exerciseId: string,
): Map<string, number> {
  const best = new Map<string, number>();
  for (const tree of trees) {
    for (const slot of tree.entries) {
      if (slot.entry.exercise_id !== exerciseId) {
        continue;
      }
      for (const set of slot.sets) {
        if (!isWorkingSet(set)) {
          continue;
        }
        const estimate = e1rmBrzycki(set.weight_kg, set.reps);
        const current = best.get(tree.session.local_date);
        if (current === undefined || estimate > current) {
          best.set(tree.session.local_date, estimate);
        }
      }
    }
  }
  return best;
}

export type ExerciseSetStat = {
  id: string;
  localDate: string;
  weightKg: number;
  reps: number;
  e1rmKg: number;
};

/**
 * Every working set of one exercise, chronological (oldest first) so a
 * chart reads left to right through time. Warmups and weight-0 sets are
 * left out: stats describe loaded work.
 */
export function setsForExercise(
  trees: readonly WorkoutTree[],
  exerciseId: string,
): ExerciseSetStat[] {
  const stats: ExerciseSetStat[] = [];
  for (const tree of trees) {
    for (const slot of tree.entries) {
      if (slot.entry.exercise_id !== exerciseId) {
        continue;
      }
      for (const set of slot.sets) {
        if (!isWorkingSet(set)) {
          continue;
        }
        stats.push({
          id: set.id,
          localDate: tree.session.local_date,
          weightKg: set.weight_kg,
          reps: set.reps,
          e1rmKg: e1rmBrzycki(set.weight_kg, set.reps),
        });
      }
    }
  }
  stats.sort((a, b) => (a.localDate < b.localDate ? -1 : a.localDate > b.localDate ? 1 : 0));
  return stats;
}
