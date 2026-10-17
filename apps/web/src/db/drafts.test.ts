import { e1rmBrzycki } from "@waveform/scoring";
import { afterEach, describe, expect, it } from "vitest";
import { createRepos, type Repos } from "./repos";
import { createWaveformDb, type WaveformDb } from "./schema";
import type { WorkoutDraft } from "./types";
import { LocalValidationError } from "./validation";

type Harness = { db: WaveformDb; repos: Repos };

const openDbs: WaveformDb[] = [];

function harness(name: string): Harness {
  const db = createWaveformDb(`drafts-${name}-${crypto.randomUUID()}`);
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

/** Two entries, three sets total; all ids pre-generated. */
function makeDraft(overrides: Partial<WorkoutDraft> = {}): WorkoutDraft {
  return {
    id: crypto.randomUUID(),
    local_date: "2026-10-14",
    started_at: "2026-10-14T12:00:00.000Z",
    duration_min: 45,
    routine_id: null,
    notes: "bench focus",
    entries: [
      {
        id: crypto.randomUUID(),
        exercise_id: "exercise-1",
        order_index: 0,
        notes: null,
        sets: [
          { id: crypto.randomUUID(), set_index: 0, weight_kg: 60, reps: 5, is_warmup: false },
          { id: crypto.randomUUID(), set_index: 1, weight_kg: 65, reps: 5, is_warmup: false },
        ],
      },
      {
        id: crypto.randomUUID(),
        exercise_id: "exercise-2",
        order_index: 1,
        notes: "superset",
        sets: [
          { id: crypto.randomUUID(), set_index: 0, weight_kg: 40, reps: 8, is_warmup: false },
        ],
      },
    ],
    updated_at: "2026-10-14T12:00:00.000Z",
    ...overrides,
  };
}

describe("drafts repo local operations", () => {
  it("save, get, current, and discard write no outbox ops", async () => {
    const { db, repos } = harness("local");
    const first = makeDraft();
    await repos.drafts.save(first);
    expect(await db.outbox.count()).toBe(0);
    expect((await repos.drafts.get(first.id))?.id).toBe(first.id);

    const second = makeDraft();
    await repos.drafts.save(second);
    expect(await db.outbox.count()).toBe(0);
    expect(await repos.drafts.current()).toBeDefined();
    expect((await repos.drafts.current())?.id).toBe(second.id);

    await repos.drafts.discard(second.id);
    expect(await repos.drafts.get(second.id)).toBeUndefined();
    expect((await repos.drafts.current())?.id).toBe(first.id);
    expect(await db.outbox.count()).toBe(0);

    await repos.drafts.discard(first.id);
    expect(await repos.drafts.current()).toBeUndefined();
    expect(await db.outbox.count()).toBe(0);
  });
});

describe("drafts commit", () => {
  it("expands into 1 session + N entries + M sets with draft ids and one create op each", async () => {
    const { db, repos } = harness("commit");
    const draft = makeDraft();
    await repos.drafts.save(draft);

    const ops = await repos.drafts.commit(draft.id);
    expect(ops).toHaveLength(1 + 2 + 3);
    expect(ops.every((op) => op.action === "create")).toBe(true);
    expect(ops.filter((op) => op.entity === "workout_sessions")).toHaveLength(1);
    expect(ops.filter((op) => op.entity === "exercise_entries")).toHaveLength(2);
    expect(ops.filter((op) => op.entity === "set_entries")).toHaveLength(3);

    const session = await db.workout_sessions.get(draft.id);
    expect(session).toBeDefined();
    expect(session?.user_id).toBe("user-1");
    expect(session?.local_date).toBe("2026-10-14");
    expect(session?.duration_min).toBe(45);
    expect(session?.deleted_at).toBeNull();

    const entries = await db.exercise_entries.toArray();
    expect(entries).toHaveLength(2);
    expect([...entries.map((entry) => entry.id)].sort()).toEqual(
      [...draft.entries.map((entry) => entry.id)].sort(),
    );
    expect(entries.every((entry) => entry.workout_id === draft.id)).toBe(true);

    const sets = await db.set_entries.toArray();
    expect(sets).toHaveLength(3);
    const draftSetIds = draft.entries.flatMap((entry) => entry.sets.map((set) => set.id));
    expect([...sets.map((set) => set.id)].sort()).toEqual([...draftSetIds].sort());
    expect(sets.every((set) => set.e1rm_kg === e1rmBrzycki(set.weight_kg, set.reps))).toBe(true);

    expect(await db.workout_drafts.get(draft.id)).toBeUndefined();
    expect(await db.outbox.count()).toBe(6);
    expect((await db.outbox.toArray()).every((op) => op.action === "create")).toBe(true);
  });

  it("keeps set e1rm_kg out of the outbox payloads", async () => {
    const { db, repos } = harness("commit-wire");
    const draft = makeDraft();
    await repos.drafts.save(draft);
    await repos.drafts.commit(draft.id);

    const ops = await db.outbox.toArray();
    const setOps = ops.filter((op) => op.entity === "set_entries");
    expect(setOps).toHaveLength(3);
    expect(setOps.every((op) => !("e1rm_kg" in op.payload))).toBe(true);
  });

  it("throws when the draft does not exist and writes nothing", async () => {
    const { db, repos } = harness("missing");
    await expect(repos.drafts.commit(crypto.randomUUID())).rejects.toThrow(LocalValidationError);
    expect(await db.outbox.count()).toBe(0);
    expect(await db.workout_sessions.count()).toBe(0);
  });

  it("stamps the routine id on the session and keeps target hints off the rows", async () => {
    const { db, repos } = harness("routine");
    const draft = makeDraft({ routine_id: "routine-9" });
    const first = draft.entries[0];
    expect(first).toBeDefined();
    if (!first) {
      return;
    }
    first.target = { sets: 5, reps: 5, weight_kg: 80 };
    await repos.drafts.save(draft);

    await repos.drafts.commit(draft.id);

    const session = await db.workout_sessions.get(draft.id);
    expect(session?.routine_id).toBe("routine-9");

    const entry = await db.exercise_entries.get(first.id);
    expect(entry).toBeDefined();
    // A target hint is a plan, never a stored column.
    expect(entry).not.toHaveProperty("target");
    const entryOps = (await db.outbox.toArray()).filter(
      (op) => op.entity === "exercise_entries",
    );
    expect(entryOps).toHaveLength(2);
    expect(entryOps.every((op) => !("target" in op.payload))).toBe(true);
  });
});
