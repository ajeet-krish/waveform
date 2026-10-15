/**
 * Client-side guards mirroring the SQL CHECK constraints
 * (migrations/0001_init.sql and migrations/0003_hardening.sql). The server
 * is still authoritative; these exist so a bad row fails locally, inside
 * the writing transaction, instead of at sync-push time.
 */

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Raised when a local row violates a schema-equivalent constraint. */
export class LocalValidationError extends Error {
  /** Human-readable one-per-violation list; defaults to the message. */
  readonly issues: string[];

  constructor(message: string, issues?: string[]) {
    super(message);
    this.name = "LocalValidationError";
    this.issues = issues ?? [message];
  }
}

export type SetCheck = {
  set_index: number;
  weight_kg: number;
  reps: number;
};

export type EntryCheck = {
  order_index: number;
};

export type WorkoutCheck = {
  local_date: string;
  duration_min: number | null;
};

function fail(what: string, issues: string[]): never {
  throw new LocalValidationError(`invalid ${what}: ${issues.join("; ")}`, issues);
}

/**
 * set_entries: reps BETWEEN 1 AND 36, weight_kg BETWEEN 0 AND 1500
 * (0 allows bodyweight and banded work), set_index >= 0, all integers.
 */
export function assertValidSet(set: SetCheck): void {
  const issues: string[] = [];
  if (!Number.isInteger(set.reps) || set.reps < 1 || set.reps > 36) {
    issues.push(`reps must be an integer in 1..36 (got ${set.reps})`);
  }
  if (typeof set.weight_kg !== "number" || !Number.isFinite(set.weight_kg)) {
    issues.push(`weight_kg must be a finite number (got ${set.weight_kg})`);
  } else if (set.weight_kg < 0 || set.weight_kg > 1500) {
    issues.push(`weight_kg must be in 0..1500 (got ${set.weight_kg})`);
  }
  if (!Number.isInteger(set.set_index) || set.set_index < 0) {
    issues.push(`set_index must be an integer >= 0 (got ${set.set_index})`);
  }
  if (issues.length > 0) {
    fail("set", issues);
  }
}

/** exercise_entries: order_index integer >= 0. */
export function assertValidEntry(entry: EntryCheck): void {
  const issues: string[] = [];
  if (!Number.isInteger(entry.order_index) || entry.order_index < 0) {
    issues.push(`order_index must be an integer >= 0 (got ${entry.order_index})`);
  }
  if (issues.length > 0) {
    fail("entry", issues);
  }
}

/** workout_sessions: local_date is a bare calendar day, duration_min null or 0..1440. */
export function assertValidWorkout(workout: WorkoutCheck): void {
  const issues: string[] = [];
  if (typeof workout.local_date !== "string" || !LOCAL_DATE_PATTERN.test(workout.local_date)) {
    issues.push(`local_date must match YYYY-MM-DD (got ${workout.local_date})`);
  }
  if (workout.duration_min !== null) {
    if (!Number.isInteger(workout.duration_min) || workout.duration_min < 0 || workout.duration_min > 1440) {
      issues.push(`duration_min must be null or an integer in 0..1440 (got ${workout.duration_min})`);
    }
  }
  if (issues.length > 0) {
    fail("workout", issues);
  }
}
