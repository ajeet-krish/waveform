/**
 * Body repository: the signed-in user's body-stat entries.
 *
 * Body stats are owner-private and one live row per local_date.
 * upsertBodyStat enforces that: patching a date that already has a live
 * row merges the patch into it (undefined keeps the existing value, null
 * clears it) and queues one update op; a date with no live row (never
 * logged, or only tombstoned) gets a fresh uuid row and one create op.
 *
 * Transactional contract, same as the other repos: every mutating
 * function performs all of its row writes AND all of its outbox appends
 * inside ONE `db.transaction("rw", db.body_stats, db.outbox, ...)`.
 * Deletes are soft: the row is re-put with `deleted_at = updated_at =
 * now` and the delete op carries the full tombstoned row.
 */

import type { BodyStats } from "@waveform/api-types";
import { buildOutboxOp } from "../outbox";
import type { WaveformDb } from "../schema";
import type { LocalRow, OutboxOp } from "../types";
import { assertValidBodyStat, LocalValidationError } from "../validation";
import { nowDate, type RepoDeps } from "./deps";

/** Fields a body-stat write may carry; omitted fields keep their value. */
export type BodyStatFields = {
  weight_kg?: number | null;
  bodyfat_pct?: number | null;
  neck_cm?: number | null;
  shoulders_cm?: number | null;
  chest_cm?: number | null;
  bicep_cm?: number | null;
  waist_cm?: number | null;
  hips_cm?: number | null;
  thigh_cm?: number | null;
  calf_cm?: number | null;
};

export type BodyStatInput = BodyStatFields & {
  local_date: string;
};

export type BodyStatMutation = {
  row: LocalRow<BodyStats>;
  op: OutboxOp<"body_stats">;
};

export type BodyStatRepo = {
  /**
   * Creates or updates the body-stat entry for one local_date. A live
   * row for the date is patched in place (undefined keeps, null clears)
   * with one update op; otherwise a fresh uuid row gets one create op.
   * Always leaves exactly one live row for the date.
   */
  upsertBodyStat(input: BodyStatInput): Promise<BodyStatMutation>;
  /** Live entries whose local_date falls in [from, to], local_date asc. */
  listRange(from: string, to: string): Promise<LocalRow<BodyStats>[]>;
  /** Every live entry, local_date desc then id desc. */
  listAll(): Promise<LocalRow<BodyStats>[]>;
  /** Tombstones an entry with one delete op; throws when missing. */
  remove(id: string): Promise<OutboxOp[]>;
};

function mergeField<T>(patched: T | undefined, existing: T): T {
  return patched !== undefined ? patched : existing;
}

export function createBodyRepo(db: WaveformDb, deps: RepoDeps): BodyStatRepo {
  return {
    upsertBodyStat(input: BodyStatInput): Promise<BodyStatMutation> {
      const now = nowDate(deps);
      const iso = now.toISOString();
      return db.transaction("rw", db.body_stats, db.outbox, async () => {
        const forDate = await db.body_stats.where("local_date").equals(input.local_date).toArray();
        const liveRows = forDate.filter((row) => row.deleted_at === null);
        // Own row first: a date the signed-in user already logged patches
        // that row. Only when they have none does a foreign live row on the
        // date refuse the write, keeping one live row per date.
        const own = liveRows.find((row) => row.user_id === deps.userId);
        if (own) {
          const row: LocalRow<BodyStats> = {
            ...own,
            weight_kg: mergeField(input.weight_kg, own.weight_kg),
            bodyfat_pct: mergeField(input.bodyfat_pct, own.bodyfat_pct),
            neck_cm: mergeField(input.neck_cm, own.neck_cm),
            shoulders_cm: mergeField(input.shoulders_cm, own.shoulders_cm),
            chest_cm: mergeField(input.chest_cm, own.chest_cm),
            bicep_cm: mergeField(input.bicep_cm, own.bicep_cm),
            waist_cm: mergeField(input.waist_cm, own.waist_cm),
            hips_cm: mergeField(input.hips_cm, own.hips_cm),
            thigh_cm: mergeField(input.thigh_cm, own.thigh_cm),
            calf_cm: mergeField(input.calf_cm, own.calf_cm),
            updated_at: iso,
          };
          assertValidBodyStat(row);
          const op = buildOutboxOp("body_stats", "update", row, now);
          await db.body_stats.put(row);
          await db.outbox.add(op);
          return { row, op };
        }
        const foreign = liveRows.find((row) => row.user_id !== deps.userId);
        if (foreign) {
          throw new LocalValidationError(
            "this body stat belongs to another account",
            [`body stat ${foreign.id} is owned by another account`],
          );
        }
        const row: LocalRow<BodyStats> = {
          id: crypto.randomUUID(),
          user_id: deps.userId,
          local_date: input.local_date,
          weight_kg: input.weight_kg ?? null,
          bodyfat_pct: input.bodyfat_pct ?? null,
          neck_cm: input.neck_cm ?? null,
          shoulders_cm: input.shoulders_cm ?? null,
          chest_cm: input.chest_cm ?? null,
          bicep_cm: input.bicep_cm ?? null,
          waist_cm: input.waist_cm ?? null,
          hips_cm: input.hips_cm ?? null,
          thigh_cm: input.thigh_cm ?? null,
          calf_cm: input.calf_cm ?? null,
          created_at: iso,
          updated_at: iso,
          deleted_at: null,
        };
        assertValidBodyStat(row);
        const op = buildOutboxOp("body_stats", "create", row, now);
        await db.body_stats.put(row);
        await db.outbox.add(op);
        return { row, op };
      });
    },

    async listRange(from: string, to: string): Promise<LocalRow<BodyStats>[]> {
      const rows = await db.body_stats
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

    async listAll(): Promise<LocalRow<BodyStats>[]> {
      const rows = await db.body_stats.toArray();
      const live = rows.filter((row) => row.deleted_at === null);
      live.sort((a, b) => {
        if (a.local_date !== b.local_date) {
          return a.local_date < b.local_date ? 1 : -1;
        }
        if (a.id === b.id) {
          return 0;
        }
        return a.id < b.id ? 1 : -1;
      });
      return live;
    },

    remove(id: string): Promise<OutboxOp[]> {
      const now = nowDate(deps);
      const iso = now.toISOString();
      return db.transaction("rw", db.body_stats, db.outbox, async () => {
        const existing = await db.body_stats.get(id);
        if (!existing) {
          throw new LocalValidationError(`body stat not found: ${id}`);
        }
        if (existing.deleted_at !== null) {
          return [];
        }
        if (existing.user_id !== deps.userId) {
          throw new LocalValidationError(
            "this body stat belongs to another account",
            [`body stat ${id} is owned by another account`],
          );
        }
        const tomb: LocalRow<BodyStats> = { ...existing, updated_at: iso, deleted_at: iso };
        const op = buildOutboxOp("body_stats", "delete", tomb, now);
        await db.body_stats.put(tomb);
        await db.outbox.add(op);
        return [op];
      });
    },
  };
}
