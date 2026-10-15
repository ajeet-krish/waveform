/**
 * Workout draft repository: local-only scratch space for an in-progress
 * workout.
 *
 * save/get/current/discard append NO outbox ops. commit() is the only
 * synced mutation: inside ONE transaction it expands the draft into
 * workout_sessions + exercise_entries + set_entries rows using the
 * pre-generated draft ids, computes e1rm_kg per set, appends one create op
 * per inserted row, and deletes the draft. An invalid row (any SQL CHECK
 * violation) throws inside the transaction, which aborts it, so a failed
 * commit leaves every table and the draft itself untouched.
 */

import { e1rmBrzycki } from "@waveform/scoring";
import type { ExerciseEntry, SetEntry, WorkoutSession } from "@waveform/api-types";
import { buildOutboxOp } from "../outbox";
import type { WaveformDb } from "../schema";
import type { LocalRow, OutboxOp, WorkoutDraft } from "../types";
import {
  assertValidEntry,
  assertValidSet,
  assertValidWorkout,
  LocalValidationError,
} from "../validation";
import { nowDate, type RepoDeps } from "./deps";
import { toSetWrite } from "./workouts";

export type DraftRepo = {
  /** Stores a draft locally (stamping updated_at); writes NO outbox op. */
  save(draft: WorkoutDraft): Promise<void>;
  get(id: string): Promise<WorkoutDraft | undefined>;
  /** The most recently saved draft (latest updated_at, id as tie-break). */
  current(): Promise<WorkoutDraft | undefined>;
  /**
   * Turns a draft into synced rows atomically: one create op per inserted
   * row, then the draft is deleted. Throws LocalValidationError when the
   * draft is missing or violates a CHECK.
   */
  commit(id: string): Promise<OutboxOp[]>;
  /** Deletes a draft locally; writes NO outbox op. */
  discard(id: string): Promise<void>;
};

export function createDraftRepo(db: WaveformDb, deps: RepoDeps): DraftRepo {
  return {
    async save(draft: WorkoutDraft): Promise<void> {
      const iso = nowDate(deps).toISOString();
      await db.workout_drafts.put({ ...draft, updated_at: iso });
    },

    get(id: string): Promise<WorkoutDraft | undefined> {
      return db.workout_drafts.get(id);
    },

    async current(): Promise<WorkoutDraft | undefined> {
      const drafts = await db.workout_drafts.toArray();
      drafts.sort((a, b) => {
        if (a.updated_at !== b.updated_at) {
          return a.updated_at < b.updated_at ? 1 : -1;
        }
        if (a.id === b.id) {
          return 0;
        }
        return a.id < b.id ? 1 : -1;
      });
      return drafts[0];
    },

    commit(id: string): Promise<OutboxOp[]> {
      const now = nowDate(deps);
      const iso = now.toISOString();
      return db.transaction(
        "rw",
        db.workout_sessions,
        db.exercise_entries,
        db.set_entries,
        db.workout_drafts,
        db.outbox,
        async () => {
          const draft = await db.workout_drafts.get(id);
          if (!draft) {
            throw new LocalValidationError(`draft not found: ${id}`);
          }

          const ops: OutboxOp[] = [];
          const session: LocalRow<WorkoutSession> = {
            id: draft.id,
            user_id: deps.userId,
            local_date: draft.local_date,
            started_at: draft.started_at,
            duration_min: draft.duration_min,
            routine_id: draft.routine_id,
            notes: draft.notes,
            created_at: iso,
            updated_at: iso,
            deleted_at: null,
          };
          assertValidWorkout(session);
          await db.workout_sessions.put(session);
          const sessionOp = buildOutboxOp("workout_sessions", "create", session, now);
          await db.outbox.add(sessionOp);
          ops.push(sessionOp);

          for (const draftEntry of draft.entries) {
            const entry: LocalRow<ExerciseEntry> = {
              id: draftEntry.id,
              workout_id: draft.id,
              exercise_id: draftEntry.exercise_id,
              order_index: draftEntry.order_index,
              notes: draftEntry.notes,
              created_at: iso,
              updated_at: iso,
              deleted_at: null,
            };
            assertValidEntry(entry);
            await db.exercise_entries.put(entry);
            const entryOp = buildOutboxOp("exercise_entries", "create", entry, now);
            await db.outbox.add(entryOp);
            ops.push(entryOp);

            for (const draftSet of draftEntry.sets) {
              const set: LocalRow<SetEntry> = {
                id: draftSet.id,
                exercise_entry_id: draftEntry.id,
                set_index: draftSet.set_index,
                weight_kg: draftSet.weight_kg,
                reps: draftSet.reps,
                is_warmup: draftSet.is_warmup,
                e1rm_kg: e1rmBrzycki(draftSet.weight_kg, draftSet.reps),
                created_at: iso,
                updated_at: iso,
                deleted_at: null,
              };
              // Throws on a CHECK violation: the transaction aborts and
              // rolls back every row and op written above.
              assertValidSet(set);
              await db.set_entries.put(set);
              const setOp = buildOutboxOp("set_entries", "create", toSetWrite(set), now);
              await db.outbox.add(setOp);
              ops.push(setOp);
            }
          }

          await db.workout_drafts.delete(id);
          return ops;
        },
      );
    },

    async discard(id: string): Promise<void> {
      await db.workout_drafts.delete(id);
    },
  };
}
