/**
 * Sparkline model: one best-e1RM series across days.
 *
 * buildSparkline turns values into polyline coordinates inside a fixed
 * pixel box (the box matches the SVG's rendered size, so circles stay
 * round); sparklineSummary writes the sentence the SVG carries as its
 * accessible name, because a picture of progress still has to say what
 * it shows.
 */

import { formatDayHeading, formatE1rm } from "./format";

export type SparkDay = {
  /** Device-local day, "YYYY-MM-DD". */
  day: string;
  /** Best working e1RM in kg for that day. */
  value: number;
};

export type SparkDot = {
  x: number;
  y: number;
  /** True for a dot sitting at the series maximum: the record. */
  record: boolean;
};

export type SparkGeometry = {
  /** "x,y x,y ..." ready for a polyline's points attribute. */
  polyline: string;
  dots: SparkDot[];
};

export type SparkBox = {
  width: number;
  height: number;
  /** Keep-out margin so edge dots stay inside the box. */
  pad: number;
};

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Maps values left to right across the box, top to bottom by magnitude.
 * Non-finite values are skipped, a flat series sits on the midline, and
 * a single value lands in the center.
 */
export function buildSparkline(values: readonly number[], box: SparkBox): SparkGeometry {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return { polyline: "", dots: [] };
  }
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const innerWidth = Math.max(1, box.width - box.pad * 2);
  const innerHeight = Math.max(1, box.height - box.pad * 2);
  const xAt = (index: number): number => {
    if (finite.length === 1) {
      return box.width / 2;
    }
    return box.pad + (index * innerWidth) / (finite.length - 1);
  };
  const yAt = (value: number): number => {
    if (max === min) {
      return box.pad + innerHeight / 2;
    }
    return box.height - box.pad - ((value - min) / (max - min)) * innerHeight;
  };
  const dots = finite.map((value, index) => ({
    x: round(xAt(index)),
    y: round(yAt(value)),
    record: value === max,
  }));
  const polyline = dots.map((dot) => `${dot.x},${dot.y}`).join(" ");
  return { polyline, dots };
}

/**
 * The spoken summary for a series of best e1RM days. Days are read in
 * any order; headings follow formatDayHeading, so a recent peak reads
 * "Today" and an old one reads "Monday 12 Oct".
 */
export function sparklineSummary(
  points: readonly SparkDay[],
  unit: string,
  today: Date,
): string {
  if (points.length === 0) {
    return "No days logged yet.";
  }
  const sorted = [...points].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const heading = (day: string): string => formatDayHeading(day, today);
  const figure = (value: number): string => `${formatE1rm(value)} ${unit}`;

  if (sorted.length === 1) {
    const only = sorted[0];
    if (!only) {
      return "No days logged yet.";
    }
    return `Best e1RM (Brzycki): ${figure(only.value)}, logged ${heading(only.day)}.`;
  }

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) {
    return "No days logged yet.";
  }
  let peak = first;
  for (const point of sorted) {
    if (point.value > peak.value) {
      peak = point;
    }
  }
  return (
    `Best e1RM (Brzycki): ${sorted.length} days logged, ` +
    `${figure(first.value)} ${heading(first.day)} to ${figure(last.value)} ${heading(last.day)}, ` +
    `peak ${figure(peak.value)} ${heading(peak.day)}.`
  );
}
