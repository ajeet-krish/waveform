/**
 * Local backup: the whole device log as one portable JSON file.
 *
 * Raw rows only, tombstones included: a backup is a record of what this
 * device holds, deletions included, so a restore sees the same truth the
 * sync outbox would push. Phase 1 entities only (profile plus the three
 * workout tables and the catalog); the schema_version lets a future
 * importer tell v1 from whatever comes next.
 */

import type { Exercise, ExerciseEntry, SetEntry, WorkoutSession } from "@waveform/api-types";
import type { WaveformDb } from "../db/schema";
import type { LocalProfile, LocalRow } from "../db/types";
import { localDateString, parseLocalDate } from "./format";

export type WaveformBackupV1 = {
  format: "waveform-backup";
  version: 1;
  exported_at: string;
  app: {
    name: "waveform";
    schema_version: 1;
  };
  profile: LocalProfile | null;
  exercises: LocalRow<Exercise>[];
  workout_sessions: LocalRow<WorkoutSession>[];
  exercise_entries: LocalRow<ExerciseEntry>[];
  set_entries: LocalRow<SetEntry>[];
};

/** Reads every phase 1 store as it stands, tombstones and all. */
export async function collectBackup(db: WaveformDb): Promise<WaveformBackupV1> {
  const profiles = await db.local_profile.toArray();
  return {
    format: "waveform-backup",
    version: 1,
    exported_at: new Date().toISOString(),
    app: { name: "waveform", schema_version: 1 },
    profile: profiles[0] ?? null,
    exercises: await db.exercises.toArray(),
    workout_sessions: await db.workout_sessions.toArray(),
    exercise_entries: await db.exercise_entries.toArray(),
    set_entries: await db.set_entries.toArray(),
  };
}

/** Pretty JSON with a two-space indent, newline-terminated. */
export function serializeBackup(backup: WaveformBackupV1): string {
  return `${JSON.stringify(backup, null, 2)}\n`;
}

/** `waveform-backup-YYYY-MM-DD.json` for a calendar day (string or Date). */
export function backupFileName(day: string | Date): string {
  const date = typeof day === "string" ? parseLocalDate(day) : day;
  return `waveform-backup-${localDateString(date)}.json`;
}

/**
 * Saves the backup through the browser's download path: a Blob and an
 * object URL, one anchor click, then the URL is revoked. No network hop.
 */
export function downloadBackup(backup: WaveformBackupV1): void {
  const blob = new Blob([serializeBackup(backup)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = backupFileName(new Date(backup.exported_at));
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
