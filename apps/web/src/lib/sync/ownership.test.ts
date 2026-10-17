import { afterEach, describe, expect, it } from "vitest";
import type {
  Activity,
  BodyStats,
  Exercise,
  ExerciseEntry,
  SetEntry,
  WorkoutSession,
} from "@waveform/api-types";
import { createWaveformDb, type WaveformDb } from "../../db/schema";
import type {
  ClimbSends,
  LocalProfile,
  LocalRow,
  OutboxEntity,
  OutboxOp,
  OutboxRowMap,
  SetEntryWrite,
  WorkoutDraft,
} from "../../db/types";
import {
  ADOPTED_USER_ID_KEY,
  API_BASE_URL_KEY,
  CONFLICT_LOG_KEY,
  FULL_PULL_PENDING_KEY,
  LAST_SYNCED_AT_KEY,
  PULL_CURSOR_PREFIX,
  getMeta,
  setMeta,
} from "./meta";
import {
  OWNERSHIP_SOURCES,
  classifyOwnership,
  isWriteBlocked,
  wipeAccountDataFromDevice,
} from "./ownership";

const USER_A = "owner-a";
const USER_B = "owner-b";
const USER_C = "owner-c";
const STAMP = "2026-10-14T00:00:00.000Z";

const openDbs: WaveformDb[] = [];

function harness(name: string): WaveformDb {
  const db = createWaveformDb(`ownership-${name}-${crypto.randomUUID()}`);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDbs) {
    db.close();
  }
  openDbs.length = 0;
});

function profile(id: string): LocalProfile {
  return {
    id,
    display_name: "Ada",
    email: null,
    avatar_url: null,
    created_at: STAMP,
    updated_at: STAMP,
    settings: { display_weight_unit: "kg", display_length_unit: "cm" },
  };
}

function exercise(id: string, owner_id: string | null): LocalRow<Exercise> {
  return {
    id,
    owner_id,
    name: "Bench Press (Barbell)",
    muscle_group: "chest",
    equipment: "barbell",
    created_at: STAMP,
    updated_at: STAMP,
    deleted_at: null,
  };
}

function session(id: string, user_id: string): LocalRow<WorkoutSession> {
  return {
    id,
    user_id,
    local_date: "2026-10-14",
    started_at: null,
    duration_min: null,
    routine_id: null,
    notes: null,
    created_at: STAMP,
    updated_at: STAMP,
    deleted_at: null,
  };
}

function entry(id: string, workout_id: string): LocalRow<ExerciseEntry> {
  return {
    id,
    workout_id,
    exercise_id: "catalog-1",
    order_index: 0,
    notes: null,
    created_at: STAMP,
    updated_at: STAMP,
    deleted_at: null,
  };
}

function setRow(id: string, exercise_entry_id: string): LocalRow<SetEntry> {
  return {
    id,
    exercise_entry_id,
    set_index: 0,
    weight_kg: 60,
    reps: 5,
    is_warmup: false,
    e1rm_kg: 70,
    created_at: STAMP,
    updated_at: STAMP,
    deleted_at: null,
  };
}

function activity(id: string, user_id: string): LocalRow<Activity> {
  return {
    id,
    user_id,
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
    created_at: STAMP,
    updated_at: STAMP,
    deleted_at: null,
  };
}

function bodyStat(id: string, user_id: string): LocalRow<BodyStats> {
  return {
    id,
    user_id,
    local_date: "2026-10-12",
    weight_kg: 70,
    bodyfat_pct: null,
    neck_cm: null,
    shoulders_cm: null,
    chest_cm: null,
    bicep_cm: null,
    waist_cm: null,
    hips_cm: null,
    thigh_cm: null,
    calf_cm: null,
    created_at: STAMP,
    updated_at: STAMP,
    deleted_at: null,
  };
}

function sends(activity_id: string): ClimbSends {
  return { activity_id, counts: Array.from({ length: 17 }, () => 0), updated_at: STAMP };
}

function draft(id: string): WorkoutDraft {
  return {
    id,
    local_date: "2026-10-15",
    started_at: null,
    duration_min: null,
    routine_id: null,
    notes: null,
    entries: [],
    updated_at: STAMP,
  };
}

function op<E extends OutboxEntity>(
  op_id: string,
  entity: E,
  payload: OutboxRowMap[E],
): OutboxOp<E> {
  return { op_id, entity, action: "update", payload, updated_at: STAMP, created_at: STAMP };
}

