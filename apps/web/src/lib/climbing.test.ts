import { describe, expect, it } from "vitest";
import {
  V_GRADE_COUNT,
  climbBreakdownSummary,
  emptySendCounts,
  gradesSent,
  hardestGrade,
  normalizeSendCounts,
  totalSends,
  vPointsForSends,
} from "./climbing";

const today = new Date(2026, 9, 15, 9, 0);

describe("V_GRADE_COUNT and emptySendCounts", () => {
  it("is 17 slots, all zero", () => {
    expect(V_GRADE_COUNT).toBe(17);
    const counts = emptySendCounts();
    expect(counts).toHaveLength(17);
    expect(counts.every((count) => count === 0)).toBe(true);
  });
});

describe("normalizeSendCounts", () => {
  it("pads short input with zeros to length 17", () => {
    const normalized = normalizeSendCounts([1, 2, 3]);
    expect(normalized).toHaveLength(17);
    expect(normalized[0]).toBe(1);
    expect(normalized[1]).toBe(2);
    expect(normalized[2]).toBe(3);
    expect(normalized[3]).toBe(0);
    expect(normalized[16]).toBe(0);
  });

  it("truncates long input to length 17", () => {
    const long = new Array<number>(25).fill(1);
    const normalized = normalizeSendCounts(long);
    expect(normalized).toHaveLength(17);
  });

  it("floors fractions, clamps negatives to zero, and maps NaN to zero", () => {
    const normalized = normalizeSendCounts([3.9, -5, Number.NaN]);
    expect(normalized[0]).toBe(3);
    expect(normalized[1]).toBe(0);
    expect(normalized[2]).toBe(0);
  });
});

describe("totalSends", () => {
  it("sums every grade's count", () => {
    expect(totalSends([2, 0, 3])).toBe(5);
    expect(totalSends(emptySendCounts())).toBe(0);
  });
});

describe("hardestGrade", () => {
  it("returns the highest grade with a send, or null when empty", () => {
    expect(hardestGrade([1, 0, 2, 1])).toBe(3);
    expect(hardestGrade(emptySendCounts())).toBeNull();
    expect(hardestGrade([])).toBeNull();
  });
});

describe("gradesSent", () => {
  it("expands the histogram into one entry per send, ordered easy to hard", () => {
    expect(gradesSent([2, 0, 1])).toEqual([0, 0, 2]);
    expect(gradesSent(emptySendCounts())).toEqual([]);
  });
});

describe("vPointsForSends", () => {
  it("sums 2^grade across sends, matching totalVPoints(gradesSent(...))", () => {
    // Two V0 sends (2^0 each) plus one V3 send (2^3): 1 + 1 + 8 = 10.
    expect(vPointsForSends([2, 0, 0, 1])).toBe(10);
    expect(vPointsForSends(emptySendCounts())).toBe(0);
    // A hard send dominates: one V5 send is worth 32, more than many V0s.
    expect(vPointsForSends([10, 0, 0, 0, 0, 1])).toBe(10 + 32);
  });
});

describe("climbBreakdownSummary", () => {
  it("invites a first log when there are no sends", () => {
    expect(climbBreakdownSummary(emptySendCounts(), today)).toBe("No sends logged yet.");
  });

  it("summarizes total sends, hardest grade, V-points, and a per-grade breakdown", () => {
    // Two V2 sends and one V5 send: 3 sends, hardest V5, 4 + 4 + 32 = 40 V-points.
    const summary = climbBreakdownSummary([0, 0, 2, 0, 0, 1], today);
    expect(summary).toBe("3 sends, hardest V5, 40 V-points (V2 x2, V5 x1).");
  });

  it("uses singular wording for a single send", () => {
    expect(climbBreakdownSummary([1], today)).toBe("1 send, hardest V0, 1 V-point (V0 x1).");
  });
});
