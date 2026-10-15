/**
 * Local-first data core entry point.
 *
 * Exposes the app-wide IndexedDB singleton plus a helper that builds the
 * repo set for the device's stored profile. No UI code is wired to this
 * module yet (sub-phase 1a adds the data core only).
 */

import { createWaveformDb } from "./schema";
import { createRepos, type Repos } from "./repos";
import { LocalValidationError } from "./validation";

/** App-wide IndexedDB singleton. Opening is lazy on first query. */
export const db = createWaveformDb("waveform");

/**
 * Builds the repos for the signed-in user. The local_profile row is the
 * source of the user id on this device; without one, there is nothing to
 * scope synced rows to yet.
 *
 * @throws LocalValidationError when no local profile row exists.
 */
export async function createDefaultRepos(): Promise<Repos> {
  const profiles = await db.local_profile.toArray();
  const profile = profiles[0];
  if (!profile) {
    throw new LocalValidationError("no local profile");
  }
  return createRepos(db, { userId: profile.id });
}

export { createWaveformDb, type WaveformDb } from "./schema";
export { createRepos, type Repos, type RepoDeps } from "./repos";
export { ensureCatalog } from "./seed/ensureCatalog";
export { CATALOG_SEED } from "./seed/catalog";
export { catalogSeedId } from "./seed/uuidV5";
export { createLocalQuery, observeQuery, type LocalQuery } from "./query";
export { LocalValidationError } from "./validation";
export { buildOutboxOp, createOutboxRepo, type OutboxRepo } from "./outbox";
export type {
  LocalProfile,
  LocalRow,
  OutboxAction,
  OutboxEntity,
  OutboxOp,
  OutboxRowMap,
  SetEntryWrite,
  SyncMetaRow,
  WorkoutDraft,
  WorkoutDraftEntry,
  WorkoutDraftSet,
} from "./types";
