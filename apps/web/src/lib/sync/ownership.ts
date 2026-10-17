/**
 * Shared-device ownership: deciding whose training log a device holds,
 * and removing exactly one account's copy from it.
 *
 * A device may be shared or handed down, so the log sitting in IndexedDB
 * can belong to a different account than the one signing in now. Two
 * questions come out of that: is this device free to adopt the signed-in
 * account (classifyOwnership), and how does one account's data leave the
 * device without touching another's (wipeAccountDataFromDevice).
 *
 * Ownership lives only where the schema stamps it. `OWNERSHIP_SOURCES`
 * names every owner-bearing field so a new store cannot be added to the
 * schema without an explicit decision here. The device's own pre-account
 * identity is its `local_profile.id`: with no adoption marker, rows
 * stamped with that id are this device's own log, not another account's,
 * so they are adoptable. Once `adopted_user_id` names an account, every
 * stamp must name that account or the sign-in is refused.
 */

import { LocalValidationError } from "../../db";
import type { WaveformDb } from "../../db/schema";
import type { OutboxOp } from "../../db/types";
import {
  ADOPTED_USER_ID_KEY,
  CONFLICT_LOG_KEY,
  FULL_PULL_PENDING_KEY,
  LAST_FULL_PULL_AT_KEY,
  LAST_SYNCED_AT_KEY,
  PULL_CURSOR_PREFIX,
  getMeta,
} from "./meta";

/**
 * The kind of place an owner stamp lives: a synced row's owner column, a
 * queued op's payload, or a device-level marker.
 */
export type OwnershipStampKind = "row-owner" | "outbox-payload" | "device-marker";

/** One owner-bearing source on the device. */
export type OwnershipSource = {
  /** Dotted path to the owner field. */
  path: string;
  kind: OwnershipStampKind;
  /** What the stamp identifies. */
  meaning: string;
};

/**
 * Every owner-bearing source on the device, in one place. A new synced
 * store with an owner column must be added here (and to
 * classifyOwnership / wipeAccountDataFromDevice) so no owner can be
 * silently forgotten.
 */
export const OWNERSHIP_SOURCES: readonly OwnershipSource[] = [
  {
    path: "exercises.owner_id",
    kind: "row-owner",
    meaning: "custom exercise owner; null marks the shared global catalog",
  },
  {
    path: "workout_sessions.user_id",
    kind: "row-owner",
    meaning: "workout session owner (entries and sets scope through it)",
  },
  {
    path: "activities.user_id",
    kind: "row-owner",
    meaning: "activity owner (climb_sends scope through it)",
  },
  {
    path: "body_stats.user_id",
    kind: "row-owner",
    meaning: "body stat owner",
  },
  {
    path: "routines.user_id",
    kind: "row-owner",
    meaning: "routine owner (routine_entries scope through it)",
  },
  {
    path: "outbox.payload.owner_id",
    kind: "outbox-payload",
    meaning: "owner inside a queued custom-exercise op",
  },
  {
    path: "outbox.payload.user_id",
    kind: "outbox-payload",
    meaning: "owner inside a queued session, activity, body-stat, or routine op",
  },
  {
    path: "sync_meta.adopted_user_id",
    kind: "device-marker",
    meaning: "the account this device was adopted onto",
  },
  {
    path: "local_profile.id",
    kind: "device-marker",
    meaning: "this device's own profile identity (pre-account until adopted)",
  },
];

/**
 * What this device holds for the signed-in account. `unknown` is the
 * fail-closed state: the ownership read itself failed, so the device
 * cannot be trusted to be this account's and sync must not start.
 */
export type DeviceOwnership =
  | { kind: "fresh" }
  | { kind: "mine" }
  | { kind: "foreign"; ownerIds: string[] }
  | { kind: "unknown" };

/**
 * True while the app must not present the normal write screens or bind
 * repos to the device's stored profile: this device holds another
 * account's log ("foreign"), or its ownership could not be read
 * ("unknown"). Signed out (null) and a device's own log (fresh or mine)
 * are writable.
 */
