/**
 * Workout repository: sessions, their exercise entries, and their sets.
 *
 * Transactional contract: every mutating function performs all of its row
 * writes AND all of its outbox appends inside ONE
 * `db.transaction("rw", <touched tables>, db.outbox, ...)`. Deletes are
 * soft: the row is re-put with `deleted_at = updated_at = now` and the
 * delete op carries the full tombstoned row. Set writes compute a local
 * `e1rm_kg` copy (Postgres regenerates its own) but their outbox payloads
 * are `SetEntryWrite`, so `e1rm_kg` never reaches the push wire.
 */

import { e1rmBrzycki } from "@waveform/scoring";
import type { ExerciseEntry, SetEntry, WorkoutSession } from "@waveform/api-types";
import { buildOutboxOp } from "../outbox";
import type { WaveformDb } from "../schema";
import type { LocalRow, OutboxOp, SetEntryWrite } from "../types";
import {
  assertValidEntry,
  assertValidSet,
  assertValidWorkout,
  LocalValidationError,
} from "../validation";
import { nowDate, type RepoDeps } from "./deps";

export type WorkoutCreateInput = {
  local_date: string;
  started_at?: string | null;
  duration_min?: number | null;
  routine_id?: string | null;
  notes?: string | null;
};

export type WorkoutPatch = {
  local_date?: string;
  started_at?: string | null;
  duration_min?: number | null;
  routine_id?: string | null;
  notes?: string | null;
};

export type WorkoutMutation = {
  row: LocalRow<WorkoutSession>;
  op: OutboxOp<"workout_sessions">;
};

export type EntryCreateInput = {
  workout_id: string;
  exercise_id: string;
  order_index: number;
  notes?: string | null;
};

export type EntryPatch = {
  exercise_id?: string;
  order_index?: number;
  notes?: string | null;
};

export type EntryMutation = {
  row: LocalRow<ExerciseEntry>;
  op: OutboxOp<"exercise_entries">;
};

export type SetCreateInput = {
  exercise_entry_id: string;
  set_index: number;
  weight_kg: number;
  reps: number;
  is_warmup?: boolean;
};

export type SetPatch = {
  set_index?: number;
  weight_kg?: number;
  reps?: number;
  is_warmup?: boolean;
};

export type SetMutation = {
  row: LocalRow<SetEntry>;
  op: OutboxOp<"set_entries">;
};

export type WorkoutTree = {
  session: LocalRow<WorkoutSession>;
  entries: Array<{ entry: LocalRow<ExerciseEntry>; sets: LocalRow<SetEntry>[] }>;
};

/** Strips the generated column so a set's outbox payload matches SetEntryWrite. */
export function toSetWrite({ e1rm_kg: _generated, ...rest }: LocalRow<SetEntry>): SetEntryWrite {
  return rest;
}

/** Loads one session's live entries (order_index asc) and their live sets (set_index asc). */
async function loadTree(db: WaveformDb, session: LocalRow<WorkoutSession>): Promise<WorkoutTree> {
  const entryRows = await db.exercise_entries.where("workout_id").equals(session.id).toArray();
  const liveEntries = entryRows
    .filter((row) => row.deleted_at === null)
    .sort((a, b) => a.order_index - b.order_index);
  const entries: WorkoutTree["entries"] = [];
  for (const entry of liveEntries) {
    const setRows = await db.set_entries.where("exercise_entry_id").equals(entry.id).toArray();
    const liveSets = setRows
      .filter((row) => row.deleted_at === null)
      .sort((a, b) => a.set_index - b.set_index);
    entries.push({ entry, sets: liveSets });
  }
  return { session, entries };
}

