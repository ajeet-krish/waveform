import type { WorkoutSession } from "@waveform/api-types";
import { afterEach, describe, expect, it } from "vitest";
import { createWaveformDb, type WaveformDb } from "../db/schema";
import type { LocalRow } from "../db/types";
import { applyBackupImport, parseImportFile } from "./backupImport";
import {
  importSourceLabel,
  registerLegacyConverter,
  sniffImportSource,
  unregisterLegacyConverter,
  type ImportSource,
} from "./importConverters";

const STAMP = "2026-10-14T00:00:00.000Z";

const openDbs: WaveformDb[] = [];

function harness(name: string): WaveformDb {
  const db = createWaveformDb(`converters-${name}-${crypto.randomUUID()}`);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  // The converter registry is module-level: drop the stub registration so
  // every test sees a clean registry and the suite is order-independent.
  unregisterLegacyConverter("liftlog-v1");
  for (const db of openDbs) {
    db.close();
  }
  openDbs.length = 0;
});

/** The shape legacy/app.js exports: the whole db blob with a v marker. */
const liftlogRaw = {
  v: 1,
  settings: { unit: "lb", rest: 90 },
  exercises: [{ id: "ex-1", name: "Bench Press" }],
  workouts: [{ id: "w-1", date: "2026-10-14" }],
  routines: [],
  body: [],
  active: null,
};

describe("sniffImportSource", () => {
  it("returns null for input that matches no known legacy source", () => {
    expect(sniffImportSource(null)).toBeNull();
    expect(sniffImportSource(undefined)).toBeNull();
    expect(sniffImportSource("liftlog-backup-2026-10-14.json")).toBeNull();
    expect(sniffImportSource([1, 2, 3])).toBeNull();
    expect(sniffImportSource({ some: "random", file: true })).toBeNull();
    expect(sniffImportSource({ v: 2, exercises: [], workouts: [] })).toBeNull();
    expect(sniffImportSource({ v: 1, exercises: [] })).toBeNull();
  });

  it("recognizes the LiftLog v1 export shape", () => {
    const detected: ImportSource | null = sniffImportSource(liftlogRaw);
    expect(detected).toBe("liftlog-v1");
    expect(importSourceLabel("liftlog-v1")).toBe("LiftLog v1");
  });
});

describe("parseImportFile legacy dispatch", () => {
  // No converter is registered: detection alone must produce the honest
  // Phase 2 issue. afterEach unregisters the stub below, so this test
  // holds no matter which order the two run in.
  it("reports Phase 2 for a sniffed source with no registered converter", () => {
    const result = parseImportFile(JSON.stringify(liftlogRaw));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toContain("LiftLog v1");
      expect(result.issues[0]).toContain("Phase 2");
    }
  });

  it("flows a stub converter's backup through applyBackupImport merge", async () => {
    const session: LocalRow<WorkoutSession> = {
      id: "w-converted-1",
      user_id: "user-1",
      local_date: "2026-10-14",
      started_at: null,
      duration_min: 45,
      routine_id: null,
      notes: "from liftlog",
      created_at: STAMP,
      updated_at: STAMP,
      deleted_at: null,
    };
    registerLegacyConverter("liftlog-v1", (raw) => {
      const source = raw as { workouts?: unknown[] };
      if (!Array.isArray(source.workouts)) {
        return { ok: false, issues: ["not a LiftLog export"] };
      }
      return {
        ok: true,
        backup: {
          format: "waveform-backup",
          version: 2,
          exported_at: STAMP,
          app: { name: "waveform", schema_version: 2 },
          profile: null,
          exercises: [],
          workout_sessions: [session],
          exercise_entries: [],
          set_entries: [],
          activities: [],
          body_stats: [],
          climb_sends: [],
        },
        warnings: [],
      };
    });

    const parsed = parseImportFile(JSON.stringify(liftlogRaw));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.backup.workout_sessions).toHaveLength(1);

    const db = harness("stub-convert");
    const summary = await applyBackupImport(db, parsed.backup, { mode: "merge" });
    expect(summary.mode).toBe("merge");
    expect(summary.stores.workout_sessions).toBe(1);
    expect(await db.workout_sessions.get("w-converted-1")).toBeDefined();
    expect(summary.opsQueued).toBe(1);
  });
});
