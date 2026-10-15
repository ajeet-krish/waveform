/**
 * Reactive form state without a DOM: field accessors, validation, and a
 * submit lifecycle built on Solid signals. Views bind their own controls;
 * this module owns values, errors, touched state, and status.
 *
 * The set-entry validators mirror SET_RULES (db/validation.ts), so a value
 * the form accepts is a value assertValidSet accepts: UI input can never
 * trip the repo guard.
 */

import { createSignal, type Accessor } from "solid-js";
import { ACTIVITY_RULES, BODY_RULES, SET_RULES } from "../db/validation";

/** idle until the first submit, then saving, saved, or error. */
export type FormStatus = "idle" | "saving" | "saved" | "error";

/** Returns a human-readable problem, or null when the value is acceptable. */
export type Validator<V> = (value: V) => string | null;

export type FieldSpec<V, W = V> = {
  initial: V;
  /** Normalizes the raw value V into the stored value W before validation and values(); raw input stays untouched while typing. */
  clean?(value: V): W;
  validate(value: W): string | null;
};

export type FieldHandle<V> = {
  /** The raw value as the control holds it. */
  value: Accessor<V>;
  /** The current problem, visible only after the field was touched or a submit ran. */
  error: Accessor<string | null>;
  touched: Accessor<boolean>;
  setValue(next: V): void;
  markTouched(): void;
};

export type TextFieldOptions = {
  initial?: string;
  /** Validate the trimmed value (use with form values, which read cleaned). */
  trim?: boolean;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  validate?: Validator<string>;
};

export type NumberFieldOptions = {
  initial?: number;
  integer?: boolean;
  min?: number;
  max?: number;
  validate?: Validator<number>;
};

export function createTextField(options: TextFieldOptions = {}): FieldSpec<string> {
  const trim = options.trim ?? false;
  return {
    initial: options.initial ?? "",
    clean: trim ? (value: string) => value.trim() : undefined,
    validate(value: string): string | null {
      const v = trim ? value.trim() : value;
      if ((options.required ?? false) && v.length === 0) {
        return "This field is required.";
      }
      if (options.minLength !== undefined && v.length < options.minLength) {
        return `Enter at least ${options.minLength} characters.`;
      }
      if (options.maxLength !== undefined && v.length > options.maxLength) {
        return `Use ${options.maxLength} characters or fewer.`;
      }
      return options.validate ? options.validate(v) : null;
    },
  };
}

export function createNumberField(options: NumberFieldOptions = {}): FieldSpec<number> {
  return {
    initial: options.initial ?? NaN,
    validate(value: number): string | null {
      if (!Number.isFinite(value)) {
        return "Enter a number.";
      }
      if ((options.integer ?? false) && !Number.isInteger(value)) {
        return "Enter a whole number.";
      }
      if (options.min !== undefined && value < options.min) {
        return `Enter ${options.min} or more.`;
      }
      if (options.max !== undefined && value > options.max) {
        return `Enter ${options.max} or less.`;
      }
      return options.validate ? options.validate(value) : null;
    },
  };
}

/**
 * The reps validator that mirrors the SQL CHECK: integer, SET_RULES bounds.
 * Anything this accepts, assertValidSet accepts.
 */
export function createRepsField(options: { initial?: number } = {}): FieldSpec<number> {
  return createNumberField({
    initial: options.initial ?? 5,
    integer: true,
    min: SET_RULES.repsMin,
    max: SET_RULES.repsMax,
  });
}

/** The weight_kg validator that mirrors the SQL CHECK: finite, SET_RULES bounds. */
export function createWeightField(options: { initial?: number } = {}): FieldSpec<number> {
  return createNumberField({
    initial: options.initial ?? NaN,
    min: SET_RULES.weightMinKg,
    max: SET_RULES.weightMaxKg,
  });
}

