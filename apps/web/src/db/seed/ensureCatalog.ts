/**
 * Idempotent bootstrap of the global exercise catalog.
 *
 * Documented exception to the outbox contract: catalog rows are
 * server-owned (owner_id null), so seeding them locally writes NO outbox
 * ops. The server already has the same rows from
 * migrations/0002_seed_catalog.sql; pushing them back would be pointless
 * and could collide on the lower(name) unique key. The reconcile step is
 * the same exception for the same reason: the server already retired
 * those rows in migrations/0004_catalog_cleanup.sql, so mirroring the
 * tombstone locally needs no op either.
 */

import type { Exercise } from "@waveform/api-types";
import type { WaveformDb } from "../schema";
import type { LocalRow } from "../types";
import { CATALOG_REMOVED_NAMES, CATALOG_SEED } from "./catalog";
import { catalogSeedId } from "./uuidV5";

/** Lowercased retired names, prepared once for the reconcile scan. */
const REMOVED_LOWER_NAMES: ReadonlySet<string> = new Set(
  CATALOG_REMOVED_NAMES.map((name) => name.toLowerCase()),
);

/**
 * Seeds CATALOG_SEED when the device has no catalog rows yet, then
 * reconciles the names retired by the 0004 catalog cleanup: any live
 * global row (owner_id null) named in CATALOG_REMOVED_NAMES is
 * soft-deleted by stamping deleted_at and updated_at to the same ISO
 * instant. Devices that seeded the pre-cleanup 118-row list converge on
 * the 111 live rows on every bootstrap; fresh devices seed the reduced
 * list and find nothing to reconcile.
 *
 * Returns the number of rows inserted (0 when the catalog already
 * exists); reconciled tombstones are not counted.
 *
 * Runs no transaction: seeding and reconciling are two independent
 * idempotent steps, each a single bulkPut, so a crash between them is
 * finished by the next call. The reconcile only reads owner_id null rows
 * that are still live, so it is idempotent, never touches custom
 * exercises, and writes NO outbox ops. History resolves exercise names
 * from raw rows including tombstones, so retiring a name this way keeps
 * the display name on old entries.
 */
export async function ensureCatalog(
  db: WaveformDb,
  now: () => Date = () => new Date(),
): Promise<number> {
  const iso = now().toISOString();

  const existing = await db.exercises.filter((row) => row.owner_id === null).count();
  let inserted = 0;
  if (existing === 0) {
    const rows: LocalRow<Exercise>[] = [];
    for (const seed of CATALOG_SEED) {
      rows.push({
        id: await catalogSeedId(seed.name),
        owner_id: null,
        name: seed.name,
        muscle_group: seed.muscle_group,
        equipment: seed.equipment,
        created_at: iso,
        updated_at: iso,
        deleted_at: null,
      });
    }
    await db.exercises.bulkPut(rows);
    inserted = rows.length;
  }

  await reconcileRetired(db, iso);
  return inserted;
}

/**
 * Tombstones live global rows whose name the 0004 cleanup retired.
 * Returns how many rows were tombstoned (0 when nothing is stale).
 */
async function reconcileRetired(db: WaveformDb, iso: string): Promise<number> {
  const stale = await db.exercises
    .filter(
      (row) =>
        row.owner_id === null &&
        row.deleted_at === null &&
        REMOVED_LOWER_NAMES.has(row.name.toLowerCase()),
    )
    .toArray();
  if (stale.length === 0) {
    return 0;
  }
  const tombstones: LocalRow<Exercise>[] = [];
  for (const row of stale) {
    tombstones.push({ ...row, updated_at: iso, deleted_at: iso });
  }
  await db.exercises.bulkPut(tombstones);
  return tombstones.length;
}