export function isWriteBlocked(ownership: DeviceOwnership | null): boolean {
  return ownership?.kind === "foreign" || ownership?.kind === "unknown";
}

/**
 * Raised when a sign-in would adopt a log that belongs to another
 * account. Extends the repo validation error so existing error handling
 * (a message and an issues list) carries it unchanged.
 */
export class ForeignOwnerError extends LocalValidationError {
  /** The distinct owner ids that do not belong to the signed-in account. */
  readonly ownerIds: string[];

  constructor(ownerIds: string[]) {
    super("This device holds a training log belonging to another account.", [
      `foreign owner ids: ${ownerIds.length > 0 ? ownerIds.join(", ") : "unknown"}`,
    ]);
    this.name = "ForeignOwnerError";
    this.ownerIds = ownerIds;
  }
}

/** Reads an owner stamp off a queued op's payload; null when it has none. */
function outboxOwnerId(op: OutboxOp): string | null {
  const payload = op.payload as { owner_id?: unknown; user_id?: unknown };
  const owner = op.entity === "exercises" ? payload.owner_id : payload.user_id;
  return typeof owner === "string" && owner.length > 0 ? owner : null;
}

type OwnerStamps = Map<string, string[]>;

function addStamp(stamps: OwnerStamps, ownerId: string | null | undefined, source: string): void {
  if (typeof ownerId !== "string" || ownerId.length === 0) {
    return;
  }
  const sources = stamps.get(ownerId);
  if (sources === undefined) {
    stamps.set(ownerId, [source]);
  } else if (!sources.includes(source)) {
    sources.push(source);
  }
}

/**
 * Every distinct owner id on the device and the sources that carry it.
 * Global catalog exercises (owner_id null) are deliberately skipped: they
 * are shared, not owned.
 */
async function collectOwnerStamps(db: WaveformDb): Promise<OwnerStamps> {
  const stamps: OwnerStamps = new Map();
  for (const row of await db.exercises.toArray()) {
    addStamp(stamps, row.owner_id, "exercises.owner_id");
  }
  for (const row of await db.workout_sessions.toArray()) {
    addStamp(stamps, row.user_id, "workout_sessions.user_id");
  }
  for (const row of await db.activities.toArray()) {
    addStamp(stamps, row.user_id, "activities.user_id");
  }
  for (const row of await db.body_stats.toArray()) {
    addStamp(stamps, row.user_id, "body_stats.user_id");
  }
  for (const row of await db.routines.toArray()) {
    addStamp(stamps, row.user_id, "routines.user_id");
  }
  for (const op of await db.outbox.toArray()) {
    addStamp(
      stamps,
      outboxOwnerId(op),
      op.entity === "exercises" ? "outbox.payload.owner_id" : "outbox.payload.user_id",
    );
  }
  return stamps;
}

/**
 * Classifies what this device holds for `userId`:
 *
 * - "fresh": no owner stamps at all and no adoption marker, so there is
 *   nothing to protect (an empty device, with or without a profile row).
 * - "mine": the adoption marker names `userId`, or every observed owner
 *   stamp is the account itself or this device's own unclaimed
 *   `local_profile.id` (the pre-account identity adoption rebases).
 * - "foreign": some owner stamp names someone else, or the device is
 *   already adopted to a different account. `ownerIds` lists the
 *   distinct non-matching ids.
 */
