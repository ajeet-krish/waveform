import { afterEach, describe, expect, it } from "vitest";
import { createWaveformDb, type WaveformDb } from "../schema";
import type { LocalProfile } from "../types";
import { createRepos, type Repos } from "./index";

type Harness = { db: WaveformDb; repos: Repos };

const openDbs: WaveformDb[] = [];

/** Fresh database plus repos on an advancing one-second test clock. */
function harness(name: string): Harness {
  const db = createWaveformDb(`profile-${name}-${crypto.randomUUID()}`);
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

/** A full profile row; id defaults to a value that differs from deps.userId. */
function makeProfile(overrides: Partial<LocalProfile> = {}): LocalProfile {
  return {
    id: "someone-else",
    display_name: "Ada",
    email: "ada@example.com",
    avatar_url: null,
    created_at: "2026-10-14T12:00:00.000Z",
    updated_at: "2026-10-14T12:00:00.000Z",
    settings: { display_weight_unit: "kg", display_length_unit: "cm" },
    ...overrides,
  };
}

describe("profile repo", () => {
  it("save then get round-trips under deps.userId even when the profile id differs", async () => {
    const { db, repos } = harness("round-trip");
    const saved = await repos.profile.save(makeProfile({ id: "stale-id" }));

    expect(saved.id).toBe("user-1");
    expect(saved.display_name).toBe("Ada");
    expect(saved.email).toBe("ada@example.com");
    expect(await db.local_profile.get("user-1")).toEqual(saved);
    expect(await db.local_profile.get("stale-id")).toBeUndefined();

    const fetched = await repos.profile.get();
    expect(fetched).toEqual(saved);
    expect(fetched?.id).toBe("user-1");
  });

  it("save writes no outbox op (local-only exception)", async () => {
    const { db, repos } = harness("local-only");
    await repos.profile.save(makeProfile());
    expect(await db.outbox.count()).toBe(0);

    await repos.profile.save(makeProfile({ display_name: "Grace" }));
    expect(await db.outbox.count()).toBe(0);
  });

  it("get returns undefined when nothing was saved", async () => {
    const { repos } = harness("empty");
    expect(await repos.profile.get()).toBeUndefined();
  });
});
