/**
 * Effort Points heat levels, matching crates/scoring: levels 0, 1-25, 26-50,
 * 51-75, and 76-100 Effort Points per day.
 */
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export const HEAT_LEVEL_RANGES: ReadonlyArray<{ level: HeatLevel; label: string }> = [
  { level: 0, label: "0" },
  { level: 1, label: "1 to 25" },
  { level: 2, label: "26 to 50" },
  { level: 3, label: "51 to 75" },
  { level: 4, label: "76 to 100" },
];

export function heatLevel(effortPoints: number): HeatLevel {
  if (Number.isNaN(effortPoints) || effortPoints <= 0) return 0;
  if (effortPoints <= 25) return 1;
  if (effortPoints <= 50) return 2;
  if (effortPoints <= 75) return 3;
  return 4;
}
