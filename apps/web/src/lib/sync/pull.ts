/**
 * Pull: cursor-paged download of server rows, merged locally with
 * last-write-wins.
 *
 * Entities are pulled in CLIENT_PULL_ORDER (parents before children, so
 * a fresh device never holds a set_entry whose exercise_entry has not
 * landed yet). Each entity resumes from its `pull_cursor:{entity}` key
 * and pages until the server reports the tip (`next_cursor` null); the
 * cursor is persisted in the SAME transaction as the page's merges, and
 * the tail page leaves the cursor unchanged (re-pulling the tail is
 * idempotent: a tie keeps the local row).
 *
 * The cursor is an optimization behind a full re-pull safety net: a row
 * whose `applied_at` is at or before a stored cursor is never revisited,
 * so a deleted-then-reminted cursor or a server-side clock step could in
 * principle hide a row. `dueForFullRepull` bounds that: once
 * FULL_REPULL_INTERVAL_MS has passed since the last completed full
 * re-pull, the next run walks all entities from the beginning. The walk
 * is resumable instead of storming: a due run sets `full_pull_pending`
 * and starts each entity from a null cursor WITHOUT deleting the stored
 * cursors (they are still written per page as usual), so an interrupted
 * attempt leaves the flag set and the next run degrades to a normal
 * incremental resume from those cursors. A complete run stamps
 * `last_full_pull_at` and clears the flag, whichever run finishes the
 * pending walk. The residual window within a run is one apply
 * transaction, since merges and their cursor move together.
 *
 * mergePullRow is pure LWW on `updated_at` parsed as instants: a
 * strictly newer incoming row wins, a tie keeps the local row. The
 * winner's payload is written with a plain put, never an outbox op:
 * pulled rows must not be pushed back. Before an incoming row wins, the
 * queued outbox ops for the same `(entity, id)` that it supersedes
 * (`op.updated_at <= incoming.updated_at`) are dropped and one entry is
 * appended to the `conflict_log` meta (capped at 200) so a conflict is
 * observable instead of silent.
 */

import type { PullPage, PullRow, SyncEntity } from "@waveform/api-types";
import type { WaveformDb } from "../../db/schema";
import type { LocalRow, OutboxEntity } from "../../db/types";
import type {
  Activity,
  BodyStats,
  Exercise,
  ExerciseEntry,
  Routine,
  RoutineEntry,
  SetEntry,
  WorkoutSession,
} from "@waveform/api-types";
import { ApiError } from "../api";
import {
  CONFLICT_LOG_KEY,
  FULL_PULL_PENDING_KEY,
  LAST_FULL_PULL_AT_KEY,
  LAST_SYNCED_AT_KEY,
  getLastFullPullAt,
  getMeta,
  pullCursorKey,
  setMeta,
} from "./meta";

/**
 * The pull entity order, parents first: an exercise before the routines
 * and sessions that use it, a routine before its entries, a session before
 * its entries, an entry before its sets. The eight client-known sync
 * entities; routines land here so a session's `routine_id` parent exists.
 */
export const CLIENT_PULL_ORDER: readonly OutboxEntity[] = [
  "exercises",
  "routines",
  "routine_entries",
  "workout_sessions",
  "exercise_entries",
  "set_entries",
  "activities",
  "body_stats",
];

/** How many conflict entries the log keeps (newest win). */
export const CONFLICT_LOG_CAP = 200;

/** How stale the last full re-pull may get before the next pull forces one. */
export const FULL_REPULL_INTERVAL_MS = 12 * 60 * 60 * 1000;

/**
 * True when a full re-pull is due: never run before, an unparseable
 * stamp, a stamp in the future (a backward clock step must not suppress
 * the safety net), or the last completed run is at least `intervalMs`
 * old. Pure so the schedule is testable without a database.
 */
export function dueForFullRepull(
  lastFullPullAt: string | null,
  now: Date,
  intervalMs: number = FULL_REPULL_INTERVAL_MS,
): boolean {
  if (lastFullPullAt === null) {
    return true;
  }
  const last = Date.parse(lastFullPullAt);
  if (Number.isNaN(last)) {
    return true;
  }
  if (last > now.getTime()) {
    return true;
  }
  return now.getTime() - last >= intervalMs;
}

/** One dropped-conflict record kept in sync_meta for observability. */
export type PullConflictEntry = {
  entity: OutboxEntity;
  id: string;
  /** Queued ops deleted because the incoming row superseded them. */
  dropped: number;
  incoming_updated_at: string;
  local_updated_at: string | null;
  /** When the merge recorded this entry. */
  at: string;
};

/** What one merged row did. */
export type MergePullResult = {
  /** True when the incoming row was written (newer, or absent locally). */
  merged: boolean;
  /** True when superseded queued ops were dropped. */
  conflict: boolean;
};

/** The pull surface the engine needs (a stub-able subset of ApiClient). */
export type SyncPullApi = {
  pull(params: { entity: SyncEntity; cursor?: string | null }): Promise<PullPage>;
};

