/**
 * Routine repository: reusable workout templates and their planned
 * exercise entries.
 *
 * Transactional contract: every mutating function performs all of its row
 * writes AND all of its outbox appends inside ONE
 * `db.transaction("rw", <touched tables>, db.outbox, ...)`, so a crash can
 * never leave a row change without its op (create writes the routine and
 * every entry in a single transaction). Ownership guard: a mutation
 * refuses to touch a routine whose `user_id` is not `deps.userId`, and an
 * entry mutation proves the parent routine is the signed-in user's,
 * throwing before any write. A routine or entry mutation refuses a
 * tombstoned row (not found), and removeEntry is idempotent: a repeat on
 * an already-deleted entry returns the existing tombstone with no new op.
 * Deletes are soft: the row is re-put with
 * `deleted_at = updated_at = now` and the delete op carries the full
 * tombstoned row; softDelete tombstones the routine and its entries
 * together. Routine entries carry no owner column of their own, so their
 * ownership is the parent path.
 */

import type { Routine, RoutineEntry } from "@waveform/api-types";
import { buildOutboxOp } from "../outbox";
import type { WaveformDb } from "../schema";
import type { LocalRow, OutboxOp } from "../types";
import {
  assertValidRoutine,
  assertValidRoutineEntry,
  LocalValidationError,
} from "../validation";
import { nowDate, type RepoDeps } from "./deps";

/** Mirror the schema defaults for a routine entry's targets. */
const DEFAULT_TARGET_SETS = 3;
const DEFAULT_TARGET_REPS = 8;

export type RoutineEntryCreateInput = {
  exercise_id: string;
  order_index?: number;
  target_sets?: number;
  target_reps?: number;
  target_weight_kg?: number | null;
};

export type RoutineCreateInput = {
  name: string;
  notes?: string | null;
  entries?: RoutineEntryCreateInput[];
};

export type RoutinePatch = {
  name?: string;
  notes?: string | null;
};

export type RoutineEntryPatch = {
  exercise_id?: string;
  order_index?: number;
  target_sets?: number;
  target_reps?: number;
  target_weight_kg?: number | null;
};

export type RoutineMutation = {
  row: LocalRow<Routine>;
  op: OutboxOp<"routines">;
};

export type RoutineEntryMutation = {
  row: LocalRow<RoutineEntry>;
  op: OutboxOp<"routine_entries">;
};

/**
 * What removeEntry returns: the tombstoned entry, and the delete op only
 * when one was queued. A repeat remove on an already-tombstoned entry is
 * an idempotent no-op that returns the existing tombstone with no op.
 */
export type RoutineEntryRemoval = {
  row: LocalRow<RoutineEntry>;
  op?: OutboxOp<"routine_entries">;
};

/** A routine plus its live entries in order_index order. */
export type RoutineWithEntries = {
  routine: LocalRow<Routine>;
  entries: LocalRow<RoutineEntry>[];
};

/** What create returns: the routine mutation plus one mutation per entry. */
export type RoutineCreateResult = RoutineMutation & { entries: RoutineEntryMutation[] };

/** The foreign-owner refusal for one row kind, with a noun-specific message. */
function foreignAccountError(noun: string, id: string): LocalValidationError {
  return new LocalValidationError(
    `this ${noun} belongs to another account`,
    [`${noun} ${id} is owned by another account`],
  );
}

/** Refuses a mutation when the routine's user_id is not the signed-in user. */
function assertRoutineOwned(deps: RepoDeps, routine: LocalRow<Routine>): void {
  if (routine.user_id !== deps.userId) {
    throw foreignAccountError("routine", routine.id);
  }
}

/** Loads a routine and refuses the mutation when it belongs to another account. */
async function loadOwnedRoutine(
  db: WaveformDb,
  deps: RepoDeps,
  routineId: string,
): Promise<LocalRow<Routine>> {
  const routine = await db.routines.get(routineId);
  // A tombstoned routine is as gone as a missing one: an entry must not
  // be added under it and a reorder must not touch its entries.
  if (!routine || routine.deleted_at !== null) {
    throw new LocalValidationError(`routine not found: ${routineId}`);
  }
  assertRoutineOwned(deps, routine);
  return routine;
}

