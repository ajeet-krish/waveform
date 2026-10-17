import { describe, expect, it } from "vitest";
import type { BoardsResponse, PublicUser } from "@waveform/api-types";
import {
  BOARD_WINDOWS,
  DEFAULT_BOARD_WINDOW,
  KM_PER_MI,
  M_PER_FT,
  boardUnits,
  buildLeaderboard,
  formatBestE1rm,
  formatDistance,
  formatElevation,
  formatHardestGrade,
  formatRank,
  formatRatio,
  formatVPoints,
  formatVolume,
  hasLeaderboardData,
  windowLabel,
} from "./social";

function user(id: string, displayName: string): PublicUser {
  return { id, display_name: displayName, avatar_url: null };
}

/** An all-empty response the tests override board by board. */
function makeResponse(overrides: Partial<BoardsResponse> = {}): BoardsResponse {
  return {
    window: "7d",
    marquee_lifts: ["Back Squat", "Bench Press"],
    consistency: [],
    lifting: { volume: [], e1rm: [], relative_e1rm: [] },
    cycling: { distance: [], elevation: [] },
    climbing: [],
    ...overrides,
  };
}

const ADA = user("u1", "Ada");
const GRACE = user("u2", "Grace");

describe("board windows", () => {
  it("lists the three windows narrowest first and defaults to 7d", () => {
    expect(BOARD_WINDOWS).toEqual(["7d", "4w", "12w"]);
    expect(DEFAULT_BOARD_WINDOW).toBe("7d");
  });

  it("labels each window in plain words", () => {
    expect(windowLabel("7d")).toBe("7 days");
    expect(windowLabel("4w")).toBe("4 weeks");
    expect(windowLabel("12w")).toBe("12 weeks");
  });
});

describe("formatRank", () => {
  it("prefixes a valid rank with a hash", () => {
    expect(formatRank(1)).toBe("#1");
    expect(formatRank(4)).toBe("#4");
  });

  it("keeps a shared rank on every tied member", () => {
    expect(formatRank(2)).toBe("#2");
    expect(formatRank(2)).toBe("#2");
  });

  it("reads a missing or fractional rank without leaking a bad figure", () => {
    expect(formatRank(Number.NaN)).toBe("n/a");
    expect(formatRank(0)).toBe("n/a");
    expect(formatRank(2.9)).toBe("#2");
  });
});

describe("metric formatting", () => {
  it("formats volume in the display weight unit, including zero", () => {
    expect(formatVolume(1240, "kg")).toBe("1240 kg");
    expect(formatVolume(1200, "lb")).toBe("2645.5 lb");
    expect(formatVolume(0, "kg")).toBe("0 kg");
    expect(formatVolume(Number.NaN, "kg")).toBe("n/a");
  });

  it("formats best e1RM at one decimal in the display weight unit", () => {
    expect(formatBestE1rm(112.5, "kg")).toBe("112.5 kg");
    expect(formatBestE1rm(100, "lb")).toBe("220.5 lb");
    expect(formatBestE1rm(0, "kg")).toBe("0 kg");
    expect(formatBestE1rm(Number.NaN, "kg")).toBe("n/a");
  });

  it("formats the relative ratio at the server's two decimals", () => {
    expect(formatRatio(1.5)).toBe("1.50");
    expect(formatRatio(1.234)).toBe("1.23");
    expect(formatRatio(0)).toBe("0.00");
    expect(formatRatio(Number.NaN)).toBe("n/a");
  });

  it("converts distance to km or miles at one decimal", () => {
    expect(formatDistance(42.195, "km")).toBe("42.2 km");
    expect(formatDistance(KM_PER_MI, "mi")).toBe("1.0 mi");
    expect(formatDistance(42.195, "mi")).toBe("26.2 mi");
    expect(formatDistance(0, "km")).toBe("0.0 km");
    expect(formatDistance(Number.NaN, "km")).toBe("n/a");
  });

  it("converts elevation to metres or feet as whole figures", () => {
    expect(formatElevation(380, "m")).toBe("380 m");
    expect(formatElevation(M_PER_FT, "ft")).toBe("1 ft");
    expect(formatElevation(380, "ft")).toBe("1247 ft");
    expect(formatElevation(0, "m")).toBe("0 m");
    expect(formatElevation(Number.NaN, "m")).toBe("n/a");
  });

  it("formats V-points and hardest grade, with a null grade reading none", () => {
    expect(formatVPoints(24)).toBe("24");
    expect(formatVPoints(0)).toBe("0");
    expect(formatVPoints(Number.NaN)).toBe("n/a");
    expect(formatHardestGrade(5)).toBe("V5");
    expect(formatHardestGrade(null)).toBe("none");
    expect(formatHardestGrade(Number.NaN)).toBe("none");
  });
});

