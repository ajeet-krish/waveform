/**
 * Profile repository: the device-local account row.
 *
 * Local-only in sub-phase 1a: save() writes no outbox op. A later sub-phase
 * will decide what of this row syncs (display name and avatar yes, email
 * and settings device-scoped).
 */

import type { WaveformDb } from "../schema";
import type { LocalProfile } from "../types";
import { nowDate, type RepoDeps } from "./deps";

export type ProfileRepo = {
  /** The profile row for deps.userId, if the device has one. */
  get(): Promise<LocalProfile | undefined>;
  /**
   * Stores the profile locally under deps.userId, stamping updated_at;
   * writes NO outbox op. The id is normalized to deps.userId so get()
   * always finds what save() wrote, whatever id the caller passed.
   */
  save(profile: LocalProfile): Promise<LocalProfile>;
};

export function createProfileRepo(db: WaveformDb, deps: RepoDeps): ProfileRepo {
  return {
    get(): Promise<LocalProfile | undefined> {
      return db.local_profile.get(deps.userId);
    },

    async save(profile: LocalProfile): Promise<LocalProfile> {
      const row: LocalProfile = {
        ...profile,
        id: deps.userId,
        updated_at: nowDate(deps).toISOString(),
      };
      await db.local_profile.put(row);
      return row;
    },
  };
}
