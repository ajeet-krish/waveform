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
  "routines",
  "routine_entries",
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
  routines: { primary: "id", secondary: ["user_id", "updated_at"] },
  routine_entries: { primary: "id", secondary: ["routine_id", "exercise_id"] },
};

function storeNames(db: ReturnType<typeof createWaveformDb>): string[] {
  return db.tables.map((table) => table.name);
}

describe("WaveformDb schema", () => {
  it("declares exactly the thirteen version 3 stores with their indexes", async () => {
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

  it("opens version 3 twice without error and keeps its data", async () => {
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

  it("upgrades a version 1 database losslessly and adds the five new stores", async () => {
    const name = `schema-upgrade-v1-${crypto.randomUUID()}`;

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

    // Reopen through WaveformDb: the v1 rows survive and the five new
    // stores exist and are empty.
    const db = createWaveformDb(name);
    await db.open();
    expect(storeNames(db)).toEqual(STORES);
    expect(await db.local_profile.get("user-1")).toEqual(profileRow);
    expect(await db.workout_sessions.get("sess-1")).toEqual(sessionRow);
    expect(await db.activities.count()).toBe(0);
    expect(await db.body_stats.count()).toBe(0);
    expect(await db.climb_sends.count()).toBe(0);
    expect(await db.routines.count()).toBe(0);
    expect(await db.routine_entries.count()).toBe(0);
    db.close();
  });

  it("upgrades a version 2 database losslessly and adds the two routine stores", async () => {
    const name = `schema-upgrade-v2-${crypto.randomUUID()}`;

    // A v2 install as it existed before Phase 2.1: no routines stores.
    const v2 = new Dexie(name);
    v2.version(1).stores({
      exercises: "id, owner_id",
      workout_sessions: "id, local_date",
      exercise_entries: "id, workout_id",
      set_entries: "id, exercise_entry_id",
      workout_drafts: "id",
      outbox: "op_id, created_at",
      local_profile: "id",
      sync_meta: "key",
    });
    v2.version(2).stores({
      exercises: "id, owner_id",
      workout_sessions: "id, local_date",
      exercise_entries: "id, workout_id",
      set_entries: "id, exercise_entry_id",
      workout_drafts: "id",
      outbox: "op_id, created_at",
      local_profile: "id",
      sync_meta: "key",
      activities: "id, local_date, type",
      body_stats: "id, local_date",
      climb_sends: "activity_id",
    });
    await v2.open();
    const activityRow = {
      id: "act-1",
      user_id: "user-1",
      type: "cycling",
      local_date: "2026-10-13",
      started_at: null,
      duration_min: 45,
      distance_km: 20,
      elevation_m: null,
      climb_grade: null,
      climb_grade_value: null,
      routes_sent: null,
      notes: null,
      created_at: "2026-10-13T00:00:00.000Z",
      updated_at: "2026-10-13T00:00:00.000Z",
      deleted_at: null,
    };
    const sendsRow = {
      activity_id: "act-1",
      counts: new Array<number>(17).fill(0),
      updated_at: "2026-10-13T00:00:00.000Z",
    };
    await v2.table("activities").put(activityRow);
    await v2.table("climb_sends").put(sendsRow);
    v2.close();

    // Reopen through WaveformDb (v3): the v2 rows survive and the two
    // routine stores are added empty.
    const db = createWaveformDb(name);
    await db.open();
    expect(storeNames(db)).toEqual(STORES);
    expect(await db.activities.get("act-1")).toEqual(activityRow);
    expect(await db.climb_sends.get("act-1")).toEqual(sendsRow);
    expect(await db.routines.count()).toBe(0);
    expect(await db.routine_entries.count()).toBe(0);
    db.close();
  });
});
