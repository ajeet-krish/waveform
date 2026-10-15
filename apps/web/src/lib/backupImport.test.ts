import { e1rmBrzycki } from "@waveform/scoring";
import { afterEach, describe, expect, it } from "vitest";
import { createWaveformDb, type WaveformDb } from "../db/schema";
import type { LocalProfile, LocalRow, WorkoutDraft } from "../db/types";
import { LocalValidationError } from "../db/validation";
import type { WorkoutSession } from "@waveform/api-types";
import { collectBackup, serializeBackup, type WaveformBackupV2 } from "./backup";
import { applyBackupImport, parseBackup, parseImportFile } from "./backupImport";
import { subscribeStorageFailures, isQuotaExceeded, type StorageFailure } from "./storage";

const STAMP = "2026-10-14T00:00:00.000Z";
const IMPORT_TIME = "2026-10-15T09:00:00.000Z";

/** Deterministic import clock so op created_at is assertable. */
function importNow(): () => Date {
  return () => new Date(IMPORT_TIME);
}

const openDbs: WaveformDb[] = [];

function harness(name: string): WaveformDb {
  const db = createWaveformDb(`backup-import-${name}-${crypto.randomUUID()}`);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDbs) {
    db.close();
  }
  openDbs.length = 0;
});

function sampleProfile(name: string): LocalProfile {
  return {
    id: "user-1",
    display_name: name,
    email: null,
    avatar_url: null,
    created_at: STAMP,
    updated_at: STAMP,
    settings: { display_weight_unit: "kg", display_length_unit: "cm" },
  };
}

function sessionRow(
  id: string,
  updated_at: string,
  deleted_at: string | null = null,
): LocalRow<WorkoutSession> {
  return {
    id,
    user_id: "user-1",
    local_date: "2026-10-14",
    started_at: null,
    duration_min: 45,
    routine_id: null,
    notes: null,
    created_at: STAMP,
    updated_at,
    deleted_at,
  };
}

/** A small but complete v2 backup covering every store and both row states. */
function sampleBackup(): WaveformBackupV2 {
  return {
    format: "waveform-backup",
    version: 2,
    exported_at: STAMP,
    app: { name: "waveform", schema_version: 2 },
    profile: sampleProfile("Ada"),
    exercises: [
      {
        id: "ex-bench",
        owner_id: null,
        name: "Bench Press (Barbell)",
        muscle_group: "chest",
        equipment: "barbell",
        created_at: STAMP,
        updated_at: STAMP,
        deleted_at: null,
      },
      {
        id: "ex-zettel",
        owner_id: "user-1",
        name: "Zettel Curl",
        muscle_group: "biceps",
        equipment: null,
        created_at: STAMP,
        updated_at: STAMP,
        deleted_at: STAMP,
      },
    ],
    workout_sessions: [sessionRow("sess-1", STAMP)],
    exercise_entries: [
      {
        id: "entry-1",
        workout_id: "sess-1",
        exercise_id: "ex-bench",
        order_index: 0,
        notes: null,
        created_at: STAMP,
        updated_at: STAMP,
        deleted_at: null,
      },
    ],
    set_entries: [
      {
        id: "set-1",
        exercise_entry_id: "entry-1",
        set_index: 0,
        weight_kg: 100,
        reps: 5,
        is_warmup: false,
        e1rm_kg: e1rmBrzycki(100, 5),
        created_at: STAMP,
        updated_at: STAMP,
        deleted_at: null,
      },
    ],
    activities: [
      {
        id: "act-1",
        user_id: "user-1",
        type: "climbing",
        local_date: "2026-10-13",
        started_at: null,
        duration_min: 90,
        distance_km: null,
        elevation_m: null,
        climb_grade: "V5",
        climb_grade_value: 5,
        routes_sent: 3,
        notes: null,
        created_at: STAMP,
        updated_at: STAMP,
        deleted_at: null,
      },
      {
        id: "act-2",
        user_id: "user-1",
        type: "cycling",
        local_date: "2026-10-12",
        started_at: null,
        duration_min: null,
        distance_km: 32.5,
        elevation_m: 410,
        climb_grade: null,
        climb_grade_value: null,
        routes_sent: null,
        notes: null,
        created_at: STAMP,
        updated_at: STAMP,
        deleted_at: STAMP,
      },
    ],
    body_stats: [
      {
        id: "body-1",
        user_id: "user-1",
        local_date: "2026-10-14",
        weight_kg: 72.5,
        bodyfat_pct: 15.2,
        neck_cm: null,
        shoulders_cm: null,
        chest_cm: null,
        bicep_cm: null,
        waist_cm: 80,
        hips_cm: null,
        thigh_cm: null,
        calf_cm: null,
        created_at: STAMP,
        updated_at: STAMP,
        deleted_at: null,
      },
    ],
    climb_sends: [
      {
        activity_id: "act-1",
        counts: new Array<number>(17).fill(0).map((_, index) => (index === 5 ? 1 : 0)),
        updated_at: STAMP,
      },
    ],
  };
}

