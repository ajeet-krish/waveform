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
};

function storeNames(db: ReturnType<typeof createWaveformDb>): string[] {
  return db.tables.map((table) => table.name);
}

describe("WaveformDb schema", () => {
  it("declares exactly the eight version 1 stores with their indexes", async () => {
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

  it("opens version 1 twice without error and keeps its data", async () => {
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
});