export type PullAllParams = {
  db: WaveformDb;
  api: SyncPullApi;
  /** Clock for last_synced_at and conflict entries; defaults to now. */
  now?: Date;
  /**
   * Consulted at the top of every page iteration; a true answer returns
   * the partial result with `complete: false`, leaving already-merged
   * rows and their cursors in place (settled work stands).
   */
  shouldStop?: () => boolean;
};

export type PullAllResult = {
  /** Rows written across every entity in this run. */
  merged: number;
  /** Merges that dropped superseded queued ops. */
  conflicts: number;
  /** True when every entity reached the tip; false on an aborted run. */
  complete: boolean;
};

/**
 * Ranks an `updated_at` for LWW: parsed epoch milliseconds, so equal
 * instants compare equal however they are shaped. Unparseable ranks
 * oldest, keeping the order stable.
 */
function rank(value: unknown): number {
  if (typeof value !== "string") {
    return Number.NEGATIVE_INFINITY;
  }
  const epoch = Date.parse(value);
  return Number.isNaN(epoch) ? Number.NEGATIVE_INFINITY : epoch;
}

/** True when the entity is one the client stores locally. */
function isLocalEntity(entity: SyncEntity): entity is OutboxEntity {
  return (CLIENT_PULL_ORDER as readonly string[]).includes(entity);
}

/** The local row's id, read straight off the pulled payload. */
function payloadId(payload: Record<string, unknown>): string | undefined {
  const id = payload.id;
  return typeof id === "string" ? id : undefined;
}

/** Reads one local row for LWW comparison; undefined when absent. */
async function readLocal(
  db: WaveformDb,
  entity: OutboxEntity,
  id: string,
): Promise<{ updated_at: string } | undefined> {
  switch (entity) {
    case "exercises":
      return db.exercises.get(id);
    case "routines":
      return db.routines.get(id);
    case "routine_entries":
      return db.routine_entries.get(id);
    case "workout_sessions":
      return db.workout_sessions.get(id);
    case "exercise_entries":
      return db.exercise_entries.get(id);
    case "set_entries":
      return db.set_entries.get(id);
    case "activities":
      return db.activities.get(id);
    case "body_stats":
      return db.body_stats.get(id);
  }
}

/** Writes the pulled payload into its table with a plain put (no op). */
async function writePulled(
  db: WaveformDb,
  entity: OutboxEntity,
  row: PullRow,
): Promise<void> {
  const payload = { ...row.payload, id: row.id };
  switch (entity) {
    case "exercises":
      await db.exercises.put(payload as unknown as LocalRow<Exercise>);
      return;
    case "routines":
      await db.routines.put(payload as unknown as LocalRow<Routine>);
      return;
    case "routine_entries":
      await db.routine_entries.put(payload as unknown as LocalRow<RoutineEntry>);
      return;
    case "workout_sessions":
      await db.workout_sessions.put(payload as unknown as LocalRow<WorkoutSession>);
      return;
    case "exercise_entries":
      await db.exercise_entries.put(payload as unknown as LocalRow<ExerciseEntry>);
      return;
    case "set_entries":
      await db.set_entries.put(payload as unknown as LocalRow<SetEntry>);
      return;
    case "activities":
      await db.activities.put(payload as unknown as LocalRow<Activity>);
      return;
    case "body_stats":
      await db.body_stats.put(payload as unknown as LocalRow<BodyStats>);
      return;
  }
}

/** Drops queued ops the incoming row supersedes; returns how many. */
async function dropSupersededOps(
  db: WaveformDb,
  entity: OutboxEntity,
  id: string,
  incomingRank: number,
): Promise<number> {
  const stale = await db.outbox.filter((op) => {
    if (op.entity !== entity) {
      return false;
    }
    if (payloadId(op.payload) !== id) {
      return false;
    }
    return rank(op.updated_at) <= incomingRank;
  }).toArray();
  if (stale.length === 0) {
    return 0;
  }
  await db.outbox.bulkDelete(stale.map((op) => op.op_id));
  return stale.length;
}

/** Appends one conflict entry, keeping the newest CONFLICT_LOG_CAP. */
async function appendConflict(
  db: WaveformDb,
  entry: PullConflictEntry,
): Promise<void> {
  const current = await getMeta(db, CONFLICT_LOG_KEY);
  const log: PullConflictEntry[] = Array.isArray(current)
    ? (current as PullConflictEntry[])
    : [];
  log.push(entry);
  while (log.length > CONFLICT_LOG_CAP) {
    log.shift();
  }
  await setMeta(db, CONFLICT_LOG_KEY, log);
}

/**
 * Merges one pulled row into its local table with last-write-wins.
 * Runs inside its own rw transaction (which joins any enclosing pull
 * transaction over a subset of the same tables). Incoming strictly
 * newer: superseded queued ops are dropped (one conflict entry
 * appended), then the payload is written with no outbox op. Tie or
 * older: the local row is kept and queued ops are left alone.
 */