/**
 * The raw value an optional-number field carries: the string exactly as
 * typed (so an in-progress "12." stays untouched while editing), a
 * pre-parsed number, or null for an empty box.
 */
export type OptionalNumberInput = string | number | null;

/**
 * Maps an optional-number input to its stored value: an empty or
 * whitespace-only string becomes null (the column is nullable), a
 * numeric string becomes its number, and a number passes through.
 */
function parseOptionalNumber(raw: OptionalNumberInput): number | null {
  if (raw === null) {
    return null;
  }
  if (typeof raw === "number") {
    return raw;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  return Number(trimmed);
}

export type OptionalNumberFieldOptions = {
  initial?: number | null;
  integer?: boolean;
  min?: number;
  max?: number;
  /** Reject values at or below min instead of below min (strictly positive). */
  exclusiveMin?: boolean;
  validate?: Validator<number>;
};

/**
 * The optional-number field builder behind the body and activity forms.
 * Empty input maps to null and validates cleanly (the columns are all
 * nullable); a non-empty value must parse to a finite number inside the
 * given bounds. The bounds mirror the SQL CHECKs via ACTIVITY_RULES and
 * BODY_RULES, so anything this accepts, the repo guard accepts too.
 */
export function createOptionalNumberField(
  options: OptionalNumberFieldOptions = {},
): FieldSpec<OptionalNumberInput, number | null> {
  return {
    initial: options.initial ?? null,
    clean: parseOptionalNumber,
    validate(value: number | null): string | null {
      const parsed = value;
      if (parsed === null) {
        return null;
      }
      if (!Number.isFinite(parsed)) {
        return "Enter a number.";
      }
      if ((options.integer ?? false) && !Number.isInteger(parsed)) {
        return "Enter a whole number.";
      }
      if (options.min !== undefined) {
        if (options.exclusiveMin ? parsed <= options.min : parsed < options.min) {
          return options.exclusiveMin
            ? `Enter more than ${options.min}.`
            : `Enter ${options.min} or more.`;
        }
      }
      if (options.max !== undefined && parsed > options.max) {
        return `Enter ${options.max} or less.`;
      }
      return options.validate ? options.validate(parsed) : null;
    },
  };
}

/** duration_min validator mirroring ACTIVITY_RULES: whole minutes 0..1440, or empty. */
export function createDurationField(
  options: { initial?: number | null } = {},
): FieldSpec<OptionalNumberInput, number | null> {
  return createOptionalNumberField({
    initial: options.initial ?? null,
    integer: true,
    min: ACTIVITY_RULES.durationMin,
    max: ACTIVITY_RULES.durationMax,
  });
}

/** distance_km validator: finite, or empty for null. */
export function createDistanceKmField(
  options: { initial?: number | null } = {},
): FieldSpec<OptionalNumberInput, number | null> {
  return createOptionalNumberField({
    initial: options.initial ?? null,
  });
}

/** elevation_m validator: finite, or empty for null. */
export function createElevationField(
  options: { initial?: number | null } = {},
): FieldSpec<OptionalNumberInput, number | null> {
  return createOptionalNumberField({
    initial: options.initial ?? null,
  });
}

/**
 * Body weight_kg validator mirroring BODY_RULES: strictly positive and at
 * most 1500, or empty for null.
 */
export function createBodyWeightField(
  options: { initial?: number | null } = {},
): FieldSpec<OptionalNumberInput, number | null> {
  return createOptionalNumberField({
    initial: options.initial ?? null,
    min: BODY_RULES.weightMinKgExclusive,
    max: BODY_RULES.weightMaxKg,
    exclusiveMin: true,
  });
}

/** bodyfat_pct validator mirroring BODY_RULES: 0..100, or empty for null. */
export function createBodyFatField(
  options: { initial?: number | null } = {},
): FieldSpec<OptionalNumberInput, number | null> {
  return createOptionalNumberField({
    initial: options.initial ?? null,
    min: BODY_RULES.bodyfatMinPct,
    max: BODY_RULES.bodyfatMaxPct,
  });
}

/** Circumference (neck, waist, ...) validator: finite cm, or empty for null. */
export function createCircumferenceField(
  options: { initial?: number | null } = {},
): FieldSpec<OptionalNumberInput, number | null> {
  return createOptionalNumberField({
    initial: options.initial ?? null,
  });
}

/** Extracts the stored (cleaned) value type a field spec carries. */
export type ValueOf<S> = S extends FieldSpec<infer _V, infer W> ? W : never;

/** Extracts the raw input type a field spec carries (what setValue accepts). */
export type InputOf<S> = S extends FieldSpec<infer V, infer _W> ? V : never;

/** Maps a record of field specs to the matching record of values. */
export type ValueMap<F> = { [K in keyof F]: ValueOf<F[K]> };

export type FormSpec<F> = {
  fields: F;
  submit(values: ValueMap<F>): void | Promise<void>;
};

export type Form<F> = {
  fields: { [K in keyof F]: FieldHandle<InputOf<F[K]>> };
  /** Cleaned values, ready to hand to submit or a repo call. */
  values(): ValueMap<F>;
  status: Accessor<FormStatus>;
  /** Form-level message: which fields need attention, or why submit failed. */
  error: Accessor<string | null>;
  submit(): Promise<void>;
};

function messageOf(cause: unknown): string {
  if (cause instanceof Error && cause.message) {
    return cause.message;
  }
  return "That did not go through. Try again.";
}

export function createForm<F extends object>(spec: FormSpec<F>): Form<F> {
  const keys = Object.keys(spec.fields);
  const handles: Record<string, FieldHandle<unknown>> = {};
  const cleaned: Record<string, () => unknown> = {};

  for (const key of keys) {
    const fieldSpec = spec.fields[key as keyof F] as unknown as FieldSpec<unknown> | undefined;
    if (!fieldSpec) {
      continue;
    }
    const built = makeField(fieldSpec);
    handles[key] = built.handle;
    cleaned[key] = built.cleaned;
  }

  const [status, setStatus] = createSignal<FormStatus>("idle");
  const [formError, setFormError] = createSignal<string | null>(null);

  const readValues = (): ValueMap<F> => {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const read = cleaned[key];
      out[key] = read ? read() : undefined;
    }
    return out as unknown as ValueMap<F>;
  };

  const markAllTouched = (): void => {
    for (const key of keys) {
      handles[key]?.markTouched();
    }
  };

  const problems = (): string[] => {
    const list: string[] = [];
    for (const key of keys) {
      const error = handles[key]?.error();
      if (error !== null && error !== undefined) {
        list.push(error);
      }
    }
    return list;
  };

  return {
    fields: handles as unknown as Form<F>["fields"],
    values: readValues,
    status,
    error: formError,

    async submit(): Promise<void> {
      markAllTouched();
      setFormError(null);
      if (problems().length > 0) {
        setStatus("error");
        setFormError("Check the highlighted fields.");
        return;
      }
      setStatus("saving");
      try {
        await spec.submit(readValues());
        setStatus("saved");
      } catch (cause) {
        setStatus("error");
        setFormError(messageOf(cause));
      }
    },
  };
}

function makeField<V, W>(fieldSpec: FieldSpec<V, W>): {
  handle: FieldHandle<V>;
  cleaned: Accessor<W>;
} {
  const [value, setValue] = createSignal<V>(fieldSpec.initial);
  const [touched, setTouched] = createSignal(false);
  const cleaned = (): W => (fieldSpec.clean ? fieldSpec.clean(value()) : (value() as unknown as W));
  const handle: FieldHandle<V> = {
    value,
    touched,
    setValue: (next: V) => setValue(() => next),
    markTouched: () => setTouched(true),
    error: () => (touched() ? fieldSpec.validate(cleaned()) : null),
  };
  return { handle, cleaned };
}
