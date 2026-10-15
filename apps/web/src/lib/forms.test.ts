import { describe, expect, it } from "vitest";
import {
  ACTIVITY_RULES,
  BODY_RULES,
  SET_RULES,
  assertValidActivity,
  assertValidBodyStat,
  assertValidSet,
} from "../db/validation";
import {
  createBodyFatField,
  createBodyWeightField,
  createCircumferenceField,
  createDistanceKmField,
  createDurationField,
  createElevationField,
  createForm,
  createNumberField,
  createRepsField,
  createTextField,
  createWeightField,
} from "./forms";

describe("createTextField", () => {
  it("keeps errors quiet until the field is touched, then validates the trimmed value", () => {
    const form = createForm({
      fields: { name: createTextField({ trim: true, required: true, maxLength: 40 }) },
      submit: () => undefined,
    });

    expect(form.fields.name.error()).toBeNull();

    form.fields.name.markTouched();
    expect(form.fields.name.error()).toBe("This field is required.");

    form.fields.name.setValue("   ");
    expect(form.fields.name.error()).toBe("This field is required.");

    form.fields.name.setValue("Ada");
    expect(form.fields.name.error()).toBeNull();
  });

  it("exposes raw input on the field and cleaned values on the form", () => {
    const form = createForm({
      fields: { name: createTextField({ trim: true }) },
      submit: () => undefined,
    });

    form.fields.name.setValue("  Ada  ");
    expect(form.fields.name.value()).toBe("  Ada  ");
    expect(form.values().name).toBe("Ada");
  });

  it("enforces maximum length on the trimmed value", () => {
    const field = createTextField({ trim: true, maxLength: 40 });
    expect(field.validate("a".repeat(40))).toBeNull();
    expect(field.validate("a".repeat(41))).toBe("Use 40 characters or fewer.");
  });
});

describe("createNumberField", () => {
  it("rejects empty, fractional, and out-of-range input with plain messages", () => {
    const reps = createNumberField({ integer: true, min: 1, max: 36 });
    expect(reps.validate(Number.NaN)).toBe("Enter a number.");
    expect(reps.validate(1.5)).toBe("Enter a whole number.");
    expect(reps.validate(0)).toBe("Enter 1 or more.");
    expect(reps.validate(37)).toBe("Enter 36 or less.");
    expect(reps.validate(5)).toBeNull();

    const weight = createNumberField({ min: 0, max: 1500 });
    expect(weight.validate(Number.POSITIVE_INFINITY)).toBe("Enter a number.");
    expect(weight.validate(-1)).toBe("Enter 0 or more.");
    expect(weight.validate(1500.01)).toBe("Enter 1500 or less.");
    expect(weight.validate(62.5)).toBeNull();
  });
});

