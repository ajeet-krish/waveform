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

/** Writes one sync_meta value (put, so it is idempotent). */
export async function setMeta(db: WaveformDb, key: string, value: unknown): Promise<void> {
  await db.sync_meta.put({ key, value });
}
