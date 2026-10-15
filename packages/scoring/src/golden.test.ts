import { describe, expect, it } from "vitest";
import { e1rmBrzycki } from "./brzycki";
import { totalVPoints, vPoints } from "./climbing";
import {
  effortPoints,
  effortPointsDaily,
  parseDiscipline,
  type SessionEffort,
} from "./effort";
import {
  loadGolden,
  type GoldenSession,
  type ScoringGolden,
} from "./golden";

function assertApprox(actual: number, expected: number, tolerance: number): void {
  expect(
    Math.abs(actual - expected),
    `expected ${expected} (+/- ${tolerance}), got ${actual}`,
  ).toBeLessThan(tolerance);
}

function toSession(raw: GoldenSession): SessionEffort {
  return {
    minutes: raw.minutes,
    discipline: parseDiscipline(raw.discipline),
    bonuses: raw.bonuses,
  };
}

describe("shared golden vectors", () => {
  const golden: ScoringGolden = loadGolden();

  it("is version 1 with a positive tolerance", () => {
    expect(golden.version).toBe(1);
    expect(golden.tolerance).toBeGreaterThan(0);
  });

  it("ships non-empty vector lists", () => {
    expect(golden.e1rm.length).toBeGreaterThan(0);
    expect(golden.vPoints.length).toBeGreaterThan(0);
    expect(golden.totalVPoints.length).toBeGreaterThan(0);
    expect(golden.effortPoints.length).toBeGreaterThan(0);
    expect(golden.effortPointsDaily.length).toBeGreaterThan(0);
  });

  it("matches e1rmBrzycki on every vector", () => {
    for (const vector of golden.e1rm) {
      assertApprox(
        e1rmBrzycki(vector.weightKg, vector.reps),
        vector.expected,
        golden.tolerance,
      );
    }
  });

  it("matches vPoints on every vector", () => {
    for (const vector of golden.vPoints) {
      assertApprox(
        vPoints(vector.grade),
        vector.expected,
        golden.tolerance,
      );
    }
  });

  it("matches totalVPoints on every vector", () => {
    for (const vector of golden.totalVPoints) {
      assertApprox(
        totalVPoints(vector.grades),
        vector.expected,
        golden.tolerance,
      );
    }
  });

  it("matches effortPoints on every vector", () => {
    for (const vector of golden.effortPoints) {
      assertApprox(
        effortPoints(
          vector.minutes,
          parseDiscipline(vector.discipline),
          vector.bonuses,
        ),
        vector.expected,
        golden.tolerance,
      );
    }
  });

  it("matches effortPointsDaily on every vector", () => {
    for (const vector of golden.effortPointsDaily) {
      const sessions = vector.sessions.map(toSession);
      assertApprox(
        effortPointsDaily(sessions),
        vector.expected,
        golden.tolerance,
      );
    }
  });
});
