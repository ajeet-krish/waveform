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
import type { ClimbSends, LocalProfile, LocalRow, OutboxOp, WorkoutDraft } from "../../db/types";
import { ADOPTED_USER_ID_KEY, PULL_CURSOR_PREFIX, getMeta, setMeta } from "./meta";
import { adoptLocalUser, adoptStartEmpty, needsAdoption } from "./adoption";
import { ForeignOwnerError } from "./ownership";

const OLD_ID = "device-local-1";
const NEW_ID = "server-user-9";
const STAMP = "2026-10-14T00:00:00.000Z";

const openDbs: WaveformDb[] = [];

function harness(name: string): WaveformDb {
  const db = createWaveformDb(`adoption-${name}-${crypto.randomUUID()}`);
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

/** Seeds one row per synced store, one custom plus one global exercise,
 * two outbox ops whose payloads carry the old id, and the device-local
 * rows adoption must NOT touch. */
async function seed(db: WaveformDb): Promise<void> {
  const exercises: Array<LocalRow<Exercise>> = [
    {
      id: "catalog-1",
      owner_id: null,
      name: "Bench Press (Barbell)",
      muscle_group: "chest",
      equipment: "barbell",
      created_at: STAMP,
      updated_at: STAMP,
      deleted_at: null,
    },
    {
      id: "custom-1",
      owner_id: OLD_ID,
      name: "My Lift",
      muscle_group: "chest",
      equipment: null,
      created_at: STAMP,
      updated_at: STAMP,
      deleted_at: null,
    },
  ];
  const session: LocalRow<WorkoutSession> = {
    id: "session-1",
    user_id: OLD_ID,
    local_date: "2026-10-14",
    started_at: null,
    duration_min: null,
    routine_id: null,
    notes: null,
    created_at: STAMP,
    updated_at: STAMP,
    deleted_at: null,
  };
  const entry: LocalRow<ExerciseEntry> = {
    id: "entry-1",
    workout_id: "session-1",
    exercise_id: "custom-1",
    order_index: 0,
    notes: null,
    created_at: STAMP,
    updated_at: STAMP,
    deleted_at: null,
  };
  const setRow: LocalRow<SetEntry> = {
    id: "set-1",
    exercise_entry_id: "entry-1",
    set_index: 0,
    weight_kg: 60,
    reps: 5,
    is_warmup: false,
    e1rm_kg: 70,
    created_at: STAMP,
    updated_at: STAMP,
    deleted_at: null,
  };
  const activity: LocalRow<Activity> = {
    id: "activity-1",
    user_id: OLD_ID,
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
  const body: LocalRow<BodyStats> = {
    id: "body-1",
    user_id: OLD_ID,
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

  await db.exercises.bulkAdd(exercises);
  await db.workout_sessions.add(session);
  await db.exercise_entries.add(entry);
  await db.set_entries.add(setRow);
  await db.activities.add(activity);
  await db.body_stats.add(body);

  const sessionOp: OutboxOp<"workout_sessions"> = {
    op_id: "op-session",
    entity: "workout_sessions",
    action: "update",
    payload: session,
    updated_at: STAMP,
    created_at: STAMP,
  };
  const exerciseOp: OutboxOp<"exercises"> = {
    op_id: "op-exercise",
    entity: "exercises",
    action: "update",
    payload: exercises[1] as LocalRow<Exercise>,
    updated_at: STAMP,
    created_at: STAMP,
  };
  await db.outbox.bulkAdd([sessionOp, exerciseOp]);

  await db.local_profile.put(profile(OLD_ID));
  const sends: ClimbSends = {
    activity_id: "activity-1",
    counts: Array.from({ length: 17 }, () => 0),
    updated_at: STAMP,
  };
  await db.climb_sends.put(sends);
  const draft: WorkoutDraft = {
    id: "draft-1",
    local_date: "2026-10-15",
    started_at: null,
    duration_min: null,
    routine_id: null,
    notes: null,
    entries: [],
    updated_at: STAMP,
  };
  await db.workout_drafts.put(draft);

  await setMeta(db, `${PULL_CURSOR_PREFIX}workout_sessions`, "cursor-x");
  await setMeta(db, `${PULL_CURSOR_PREFIX}activities`, "cursor-y");
  await setMeta(db, "last_synced_at", STAMP);
}

describe("needsAdoption", () => {
  it("is true before adoption and false for the adopted user", async () => {
    const db = harness("needs");
    await seed(db);
    expect(await needsAdoption(db, NEW_ID)).toBe(true);
    await adoptLocalUser(db, NEW_ID);
    expect(await needsAdoption(db, NEW_ID)).toBe(false);
    // A different user still needs adoption.
    expect(await needsAdoption(db, "someone-else")).toBe(true);
  });
});

describe("adoptLocalUser", () => {
  it("rewrites owner/user ids across every store, outbox payload, and profile", async () => {
    const db = harness("rewrite");
    await seed(db);

    const summary = await adoptLocalUser(db, NEW_ID);
    expect(summary).toEqual({
      adopted: true,
      rowsRewritten: 4,
      opsRewritten: 2,
      profileRewritten: true,
    });

    // Custom exercise takes the new owner; the catalog row stays global.
    expect((await db.exercises.get("custom-1"))?.owner_id).toBe(NEW_ID);
    expect((await db.exercises.get("catalog-1"))?.owner_id).toBeNull();

    // Entries and sets scope through their parents (no user_id column).
    expect((await db.workout_sessions.get("session-1"))?.user_id).toBe(NEW_ID);
    expect((await db.activities.get("activity-1"))?.user_id).toBe(NEW_ID);
    expect((await db.body_stats.get("body-1"))?.user_id).toBe(NEW_ID);
    // The child rows still exist and still hang off their parents.
    expect((await db.exercise_entries.get("entry-1"))?.workout_id).toBe("session-1");
    expect((await db.set_entries.get("set-1"))?.exercise_entry_id).toBe("entry-1");

    // The queued ops carry the new ids in their payloads, op ids intact.
    const sessionOp = await db.outbox.get("op-session");
    expect((sessionOp?.payload as { user_id: string }).user_id).toBe(NEW_ID);
    const exerciseOp = await db.outbox.get("op-exercise");
    expect((exerciseOp?.payload as { owner_id: string }).owner_id).toBe(NEW_ID);

    // The profile row is re-keyed, not duplicated.
    expect(await db.local_profile.get(OLD_ID)).toBeUndefined();
    expect((await db.local_profile.get(NEW_ID))?.display_name).toBe("Ada");
    expect(await db.local_profile.count()).toBe(1);

    expect(await getMeta(db, ADOPTED_USER_ID_KEY)).toBe(NEW_ID);

    // Device-local rows are untouched.
    expect(await db.climb_sends.get("activity-1")).toBeDefined();
    expect(await db.workout_drafts.get("draft-1")).toBeDefined();
    expect(await getMeta(db, `${PULL_CURSOR_PREFIX}workout_sessions`)).toBe("cursor-x");
  });

  it("writes no new outbox ops while rewriting", async () => {
    const db = harness("no-ops");
    await seed(db);
    const before = await db.outbox.count();
    await adoptLocalUser(db, NEW_ID);
    expect(await db.outbox.count()).toBe(before);
  });

  it("is idempotent: a second run rewrites nothing", async () => {
    const db = harness("idempotent");
    await seed(db);
    await adoptLocalUser(db, NEW_ID);

    const again = await adoptLocalUser(db, NEW_ID);
    expect(again).toEqual({
      adopted: false,
      rowsRewritten: 0,
      opsRewritten: 0,
      profileRewritten: false,
    });
    expect(await db.local_profile.count()).toBe(1);
    expect((await db.workout_sessions.get("session-1"))?.user_id).toBe(NEW_ID);
  });

  it("refuses to adopt a foreign device and modifies nothing", async () => {
    const db = harness("foreign");
    await seed(db);
    // The device is already claimed by its own local owner, so a sign-in as
    // a different account finds a log that is not theirs.
    await setMeta(db, ADOPTED_USER_ID_KEY, OLD_ID);
    const before = {
      session: await db.workout_sessions.get("session-1"),
      exercise: await db.exercises.get("custom-1"),
      profile: await db.local_profile.get(OLD_ID),
      ops: await db.outbox.count(),
      adopted: await getMeta(db, ADOPTED_USER_ID_KEY),
    };

    await expect(adoptLocalUser(db, NEW_ID)).rejects.toBeInstanceOf(ForeignOwnerError);

    // Every row, the profile, the outbox, and the marker are untouched.
    expect(await db.workout_sessions.get("session-1")).toEqual(before.session);
    expect((await db.workout_sessions.get("session-1"))?.user_id).toBe(OLD_ID);
    expect(await db.exercises.get("custom-1")).toEqual(before.exercise);
    expect(await db.local_profile.get(OLD_ID)).toEqual(before.profile);
    expect(await db.local_profile.count()).toBe(1);
    expect(await db.outbox.count()).toBe(before.ops);
    expect(await getMeta(db, ADOPTED_USER_ID_KEY)).toBe(OLD_ID);
  });
});

describe("adoptStartEmpty", () => {
  it("wipes synced stores, outbox, climb_sends, and cursors; keeps drafts", async () => {
    const db = harness("start-empty");
    await seed(db);

    const summary = await adoptStartEmpty(db, NEW_ID);
    expect(summary.rowsWiped).toBe(7);
    expect(summary.opsWiped).toBe(2);
    expect(summary.sendsWiped).toBe(1);
    expect(summary.cursorsCleared).toBe(2);
    expect(summary.profileRewritten).toBe(true);

    expect(await db.exercises.count()).toBe(0);
    expect(await db.workout_sessions.count()).toBe(0);
    expect(await db.exercise_entries.count()).toBe(0);
    expect(await db.set_entries.count()).toBe(0);
    expect(await db.activities.count()).toBe(0);
    expect(await db.body_stats.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
    expect(await db.climb_sends.count()).toBe(0);

    // Every pull_cursor:* key is gone; other sync_meta keys survive.
    const remainingKeys = (await db.sync_meta.toArray()).map((row) => row.key);
    expect(remainingKeys.some((key) => key.startsWith(PULL_CURSOR_PREFIX))).toBe(false);
    expect(remainingKeys).toContain("last_synced_at");

    // Drafts and the re-keyed profile survive the wipe.
    expect(await db.workout_drafts.get("draft-1")).toBeDefined();
    expect(await db.local_profile.get(OLD_ID)).toBeUndefined();
    expect(await db.local_profile.get(NEW_ID)).toBeDefined();
    expect(await getMeta(db, ADOPTED_USER_ID_KEY)).toBe(NEW_ID);
  });

  it("is idempotent: a second run for the same user wipes nothing", async () => {
    const db = harness("start-empty-idempotent");
    await seed(db);
    await adoptStartEmpty(db, NEW_ID);

    // Data that landed after the first adoption: one downloaded session
    // with its queued op, plus a cursor pulled from the server tip.
    const synced: LocalRow<WorkoutSession> = {
      id: "session-2",
      user_id: NEW_ID,
      local_date: "2026-10-16",
      started_at: null,
      duration_min: null,
      routine_id: null,
      notes: null,
      created_at: STAMP,
      updated_at: STAMP,
      deleted_at: null,
    };
    const syncedOp: OutboxOp<"workout_sessions"> = {
      op_id: "op-later",
      entity: "workout_sessions",
      action: "update",
      payload: synced,
      updated_at: STAMP,
      created_at: STAMP,
    };
    await db.workout_sessions.add(synced);
    await db.outbox.add(syncedOp);
    await setMeta(db, `${PULL_CURSOR_PREFIX}workout_sessions`, "cursor-after");

    const again = await adoptStartEmpty(db, NEW_ID);
    expect(again).toEqual({
      rowsWiped: 0,
      opsWiped: 0,
      sendsWiped: 0,
      cursorsCleared: 0,
      profileRewritten: false,
    });

    // The duplicate call is a no-op: nothing downloaded was wiped.
    expect(await db.workout_sessions.count()).toBe(1);
    expect(await db.outbox.count()).toBe(1);
    expect(await getMeta(db, `${PULL_CURSOR_PREFIX}workout_sessions`)).toBe("cursor-after");
    expect(await db.local_profile.count()).toBe(1);
    expect((await db.local_profile.get(NEW_ID))?.display_name).toBe("Ada");
    expect(await getMeta(db, ADOPTED_USER_ID_KEY)).toBe(NEW_ID);
  });
});
