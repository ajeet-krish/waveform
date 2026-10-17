/**
 * Activity repository: cycling, climbing, running, hike, and swim
 * sessions plus the device-local climb_sends histogram.
 *
 * Transactional contract, same as the workout repo: every mutating
 * function performs all of its row writes AND all of its outbox appends
 * inside ONE `db.transaction("rw", <touched tables>, db.outbox, ...)`.
 * Deletes are soft: the row is re-put with `deleted_at = updated_at =
 * now` and the delete op carries the full tombstoned row. The
 * climb_sends row is device-local (it never enters the outbox; the
 * server derives V-points from the activity row's climb_grade_value and
 * routes_sent) and is hard-deleted when its activity is tombstoned.
 *
 * Climbing derivation lives in `toClimbFields`: the histogram's hardest
 * sent grade becomes climb_grade ("V5") and climb_grade_value (5), and
 * the histogram's total becomes routes_sent. Cycling, running, hike, and
 * swim rows keep those columns null and never write a climb_sends row.
 */

import type { Activity, ActivityType } from "@waveform/api-types";
import { hardestGrade, normalizeSendCounts, totalSends } from "../../lib/climbing";
import { buildOutboxOp } from "../outbox";
import type { WaveformDb } from "../schema";
import type { ClimbSends, LocalRow, OutboxOp } from "../types";
import { assertValidActivity, LocalValidationError } from "../validation";
import { nowDate, type RepoDeps } from "./deps";

export type ClimbLogInput = {
  type: "climbing";
  local_date: string;
  started_at?: string | null;
  duration_min?: number | null;
  notes?: string | null;
  /** Send histogram, indexed by integer V grade; normalized on write. */
  sends: readonly number[];
};

export type EnduranceLogInput = {
  type: "cycling" | "running" | "hike" | "swim";
  local_date: string;
  started_at?: string | null;
  duration_min?: number | null;
  distance_km?: number | null;
  elevation_m?: number | null;
  notes?: string | null;
};

export type ActivityLogInput = ClimbLogInput | EnduranceLogInput;

export type ActivityPatch = {
  local_date?: string;
  started_at?: string | null;
  duration_min?: number | null;
  distance_km?: number | null;
  elevation_m?: number | null;
  notes?: string | null;
  /** Climbing only: a replacement histogram; derived fields recompute. */
  sends?: readonly number[];
};

export type ActivityMutation = {
  row: LocalRow<Activity>;
  op: OutboxOp<"activities">;
  /** The histogram row for climbing writes; absent for cycling. */
  sends?: ClimbSends;
};

export type ClimbFields = {
  climb_grade: string | null;
  climb_grade_value: number | null;
  routes_sent: number | null;
};

/**
 * Derives the activity row's climbing summary columns from a send
 * histogram: the hardest grade with at least one send becomes
 * climb_grade ("V5") and climb_grade_value (5, an integer in 0..16), and
 * the histogram total becomes routes_sent. An empty histogram yields
 * null grades and routes_sent 0. Counts are normalized first, so any
 * caller-supplied array is safe.
 */
export function toClimbFields(counts: readonly number[]): ClimbFields {
  const normalized = normalizeSendCounts(counts);
  const grade = hardestGrade(normalized);
  return {
    climb_grade: grade === null ? null : `V${grade}`,
    climb_grade_value: grade,
    routes_sent: totalSends(normalized),
  };
}

export type ClimbLog = {
  activity: LocalRow<Activity>;
  /** The histogram row; undefined only if the row predates the repo. */
  sends: ClimbSends | undefined;
};

export type ActivityRepo = {
  /**
   * Logs one activity: cycling, running, hike, swim, or climbing.
   * Climbing derives its summary columns from `sends`, writes the
   * histogram row, and queues one create op whose payload is the activity
   * row exactly as the backend expects (no sends field). Endurance types
   * keep the climb columns null and store their distance and elevation.
   */
  logActivity(input: ActivityLogInput): Promise<ActivityMutation>;
  /**
   * Patches an activity; recomputes the derived climb columns when a
   * climbing row's sends change, and queues one update op. The patch
   * cannot move a row across types: `sends` is ignored for cycling
   * rows, and `distance_km`/`elevation_m` are ignored for climbing
   * rows, which keep null distance and elevation. Throws
   * LocalValidationError when the row is missing or tombstoned.
   */
  update(id: string, patch: ActivityPatch): Promise<ActivityMutation>;
  /**
   * Tombstones an activity (one delete op carrying the tombstone) and
   * hard-deletes its climb_sends row in the same transaction. A no-op
   * returning no ops when the row is missing or already tombstoned.
   */
  remove(id: string): Promise<OutboxOp[]>;
  /** Live activities of one type, local_date desc then id desc. */
  listByType(type: ActivityType): Promise<LocalRow<Activity>[]>;
  /** Live activities whose local_date falls in [from, to], both inclusive. */
  listByDateRange(from: string, to: string): Promise<LocalRow<Activity>[]>;
  /** Live climbing activities paired with their send histograms. */
  listClimbs(): Promise<ClimbLog[]>;
  /** The raw histogram row for one activity, if any. */
  getSends(activity_id: string): Promise<ClimbSends | undefined>;
};

