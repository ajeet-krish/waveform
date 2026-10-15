/**
 * The global exercise catalog, transcribed from
 * migrations/0002_seed_catalog.sql IN FILE ORDER, minus the 27 duplicate
 * names hard-deleted by migrations/0005_catalog_dedup.sql (listed in
 * CATALOG_REMOVED_NAMES below). 0002 seeds two naming sets; the first
 * set (rows 1 to 54, including "Ab Wheel") is kept and the plain-named
 * twins of the second set are gone, so the live catalog is the 91 rows
 * seen here.
 *
 * Order matters: the first entries are the original catalog names. The
 * parity test in catalogParity.test.ts parses both migrations
 * and fails if this array and the SQL ever drift apart in content or in
 * order, including a drift between this list and the dedup migration.
 */

export type CatalogSeedRow = {
  name: string;
  muscle_group: string;
  equipment: string | null;
};

export const CATALOG_SEED: readonly CatalogSeedRow[] = [
  { name: "Bench Press (Barbell)", muscle_group: "chest", equipment: "barbell" },
  { name: "Incline Bench Press (Barbell)", muscle_group: "chest", equipment: "barbell" },
  { name: "Bench Press (Dumbbell)", muscle_group: "chest", equipment: "dumbbell" },
  { name: "Incline Bench Press (Dumbbell)", muscle_group: "chest", equipment: "dumbbell" },
  { name: "Chest Fly (Dumbbell)", muscle_group: "chest", equipment: "dumbbell" },
  { name: "Cable Fly", muscle_group: "chest", equipment: "cable" },
  { name: "Machine Chest Press", muscle_group: "chest", equipment: "machine" },
  { name: "Push Up", muscle_group: "chest", equipment: "bodyweight" },
  { name: "Chest Dip", muscle_group: "chest", equipment: "bodyweight" },
  { name: "Deadlift (Barbell)", muscle_group: "back", equipment: "barbell" },
  { name: "Pull Up", muscle_group: "back", equipment: "bodyweight" },
  { name: "Chin Up", muscle_group: "back", equipment: "bodyweight" },
  { name: "Lat Pulldown", muscle_group: "back", equipment: "cable" },
  { name: "Bent Over Row (Barbell)", muscle_group: "back", equipment: "barbell" },
  { name: "Seated Cable Row", muscle_group: "back", equipment: "cable" },
  { name: "One-Arm Row (Dumbbell)", muscle_group: "back", equipment: "dumbbell" },
  { name: "T-Bar Row", muscle_group: "back", equipment: "barbell" },
  { name: "Face Pull", muscle_group: "back", equipment: "cable" },
  { name: "Back Extension", muscle_group: "back", equipment: "bodyweight" },
  { name: "Squat (Barbell)", muscle_group: "legs", equipment: "barbell" },
  { name: "Front Squat", muscle_group: "legs", equipment: "barbell" },
  { name: "Leg Press", muscle_group: "legs", equipment: "machine" },
  { name: "Romanian Deadlift", muscle_group: "legs", equipment: "barbell" },
  { name: "Lunge (Dumbbell)", muscle_group: "legs", equipment: "dumbbell" },
  { name: "Bulgarian Split Squat", muscle_group: "legs", equipment: "dumbbell" },
  { name: "Leg Extension", muscle_group: "legs", equipment: "machine" },
  { name: "Leg Curl", muscle_group: "legs", equipment: "machine" },
  { name: "Hip Thrust (Barbell)", muscle_group: "legs", equipment: "barbell" },
  { name: "Goblet Squat", muscle_group: "legs", equipment: "dumbbell" },
  { name: "Standing Calf Raise", muscle_group: "legs", equipment: "machine" },
  { name: "Seated Calf Raise", muscle_group: "legs", equipment: "machine" },
  { name: "Overhead Press (Barbell)", muscle_group: "shoulders", equipment: "barbell" },
  { name: "Shoulder Press (Dumbbell)", muscle_group: "shoulders", equipment: "dumbbell" },
  { name: "Lateral Raise (Dumbbell)", muscle_group: "shoulders", equipment: "dumbbell" },
  { name: "Rear Delt Fly", muscle_group: "shoulders", equipment: "dumbbell" },
  { name: "Front Raise", muscle_group: "shoulders", equipment: "dumbbell" },
  { name: "Arnold Press", muscle_group: "shoulders", equipment: "dumbbell" },
  { name: "Upright Row", muscle_group: "shoulders", equipment: "barbell" },
  { name: "Shrug (Dumbbell)", muscle_group: "shoulders", equipment: "dumbbell" },
  { name: "Bicep Curl (Dumbbell)", muscle_group: "biceps", equipment: "dumbbell" },
  { name: "Barbell Curl", muscle_group: "biceps", equipment: "barbell" },
  { name: "Hammer Curl", muscle_group: "biceps", equipment: "dumbbell" },
  { name: "Preacher Curl", muscle_group: "biceps", equipment: "machine" },
  { name: "Triceps Pushdown", muscle_group: "triceps", equipment: "cable" },
  { name: "Skullcrusher", muscle_group: "triceps", equipment: "barbell" },
  { name: "Overhead Triceps Extension", muscle_group: "triceps", equipment: "cable" },
  { name: "Close Grip Bench Press", muscle_group: "triceps", equipment: "barbell" },
  { name: "Triceps Dip", muscle_group: "triceps", equipment: "bodyweight" },
  { name: "Plank", muscle_group: "core", equipment: "bodyweight" },
  { name: "Crunch", muscle_group: "core", equipment: "bodyweight" },
  { name: "Hanging Leg Raise", muscle_group: "core", equipment: "bodyweight" },
  { name: "Cable Crunch", muscle_group: "core", equipment: "cable" },
  { name: "Russian Twist", muscle_group: "core", equipment: "bodyweight" },
  { name: "Ab Wheel", muscle_group: "core", equipment: "other" },
  { name: "Decline Barbell Bench Press", muscle_group: "chest", equipment: "barbell" },
  { name: "Decline Dumbbell Press", muscle_group: "chest", equipment: "dumbbell" },
  { name: "Incline Cable Fly", muscle_group: "chest", equipment: "cable" },
  { name: "Pec Deck Fly", muscle_group: "chest", equipment: "machine" },
  { name: "Pendlay Row", muscle_group: "back", equipment: "barbell" },
  { name: "Straight Arm Pulldown", muscle_group: "back", equipment: "cable" },
  { name: "Machine Row", muscle_group: "back", equipment: "machine" },
  { name: "Hack Squat", muscle_group: "legs", equipment: "machine" },
  { name: "Reverse Pec Deck", muscle_group: "shoulders", equipment: "machine" },
  { name: "Machine Shoulder Press", muscle_group: "shoulders", equipment: "machine" },
  { name: "EZ Bar Curl", muscle_group: "biceps", equipment: "barbell" },
  { name: "Incline Dumbbell Curl", muscle_group: "biceps", equipment: "dumbbell" },
  { name: "Concentration Curl", muscle_group: "biceps", equipment: "dumbbell" },
  { name: "Cable Curl", muscle_group: "biceps", equipment: "cable" },
  { name: "Machine Bicep Curl", muscle_group: "biceps", equipment: "machine" },
  { name: "Tricep Kickback", muscle_group: "triceps", equipment: "dumbbell" },
  { name: "Machine Tricep Extension", muscle_group: "triceps", equipment: "machine" },
  { name: "Side Plank", muscle_group: "core", equipment: "bodyweight" },
  { name: "Bicycle Crunch", muscle_group: "core", equipment: "bodyweight" },
  { name: "Dead Bug", muscle_group: "core", equipment: "bodyweight" },
  { name: "Running", muscle_group: "cardio", equipment: "other" },
  { name: "Cycling", muscle_group: "cardio", equipment: "other" },
  { name: "Swimming", muscle_group: "cardio", equipment: "other" },
  { name: "Rowing", muscle_group: "cardio", equipment: "machine" },
  { name: "Jump Rope", muscle_group: "cardio", equipment: "other" },
  { name: "Stair Climber", muscle_group: "cardio", equipment: "machine" },
  { name: "Elliptical", muscle_group: "cardio", equipment: "machine" },
  { name: "Walking", muscle_group: "cardio", equipment: "other" },
  { name: "Sumo Deadlift", muscle_group: "back", equipment: "barbell" },
  { name: "Power Clean", muscle_group: "back", equipment: "barbell" },
  { name: "Clean and Jerk", muscle_group: "back", equipment: "barbell" },
  { name: "Snatch", muscle_group: "back", equipment: "barbell" },
  { name: "Thruster", muscle_group: "legs", equipment: "barbell" },
  { name: "Yoga", muscle_group: "other", equipment: "other" },
  { name: "Climbing", muscle_group: "other", equipment: "other" },
  { name: "Stretching", muscle_group: "other", equipment: "other" },
  { name: "Foam Rolling", muscle_group: "other", equipment: "other" },
];

