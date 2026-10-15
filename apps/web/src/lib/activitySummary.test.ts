import { describe, expect, it } from "vitest";
import { climbFooterSummary, disciplineWindowSummary, rideSummary } from "./activitySummary";

describe("rideSummary", () => {
  it("joins distance, elevation, and duration in order", () => {
    expect(rideSummary({ distanceKm: 42, elevationM: 380, durationMin: 80 })).toBe(
      "42.0 km, 380 m, 1 h 20 min",
    );
  });

  it("drops null figures instead of printing zeros", () => {
    expect(rideSummary({ distanceKm: 12.25, elevationM: null, durationMin: null })).toBe(
      "12.3 km",
    );
    expect(rideSummary({ distanceKm: null, elevationM: 55, durationMin: 45 })).toBe(
      "55 m, 45 min",
    );
  });

  it("invites a log when the ride carries no figures at all", () => {
    expect(rideSummary({ distanceKm: null, elevationM: null, durationMin: null })).toBe(
      "No figures logged yet.",
    );
  });
});

describe("climbFooterSummary", () => {
  it("invites a first send when the histogram is empty", () => {
    expect(climbFooterSummary([])).toBe("No sends yet.");
  });

  it("speaks sends, hardest grade, and V-points", () => {
    // Three V4 sends and one V2 send: 4 sends, hardest V4, 3*16 + 4 = 52.
    expect(climbFooterSummary([0, 0, 1, 0, 3])).toBe("4 sends, hardest V4, 52 V-points.");
  });

  it("uses singular wording for one send and one point", () => {
    expect(climbFooterSummary([1])).toBe("1 send, hardest V0, 1 V-point.");
  });
});

describe("disciplineWindowSummary", () => {
  it("reads as an invitation when nothing was logged", () => {
    expect(
      disciplineWindowSummary({ type: "cycling", count: 0, totalKm: 0, totalVPoints: 0 }),
    ).toBe("Nothing logged in the last 30 days.");
  });

  it("totals cycling distance to one decimal", () => {
    expect(
      disciplineWindowSummary({ type: "cycling", count: 3, totalKm: 86.1, totalVPoints: 0 }),
    ).toBe("3 sessions, 86.1 km in the last 30 days.");
  });

  it("totals climbing V-points with singular wording", () => {
    expect(
      disciplineWindowSummary({ type: "climbing", count: 1, totalKm: 0, totalVPoints: 1 }),
    ).toBe("1 session, 1 V-point in the last 30 days.");
  });

  it("falls back to the session count for other disciplines", () => {
    expect(
      disciplineWindowSummary({ type: "running", count: 2, totalKm: 10, totalVPoints: 0 }),
    ).toBe("2 sessions in the last 30 days.");
  });
});
