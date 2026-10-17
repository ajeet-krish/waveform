/**
 * sync_meta accessors plus the key constants the sync engine shares.
 *
 * sync_meta is the device's sync bookkeeping store: cursor positions per
 * entity, the last successful pull stamp, the adoption marker, and the
 * conflict log. Keys are plain strings so an older app version can leave
 * keys a newer one understands (and vice versa); the pull cursor keys are
 * namespaced per entity so adding an entity never collides.
 */

import type { SyncEntity } from "@waveform/api-types";
import type { WaveformDb } from "../../db/schema";

/** Pull cursor key prefix; the entity name follows. */
export const PULL_CURSOR_PREFIX = "pull_cursor:";

/** Pull cursor key for one entity: `pull_cursor:{entity}`. */
export function pullCursorKey(entity: SyncEntity): string {
  return `${PULL_CURSOR_PREFIX}${entity}`;
}

/** ISO stamp of the last pull that reached every entity's tip. */
export const LAST_SYNCED_AT_KEY = "last_synced_at";

/**
 * ISO stamp of the last completed full re-pull (a run that walked every
 * entity from the beginning). The pull cursor is an optimization behind
 * this safety net: when the stamp is older than `FULL_REPULL_INTERVAL_MS`,
 * the next pull starts a full walk.
 */
export const LAST_FULL_PULL_AT_KEY = "last_full_pull_at";

/**
 * True while a due full re-pull has been started but not yet completed.
 * The walk runs from a null cursor per entity without deleting the
 * stored cursors, so an interrupted attempt degrades to an incremental
 * resume on the next run instead of re-downloading everything again.
 * Cleared, together with `last_full_pull_at`, by a complete run.
 */
export const FULL_PULL_PENDING_KEY = "full_pull_pending";

/** The user id whose rows this device now belongs to (adoption). */
export const ADOPTED_USER_ID_KEY = "adopted_user_id";

/** One-time flag: the Phase 1 outbox has been compacted at least once. */
export const OUTBOX_COMPACTED_V1_KEY = "outbox_compacted_v1";

/** The API base URL the user chose (settings override over env). */
export const API_BASE_URL_KEY = "api_base_url";

/** Capped ring of dropped-conflict entries from pull merges. */
export const CONFLICT_LOG_KEY = "conflict_log";

/** Reads one sync_meta value; undefined when the key was never written. */
export async function getMeta(db: WaveformDb, key: string): Promise<unknown> {
  const row = await db.sync_meta.get(key);
  return row?.value;
}

/**
 * Reads the last completed full re-pull stamp; null when it was never
 * written or is not a non-empty string.
 */
export async function getLastFullPullAt(db: WaveformDb): Promise<string | null> {
  const value = await getMeta(db, LAST_FULL_PULL_AT_KEY);
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Writes one sync_meta value (put, so it is idempotent). */
export async function setMeta(db: WaveformDb, key: string, value: unknown): Promise<void> {
  await db.sync_meta.put({ key, value });
}
