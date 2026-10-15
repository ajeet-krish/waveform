import { afterEach, describe, expect, it } from "vitest";
import { V_GRADE_COUNT, emptySendCounts } from "../../lib/climbing";
import { createRepos, type Repos } from "./index";
import { createWaveformDb, type WaveformDb } from "../schema";
import { LocalValidationError } from "../validation";

type Harness = { db: WaveformDb; repos: Repos };

const openDbs: WaveformDb[] = [];

/** Fresh database plus repos on an advancing one-second test clock. */
function harness(name: string): Harness {
  const db = createWaveformDb(`activities-${name}-${crypto.randomUUID()}`);
  openDbs.push(db);
  let current = Date.UTC(2026, 9, 14, 12, 0, 0);
  const repos = createRepos(db, {
    userId: "user-1",
    now: () => {
      const stamp = new Date(current);
      current += 1000;
      return stamp;
    },
  });
  return { db, repos };
}

afterEach(() => {
  for (const db of openDbs) {
    db.close();
  }
  openDbs.length = 0;
});

/** The exact backend Activity key set (LocalRow<Activity>, no applied_at). */
const ACTIVITY_KEYS = [
  "climb_grade",
  "climb_grade_value",
  "created_at",
  "deleted_at",
  "distance_km",
  "duration_min",
  "elevation_m",
  "id",
  "local_date",
  "notes",
  "routes_sent",
  "started_at",
  "type",
  "updated_at",
  "user_id",
];

/** A histogram with sends at the given grades; length 17. */
function sendsAt(...grades: number[]): number[] {
  const counts = emptySendCounts();
  for (const grade of grades) {
    counts[grade] = (counts[grade] ?? 0) + 1;
  }
  return counts;
}