export type WorkoutRepo = {
  create(input: WorkoutCreateInput): Promise<WorkoutMutation>;
  update(id: string, patch: WorkoutPatch): Promise<WorkoutMutation>;
  /** Soft-deletes a session, its entries, and its sets; one delete op per row. */
  remove(id: string): Promise<OutboxOp[]>;
  /** Live sessions whose local_date falls in [from, to], both inclusive. */
  listByDateRange(from: string, to: string): Promise<LocalRow<WorkoutSession>[]>;
  /** Session with entries in order_index order and sets in set_index order; undefined when the session is missing or tombstoned. */
  getTree(id: string): Promise<WorkoutTree | undefined>;
  /**
   * Every live session (tombstones excluded) with its live entries and sets,
   * sorted by local_date desc then id desc: the newest day first, newest id
   * first within one day.
   */
  listAllTrees(): Promise<WorkoutTree[]>;
  /**
   * Live sessions whose local_date falls in [from, to] (both inclusive),
   * each with its live entries and sets, in local_date asc then id asc
   * order.
   */
  listTreesByDateRange(from: string, to: string): Promise<WorkoutTree[]>;
  addEntry(input: EntryCreateInput): Promise<EntryMutation>;
  updateEntry(id: string, patch: EntryPatch): Promise<EntryMutation>;
  /** Soft-deletes an entry and its sets; one delete op per row. */
  removeEntry(id: string): Promise<OutboxOp[]>;
  addSet(input: SetCreateInput): Promise<SetMutation>;
  updateSet(id: string, patch: SetPatch): Promise<SetMutation>;
  removeSet(id: string): Promise<SetMutation>;
};

