/**
 * Per-exercise set history across sessions: every logged set, warmups
 * included, for the exercise history table.
 *
 * Rows come back newest day first (and newest session first inside a
 * day), which is how a log reads: what you did most recently is what
 * you see first. Tombstoned rows are skipped even if a caller hands
 * them over, so a deleted session never resurfaces here.
 */

import type { WorkoutTree } from "../db/repos/workouts";

export type ExerciseSetRow = {
  id: string;
  /** Device-local day the set was logged on, "YYYY-MM-DD". */
  localDate: string;
  startedAt: string | null;
  weightKg: number;
  reps: number;
  isWarmup: boolean;
  /** Stored Brzycki estimate (set_entries.e1rm_kg), never recomputed here. */
  e1rmKg: number;
};

export function exerciseSetRows(
  trees: readonly WorkoutTree[],
  exerciseId: string,
): ExerciseSetRow[] {
  const rows: ExerciseSetRow[] = [];
  for (const tree of trees) {
    if (tree.session.deleted_at !== null) {
      continue;
    }
    for (const slot of tree.entries) {
      if (slot.entry.exercise_id !== exerciseId || slot.entry.deleted_at !== null) {
        continue;
      }
      for (const set of slot.sets) {
        if (set.deleted_at !== null) {
          continue;
        }
        rows.push({
          id: set.id,
          localDate: tree.session.local_date,
          startedAt: tree.session.started_at,
          weightKg: set.weight_kg,
          reps: set.reps,
          isWarmup: set.is_warmup,
          e1rmKg: set.e1rm_kg,
        });
      }
    }
  }
  rows.sort((a, b) => {
    if (a.localDate !== b.localDate) {
      return a.localDate < b.localDate ? 1 : -1;
    }
    const aStart = a.startedAt ?? "";
    const bStart = b.startedAt ?? "";
    if (aStart !== bStart) {
      return aStart < bStart ? 1 : -1;
    }
    // Same session: the stable sort keeps entry order, then set order.
    return 0;
  });
  return rows;
}
