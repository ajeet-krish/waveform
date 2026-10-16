import { afterEach, describe, expect, it } from "vitest";
import type { PullPage, PullRow } from "@waveform/api-types";
import { createWaveformDb, type WaveformDb } from "../../db/schema";
import type { LocalRow, OutboxOp, WorkoutDraft } from "../../db/types";
import type { WorkoutSession as WireWorkout } from "@waveform/api-types";
import { ApiError } from "../api";
import {
  CONFLICT_LOG_CAP,
  CLIENT_PULL_ORDER,
  mergePullRow,
  pullAll,
  type PullConflictEntry,
  type SyncPullApi,
} from "./pull";
import { CONFLICT_LOG_KEY, LAST_SYNCED_AT_KEY, getMeta, pullCursorKey, setMeta } from "./meta";

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

  it("resumes from a previously persisted cursor", async () => {
    const db = harness("resume");
    await setMeta(db, pullCursorKey("workout_sessions"), "cursor-9");
    const { api, calls } = scriptedPull(new Map());

    const result = await pullAll({ db, api, now: new Date(STAMP) });
    expect(result.complete).toBe(true);
    const sessionCalls = calls.filter((c) => c.entity === "workout_sessions");
    expect(sessionCalls).toEqual([{ entity: "workout_sessions", cursor: "cursor-9" }]);
  });

  it("an empty run over six entities completes with no writes", async () => {
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
