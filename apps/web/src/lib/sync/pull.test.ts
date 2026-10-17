import { afterEach, describe, expect, it } from "vitest";
import type { PullPage, PullRow } from "@waveform/api-types";
import { createWaveformDb, type WaveformDb } from "../../db/schema";
import type { LocalRow, OutboxOp, WorkoutDraft } from "../../db/types";
import type { WorkoutSession as WireWorkout } from "@waveform/api-types";
import { ApiError } from "../api";
import {
  CONFLICT_LOG_CAP,
  CLIENT_PULL_ORDER,
  FULL_REPULL_INTERVAL_MS,
  dueForFullRepull,
  mergePullRow,
  pullAll,
  type PullConflictEntry,
  type SyncPullApi,
} from "./pull";
import {
  CONFLICT_LOG_KEY,
  FULL_PULL_PENDING_KEY,
  LAST_FULL_PULL_AT_KEY,
  LAST_SYNCED_AT_KEY,
  getMeta,
  pullCursorKey,
  setMeta,
} from "./meta";

const STAMP = "2026-10-14T00:00:00.000Z";

const openDbs: WaveformDb[] = [];

function harness(name: string): WaveformDb {
  const db = createWaveformDb(`pull-${name}-${crypto.randomUUID()}`);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDbs) {
    db.close();
  }
  openDbs.length = 0;
});

function sessionRow(
  id: string,
  updated_at: string,
  notes: string | null = null,
  deleted_at: string | null = null,
): LocalRow<WireWorkout> {
  return {
    id,
    user_id: "server-user-9",
    local_date: "2026-10-14",
    started_at: null,
    duration_min: null,
    routine_id: null,
    notes,
    created_at: STAMP,
    updated_at,
    deleted_at,
  };
}

/** A pulled row for one session: payload minus applied_at, per the wire. */
function pullRow(row: LocalRow<WireWorkout>): PullRow {
  return {
    entity: "workout_sessions",
    id: row.id,
    applied_at: STAMP,
    payload: { ...row },
  };
}

function sessionOp(id: string, updated_at: string, op_id: string): OutboxOp {
  return {
    op_id,
    entity: "workout_sessions",
    action: "update",
    payload: sessionRow(id, updated_at),
    updated_at,
    created_at: "2026-10-01T00:00:00.000Z",
  };
}

describe("CLIENT_PULL_ORDER", () => {
  it("lists parents before children", () => {
    expect(CLIENT_PULL_ORDER).toEqual([
      "exercises",
      "workout_sessions",
      "exercise_entries",
      "set_entries",
      "activities",
      "body_stats",
    ]);
  });
});

