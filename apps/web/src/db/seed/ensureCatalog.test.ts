import type { Exercise } from "@waveform/api-types";
import { describe, expect, it } from "vitest";
import { createRepos } from "../repos";
import { createWaveformDb, type WaveformDb } from "../schema";
import type { LocalRow } from "../types";
import { CATALOG_REMOVED_NAMES, CATALOG_SEED, type CatalogSeedRow } from "./catalog";
import { ensureCatalog } from "./ensureCatalog";
import { catalogSeedId } from "./uuidV5";

const UUID_V5_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The 27 names 0005 hard-deletes, with their 0002 muscle_group/equipment.
 * Together with CATALOG_SEED these recreate the pre-dedup 118-row list.
 */
const REMOVED_ROWS: readonly CatalogSeedRow[] = [
  { name: "Ab Wheel Rollout", muscle_group: "core", equipment: "other" },
  { name: "Back Squat", muscle_group: "legs", equipment: "barbell" },
  { name: "Barbell Row", muscle_group: "back", equipment: "barbell" },
  { name: "Chest Dips", muscle_group: "chest", equipment: "bodyweight" },
  { name: "Chin-ups", muscle_group: "back", equipment: "bodyweight" },
  { name: "Deadlift", muscle_group: "back", equipment: "barbell" },
  { name: "Dips (Tricep)", muscle_group: "triceps", equipment: "bodyweight" },
  { name: "Dumbbell Curl", muscle_group: "biceps", equipment: "dumbbell" },
  { name: "Dumbbell Fly", muscle_group: "chest", equipment: "dumbbell" },
  { name: "Dumbbell Row", muscle_group: "back", equipment: "dumbbell" },
  { name: "Flat Barbell Bench Press", muscle_group: "chest", equipment: "barbell" },
  { name: "Flat Dumbbell Press", muscle_group: "chest", equipment: "dumbbell" },
  { name: "Hyperextension", muscle_group: "back", equipment: "bodyweight" },
  { name: "Incline Barbell Bench Press", muscle_group: "chest", equipment: "barbell" },
  { name: "Incline Dumbbell Press", muscle_group: "chest", equipment: "dumbbell" },
  { name: "Lateral Raise", muscle_group: "shoulders", equipment: "dumbbell" },
  { name: "Overhead Press", muscle_group: "shoulders", equipment: "barbell" },
  { name: "Overhead Tricep Extension", muscle_group: "triceps", equipment: "cable" },
  { name: "Pull-ups", muscle_group: "back", equipment: "bodyweight" },
  { name: "Push-ups", muscle_group: "chest", equipment: "bodyweight" },
  { name: "Seated Dumbbell Press", muscle_group: "shoulders", equipment: "dumbbell" },
  { name: "Single Arm Dumbbell Row", muscle_group: "back", equipment: "dumbbell" },
  { name: "Skull Crushers", muscle_group: "triceps", equipment: "barbell" },
  { name: "Standing Dumbbell Press", muscle_group: "shoulders", equipment: "dumbbell" },
  { name: "Stiff Leg Deadlift", muscle_group: "legs", equipment: "barbell" },
  { name: "Tricep Pushdown", muscle_group: "triceps", equipment: "cable" },
  { name: "Walking Lunges", muscle_group: "legs", equipment: "dumbbell" },
];

/** Timestamp stamped on the pre-dedup rows, distinct from fixedNow(). */
const OLD_ISO = "2026-01-05T08:00:00.000Z";

function fixedNow(): () => Date {
  return () => new Date("2026-10-14T00:00:00.000Z");
}

async function putGlobal(db: WaveformDb, seed: CatalogSeedRow, iso: string): Promise<string> {
  const id = await catalogSeedId(seed.name);
  await db.exercises.put({
    id,
    owner_id: null,
    name: seed.name,
    muscle_group: seed.muscle_group,
    equipment: seed.equipment,
    created_at: iso,
    updated_at: iso,
    deleted_at: null,
  });
  return id;
}

