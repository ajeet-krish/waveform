/**
 * Import summary display: one row per store an applied import touched,
 * pairing the written count with the backup rows it skipped. Skipped
 * means "the local copy stayed": a merge leaves a row alone when it is
 * the same age or newer, and a replace writes everything the file holds.
 */

import type { WaveformBackupV2 } from "./backup";
import type { ImportStoreCounts, ImportSummary } from "./backupImport";

/** One display row: a store's written count beside its skipped count. */
export type ImportSummaryRow = {
  key: keyof ImportStoreCounts;
  label: string;
  written: number;
  skipped: number;
};

const STORE_LABELS: ReadonlyArray<{ key: keyof ImportStoreCounts; label: string }> = [
  { key: "exercises", label: "Exercises" },
  { key: "workout_sessions", label: "Workout sessions" },
  { key: "exercise_entries", label: "Exercise entries" },
  { key: "set_entries", label: "Sets" },
  { key: "activities", label: "Activities" },
  { key: "body_stats", label: "Body stats" },
  { key: "climb_sends", label: "Climb sends" },
];

/**
 * One row per store the file had something to say about. Stores with
 * nothing written and nothing skipped drop out, so the summary reads as
 * what happened instead of a table of zeros. The clamp keeps a defensive
 * caller (a summary that over-reports) from showing a negative skip.
 */
export function importSummaryRows(
  backup: WaveformBackupV2,
  summary: ImportSummary,
): ImportSummaryRow[] {
  const rows: ImportSummaryRow[] = [];
  for (const { key, label } of STORE_LABELS) {
    const written = summary.stores[key];
    const skipped = Math.max(0, backup[key].length - written);
    if (written === 0 && skipped === 0) {
      continue;
    }
    rows.push({ key, label, written, skipped });
  }
  return rows;
}