export function createWorkoutRepo(db: WaveformDb, deps: RepoDeps): WorkoutRepo {
  return {
    create(input: WorkoutCreateInput): Promise<WorkoutMutation> {
      const now = nowDate(deps);
      const iso = now.toISOString();
      const row: LocalRow<WorkoutSession> = {
        id: crypto.randomUUID(),
        user_id: deps.userId,
        local_date: input.local_date,
        started_at: input.started_at ?? null,
        duration_min: input.duration_min ?? null,
        routine_id: input.routine_id ?? null,
        notes: input.notes ?? null,
        created_at: iso,
        updated_at: iso,
        deleted_at: null,
      };
      assertValidWorkout(row);
      const op = buildOutboxOp("workout_sessions", "create", row, now);
      return db.transaction("rw", db.workout_sessions, db.outbox, async () => {
        await db.workout_sessions.put(row);
        await db.outbox.add(op);
        return { row, op };
      });
    },

    update(id: string, patch: WorkoutPatch): Promise<WorkoutMutation> {
      const now = nowDate(deps);
      const iso = now.toISOString();
      return db.transaction("rw", db.workout_sessions, db.outbox, async () => {
        const existing = await db.workout_sessions.get(id);
        if (!existing) {
          throw new LocalValidationError(`workout not found: ${id}`);
        }
        const row: LocalRow<WorkoutSession> = {
          ...existing,
          local_date: patch.local_date ?? existing.local_date,
          started_at: patch.started_at !== undefined ? patch.started_at : existing.started_at,
          duration_min: patch.duration_min !== undefined ? patch.duration_min : existing.duration_min,
          routine_id: patch.routine_id !== undefined ? patch.routine_id : existing.routine_id,
          notes: patch.notes !== undefined ? patch.notes : existing.notes,
          updated_at: iso,
        };
        assertValidWorkout(row);
        const op = buildOutboxOp("workout_sessions", "update", row, now);
        await db.workout_sessions.put(row);
        await db.outbox.add(op);
        return { row, op };
      });
    },

    remove(id: string): Promise<OutboxOp[]> {
      const now = nowDate(deps);
      const iso = now.toISOString();
      return db.transaction(
        "rw",
        db.workout_sessions,
        db.exercise_entries,
        db.set_entries,
        db.outbox,
        async () => {
          const session = await db.workout_sessions.get(id);
          if (!session) {
            throw new LocalValidationError(`workout not found: ${id}`);
          }
          const ops: OutboxOp[] = [];
          if (session.deleted_at === null) {
            const tomb: LocalRow<WorkoutSession> = { ...session, updated_at: iso, deleted_at: iso };
            const op = buildOutboxOp("workout_sessions", "delete", tomb, now);
            await db.workout_sessions.put(tomb);
            await db.outbox.add(op);
            ops.push(op);
          }
          const entries = await db.exercise_entries.where("workout_id").equals(id).toArray();
          for (const entry of entries) {
            if (entry.deleted_at === null) {
              const tomb: LocalRow<ExerciseEntry> = { ...entry, updated_at: iso, deleted_at: iso };
              const op = buildOutboxOp("exercise_entries", "delete", tomb, now);
              await db.exercise_entries.put(tomb);
              await db.outbox.add(op);
              ops.push(op);
            }
            const sets = await db.set_entries.where("exercise_entry_id").equals(entry.id).toArray();
            for (const set of sets) {
              if (set.deleted_at === null) {
                const tomb: LocalRow<SetEntry> = { ...set, updated_at: iso, deleted_at: iso };
                const op = buildOutboxOp("set_entries", "delete", toSetWrite(tomb), now);
                await db.set_entries.put(tomb);
                await db.outbox.add(op);
                ops.push(op);
              }
            }
          }
          return ops;
        },
      );
    },

    async listByDateRange(from: string, to: string): Promise<LocalRow<WorkoutSession>[]> {
      const rows = await db.workout_sessions
        .where("local_date")
        .between(from, to, true, true)
        .toArray();
      const live = rows.filter((row) => row.deleted_at === null);
      live.sort((a, b) => {
        if (a.local_date !== b.local_date) {
          return a.local_date < b.local_date ? -1 : 1;
        }
        return a.id.localeCompare(b.id);
      });
      return live;
    },

    async getTree(id: string): Promise<WorkoutTree | undefined> {
      const session = await db.workout_sessions.get(id);
      // A soft-deleted session is as gone as a missing one: the detail
      // view renders "Session not found" instead of a tombstone.
      if (!session || session.deleted_at !== null) {
        return undefined;
      }
      return loadTree(db, session);
    },

    async listAllTrees(): Promise<WorkoutTree[]> {
      const rows = await db.workout_sessions.toArray();
      const live = rows.filter((row) => row.deleted_at === null);
      live.sort((a, b) => {
        if (a.local_date !== b.local_date) {
          return a.local_date < b.local_date ? 1 : -1;
        }
        if (a.id === b.id) {
          return 0;
        }
        return a.id < b.id ? 1 : -1;
      });
      const trees: WorkoutTree[] = [];
      for (const session of live) {
        trees.push(await loadTree(db, session));
      }
      return trees;
    },

    async listTreesByDateRange(from: string, to: string): Promise<WorkoutTree[]> {
      const sessions = await this.listByDateRange(from, to);
      const trees: WorkoutTree[] = [];
      for (const session of sessions) {
        trees.push(await loadTree(db, session));
      }
      return trees;
    },

    addEntry(input: EntryCreateInput): Promise<EntryMutation> {
      const now = nowDate(deps);
      const iso = now.toISOString();
      const row: LocalRow<ExerciseEntry> = {
        id: crypto.randomUUID(),
        workout_id: input.workout_id,
        exercise_id: input.exercise_id,
        order_index: input.order_index,
        notes: input.notes ?? null,
        created_at: iso,
        updated_at: iso,
        deleted_at: null,
      };
      assertValidEntry(row);
      const op = buildOutboxOp("exercise_entries", "create", row, now);
      return db.transaction("rw", db.exercise_entries, db.outbox, async () => {
        await db.exercise_entries.put(row);
        await db.outbox.add(op);
        return { row, op };
      });
    },

    updateEntry(id: string, patch: EntryPatch): Promise<EntryMutation> {
      const now = nowDate(deps);
      const iso = now.toISOString();
      return db.transaction("rw", db.exercise_entries, db.outbox, async () => {
        const existing = await db.exercise_entries.get(id);
        if (!existing) {
          throw new LocalValidationError(`exercise entry not found: ${id}`);
        }
        const row: LocalRow<ExerciseEntry> = {
          ...existing,
          exercise_id: patch.exercise_id ?? existing.exercise_id,
          order_index: patch.order_index ?? existing.order_index,
          notes: patch.notes !== undefined ? patch.notes : existing.notes,
          updated_at: iso,
        };
        assertValidEntry(row);
        const op = buildOutboxOp("exercise_entries", "update", row, now);
        await db.exercise_entries.put(row);
        await db.outbox.add(op);
        return { row, op };
      });
    },

    removeEntry(id: string): Promise<OutboxOp[]> {
      const now = nowDate(deps);
      const iso = now.toISOString();
      return db.transaction("rw", db.exercise_entries, db.set_entries, db.outbox, async () => {
        const entry = await db.exercise_entries.get(id);
        if (!entry) {
          throw new LocalValidationError(`exercise entry not found: ${id}`);
        }
        const ops: OutboxOp[] = [];
        if (entry.deleted_at === null) {
          const tomb: LocalRow<ExerciseEntry> = { ...entry, updated_at: iso, deleted_at: iso };
          const op = buildOutboxOp("exercise_entries", "delete", tomb, now);
          await db.exercise_entries.put(tomb);
          await db.outbox.add(op);
          ops.push(op);
        }
        const sets = await db.set_entries.where("exercise_entry_id").equals(id).toArray();
        for (const set of sets) {
          if (set.deleted_at === null) {
            const tomb: LocalRow<SetEntry> = { ...set, updated_at: iso, deleted_at: iso };
            const op = buildOutboxOp("set_entries", "delete", toSetWrite(tomb), now);
            await db.set_entries.put(tomb);
            await db.outbox.add(op);
            ops.push(op);
          }
        }
        return ops;
      });
    },

    addSet(input: SetCreateInput): Promise<SetMutation> {
      const now = nowDate(deps);
      const iso = now.toISOString();
      const row: LocalRow<SetEntry> = {
        id: crypto.randomUUID(),
        exercise_entry_id: input.exercise_entry_id,
        set_index: input.set_index,
        weight_kg: input.weight_kg,
        reps: input.reps,
        is_warmup: input.is_warmup ?? false,
        e1rm_kg: e1rmBrzycki(input.weight_kg, input.reps),
        created_at: iso,
        updated_at: iso,
        deleted_at: null,
      };
      assertValidSet(row);
      const op = buildOutboxOp("set_entries", "create", toSetWrite(row), now);
      return db.transaction("rw", db.set_entries, db.outbox, async () => {
        await db.set_entries.put(row);
        await db.outbox.add(op);
        return { row, op };
      });
    },

    updateSet(id: string, patch: SetPatch): Promise<SetMutation> {
      const now = nowDate(deps);
      const iso = now.toISOString();
      return db.transaction("rw", db.set_entries, db.outbox, async () => {
        const existing = await db.set_entries.get(id);
        if (!existing) {
          throw new LocalValidationError(`set not found: ${id}`);
        }
        const weight = patch.weight_kg ?? existing.weight_kg;
        const reps = patch.reps ?? existing.reps;
        const row: LocalRow<SetEntry> = {
          ...existing,
          set_index: patch.set_index ?? existing.set_index,
          weight_kg: weight,
          reps: reps,
          is_warmup: patch.is_warmup ?? existing.is_warmup,
          e1rm_kg: e1rmBrzycki(weight, reps),
          updated_at: iso,
        };
        assertValidSet(row);
        const op = buildOutboxOp("set_entries", "update", toSetWrite(row), now);
        await db.set_entries.put(row);
        await db.outbox.add(op);
        return { row, op };
      });
    },

    removeSet(id: string): Promise<SetMutation> {
      const now = nowDate(deps);
      const iso = now.toISOString();
      return db.transaction("rw", db.set_entries, db.outbox, async () => {
        const existing = await db.set_entries.get(id);
        if (!existing) {
          throw new LocalValidationError(`set not found: ${id}`);
        }
        const row: LocalRow<SetEntry> = { ...existing, updated_at: iso, deleted_at: iso };
        const op = buildOutboxOp("set_entries", "delete", toSetWrite(row), now);
        await db.set_entries.put(row);
        await db.outbox.add(op);
        return { row, op };
      });
    },
  };
}
