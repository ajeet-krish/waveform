/**
 * User adoption: rebasing a device's Phase 1 local log onto the account
 * the server just assigned.
 *
 * Phase 1 ran with no backend: the device made up a user id for its
 * local_profile row and stamped it onto every synced row that carries an
 * owner field. Once signup or login hands back a real user id, that
 * local data must be rebased in one transaction or the first push would
 * carry ids the server rejects.
 *
 * Ownership lives only where the schema puts it: `exercises.owner_id`
 * (null marks a global catalog row, which stays global) and `user_id`
 * on workout_sessions, activities, and body_stats. exercise_entries and
 * set_entries have no owner column of their own; they scope through
 * their parent rows, so rewriting the parents re-scopes them too.
 *
 * Two strategies, chosen by the engine (pass 2): adoptLocalUser keeps
 * the data and rewrites its ownership, adoptStartEmpty wipes the synced
 * stores and starts clean under the account. Both are idempotent and
 * both mark the device with `adopted_user_id` so needsAdoption stops
 * asking.
 */

import type { WaveformDb } from "../../db/schema";
import type { OutboxRowMap } from "../../db/types";
import { ADOPTED_USER_ID_KEY, PULL_CURSOR_PREFIX, getMeta, setMeta } from "./meta";
import { ForeignOwnerError, classifyOwnership } from "./ownership";

/** What one adoption run did. */
export type AdoptionSummary = {
  /** False when the device was already adopted for this user (no-op). */
  adopted: boolean;
  /** Synced rows whose owner/user id was rewritten. */
  rowsRewritten: number;
  /** Outbox payloads whose owner/user id was rewritten. */
  opsRewritten: number;
  /** True when the local_profile row's id was replaced. */
  profileRewritten: boolean;
};

/** What an adoptStartEmpty run wiped. */
export type StartEmptySummary = {
  /** Rows removed across the owned synced stores plus the child tables. */
  rowsWiped: number;
  /** Outbox ops removed. */
  opsWiped: number;
  /** Device-local climb_sends rows removed. */
  sendsWiped: number;
  /** `pull_cursor:*` keys removed from sync_meta. */
  cursorsCleared: number;
  /** True when the local_profile row's id was replaced. */
  profileRewritten: boolean;
};

/**
 * True when this device's data is not yet attributed to `userId`: the
 * `adopted_user_id` marker is absent or names someone else. A brand-new
 * device also reports true (adopting it rewrites nothing), which keeps
 * the engine's decision to a single question.
 */
export async function needsAdoption(db: WaveformDb, userId: string): Promise<boolean> {
  const adopted = await getMeta(db, ADOPTED_USER_ID_KEY);
  return adopted !== userId;
}

/**
 * Re-puts the local_profile row under the new id (delete + put, since
 * the id is the primary key). Returns true when a row was rewritten.
 */
async function rewriteProfile(db: WaveformDb, userId: string): Promise<boolean> {
  const profiles = await db.local_profile.toArray();
  let rewritten = false;
  for (const profile of profiles) {
    if (profile.id !== userId) {
      await db.local_profile.delete(profile.id);
      // The snapshot above can predate a row under the target id; clear
      // it too so the re-key put never lands on top of a stale twin.
      await db.local_profile.delete(userId);
      await db.local_profile.put({ ...profile, id: userId });
      rewritten = true;
    }
  }
  return rewritten;
}

/**
 * Rebases the whole local log onto `userId` in ONE rw transaction over
 * the synced stores, outbox, local_profile, and sync_meta: rewrites
 * `owner_id` on custom exercises (catalog rows keep owner_id null),
 * `user_id` on workout_sessions, activities, and body_stats, and the
 * same fields inside every queued outbox payload, then re-keys
 * local_profile and stamps `adopted_user_id`. Idempotent: when the
 * device is already adopted for this user it touches nothing and
 * reports adopted false. Writes NO new outbox ops (ownership is
 * bookkeeping, not a user edit).
 *
 * Refuses outright when the device holds another account's log: the
 * first thing the transaction does is classifyOwnership, and a "foreign"
 * verdict throws ForeignOwnerError before any row is modified. An
 * unadopted device's own pre-account log classifies as "mine", so the
 * normal upload path is unchanged.
 */
