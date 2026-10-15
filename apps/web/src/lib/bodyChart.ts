/**
 * Body-stat chart model: one weight series and one body-fat series
 * across days, plus the spoken summary the weight chart carries as its
 * accessible name.
 *
 * buildBodyPoints flattens body-stat rows into one point per day;
 * bodySeries splits those points into the two sparkline-ready series,
 * skipping nulls independently so a day that logged weight but no body
 * fat still contributes its weight dot.
 */

import type { BodyStats } from "@waveform/api-types";
import type { LocalRow } from "../db/types";
import { formatDayHeading, formatWeight, type WeightUnit } from "./format";
import type { SparkDay } from "./sparkline";

export type BodyPoint = {
  /** Device-local day, "YYYY-MM-DD". */
  day: string;
  /** Weight in kg for that day, or null when not logged. */
  weightKg: number | null;
  /** Body fat percentage for that day, or null when not logged. */
  bodyfatPct: number | null;
};

/** Flattens body-stat rows into one point per day, sorted day asc. */
export function buildBodyPoints(rows: readonly LocalRow<BodyStats>[]): BodyPoint[] {
  const points = rows.map((row) => ({
    day: row.local_date,
    weightKg: row.weight_kg,
    bodyfatPct: row.bodyfat_pct,
  }));
  points.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return points;
}

export type BodySeries = {
  /** Weight per day, nulls skipped; ready for a kg sparkline. */
  weight: SparkDay[];
  /** Body fat per day, nulls skipped; ready for a percent sparkline. */
  bodyfat: SparkDay[];
};

/** Splits points into the weight and body-fat sparkline series. */
export function bodySeries(points: readonly BodyPoint[]): BodySeries {
  const weight: SparkDay[] = [];
  const bodyfat: SparkDay[] = [];
  for (const point of points) {
    if (point.weightKg !== null && Number.isFinite(point.weightKg)) {
      weight.push({ day: point.day, value: point.weightKg });
    }
    if (point.bodyfatPct !== null && Number.isFinite(point.bodyfatPct)) {
      bodyfat.push({ day: point.day, value: point.bodyfatPct });
    }
  }
  return { weight, bodyfat };
}

/**
 * The spoken summary for a series of body-weight days. Days are read in
 * any order; headings follow formatDayHeading, so a recent point reads
 * "Today" and an old one reads "Monday 12 Oct".
 */
export function bodyChartSummary(
  weight: readonly SparkDay[],
  today: Date,
  unit: WeightUnit,
): string {
  if (weight.length === 0) {
    return "No body weight logged yet.";
  }
  const sorted = [...weight].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const heading = (day: string): string => formatDayHeading(day, today);
  const figure = (kg: number): string => formatWeight(kg, unit);

  if (sorted.length === 1) {
    const only = sorted[0];
    if (!only) {
      return "No body weight logged yet.";
    }
    return `Body weight: ${figure(only.value)}, logged ${heading(only.day)}.`;
  }

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) {
    return "No body weight logged yet.";
  }
  let low = first;
  let high = first;
  for (const point of sorted) {
    if (point.value < low.value) {
      low = point;
    }
    if (point.value > high.value) {
      high = point;
    }
  }
  return (
    `Body weight: ${sorted.length} days logged, ` +
    `${figure(first.value)} ${heading(first.day)} to ${figure(last.value)} ${heading(last.day)}, ` +
    `low ${figure(low.value)} ${heading(low.day)}, high ${figure(high.value)} ${heading(high.day)}.`
  );
}
