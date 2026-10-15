/**
 * Body reading model: the eight tape circumferences the form offers,
 * and the mapping from cleaned form values to the repo's upsert input.
 */

import type { BodyStatInput } from "../db/repos/body";

export type CircumferenceKey =
  | "neck_cm"
  | "shoulders_cm"
  | "chest_cm"
  | "bicep_cm"
  | "waist_cm"
  | "hips_cm"
  | "thigh_cm"
  | "calf_cm";

export type CircumferenceField = {
  key: CircumferenceKey;
  label: string;
};

/** The tape measurements, top to bottom, in the order the form shows them. */
export const CIRCUMFERENCE_FIELDS: readonly CircumferenceField[] = [
  { key: "neck_cm", label: "Neck" },
  { key: "shoulders_cm", label: "Shoulders" },
  { key: "chest_cm", label: "Chest" },
  { key: "bicep_cm", label: "Bicep" },
  { key: "waist_cm", label: "Waist" },
  { key: "hips_cm", label: "Hips" },
  { key: "thigh_cm", label: "Thigh" },
  { key: "calf_cm", label: "Calf" },
];

/** Every value a body reading form carries, after field cleaning. */
export type BodyReadingValues = {
  local_date: string;
  weight_kg: number | null;
  bodyfat_pct: number | null;
} & Record<CircumferenceKey, number | null>;

/**
 * Maps cleaned form values to the upsert input. Edit mode sends every
 * value as-is, so a cleared box clears the stored field. Create mode
 * turns empty boxes into undefined: logging one figure on a day that
 * already has a reading keeps the other figures instead of wiping them,
 * because upsertBodyStat reads undefined as keep and null as clear.
 */
export function toBodyStatInput(
  values: BodyReadingValues,
  mode: "create" | "edit",
): BodyStatInput {
  const keep = (value: number | null): number | null | undefined =>
    mode === "edit" ? value : (value ?? undefined);
  const input: BodyStatInput = {
    local_date: values.local_date,
  };
  const fields: Array<[keyof BodyStatInput, number | null]> = [
    ["weight_kg", values.weight_kg],
    ["bodyfat_pct", values.bodyfat_pct],
  ];
  for (const field of CIRCUMFERENCE_FIELDS) {
    fields.push([field.key, values[field.key]]);
  }
  for (const [key, value] of fields) {
    if (key !== "local_date") {
      input[key] = keep(value);
    }
  }
  return input;
}