export async function mergePullRow(
  db: WaveformDb,
  row: PullRow,
  now: Date,
): Promise<MergePullResult> {
  if (!isLocalEntity(row.entity)) {
    return { merged: false, conflict: false };
  }
  const entity = row.entity;
  const id = row.id;
  const incomingRank = rank(row.payload.updated_at);

  return db.transaction(
    "rw",
    [
      db.exercises,
      db.routines,
      db.routine_entries,
      db.workout_sessions,
      db.exercise_entries,
      db.set_entries,
      db.activities,
      db.body_stats,
      db.outbox,
      db.sync_meta,
    ],
    async () => {
      const local = await readLocal(db, entity, id);
      if (local !== undefined && rank(local.updated_at) >= incomingRank) {
        // Tie keeps local: a re-pulled row never churns the log.
        return { merged: false, conflict: false };
      }

      const dropped = await dropSupersededOps(db, entity, id, incomingRank);
      if (dropped > 0) {
        await appendConflict(db, {
          entity,
          id,
          dropped,
          incoming_updated_at: typeof row.payload.updated_at === "string"
            ? row.payload.updated_at
            : "",
          local_updated_at: local?.updated_at ?? null,
          at: now.toISOString(),
        });
      }

      await writePulled(db, entity, row);
      return { merged: true, conflict: dropped > 0 };
    },
  );
}

/** Reads an entity's stored cursor; null when never pulled. */
async function readCursor(db: WaveformDb, entity: OutboxEntity): Promise<string | null> {
  const value = await getMeta(db, pullCursorKey(entity));
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Pulls every entity to the tip. Each entity resumes from its cursor
 * and pages until `next_cursor` is null; every page's merges and its
 * `next_cursor` persist land in ONE transaction, and the tail page
 * leaves the cursor unchanged. A due full re-pull (`dueForFullRepull`)
 * that is not already pending sets `full_pull_pending` and starts every
 * entity from a null cursor WITHOUT deleting the stored cursors; a run
 * that finds the flag already set resumes incrementally from them. When
 * all eight entities reach the tip, `last_synced_at` is stamped and, when
 * the run was (or finished) a full re-pull, `last_full_pull_at` is
 * stamped and `full_pull_pending` is cleared. An ApiError mid-run
 * (offline, timeout, auth-expired, 4xx/5xx) stops the run with complete
 * false; work already merged and cursors already persisted stand, so the
 * next pull resumes where this one broke. A due run that aborts leaves
 * the flag set and the stamp unset, so the next run degrades to an
 * incremental resume and eventually completes. A `shouldStop` answer
 * stops the run between pages the same way. Non-ApiError failures are
 * bugs and rethrow.
 */
export async function pullAll(params: PullAllParams): Promise<PullAllResult> {
  const { db, api, shouldStop } = params;
  const now = params.now ?? new Date();
  const totals: PullAllResult = { merged: 0, conflicts: 0, complete: false };

  const fullRepullDue = dueForFullRepull(await getLastFullPullAt(db), now);
  const fullPullPending = (await getMeta(db, FULL_PULL_PENDING_KEY)) === true;
  // Only a due run that is not already mid-walk starts from the top; a
  // pending run resumes incrementally so an interrupted attempt makes
  // progress instead of re-downloading everything.
  const startingFull = fullRepullDue && !fullPullPending;
  if (startingFull) {
    await setMeta(db, FULL_PULL_PENDING_KEY, true);
  }

  for (const entity of CLIENT_PULL_ORDER) {
    let cursor = startingFull ? null : await readCursor(db, entity);
    for (;;) {
      if (shouldStop?.() === true) {
        return totals;
      }
      let page: PullPage;
      try {
        page = await api.pull({ entity, cursor });
      } catch (cause) {
        if (cause instanceof ApiError) {
          return totals;
        }
        throw cause;
      }

      // One transaction per page: merges and the cursor move together,
      // so a crash can never persist a cursor past unmerged rows.
      await db.transaction(
        "rw",
        [
          db.exercises,
          db.routines,
          db.routine_entries,
          db.workout_sessions,
          db.exercise_entries,
          db.set_entries,
          db.activities,
          db.body_stats,
          db.outbox,
          db.sync_meta,
        ],
        async () => {
          for (const pulled of page.rows) {
            const outcome = await mergePullRow(db, pulled, now);
            if (outcome.merged) {
              totals.merged += 1;
            }
            if (outcome.conflict) {
              totals.conflicts += 1;
            }
          }
          if (page.next_cursor !== null) {
            await setMeta(db, pullCursorKey(entity), page.next_cursor);
          }
        },
      );

      if (page.next_cursor === null) {
        break;
      }
      cursor = page.next_cursor;
    }
  }

  await setMeta(db, LAST_SYNCED_AT_KEY, now.toISOString());
  if (startingFull || fullPullPending) {
    // This run either walked the whole log from the top or finished the
    // pending walk; either way the safety net is satisfied.
    await setMeta(db, LAST_FULL_PULL_AT_KEY, now.toISOString());
    await db.sync_meta.delete(FULL_PULL_PENDING_KEY);
  }
  totals.complete = true;
  return totals;
}
