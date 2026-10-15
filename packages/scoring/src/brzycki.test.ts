import { describe, expect, it } from "vitest";
import { e1rmBrzycki } from "./brzycki";

function assertApprox(actual: number, expected: number, tolerance: number): void {
  expect(
    Math.abs(actual - expected),
    `expected ${expected} (+/- ${tolerance}), got ${actual}`,
  ).toBeLessThan(tolerance);
}

describe("e1rmBrzycki", () => {
  it("returns known values across the rep domain", () => {
    // Independently computed: w / (1.0278 - 0.0278 * r).
    const cases: Array<[number, number, number]> = [
      [100, 1, 100.000000],
      [100, 2, 102.859494],
      [100, 3, 105.887336],
      [100, 5, 112.511251],
      [100, 8, 124.161907],
      [100, 10, 133.368898],
      [100, 12, 144.050706],
      [100, 15, 163.719712],
      [100, 20, 211.954218],
      [100, 25, 300.480769],
      [100, 30, 515.995872],
      [100, 36, 3703.703704],
      [60, 1, 60.000000],
      [60, 10, 80.021339],
      [60, 20, 127.172531],
      [60, 36, 2222.222222],
      [200, 5, 225.022502],
      [200, 20, 423.908436],
    ];
    for (const [weight, reps, expected] of cases) {
      assertApprox(e1rmBrzycki(weight, reps), expected, 1e-6);
    }
  });

  it("keeps every schema rep count finite and at least the lifted weight", () => {
    for (const weight of [1, 35, 100, 232.5]) {
      for (let reps = 1; reps <= 36; reps += 1) {
        const e1rm = e1rmBrzycki(weight, reps);
        expect(Number.isFinite(e1rm), `non-finite e1rm for ${weight} kg x ${reps}`).toBe(true);
        expect(e1rm >= weight, `e1rm ${e1rm} below weight ${weight} at ${reps} reps`).toBe(true);
        if (reps === 1) {
          expect(e1rm).toBe(weight);
        } else {
          expect(e1rm > weight).toBe(true);
        }
      }
    }
  });

  it("is strictly monotonic in reps for a fixed weight", () => {
    let previous = e1rmBrzycki(100, 1);
    for (let reps = 2; reps <= 36; reps += 1) {
      const current = e1rmBrzycki(100, reps);
      expect(
        current > previous,
        `e1rm not increasing at ${reps} reps: ${current} <= ${previous}`,
      ).toBe(true);
      previous = current;
    }
  });

  it("scales linearly in weight", () => {
    for (const reps of [2, 5, 10, 20, 36]) {
      const base = e1rmBrzycki(100, reps);
      assertApprox(e1rmBrzycki(250, reps), 2.5 * base, 1e-9);
      assertApprox(e1rmBrzycki(62.5, reps) + e1rmBrzycki(37.5, reps), base, 1e-9);
    }
  });

  it("returns the raw weight outside the schema domain", () => {
    // Defensive fallback: denominator <= 0 (reps >= 37) and the
    // sub-one-rep case both return the weight unchanged.
    for (const reps of [0, 37, 40, 100, 1000, 4294967295]) {
      expect(e1rmBrzycki(100, reps), `guard failed at ${reps} reps`).toBe(100);
    }
  });

  it("treats the schema max of 36 reps as the sane extremum", () => {
    // At the CHECK ceiling the denominator is 1.0278 - 0.0278 * 36 = 0.027,
    // so 100 kg x 36 estimates ~3703.7 kg; one rep past it the guard
    // kicks in (documented discontinuity, defensive only).
    assertApprox(e1rmBrzycki(100, 36), 3703.703704, 1e-6);
    expect(e1rmBrzycki(100, 37)).toBe(100);
  });

  it("keeps zero weight at zero and negative weight linear", () => {
    for (const reps of [1, 5, 20, 36]) {
      expect(e1rmBrzycki(0, reps)).toBe(0);
      // Defensive: no clamping, the formula stays linear for negatives.
      assertApprox(e1rmBrzycki(-100, 5), -112.511251, 1e-6);
    }
  });

  it("treats a single rep or fewer as its own e1rm", () => {
    expect(e1rmBrzycki(100, 0)).toBe(100);
    expect(e1rmBrzycki(100, 1)).toBe(100);
  });

  it("grows with reps", () => {
    const one = e1rmBrzycki(100, 1);
    const five = e1rmBrzycki(100, 5);
    const twelve = e1rmBrzycki(100, 12);
    expect(one < five && five < twelve).toBe(true);
  });
});
