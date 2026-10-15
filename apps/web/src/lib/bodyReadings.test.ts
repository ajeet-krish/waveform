import { describe, expect, it } from "vitest";
import {
  CIRCUMFERENCE_FIELDS,
  toBodyStatInput,
  type BodyReadingValues,
} from "./bodyReadings";

function values(overrides: Partial<BodyReadingValues> = {}): BodyReadingValues {
  return {
    local_date: "2026-10-14",
    weight_kg: null,
    bodyfat_pct: null,
    neck_cm: null,
    shoulders_cm: null,
    chest_cm: null,
    bicep_cm: null,
    waist_cm: null,
    hips_cm: null,
    thigh_cm: null,
    calf_cm: null,
    ...overrides,
  };
}

describe("CIRCUMFERENCE_FIELDS", () => {
  it("offers the eight tape columns, top to bottom, with unique keys and labels", () => {
    expect(CIRCUMFERENCE_FIELDS.map((field) => field.key)).toEqual([
      "neck_cm",
      "shoulders_cm",
      "chest_cm",
      "bicep_cm",
      "waist_cm",
      "hips_cm",
      "thigh_cm",
      "calf_cm",
    ]);
    const labels = CIRCUMFERENCE_FIELDS.map((field) => field.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("toBodyStatInput", () => {
  it("always carries the calendar day", () => {
    expect(toBodyStatInput(values(), "create").local_date).toBe("2026-10-14");
  });

  it("create mode keeps filled figures and turns empty boxes into undefined", () => {
    const input = toBodyStatInput(
      values({ weight_kg: 82.4, waist_cm: 84 }),
      "create",
    );
    expect(input.weight_kg).toBe(82.4);
    expect(input.waist_cm).toBe(84);
    // Undefined reads as keep, so a same-day reading never wipes a figure.
    expect(input.bodyfat_pct).toBeUndefined();
    expect(input.neck_cm).toBeUndefined();
  });

  it("edit mode passes nulls through so a cleared box clears the stored field", () => {
    const input = toBodyStatInput(values({ weight_kg: 82.4, bodyfat_pct: null }), "edit");
    expect(input.weight_kg).toBe(82.4);
    expect(input.bodyfat_pct).toBeNull();
    expect(input.calf_cm).toBeNull();
  });

  it("carries every circumference the form offers", () => {
    const input = toBodyStatInput(
      values({ neck_cm: 38, shoulders_cm: 118, chest_cm: 98, bicep_cm: 33 }),
      "edit",
    );
    expect(input.neck_cm).toBe(38);
    expect(input.shoulders_cm).toBe(118);
    expect(input.chest_cm).toBe(98);
    expect(input.bicep_cm).toBe(33);
  });
});
