import Dexie from "dexie";
import { describe, expect, it } from "vitest";
import { createWaveformDb } from "./schema";

const STORES = [
  "exercises",
  "workout_sessions",
  "exercise_entries",
  "set_entries",
  "workout_drafts",
  "outbox",
  "local_profile",
  "sync_meta",
  "activities",
  "body_stats",
  "climb_sends",
];

const INDEXES: Record<string, { primary: string; secondary: string[] }> = {
  exercises: { primary: "id", secondary: ["owner_id"] },
  workout_sessions: { primary: "id", secondary: ["local_date"] },
  exercise_entries: { primary: "id", secondary: ["workout_id"] },
  set_entries: { primary: "id", secondary: ["exercise_entry_id"] },
  workout_drafts: { primary: "id", secondary: [] },
  outbox: { primary: "op_id", secondary: ["created_at"] },
  local_profile: { primary: "id", secondary: [] },
  sync_meta: { primary: "key", secondary: [] },
  activities: { primary: "id", secondary: ["local_date", "type"] },
  body_stats: { primary: "id", secondary: ["local_date"] },
  climb_sends: { primary: "activity_id", secondary: [] },
};

function storeNames(db: ReturnType<typeof createWaveformDb>): string[] {
  return db.tables.map((table) => table.name);
}

describe("WaveformDb schema", () => {
  it("declares exactly the eleven version 2 stores with their indexes", async () => {
    const db = createWaveformDb(`schema-stores-${crypto.randomUUID()}`);
    expect(storeNames(db)).toEqual(STORES);
    await db.open();
    expect(storeNames(db)).toEqual(STORES);
    for (const table of db.tables) {
      const expected = INDEXES[table.name];
      expect(expected, `unexpected table ${table.name}`).toBeDefined();
      expect(table.schema.primKey.name, `${table.name} primary key`).toBe(expected?.primary);
      expect(
        table.schema.indexes.map((index) => index.name),
        `${table.name} secondary indexes`,
      ).toEqual(expected?.secondary);
    }
    db.close();
  });

  it("opens version 2 twice without error and keeps its data", async () => {
    const db = createWaveformDb(`schema-open-twice-${crypto.randomUUID()}`);
    await db.open();
    await db.open();
    expect(db.isOpen()).toBe(true);
    await db.sync_meta.put({ key: "cursor", value: "2026-10-14T00:00:00.000Z" });

    db.close();
    await db.open();
    expect(await db.sync_meta.count()).toBe(1);
    expect(storeNames(db)).toEqual(STORES);
    db.close();
  });

  it("upgrades a version 1 database losslessly and adds the three new stores", async () => {
    const name = `schema-upgrade-${crypto.randomUUID()}`;

    // Build a raw Dexie with ONLY the version 1 declaration, as an old
    // install would have it, and write two v1 rows.
    const v1 = new Dexie(name);
    v1.version(1).stores({
      exercises: "id, owner_id",
      workout_sessions: "id, local_date",
      exercise_entries: "id, workout_id",
      set_entries: "id, exercise_entry_id",
      workout_drafts: "id",
      outbox: "op_id, created_at",
      local_profile: "id",
      sync_meta: "key",
    });
    await v1.open();
    const profileRow = {
      id: "user-1",
      display_name: "Ada",
      email: null,
      avatar_url: null,
      created_at: "2026-10-14T00:00:00.000Z",
      updated_at: "2026-10-14T00:00:00.000Z",
      settings: { display_weight_unit: "kg", display_length_unit: "cm" },
    };
    const sessionRow = {
      id: "sess-1",
      user_id: "user-1",
      local_date: "2026-10-14",
      started_at: null,
      duration_min: 45,
      routine_id: null,
      notes: null,
      created_at: "2026-10-14T00:00:00.000Z",
      updated_at: "2026-10-14T00:00:00.000Z",
      deleted_at: null,
    };
    await v1.table("local_profile").put(profileRow);
    await v1.table("workout_sessions").put(sessionRow);
    v1.close();

    // Reopen through WaveformDb: the v1 rows survive and the three new
    // stores exist and are empty.
    const db = createWaveformDb(name);
    await db.open();
    expect(storeNames(db)).toEqual(STORES);
    expect(await db.local_profile.get("user-1")).toEqual(profileRow);
    expect(await db.workout_sessions.get("sess-1")).toEqual(sessionRow);
    expect(await db.activities.count()).toBe(0);
    expect(await db.body_stats.count()).toBe(0);
    expect(await db.climb_sends.count()).toBe(0);
    db.close();
  });
});