/**
 * Global catalog rows hard-deleted by migrations/0005_catalog_dedup.sql:
 * the second-set duplicates of first-set names (for example
 * "Flat Dumbbell Press" repeats "Bench Press (Dumbbell)"). Order is
 * alphabetical so the list is stable across edits. "Ab Wheel" is NOT
 * here: 0004 soft-deleted it, but 0005 restores the first-set row.
 *
 * 0005 hard-deletes these rows server-side; ensureCatalog mirrors the
 * same reconcile-to-seed on every call so devices that seeded the
 * pre-dedup 118-row list converge on the 91 live rows without touching
 * custom exercises and without writing outbox ops. History resolves
 * exercise names from the live list and falls back to "Unknown
 * exercise" for a row that is gone. catalogParity.test.ts asserts this
 * list against both migrations: every name must exist in 0002, and the
 * 0005 delete list must match here exactly, so neither side can drift
 * alone.
 */
export const CATALOG_REMOVED_NAMES: readonly string[] = [
  "Ab Wheel Rollout",
  "Back Squat",
  "Barbell Row",
  "Chest Dips",
  "Chin-ups",
  "Deadlift",
  "Dips (Tricep)",
  "Dumbbell Curl",
  "Dumbbell Fly",
  "Dumbbell Row",
  "Flat Barbell Bench Press",
  "Flat Dumbbell Press",
  "Hyperextension",
  "Incline Barbell Bench Press",
  "Incline Dumbbell Press",
  "Lateral Raise",
  "Overhead Press",
  "Overhead Tricep Extension",
  "Pull-ups",
  "Push-ups",
  "Seated Dumbbell Press",
  "Single Arm Dumbbell Row",
  "Skull Crushers",
  "Standing Dumbbell Press",
  "Stiff Leg Deadlift",
  "Tricep Pushdown",
  "Walking Lunges",
];
