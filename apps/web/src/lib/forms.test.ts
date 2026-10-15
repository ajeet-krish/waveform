import { describe, expect, it } from "vitest";
import { SET_RULES, assertValidSet } from "../db/validation";
import {
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
