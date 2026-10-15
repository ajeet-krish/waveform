/**
 * Pure draft reducers for an in-progress workout.
 *
 * Every function returns a new draft and never mutates its input; ids are
 * pre-generated with crypto.randomUUID() at insert time so a commit can
 * reuse them as primary keys. updated_at is left alone here: the draft
 * repo stamps it on save, and the clock does not belong in a reducer.
 */

import { e1rmBrzycki } from "@waveform/scoring";
import type { WorkoutDraft, WorkoutDraftEntry, WorkoutDraftSet } from "../db/types";
import { localDateString } from "./format";

/** The set as entered in a form: weight and reps, warmup optional. */
export type DraftSetInput = {
  weight_kg: number;
  reps: number;
  is_warmup?: boolean;
};

/** The shape every working-set filter agrees on (rows and draft sets). */
export type WorkingSetLike = {
  weight_kg: number;
  reps: number;
  is_warmup: boolean;
};

/**
 * A working set earns stats: not a warmup, with real weight on the bar and
 * at least one rep. Bodyweight-only work (weight 0) still counts as work,
 * but carries no load to estimate a max from.
 */
export function isWorkingSet(set: WorkingSetLike): boolean {
  return (
    !set.is_warmup &&
    Number.isFinite(set.weight_kg) &&
    set.weight_kg > 0 &&
    Number.isFinite(set.reps) &&
    set.reps >= 1
  );
}

/** Best Brzycki e1RM across working sets; undefined when none qualify. */
export function bestE1rm(sets: readonly WorkingSetLike[]): number | undefined {
  let best: number | undefined;
  for (const set of sets) {
    if (!isWorkingSet(set)) {
      continue;
    }
    const estimate = e1rmBrzycki(set.weight_kg, set.reps);
    if (best === undefined || estimate > best) {
      best = estimate;
    }
  }
  return best;
}

/** A fresh draft for the device-local day the clock reads. */
export function createEmptyDraft(now: Date): WorkoutDraft {
  const iso = now.toISOString();
  return {
    id: crypto.randomUUID(),
    local_date: localDateString(now),
    started_at: iso,
    duration_min: null,
    routine_id: null,
    notes: null,
    entries: [],
    updated_at: iso,
  };
}

/** Appends an exercise slot at the end of the draft. */
export function addExerciseToDraft(draft: WorkoutDraft, exerciseId: string): WorkoutDraft {
  const entry: WorkoutDraftEntry = {
    id: crypto.randomUUID(),
    exercise_id: exerciseId,
    order_index: draft.entries.length,
    notes: null,
    sets: [],
  };
  return { ...draft, entries: [...draft.entries, entry] };
}

/** Appends a set to one slot; the draft is returned unchanged for an unknown slot. */
export function addSetToDraft(
  draft: WorkoutDraft,
  entryId: string,
  input: DraftSetInput,
): WorkoutDraft {
  let found = false;
  const entries = draft.entries.map((entry) => {
    if (entry.id !== entryId) {
      return entry;
    }
    found = true;
    const set: WorkoutDraftSet = {
      id: crypto.randomUUID(),
      set_index: entry.sets.length,
      weight_kg: input.weight_kg,
      reps: input.reps,
      is_warmup: input.is_warmup ?? false,
    };
    return { ...entry, sets: [...entry.sets, set] };
  });
  return found ? { ...draft, entries } : draft;
}

/** Patches one set; the draft is returned unchanged when the id is unknown. */
export function updateSetInDraft(
  draft: WorkoutDraft,
  setId: string,
  patch: { weight_kg?: number; reps?: number; is_warmup?: boolean },
): WorkoutDraft {
  let found = false;
  const entries = draft.entries.map((entry) => {
    let hit = false;
    const sets = entry.sets.map((set) => {
      if (set.id !== setId) {
        return set;
      }
      hit = true;
      found = true;
      return {
        ...set,
        weight_kg: patch.weight_kg ?? set.weight_kg,
        reps: patch.reps ?? set.reps,
        is_warmup: patch.is_warmup ?? set.is_warmup,
      };
    });
    return hit ? { ...entry, sets } : entry;
  });
  return found ? { ...draft, entries } : draft;
}

/** Removes one set and renumbers the remaining sets 0..n-1 in place order. */
export function removeSetFromDraft(draft: WorkoutDraft, setId: string): WorkoutDraft {
  let found = false;
  const entries = draft.entries.map((entry) => {
    const remaining = entry.sets.filter((set) => {
      if (set.id === setId) {
        found = true;
        return false;
      }
      return true;
    });
    if (remaining.length === entry.sets.length) {
      return entry;
    }
    return {
      ...entry,
      sets: remaining.map((set, index) => (set.set_index === index ? set : { ...set, set_index: index })),
    };
  });
  return found ? { ...draft, entries } : draft;
}

/** Removes one exercise slot (its sets go with it) and renumbers the rest. */
export function removeExerciseFromDraft(draft: WorkoutDraft, entryId: string): WorkoutDraft {
  const remaining = draft.entries.filter((entry) => entry.id !== entryId);
  if (remaining.length === draft.entries.length) {
    return draft;
  }
  return {
    ...draft,
    entries: remaining.map((entry, index) =>
      entry.order_index === index ? entry : { ...entry, order_index: index },
    ),
  };
}

export type DraftTotals = {
  /** Every set in the draft, warmups included: what the log shows. */
  sets: number;
  /** Reps times weight across working sets: what the muscles paid. */
  volumeKg: number;
  /** Best Brzycki estimate; absent when no set carries a load. */
  topE1rmKg?: number;
};

export function draftTotals(draft: WorkoutDraft): DraftTotals {
  let sets = 0;
  let volumeKg = 0;
  const working: WorkingSetLike[] = [];
  for (const entry of draft.entries) {
    for (const set of entry.sets) {
      sets += 1;
      if (set.is_warmup || !Number.isFinite(set.weight_kg) || !Number.isFinite(set.reps)) {
        continue;
      }
      if (set.reps >= 1) {
        volumeKg += set.weight_kg * set.reps;
        working.push(set);
      }
    }
  }
  const top = bestE1rm(working);
  const totals: DraftTotals = { sets, volumeKg };
  if (top !== undefined) {
    totals.topE1rmKg = top;
  }
  return totals;
}

/**
 * Session length in whole minutes: rounded, clamped to 0..1440 (the same
 * bound workout_sessions.duration_min is checked against), null when either
 * endpoint is missing or unreadable.
 */
export function computeDurationMin(
  startedAt: string | Date | null | undefined,
  endedAt: string | Date | null | undefined,
): number | null {
  const start = toDateOrNull(startedAt);
  const end = toDateOrNull(endedAt);
  if (!start || !end) {
    return null;
  }
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
  return Math.min(1440, Math.max(0, minutes));
}

function toDateOrNull(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