/** An all-empty backup; callers fill the stores under test. */
function emptyBackup(): WaveformBackupV2 {
  const backup = sampleBackup();
  backup.profile = null;
  backup.exercises = [];
  backup.workout_sessions = [];
  backup.exercise_entries = [];
  backup.set_entries = [];
  backup.activities = [];
  backup.body_stats = [];
  backup.climb_sends = [];
  return backup;
}

/** Serializes a sample backup with one mutation applied to the raw JSON. */
function tamperedText(mutate: (root: Record<string, unknown>) => void): string {
  const root = JSON.parse(JSON.stringify(sampleBackup())) as Record<string, unknown>;
  mutate(root);
  return JSON.stringify(root);
}

function firstRow(root: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const rows = root[key];
  if (!Array.isArray(rows)) {
    return undefined;
  }
  const row: unknown = rows[0];
  return row !== null && typeof row === "object" ? (row as Record<string, unknown>) : undefined;
}

describe("parseBackup", () => {
  it("round trips a serialized backup into an identical object", () => {
    const result = parseBackup(serializeBackup(sampleBackup()));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.backup).toEqual(sampleBackup());
      expect(result.warnings).toEqual([]);
    }
  });

  it("rejects text that is not JSON", () => {
    const result = parseBackup("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]).toContain("not valid JSON");
    }
  });

  it("rejects a JSON value that is not an object", () => {
    const result = parseBackup("[1, 2, 3]");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]).toContain("JSON object");
    }
  });

  it("rejects a foreign format", () => {
    const result = parseBackup(
      tamperedText((root) => {
        root.format = "someone-elses-backup";
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.includes("format"))).toBe(true);
    }
  });

  it("points a version 1 backup at the legacy seam", () => {
    const result = parseBackup(
      tamperedText((root) => {
        root.version = 1;
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.includes("legacy v1 import wizard"))).toBe(true);
    }
  });

  it("refuses a backup made by a newer Waveform", () => {
    const result = parseBackup(
      tamperedText((root) => {
        root.version = 3;
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.includes("newer Waveform"))).toBe(true);
    }
  });

  it("rejects a wrong app name or schema version", () => {
    const wrongName = parseBackup(
      tamperedText((root) => {
        root.app = { name: "other", schema_version: 2 };
      }),
    );
    expect(wrongName.ok).toBe(false);
    const wrongSchema = parseBackup(
      tamperedText((root) => {
        root.app = { name: "waveform", schema_version: 1 };
      }),
    );
    expect(wrongSchema.ok).toBe(false);
    if (!wrongSchema.ok) {
      expect(wrongSchema.issues.some((issue) => issue.includes("schema_version"))).toBe(true);
    }
  });

  it("rejects a collection that is not an array", () => {
    const result = parseBackup(
      tamperedText((root) => {
        root.set_entries = {};
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.includes("set_entries must be an array"))).toBe(
        true,
      );
    }
  });

  it("rejects a null row element with a collection issue instead of throwing", () => {
    // JSON-legal, but not an object: reading a field off it would throw.
    const exercises = parseBackup(
      tamperedText((root) => {
        root.exercises = [null];
      }),
    );
    expect(exercises.ok).toBe(false);
    if (!exercises.ok) {
      expect(exercises.issues).toEqual(["exercises: must be an object"]);
    }

    const climbSends = parseBackup(
      tamperedText((root) => {
        root.climb_sends = [null];
      }),
    );
    expect(climbSends.ok).toBe(false);
    if (!climbSends.ok) {
      expect(climbSends.issues).toEqual(["climb_sends: must be an object"]);
    }
  });

  it("rejects string, number, and array row elements without reading their fields", () => {
    const result = parseBackup(
      tamperedText((root) => {
        root.workout_sessions = ["oops", 7, ["not", "rows"], null];
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toHaveLength(4);
      expect(result.issues.every((issue) => issue === "workout_sessions: must be an object")).toBe(
        true,
      );
    }
  });

  it("rejects a row without an id", () => {
    const result = parseBackup(
      tamperedText((root) => {
        const row = firstRow(root, "workout_sessions");
        if (row) {
          delete row.id;
        }
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.includes("id must be a non-empty string"))).toBe(
        true,
      );
    }
  });

  it("rejects bad ISO timestamps and a bad deleted_at", () => {
    const badUpdated = parseBackup(
      tamperedText((root) => {
        const row = firstRow(root, "workout_sessions");
        if (row) {
          row.updated_at = "yesterday";
        }
      }),
    );
    expect(badUpdated.ok).toBe(false);
    if (!badUpdated.ok) {
      expect(badUpdated.issues.some((issue) => issue.includes("updated_at"))).toBe(true);
    }

    const badDeleted = parseBackup(
      tamperedText((root) => {
        const row = firstRow(root, "exercises");
        if (row) {
          row.deleted_at = "soon";
        }
      }),
    );
    expect(badDeleted.ok).toBe(false);
    if (!badDeleted.ok) {
      expect(badDeleted.issues.some((issue) => issue.includes("deleted_at"))).toBe(true);
    }
  });

  it("rejects rows that fail the repo validation guards", () => {
    const badSet = parseBackup(
      tamperedText((root) => {
        const row = firstRow(root, "set_entries");
        if (row) {
          row.reps = 40;
        }
      }),
    );
    expect(badSet.ok).toBe(false);
    if (!badSet.ok) {
      expect(badSet.issues.some((issue) => issue.includes("reps"))).toBe(true);
    }

    const badActivity = parseBackup(
      tamperedText((root) => {
        const row = firstRow(root, "activities");
        if (row) {
          row.local_date = "13/10/2026";
        }
      }),
    );
    expect(badActivity.ok).toBe(false);
    if (!badActivity.ok) {
      expect(badActivity.issues.some((issue) => issue.includes("local_date"))).toBe(true);
    }

    const badBody = parseBackup(
      tamperedText((root) => {
        const row = firstRow(root, "body_stats");
        if (row) {
          row.weight_kg = 0;
        }
      }),
    );
    expect(badBody.ok).toBe(false);
    if (!badBody.ok) {
      expect(badBody.issues.some((issue) => issue.includes("weight_kg"))).toBe(true);
    }
  });

  it("rejects one bad row among many good ones: all or nothing", () => {
    const result = parseBackup(
      tamperedText((root) => {
        const rows = root.workout_sessions;
        if (Array.isArray(rows) && rows.length > 0) {
          const bad: unknown = rows[0];
          if (bad !== null && typeof bad === "object") {
            (bad as Record<string, unknown>).duration_min = 5000;
          }
        }
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a profile that fails its shape checks", () => {
    const result = parseBackup(
      tamperedText((root) => {
        root.profile = {
          id: "user-1",
          display_name: "Ada",
          email: null,
          avatar_url: null,
          created_at: STAMP,
          updated_at: STAMP,
          settings: { display_weight_unit: "stone", display_length_unit: "cm" },
        };
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.includes("profile: settings"))).toBe(true);
    }
  });
});

describe("applyBackupImport: merge", () => {
  it("merges a backup onto an empty database and queues one op per row", async () => {
    const db = harness("merge-empty");
    const summary = await applyBackupImport(db, sampleBackup(), {
      mode: "merge",
      now: importNow(),
    });

    expect(summary.mode).toBe("merge");
    expect(summary.stores).toEqual({
      exercises: 2,
      workout_sessions: 1,
      exercise_entries: 1,
      set_entries: 1,
      activities: 2,
      body_stats: 1,
      climb_sends: 1,
    });
    // Climb histograms are device-local: no ops. Everything else queues one.
    expect(summary.opsQueued).toBe(8);
    expect(summary.profileRestored).toBe(true);

    expect(await db.workout_sessions.get("sess-1")).toEqual(sampleBackup().workout_sessions[0]);
    expect((await db.local_profile.toArray())[0]?.display_name).toBe("Ada");

    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(8);
    const sessionOp = ops.find((op) => op.entity === "workout_sessions");
    expect(sessionOp?.action).toBe("create");
    expect(sessionOp?.updated_at).toBe(STAMP);
    expect(sessionOp?.created_at).toBe(IMPORT_TIME);
    const tombOp = ops.find((op) => op.entity === "exercises" && op.action === "delete");
    expect(tombOp?.payload.id).toBe("ex-zettel");
  });

  it("is idempotent: a second identical import writes nothing and queues nothing", async () => {
    const db = harness("merge-idempotent");
    const first = await applyBackupImport(db, sampleBackup(), { mode: "merge", now: importNow() });
    const opsAfterFirst = await db.outbox.count();
    expect(opsAfterFirst).toBe(first.opsQueued);

    const second = await applyBackupImport(db, sampleBackup(), {
      mode: "merge",
      now: () => new Date("2026-10-16T09:00:00.000Z"),
    });

    expect(second.opsQueued).toBe(0);
    expect(second.stores).toEqual({
      exercises: 0,
      workout_sessions: 0,
      exercise_entries: 0,
      set_entries: 0,
      activities: 0,
      body_stats: 0,
      climb_sends: 0,
    });
    expect(await db.outbox.count()).toBe(opsAfterFirst);
  });

  it("keeps the local row when it is newer than the incoming one", async () => {
    const db = harness("lww-newer-local");
    await db.workout_sessions.put(sessionRow("sess-1", "2026-10-14T12:00:00.000Z"));

    const backup = emptyBackup();
    backup.workout_sessions = [sessionRow("sess-1", "2026-10-14T11:00:00.000Z")];
    const summary = await applyBackupImport(db, backup, { mode: "merge", now: importNow() });

    expect(summary.stores.workout_sessions).toBe(0);
    expect(summary.opsQueued).toBe(0);
    const row = await db.workout_sessions.get("sess-1");
    expect(row?.duration_min).toBe(45);
    expect(row?.updated_at).toBe("2026-10-14T12:00:00.000Z");
    expect(await db.outbox.count()).toBe(0);
  });

  it("takes the incoming row when it is newer, with the op carrying the row LWW time", async () => {
    const db = harness("lww-newer-incoming");
    await db.workout_sessions.put(sessionRow("sess-1", "2026-10-14T11:00:00.000Z"));

    const backup = emptyBackup();
    const incoming = sessionRow("sess-1", "2026-10-14T12:00:00.000Z");
    incoming.notes = "edited on the other phone";
    backup.workout_sessions = [incoming];
    const summary = await applyBackupImport(db, backup, { mode: "merge", now: importNow() });

    expect(summary.stores.workout_sessions).toBe(1);
    expect(await db.workout_sessions.get("sess-1")).toEqual(incoming);
    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]?.action).toBe("update");
    expect(ops[0]?.updated_at).toBe("2026-10-14T12:00:00.000Z");
    expect(ops[0]?.created_at).toBe(IMPORT_TIME);
  });

  it("skips a row whose timestamps are equal", async () => {
    const db = harness("lww-equal");
    await db.workout_sessions.put(sessionRow("sess-1", STAMP));

    const backup = emptyBackup();
    const other = sessionRow("sess-1", STAMP);
    other.notes = "same time, different text";
    backup.workout_sessions = [other];
    const summary = await applyBackupImport(db, backup, { mode: "merge", now: importNow() });

    expect(summary.opsQueued).toBe(0);
    expect((await db.workout_sessions.get("sess-1"))?.notes).toBeNull();
  });

  it("skips a row whose instants are equal but written in a different ISO shape", async () => {
    const db = harness("lww-equal-shape");
    await db.workout_sessions.put(sessionRow("sess-1", "2026-10-14T10:00:00.000Z"));

    const backup = emptyBackup();
    const other = sessionRow("sess-1", "2026-10-14T10:00:00Z");
    other.notes = "same instant, other shape";
    backup.workout_sessions = [other];
    const summary = await applyBackupImport(db, backup, { mode: "merge", now: importNow() });

    expect(summary.stores.workout_sessions).toBe(0);
    expect(summary.opsQueued).toBe(0);
    expect(await db.outbox.count()).toBe(0);
    expect((await db.workout_sessions.get("sess-1"))?.notes).toBeNull();
    expect((await db.workout_sessions.get("sess-1"))?.updated_at).toBe("2026-10-14T10:00:00.000Z");
  });

  it("applies an incoming tombstone that is newer than the local live row", async () => {
    const db = harness("lww-incoming-tombstone");
    await db.workout_sessions.put(sessionRow("sess-1", "2026-10-14T11:00:00.000Z"));

    const backup = emptyBackup();
    backup.workout_sessions = [sessionRow("sess-1", "2026-10-14T12:00:00.000Z", "2026-10-14T12:00:00.000Z")];
    const summary = await applyBackupImport(db, backup, { mode: "merge", now: importNow() });

    expect(summary.stores.workout_sessions).toBe(1);
    const row = await db.workout_sessions.get("sess-1");
    expect(row?.deleted_at).toBe("2026-10-14T12:00:00.000Z");
    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]?.action).toBe("delete");
    expect((ops[0]?.payload as { deleted_at: string | null }).deleted_at).not.toBeNull();
  });

  it("resurrects a local tombstone when a newer live row arrives", async () => {
    const db = harness("lww-resurrect");
    await db.workout_sessions.put(
      sessionRow("sess-1", "2026-10-14T11:00:00.000Z", "2026-10-14T11:00:00.000Z"),
    );

    const backup = emptyBackup();
    backup.workout_sessions = [sessionRow("sess-1", "2026-10-14T12:00:00.000Z")];
    const summary = await applyBackupImport(db, backup, { mode: "merge", now: importNow() });

    expect(summary.stores.workout_sessions).toBe(1);
    const row = await db.workout_sessions.get("sess-1");
    expect(row?.deleted_at).toBeNull();
    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]?.action).toBe("update");
  });

  it("writes an unknown tombstone with a delete op", async () => {
    const db = harness("lww-unknown-tombstone");
    const backup = emptyBackup();
    backup.workout_sessions = [sessionRow("sess-ghost", STAMP, STAMP)];

    const summary = await applyBackupImport(db, backup, { mode: "merge", now: importNow() });

    expect(summary.stores.workout_sessions).toBe(1);
    expect((await db.workout_sessions.get("sess-ghost"))?.deleted_at).toBe(STAMP);
    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]?.action).toBe("delete");
  });

  it("recomputes a tampered e1rm_kg and keeps it out of the payload", async () => {
    const db = harness("merge-e1rm");
    const backup = emptyBackup();
    const set = sampleBackup().set_entries[0];
    expect(set).toBeDefined();
    if (!set) {
      return;
    }
    backup.set_entries = [{ ...set, e1rm_kg: 999 }];

    const summary = await applyBackupImport(db, backup, { mode: "merge", now: importNow() });
    expect(summary.stores.set_entries).toBe(1);

    const row = await db.set_entries.get("set-1");
    expect(row?.e1rm_kg).toBe(e1rmBrzycki(100, 5));
    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]?.payload).not.toHaveProperty("e1rm_kg");
  });

  it("preserves local-only rows and a local profile", async () => {
    const db = harness("merge-preserves");
    await db.workout_sessions.put(sessionRow("sess-local", STAMP));
    await db.local_profile.put(sampleProfile("Grace"));

    const backup = emptyBackup();
    backup.profile = sampleProfile("Ada");
    backup.workout_sessions = [sessionRow("sess-backup", STAMP)];
    const summary = await applyBackupImport(db, backup, { mode: "merge", now: importNow() });

    expect(summary.profileRestored).toBe(false);
    const sessions = await db.workout_sessions.toArray();
    expect(sessions.map((row) => row.id).sort()).toEqual(["sess-backup", "sess-local"]);
    expect((await db.local_profile.toArray())[0]?.display_name).toBe("Grace");
  });

  it("rolls back every write when a quota failure hits mid-merge", async () => {
    const db = harness("merge-rollback");
    const quota = new DOMException("The quota has been exceeded.", "QuotaExceededError");
    db.activities.put = () => {
      throw quota;
    };

    const backup = sampleBackup();
    await expect(
      applyBackupImport(db, backup, { mode: "merge", now: importNow() }),
    ).rejects.toThrow("The quota has been exceeded.");

    expect(await db.exercises.count()).toBe(0);
    expect(await db.workout_sessions.count()).toBe(0);
    expect(await db.exercise_entries.count()).toBe(0);
    expect(await db.set_entries.count()).toBe(0);
    expect(await db.body_stats.count()).toBe(0);
    expect(await db.climb_sends.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });

  it("publishes one StorageFailure on a quota error and rethrows it", async () => {
    const db = harness("merge-quota-bus");
    const quota = new DOMException("The quota has been exceeded.", "QuotaExceededError");
    db.activities.put = () => {
      throw quota;
    };

    const received: StorageFailure[] = [];
    const unsubscribe = subscribeStorageFailures((failure) => received.push(failure));
    // Import writes bypass guardRepos, so the import must classify the
    // quota failure itself; the error still propagates to the caller.
    // (Dexie rewraps a DOMException, so assert the classification, not
    // the exact object.)
    let thrown: unknown = null;
    try {
      await applyBackupImport(db, sampleBackup(), { mode: "merge", now: importNow() });
    } catch (cause) {
      thrown = cause;
    } finally {
      unsubscribe();
    }

    expect(isQuotaExceeded(thrown)).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]?.kind).toBe("quota");
  });

  it("publishes nothing on a non-storage error", async () => {
    const db = harness("merge-plain-error");
    const boom = new TypeError("logic bug");
    db.activities.put = () => {
      throw boom;
    };

    const received: StorageFailure[] = [];
    const unsubscribe = subscribeStorageFailures((failure) => received.push(failure));
    try {
      await expect(
        applyBackupImport(db, sampleBackup(), { mode: "merge", now: importNow() }),
      ).rejects.toBe(boom);
    } finally {
      unsubscribe();
    }

    expect(received).toEqual([]);
  });
});

