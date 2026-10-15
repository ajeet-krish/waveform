/** Brzycki constant applied to the numerator side of the curve. */
export const BRZYCKI_A = 1.0278;

/** Brzycki constant scaled by the rep count. */
export const BRZYCKI_B = 0.0278;

/**
 * Estimate the one-rep max for a set using the Brzycki formula.
 *
 * Sets with `reps <= 1` return the lifted weight unchanged. The schema
 * constrains reps to `1..=36`, where the denominator stays positive; for
 * defensive use the function falls back to the raw weight if the
 * denominator would be non-positive.
 */
export function e1rmBrzycki(weightKg: number, reps: number): number {
  if (reps <= 1) {
    return weightKg;
  }
  const denominator = BRZYCKI_A - BRZYCKI_B * reps;
  if (denominator <= Number.EPSILON) {
    return weightKg;
  }
  return weightKg / denominator;
}
