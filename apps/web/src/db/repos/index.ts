/**
 * Repository factory: one call wires every local-first repo to a shared
 * WaveformDb and the caller's deps (signed-in user id plus an injectable
 * clock).
 */

import { createOutboxRepo, type OutboxRepo } from "../outbox";
import type { WaveformDb } from "../schema";
import { createDraftRepo, type DraftRepo } from "./drafts";
import { createExerciseRepo, type ExerciseRepo } from "./exercises";
import { createProfileRepo, type ProfileRepo } from "./profile";
import { createWorkoutRepo, type WorkoutRepo } from "./workouts";
import type { RepoDeps } from "./deps";

export type { RepoDeps } from "./deps";
export type { DraftRepo } from "./drafts";
export type { ExerciseRepo } from "./exercises";
export type { ProfileRepo } from "./profile";
export type { WorkoutRepo } from "./workouts";

export type Repos = {
  exercises: ExerciseRepo;
  workouts: WorkoutRepo;
  drafts: DraftRepo;
  profile: ProfileRepo;
  outbox: OutboxRepo;
};

export function createRepos(db: WaveformDb, deps: RepoDeps): Repos {
  return {
    exercises: createExerciseRepo(db, deps),
    workouts: createWorkoutRepo(db, deps),
    drafts: createDraftRepo(db, deps),
    profile: createProfileRepo(db, deps),
    outbox: createOutboxRepo(db),
  };
}
