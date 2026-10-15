/**
 * Idempotent bootstrap of the global exercise catalog.
 *
 * Documented exception to the outbox contract: catalog rows are
 * server-owned (owner_id null), so seeding them locally writes NO outbox
 * ops. The server already has the same rows from
 * migrations/0002_seed_catalog.sql; pushing them back would be pointless
 * and could collide on the lower(name) unique key. The reconcile step is
 * the same exception for the same reason: the server already hard-deleted
 * the duplicates in migrations/0005_catalog_dedup.sql, so converging
 * locally needs no op either.
 */

import type { Exercise } from "@waveform/api-types";
import type { WaveformDb } from "../schema";
import type { LocalRow } from "../types";
import { CATALOG_SEED, type CatalogSeedRow } from "./catalog";
import { catalogSeedId } from "./uuidV5";

/** The seed rows keyed by their deterministic UUIDv5 id. */
async function seedById(): Promise<Map<string, CatalogSeedRow>> {
  const byId = new Map<string, CatalogSeedRow>();
  for (const seed of CATALOG_SEED) {
    byId.set(await catalogSeedId(seed.name), seed);
  }
  return byId;
}

/**
 * Seeds CATALOG_SEED when the device has no catalog rows yet, then
 * reconciles the global catalog (owner_id null) to CATALOG_SEED exactly:
 * a global row whose id is not a seed id is HARD deleted (it is a
 * duplicate the 0005 dedup retired on the server), a missing seed row is
 * inserted, and a tombstoned seed row is restored (deleted_at null,
 * updated_at restamped). Live seed rows and every custom exercise
 * (owner_id set) are untouched. Devices that seeded the pre-dedup
 * 118-row list converge on the 91 live rows on every bootstrap; fresh
 * devices seed the reduced list and find nothing to reconcile.
 *
 * Returns the number of rows inserted by the initial seed (0 when the
 * catalog already exists); reconciled inserts, restores, and deletes are
 * not counted.
 *
 * Runs no transaction: seeding and reconciling are two independent
 * idempotent steps, each a bulk write, so a crash between them is
 * finished by the next call. The reconcile is idempotent by
 * construction (a second pass finds nothing out of place) and writes NO
 * outbox ops. History resolves exercise names from the live list and
 * falls back to "Unknown exercise", so a hard-deleted duplicate cannot
 * break an old session view.
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

  await reconcileToSeed(db, iso);
  return inserted;
}

/**
 * Makes the global catalog match CATALOG_SEED exactly: hard-deletes
 * non-seed global rows, inserts missing seed rows, and restores
 * tombstoned seed rows. Live seed rows and all custom rows are left
 * alone. Returns nothing; the writes are applied as at most one
 * bulkDelete plus one bulkPut.
 */
async function reconcileToSeed(db: WaveformDb, iso: string): Promise<void> {
  const seeds = await seedById();
  const globals = await db.exercises.filter((row) => row.owner_id === null).toArray();

  const strayIds: string[] = [];
  const presentIds = new Set<string>();
  const restorations: LocalRow<Exercise>[] = [];
  for (const row of globals) {
    if (!seeds.has(row.id)) {
      // A duplicate the 0005 dedup removed server-side: no tombstone remnants.
      strayIds.push(row.id);
      continue;
    }
    presentIds.add(row.id);
    if (row.deleted_at !== null) {
      restorations.push({ ...row, deleted_at: null, updated_at: iso });
    }
  }

  const missing: LocalRow<Exercise>[] = [];
  for (const [id, seed] of seeds) {
    if (!presentIds.has(id)) {
      missing.push({
        id,
        owner_id: null,
        name: seed.name,
        muscle_group: seed.muscle_group,
        equipment: seed.equipment,
        created_at: iso,
        updated_at: iso,
        deleted_at: null,
      });
    }
  }

  if (strayIds.length > 0) {
    await db.exercises.bulkDelete(strayIds);
  }
  if (restorations.length > 0 || missing.length > 0) {
    await db.exercises.bulkPut([...restorations, ...missing]);
  }
}
