import { describe, expect, it } from "vitest";
import { createWaveformDb } from "../schema";
import { CATALOG_SEED } from "./catalog";
import { ensureCatalog } from "./ensureCatalog";
import { catalogSeedId } from "./uuidV5";

const UUID_V5_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fixedNow(): () => Date {
  return () => new Date("2026-10-14T00:00:00.000Z");
}

describe("ensureCatalog", () => {
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
