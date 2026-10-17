/**
 * Routine view models: the provenance label a finished session shows, the
 * draft a routine seeds, and the target parsing the routine editor uses.
 *
 * Everything here is pure. The routes own the repository calls, so this
 * module runs and is tested without IndexedDB or a DOM.
 */

import type { Routine, RoutineEntry } from "@waveform/api-types";
import type {
  LocalRow,
  WorkoutDraft,
  WorkoutDraftEntry,
  WorkoutDraftTarget,
} from "../db/types";
import { ROUTINE_RULES } from "../db/validation";
import { createNumberField, type FieldSpec } from "./forms";
import { formatWeight, localDateString, toDisplayWeight, toKg, type WeightUnit } from "./format";

/** The label a session shows when its routine is gone (tombstoned or absent). */
export const DELETED_ROUTINE_LABEL = "Deleted routine";

/**
 * The routine a session was logged from: its name while it lives, the
 * deleted-routine label when it is tombstoned or missing, and null when
 * the session never carried a routine id, so a plain session shows no
 * provenance at all.
 */
export function routineProvenance(
  routineId: string | null,
  routine: LocalRow<Routine> | undefined | null,
): string | null {
  if (routineId === null) {
    return null;
  }
  if (!routine || routine.deleted_at !== null) {
    return DELETED_ROUTINE_LABEL;
  }
  return routine.name;
}

/** The minimal routine shape the seeder reads: a routine and its live entries. */
export type RoutineSeedSource = {
  routine: LocalRow<Routine>;
  entries: readonly LocalRow<RoutineEntry>[];
};

/**
 * Seeds a workout draft from a routine: one entry per planned exercise in
 * order_index order, each carrying its targets as a hint, and the routine
 * id so the committed session records where it came from. No sets are
 * created, because a target is a plan and not a performed set.
 */
export function seedDraftFromRoutine(source: RoutineSeedSource, now: Date): WorkoutDraft {
  const iso = now.toISOString();
  const ordered = [...source.entries].sort((a, b) => a.order_index - b.order_index);
  const entries: WorkoutDraftEntry[] = ordered.map((entry, index) => ({
    id: crypto.randomUUID(),
    exercise_id: entry.exercise_id,
    order_index: index,
    notes: null,
    target: {
      sets: entry.target_sets,
      reps: entry.target_reps,
      weight_kg: entry.target_weight_kg,
    },
    sets: [],
  }));
  return {
    id: crypto.randomUUID(),
    local_date: localDateString(now),
    started_at: iso,
    duration_min: null,
    routine_id: source.routine.id,
    notes: null,
    entries,
    updated_at: iso,
  };
}

/** "3 sets of 8 reps at 80 kg": one planned target in the display unit. */
export function formatTargetHint(target: WorkoutDraftTarget, unit: WeightUnit): string {
  const sets = target.sets === 1 ? "1 set" : `${target.sets} sets`;
  const reps = target.reps === 1 ? "1 rep" : `${target.reps} reps`;
  const base = `${sets} of ${reps}`;
  return target.weight_kg === null ? base : `${base} at ${formatWeight(target.weight_kg, unit)}`;
}

/** target_sets bounds, mirroring ROUTINE_RULES; the editor's sets box. */
export const routineSetsField: FieldSpec<number> = createNumberField({
  integer: true,
  min: ROUTINE_RULES.targetSetsMin,
  max: ROUTINE_RULES.targetSetsMax,
});

/** target_reps bounds, mirroring ROUTINE_RULES; the editor's reps box. */
export const routineRepsField: FieldSpec<number> = createNumberField({
  integer: true,
  min: ROUTINE_RULES.targetRepsMin,
  max: ROUTINE_RULES.targetRepsMax,
});

/**
 * Parses a sets or reps box against its ROUTINE_RULES bounds, or explains
 * the rejection. The editor keeps the raw text and only writes a value the
 * repo guard accepts.
 */
export function parseTargetCountInput(
  text: string,
  field: FieldSpec<number>,
): { ok: true; value: number } | { ok: false; issue: string } {
  const raw = text.trim();
  if (raw === "") {
    return { ok: false, issue: "Enter a number." };
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return { ok: false, issue: "Enter a number." };
  }
  const issue = field.validate(value);
  if (issue) {
    return { ok: false, issue };
  }
  return { ok: true, value };
}

/**
 * The live entry id order after swapping the entry at `index` one step in
 * `direction`, or null when the move would fall off either end of the
 * list. Pure: it only rearranges the ids it is given, so the caller
 * decides which order (the latest one it holds) the move applies to. The
 * result is always an exact permutation of the input, which is the shape
 * reorderEntries requires.
 */
export function moveEntryOrder(
  orderedIds: readonly string[],
  index: number,
  direction: -1 | 1,
): string[] | null {
  const target = index + direction;
  if (index < 0 || index >= orderedIds.length || target < 0 || target >= orderedIds.length) {
    return null;
  }
  const moved = orderedIds[index];
  const displaced = orderedIds[target];
  if (moved === undefined || displaced === undefined) {
    return null;
  }
  const next = [...orderedIds];
  next[index] = displaced;
  next[target] = moved;
  return next;
}

/**
 * Parses the optional target-weight box: empty means no target, otherwise
 * a display-unit number converted to stored kg and checked against the
 * routine_entries weight CHECK. Messages stay in the unit on the label.
 */
export function parseTargetWeightInput(
  text: string,
  unit: WeightUnit,
): { ok: true; weight_kg: number | null } | { ok: false; issue: string } {
  const raw = text.trim();
  if (raw === "") {
    return { ok: true, weight_kg: null };
  }
  const typed = Number(raw);
  if (!Number.isFinite(typed)) {
    return { ok: false, issue: "Enter a number." };
  }
  const weightKg = toKg(typed, unit);
  if (weightKg <= ROUTINE_RULES.targetWeightMinKgExclusive) {
    return {
      ok: false,
      issue: `Enter more than ${toDisplayWeight(ROUTINE_RULES.targetWeightMinKgExclusive, unit)}.`,
    };
  }
  if (weightKg > ROUTINE_RULES.targetWeightMaxKg) {
    return {
      ok: false,
      issue: `Enter ${toDisplayWeight(ROUTINE_RULES.targetWeightMaxKg, unit)} ${unit} or less.`,
    };
  }
  return { ok: true, weight_kg: weightKg };
}
