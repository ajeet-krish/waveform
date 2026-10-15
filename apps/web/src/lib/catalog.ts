/**
 * Catalog vocabulary shared by the exercises screen and the workout
 * picker: the nine muscle groups the seed catalog defines, name lookup
 * for draft and history rows, and the form rules a custom exercise must
 * pass before it reaches the repository.
 */

import type { Exercise } from "@waveform/api-types";
import type { LocalRow } from "../db/types";
import type { ExerciseNameMap } from "./history";

/**
 * The nine muscle groups from migrations/0002_seed_catalog.sql. A custom
 * exercise must pick one of them, so every filter chip keeps working.
 */
export const MUSCLE_GROUPS = [
  "chest",
  "back",
  "legs",
  "shoulders",
  "biceps",
  "triceps",
  "core",
  "cardio",
  "other",
] as const;

export type MuscleGroup = (typeof MUSCLE_GROUPS)[number];

/** "All" plus every muscle group, in the order the filter chips render. */
export const MUSCLE_FILTERS: readonly string[] = ["all", ...MUSCLE_GROUPS];

/** Narrow a free-form string to a known muscle group. */
export function isMuscleGroup(value: string): value is MuscleGroup {
  return (MUSCLE_GROUPS as readonly string[]).includes(value);
}

/** exercise_id to display name, built from the live exercise list. */
export function exerciseNameMap(rows: readonly LocalRow<Exercise>[]): ExerciseNameMap {
  const names = new Map<string, string>();
  for (const row of rows) {
    names.set(row.id, row.name);
  }
  return names;
}

export type ExerciseFormValues = {
  /** Raw input; the name is trimmed before its length is checked. */
  name: string;
  muscle_group: string;
  /** Optional equipment; an empty string means "no equipment". */
  equipment?: string;
};

/**
 * The problems a create or edit exercise form reports, one per
 * violation; an empty array means the values are ready for the repo:
 * name trimmed, 1 to 60 characters, muscle group from the catalog list.
 */
export function exerciseFormIssues(values: ExerciseFormValues): string[] {
  const issues: string[] = [];
  const name = values.name.trim();
  if (name.length < 1) {
    issues.push("Enter an exercise name.");
  } else if (name.length > 60) {
    issues.push("Use 60 characters or fewer.");
  }
  if (!isMuscleGroup(values.muscle_group)) {
    issues.push("Choose a muscle group.");
  }
  return issues;
}

/** The trimmed, repo-ready values for one exercise form submission. */
export function exerciseFormValues(values: ExerciseFormValues): {
  name: string;
  muscle_group: MuscleGroup;
  equipment: string | null;
} {
  const equipment = (values.equipment ?? "").trim();
  return {
    name: values.name.trim(),
    muscle_group: values.muscle_group as MuscleGroup,
    equipment: equipment === "" ? null : equipment,
  };
}
