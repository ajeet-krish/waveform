import type { Exercise } from "@waveform/api-types";
import { describe, expect, it } from "vitest";
import { createRepos } from "../repos";
import { createWaveformDb, type WaveformDb } from "../schema";
import type { LocalRow } from "../types";
import {
  CATALOG_REMOVED_NAMES,
  CATALOG_SEED,
  type CatalogSeedRow,
} from "./catalog";
import { ensureCatalog } from "./ensureCatalog";
import { catalogSeedId } from "./uuidV5";

const UUID_V5_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The seven names 0004 retires, with their 0002 muscle_group/equipment. */
const RETIRED_ROWS: readonly CatalogSeedRow[] = [
  { name: "Ab Wheel", muscle_group: "core", equipment: "other" },
  { name: "Chest Dips", muscle_group: "chest", equipment: "bodyweight" },
  { name: "Chin-ups", muscle_group: "back", equipment: "bodyweight" },
  { name: "Dumbbell Curl", muscle_group: "biceps", equipment: "dumbbell" },
  { name: "Dumbbell Row", muscle_group: "back", equipment: "dumbbell" },
  { name: "Incline Barbell Bench Press", muscle_group: "chest", equipment: "barbell" },
  { name: "Lateral Raise", muscle_group: "shoulders", equipment: "dumbbell" },
];

/** Timestamp stamped on the pre-cleanup rows, distinct from fixedNow(). */
const OLD_ISO = "2026-01-05T08:00:00.000Z";

function fixedNow(): () => Date {
  return () => new Date("2026-10-14T00:00:00.000Z");
}

/** Populates a device that seeded the pre-0004 catalog: 118 live global rows. */
async function seedPreCleanupCatalog(db: WaveformDb): Promise<void> {
  const rows: LocalRow<Exercise>[] = [];
  for (const seed of [...CATALOG_SEED, ...RETIRED_ROWS]) {
    rows.push({
      id: await catalogSeedId(seed.name),
      owner_id: null,
      name: seed.name,
      muscle_group: seed.muscle_group,
      equipment: seed.equipment,
      created_at: OLD_ISO,
      updated_at: OLD_ISO,
      deleted_at: null,
    });
  }
  await db.exercises.bulkPut(rows);
}

async function retiredId(name: string): Promise<string> {
  return catalogSeedId(name);
}