describe("boardUnits", () => {
  it("keeps metric distance and elevation for the cm length unit", () => {
    expect(boardUnits("kg", "cm")).toEqual({ weight: "kg", distance: "km", elevation: "m" });
    expect(boardUnits("lb", "cm")).toEqual({ weight: "lb", distance: "km", elevation: "m" });
  });

  it("shows miles and feet for the in length unit", () => {
    expect(boardUnits("lb", "in")).toEqual({ weight: "lb", distance: "mi", elevation: "ft" });
  });
});

describe("buildLeaderboard", () => {
  const response = makeResponse({
    consistency: [
      { rank: 1, user: ADA, active_days: 5, weekly_streak: 1 },
      { rank: 2, user: GRACE, active_days: 0, weekly_streak: 0 },
    ],
    lifting: {
      volume: [
        { rank: 1, user: ADA, volume_kg: 1200 },
        { rank: 2, user: GRACE, volume_kg: 0 },
      ],
      e1rm: [{ lift: "Back Squat", entries: [{ rank: 1, user: ADA, best_e1rm_kg: 150 }] }],
      relative_e1rm: [{ rank: 1, user: ADA, ratio: 1.5 }],
    },
    cycling: {
      distance: [{ rank: 1, user: ADA, distance_km: 42.195 }],
      elevation: [{ rank: 1, user: ADA, elevation_m: 380 }],
    },
    climbing: [{ rank: 1, user: ADA, v_points: 24, hardest_grade: 5 }],
  });

  const groups = buildLeaderboard(response, boardUnits("kg", "cm"));

  it("groups the boards by discipline in display order", () => {
    expect(groups.map((group) => group.label)).toEqual([
      "Consistency",
      "Lifting",
      "Cycling",
      "Climbing",
    ]);
  });

  it("builds consistency rows with shared-rank labels and member names", () => {
    const consistency = groups[0]?.boards[0];
    expect(consistency?.title).toBe("Consistency");
    expect(consistency?.columns).toEqual(["Active days", "Weekly streak"]);
    expect(consistency?.rows).toEqual([
      { rank: 1, rankLabel: "#1", member: "Ada", cells: ["5", "1"], empty: false },
      { rank: 2, rankLabel: "#2", member: "Grace", cells: ["0", "0"], empty: true },
    ]);
    expect(consistency?.empty).toBe(false);
  });

  it("keeps a shared rank on every tied member", () => {
    const tied = makeResponse({
      consistency: [
        { rank: 1, user: ADA, active_days: 5, weekly_streak: 1 },
        { rank: 2, user: GRACE, active_days: 4, weekly_streak: 0 },
        { rank: 2, user: user("u3", "Hopper"), active_days: 4, weekly_streak: 0 },
      ],
    });
    const rows = buildLeaderboard(tied, boardUnits("kg", "cm"))[0]?.boards[0]?.rows ?? [];
    expect(rows.map((row) => row.rankLabel)).toEqual(["#1", "#2", "#2"]);
  });

  it("names the marquee boards from the response, never hardcoded", () => {
    expect(groups[1]?.boards.map((board) => board.title)).toEqual([
      "Lifting volume",
      "Best e1RM: Back Squat",
      "Relative e1RM",
    ]);
  });

  it("converts weight, distance, and elevation into the chosen units", () => {
    const imperial = buildLeaderboard(response, boardUnits("lb", "in"));
    const volume = imperial[1]?.boards[0];
    expect(volume?.rows[0]?.cells).toEqual(["2645.5 lb"]);
    const distance = imperial[2]?.boards[0];
    expect(distance?.rows[0]?.cells).toEqual(["26.2 mi"]);
    const elevation = imperial[2]?.boards[1];
    expect(elevation?.rows[0]?.cells).toEqual(["1247 ft"]);
  });

  it("marks a board with no member data empty and carries its note", () => {
    const empty = makeResponse();
    const boards = buildLeaderboard(empty, boardUnits("kg", "cm"));
    const cycling = boards[2]?.boards ?? [];
    expect(cycling.every((board) => board.empty)).toBe(true);
    expect(cycling[0]?.emptyNote).toBe("No one logged a ride in this window.");
    expect(cycling[0]?.rows).toEqual([]);
  });
});

describe("hasLeaderboardData", () => {
  it("is true when any board carries a non-zero entry", () => {
    const response = makeResponse({
      consistency: [{ rank: 1, user: ADA, active_days: 3, weekly_streak: 0 }],
    });
    expect(hasLeaderboardData(buildLeaderboard(response, boardUnits("kg", "cm")))).toBe(true);
  });

  it("is false when every board is empty", () => {
    const groups = buildLeaderboard(makeResponse(), boardUnits("kg", "cm"));
    expect(hasLeaderboardData(groups)).toBe(false);
  });
});