export async function classifyOwnership(
  db: WaveformDb,
  userId: string,
): Promise<DeviceOwnership> {
  const profileRows = await db.local_profile.toArray();
  const profileId = profileRows[0]?.id ?? null;
  const adopted = await getMeta(db, ADOPTED_USER_ID_KEY);
  const marker = typeof adopted === "string" && adopted.length > 0 ? adopted : null;
  const stamps = await collectOwnerStamps(db);
  const ownerIds = [...stamps.keys()];

  // Identities that count as "this device's own right now": the account
  // signing in, plus its unclaimed pre-account profile id. Once a marker
  // exists the profile id is pinned to that account, so it is not added.
  const accepted = new Set<string>([userId]);
  if (marker === null && profileId !== null) {
    accepted.add(profileId);
  }

  const foreignIds = ownerIds.filter((id) => !accepted.has(id));
  if (foreignIds.length > 0) {
    return { kind: "foreign", ownerIds: foreignIds };
  }
  if (marker !== null && marker !== userId) {
    // The device is claimed by another account even if it looks empty.
    return { kind: "foreign", ownerIds: [marker] };
  }
  if (marker === userId) {
    return { kind: "mine" };
  }
  if (ownerIds.length === 0) {
    return { kind: "fresh" };
  }
  return { kind: "mine" };
}

/**
 * True when this device's own identity is `userId`, mirroring the "mine"
 * verdict of classifyOwnership: the adoption marker names it, or no
 * marker exists and every owner stamp is either the account or this
 * device's unclaimed pre-account profile id. Device-local scratch (the
 * marker, cursors, conflict log, drafts, sync stamps) belongs to the
 * account only in those cases; on a foreign panel's sign-out the marker
 * names someone else and that scratch must survive so the next sign-in
 * still classifies the log as foreign.
 */
async function deviceOwnedByUser(db: WaveformDb, userId: string): Promise<boolean> {
  const marker = await getMeta(db, ADOPTED_USER_ID_KEY);
  const markerId = typeof marker === "string" && marker.length > 0 ? marker : null;
  if (markerId !== null) {
    return markerId === userId;
  }
  const profileRows = await db.local_profile.toArray();
  const profileId = profileRows[0]?.id ?? null;
  const stamps = await collectOwnerStamps(db);
  return [...stamps.keys()].every((id) => id === userId || id === profileId);
}

/**
 * Removes one account's data from this device in ONE rw transaction, via
 * direct table deletes that never go through the repos, so the wipe
 * queues no outbox ops and cannot be pushed anywhere.
 *
 * Deleted: custom exercises owned by `userId`; `workout_sessions` owned
 * by `userId` plus their `exercise_entries` and `set_entries`;
 * `activities` owned by `userId` plus their `climb_sends`; `body_stats`
 * owned by `userId`; `routines` owned by `userId` plus their
 * `routine_entries`; and queued outbox ops whose payload owner is
 * `userId` (and child ops scoped through a deleted parent).
 *
 * Device-local scratch is cleared ONLY when the device actually belongs
 * to `userId` (deviceOwnedByUser): the `adopted_user_id` marker, every
 * `pull_cursor:*` key, `conflict_log`, `workout_drafts`, `last_synced_at`,
 * `last_full_pull_at`, and `full_pull_pending`. On a foreign panel's
 * sign-out the marker names another account, so all of it survives and
 * the next sign-in still classifies the remaining log as foreign.
 *
 * KEPT on purpose in every case: `local_profile` (device config: display
 * name and units) and the `sync_meta` `api_base_url` override (device
 * config), so a returning user is not forced to re-onboard or re-enter
 * the address. Global catalog exercises (owner_id null) are shared and
 * stay too.
 */