describe("activities repo", () => {
  it("derives climb fields, writes climb_sends, and queues one create op with the backend key set", async () => {
    const { db, repos } = harness("climb-derive");
    const sends = sendsAt(3, 3, 5);
    const { row, op, sends: sendsRow } = await repos.activities.logActivity({
      type: "climbing",
      local_date: "2026-10-14",
      duration_min: 90,
      sends,
    });

    expect(row.user_id).toBe("user-1");
    expect(row.type).toBe("climbing");
    expect(row.climb_grade).toBe("V5");
    expect(row.climb_grade_value).toBe(5);
    expect(row.routes_sent).toBe(3);
    expect(row.distance_km).toBeNull();
    expect(row.elevation_m).toBeNull();
    expect(row.deleted_at).toBeNull();
    expect(await db.activities.get(row.id)).toEqual(row);

    // The climb_sends row carries the normalized histogram keyed by activity id.
    expect(sendsRow).toBeDefined();
    expect(sendsRow?.activity_id).toBe(row.id);
    expect(sendsRow?.counts).toHaveLength(V_GRADE_COUNT);
    expect(sendsRow?.counts).toEqual(sends);
    expect(await db.climb_sends.get(row.id)).toEqual(sendsRow);

    // Exactly one op, and its payload has exactly the backend Activity keys.
    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    const queued = ops[0];
    expect(queued?.entity).toBe("activities");
    expect(queued?.action).toBe("create");
    expect(queued?.op_id).toBe(op.op_id);
    expect(Object.keys(queued?.payload ?? {}).sort()).toEqual(ACTIVITY_KEYS);
    expect(queued?.payload).not.toHaveProperty("sends");
    expect(queued?.payload).not.toHaveProperty("applied_at");
  });

  it("shares one timestamp across the row, the sends row, and the op", async () => {
    const { repos } = harness("climb-timestamp");
    const { row, op, sends } = await repos.activities.logActivity({
      type: "climbing",
      local_date: "2026-10-14",
      sends: sendsAt(4),
    });

    expect(row.updated_at).toBe(row.created_at);
    expect(op.updated_at).toBe(row.updated_at);
    expect(op.created_at).toBe(row.updated_at);
    expect(sends?.updated_at).toBe(row.updated_at);
  });

  it("logs cycling with null climb fields and no climb_sends row", async () => {
    const { db, repos } = harness("cycling");
    const { row, sends } = await repos.activities.logActivity({
      type: "cycling",
      local_date: "2026-10-14",
      distance_km: 32.5,
      elevation_m: 410,
      duration_min: 75,
    });

    expect(row.type).toBe("cycling");
    expect(row.climb_grade).toBeNull();
    expect(row.climb_grade_value).toBeNull();
    expect(row.routes_sent).toBeNull();
    expect(row.distance_km).toBe(32.5);
    expect(row.elevation_m).toBe(410);
    expect(sends).toBeUndefined();
    expect(await db.climb_sends.get(row.id)).toBeUndefined();

    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]?.entity).toBe("activities");
  });

  it("derives null grades and routes_sent 0 from an empty histogram", async () => {
    const { repos } = harness("climb-empty");
    const { row } = await repos.activities.logActivity({
      type: "climbing",
      local_date: "2026-10-14",
      sends: [],
    });

    expect(row.climb_grade).toBeNull();
    expect(row.climb_grade_value).toBeNull();
    expect(row.routes_sent).toBe(0);
  });

  it("update recomputes climb fields when sends change and queues one update op", async () => {
    const { db, repos } = harness("climb-update");
    const created = await repos.activities.logActivity({
      type: "climbing",
      local_date: "2026-10-14",
      sends: sendsAt(2),
    });
    expect(created.row.climb_grade).toBe("V2");

    const { row, op, sends } = await repos.activities.update(created.row.id, {
      sends: sendsAt(6, 6, 6),
    });
    expect(row.climb_grade).toBe("V6");
    expect(row.climb_grade_value).toBe(6);
    expect(row.routes_sent).toBe(3);
    expect(row.created_at).toBe(created.row.created_at);
    expect(sends?.counts).toEqual(sendsAt(6, 6, 6));
    expect(await db.climb_sends.get(row.id)).toEqual(sends);
    expect(op.action).toBe("update");

    const ops = await repos.outbox.listPending();
    expect(ops.map((queued) => queued.action)).toEqual(["create", "update"]);
  });

  it("update on a missing row throws LocalValidationError", async () => {
    const { repos } = harness("climb-update-missing");
    await expect(repos.activities.update("missing", { duration_min: 30 })).rejects.toThrow(
      LocalValidationError,
    );
  });

  it("update on an already-tombstoned row throws LocalValidationError", async () => {
    const { db, repos } = harness("climb-update-tombstoned");
    const created = await repos.activities.logActivity({
      type: "climbing",
      local_date: "2026-10-14",
      sends: sendsAt(3),
    });
    await repos.activities.remove(created.row.id);
    const opsBefore = await db.outbox.count();

    await expect(repos.activities.update(created.row.id, { duration_min: 30 })).rejects.toThrow(
      LocalValidationError,
    );
    const tomb = await db.activities.get(created.row.id);
    expect(tomb?.duration_min).toBe(created.row.duration_min);
    expect(await db.outbox.count()).toBe(opsBefore);
  });

  it("update ignores sends on a cycling row and never writes climb fields", async () => {
    const { db, repos } = harness("cycling-update-sends");
    const created = await repos.activities.logActivity({
      type: "cycling",
      local_date: "2026-10-14",
      distance_km: 32.5,
      elevation_m: 410,
    });

    const { row, op, sends } = await repos.activities.update(created.row.id, {
      duration_min: 80,
      sends: sendsAt(6, 6),
    });

    // The stray sends patch is ignored: no climb derivation, no histogram.
    expect(row.type).toBe("cycling");
    expect(row.climb_grade).toBeNull();
    expect(row.climb_grade_value).toBeNull();
    expect(row.routes_sent).toBeNull();
    expect(sends).toBeUndefined();
    expect(await db.climb_sends.get(row.id)).toBeUndefined();

    // The rest of the patch still applies.
    expect(row.duration_min).toBe(80);
    expect(row.distance_km).toBe(32.5);
    expect(row.elevation_m).toBe(410);
    expect(op.action).toBe("update");
    expect(op.payload.climb_grade).toBeNull();
    expect(op.payload.routes_sent).toBeNull();
  });

  it("update ignores distance and elevation on a climbing row, keeping them null", async () => {
    const { db, repos } = harness("climb-update-distance");
    const created = await repos.activities.logActivity({
      type: "climbing",
      local_date: "2026-10-14",
      duration_min: 90,
      sends: sendsAt(4),
    });

    const { row, op } = await repos.activities.update(created.row.id, {
      distance_km: 10,
      elevation_m: 200,
      notes: "project day",
    });

    expect(row.type).toBe("climbing");
    expect(row.distance_km).toBeNull();
    expect(row.elevation_m).toBeNull();
    expect(await db.activities.get(row.id)).toEqual(row);
    expect(op.payload.distance_km).toBeNull();
    expect(op.payload.elevation_m).toBeNull();

    // The rest of the patch still applies and the histogram is untouched.
    expect(row.notes).toBe("project day");
    expect(row.duration_min).toBe(90);
    expect(row.routes_sent).toBe(1);
    expect((await db.climb_sends.get(row.id))?.counts).toEqual(sendsAt(4));
  });

  it("update rejects an out-of-range duration and leaves the row unchanged", async () => {
    const { db, repos } = harness("climb-update-invalid");
    const created = await repos.activities.logActivity({
      type: "cycling",
      local_date: "2026-10-14",
      distance_km: 10,
    });
    await expect(
      repos.activities.update(created.row.id, { duration_min: 2000 }),
    ).rejects.toThrow(LocalValidationError);
    const unchanged = await db.activities.get(created.row.id);
    expect(unchanged?.duration_min).toBeNull();
  });

  it("remove tombstones the row, hard-deletes climb_sends, and queues one delete op", async () => {
    const { db, repos } = harness("climb-remove");
    const created = await repos.activities.logActivity({
      type: "climbing",
      local_date: "2026-10-14",
      sends: sendsAt(3),
    });

    const ops = await repos.activities.remove(created.row.id);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.action).toBe("delete");
    expect(ops[0]?.entity).toBe("activities");
    expect(ops[0]?.payload.deleted_at).not.toBeNull();

    const tomb = await db.activities.get(created.row.id);
    expect(tomb?.deleted_at).not.toBeNull();
    expect(tomb?.deleted_at).toBe(tomb?.updated_at);
    expect(await db.climb_sends.get(created.row.id)).toBeUndefined();
    expect(await db.outbox.count()).toBe(2);
  });

  it("remove on an already-tombstoned or missing row is a no-op", async () => {
    const { db, repos } = harness("climb-remove-twice");
    const created = await repos.activities.logActivity({
      type: "climbing",
      local_date: "2026-10-14",
      sends: sendsAt(1),
    });
    await repos.activities.remove(created.row.id);
    const opsBefore = await db.outbox.count();

    const second = await repos.activities.remove(created.row.id);
    expect(second).toHaveLength(0);
    expect(await repos.activities.remove("missing")).toHaveLength(0);
    expect(await db.outbox.count()).toBe(opsBefore);
  });

  it("listByType filters by type, hides tombstones, and sorts local_date desc then id desc", async () => {
    const { db, repos } = harness("list-by-type");
    const stamp = "2026-10-14T00:00:00.000Z";
    const activity = (
      id: string,
      type: "climbing" | "cycling",
      local_date: string,
      deleted_at: string | null = null,
    ) => ({
      id,
      user_id: "user-1",
      type,
      local_date,
      started_at: null,
      duration_min: null,
      distance_km: null,
      elevation_m: null,
      climb_grade: null,
      climb_grade_value: null,
      routes_sent: null,
      notes: null,
      created_at: stamp,
      updated_at: stamp,
      deleted_at,
    });
    await db.activities.bulkPut([
      activity("act-a", "climbing", "2026-10-12"),
      activity("act-b", "climbing", "2026-10-14"),
      activity("act-c", "climbing", "2026-10-14"),
      activity("act-d", "climbing", "2026-10-15", stamp),
      activity("act-e", "cycling", "2026-10-14"),
    ]);

    const climbs = await repos.activities.listByType("climbing");
    expect(climbs.map((row) => row.id)).toEqual(["act-c", "act-b", "act-a"]);

    const rides = await repos.activities.listByType("cycling");
    expect(rides.map((row) => row.id)).toEqual(["act-e"]);
  });

  it("listByDateRange is inclusive on both bounds and skips tombstones", async () => {
    const { db, repos } = harness("list-by-range");
    const stamp = "2026-10-14T00:00:00.000Z";
    const activity = (id: string, local_date: string, deleted_at: string | null = null) => ({
      id,
      user_id: "user-1",
      type: "cycling" as const,
      local_date,
      started_at: null,
      duration_min: null,
      distance_km: null,
      elevation_m: null,
      climb_grade: null,
      climb_grade_value: null,
      routes_sent: null,
      notes: null,
      created_at: stamp,
      updated_at: stamp,
      deleted_at,
    });
    await db.activities.bulkPut([
      activity("act-1", "2026-10-12"),
      activity("act-2", "2026-10-13"),
      activity("act-3", "2026-10-14"),
      activity("act-4", "2026-10-15", stamp),
    ]);

    const window = await repos.activities.listByDateRange("2026-10-13", "2026-10-14");
    expect(window.map((row) => row.id)).toEqual(["act-2", "act-3"]);
  });

  it("listClimbs pairs live climbing activities with their sends", async () => {
    const { repos } = harness("list-climbs");
    const removed = await repos.activities.logActivity({
      type: "climbing",
      local_date: "2026-10-13",
      sends: sendsAt(2),
    });
    const kept = await repos.activities.logActivity({
      type: "climbing",
      local_date: "2026-10-14",
      sends: sendsAt(4, 4),
    });
    await repos.activities.logActivity({
      type: "cycling",
      local_date: "2026-10-14",
      distance_km: 12,
    });
    await repos.activities.remove(removed.row.id);

    const logs = await repos.activities.listClimbs();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.activity.id).toBe(kept.row.id);
    expect(logs[0]?.sends?.counts).toEqual(sendsAt(4, 4));

    expect(await repos.activities.getSends(removed.row.id)).toBeUndefined();
    expect((await repos.activities.getSends(kept.row.id))?.counts).toEqual(sendsAt(4, 4));
  });

  it("rejects a climbing log with an invalid duration before touching the database", async () => {
    const { db, repos } = harness("climb-log-invalid");
    await expect(
      repos.activities.logActivity({
        type: "climbing",
        local_date: "2026-10-14",
        duration_min: 5000,
        sends: sendsAt(3),
      }),
    ).rejects.toThrow(LocalValidationError);
    expect(await db.activities.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });

  it("rejects a body-stat-like invalid local_date on a ride", async () => {
    const { repos } = harness("cycling-bad-date");
    await expect(
      repos.activities.logActivity({
        type: "cycling",
        local_date: "14/10/2026",
        distance_km: 10,
      }),
    ).rejects.toThrow(LocalValidationError);
  });
});
