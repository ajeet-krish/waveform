/**
 * Local data types for the IndexedDB core.
 *
 * Every timestamp is an ISO 8601 UTC string (for example
 * "2026-10-14T09:30:00.000Z"); `local_date` is the device-local calendar
 * day in "YYYY-MM-DD" form. No Date objects are ever stored.
 */

import type {
  Activity,
  BodyStats,
  Exercise,
  ExerciseEntry,
  Routine,
  RoutineEntry,
  SetEntry,
  WorkoutSession,
} from "@waveform/api-types";

/**
 * A synced row as it lives locally: identical to the server row minus
 * `applied_at`, which is server-stamped and never written by the client.
 */
export type LocalRow<T> = Omit<T, "applied_at">;

/**
 * The push payload for a set. `e1rm_kg` is a Postgres generated column
 * (migrations/0001_init.sql), so it is omitted from the outbox payload; the
 * local row still stores a client-computed copy for charts and history.
 */
export type SetEntryWrite = Omit<LocalRow<SetEntry>, "e1rm_kg">;

export type OutboxAction = "create" | "update" | "delete";

export type OutboxEntity =
  | "exercises"
  | "workout_sessions"
  | "exercise_entries"
  | "set_entries"
  | "activities"
  | "body_stats"
  | "routines"
  | "routine_entries";

/** Maps each syncable entity to the local row type it carries. */
export type OutboxRowMap = {
  exercises: LocalRow<Exercise>;
  workout_sessions: LocalRow<WorkoutSession>;
  exercise_entries: LocalRow<ExerciseEntry>;
  set_entries: SetEntryWrite;
  activities: LocalRow<Activity>;
  body_stats: LocalRow<BodyStats>;
  routines: LocalRow<Routine>;
  routine_entries: LocalRow<RoutineEntry>;
};

/**
 * The per-grade send histogram for one climbing activity. Device-local
 * only: it never enters the outbox (the server derives V-points from the
 * activity row's `climb_grade_value` and `routes_sent`). `counts` always
 * holds MAX_V_GRADE + 1 (17) entries; the index is the integer V grade.
 */
export type ClimbSends = {
  activity_id: string;
  counts: number[];
  updated_at: string;
};

/**
 * One queued mutation. The wire shape sent to POST /sync/push is
 * `op_id`/`entity`/`action`/`payload`/`updated_at`; `created_at` is local
 * only and exists so the outbox drains in the order the user made the
 * changes when several ops share one LWW timestamp.
 */
export type OutboxOp<E extends OutboxEntity = OutboxEntity> = {
  op_id: string;
  entity: E;
  action: OutboxAction;
  payload: OutboxRowMap[E];
  updated_at: string;
  created_at: string;
  /** Push attempts recorded by markOutboxFailed; absent while healthy. */
  attempts?: number;
  /** Last server or transport error recorded for the op, if any. */
  last_error?: string | null;
  /** True once attempts reached 3; excluded from the pending queue. */
  quarantined?: boolean;
};

/** The signed-in user's local profile row (single row per device). */
export type LocalProfile = {
  id: string;
  display_name: string;
  email: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
  settings: {
    display_weight_unit: "kg" | "lb";
    display_length_unit: "cm" | "in";
  };
};

/** One set inside an unsaved workout draft. Ids are pre-generated so a
 * commit can insert rows with the same primary keys the draft used. */
export type WorkoutDraftSet = {
  id: string;
  set_index: number;
  weight_kg: number;
  reps: number;
  is_warmup: boolean;
};

/** One exercise slot inside an unsaved workout draft. */
export type WorkoutDraftEntry = {
  id: string;
  exercise_id: string;
  order_index: number;
  notes: string | null;
  sets: WorkoutDraftSet[];
};

/**
 * An in-progress workout kept locally only. `id` becomes the workout
 * session id on commit; entry and set ids are likewise pre-generated.
 */
export type WorkoutDraft = {
  id: string;
  local_date: string;
  started_at: string | null;
  duration_min: number | null;
  routine_id: string | null;
  notes: string | null;
  entries: WorkoutDraftEntry[];
  updated_at: string;
};

/** Generic key/value sync metadata (cursor positions, last pull, ...). */
export type SyncMetaRow = {
  key: string;
  value: unknown;
};
