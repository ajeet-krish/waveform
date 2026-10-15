/**
 * Dexie schema for the local-first data core.
 *
 * Version 1 declares eight stores. Every synced row mirrors its SQL table
 * minus `applied_at` (server-stamped); the outbox holds queued mutations
 * and workout_drafts/local_profile/sync_meta stay device-local.
 */

import Dexie, { type EntityTable } from "dexie";
import type { Exercise, ExerciseEntry, SetEntry, WorkoutSession } from "@waveform/api-types";
import type {
  LocalProfile,
  LocalRow,
  OutboxOp,
  SyncMetaRow,
  WorkoutDraft,
} from "./types";

export class WaveformDb extends Dexie {
  exercises!: EntityTable<LocalRow<Exercise>, "id">;
  workout_sessions!: EntityTable<LocalRow<WorkoutSession>, "id">;
  exercise_entries!: EntityTable<LocalRow<ExerciseEntry>, "id">;
  set_entries!: EntityTable<LocalRow<SetEntry>, "id">;
  workout_drafts!: EntityTable<WorkoutDraft, "id">;
  outbox!: EntityTable<OutboxOp, "op_id">;
  local_profile!: EntityTable<LocalProfile, "id">;
  sync_meta!: EntityTable<SyncMetaRow, "key">;

  constructor(name = "waveform") {
    super(name);
    this.version(1).stores({
      exercises: "id, owner_id",
      workout_sessions: "id, local_date",
      exercise_entries: "id, workout_id",
      set_entries: "id, exercise_entry_id",
      workout_drafts: "id",
      outbox: "op_id, created_at",
      local_profile: "id",
      sync_meta: "key",
    });
  }
}

/** Creates (but does not open) a WaveformDb instance. Opening is lazy. */
export function createWaveformDb(name = "waveform"): WaveformDb {
  return new WaveformDb(name);
}
