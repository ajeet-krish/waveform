import { describe, expect, it } from "vitest";
import {
  climbFooterSummary,
  disciplineWindowSummary,
  endurancePace,
  enduranceSummary,
  formatPace,
  rideSummary,
} from "./activitySummary";

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

describe("formatPace", () => {
  it("formats minutes and seconds, clamping negatives to zero", () => {
    expect(formatPace(5)).toBe("5:00");
    expect(formatPace(1.904761)).toBe("1:54");
    expect(formatPace(0.5)).toBe("0:30");
    expect(formatPace(-3)).toBe("0:00");
  });
});

describe("endurancePace", () => {
  it("speaks per km for runs and hikes, per 100 m for swims", () => {
    expect(endurancePace({ distanceKm: 10, elevationM: null, durationMin: 50 }, false)).toBe(
      "5:00 /km",
    );
    expect(endurancePace({ distanceKm: 1.5, elevationM: null, durationMin: 45 }, true)).toBe(
      "3:00 /100 m",
    );
  });

  it("returns null rather than dividing by zero", () => {
    expect(endurancePace({ distanceKm: 0, elevationM: null, durationMin: 30 }, false)).toBeNull();
    expect(endurancePace({ distanceKm: 10, elevationM: null, durationMin: 0 }, false)).toBeNull();
    expect(endurancePace({ distanceKm: null, elevationM: null, durationMin: 30 }, false)).toBeNull();
    expect(endurancePace({ distanceKm: 10, elevationM: null, durationMin: null }, false)).toBeNull();
  });
});

describe("enduranceSummary", () => {
  it("speaks duration, distance, and per-km pace for a run", () => {
    expect(enduranceSummary({ distanceKm: 42, elevationM: null, durationMin: 80 })).toBe(
      "1 h 20 min, 42.0 km, 1:54 /km",
    );
  });

  it("speaks per-100m pace for a swim", () => {
    expect(
      enduranceSummary({ distanceKm: 1.5, elevationM: null, durationMin: 45 }, { per100m: true }),
    ).toBe("45 min, 1.5 km, 3:00 /100 m");
  });

  it("speaks logged elevation for a hike", () => {
    expect(enduranceSummary({ distanceKm: 12.5, elevationM: 620, durationMin: 80 })).toBe(
      "1 h 20 min, 12.5 km, 620 m, 6:24 /km",
    );
  });

  it("omits elevation when the session carried none", () => {
    expect(enduranceSummary({ distanceKm: 12.5, elevationM: null, durationMin: 80 })).toBe(
      "1 h 20 min, 12.5 km, 6:24 /km",
    );
  });

  it("omits pace when the distance is zero", () => {
    expect(enduranceSummary({ distanceKm: 0, elevationM: null, durationMin: 30 })).toBe(
      "30 min, 0.0 km",
    );
  });

  it("drops missing figures instead of printing zeros", () => {
    expect(enduranceSummary({ distanceKm: null, elevationM: null, durationMin: 30 })).toBe(
      "30 min",
    );
    expect(enduranceSummary({ distanceKm: 10, elevationM: null, durationMin: null })).toBe(
      "10.0 km",
    );
  });

  it("invites a log when the session carries no figures at all", () => {
    expect(enduranceSummary({ distanceKm: null, elevationM: null, durationMin: null })).toBe(
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

  it("totals distance for running, hike, and swim", () => {
    expect(
      disciplineWindowSummary({ type: "running", count: 2, totalKm: 15.5, totalVPoints: 0 }),
    ).toBe("2 sessions, 15.5 km in the last 30 days.");
    expect(
      disciplineWindowSummary({ type: "hike", count: 1, totalKm: 8.4, totalVPoints: 0 }),
    ).toBe("1 session, 8.4 km in the last 30 days.");
    expect(
      disciplineWindowSummary({ type: "swim", count: 1, totalKm: 1.5, totalVPoints: 0 }),
    ).toBe("1 session, 1.5 km in the last 30 days.");
  });

  it("falls back to sessions-only when a distance window carried no distance", () => {
    expect(
      disciplineWindowSummary({ type: "hike", count: 2, totalKm: 0, totalVPoints: 0 }),
    ).toBe("2 sessions in the last 30 days.");
    expect(
      disciplineWindowSummary({ type: "running", count: 1, totalKm: 0, totalVPoints: 0 }),
    ).toBe("1 session in the last 30 days.");
  });
});
