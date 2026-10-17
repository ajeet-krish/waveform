/**
 * Client-side guards mirroring the SQL CHECK constraints
 * (migrations/0001_init.sql and migrations/0003_hardening.sql). The server
 * is still authoritative; these exist so a bad row fails locally, inside
 * the writing transaction, instead of at sync-push time.
 */

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The set_entries CHECK bounds in one place. The SQL CHECKs remain
 * authoritative; the form layer (lib/forms.ts) validates against these same
 * constants, so UI input can never reach assertValidSet and trip it.
 */
export const SET_RULES = {
  repsMin: 1,
  repsMax: 36,
  weightMinKg: 0,
  weightMaxKg: 1500,
} as const;

/**
 * The activities CHECK bounds (migrations/0001_init.sql plus
 * migrations/0003_hardening.sql) in one place. The SQL CHECKs remain
 * authoritative; the form layer validates against these same constants,
 * so UI input can never reach assertValidActivity and trip it.
 */
export const ACTIVITY_RULES = {
  durationMin: 0,
  durationMax: 1440,
  climbGradeValueMin: 0,
  climbGradeValueMax: 16,
  routesSentMin: 0,
} as const;

/**
 * The body_stats CHECK bounds (migrations/0003_hardening.sql). Body
 * weight must be strictly positive; 0 kg is not a plausible human weight
 * and the CHECK says so, unlike set weights which allow 0 for
 * bodyweight work.
 */
export const BODY_RULES = {
  weightMinKgExclusive: 0,
  weightMaxKg: 1500,
  bodyfatMinPct: 0,
  bodyfatMaxPct: 100,
} as const;

/**
 * The routine_entries target bounds in one place, mirroring the
 * `RULE_CONSTANTS.routine` tree generated from `crates/db`
 * (`packages/api-types/src/rules.generated.ts`). `target_sets` and
 * `target_reps` carry no SQL CHECK of their own, so these bounds are the
 * shared contract the form layer and the repo guard enforce;
 * `target_weight_kg` mirrors the `routine_entries_target_weight_kg_range`
 * CHECK (null or strictly positive).
 */
export const ROUTINE_RULES = {
  targetSetsMin: 1,
  targetSetsMax: 20,
  targetRepsMin: 1,
  targetRepsMax: 36,
  targetWeightMinKgExclusive: 0,
  targetWeightMaxKg: 1500,
} as const;

/** Routine name bounds after trimming (the DB only requires NOT NULL). */
export const ROUTINE_NAME_MIN_LENGTH = 1;
export const ROUTINE_NAME_MAX_LENGTH = 60;

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

export type ActivityCheck = {
  local_date: string;
  duration_min: number | null;
  distance_km: number | null;
  elevation_m: number | null;
  climb_grade_value: number | null;
  routes_sent: number | null;
};

export type BodyStatCheck = {
  local_date: string;
  weight_kg: number | null;
  bodyfat_pct: number | null;
  neck_cm: number | null;
  shoulders_cm: number | null;
  chest_cm: number | null;
  bicep_cm: number | null;
  waist_cm: number | null;
  hips_cm: number | null;
  thigh_cm: number | null;
  calf_cm: number | null;
};

export type RoutineCheck = {
  name: string;
  notes: string | null;
};

