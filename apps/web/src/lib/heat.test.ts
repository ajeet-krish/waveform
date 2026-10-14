import { describe, expect, it } from "vitest";
import { heatLevel } from "./heat";

describe("heatLevel", () => {
  it("maps Effort Points onto the five published levels", () => {
    expect(heatLevel(0)).toBe(0);
    expect(heatLevel(1)).toBe(1);
    expect(heatLevel(25)).toBe(1);
    expect(heatLevel(26)).toBe(2);
    expect(heatLevel(50)).toBe(2);
    expect(heatLevel(51)).toBe(3);
    expect(heatLevel(75)).toBe(3);
    expect(heatLevel(76)).toBe(4);
    expect(heatLevel(100)).toBe(4);
  });

  it("treats negative and non-finite input as an empty day", () => {
    expect(heatLevel(-5)).toBe(0);
    expect(heatLevel(Number.NaN)).toBe(0);
    expect(heatLevel(Number.POSITIVE_INFINITY)).toBe(4);
  });
});