/** Populates a device that seeded the pre-dedup catalog: 118 live global rows. */
async function seedPreDedupCatalog(db: WaveformDb): Promise<void> {
  for (const seed of [...CATALOG_SEED, ...REMOVED_ROWS]) {
    await putGlobal(db, seed, OLD_ISO);
  }
}

async function removedId(name: string): Promise<string> {
  return catalogSeedId(name);
}

describe("ensureCatalog", () => {
  it("keeps the live seed at 91 rows: 118 in 0002 minus the 27 dedup names", () => {
    expect(CATALOG_SEED).toHaveLength(91);
    expect(CATALOG_REMOVED_NAMES).toHaveLength(27);
    expect(REMOVED_ROWS.map((row) => row.name)).toEqual([...CATALOG_REMOVED_NAMES]);
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

  it("reconciles a pre-dedup device: live catalog equals CATALOG_SEED exactly", async () => {
    const db = createWaveformDb(`ensure-reconcile-${crypto.randomUUID()}`);
    await seedPreDedupCatalog(db);
    expect(await db.exercises.filter((row) => row.deleted_at === null).count()).toBe(118);

    const inserted = await ensureCatalog(db, fixedNow());
    expect(inserted).toBe(0);

    const repos = createRepos(db, { userId: "user-1" });
    const live = await repos.exercises.listLive();
    expect(live).toHaveLength(CATALOG_SEED.length);
    const liveByName = new Map(live.map((row) => [row.name, row]));
    for (const seed of CATALOG_SEED) {
      const row = liveByName.get(seed.name);
      expect(row, `seed row "${seed.name}" stays live`).toBeDefined();
      expect(row?.id).toBe(await catalogSeedId(seed.name));
      expect(row?.muscle_group).toBe(seed.muscle_group);
      expect(row?.equipment).toBe(seed.equipment);
    }
    expect(await db.outbox.count()).toBe(0);
    db.close();
  });

  it("hard-deletes the 27 duplicates: no row, no tombstone remnant", async () => {
    const db = createWaveformDb(`ensure-hard-delete-${crypto.randomUUID()}`);
    await seedPreDedupCatalog(db);
    await ensureCatalog(db, fixedNow());

    expect(await db.exercises.count()).toBe(CATALOG_SEED.length);
    for (const name of CATALOG_REMOVED_NAMES) {
      const row = await db.exercises.get(await removedId(name));
      expect(row, `duplicate "${name}" must be hard-deleted, not tombstoned`).toBeUndefined();
    }
    db.close();
  });

  it("hard-deletes a stray global row that no seed id claims", async () => {
    const db = createWaveformDb(`ensure-stray-${crypto.randomUUID()}`);
    await ensureCatalog(db, fixedNow());
    const stray: LocalRow<Exercise> = {
      id: crypto.randomUUID(),
      owner_id: null,
      name: "Legacy Duplicate",
      muscle_group: "chest",
      equipment: "barbell",
      created_at: OLD_ISO,
      updated_at: OLD_ISO,
      deleted_at: null,
    };
    await db.exercises.put(stray);

    await ensureCatalog(db, fixedNow());
    expect(await db.exercises.get(stray.id)).toBeUndefined();
    expect(await db.exercises.count()).toBe(CATALOG_SEED.length);
    expect(await db.outbox.count()).toBe(0);
    db.close();
  });

  it("restores a tombstoned seed row to the live catalog", async () => {
    const db = createWaveformDb(`ensure-restore-${crypto.randomUUID()}`);
    await seedPreDedupCatalog(db);
    // The 0004 cleanup tombstoned first-set "Ab Wheel"; 0005 and the
    // reconcile restore it.
    const abWheelId = await catalogSeedId("Ab Wheel");
    const abWheel = await db.exercises.get(abWheelId);
    expect(abWheel).toBeDefined();
    if (!abWheel) {
      db.close();
      return;
    }
    await db.exercises.put({ ...abWheel, updated_at: OLD_ISO, deleted_at: OLD_ISO });
    expect(await db.exercises.filter((row) => row.deleted_at === null).count()).toBe(117);

    await ensureCatalog(db, fixedNow());

    const restored = await db.exercises.get(abWheelId);
    expect(restored?.deleted_at).toBeNull();
    expect(restored?.updated_at).toBe("2026-10-14T00:00:00.000Z");
    expect(restored?.name).toBe("Ab Wheel");
    const repos = createRepos(db, { userId: "user-1" });
    const liveNames = (await repos.exercises.listLive()).map((row) => row.name);
    expect(liveNames).toContain("Ab Wheel");
    expect(await db.outbox.count()).toBe(0);
    db.close();
  });

  it("reconcile is idempotent: a later call rewrites nothing", async () => {
    const db = createWaveformDb(`ensure-reconcile-twice-${crypto.randomUUID()}`);
    await seedPreDedupCatalog(db);
    await ensureCatalog(db, fixedNow());
    const afterFirst = await db.exercises.toArray();

    const later = await ensureCatalog(db, () => new Date("2026-10-20T00:00:00.000Z"));
    expect(later).toBe(0);

    const afterSecond = await db.exercises.toArray();
    // A rewrite would restamp rows with the later clock.
    expect(afterSecond).toEqual(afterFirst);
    expect(await db.exercises.filter((row) => row.deleted_at === null).count()).toBe(
      CATALOG_SEED.length,
    );
    db.close();
  });

  it("writes no outbox ops while reconciling a pre-dedup device", async () => {
    const db = createWaveformDb(`ensure-reconcile-ops-${crypto.randomUUID()}`);
    await seedPreDedupCatalog(db);
    await ensureCatalog(db, fixedNow());
    expect(await db.outbox.count()).toBe(0);
    db.close();
  });

  it("touches only the 27 duplicate global rows: customs and the rest are untouched", async () => {
    const db = createWaveformDb(`ensure-reconcile-scope-${crypto.randomUUID()}`);
    await seedPreDedupCatalog(db);
    // A custom exercise may reuse a duplicate name; it is never in scope.
    const custom: LocalRow<Exercise> = {
      id: crypto.randomUUID(),
      owner_id: "user-1",
      name: "Back Squat",
      muscle_group: "legs",
      equipment: "barbell",
      created_at: OLD_ISO,
      updated_at: OLD_ISO,
      deleted_at: null,
    };
    // A custom tombstone survives the reconcile as well.
    const customTombstone: LocalRow<Exercise> = {
      id: crypto.randomUUID(),
      owner_id: "user-1",
      name: "Old Custom",
      muscle_group: "other",
      equipment: null,
      created_at: OLD_ISO,
      updated_at: OLD_ISO,
      deleted_at: OLD_ISO,
    };
    await db.exercises.bulkPut([custom, customTombstone]);

    const before = await db.exercises.toArray();
    await ensureCatalog(db, fixedNow());
    const after = await db.exercises.toArray();

    const beforeById = new Map(before.map((row) => [row.id, row]));
    const afterIds = new Set(after.map((row) => row.id));
    const removedIds = before
      .filter((row) => !afterIds.has(row.id))
      .map((row) => row.id)
      .sort();
    const changedIds = after
      .filter(
        (row) =>
          beforeById.has(row.id) &&
          JSON.stringify(row) !== JSON.stringify(beforeById.get(row.id)),
      )
      .map((row) => row.id);
    const retiredIds = (await Promise.all(
      CATALOG_REMOVED_NAMES.map((name) => removedId(name)),
    )).sort();
    expect(removedIds, "exactly the 27 duplicates leave the table").toEqual(retiredIds);
    expect(changedIds, "no surviving global row is rewritten").toEqual([]);

    expect(await db.exercises.get(custom.id)).toEqual(custom);
    expect(await db.exercises.get(customTombstone.id)).toEqual(customTombstone);
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
