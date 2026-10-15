/**
 * Highest numeric grade on the V scale. Grades outside `0..=MAX_V_GRADE`
 * are clamped, matching the `climb_grade_value` CHECK in
 * migrations/0003_hardening.sql.
 */
export const MAX_V_GRADE = 16;

/**
 * Points for a single send at `grade` on the V scale. Out-of-range grades
 * clamp into `0..=MAX_V_GRADE`, so a mistyped or hostile grade can never
 * produce negative or runaway points.
 */
export function vPoints(grade: number): number {
  const clamped = Math.min(Math.max(grade, 0), MAX_V_GRADE);
  return 2 ** clamped;
}

/** Sum of V-points for a set of sends. */
export function totalVPoints(grades: readonly number[]): number {
  let total = 0;
  for (const grade of grades) {
    total += vPoints(grade);
  }
  return total;
}