function byDateDescThenIdDesc(a: LocalRow<Activity>, b: LocalRow<Activity>): number {
  if (a.local_date !== b.local_date) {
    return a.local_date < b.local_date ? 1 : -1;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? 1 : -1;
}

export function createActivityRepo(db: WaveformDb, deps: RepoDeps): ActivityRepo {
  return {
    async logActivity(input: ActivityLogInput): Promise<ActivityMutation> {
      const now = nowDate(deps);
      const iso = now.toISOString();
      const isClimb = input.type === "climbing";
      const climb = isClimb
        ? toClimbFields((input as ClimbLogInput).sends)
        : { climb_grade: null, climb_grade_value: null, routes_sent: null };
      const row: LocalRow<Activity> = {
        id: crypto.randomUUID(),
        user_id: deps.userId,
        type: input.type,
        local_date: input.local_date,
        started_at: input.started_at ?? null,
        duration_min: input.duration_min ?? null,
        distance_km: isClimb ? null : ((input as EnduranceLogInput).distance_km ?? null),
        elevation_m: isClimb ? null : ((input as EnduranceLogInput).elevation_m ?? null),
        climb_grade: climb.climb_grade,
        climb_grade_value: climb.climb_grade_value,
        routes_sent: climb.routes_sent,
        notes: input.notes ?? null,
        created_at: iso,
        updated_at: iso,
        deleted_at: null,
      };
      assertValidActivity(row);
      const sends: ClimbSends | undefined = isClimb
        ? {
            activity_id: row.id,
            counts: normalizeSendCounts((input as ClimbLogInput).sends),
            updated_at: iso,
          }
        : undefined;
      const op = buildOutboxOp("activities", "create", row, now);
      return db.transaction("rw", db.activities, db.climb_sends, db.outbox, async () => {
        await db.activities.put(row);
        if (sends) {
          await db.climb_sends.put(sends);
        }
        await db.outbox.add(op);
        return sends ? { row, op, sends } : { row, op };
      });
    },

    update(id: string, patch: ActivityPatch): Promise<ActivityMutation> {
      const now = nowDate(deps);
      const iso = now.toISOString();
      return db.transaction("rw", db.activities, db.climb_sends, db.outbox, async () => {
        const existing = await db.activities.get(id);
        if (!existing || existing.deleted_at !== null) {
          throw new LocalValidationError(`activity not found: ${id}`);
        }
        if (existing.user_id !== deps.userId) {
          throw new LocalValidationError(
            "this activity belongs to another account",
            [`activity ${id} is owned by another account`],
          );
        }
        // A patch cannot move a row across types: climbing rows keep
        // null distance/elevation, cycling rows keep null climb fields.
        const isClimb = existing.type === "climbing";
        const row: LocalRow<Activity> = {
          ...existing,
          local_date: patch.local_date ?? existing.local_date,
          started_at: patch.started_at !== undefined ? patch.started_at : existing.started_at,
          duration_min: patch.duration_min !== undefined ? patch.duration_min : existing.duration_min,
          distance_km: isClimb
            ? null
            : patch.distance_km !== undefined
              ? patch.distance_km
              : existing.distance_km,
          elevation_m: isClimb
            ? null
            : patch.elevation_m !== undefined
              ? patch.elevation_m
              : existing.elevation_m,
          notes: patch.notes !== undefined ? patch.notes : existing.notes,
          updated_at: iso,
        };
        const sendsPatch = isClimb && patch.sends !== undefined;
        if (sendsPatch) {
          const climb = toClimbFields(patch.sends ?? []);
          row.climb_grade = climb.climb_grade;
          row.climb_grade_value = climb.climb_grade_value;
          row.routes_sent = climb.routes_sent;
        }
        assertValidActivity(row);
        const op = buildOutboxOp("activities", "update", row, now);
        await db.activities.put(row);
        let sends: ClimbSends | undefined;
        if (sendsPatch) {
          sends = {
            activity_id: row.id,
            counts: normalizeSendCounts(patch.sends ?? []),
            updated_at: iso,
          };
          await db.climb_sends.put(sends);
        }
        await db.outbox.add(op);
        return sends ? { row, op, sends } : { row, op };
      });
    },

    remove(id: string): Promise<OutboxOp[]> {
      const now = nowDate(deps);
      const iso = now.toISOString();
      return db.transaction("rw", db.activities, db.climb_sends, db.outbox, async () => {
        const existing = await db.activities.get(id);
        if (!existing || existing.deleted_at !== null) {
          return [];
        }
        if (existing.user_id !== deps.userId) {
          throw new LocalValidationError(
            "this activity belongs to another account",
            [`activity ${id} is owned by another account`],
          );
        }
        const tomb: LocalRow<Activity> = { ...existing, updated_at: iso, deleted_at: iso };
        const op = buildOutboxOp("activities", "delete", tomb, now);
        await db.activities.put(tomb);
        await db.climb_sends.delete(id);
        await db.outbox.add(op);
        return [op];
      });
    },

    async listByType(type: ActivityType): Promise<LocalRow<Activity>[]> {
      const rows = await db.activities.where("type").equals(type).toArray();
      const live = rows.filter((row) => row.deleted_at === null);
      live.sort(byDateDescThenIdDesc);
      return live;
    },

    async listByDateRange(from: string, to: string): Promise<LocalRow<Activity>[]> {
      const rows = await db.activities
        .where("local_date")
        .between(from, to, true, true)
        .toArray();
      const live = rows.filter((row) => row.deleted_at === null);
      live.sort((a, b) => {
        if (a.local_date !== b.local_date) {
          return a.local_date < b.local_date ? -1 : 1;
        }
        return a.id.localeCompare(b.id);
      });
      return live;
    },

    async listClimbs(): Promise<ClimbLog[]> {
      const rows = await db.activities.where("type").equals("climbing").toArray();
      const live = rows.filter((row) => row.deleted_at === null);
      live.sort(byDateDescThenIdDesc);
      const logs: ClimbLog[] = [];
      for (const activity of live) {
        logs.push({ activity, sends: await db.climb_sends.get(activity.id) });
      }
      return logs;
    },

    getSends(activity_id: string): Promise<ClimbSends | undefined> {
      return db.climb_sends.get(activity_id);
    },
  };
}
