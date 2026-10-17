/**
 * Repository factory: one call wires every local-first repo to a shared
 * WaveformDb and the caller's deps (signed-in user id plus an injectable
 * clock).
 */

import { createOutboxRepo, type OutboxRepo } from "../outbox";
import type { WaveformDb } from "../schema";
import { createActivityRepo, type ActivityRepo } from "./activities";
import { createBodyRepo, type BodyStatRepo } from "./body";
import { createDraftRepo, type DraftRepo } from "./drafts";
import { createExerciseRepo, type ExerciseRepo } from "./exercises";
import { createProfileRepo, type ProfileRepo } from "./profile";
import { createRoutineRepo, type RoutineRepo } from "./routines";
import { createWorkoutRepo, type WorkoutRepo } from "./workouts";
import type { RepoDeps } from "./deps";

export type { RepoDeps } from "./deps";
export type { ActivityRepo } from "./activities";
export type { BodyStatRepo } from "./body";
export type { DraftRepo } from "./drafts";
export type { ExerciseRepo } from "./exercises";
export type { ProfileRepo } from "./profile";
export type { RoutineRepo } from "./routines";
export type { WorkoutRepo } from "./workouts";

export type Repos = {
  exercises: ExerciseRepo;
  workouts: WorkoutRepo;
  routines: RoutineRepo;
  drafts: DraftRepo;
  profile: ProfileRepo;
  activities: ActivityRepo;
  body: BodyStatRepo;
  outbox: OutboxRepo;
};

export function createRepos(db: WaveformDb, deps: RepoDeps): Repos {
  return {
    exercises: createExerciseRepo(db, deps),
    workouts: createWorkoutRepo(db, deps),
    routines: createRoutineRepo(db, deps),
    drafts: createDraftRepo(db, deps),
    profile: createProfileRepo(db, deps),
    activities: createActivityRepo(db, deps),
    body: createBodyRepo(db, deps),
    outbox: createOutboxRepo(db),
  };
}
