/**
 * Set entry parsing: the text a workout input holds becomes the numbers
 * a draft set stores, checked against SET_RULES before any reducer runs.
 *
 * Weight is typed in the profile's display unit and converted to the
 * stored kilogram value at this boundary (same contract as format.ts),
 * so a value the form accepts is a value assertValidSet accepts.
 */

import { SET_RULES } from "../db/validation";
import { toDisplayWeight, toKg, type WeightUnit } from "./format";

export type WeightParse = { ok: true; weight_kg: number } | { ok: false; issue: string };

export type RepsParse = { ok: true; reps: number } | { ok: false; issue: string };

export type SetParse =
  | { ok: true; weight_kg: number; reps: number }
  | { ok: false; issues: string[] };

/**
 * The SET_RULES weight bounds as the user sees them: kg passes through
 * (0..1500), lb is the same stored range converted for display
 * (0..3306.9). Input validation and any input hint agree because both
 * read these numbers.
 */
export function weightInputBounds(unit: WeightUnit): { min: number; max: number } {
  return {
    min: toDisplayWeight(SET_RULES.weightMinKg, unit),
    max: toDisplayWeight(SET_RULES.weightMaxKg, unit),
  };
}

/** Parses a display-unit weight into stored kg, or explains the rejection. */
export function parseWeightInput(text: string, unit: WeightUnit): WeightParse {
  const raw = text.trim();
  if (raw === "") {
    return { ok: false, issue: "Enter a weight (0 for bodyweight)." };
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return { ok: false, issue: "Enter a number." };
  }
  const weightKg = toKg(value, unit);
  const bounds = weightInputBounds(unit);
  if (weightKg < SET_RULES.weightMinKg) {
    return { ok: false, issue: `Enter ${bounds.min} or more.` };
  }
  if (weightKg > SET_RULES.weightMaxKg) {
    return { ok: false, issue: `Enter ${bounds.max} ${unit} or less.` };
  }
  return { ok: true, weight_kg: weightKg };
}

/** Parses reps as an integer inside the SQL CHECK bounds, or explains why not. */
export function parseRepsInput(text: string): RepsParse {
  const raw = text.trim();
  if (raw === "") {
    return { ok: false, issue: "Enter reps." };
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return { ok: false, issue: "Enter a number." };
  }
  if (!Number.isInteger(value)) {
    return { ok: false, issue: "Enter a whole number." };
  }
  if (value < SET_RULES.repsMin) {
    return { ok: false, issue: `Enter ${SET_RULES.repsMin} or more.` };
  }
  if (value > SET_RULES.repsMax) {
    return { ok: false, issue: `Enter ${SET_RULES.repsMax} or less.` };
  }
  return { ok: true, reps: value };
}

/** Parses a whole add-set row: both fields must pass before a set is added. */
export function parseSetInput(
  weightText: string,
  repsText: string,
  unit: WeightUnit,
): SetParse {
  const weight = parseWeightInput(weightText, unit);
  const reps = parseRepsInput(repsText);
  if (weight.ok && reps.ok) {
    return { ok: true, weight_kg: weight.weight_kg, reps: reps.reps };
  }
  const issues: string[] = [];
  if (!weight.ok) {
    issues.push(weight.issue);
  }
  if (!reps.ok) {
    issues.push(reps.issue);
  }
  return { ok: false, issues };
}