/** Refuses a mutation when the entry's parent routine belongs to another user. */
async function assertEntryOwned(
  db: WaveformDb,
  deps: RepoDeps,
  entry: LocalRow<RoutineEntry>,
): Promise<void> {
  const routine = await db.routines.get(entry.routine_id);
  if (!routine) {
    throw new LocalValidationError(`routine not found: ${entry.routine_id}`);
  }
  if (routine.user_id !== deps.userId) {
    throw foreignAccountError("routine entry", entry.id);
  }
}

export type RoutineRepo = {
  /** Live routines (tombstones filtered), sorted by name then id. */
  listLive(): Promise<LocalRow<Routine>[]>;
  /** Routine plus its live entries ordered by order_index; undefined when missing or tombstoned. */
  getWithEntries(id: string): Promise<RoutineWithEntries | undefined>;
  /** Creates a routine and its entries in ONE transaction with one op per row. */
  create(input: RoutineCreateInput): Promise<RoutineCreateResult>;
  /** Patches name/notes on a routine with an update op. */
  update(id: string, patch: RoutinePatch): Promise<RoutineMutation>;
  /** Tombstones the routine and its entries together; one delete op per live row. */
  softDelete(id: string): Promise<OutboxOp[]>;
  /** Adds one planned exercise entry with a create op. */
  addEntry(input: RoutineEntryCreateInput & { routine_id: string }): Promise<RoutineEntryMutation>;
  /** Patches one entry with an update op. */
  updateEntry(id: string, patch: RoutineEntryPatch): Promise<RoutineEntryMutation>;
  /** Tombstones one entry with a delete op; idempotent no-op when already tombstoned. */
  removeEntry(id: string): Promise<RoutineEntryRemoval>;
  /** Rewrites order_index to the given entry id order; one update op per entry. */
  reorderEntries(routineId: string, orderedEntryIds: string[]): Promise<RoutineEntryMutation[]>;
};

