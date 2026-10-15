import { describe, expect, it } from "vitest";
import { parseRepsInput, parseSetInput, parseWeightInput } from "./setInput";

describe("parseWeightInput", () => {
  it("accepts kg within the CHECK bounds", () => {
    expect(parseWeightInput("100.5", "kg")).toEqual({ ok: true, weight_kg: 100.5 });
    expect(parseWeightInput(" 0 ", "kg")).toEqual({ ok: true, weight_kg: 0 });
  });

  it("converts lb to kg and rounds at the input boundary", () => {
    expect(parseWeightInput("44", "lb")).toEqual({ ok: true, weight_kg: 19.96 });
    expect(parseWeightInput("135", "lb")).toEqual({ ok: true, weight_kg: 61.23 });
  });

  it("rejects an empty weight", () => {
    expect(parseWeightInput("", "kg")).toEqual({
      ok: false,
      issue: "Enter a weight (0 for bodyweight).",
    });
    expect(parseWeightInput("   ", "lb").ok).toBe(false);
  });

  it("rejects text and out-of-range values", () => {
    expect(parseWeightInput("heavy", "kg")).toEqual({ ok: false, issue: "Enter a number." });
    expect(parseWeightInput("-5", "kg")).toEqual({ ok: false, issue: "Enter 0 or more." });
    expect(parseWeightInput("1500.01", "kg")).toEqual({
      ok: false,
      issue: "Enter 1500 kg or less.",
    });
  });
});

describe("parseRepsInput", () => {
  it("accepts integers inside the CHECK bounds", () => {
    expect(parseRepsInput("5")).toEqual({ ok: true, reps: 5 });
    expect(parseRepsInput(" 1 ")).toEqual({ ok: true, reps: 1 });
    expect(parseRepsInput("36")).toEqual({ ok: true, reps: 36 });
  });

  it("rejects empty, fractional, and out-of-range reps", () => {
    expect(parseRepsInput("")).toEqual({ ok: false, issue: "Enter reps." });
    expect(parseRepsInput("abc")).toEqual({ ok: false, issue: "Enter a number." });
    expect(parseRepsInput("5.5")).toEqual({ ok: false, issue: "Enter a whole number." });
    expect(parseRepsInput("0")).toEqual({ ok: false, issue: "Enter 1 or more." });
    expect(parseRepsInput("37")).toEqual({ ok: false, issue: "Enter 36 or less." });
  });
});

describe("parseSetInput", () => {
  it("passes both values through when each field is valid", () => {
    expect(parseSetInput("225", "5", "lb")).toEqual({ ok: true, weight_kg: 102.06, reps: 5 });
  });

  it("collects one issue per broken field", () => {
    const parsed = parseSetInput("", "40", "kg");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues).toEqual(["Enter a weight (0 for bodyweight).", "Enter 36 or less."]);
    }
  });

  it("reports a single issue when only one field is wrong", () => {
    const parsed = parseSetInput("60", "", "kg");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues).toEqual(["Enter reps."]);
    }
  });
});
