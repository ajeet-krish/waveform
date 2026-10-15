import { afterEach, describe, expect, it } from "vitest";
import { createRepos, type Repos } from "./index";
import { createWaveformDb, type WaveformDb } from "../schema";
import { LocalValidationError } from "../validation";

type Harness = { db: WaveformDb; repos: Repos };

const openDbs: WaveformDb[] = [];

/** Fresh database plus repos on an advancing one-second test clock. */
function harness(name: string): Harness {
  const db = createWaveformDb(`body-${name}-${crypto.randomUUID()}`);
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

describe("body repo", () => {
  it("upsert creates a fresh row and queues one create op", async () => {
    const { db, repos } = harness("create");
    const { row, op } = await repos.body.upsertBodyStat({
      local_date: "2026-10-14",
      weight_kg: 72.5,
      bodyfat_pct: 15.2,
    });

    expect(row.user_id).toBe("user-1");
    expect(row.local_date).toBe("2026-10-14");
    expect(row.weight_kg).toBe(72.5);
    expect(row.bodyfat_pct).toBe(15.2);
    expect(row.neck_cm).toBeNull();
    expect(row.deleted_at).toBeNull();
    expect(await db.body_stats.get(row.id)).toEqual(row);

    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]?.entity).toBe("body_stats");
    expect(ops[0]?.action).toBe("create");
    expect(ops[0]?.op_id).toBe(op.op_id);
    expect(ops[0]?.payload).toEqual(row);
  });

  it("upsert on the same date keeps one live row, merges the patch, and queues an update op", async () => {
    const { db, repos } = harness("merge");
    const first = await repos.body.upsertBodyStat({
      local_date: "2026-10-14",
      weight_kg: 72.5,
      bodyfat_pct: 15.2,
      waist_cm: 80,
    });

    // undefined keeps the existing value; null clears it; a number sets it.
    const { row, op } = await repos.body.upsertBodyStat({
      local_date: "2026-10-14",
      weight_kg: 71.8,
      bodyfat_pct: null,
      chest_cm: 98,
    });

    expect(row.id).toBe(first.row.id);
    expect(row.weight_kg).toBe(71.8);
    expect(row.bodyfat_pct).toBeNull();
    expect(row.waist_cm).toBe(80);
    expect(row.chest_cm).toBe(98);
    expect(op.action).toBe("update");
    expect(await db.body_stats.get(row.id)).toEqual(row);

    const live = await db.body_stats
      .where("local_date")
      .equals("2026-10-14")
      .filter((r) => r.deleted_at === null)
      .toArray();
    expect(live).toHaveLength(1);

    const ops = await repos.outbox.listPending();
    expect(ops.map((queued) => queued.action)).toEqual(["create", "update"]);
  });

  it("upsert on a tombstoned date creates a fresh id", async () => {
    const { db, repos } = harness("tombstoned-date");
    const first = await repos.body.upsertBodyStat({
      local_date: "2026-10-14",
      weight_kg: 72.5,
    });
    await repos.body.remove(first.row.id);

    const { row, op } = await repos.body.upsertBodyStat({
      local_date: "2026-10-14",
      weight_kg: 71,
    });
    expect(row.id).not.toBe(first.row.id);
    expect(op.action).toBe("create");
    expect(row.weight_kg).toBe(71);

    const all = await db.body_stats.where("local_date").equals("2026-10-14").toArray();
    expect(all).toHaveLength(2);
    expect(all.filter((r) => r.deleted_at === null)).toHaveLength(1);
  });

  it("remove tombstones the row and queues one delete op; a second remove is a no-op", async () => {
    const { db, repos } = harness("remove");
    const created = await repos.body.upsertBodyStat({
      local_date: "2026-10-14",
      weight_kg: 72.5,
    });

    const ops = await repos.body.remove(created.row.id);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.action).toBe("delete");
    const tomb = await db.body_stats.get(created.row.id);
    expect(tomb?.deleted_at).not.toBeNull();
    expect(tomb?.deleted_at).toBe(tomb?.updated_at);

    const second = await repos.body.remove(created.row.id);
    expect(second).toHaveLength(0);
    await expect(repos.body.remove("missing")).rejects.toThrow(LocalValidationError);
  });

  it("listRange is inclusive on both bounds, sorted local_date asc, skipping tombstones", async () => {
    const { repos } = harness("list-range");
    for (const [local_date, weight] of [
      ["2026-10-12", 73],
      ["2026-10-13", 72.5],
      ["2026-10-14", 72],
      ["2026-10-15", 71.5],
    ] as const) {
      await repos.body.upsertBodyStat({ local_date, weight_kg: weight });
    }

    const window = await repos.body.listRange("2026-10-13", "2026-10-14");
    expect(window.map((row) => row.local_date)).toEqual(["2026-10-13", "2026-10-14"]);
  });

  it("listAll returns every live entry, local_date desc", async () => {
    const { repos } = harness("list-all");
    for (const local_date of ["2026-10-12", "2026-10-14", "2026-10-13"]) {
      await repos.body.upsertBodyStat({ local_date, weight_kg: 72 });
    }

    const all = await repos.body.listAll();
    expect(all.map((row) => row.local_date)).toEqual(["2026-10-14", "2026-10-13", "2026-10-12"]);
  });

  it("rejects a zero, negative, or over-max weight, and a bad local_date", async () => {
    const { db, repos } = harness("validation");
    await expect(
      repos.body.upsertBodyStat({ local_date: "2026-10-14", weight_kg: 0 }),
    ).rejects.toThrow(LocalValidationError);
    await expect(
      repos.body.upsertBodyStat({ local_date: "2026-10-14", weight_kg: -3 }),
    ).rejects.toThrow(LocalValidationError);
    await expect(
      repos.body.upsertBodyStat({ local_date: "2026-10-14", weight_kg: 1500.01 }),
    ).rejects.toThrow(LocalValidationError);
    await expect(
      repos.body.upsertBodyStat({ local_date: "14/10/2026", weight_kg: 72 }),
    ).rejects.toThrow(LocalValidationError);
    expect(await db.body_stats.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });

  it("rejects an out-of-range bodyfat and a non-finite circumference", async () => {
    const { repos } = harness("validation-2");
    await expect(
      repos.body.upsertBodyStat({ local_date: "2026-10-14", bodyfat_pct: 101 }),
    ).rejects.toThrow(LocalValidationError);
    await expect(
      repos.body.upsertBodyStat({ local_date: "2026-10-14", neck_cm: Number.NaN }),
    ).rejects.toThrow(LocalValidationError);
  });
});