describe("mergePullRow", () => {
  it("writes a strictly newer incoming row and keeps local on a tie", async () => {
    const db = harness("lww");
    await db.workout_sessions.put(sessionRow("s1", "2026-10-13T00:00:00.000Z", "local"));

    // Strictly newer: incoming wins.
    const newer = await mergePullRow(
      db,
      pullRow(sessionRow("s1", "2026-10-14T01:00:00.000Z", "server")),
      new Date(STAMP),
    );
    expect(newer).toEqual({ merged: true, conflict: false });
    expect((await db.workout_sessions.get("s1"))?.notes).toBe("server");

    // Tie: local stays, incoming is ignored.
    const tied = await mergePullRow(
      db,
      pullRow(sessionRow("s1", "2026-10-14T01:00:00.000Z", "server-again")),
      new Date(STAMP),
    );
    expect(tied).toEqual({ merged: false, conflict: false });
    expect((await db.workout_sessions.get("s1"))?.notes).toBe("server");

    // Older: local stays.
    const older = await mergePullRow(
      db,
      pullRow(sessionRow("s1", "2026-10-12T00:00:00.000Z", "stale")),
      new Date(STAMP),
    );
    expect(older).toEqual({ merged: false, conflict: false });
    expect((await db.workout_sessions.get("s1"))?.notes).toBe("server");
  });

  it("merges a tombstone and writes no outbox op", async () => {
    const db = harness("tombstone");
    await db.workout_sessions.put(sessionRow("s1", "2026-10-13T00:00:00.000Z"));
    const opsBefore = await db.outbox.count();

    const result = await mergePullRow(
      db,
      pullRow(sessionRow("s1", "2026-10-14T02:00:00.000Z", null, "2026-10-14T02:00:00.000Z")),
      new Date(STAMP),
    );
    expect(result.merged).toBe(true);
    const stored = await db.workout_sessions.get("s1");
    expect(stored?.deleted_at).toBe("2026-10-14T02:00:00.000Z");
    // Pulled rows never regenerate ops.
    expect(await db.outbox.count()).toBe(opsBefore);
  });

  it("drops superseded queued ops and appends one conflict entry", async () => {
    const db = harness("conflict");
    await db.workout_sessions.put(sessionRow("s1", "2026-10-13T00:00:00.000Z", "local"));
    // op-stale is superseded by the incoming row; op-newer is not.
    await db.outbox.bulkAdd([
      sessionOp("s1", "2026-10-13T00:00:00.000Z", "op-stale"),
      sessionOp("s1", "2026-10-15T00:00:00.000Z", "op-newer"),
    ]);

    const result = await mergePullRow(
      db,
      pullRow(sessionRow("s1", "2026-10-14T00:00:00.000Z", "server")),
      new Date(STAMP),
    );
    expect(result).toEqual({ merged: true, conflict: true });

    // The superseded op is gone; the newer local edit stays queued.
    const remaining = (await db.outbox.toArray()).map((o) => o.op_id);
    expect(remaining).toEqual(["op-newer"]);

    const log = (await getMeta(db, CONFLICT_LOG_KEY)) as PullConflictEntry[];
    expect(log).toHaveLength(1);
    expect(log[0]).toEqual({
      entity: "workout_sessions",
      id: "s1",
      dropped: 1,
      incoming_updated_at: "2026-10-14T00:00:00.000Z",
      local_updated_at: "2026-10-13T00:00:00.000Z",
      at: STAMP,
    });
  });

  it("caps the conflict log at 200 entries", async () => {
    const db = harness("log-cap");
    const full: PullConflictEntry[] = Array.from({ length: CONFLICT_LOG_CAP }, (_, i) => ({
      entity: "activities",
      id: `old-${i}`,
      dropped: 1,
      incoming_updated_at: STAMP,
      local_updated_at: null,
      at: STAMP,
    }));
    await setMeta(db, CONFLICT_LOG_KEY, full);

    await db.workout_sessions.put(sessionRow("s1", "2026-10-13T00:00:00.000Z"));
    await db.outbox.add(sessionOp("s1", "2026-10-13T00:00:00.000Z", "op-stale"));
    await mergePullRow(
      db,
      pullRow(sessionRow("s1", "2026-10-14T00:00:00.000Z")),
      new Date(STAMP),
    );

    const log = (await getMeta(db, CONFLICT_LOG_KEY)) as PullConflictEntry[];
    expect(log).toHaveLength(CONFLICT_LOG_CAP);
    // Oldest evicted, the new entry is last.
    expect(log[0]?.id).toBe("old-1");
    expect(log[CONFLICT_LOG_CAP - 1]?.id).toBe("s1");
  });

  it("queues no ops for a brand-new incoming row", async () => {
    const db = harness("no-ops");
    const result = await mergePullRow(
      db,
      pullRow(sessionRow("s-new", "2026-10-14T00:00:00.000Z")),
      new Date(STAMP),
    );
    expect(result).toEqual({ merged: true, conflict: false });
    expect(await db.workout_sessions.get("s-new")).toBeDefined();
    expect(await db.outbox.count()).toBe(0);
  });

  it("skips entities the client does not store", async () => {
    const db = harness("foreign");
    const row: PullRow = {
      entity: "routines",
      id: "r1",
      applied_at: STAMP,
      payload: { id: "r1", updated_at: STAMP },
    };
    expect(await mergePullRow(db, row, new Date(STAMP))).toEqual({
      merged: false,
      conflict: false,
    });
  });
});