export async function wipeAccountDataFromDevice(
  db: WaveformDb,
  userId: string,
): Promise<void> {
  await db.transaction(
    "rw",
    [
      db.exercises,
      db.workout_sessions,
      db.exercise_entries,
      db.set_entries,
      db.activities,
      db.body_stats,
      db.routines,
      db.routine_entries,
      db.outbox,
      db.climb_sends,
      db.workout_drafts,
      db.local_profile,
      db.sync_meta,
    ],
    async () => {
      // Decide before any delete: the gate reads the surviving owner
      // stamps, and the marker must still be in place.
      const owned = await deviceOwnedByUser(db, userId);

      // Custom exercises owned by the user; catalog rows (owner_id null)
      // are shared and stay.
      const exerciseIds = (await db.exercises.where("owner_id").equals(userId).toArray()).map(
        (row) => row.id,
      );
      await db.exercises.bulkDelete(exerciseIds);

      // Sessions plus their entries and sets, scoped through the parents.
      const sessionIds = (await db.workout_sessions
        .filter((row) => row.user_id === userId)
        .toArray()).map((row) => row.id);
      const sessionIdSet = new Set(sessionIds);
      const entries =
        sessionIds.length > 0
          ? await db.exercise_entries.where("workout_id").anyOf(sessionIds).toArray()
          : [];
      const entryIds = entries.map((row) => row.id);
      const entryIdSet = new Set(entryIds);
      if (entryIds.length > 0) {
        await db.set_entries.where("exercise_entry_id").anyOf(entryIds).delete();
      }
      if (sessionIds.length > 0) {
        await db.exercise_entries.where("workout_id").anyOf(sessionIds).delete();
        await db.workout_sessions.bulkDelete(sessionIds);
      }

      // Activities plus their device-local send histograms.
      const activityIds = (await db.activities
        .filter((row) => row.user_id === userId)
        .toArray()).map((row) => row.id);
      if (activityIds.length > 0) {
        await db.climb_sends.where("activity_id").anyOf(activityIds).delete();
        await db.activities.bulkDelete(activityIds);
      }

      // Body stats.
      const bodyIds = (await db.body_stats
        .filter((row) => row.user_id === userId)
        .toArray()).map((row) => row.id);
      await db.body_stats.bulkDelete(bodyIds);

      // Routines plus their entries, scoped through the parent routine.
      const routineIds = (await db.routines
        .filter((row) => row.user_id === userId)
        .toArray()).map((row) => row.id);
      const routineIdSet = new Set(routineIds);
      if (routineIds.length > 0) {
        await db.routine_entries.where("routine_id").anyOf(routineIds).delete();
        await db.routines.bulkDelete(routineIds);
      }

      // Queued ops that belong to the user, whether by an owner stamp in
      // the payload or by carrying a child row whose parent was deleted.
      const opIds: string[] = [];
      for (const op of await db.outbox.toArray()) {
        if (outboxOwnerId(op) === userId) {
          opIds.push(op.op_id);
          continue;
        }
        const payload = op.payload as {
          workout_id?: unknown;
          exercise_entry_id?: unknown;
          routine_id?: unknown;
        };
        if (
          op.entity === "exercise_entries" &&
          typeof payload.workout_id === "string" &&
          sessionIdSet.has(payload.workout_id)
        ) {
          opIds.push(op.op_id);
          continue;
        }
        if (
          op.entity === "set_entries" &&
          typeof payload.exercise_entry_id === "string" &&
          entryIdSet.has(payload.exercise_entry_id)
        ) {
          opIds.push(op.op_id);
          continue;
        }
        if (
          op.entity === "routine_entries" &&
          typeof payload.routine_id === "string" &&
          routineIdSet.has(payload.routine_id)
        ) {
          opIds.push(op.op_id);
        }
      }
      await db.outbox.bulkDelete(opIds);

      // Device-local scratch belongs to the account only when the device
      // is actually this account's. A foreign panel's sign-out leaves it
      // all in place so the next sign-in still classifies the log as
      // foreign. `local_profile` and `api_base_url` always stay.
      if (owned) {
        await db.workout_drafts.clear();
        await db.sync_meta.delete(ADOPTED_USER_ID_KEY);
        await db.sync_meta.delete(CONFLICT_LOG_KEY);
        await db.sync_meta.delete(LAST_SYNCED_AT_KEY);
        await db.sync_meta.delete(LAST_FULL_PULL_AT_KEY);
        await db.sync_meta.delete(FULL_PULL_PENDING_KEY);
        await db.sync_meta.where("key").startsWith(PULL_CURSOR_PREFIX).delete();
      }
    },
  );
}