describe("set entry validators mirror SET_RULES", () => {
  it("matches the SQL CHECK constants", () => {
    expect(SET_RULES).toEqual({
      repsMin: 1,
      repsMax: 36,
      weightMinKg: 0,
      weightMaxKg: 1500,
    });
  });

  it("accepts exactly the values assertValidSet accepts, so the repo guard never fires", () => {
    const reps = createRepsField();
    const weight = createWeightField();

    for (const good of [SET_RULES.repsMin, 5, SET_RULES.repsMax]) {
      expect(reps.validate(good)).toBeNull();
      expect(() => assertValidSet({ set_index: 0, weight_kg: 60, reps: good })).not.toThrow();
    }
    for (const bad of [0, 37, 1.5, Number.NaN]) {
      expect(reps.validate(bad)).not.toBeNull();
    }

    for (const good of [SET_RULES.weightMinKg, 62.5, SET_RULES.weightMaxKg]) {
      expect(weight.validate(good)).toBeNull();
      expect(() => assertValidSet({ set_index: 0, weight_kg: good, reps: 5 })).not.toThrow();
    }
    for (const bad of [-1, 1500.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(weight.validate(bad)).not.toBeNull();
    }
  });
});

describe("optional number fields map empty input to null", () => {
  it("cleans an empty or whitespace string to null and a numeric string to a number", () => {
    const field = createBodyWeightField();
    expect(field.clean?.("")).toBeNull();
    expect(field.clean?.("   ")).toBeNull();
    expect(field.clean?.(null)).toBeNull();
    expect(field.clean?.("72.5")).toBe(72.5);
    expect(field.clean?.(72.5)).toBe(72.5);
  });

  it("treats null as valid (the columns are nullable)", () => {
    const duration = createDurationField();
    const weight = createBodyWeightField();
    const fat = createBodyFatField();
    const circumference = createCircumferenceField();
    for (const field of [duration, weight, fat, circumference]) {
      expect(field.validate(field.clean?.("") ?? null)).toBeNull();
    }
  });

  it("createDurationField mirrors ACTIVITY_RULES duration bounds", () => {
    expect(ACTIVITY_RULES).toEqual({
      durationMin: 0,
      durationMax: 1440,
      climbGradeValueMin: 0,
      climbGradeValueMax: 16,
      routesSentMin: 0,
    });
    const duration = createDurationField();
    for (const good of [0, 45, 1440]) {
      expect(duration.validate(good)).toBeNull();
      expect(() => assertValidActivity({ local_date: "2026-10-14", duration_min: good, distance_km: null, elevation_m: null, climb_grade_value: null, routes_sent: null })).not.toThrow();
    }
    for (const bad of [-1, 1441, 1.5, Number.NaN]) {
      expect(duration.validate(bad)).not.toBeNull();
    }
  });

  it("createBodyWeightField mirrors BODY_RULES: strictly positive and at most 1500", () => {
    expect(BODY_RULES).toEqual({
      weightMinKgExclusive: 0,
      weightMaxKg: 1500,
      bodyfatMinPct: 0,
      bodyfatMaxPct: 100,
    });
    const weight = createBodyWeightField();
    for (const good of [0.1, 72.5, 1500]) {
      expect(weight.validate(good)).toBeNull();
      expect(() => assertValidBodyStat({ local_date: "2026-10-14", weight_kg: good, bodyfat_pct: null, neck_cm: null, shoulders_cm: null, chest_cm: null, bicep_cm: null, waist_cm: null, hips_cm: null, thigh_cm: null, calf_cm: null })).not.toThrow();
    }
    // 0 is rejected here (unlike set weights) because a body weight must be positive.
    for (const bad of [0, -1, 1500.01, Number.NaN]) {
      expect(weight.validate(bad)).not.toBeNull();
    }
  });

  it("createBodyFatField mirrors BODY_RULES bodyfat bounds", () => {
    const fat = createBodyFatField();
    for (const good of [0, 15.2, 100]) {
      expect(fat.validate(good)).toBeNull();
    }
    for (const bad of [-0.1, 100.1, Number.NaN]) {
      expect(fat.validate(bad)).not.toBeNull();
    }
  });

  it("createDistanceKmField, createElevationField, and createCircumferenceField accept finite values", () => {
    const distance = createDistanceKmField();
    const elevation = createElevationField();
    const circumference = createCircumferenceField();
    for (const field of [distance, elevation, circumference]) {
      expect(field.validate(0)).toBeNull();
      expect(field.validate(42.5)).toBeNull();
      expect(field.validate(Number.NaN)).not.toBeNull();
      expect(field.validate(Number.POSITIVE_INFINITY)).not.toBeNull();
    }
  });

  it("hands cleaned nullable numbers to a form submit", async () => {
    const seen: Array<{ weight: number | null; fat: number | null }> = [];
    const form = createForm({
      fields: {
        weight: createBodyWeightField(),
        fat: createBodyFatField(),
      },
      submit: (values) => {
        seen.push(values);
      },
    });

    form.fields.weight.setValue("72.5");
    form.fields.fat.setValue("");
    await form.submit();

    expect(form.status()).toBe("saved");
    expect(seen).toEqual([{ weight: 72.5, fat: null }]);
  });
});

describe("createForm", () => {
  it("marks every field touched and refuses to submit when a field is invalid", async () => {
    const submitted: Array<{ name: string }> = [];
    const form = createForm({
      fields: {
        name: createTextField({ trim: true, required: true, maxLength: 40 }),
        reps: createRepsField(),
      },
      submit: (values) => {
        submitted.push(values);
      },
    });

    form.fields.name.setValue("   ");
    await form.submit();

    expect(form.status()).toBe("error");
    expect(form.error()).toBe("Check the highlighted fields.");
    expect(form.fields.name.touched()).toBe(true);
    expect(form.fields.name.error()).toBe("This field is required.");
    expect(form.fields.reps.error()).toBeNull();
    expect(submitted).toHaveLength(0);
  });

  it("walks idle to saving to saved, and surfaces submit failures as error", async () => {
    let shouldFail = false;
    const form = createForm({
      fields: { name: createTextField({ trim: true, required: true }) },
      submit: async () => {
        if (shouldFail) {
          throw new Error("storage is full");
        }
      },
    });

    expect(form.status()).toBe("idle");
    form.fields.name.setValue("Ada");

    const first = form.submit();
    expect(form.status()).toBe("saving");
    await first;
    expect(form.status()).toBe("saved");
    expect(form.error()).toBeNull();

    shouldFail = true;
    await form.submit();
    expect(form.status()).toBe("error");
    expect(form.error()).toBe("storage is full");
  });

  it("hands cleaned, typed values to submit", async () => {
    const seen: Array<{ name: string; weight: number }> = [];
    const form = createForm({
      fields: {
        name: createTextField({ trim: true, required: true }),
        weight: createWeightField({ initial: 60 }),
      },
      submit: (values) => {
        seen.push(values);
      },
    });

    form.fields.name.setValue("  Push day  ");
    await form.submit();

    expect(seen).toEqual([{ name: "Push day", weight: 60 }]);
    expect(form.values().weight).toBe(60);
  });
});
