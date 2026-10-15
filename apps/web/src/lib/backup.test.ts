import { afterEach, describe, expect, it } from "vitest";
import { createWaveformDb, type WaveformDb } from "../db/schema";
import type { LocalProfile } from "../db/types";
import { backupFileName, collectBackup, serializeBackup } from "./backup";

const openDbs: WaveformDb[] = [];

function harness(name: string): WaveformDb {
  const db = createWaveformDb(`backup-${name}-${crypto.randomUUID()}`);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDbs) {
    db.close();
  }
  openDbs.length = 0;
});

const STAMP = "2026-10-14T00:00:00.000Z";

async function seedRows(db: WaveformDb): Promise<void> {
  const profile: LocalProfile = {
    id: "user-1",
    display_name: "Ada",
    email: null,
    avatar_url: null,
    created_at: STAMP,
    updated_at: STAMP,
    settings: { display_weight_unit: "kg", display_length_unit: "cm" },
  };
  await db.local_profile.put(profile);
  await db.exercises.bulkPut([
    {
      id: "ex-1",
      owner_id: null,
      name: "Bench Press (Barbell)",
      muscle_group: "chest",
      equipment: "barbell",
      created_at: STAMP,
      updated_at: STAMP,
      deleted_at: null,
    },
    {
      id: "ex-2",
      owner_id: "user-1",
      name: "Zettel Curl",
      muscle_group: "biceps",
      equipment: null,
      created_at: STAMP,
      updated_at: STAMP,
      deleted_at: STAMP,
    },
  ]);
  await db.workout_sessions.put({
    id: "sess-1",
    user_id: "user-1",
    local_date: "2026-10-14",
    started_at: STAMP,
    duration_min: 45,
    routine_id: null,
    notes: null,
    created_at: STAMP,
    updated_at: STAMP,
    deleted_at: null,
  });
  await db.exercise_entries.put({
    id: "entry-1",
    workout_id: "sess-1",
    exercise_id: "ex-1",
    order_index: 0,
    notes: null,
    created_at: STAMP,
    updated_at: STAMP,
    deleted_at: null,
  });
  await db.set_entries.put({
    id: "set-1",
    exercise_entry_id: "entry-1",
    set_index: 0,
    weight_kg: 100,
    reps: 5,
    is_warmup: false,
    e1rm_kg: 112.5,
    created_at: STAMP,
    updated_at: STAMP,
    deleted_at: STAMP,
  });
}

describe("collectBackup", () => {
  it("reads raw rows from every phase 1 store, tombstones included", async () => {
    const db = harness("collect");
    await seedRows(db);

    const backup = await collectBackup(db);
    expect(backup.format).toBe("waveform-backup");
    expect(backup.version).toBe(1);
    expect(backup.app).toEqual({ name: "waveform", schema_version: 1 });
    expect(backup.profile?.display_name).toBe("Ada");
    expect(backup.exercises).toHaveLength(2);
    expect(backup.exercises.some((row) => row.deleted_at !== null)).toBe(true);
    expect(backup.workout_sessions.map((row) => row.id)).toEqual(["sess-1"]);
    expect(backup.exercise_entries.map((row) => row.id)).toEqual(["entry-1"]);
    expect(backup.set_entries.map((row) => row.id)).toEqual(["set-1"]);
    expect(Number.isNaN(Date.parse(backup.exported_at))).toBe(false);
  });

  it("marks an empty device instead of failing", async () => {
    const db = harness("empty");
    const backup = await collectBackup(db);
    expect(backup.profile).toBeNull();
    expect(backup.exercises).toEqual([]);
    expect(backup.workout_sessions).toEqual([]);
    expect(backup.exercise_entries).toEqual([]);
    expect(backup.set_entries).toEqual([]);
  });
});

describe("serializeBackup", () => {
  it("indents with two spaces and parses back to the same object", async () => {
    const db = harness("serialize");
    await seedRows(db);
    const backup = await collectBackup(db);

    const text = serializeBackup(backup);
    expect(text).toContain('\n  "format": "waveform-backup",');
    expect(text).toContain('\n    "schema_version": 1');
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(backup);
  });
});

describe("backupFileName", () => {
  it("names the file from a calendar day, string or Date", () => {
    expect(backupFileName("2026-10-14")).toBe("waveform-backup-2026-10-14.json");
    expect(backupFileName(new Date(2026, 9, 14, 23, 59))).toBe("waveform-backup-2026-10-14.json");
    expect(backupFileName(new Date(2026, 0, 1))).toBe("waveform-backup-2026-01-01.json");
  });

  it("refuses a day that is not a bare calendar day", () => {
    expect(() => backupFileName("14/10/2026")).toThrow(RangeError);
  });
});
