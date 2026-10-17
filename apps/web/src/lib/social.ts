/**
 * Leaderboard view models: window labels, per-board metric formatting in
 * the profile's display units, shared-rank labels, and the empty and zero
 * handling the boards screen reads.
 *
 * Pure and server-shaped: it takes the generated `BoardsResponse` and turns
 * it into `BoardView` groups the route renders, so the route holds no
 * formatting logic. Weights convert through format.ts (kg is stored, lb is
 * display only). Distance and elevation follow the profile's length unit as
 * the metric/imperial switch: cm keeps km and m (the app's native distance
 * figures), in shows miles and feet. Ranks arrive already sharing a number
 * (1, 2, 2, 4) from the server, so a label is a straight format.
 */

import type { BoardWindow, BoardsResponse, PublicUser } from "@waveform/api-types";
import {
  KG_PER_LB,
  formatE1rm,
  formatWeight,
  type LengthUnit,
  type WeightUnit,
} from "./format";

/** The window the API serves when the request omits one. */
export const DEFAULT_BOARD_WINDOW: BoardWindow = "7d";

/** Board windows in display order, narrowest first. */
export const BOARD_WINDOWS: readonly BoardWindow[] = ["7d", "4w", "12w"];

const WINDOW_LABELS: Record<BoardWindow, string> = {
  "7d": "7 days",
  "4w": "4 weeks",
  "12w": "12 weeks",
};

/** "7 days" / "4 weeks" / "12 weeks": the segmented control's labels. */
export function windowLabel(window: BoardWindow): string {
  return WINDOW_LABELS[window];
}

export type DistanceUnit = "km" | "mi";

export type ElevationUnit = "m" | "ft";

/** Exact kilometres per international mile. */
export const KM_PER_MI = 1.609344;

/** Exact metres per international foot. */
export const M_PER_FT = 0.3048;

/** The units the boards format their figures in. */
export type BoardUnits = {
  weight: WeightUnit;
  distance: DistanceUnit;
  elevation: ElevationUnit;
};

/**
 * The leaderboard's formatting units from the profile's display units. The
 * length unit doubles as the metric/imperial switch: cm keeps km and m, in
 * shows miles and feet.
 */
export function boardUnits(weight: WeightUnit, length: LengthUnit): BoardUnits {
  if (length === "in") {
    return { weight, distance: "mi", elevation: "ft" };
  }
  return { weight, distance: "km", elevation: "m" };
}

/**
 * "#1" / "#2": the rank as the server assigned it. Ties already share a
 * number (1, 2, 2, 4), so two members on rank 2 both read "#2".
 */
export function formatRank(rank: number): string {
  if (!Number.isFinite(rank) || rank < 1) {
    return "n/a";
  }
  return `#${Math.floor(rank)}`;
}

/** Volume in the display weight unit: "1240 kg" / "2733.7 lb". */
export function formatVolume(volumeKg: number, unit: WeightUnit): string {
  if (!Number.isFinite(volumeKg)) {
    return "n/a";
  }
  return formatWeight(volumeKg, unit);
}

/** Best e1RM in the display weight unit at one decimal: "112.5 kg" / "248 lb". */
export function formatBestE1rm(bestE1rmKg: number, unit: WeightUnit): string {
  if (!Number.isFinite(bestE1rmKg)) {
    return "n/a";
  }
  const display = unit === "kg" ? bestE1rmKg : bestE1rmKg / KG_PER_LB;
  return `${formatE1rm(display)} ${unit}`;
}

/** A relative e1RM ratio at the server's two decimals: "1.50". */
export function formatRatio(ratio: number): string {
  if (!Number.isFinite(ratio)) {
    return "n/a";
  }
  return ratio.toFixed(2);
}

/** Distance in the display unit at one decimal: "42.0 km" / "26.1 mi". */
export function formatDistance(distanceKm: number, unit: DistanceUnit): string {
  if (!Number.isFinite(distanceKm)) {
    return "n/a";
  }
  const value = unit === "mi" ? distanceKm / KM_PER_MI : distanceKm;
  return `${value.toFixed(1)} ${unit}`;
}

/** Elevation in the display unit as whole figures: "380 m" / "1247 ft". */
export function formatElevation(elevationM: number, unit: ElevationUnit): string {
  if (!Number.isFinite(elevationM)) {
    return "n/a";
  }
  const value = unit === "ft" ? elevationM / M_PER_FT : elevationM;
  return `${Math.round(value)} ${unit}`;
}

/** V-points as a whole figure: "24". */
export function formatVPoints(vPoints: number): string {
  if (!Number.isFinite(vPoints)) {
    return "n/a";
  }
  return String(Math.round(vPoints));
}