describe("OWNERSHIP_SOURCES", () => {
  it("names every owner-bearing source in one place", () => {
    expect(OWNERSHIP_SOURCES.map((source) => source.path)).toEqual([
      "exercises.owner_id",
      "workout_sessions.user_id",
      "activities.user_id",
      "body_stats.user_id",
      "outbox.payload.owner_id",
      "outbox.payload.user_id",
      "sync_meta.adopted_user_id",
      "local_profile.id",
    ]);
  });

  it("marks the four synced row owners as row-owner stamps", () => {
    const rowOwners = OWNERSHIP_SOURCES.filter((source) => source.kind === "row-owner");
    expect(rowOwners.map((source) => source.path)).toEqual([
      "exercises.owner_id",
      "workout_sessions.user_id",
      "activities.user_id",
      "body_stats.user_id",
    ]);
  });
});

describe("classifyOwnership", () => {
  it("reports fresh on a device with nothing on it", async () => {
    const db = harness("fresh-empty");
    expect(await classifyOwnership(db, USER_A)).toEqual({ kind: "fresh" });
  });

  it("reports fresh when a profile exists but no rows do", async () => {
    const db = harness("fresh-profile");
    await db.local_profile.put(profile(USER_A));
    expect(await classifyOwnership(db, USER_A)).toEqual({ kind: "fresh" });
  });

  it("reports mine when the adoption marker names the user", async () => {
    const db = harness("mine-marker");
    await setMeta(db, ADOPTED_USER_ID_KEY, USER_A);
    expect(await classifyOwnership(db, USER_A)).toEqual({ kind: "mine" });
  });

  /** One row per owner source, each stamped with the signed-in user. */
  const mineCases: Array<{ source: string; seed(db: WaveformDb): Promise<void> }> = [
    {
      source: "exercises.owner_id",
      async seed(db) {
        await db.exercises.add(exercise("custom-1", USER_A));
      },
    },
    {
      source: "workout_sessions.user_id",
      async seed(db) {
        await db.workout_sessions.add(session("session-1", USER_A));
      },
    },
    {
      source: "activities.user_id",
      async seed(db) {
        await db.activities.add(activity("activity-1", USER_A));
      },
    },
    {
      source: "body_stats.user_id",
      async seed(db) {
        await db.body_stats.add(bodyStat("body-1", USER_A));
      },
    },
    {
      source: "outbox.payload.owner_id",
      async seed(db) {
        await db.outbox.add(op("op-exercise", "exercises", exercise("custom-1", USER_A)));
      },
    },
    {
      source: "outbox.payload.user_id",
      async seed(db) {
        await db.outbox.add(op("op-session", "workout_sessions", session("session-1", USER_A)));
      },
    },
  ];

  for (const mineCase of mineCases) {
    it(`reports mine when only ${mineCase.source} stamps the user`, async () => {
      const db = harness(`mine-${mineCase.source}`);
      await mineCase.seed(db);
      expect(await classifyOwnership(db, USER_A)).toEqual({ kind: "mine" });
    });
  }

  it("reports mine for a device's own unadopted pre-account log", async () => {
    const db = harness("mine-preaccount");
    await db.local_profile.put(profile("device-local-1"));
    await db.workout_sessions.add(session("session-1", "device-local-1"));
    await db.exercises.add(exercise("custom-1", "device-local-1"));
    // The signature account has never touched this device, but the log is
    // the device's own unclaimed one, so it is adoptable.
    expect(await classifyOwnership(db, USER_A)).toEqual({ kind: "mine" });
  });

  it("reports foreign with the non-matching id in a mixed-stamp device", async () => {
    const db = harness("foreign-mixed");
    await db.local_profile.put(profile("device-local-1"));
    await db.workout_sessions.add(session("session-1", USER_A));
    await db.activities.add(activity("activity-1", USER_B));
    expect(await classifyOwnership(db, USER_A)).toEqual({
      kind: "foreign",
      ownerIds: [USER_B],
    });
  });

  it("reports foreign when the device is adopted to another account", async () => {
    const db = harness("foreign-adopted");
    await db.local_profile.put(profile(USER_B));
    await db.workout_sessions.add(session("session-1", USER_B));
    await setMeta(db, ADOPTED_USER_ID_KEY, USER_B);
    expect(await classifyOwnership(db, USER_A)).toEqual({
      kind: "foreign",
      ownerIds: [USER_B],
    });
  });

  it("reports foreign from a claim marker even with no rows", async () => {
    const db = harness("foreign-marker-only");
    await setMeta(db, ADOPTED_USER_ID_KEY, USER_B);
    expect(await classifyOwnership(db, USER_A)).toEqual({
      kind: "foreign",
      ownerIds: [USER_B],
    });
  });

  it("reports foreign from a queued op's payload alone", async () => {
    const db = harness("foreign-outbox");
    await db.outbox.add(op("op-session", "workout_sessions", session("session-1", USER_B)));
    expect(await classifyOwnership(db, USER_A)).toEqual({
      kind: "foreign",
      ownerIds: [USER_B],
    });
  });

  it("ignores global catalog exercises, which have no owner", async () => {
    const db = harness("catalog");
    await db.exercises.add(exercise("catalog-1", null));
    expect(await classifyOwnership(db, USER_A)).toEqual({ kind: "fresh" });
  });
});