describe("ensureCatalog", () => {
  it("keeps the live seed at 111 rows: 118 in 0002 minus the seven retired names", () => {
    expect(CATALOG_SEED).toHaveLength(111);
    expect(CATALOG_REMOVED_NAMES).toHaveLength(7);
    expect(RETIRED_ROWS.map((row) => row.name)).toEqual([...CATALOG_REMOVED_NAMES]);
  });

  it("seeds an empty DB with every row, owner_id null, and zero outbox ops", async () => {
    const db = createWaveformDb(`ensure-empty-${crypto.randomUUID()}`);
    const inserted = await ensureCatalog(db, fixedNow());

    expect(inserted).toBe(CATALOG_SEED.length);
    const rows = await db.exercises.toArray();
    expect(rows).toHaveLength(CATALOG_SEED.length);
    expect(rows.every((row) => row.owner_id === null)).toBe(true);
    expect(rows.every((row) => row.deleted_at === null)).toBe(true);
    expect(rows.every((row) => row.created_at === "2026-10-14T00:00:00.000Z")).toBe(true);
    expect(rows.every((row) => row.updated_at === "2026-10-14T00:00:00.000Z")).toBe(true);
    expect(await db.outbox.count()).toBe(0);

    const firstSeed = CATALOG_SEED[0];
    expect(firstSeed).toBeDefined();
    if (firstSeed) {
      const stored = rows.find((row) => row.name === firstSeed.name);
      expect(stored?.id).toBe(await catalogSeedId(firstSeed.name));
      expect(stored?.muscle_group).toBe(firstSeed.muscle_group);
      expect(stored?.equipment).toBe(firstSeed.equipment);
    }
    db.close();
  });

  it("is idempotent: a second call inserts nothing and still writes no ops", async () => {
    const db = createWaveformDb(`ensure-twice-${crypto.randomUUID()}`);
    const first = await ensureCatalog(db, fixedNow());
    expect(first).toBe(CATALOG_SEED.length);

    const second = await ensureCatalog(db, fixedNow());
    expect(second).toBe(0);
    expect(await db.exercises.count()).toBe(CATALOG_SEED.length);
    expect(await db.outbox.count()).toBe(0);
    db.close();
  });

  it("seeds even when only custom (owned) exercises exist", async () => {
    const db = createWaveformDb(`ensure-custom-${crypto.randomUUID()}`);
    await db.exercises.put({
      id: crypto.randomUUID(),
      owner_id: "user-1",
      name: "Custom Curl",
      muscle_group: "biceps",
      equipment: "dumbbell",
      created_at: "2026-10-14T00:00:00.000Z",
      updated_at: "2026-10-14T00:00:00.000Z",
      deleted_at: null,
    });

    const inserted = await ensureCatalog(db, fixedNow());
    expect(inserted).toBe(CATALOG_SEED.length);
    expect(await db.exercises.count()).toBe(CATALOG_SEED.length + 1);
    expect(await db.outbox.count()).toBe(0);
    db.close();
  });

  it("reconciles a pre-cleanup device: the seven retired names leave listLive", async () => {
    const db = createWaveformDb(`ensure-reconcile-${crypto.randomUUID()}`);
    await seedPreCleanupCatalog(db);
    expect(await db.exercises.filter((row) => row.deleted_at === null).count()).toBe(118);

    const inserted = await ensureCatalog(db, fixedNow());
    expect(inserted).toBe(0);

    const repos = createRepos(db, { userId: "user-1" });
    const live = await repos.exercises.listLive();
    expect(live).toHaveLength(111);
    const liveNames = new Set(live.map((row) => row.name));
    for (const name of CATALOG_REMOVED_NAMES) {
      expect(liveNames.has(name), `retired "${name}" must be hidden from listLive`).toBe(false);
    }

    // Soft only: the tombstone keeps the row (and its name) for history.
    for (const name of CATALOG_REMOVED_NAMES) {
      const row = await db.exercises.get(await retiredId(name));
      expect(row, `tombstone row for "${name}" survives`).toBeDefined();
      expect(row?.deleted_at).toBe("2026-10-14T00:00:00.000Z");
      expect(row?.updated_at).toBe("2026-10-14T00:00:00.000Z");
    }
    db.close();
  });

  it("reconcile is idempotent: a later call rewrites nothing", async () => {
    const db = createWaveformDb(`ensure-reconcile-twice-${crypto.randomUUID()}`);
    await seedPreCleanupCatalog(db);
    await ensureCatalog(db, fixedNow());
    const afterFirst = await db.exercises.toArray();

    const later = await ensureCatalog(db, () => new Date("2026-10-20T00:00:00.000Z"));
    expect(later).toBe(0);

    const afterSecond = await db.exercises.toArray();
    // A rewrite would restamp the seven tombstones with the later clock.
    expect(afterSecond).toEqual(afterFirst);
    expect(await db.exercises.filter((row) => row.deleted_at === null).count()).toBe(111);
    db.close();
  });

  it("writes no outbox ops while reconciling a pre-cleanup device", async () => {
    const db = createWaveformDb(`ensure-reconcile-ops-${crypto.randomUUID()}`);
    await seedPreCleanupCatalog(db);
    await ensureCatalog(db, fixedNow());
    expect(await db.outbox.count()).toBe(0);
    db.close();
  });

  it("touches only the seven retired global rows: customs and the rest are untouched", async () => {
    const db = createWaveformDb(`ensure-reconcile-scope-${crypto.randomUUID()}`);
    await seedPreCleanupCatalog(db);
    // A custom exercise may reuse a retired name; it is never in scope.
    const custom: LocalRow<Exercise> = {
      id: crypto.randomUUID(),
      owner_id: "user-1",
      name: "Ab Wheel",
      muscle_group: "core",
      equipment: "other",
      created_at: OLD_ISO,
      updated_at: OLD_ISO,
      deleted_at: null,
    };
    await db.exercises.put(custom);

    const before = await db.exercises.toArray();
    await ensureCatalog(db, fixedNow());
    const after = await db.exercises.toArray();

    const beforeById = new Map(before.map((row) => [row.id, row]));
    const changedIds = after
      .filter((row) => JSON.stringify(row) !== JSON.stringify(beforeById.get(row.id)))
      .map((row) => row.id);
    const retiredIds = await Promise.all(CATALOG_REMOVED_NAMES.map((name) => retiredId(name)));
    expect(changedIds.sort()).toEqual(retiredIds.sort());

    expect(await db.exercises.get(custom.id)).toEqual(custom);
    const untouched = await db.exercises.get(await catalogSeedId("Bench Press (Barbell)"));
    expect(untouched?.deleted_at).toBeNull();
    expect(untouched?.updated_at).toBe(OLD_ISO);
    expect(await db.outbox.count()).toBe(0);
    db.close();
  });
});

describe("catalogSeedId", () => {
  it("is deterministic and normalized with lower(name)", async () => {
    const lower = await catalogSeedId("bench press (barbell)");
    expect(await catalogSeedId("bench press (barbell)")).toBe(lower);
    expect(await catalogSeedId("Bench Press (Barbell)")).toBe(lower);
    expect(await catalogSeedId("BENCH PRESS (BARBELL)")).toBe(lower);
    expect(await catalogSeedId("other exercise")).not.toBe(lower);
  });

  it("matches the UUIDv5 shape and the RFC 4122 DNS test vector", async () => {
    const id = await catalogSeedId("Bench Press (Barbell)");
    expect(id).toMatch(UUID_V5_PATTERN);
    // RFC 4122 appendix: UUIDv5 over the DNS namespace of "www.example.com".
    expect(await catalogSeedId("www.example.com")).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
  });
});