export function createRoutineRepo(db: WaveformDb, deps: RepoDeps): RoutineRepo {
  return {
    async listLive(): Promise<LocalRow<Routine>[]> {
      const rows = await db.routines.filter((row) => row.deleted_at === null).toArray();
      rows.sort((a, b) => {
        const byName = a.name.localeCompare(b.name);
        return byName !== 0 ? byName : a.id.localeCompare(b.id);
      });
      return rows;
    },

    async getWithEntries(id: string): Promise<RoutineWithEntries | undefined> {
      const routine = await db.routines.get(id);
      // A soft-deleted routine is as gone as a missing one.
      if (!routine || routine.deleted_at !== null) {
        return undefined;
      }
      const entryRows = await db.routine_entries.where("routine_id").equals(id).toArray();
      const entries = entryRows
        .filter((row) => row.deleted_at === null)
        .sort((a, b) => a.order_index - b.order_index);
      return { routine, entries };
    },

    async create(input: RoutineCreateInput): Promise<RoutineCreateResult> {
      const now = nowDate(deps);
      const iso = now.toISOString();
      const row: LocalRow<Routine> = {
        id: crypto.randomUUID(),
        user_id: deps.userId,
        name: input.name.trim(),
        notes: input.notes ?? null,
        created_at: iso,
        updated_at: iso,
        deleted_at: null,
      };
      assertValidRoutine(row);
      const entries: RoutineEntryMutation[] = (input.entries ?? []).map((entry, index) => {
        const entryRow: LocalRow<RoutineEntry> = {
          id: crypto.randomUUID(),
          routine_id: row.id,
          exercise_id: entry.exercise_id,
          order_index: entry.order_index ?? index,
          target_sets: entry.target_sets ?? DEFAULT_TARGET_SETS,
          target_reps: entry.target_reps ?? DEFAULT_TARGET_REPS,
          target_weight_kg: entry.target_weight_kg ?? null,
          created_at: iso,
          updated_at: iso,
          deleted_at: null,
        };
        assertValidRoutineEntry(entryRow);
        return {
          row: entryRow,
          op: buildOutboxOp("routine_entries", "create", entryRow, now),
        };
      });
      const op = buildOutboxOp("routines", "create", row, now);
      return db.transaction("rw", db.routines, db.routine_entries, db.outbox, async () => {
        await db.routines.put(row);
        await db.outbox.add(op);
        for (const entry of entries) {
          await db.routine_entries.put(entry.row);
          await db.outbox.add(entry.op);
        }
        return { row, op, entries };
      });
    },

    update(id: string, patch: RoutinePatch): Promise<RoutineMutation> {
      const now = nowDate(deps);
      const iso = now.toISOString();
      return db.transaction("rw", db.routines, db.outbox, async () => {
        const existing = await db.routines.get(id);
        if (!existing || existing.deleted_at !== null) {
          throw new LocalValidationError(`routine not found: ${id}`);
        }
        assertRoutineOwned(deps, existing);
        const row: LocalRow<Routine> = {
          ...existing,
          name: patch.name !== undefined ? patch.name.trim() : existing.name,
          notes: patch.notes !== undefined ? patch.notes : existing.notes,
          updated_at: iso,
        };
        assertValidRoutine(row);
        const op = buildOutboxOp("routines", "update", row, now);
        await db.routines.put(row);
        await db.outbox.add(op);
        return { row, op };
      });
    },

    softDelete(id: string): Promise<OutboxOp[]> {
      const now = nowDate(deps);
      const iso = now.toISOString();
      return db.transaction(
        "rw",
        db.routines,
        db.routine_entries,
        db.outbox,
        async () => {
          const routine = await db.routines.get(id);
          if (!routine) {
            throw new LocalValidationError(`routine not found: ${id}`);
          }
          assertRoutineOwned(deps, routine);
          const ops: OutboxOp[] = [];
          if (routine.deleted_at === null) {
            const tomb: LocalRow<Routine> = { ...routine, updated_at: iso, deleted_at: iso };
            const op = buildOutboxOp("routines", "delete", tomb, now);
            await db.routines.put(tomb);
            await db.outbox.add(op);
            ops.push(op);
          }
          const entries = await db.routine_entries.where("routine_id").equals(id).toArray();
          for (const entry of entries) {
            if (entry.deleted_at === null) {
              const tomb: LocalRow<RoutineEntry> = {
                ...entry,
                updated_at: iso,
                deleted_at: iso,
              };
              const op = buildOutboxOp("routine_entries", "delete", tomb, now);
              await db.routine_entries.put(tomb);
              await db.outbox.add(op);
              ops.push(op);
            }
          }
          return ops;
        },
      );
    },

    addEntry(
      input: RoutineEntryCreateInput & { routine_id: string },
    ): Promise<RoutineEntryMutation> {
      const now = nowDate(deps);
      const iso = now.toISOString();
      return db.transaction(
        "rw",
        db.routine_entries,
        db.routines,
        db.outbox,
        async () => {
          await loadOwnedRoutine(db, deps, input.routine_id);
          // Default the new entry after the last live one, so it never
          // collides with an existing first entry (create() uses the
          // array index for its own entries).
          const live = (await db.routine_entries
            .where("routine_id")
            .equals(input.routine_id)
            .toArray()).filter((entry) => entry.deleted_at === null);
          const maxOrder = live.reduce((max, entry) => Math.max(max, entry.order_index), -1);
          const row: LocalRow<RoutineEntry> = {
            id: crypto.randomUUID(),
            routine_id: input.routine_id,
            exercise_id: input.exercise_id,
            order_index: input.order_index ?? maxOrder + 1,
            target_sets: input.target_sets ?? DEFAULT_TARGET_SETS,
            target_reps: input.target_reps ?? DEFAULT_TARGET_REPS,
            target_weight_kg: input.target_weight_kg ?? null,
            created_at: iso,
            updated_at: iso,
            deleted_at: null,
          };
          assertValidRoutineEntry(row);
          const op = buildOutboxOp("routine_entries", "create", row, now);
          await db.routine_entries.put(row);
          await db.outbox.add(op);
          return { row, op };
        },
      );
    },

    updateEntry(id: string, patch: RoutineEntryPatch): Promise<RoutineEntryMutation> {
      const now = nowDate(deps);
      const iso = now.toISOString();
      return db.transaction(
        "rw",
        db.routine_entries,
        db.routines,
        db.outbox,
        async () => {
          const existing = await db.routine_entries.get(id);
          if (!existing || existing.deleted_at !== null) {
            throw new LocalValidationError(`routine entry not found: ${id}`);
          }
          await assertEntryOwned(db, deps, existing);
          const row: LocalRow<RoutineEntry> = {
            ...existing,
            exercise_id: patch.exercise_id ?? existing.exercise_id,
            order_index: patch.order_index ?? existing.order_index,
            target_sets: patch.target_sets ?? existing.target_sets,
            target_reps: patch.target_reps ?? existing.target_reps,
            target_weight_kg:
              patch.target_weight_kg !== undefined
                ? patch.target_weight_kg
                : existing.target_weight_kg,
            updated_at: iso,
          };
          assertValidRoutineEntry(row);
          const op = buildOutboxOp("routine_entries", "update", row, now);
          await db.routine_entries.put(row);
          await db.outbox.add(op);
          return { row, op };
        },
      );
    },

    removeEntry(id: string): Promise<RoutineEntryRemoval> {
      const now = nowDate(deps);
      const iso = now.toISOString();
      return db.transaction(
        "rw",
        db.routine_entries,
        db.routines,
        db.outbox,
        async () => {
          const existing = await db.routine_entries.get(id);
          if (!existing) {
            throw new LocalValidationError(`routine entry not found: ${id}`);
          }
          await assertEntryOwned(db, deps, existing);
          // Idempotent: an already-tombstoned entry is returned as-is with
          // no new delete op, so a repeated remove cannot duplicate the op.
          if (existing.deleted_at !== null) {
            return { row: existing };
          }
          const row: LocalRow<RoutineEntry> = { ...existing, updated_at: iso, deleted_at: iso };
          const op = buildOutboxOp("routine_entries", "delete", row, now);
          await db.routine_entries.put(row);
          await db.outbox.add(op);
          return { row, op };
        },
      );
    },

    reorderEntries(
      routineId: string,
      orderedEntryIds: string[],
    ): Promise<RoutineEntryMutation[]> {
      const now = nowDate(deps);
      const iso = now.toISOString();
      return db.transaction(
        "rw",
        db.routine_entries,
        db.routines,
        db.outbox,
        async () => {
          await loadOwnedRoutine(db, deps, routineId);
          const live = (await db.routine_entries
            .where("routine_id")
            .equals(routineId)
            .toArray()).filter((entry) => entry.deleted_at === null);
          const liveById = new Map(live.map((entry) => [entry.id, entry]));
          // The list must be a permutation of the routine's live entries:
          // same set, no duplicates, no tombstoned or cross-routine ids.
          const seen = new Set<string>();
          const issues: string[] = [];
          for (const entryId of orderedEntryIds) {
            if (seen.has(entryId)) {
              issues.push(`routine entry ${entryId} appears more than once`);
              continue;
            }
            seen.add(entryId);
            if (!liveById.has(entryId)) {
              issues.push(`routine entry ${entryId} is not a live entry of routine ${routineId}`);
            }
          }
          if (seen.size !== liveById.size) {
            issues.push(
              `expected ${liveById.size} live entries, received ${orderedEntryIds.length}`,
            );
          }
          if (issues.length > 0) {
            throw new LocalValidationError(
              `routine entries for ${routineId} must be a permutation of its live entries`,
              issues,
            );
          }
          const mutations: RoutineEntryMutation[] = [];
          for (const [index, entryId] of orderedEntryIds.entries()) {
            const existing = liveById.get(entryId);
            if (existing === undefined) {
              continue;
            }
            const row: LocalRow<RoutineEntry> = { ...existing, order_index: index, updated_at: iso };
            const op = buildOutboxOp("routine_entries", "update", row, now);
            await db.routine_entries.put(row);
            await db.outbox.add(op);
            mutations.push({ row, op });
          }
          return mutations;
        },
      );
    },
  };
}
