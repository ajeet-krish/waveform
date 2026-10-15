/**
 * Exercise repository: the global catalog plus the signed-in user's
 * custom exercises.
 *
 * Every mutation runs its row write and its outbox append in ONE
 * `db.transaction("rw", db.exercises, db.outbox, ...)` so a crash can
 * never leave a row change without its op.
 */

import type { Exercise } from "@waveform/api-types";
import { buildOutboxOp } from "../outbox";
import type { WaveformDb } from "../schema";
import type { LocalRow, OutboxOp } from "../types";
import { LocalValidationError } from "../validation";
import { nowDate, type RepoDeps } from "./deps";

export type ExerciseCreateInput = {
  name: string;
  muscle_group: string;
  equipment?: string | null;
};

export type ExerciseMutation = {
  row: LocalRow<Exercise>;
  op: OutboxOp<"exercises">;
};

export type ExerciseRepo = {
  /** Live exercises (tombstones filtered), sorted by name. */
  listLive(): Promise<LocalRow<Exercise>[]>;
  /** Raw row by id, tombstones included. */
  get(id: string): Promise<LocalRow<Exercise> | undefined>;
  /** Creates a per-user custom exercise with a create op. */
  createCustom(input: ExerciseCreateInput): Promise<ExerciseMutation>;
  /** Tombstones a custom exercise with a delete op. Catalog rows are refused. */
  softDelete(id: string): Promise<ExerciseMutation>;
};

export function createExerciseRepo(db: WaveformDb, deps: RepoDeps): ExerciseRepo {
  return {
    async listLive(): Promise<LocalRow<Exercise>[]> {
      const rows = await db.exercises.filter((row) => row.deleted_at === null).toArray();
      rows.sort((a, b) => a.name.localeCompare(b.name));
      return rows;
    },

    get(id: string): Promise<LocalRow<Exercise> | undefined> {
      return db.exercises.get(id);
    },

    createCustom(input: ExerciseCreateInput): Promise<ExerciseMutation> {
      const now = nowDate(deps);
      const iso = now.toISOString();
      const row: LocalRow<Exercise> = {
        id: crypto.randomUUID(),
        owner_id: deps.userId,
        name: input.name,
        muscle_group: input.muscle_group,
        equipment: input.equipment ?? null,
        created_at: iso,
        updated_at: iso,
        deleted_at: null,
      };
      const op = buildOutboxOp("exercises", "create", row, now);
      return db.transaction("rw", db.exercises, db.outbox, async () => {
        await db.exercises.put(row);
        await db.outbox.add(op);
        return { row, op };
      });
    },

    softDelete(id: string): Promise<ExerciseMutation> {
      const now = nowDate(deps);
      const iso = now.toISOString();
      return db.transaction("rw", db.exercises, db.outbox, async () => {
        const existing = await db.exercises.get(id);
        if (!existing) {
          throw new LocalValidationError(`exercise not found: ${id}`);
        }
        if (existing.owner_id === null) {
          throw new LocalValidationError(
            "global catalog exercise cannot be deleted",
            [`exercise ${id} is a catalog row (owner_id null)`],
          );
        }
        // Soft only: history keeps referencing the row through its tombstone.
        const row: LocalRow<Exercise> = {
          ...existing,
          updated_at: iso,
          deleted_at: iso,
        };
        const op = buildOutboxOp("exercises", "delete", row, now);
        await db.exercises.put(row);
        await db.outbox.add(op);
        return { row, op };
      });
    },
  };
}
