/**
 * Form input glue shared by the climb, ride, and body forms: the
 * "YYYY-MM-DD" date field every log form starts with, and the raw-value
 * formatter every optional-number box uses.
 */

import { createTextField, type FieldSpec, type OptionalNumberInput } from "./forms";

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A required calendar-day text field, trimmed, pre-filled with
 * `initial`. The pattern mirrors db/validation.ts, so a date this field
 * accepts is a date assertValidActivity and assertValidBodyStat accept.
 */
export function createLocalDateField(initial: string): FieldSpec<string> {
  return createTextField({
    initial,
    trim: true,
    validate(value: string): string | null {
      if (!LOCAL_DATE_PATTERN.test(value)) {
        return "Pick a date as YYYY-MM-DD.";
      }
      return null;
    },
  });
}

/**
 * The text an optional-number box shows: an empty box for null, digits
 * for a pre-parsed number, and the raw string (for example "12.")
 * exactly as it was typed.
 */
export function optionalInputValue(raw: OptionalNumberInput): string {
  if (raw === null) {
    return "";
  }
  if (typeof raw === "number") {
    return String(raw);
  }
  return raw;
}
