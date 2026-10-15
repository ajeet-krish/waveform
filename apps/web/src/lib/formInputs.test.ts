import { describe, expect, it } from "vitest";
import { createLocalDateField, optionalInputValue } from "./formInputs";

describe("createLocalDateField", () => {
  it("accepts a bare YYYY-MM-DD calendar day", () => {
    const field = createLocalDateField("2026-10-14");
    expect(field.validate("2026-10-14")).toBeNull();
  });

  it("trims whitespace before validating", () => {
    const field = createLocalDateField("");
    expect(field.clean?.(" 2026-10-14 ")).toBe("2026-10-14");
    expect(field.validate(" 2026-10-14 ")).toBeNull();
  });

  it("rejects empty and malformed dates", () => {
    const field = createLocalDateField("");
    const problem = "Pick a date as YYYY-MM-DD.";
    expect(field.validate("")).toBe(problem);
    expect(field.validate("14/10/2026")).toBe(problem);
    expect(field.validate("2026-10")).toBe(problem);
  });
});

describe("optionalInputValue", () => {
  it("renders null as an empty box, numbers as digits, strings as typed", () => {
    expect(optionalInputValue(null)).toBe("");
    expect(optionalInputValue(12.5)).toBe("12.5");
    expect(optionalInputValue(0)).toBe("0");
    expect(optionalInputValue("12.")).toBe("12.");
  });
});