/** Hardest grade: "V5", or "none" when nothing was sent. */
export function formatHardestGrade(hardestGrade: number | null): string {
  if (hardestGrade === null || !Number.isFinite(hardestGrade)) {
    return "none";
  }
  return `V${Math.floor(hardestGrade)}`;
}

/** One ranked member as the table renders it. */
export type BoardRowView = {
  rank: number;
  rankLabel: string;
  member: string;
  cells: string[];
  /** True when the member has no data on this board in the window. */
  empty: boolean;
};

/** One board: its heading, metric columns, and ranked rows. */
export type BoardView = {
  key: string;
  title: string;
  columns: string[];
  rows: BoardRowView[];
  /** True when no member has data on this board in the window. */
  empty: boolean;
  /** Shown in place of the table when the board is empty. */
  emptyNote: string;
};

/** One discipline's boards, under the heading the route stacks them with. */
export type BoardGroup = {
  label: string;
  boards: BoardView[];
};

/** The fields every ranked board entry shares. */
type RankedMember = {
  rank: number;
  user: PublicUser;
};

function boardView<T extends RankedMember>(
  key: string,
  title: string,
  columns: string[],
  entries: readonly T[],
  cells: (entry: T) => string[],
  isEmpty: (entry: T) => boolean,
  emptyNote: string,
): BoardView {
  const rows: BoardRowView[] = entries.map((entry) => ({
    rank: entry.rank,
    rankLabel: formatRank(entry.rank),
    member: entry.user.display_name,
    cells: cells(entry),
    empty: isEmpty(entry),
  }));
  return {
    key,
    title,
    columns,
    rows,
    empty: rows.length === 0 || rows.every((row) => row.empty),
    emptyNote,
  };
}

/**
 * Every board from one response, grouped by discipline in the order the
 * boards screen stacks them: Consistency, Lifting, Cycling, Climbing. The
 * marquee-lift boards come from the response's `e1rm` list, so their names
 * are never duplicated client-side.
 */
export function buildLeaderboard(response: BoardsResponse, units: BoardUnits): BoardGroup[] {
  const consistency = boardView(
    "consistency",
    "Consistency",
    ["Active days", "Weekly streak"],
    response.consistency,
    (entry) => [String(entry.active_days), String(entry.weekly_streak)],
    (entry) => entry.active_days === 0,
    "No one logged an active day in this window.",
  );

  const volume = boardView(
    "lifting-volume",
    "Lifting volume",
    ["Volume"],
    response.lifting.volume,
    (entry) => [formatVolume(entry.volume_kg, units.weight)],
    (entry) => entry.volume_kg === 0,
    "No one logged a working set in this window.",
  );

  const e1rm = response.lifting.e1rm.map((board) =>
    boardView(
      `lifting-e1rm-${board.lift}`,
      `Best e1RM: ${board.lift}`,
      ["Best e1RM"],
      board.entries,
      (entry) => [formatBestE1rm(entry.best_e1rm_kg, units.weight)],
      (entry) => entry.best_e1rm_kg === 0,
      `No one logged a ${board.lift} working set in this window.`,
    ),
  );

  const relative = boardView(
    "lifting-relative",
    "Relative e1RM",
    ["e1RM / bodyweight"],
    response.lifting.relative_e1rm,
    (entry) => [formatRatio(entry.ratio)],
    (entry) => entry.ratio === 0,
    "No member has both a marquee lift and a bodyweight in this window.",
  );

  const cyclingDistance = boardView(
    "cycling-distance",
    "Cycling distance",
    ["Distance"],
    response.cycling.distance,
    (entry) => [formatDistance(entry.distance_km, units.distance)],
    (entry) => entry.distance_km === 0,
    "No one logged a ride in this window.",
  );

  const cyclingElevation = boardView(
    "cycling-elevation",
    "Cycling elevation",
    ["Elevation"],
    response.cycling.elevation,
    (entry) => [formatElevation(entry.elevation_m, units.elevation)],
    (entry) => entry.elevation_m === 0,
    "No one logged a climb in this window.",
  );

  const climbing = boardView(
    "climbing",
    "Climbing",
    ["V-points", "Hardest grade"],
    response.climbing,
    (entry) => [formatVPoints(entry.v_points), formatHardestGrade(entry.hardest_grade)],
    (entry) => entry.v_points === 0 && entry.hardest_grade === null,
    "No one logged a send in this window.",
  );

  return [
    { label: "Consistency", boards: [consistency] },
    { label: "Lifting", boards: [volume, ...e1rm, relative] },
    { label: "Cycling", boards: [cyclingDistance, cyclingElevation] },
    { label: "Climbing", boards: [climbing] },
  ];
}

/** True when at least one board carries a non-zero entry. */
export function hasLeaderboardData(groups: readonly BoardGroup[]): boolean {
  return groups.some((group) => group.boards.some((board) => !board.empty));
}
