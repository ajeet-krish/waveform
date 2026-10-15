/**
 * Idempotent bootstrap of the global exercise catalog.
 *
 * Documented exception to the outbox contract: catalog rows are
 * server-owned (owner_id null), so seeding them locally writes NO outbox
 * ops. The server already has the same rows from
 * migrations/0002_seed_catalog.sql; pushing them back would be pointless
 * and could collide on the lower(name) unique key.
 */

import type { Exercise } from "@waveform/api-types";
import type { WaveformDb } from "../schema";
import type { LocalRow } from "../types";
import { CATALOG_SEED } from "./catalog";
import { catalogSeedId } from "./uuidV5";

/**
 * Inserts every CATALOG_SEED row when the device has no catalog rows yet.
 * Returns the number of rows inserted (0 when the catalog already exists).
 *
 * Runs no transaction: a single bulkPut is atomic on its own, and no
 * outbox ops are appended.
 */
export async function ensureCatalog(
  db: WaveformDb,
  now: () => Date = () => new Date(),
): Promise<number> {
  const existing = await db.exercises.filter((row) => row.owner_id === null).count();
  if (existing > 0) {
    return 0;
  }

  const iso = now().toISOString();
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
  return rows.length;
}