describe("isWriteBlocked", () => {
  it("blocks the write console only for foreign and unknown devices", () => {
    expect(isWriteBlocked(null)).toBe(false);
    expect(isWriteBlocked({ kind: "fresh" })).toBe(false);
    expect(isWriteBlocked({ kind: "mine" })).toBe(false);
    expect(isWriteBlocked({ kind: "foreign", ownerIds: [USER_B] })).toBe(true);
    expect(isWriteBlocked({ kind: "unknown" })).toBe(true);
  });
});

/** Seeds two accounts' rows plus device-local scratch for the wipe tests. */
async function seedTwoAccounts(db: WaveformDb): Promise<void> {
  await db.exercises.bulkAdd([
    exercise("catalog-1", null),
    exercise("custom-a", USER_A),
    exercise("custom-b", USER_B),
  ]);
  await db.workout_sessions.bulkAdd([session("session-a", USER_A), session("session-b", USER_B)]);
  await db.exercise_entries.bulkAdd([entry("entry-a", "session-a"), entry("entry-b", "session-b")]);
  await db.set_entries.bulkAdd([setRow("set-a", "entry-a"), setRow("set-b", "entry-b")]);
  await db.activities.bulkAdd([activity("activity-a", USER_A), activity("activity-b", USER_B)]);
  await db.body_stats.bulkAdd([bodyStat("body-a", USER_A), bodyStat("body-b", USER_B)]);
  await db.climb_sends.bulkAdd([sends("activity-a"), sends("activity-b")]);

  const sessionA = session("session-a", USER_A);
  const sessionB = session("session-b", USER_B);
  const entryA = entry("entry-a", "session-a");
  const entryB = entry("entry-b", "session-b");
  const setWriteA: SetEntryWrite = {
    id: "set-a",
    exercise_entry_id: "entry-a",
    set_index: 0,
    weight_kg: 60,
    reps: 5,
    is_warmup: false,
    created_at: STAMP,
    updated_at: STAMP,
    deleted_at: null,
  };
  const setWriteB: SetEntryWrite = { ...setWriteA, id: "set-b", exercise_entry_id: "entry-b" };
  await db.outbox.bulkAdd([
    op("op-exercise-a", "exercises", exercise("custom-a", USER_A)),
    op("op-exercise-b", "exercises", exercise("custom-b", USER_B)),
    op("op-entry-a", "exercise_entries", entryA),
    op("op-entry-b", "exercise_entries", entryB),
    op("op-set-a", "set_entries", setWriteA),
    op("op-set-b", "set_entries", setWriteB),
    op("op-session-b", "workout_sessions", sessionB),
  ]);

  await db.workout_drafts.bulkAdd([draft("draft-a"), draft("draft-b")]);

  await db.local_profile.put(profile(USER_A));
  await setMeta(db, ADOPTED_USER_ID_KEY, USER_A);
  await setMeta(db, `${PULL_CURSOR_PREFIX}workout_sessions`, "cursor-x");
  await setMeta(db, `${PULL_CURSOR_PREFIX}activities`, "cursor-y");
  await setMeta(db, LAST_SYNCED_AT_KEY, STAMP);
  await setMeta(db, CONFLICT_LOG_KEY, [{ note: "kept until wipe" }]);
  await setMeta(db, FULL_PULL_PENDING_KEY, true);
  await setMeta(db, API_BASE_URL_KEY, "https://waveform.example");
}

