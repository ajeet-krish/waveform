import { describe, expect, it } from "vitest";
import type { WaveformBackupV2 } from "./backup";
import type { ImportSummary } from "./backupImport";
import { importSummaryRows } from "./importSummary";

const STAMP = "2026-10-14T00:00:00.000Z";

/** Placeholder rows; the helper only ever counts a store's length. */
function rows<T>(count: number): T[] {
  return Array.from({ length: count }, () => ({} as object)) as unknown as T[];
}

function backupOf(counts: {
  exercises?: number;
  workout_sessions?: number;
  exercise_entries?: number;
  set_entries?: number;
  activities?: number;
  body_stats?: number;
  routines?: number;
  routine_entries?: number;
  climb_sends?: number;
}): WaveformBackupV2 {
  return {
    format: "waveform-backup",
    version: 2,
    exported_at: STAMP,
    app: { name: "waveform", schema_version: 2 },
    profile: null,
    exercises: rows(counts.exercises ?? 0),
    workout_sessions: rows(counts.workout_sessions ?? 0),
    exercise_entries: rows(counts.exercise_entries ?? 0),
    set_entries: rows(counts.set_entries ?? 0),
    activities: rows(counts.activities ?? 0),
    body_stats: rows(counts.body_stats ?? 0),
    routines: rows(counts.routines ?? 0),
    routine_entries: rows(counts.routine_entries ?? 0),
    climb_sends: rows(counts.climb_sends ?? 0),
  };
}

function summaryOf(
  stores: Partial<ImportSummary["stores"]>,
  mode: ImportSummary["mode"] = "merge",
): ImportSummary {
  return {
    mode,
    stores: {
      exercises: 0,
      workout_sessions: 0,
      exercise_entries: 0,
      set_entries: 0,
      activities: 0,
      body_stats: 0,
      routines: 0,
      routine_entries: 0,
      climb_sends: 0,
      ...stores,
    },
    profileRestored: false,
    opsQueued: 0,
  };
}

describe("importSummaryRows", () => {
  it("pairs a merge's written counts with the rows it skipped", () => {
    const backup = backupOf({ set_entries: 3, activities: 2 });
    const summary = summaryOf({ set_entries: 1 });
    expect(importSummaryRows(backup, summary)).toEqual([
      { key: "set_entries", label: "Sets", written: 1, skipped: 2 },
      { key: "activities", label: "Activities", written: 0, skipped: 2 },
    ]);
  });

  it("reports a replace as all written, nothing skipped", () => {
    const backup = backupOf({ exercises: 5, workout_sessions: 1, climb_sends: 2 });
    const summary = summaryOf(
      { exercises: 5, workout_sessions: 1, climb_sends: 2 },
      "replace",
    );
    expect(importSummaryRows(backup, summary)).toEqual([
      { key: "exercises", label: "Exercises", written: 5, skipped: 0 },
      { key: "workout_sessions", label: "Workout sessions", written: 1, skipped: 0 },
      { key: "climb_sends", label: "Climb sends", written: 2, skipped: 0 },
    ]);
  });

  it("drops stores where nothing was written and nothing was skipped", () => {
    const backup = backupOf({ body_stats: 1 });
    expect(importSummaryRows(backup, summaryOf({}))).toEqual([
      { key: "body_stats", label: "Body stats", written: 0, skipped: 1 },
    ]);
    expect(importSummaryRows(backupOf({}), summaryOf({}))).toEqual([]);
  });

  it("never reports a negative skip when a summary over-reports", () => {
    const backup = backupOf({ exercises: 1 });
    expect(importSummaryRows(backup, summaryOf({ exercises: 4 }))).toEqual([
      { key: "exercises", label: "Exercises", written: 4, skipped: 0 },
    ]);
  });
});