/** A scripted pull server: entity -> queue of pages (or an error). */
function scriptedPull(
  pages: Map<string, Array<PullPage | ApiError>>,
): { api: SyncPullApi; calls: Array<{ entity: string; cursor: string | null }> } {
  const calls: Array<{ entity: string; cursor: string | null }> = [];
  const api: SyncPullApi = {
    async pull(params) {
      calls.push({ entity: params.entity, cursor: params.cursor ?? null });
      const queue = pages.get(params.entity);
      const next = queue?.shift();
      if (next === undefined) {
        // Entities with no script answer an empty tip immediately.
        return { rows: [], next_cursor: null };
      }
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
  };
  return { api, calls };
}

describe("dueForFullRepull", () => {
  const now = new Date(STAMP);

  it("is due when never run or when the stamp is unparseable", () => {
    expect(dueForFullRepull(null, now)).toBe(true);
    expect(dueForFullRepull("not-a-date", now)).toBe(true);
  });

  it("is not due within the interval and due at or past it", () => {
    const recent = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const stale = new Date(now.getTime() - FULL_REPULL_INTERVAL_MS).toISOString();
    expect(dueForFullRepull(recent, now)).toBe(false);
    expect(dueForFullRepull(stale, now)).toBe(true);
  });

  it("is due when the stored stamp is in the future", () => {
    // A backward clock step must not suppress the safety net indefinitely.
    const future = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    expect(dueForFullRepull(future, now)).toBe(true);
  });

  it("honors a custom interval", () => {
    const thirtyMin = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
    expect(dueForFullRepull(thirtyMin, now, 60 * 60 * 1000)).toBe(false);
    expect(dueForFullRepull(thirtyMin, now, 15 * 60 * 1000)).toBe(true);
  });
});

describe("pullAll", () => {
  it("pages every entity to the tip, persists cursors, stamps last_synced_at", async () => {
    const db = harness("full");
    const row = sessionRow("s1", "2026-10-14T00:00:00.000Z");
    const { api, calls } = scriptedPull(
      new Map([
        [
          "workout_sessions",
          [
            { rows: [pullRow(row)], next_cursor: "cursor-1" },
            { rows: [], next_cursor: null },
          ] as Array<PullPage | ApiError>,
        ],
      ]),
    );

    const result = await pullAll({ db, api, now: new Date(STAMP) });
    expect(result).toEqual({ merged: 1, conflicts: 0, complete: true });
    expect((await db.workout_sessions.get("s1"))?.user_id).toBe("server-user-9");

    // First call resumed from no cursor; the second used the persisted one.
    const sessionCalls = calls.filter((c) => c.entity === "workout_sessions");
    expect(sessionCalls).toEqual([
      { entity: "workout_sessions", cursor: null },
      { entity: "workout_sessions", cursor: "cursor-1" },
    ]);
    // The tail page leaves the cursor at the last non-null value.
    expect(await getMeta(db, pullCursorKey("workout_sessions"))).toBe("cursor-1");
    expect(await getMeta(db, LAST_SYNCED_AT_KEY)).toBe(STAMP);
  });

  it("resumes from a previously persisted cursor when a full re-pull is not due", async () => {
    const db = harness("resume");
    const recent = new Date(new Date(STAMP).getTime() - 60 * 60 * 1000).toISOString();
    await setMeta(db, pullCursorKey("workout_sessions"), "cursor-9");
    await setMeta(db, LAST_FULL_PULL_AT_KEY, recent);
    const { api, calls } = scriptedPull(new Map());

    const result = await pullAll({ db, api, now: new Date(STAMP) });
    expect(result.complete).toBe(true);
    const sessionCalls = calls.filter((c) => c.entity === "workout_sessions");
    expect(sessionCalls).toEqual([{ entity: "workout_sessions", cursor: "cursor-9" }]);
    // A not-due run leaves the full-pull stamp exactly where it was.
    expect(await getMeta(db, LAST_FULL_PULL_AT_KEY)).toBe(recent);
  });

  it("starts a due full re-pull from the beginning without deleting cursors", async () => {
    const db = harness("due-repull");
    await db.workout_sessions.put(sessionRow("s1", "2026-10-13T00:00:00.000Z", "local"));
    await setMeta(db, pullCursorKey("workout_sessions"), "cursor-old");
    await setMeta(db, LAST_FULL_PULL_AT_KEY, "2026-10-01T00:00:00.000Z");

    const { api, calls } = scriptedPull(
      new Map([
        [
          "workout_sessions",
          [
            {
              rows: [pullRow(sessionRow("s1", "2026-10-13T00:00:00.000Z", "server-again"))],
              next_cursor: null,
            },
          ] as Array<PullPage | ApiError>,
        ],
      ]),
    );

    const result = await pullAll({ db, api, now: new Date(STAMP) });

    // The stored cursor was ignored: the walk started from null.
    const sessionCalls = calls.filter((c) => c.entity === "workout_sessions");
    expect(sessionCalls).toEqual([{ entity: "workout_sessions", cursor: null }]);
    // The re-sent row ties on updated_at, so the local row is kept.
    expect((await db.workout_sessions.get("s1"))?.notes).toBe("local");
    expect(result).toEqual({ merged: 0, conflicts: 0, complete: true });
    expect(await getMeta(db, LAST_FULL_PULL_AT_KEY)).toBe(STAMP);
    // A completed full pull clears the pending flag.
    expect(await getMeta(db, FULL_PULL_PENDING_KEY)).toBeUndefined();
  });

  it("leaves the pending flag set and cursors in place when a due run aborts", async () => {
    const db = harness("due-abort");
    await setMeta(db, pullCursorKey("workout_sessions"), "cursor-old");
    const { api } = scriptedPull(
      new Map([
        [
          "exercises",
          [new ApiError("offline", "The server could not be reached.")] as Array<
            PullPage | ApiError
          >,
        ],
      ]),
    );

    const result = await pullAll({ db, api, now: new Date(STAMP) });

    expect(result.complete).toBe(false);
    // The interrupted full walk leaves the flag set and does not delete
    // the stored cursor, so the next run can resume incrementally.
    expect(await getMeta(db, FULL_PULL_PENDING_KEY)).toBe(true);
    expect(await getMeta(db, pullCursorKey("workout_sessions"))).toBe("cursor-old");
    expect(await getMeta(db, LAST_FULL_PULL_AT_KEY)).toBeUndefined();
  });

  it("degrades an interrupted full pull to an incremental resume, then completes", async () => {
    const db = harness("pending-resume");
    await setMeta(db, pullCursorKey("workout_sessions"), "cursor-old");
    await setMeta(db, LAST_FULL_PULL_AT_KEY, "2026-10-01T00:00:00.000Z");

    // First attempt: exercises errors immediately, aborting the walk.
    const first = scriptedPull(
      new Map([
        [
          "exercises",
          [new ApiError("offline", "gone")] as Array<PullPage | ApiError>,
        ],
      ]),
    );
    const aborted = await pullAll({ db, api: first.api, now: new Date(STAMP) });
    expect(aborted.complete).toBe(false);
    expect(await getMeta(db, FULL_PULL_PENDING_KEY)).toBe(true);

    // Second attempt: the flag is set, so the walk resumes from the stored
    // cursor instead of re-downloading everything from the top.
    const second = scriptedPull(new Map());
    const resumed = await pullAll({ db, api: second.api, now: new Date(STAMP) });
    expect(resumed.complete).toBe(true);
    const sessionCalls = second.calls.filter((c) => c.entity === "workout_sessions");
    expect(sessionCalls).toEqual([{ entity: "workout_sessions", cursor: "cursor-old" }]);
    // Completion stamps the full-pull time and clears the flag.
    expect(await getMeta(db, LAST_FULL_PULL_AT_KEY)).toBe(STAMP);
    expect(await getMeta(db, FULL_PULL_PENDING_KEY)).toBeUndefined();
  });

  it("an empty run over six entities completes with no row merges", async () => {
    const db = harness("empty");
    const { api } = scriptedPull(new Map());

    const result = await pullAll({ db, api, now: new Date(STAMP) });
    expect(result).toEqual({ merged: 0, conflicts: 0, complete: true });
    expect(await getMeta(db, LAST_SYNCED_AT_KEY)).toBe(STAMP);
    expect(await db.outbox.count()).toBe(0);
  });

  it("aborts on an ApiError with complete false and no last_synced_at", async () => {
    const db = harness("abort");
    const { api } = scriptedPull(
      new Map([
        [
          "exercises",
          [new ApiError("offline", "The server could not be reached.")] as Array<
            PullPage | ApiError
          >,
        ],
      ]),
    );

    const result = await pullAll({ db, api, now: new Date(STAMP) });
    expect(result.complete).toBe(false);
    expect(await getMeta(db, LAST_SYNCED_AT_KEY)).toBeUndefined();
  });

  it("persists a cursor in the same transaction as the page merges", async () => {
    const db = harness("atomic");
    const row = sessionRow("s1", "2026-10-14T00:00:00.000Z");
    // The first page merges a row AND advances the cursor; a crash
    // between them is impossible, so a later abort leaves both behind.
    const { api } = scriptedPull(
      new Map([
        [
          "workout_sessions",
          [
            { rows: [pullRow(row)], next_cursor: "cursor-1" },
            new ApiError("offline", "gone"),
          ] as Array<PullPage | ApiError>,
        ],
      ]),
    );

    const result = await pullAll({ db, api, now: new Date(STAMP) });
    expect(result).toEqual({ merged: 1, conflicts: 0, complete: false });
    expect((await db.workout_sessions.get("s1"))?.id).toBe("s1");
    expect(await getMeta(db, pullCursorKey("workout_sessions"))).toBe("cursor-1");
  });

  it("counts a conflict merge and leaves a queued newer op alone", async () => {
    const db = harness("conflict-run");
    await db.workout_sessions.put(sessionRow("s1", "2026-10-13T00:00:00.000Z", "local"));
    await db.outbox.bulkAdd([
      sessionOp("s1", "2026-10-13T00:00:00.000Z", "op-stale"),
      sessionOp("s1", "2026-10-15T00:00:00.000Z", "op-newer"),
    ]);
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

    const { api } = scriptedPull(
      new Map([
        [
          "workout_sessions",
          [
            {
              rows: [pullRow(sessionRow("s1", "2026-10-14T00:00:00.000Z", "server"))],
              next_cursor: null,
            },
          ] as Array<PullPage | ApiError>,
        ],
      ]),
    );

    const result = await pullAll({ db, api, now: new Date(STAMP) });
    expect(result).toEqual({ merged: 1, conflicts: 1, complete: true });
    // Superseded op dropped, newer local op and the draft untouched.
    const remaining = (await db.outbox.toArray()).map((o) => o.op_id);
    expect(remaining).toEqual(["op-newer"]);
    expect(await db.workout_drafts.get("draft-1")).toBeDefined();
  });
});