describe("wipeAccountDataFromDevice", () => {
  it("removes only the target user's rows and device-local scratch", async () => {
    const db = harness("wipe-a");
    await seedTwoAccounts(db);

    await wipeAccountDataFromDevice(db, USER_A);

    // The target's rows are gone; the other account's remain.
    expect((await db.exercises.toArray()).map((row) => row.id).sort()).toEqual([
      "catalog-1",
      "custom-b",
    ]);
    expect((await db.workout_sessions.toArray()).map((row) => row.id)).toEqual(["session-b"]);
    expect((await db.exercise_entries.toArray()).map((row) => row.id)).toEqual(["entry-b"]);
    expect((await db.set_entries.toArray()).map((row) => row.id)).toEqual(["set-b"]);
    expect((await db.activities.toArray()).map((row) => row.id)).toEqual(["activity-b"]);
    expect((await db.body_stats.toArray()).map((row) => row.id)).toEqual(["body-b"]);
    expect((await db.climb_sends.toArray()).map((row) => row.activity_id)).toEqual(["activity-b"]);
  });

  it("drops the target's queued ops and keeps the other account's", async () => {
    const db = harness("wipe-ops");
    await seedTwoAccounts(db);
    const before = await db.outbox.count();

    await wipeAccountDataFromDevice(db, USER_A);

    const remaining = (await db.outbox.toArray()).map((row) => row.op_id).sort();
    expect(remaining).toEqual(["op-entry-b", "op-exercise-b", "op-session-b", "op-set-b"]);
    // Direct table deletes queue no new ops: the count only shrinks.
    expect(remaining.length).toBeLessThan(before);
  });

  it("clears device-local scratch but keeps profile and address config", async () => {
    const db = harness("wipe-scratch");
    await seedTwoAccounts(db);

    await wipeAccountDataFromDevice(db, USER_A);

    expect(await db.workout_drafts.count()).toBe(0);
    expect(await getMeta(db, ADOPTED_USER_ID_KEY)).toBeUndefined();
    expect(await getMeta(db, CONFLICT_LOG_KEY)).toBeUndefined();
    const keys = (await db.sync_meta.toArray()).map((row) => row.key);
    expect(keys.some((key) => key.startsWith(PULL_CURSOR_PREFIX))).toBe(false);
    // Device config survives so a returning user is not forced to re-onboard.
    expect((await db.local_profile.get(USER_A))?.display_name).toBe("Ada");
    expect(await db.local_profile.count()).toBe(1);
    expect(await getMeta(db, API_BASE_URL_KEY)).toBe("https://waveform.example");
    // The device belongs to USER_A, so its sync stamps go with the scratch.
    expect(await getMeta(db, LAST_SYNCED_AT_KEY)).toBeUndefined();
    expect(await getMeta(db, FULL_PULL_PENDING_KEY)).toBeUndefined();
  });

  it("is a no-op for a user whose data is not on the device", async () => {
    const db = harness("wipe-none");
    await seedTwoAccounts(db);
    const before = {
      sessions: await db.workout_sessions.count(),
      drafts: await db.workout_drafts.count(),
      ops: await db.outbox.count(),
    };

    await wipeAccountDataFromDevice(db, "someone-else");

    // The stranger owns nothing and the device is USER_A's (its marker
    // names USER_A), so even the shared scratch survives: a foreign
    // panel's sign-out must not disturb the log it is leaving behind.
    expect(await db.workout_sessions.count()).toBe(before.sessions);
    expect(await db.outbox.count()).toBe(before.ops);
    expect(await db.workout_drafts.count()).toBe(before.drafts);
    expect(await getMeta(db, ADOPTED_USER_ID_KEY)).toBe(USER_A);
  });

  it("keeps a foreign device's scratch so the next sign-in still sees foreign", async () => {
    const db = harness("wipe-foreign-marker");
    await db.exercises.add(exercise("custom-b", USER_B));
    await db.workout_sessions.add(session("session-b", USER_B));
    await db.local_profile.put(profile(USER_B));
    await setMeta(db, ADOPTED_USER_ID_KEY, USER_B);
    await setMeta(db, `${PULL_CURSOR_PREFIX}workout_sessions`, "cursor-b");
    await setMeta(db, LAST_SYNCED_AT_KEY, STAMP);
    await setMeta(db, CONFLICT_LOG_KEY, [{ note: "foreign" }]);
    await setMeta(db, FULL_PULL_PENDING_KEY, true);
    await db.workout_drafts.put(draft("draft-b"));

    // A different account signs out: it owns nothing here, so the foreign
    // log and every piece of device-local scratch must survive untouched.
    await wipeAccountDataFromDevice(db, USER_A);

    expect(await getMeta(db, ADOPTED_USER_ID_KEY)).toBe(USER_B);
    expect(await getMeta(db, `${PULL_CURSOR_PREFIX}workout_sessions`)).toBe("cursor-b");
    expect(await getMeta(db, LAST_SYNCED_AT_KEY)).toBe(STAMP);
    expect(await getMeta(db, CONFLICT_LOG_KEY)).toEqual([{ note: "foreign" }]);
    expect(await getMeta(db, FULL_PULL_PENDING_KEY)).toBe(true);
    expect(await db.workout_drafts.count()).toBe(1);
    expect((await db.workout_sessions.get("session-b"))?.user_id).toBe(USER_B);

    // The marker and the remaining rows still classify as foreign.
    expect(await classifyOwnership(db, USER_C)).toEqual({
      kind: "foreign",
      ownerIds: [USER_B],
    });
  });
});