export type RoutineEntryCheck = {
  order_index: number;
  target_sets: number;
  target_reps: number;
  target_weight_kg: number | null;
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
  const { repsMin, repsMax, weightMinKg, weightMaxKg } = SET_RULES;
  if (!Number.isInteger(set.reps) || set.reps < repsMin || set.reps > repsMax) {
    issues.push(`reps must be an integer in ${repsMin}..${repsMax} (got ${set.reps})`);
  }
  if (typeof set.weight_kg !== "number" || !Number.isFinite(set.weight_kg)) {
    issues.push(`weight_kg must be a finite number (got ${set.weight_kg})`);
  } else if (set.weight_kg < weightMinKg || set.weight_kg > weightMaxKg) {
    issues.push(`weight_kg must be in ${weightMinKg}..${weightMaxKg} (got ${set.weight_kg})`);
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

function finiteOrNullIssue(
  issues: string[],
  field: string,
  value: number | null,
  minExclusive: boolean,
  min: number,
  max: number,
): void {
  if (value === null) {
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push(`${field} must be null or a finite number (got ${value})`);
    return;
  }
  const below = minExclusive ? value <= min : value < min;
  if (below || value > max) {
    const lower = minExclusive ? `> ${min}` : `>= ${min}`;
    issues.push(`${field} must be null or ${lower} and <= ${max} (got ${value})`);
  }
}

/**
 * activities: local_date is a bare calendar day, duration_min null or
 * 0..1440, climb_grade_value null or 0..16 (the V-scale clamp), and
 * routes_sent null or >= 0. distance_km and elevation_m must be null or
 * finite.
 */
export function assertValidActivity(activity: ActivityCheck): void {
  const issues: string[] = [];
  const rules = ACTIVITY_RULES;
  if (typeof activity.local_date !== "string" || !LOCAL_DATE_PATTERN.test(activity.local_date)) {
    issues.push(`local_date must match YYYY-MM-DD (got ${activity.local_date})`);
  }
  if (activity.duration_min !== null) {
    if (
      !Number.isInteger(activity.duration_min) ||
      activity.duration_min < rules.durationMin ||
      activity.duration_min > rules.durationMax
    ) {
      issues.push(
        `duration_min must be null or an integer in ${rules.durationMin}..${rules.durationMax} (got ${activity.duration_min})`,
      );
    }
  }
  if (activity.distance_km !== null && !Number.isFinite(activity.distance_km)) {
    issues.push(`distance_km must be null or a finite number (got ${activity.distance_km})`);
  }
  if (activity.elevation_m !== null && !Number.isFinite(activity.elevation_m)) {
    issues.push(`elevation_m must be null or a finite number (got ${activity.elevation_m})`);
  }
  if (activity.climb_grade_value !== null) {
    if (
      !Number.isFinite(activity.climb_grade_value) ||
      activity.climb_grade_value < rules.climbGradeValueMin ||
      activity.climb_grade_value > rules.climbGradeValueMax
    ) {
      issues.push(
        `climb_grade_value must be null or in ${rules.climbGradeValueMin}..${rules.climbGradeValueMax} (got ${activity.climb_grade_value})`,
      );
    }
  }
  if (activity.routes_sent !== null) {
    if (!Number.isInteger(activity.routes_sent) || activity.routes_sent < rules.routesSentMin) {
      issues.push(
        `routes_sent must be null or an integer >= ${rules.routesSentMin} (got ${activity.routes_sent})`,
      );
    }
  }
  if (issues.length > 0) {
    fail("activity", issues);
  }
}

/**
 * body_stats: local_date is a bare calendar day, weight_kg strictly
 * positive and at most 1500, bodyfat_pct in 0..100, and every
 * circumference null or finite. All measurements are nullable: a day
 * logs only what was measured.
 */
export function assertValidBodyStat(stat: BodyStatCheck): void {
  const issues: string[] = [];
  const rules = BODY_RULES;
  if (typeof stat.local_date !== "string" || !LOCAL_DATE_PATTERN.test(stat.local_date)) {
    issues.push(`local_date must match YYYY-MM-DD (got ${stat.local_date})`);
  }
  finiteOrNullIssue(
    issues,
    "weight_kg",
    stat.weight_kg,
    true,
    rules.weightMinKgExclusive,
    rules.weightMaxKg,
  );
  finiteOrNullIssue(
    issues,
    "bodyfat_pct",
    stat.bodyfat_pct,
    false,
    rules.bodyfatMinPct,
    rules.bodyfatMaxPct,
  );
  const circumferences: Array<[string, number | null]> = [
    ["neck_cm", stat.neck_cm],
    ["shoulders_cm", stat.shoulders_cm],
    ["chest_cm", stat.chest_cm],
    ["bicep_cm", stat.bicep_cm],
    ["waist_cm", stat.waist_cm],
    ["hips_cm", stat.hips_cm],
    ["thigh_cm", stat.thigh_cm],
    ["calf_cm", stat.calf_cm],
  ];
  for (const [field, value] of circumferences) {
    if (value === null) {
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      issues.push(`${field} must be null or a finite number (got ${value})`);
    }
  }
  if (issues.length > 0) {
    fail("body stat", issues);
  }
}

/**
 * routines: name is required and 1..60 characters after trimming; notes is
 * optional (null or a string). The DB only enforces NOT NULL on name, so
 * the length bound is the client contract.
 */
export function assertValidRoutine(routine: RoutineCheck): void {
  const issues: string[] = [];
  if (typeof routine.name !== "string") {
    issues.push(`name must be a string (got ${routine.name})`);
  } else {
    const trimmed = routine.name.trim();
    if (trimmed.length < ROUTINE_NAME_MIN_LENGTH || trimmed.length > ROUTINE_NAME_MAX_LENGTH) {
      issues.push(
        `name must be ${ROUTINE_NAME_MIN_LENGTH}..${ROUTINE_NAME_MAX_LENGTH} characters after trimming (got ${trimmed.length})`,
      );
    }
  }
  if (!(routine.notes === null || typeof routine.notes === "string")) {
    issues.push(`notes must be null or a string (got ${routine.notes})`);
  }
  if (issues.length > 0) {
    fail("routine", issues);
  }
}

/**
 * routine_entries: order_index integer >= 0, target_sets and target_reps
 * are integers within the shared bounds, and target_weight_kg is null or
 * strictly positive and at most 1500 (the SQL CHECK).
 */
export function assertValidRoutineEntry(entry: RoutineEntryCheck): void {
  const issues: string[] = [];
  const rules = ROUTINE_RULES;
  if (!Number.isInteger(entry.order_index) || entry.order_index < 0) {
    issues.push(`order_index must be an integer >= 0 (got ${entry.order_index})`);
  }
  if (
    !Number.isInteger(entry.target_sets) ||
    entry.target_sets < rules.targetSetsMin ||
    entry.target_sets > rules.targetSetsMax
  ) {
    issues.push(
      `target_sets must be an integer in ${rules.targetSetsMin}..${rules.targetSetsMax} (got ${entry.target_sets})`,
    );
  }
  if (
    !Number.isInteger(entry.target_reps) ||
    entry.target_reps < rules.targetRepsMin ||
    entry.target_reps > rules.targetRepsMax
  ) {
    issues.push(
      `target_reps must be an integer in ${rules.targetRepsMin}..${rules.targetRepsMax} (got ${entry.target_reps})`,
    );
  }
  finiteOrNullIssue(
    issues,
    "target_weight_kg",
    entry.target_weight_kg,
    true,
    rules.targetWeightMinKgExclusive,
    rules.targetWeightMaxKg,
  );
  if (issues.length > 0) {
    fail("routine entry", issues);
  }
}
