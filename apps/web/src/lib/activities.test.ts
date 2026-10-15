import { describe, expect, it } from "vitest";
import { DISCIPLINES, summarizeDiscipline, type DisciplineActivity } from "./activities";
import type { Activity } from "../types/api";

/** The activity types the schema CHECK constraint accepts (0001_init.sql). */
const SCHEMA_ACTIVITY_TYPES = ["cycling", "climbing", "running", "hike", "swim"];

describe("discipline cards", () => {
  it("covers every schema activity type exactly once", () => {
    const types = DISCIPLINES.map((card) => card.type).sort();
    expect(types).toEqual([...SCHEMA_ACTIVITY_TYPES].sort());
  });

  it("links only the two discipline pages that ship first", () => {
    const linked = DISCIPLINES.filter((card) => card.href !== undefined).map(
      (card) => card.type,
    );
    expect(linked).toEqual(["cycling", "climbing"]);
  });

  it("keeps labels unique so the cards render distinctly", () => {
    const labels = DISCIPLINES.map((card) => card.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

const STAMP = "2026-10-14T00:00:00.000Z";

function activity(
  overrides: Partial<DisciplineActivity> & { type: Activity["type"]; local_date: string },
): DisciplineActivity {
  return {
    id: crypto.randomUUID(),
    user_id: "user-1",
    started_at: null,
    duration_min: null,
    distance_km: null,
    elevation_m: null,
    climb_grade: null,
    climb_grade_value: null,
    routes_sent: null,
    notes: null,
    created_at: STAMP,
    updated_at: STAMP,
    deleted_at: null,
    ...overrides,
  };
}

describe("summarizeDiscipline", () => {
  it("totals cycling distance in km across the window", () => {
    const activities = [
      activity({ type: "cycling", local_date: "2026-10-10", distance_km: 30 }),
      activity({ type: "cycling", local_date: "2026-10-14", distance_km: 12.5 }),
      // Out of window and a tombstone: both skipped.
      activity({ type: "cycling", local_date: "2026-09-01", distance_km: 100 }),
      activity({ type: "cycling", local_date: "2026-10-13", distance_km: 50, deleted_at: STAMP }),
    ];
    const summary = summarizeDiscipline("cycling", activities, "2026-10-01", "2026-10-31");
    expect(summary).toEqual({ type: "cycling", count: 2, totalKm: 42.5, totalVPoints: 0 });
  });

  it("totals climbing V-points via vPointsForSends", () => {
    const activities = [
      // Two V2 sends and one V5 send: 4 + 4 + 32 = 40 V-points.
      activity({
        type: "climbing",
        local_date: "2026-10-14",
        sends: [0, 0, 2, 0, 0, 1],
      }),
      activity({ type: "climbing", local_date: "2026-10-12", sends: [3] }),
      // A climbing row without a histogram contributes count but no points.
      activity({ type: "climbing", local_date: "2026-10-13" }),
    ];
    const summary = summarizeDiscipline("climbing", activities, "2026-10-01", "2026-10-31");
    // 40 + 3 (three V0 sends) = 43.
    expect(summary).toEqual({ type: "climbing", count: 3, totalKm: 0, totalVPoints: 43 });
  });

  it("counts only the requested type and respects the inclusive window bounds", () => {
    const activities = [
      activity({ type: "cycling", local_date: "2026-10-01", distance_km: 10 }),
      activity({ type: "cycling", local_date: "2026-10-31", distance_km: 20 }),
      activity({ type: "climbing", local_date: "2026-10-15", sends: [1] }),
    ];
    const summary = summarizeDiscipline("cycling", activities, "2026-10-01", "2026-10-31");
    expect(summary.count).toBe(2);
    expect(summary.totalKm).toBe(30);
    expect(summary.totalVPoints).toBe(0);
  });

  it("returns zeros for a discipline with no activities", () => {
    const summary = summarizeDiscipline("running", [], "2026-10-01", "2026-10-31");
    expect(summary).toEqual({ type: "running", count: 0, totalKm: 0, totalVPoints: 0 });
  });
});