describe("applyBackupImport: replace", () => {
  it("refuses to replace without the confirm flag and writes nothing", async () => {
    const db = harness("replace-refusal");
    await db.workout_sessions.put(sessionRow("sess-local", STAMP));
    await db.outbox.add({
      op_id: "op-local",
      entity: "workout_sessions",
      action: "create",
      payload: sessionRow("sess-local", STAMP),
      updated_at: STAMP,
      created_at: STAMP,
    });

    await expect(
      applyBackupImport(db, sampleBackup(), { mode: "replace", now: importNow() }),
    ).rejects.toThrow(LocalValidationError);

    expect(await db.workout_sessions.count()).toBe(1);
    expect(await db.outbox.count()).toBe(1);
  });

  it("wipes, restores, re-queues one op per row, and clears sync_meta while drafts survive", async () => {
    const db = harness("replace-wipe");
    const local = db;
    await local.workout_sessions.put(sessionRow("sess-local", STAMP));
    await local.local_profile.put(sampleProfile("Grace"));
    await local.sync_meta.put({ key: "last_pull", value: STAMP });
    await local.outbox.add({
      op_id: "op-stale",
      entity: "workout_sessions",
      action: "create",
      payload: sessionRow("sess-local", STAMP),
      updated_at: STAMP,
      created_at: STAMP,
    });
    const draft: WorkoutDraft = {
      id: "draft-1",
      local_date: "2026-10-14",
      started_at: null,
      duration_min: null,
      routine_id: null,
      notes: "in progress",
      entries: [],
      updated_at: STAMP,
    };
    await local.workout_drafts.put(draft);

    const backup = sampleBackup();
    const tampered = backup.set_entries[0];
    if (tampered) {
      backup.set_entries = [{ ...tampered, e1rm_kg: 999 }];
    }
    const summary = await applyBackupImport(db, backup, {
      mode: "replace",
      confirmReplace: true,
      now: importNow(),
    });

    expect(summary.mode).toBe("replace");
    expect(summary.stores).toEqual({
      exercises: 2,
      workout_sessions: 1,
      exercise_entries: 1,
      set_entries: 1,
      activities: 2,
      body_stats: 1,
      climb_sends: 1,
    });
    // One op per restored row across the six synced entities (no climb ops).
    expect(summary.opsQueued).toBe(8);

    // Local-only rows are gone; backup rows are back with recomputed e1rm.
    expect(await db.workout_sessions.get("sess-local")).toBeUndefined();
    expect(await db.workout_sessions.get("sess-1")).toBeDefined();
    expect((await db.set_entries.get("set-1"))?.e1rm_kg).toBe(e1rmBrzycki(100, 5));

    // The stale op is gone; the queue is exactly the restored rows.
    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(8);
    expect(ops.some((op) => op.op_id === "op-stale")).toBe(false);
    expect(ops.every((op) => op.created_at === IMPORT_TIME)).toBe(true);
    const setOp = ops.find((op) => op.entity === "set_entries");
    expect(setOp?.updated_at).toBe(STAMP);
    expect(setOp?.payload).not.toHaveProperty("e1rm_kg");

    expect(await db.sync_meta.count()).toBe(0);
    expect(await db.workout_drafts.get("draft-1")).toEqual(draft);
    expect((await db.local_profile.toArray())[0]?.display_name).toBe("Ada");
    expect(summary.profileRestored).toBe(true);
  });

  it("keeps the local profile when the backup carries none", async () => {
    const db = harness("replace-keep-profile");
    await db.local_profile.put(sampleProfile("Grace"));

    const summary = await applyBackupImport(db, emptyBackup(), {
      mode: "replace",
      confirmReplace: true,
      now: importNow(),
    });

    expect(summary.profileRestored).toBe(false);
    expect((await db.local_profile.toArray())[0]?.display_name).toBe("Grace");
  });

  it("self-heals the catalog when the backup carries no catalog rows", async () => {
    const db = harness("replace-self-heal");
    const summary = await applyBackupImport(db, emptyBackup(), {
      mode: "replace",
      confirmReplace: true,
      now: importNow(),
    });

    expect(summary.stores.exercises).toBe(0);
    const catalog = await db.exercises.toArray();
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.every((row) => row.owner_id === null)).toBe(true);
    // Seeding writes no outbox ops (server-owned rows).
    expect(await db.outbox.count()).toBe(0);
  });

  it("leaves every store unchanged when a quota failure hits during the restore", async () => {
    const db = harness("replace-rollback");
    await db.workout_sessions.put(sessionRow("sess-local", STAMP));
    await db.local_profile.put(sampleProfile("Grace"));
    await db.sync_meta.put({ key: "last_pull", value: STAMP });
    await db.outbox.add({
      op_id: "op-stale",
      entity: "workout_sessions",
      action: "create",
      payload: sessionRow("sess-local", STAMP),
      updated_at: STAMP,
      created_at: STAMP,
    });

    const snapshot = {
      exercises: await db.exercises.toArray(),
      sessions: await db.workout_sessions.toArray(),
      entries: await db.exercise_entries.toArray(),
      sets: await db.set_entries.toArray(),
      activities: await db.activities.toArray(),
      body: await db.body_stats.toArray(),
      sends: await db.climb_sends.toArray(),
      profile: await db.local_profile.toArray(),
      outbox: await db.outbox.toArray(),
      meta: await db.sync_meta.toArray(),
    };

    const quota = new DOMException("The quota has been exceeded.", "QuotaExceededError");
    db.set_entries.put = () => {
      throw quota;
    };

    await expect(
      applyBackupImport(db, sampleBackup(), {
        mode: "replace",
        confirmReplace: true,
        now: importNow(),
      }),
    ).rejects.toThrow("The quota has been exceeded.");

    expect(await db.exercises.toArray()).toEqual(snapshot.exercises);
    expect(await db.workout_sessions.toArray()).toEqual(snapshot.sessions);
    expect(await db.exercise_entries.toArray()).toEqual(snapshot.entries);
    expect(await db.set_entries.toArray()).toEqual(snapshot.sets);
    expect(await db.activities.toArray()).toEqual(snapshot.activities);
    expect(await db.body_stats.toArray()).toEqual(snapshot.body);
    expect(await db.climb_sends.toArray()).toEqual(snapshot.sends);
    expect(await db.local_profile.toArray()).toEqual(snapshot.profile);
    expect(await db.outbox.toArray()).toEqual(snapshot.outbox);
    expect(await db.sync_meta.toArray()).toEqual(snapshot.meta);
  });
});

describe("full round trip through parse and replace", () => {
  it("restores exactly what collectBackup read", async () => {
    const source = harness("round-trip-source");
    await source.workout_sessions.put(sessionRow("sess-1", STAMP));
    await source.local_profile.put(sampleProfile("Ada"));
    const collected = await collectBackup(source);

    const target = harness("round-trip-target");
    const parsed = parseBackup(serializeBackup(collected));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    await applyBackupImport(target, parsed.backup, {
      mode: "replace",
      confirmReplace: true,
      now: importNow(),
    });

    const restored = await collectBackup(target);
    expect(restored.profile).toEqual(collected.profile);
    expect(restored.workout_sessions).toEqual(collected.workout_sessions);
  });
});

describe("parseImportFile dispatch", () => {
  it("routes a waveform backup to the v2 parser", () => {
    const result = parseImportFile(serializeBackup(sampleBackup()));
    expect(result.ok).toBe(true);
  });

  it("reports an unrecognized file honestly", () => {
    const result = parseImportFile(JSON.stringify({ some: "random", file: true }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]).toContain("Unrecognized file");
    }
  });
});