export async function adoptLocalUser(db: WaveformDb, userId: string): Promise<AdoptionSummary> {
  return db.transaction(
    "rw",
    [
      db.exercises,
      db.workout_sessions,
      db.exercise_entries,
      db.set_entries,
      db.activities,
      db.body_stats,
      db.outbox,
      db.local_profile,
      db.sync_meta,
    ],
    async () => {
      // Hard guard before any modification: this device may not adopt a
      // log that belongs to someone else.
      const ownership = await classifyOwnership(db, userId);
      if (ownership.kind === "foreign") {
        throw new ForeignOwnerError(ownership.ownerIds);
      }

      if ((await getMeta(db, ADOPTED_USER_ID_KEY)) === userId) {
        return {
          adopted: false,
          rowsRewritten: 0,
          opsRewritten: 0,
          profileRewritten: false,
        };
      }

      let rows = 0;
      await db.exercises.toCollection().modify((row) => {
        if (row.owner_id !== null && row.owner_id !== userId) {
          row.owner_id = userId;
          rows += 1;
        }
      });
      await db.workout_sessions.toCollection().modify((row) => {
        if (row.user_id !== userId) {
          row.user_id = userId;
          rows += 1;
        }
      });
      await db.activities.toCollection().modify((row) => {
        if (row.user_id !== userId) {
          row.user_id = userId;
          rows += 1;
        }
      });
      await db.body_stats.toCollection().modify((row) => {
        if (row.user_id !== userId) {
          row.user_id = userId;
          rows += 1;
        }
      });

      let opsRewritten = 0;
      await db.outbox.toCollection().modify((op) => {
        if (op.entity === "exercises") {
          const payload = op.payload as OutboxRowMap["exercises"];
          if (payload.owner_id !== null && payload.owner_id !== userId) {
            payload.owner_id = userId;
            opsRewritten += 1;
          }
        } else if (
          op.entity === "workout_sessions" ||
          op.entity === "activities" ||
          op.entity === "body_stats"
        ) {
          const payload = op.payload as { user_id: string };
          if (payload.user_id !== userId) {
            payload.user_id = userId;
            opsRewritten += 1;
          }
        }
      });

      const profileRewritten = await rewriteProfile(db, userId);
      await setMeta(db, ADOPTED_USER_ID_KEY, userId);

      return { adopted: true, rowsRewritten: rows, opsRewritten, profileRewritten };
    },
  );
}

/**
 * Starts this device clean under `userId` in ONE rw transaction: wipes
 * every synced store, the outbox, and the device-local climb_sends
 * histogram, clears every `pull_cursor:*` key (a fresh account starts
 * pulling from the tip), re-keys local_profile, and stamps
 * `adopted_user_id`. workout_drafts and non-cursor sync_meta keys are
 * kept: an unsaved draft is in-progress user intent, not synced state.
 * Writes NO outbox ops; the caller should re-run ensureCatalog because
 * the exercises wipe also removed the global catalog rows.
 *
 * Idempotent: when the device is already adopted for this user it wipes
 * nothing and reports every count zero, so a duplicate call cannot drop
 * data downloaded after the first adoption.
 */
export async function adoptStartEmpty(db: WaveformDb, userId: string): Promise<StartEmptySummary> {
  return db.transaction(
    "rw",
    [
      db.exercises,
      db.workout_sessions,
      db.exercise_entries,
      db.set_entries,
      db.activities,
      db.body_stats,
      db.outbox,
      db.climb_sends,
      db.local_profile,
      db.sync_meta,
    ],
    async () => {
      if ((await getMeta(db, ADOPTED_USER_ID_KEY)) === userId) {
        return {
          rowsWiped: 0,
          opsWiped: 0,
          sendsWiped: 0,
          cursorsCleared: 0,
          profileRewritten: false,
        };
      }
      let rowsWiped = 0;
      for (const table of [
        db.exercises,
        db.workout_sessions,
        db.exercise_entries,
        db.set_entries,
        db.activities,
        db.body_stats,
      ]) {
        rowsWiped += await table.count();
        await table.clear();
      }
      const opsWiped = await db.outbox.count();
      await db.outbox.clear();
      const sendsWiped = await db.climb_sends.count();
      await db.climb_sends.clear();
      const cursorsCleared = await db.sync_meta.where("key").startsWith(PULL_CURSOR_PREFIX).delete();

      const profileRewritten = await rewriteProfile(db, userId);
      await setMeta(db, ADOPTED_USER_ID_KEY, userId);

      return { rowsWiped, opsWiped, sendsWiped, cursorsCleared, profileRewritten };
    },
  );
}
