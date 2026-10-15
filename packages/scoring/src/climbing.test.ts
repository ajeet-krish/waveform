import { describe, expect, it } from "vitest";
import { MAX_V_GRADE, totalVPoints, vPoints } from "./climbing";

describe("vPoints", () => {
  it("is two to the power of the grade for the whole V scale", () => {
    for (let grade = 0; grade <= 16; grade += 1) {
      expect(vPoints(grade), `vPoints(${grade}) must equal 2^grade`).toBe(
        2 ** grade,
      );
    }
    // Exact values for the grades climbers actually log.
    expect(vPoints(0)).toBe(1);
    expect(vPoints(1)).toBe(2);
    expect(vPoints(3)).toBe(8);
    expect(vPoints(5)).toBe(32);
    expect(vPoints(8)).toBe(256);
  });

  it("doubles with each grade step", () => {
    for (let grade = 0; grade <= 15; grade += 1) {
      expect(vPoints(grade + 1)).toBe(2 * vPoints(grade));
    }
  });

  it("clamps out-of-range grades into the V scale", () => {
    // Negative grades cannot mint fractional points, and absurdly large
    // grades cap at MAX_V_GRADE instead of overflowing to infinity.
    expect(vPoints(-3)).toBe(vPoints(0));
    expect(vPoints(10_000)).toBe(vPoints(MAX_V_GRADE));
    expect(Number.isFinite(vPoints(2_147_483_647))).toBe(true);
    expect(vPoints(MAX_V_GRADE)).toBe(65_536);
  });

  it("matches totalVPoints for a single send and zero for none", () => {
    for (const grade of [0, 4, 9]) {
      expect(totalVPoints([grade])).toBe(vPoints(grade));
    }
    expect(totalVPoints([])).toBe(0);
  });

  it("outranks many easy sends with a single hard send", () => {
    // 100 V0 sends are worth 100; a single V8 (256) beats them all, and
    // doubling continues past the practical ceiling without overflow.
    const hundredV0 = Array.from({ length: 100 }, () => 0);
    expect(totalVPoints(hundredV0)).toBe(100);
    expect(vPoints(8) > totalVPoints(hundredV0)).toBe(true);
    expect(vPoints(16) > 65_000).toBe(true);
  });

  it("keeps integer-grade equivalence for half-grade schema values", () => {
    // activities.climb_grade_value is numeric(4,1), so half grades are
    // representable; here we pin integer-grade equivalence ("V4" logs as 4.0).
    expect(vPoints(4)).toBe(16);
    expect(totalVPoints([4, 4, 4])).toBe(48);
  });
});

describe("totalVPoints", () => {
  it("sums sends regardless of order", () => {
    const sends = [1, 3, 5, 7, 2, 2];
    const shuffled = [...sends].reverse();
    expect(totalVPoints(sends)).toBe(totalVPoints(shuffled));
    const sorted = [1, 2, 2, 3, 5, 7];
    expect(totalVPoints(sends)).toBe(totalVPoints(sorted));
  });

  it("sums known totals", () => {
    expect(totalVPoints([0, 2, 4])).toBe(21);
    expect(totalVPoints([5, 5, 5])).toBe(96);
    expect(totalVPoints([])).toBe(0);
  });

  it("lets harder grades dominate", () => {
    const easy = totalVPoints([0, 0, 0, 0, 0, 0, 0, 0]);
    const hard = totalVPoints([4]);
    expect(hard > easy).toBe(true);
  });
});
