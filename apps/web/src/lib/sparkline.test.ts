import { describe, expect, it } from "vitest";
import { buildSparkline, sparklineSummary } from "./sparkline";

const BOX = { width: 100, height: 56, pad: 6 };

describe("buildSparkline", () => {
  it("draws nothing for an empty series", () => {
    expect(buildSparkline([], BOX)).toEqual({ polyline: "", dots: [] });
  });

  it("centers a single value", () => {
    const geometry = buildSparkline([100], BOX);
    expect(geometry.dots).toEqual([{ x: 50, y: 28, record: true }]);
    expect(geometry.polyline).toBe("50,28");
  });

  it("spans the box: first point low-left, last point high-right", () => {
    const geometry = buildSparkline([100, 200], BOX);
    expect(geometry.dots).toEqual([
      { x: 6, y: 50, record: false },
      { x: 94, y: 6, record: true },
    ]);
    expect(geometry.polyline).toBe("6,50 94,6");
  });

  it("parks a flat series on the midline and marks every point a record", () => {
    const geometry = buildSparkline([150, 150], BOX);
    expect(geometry.dots.map((dot) => dot.y)).toEqual([28, 28]);
    expect(geometry.dots.every((dot) => dot.record)).toBe(true);
  });

  it("skips non-finite values instead of drawing garbage", () => {
    const geometry = buildSparkline([100, Number.NaN, 200], BOX);
    expect(geometry.dots).toHaveLength(2);
    expect(geometry.polyline).not.toContain("NaN");
  });
});

describe("sparklineSummary", () => {
  const today = new Date(2026, 9, 15, 9, 0);

  it("invites a first log when there is nothing to show", () => {
    expect(sparklineSummary([], "kg", today)).toBe("No days logged yet.");
  });

  it("names the single logged day and its figure", () => {
    expect(
      sparklineSummary([{ day: "2026-10-14", value: 100.04 }], "kg", today),
    ).toBe("Best e1RM (Brzycki): 100 kg, logged Yesterday.");
  });

  it("spans first day, last day, and peak across a series", () => {
    const points = [
      { day: "2026-10-05", value: 80 },
      { day: "2026-10-12", value: 90 },
      { day: "2026-10-14", value: 85 },
      { day: "2026-10-15", value: 95 },
    ];
    expect(sparklineSummary(points, "kg", today)).toBe(
      "Best e1RM (Brzycki): 4 days logged, 80 kg Monday 5 Oct to 95 kg Today, peak 95 kg Today.",
    );
  });

  it("reads days in any order", () => {
    const points = [
      { day: "2026-10-15", value: 95 },
      { day: "2026-10-05", value: 80 },
    ];
    expect(sparklineSummary(points, "lb", today)).toBe(
      "Best e1RM (Brzycki): 2 days logged, 80 lb Monday 5 Oct to 95 lb Today, peak 95 lb Today.",
    );
  });

  it("picks the earliest day that holds the peak", () => {
    const points = [
      { day: "2026-10-05", value: 100 },
      { day: "2026-10-12", value: 90 },
      { day: "2026-10-15", value: 100 },
    ];
    expect(sparklineSummary(points, "kg", today)).toContain("peak 100 kg Monday 5 Oct.");
  });
});
