/**
 * Display formatting: weights, e1RM, durations, and dates.
 *
 * Weights are stored in kg; lb and in are display-only. Conversion happens
 * once, at this boundary: lb typed by the user is converted to kg and
 * rounded to two decimals before it reaches a row or a validator. Day math
 * (weekdays, "today") comes from week.ts so every surface agrees that weeks
 * start on Monday.
 */

import { DAY_NAMES, sameDay } from "./week";

export type WeightUnit = "kg" | "lb";

export type LengthUnit = "cm" | "in";

/** Exact pound-to-kilogram factor (international avoirdupois pound). */
export const KG_PER_LB = 0.45359237;

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Parses a bare "YYYY-MM-DD" device-local calendar day into a local Date. */
export function parseLocalDate(localDate: string): Date {
  const match = LOCAL_DATE_PATTERN.exec(localDate);
  if (!match) {
    throw new RangeError(`not a local calendar day: ${localDate}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new RangeError(`not a real calendar day: ${localDate}`);
  }
  return date;
}

/** Formats a local Date as a bare "YYYY-MM-DD" device-local calendar day. */
export function localDateString(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * Converts an entered weight to the stored unit (kg), rounding to two
 * decimals at the input boundary. kg passes through untouched.
 */
export function toKg(value: number, unit: WeightUnit): number {
  if (unit === "kg") {
    return value;
  }
  return roundTo(value * KG_PER_LB, 2);
}

/**
 * Converts a stored kg weight into the display unit: exact for kg (capped
 * at two decimals to keep float noise out), one decimal for lb, which is
 * finer than any plate anyone loads.
 */
export function toDisplayWeight(kg: number, unit: WeightUnit): number {
  if (unit === "kg") {
    return roundTo(kg, 2);
  }
  return roundTo(kg / KG_PER_LB, 1);
}

/** "100 kg" / "220.5 lb": the figure with its unit, ready for a stat row. */
export function formatWeight(kg: number, unit: WeightUnit): string {
  return `${toDisplayWeight(kg, unit)} ${unit}`;
}

/**
 * One-decimal e1RM figure without a unit (the unit lives beside it as a
 * stat-unit). "n/a" when there is no working set to estimate from.
 */
export function formatE1rm(kg: number | undefined): string {
  if (kg === undefined || !Number.isFinite(kg)) {
    return "n/a";
  }
  return `${roundTo(kg, 1)}`;
}

/** "45 min" / "1 h" / "1 h 15 min"; "n/a" when the duration is unknown. */
export function formatDurationMin(min: number | null): string {
  if (min === null || !Number.isFinite(min)) {
    return "n/a";
  }
  const total = Math.max(0, Math.round(min));
  if (total < 60) {
    return `${total} min`;
  }
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (rest === 0) {
    return `${hours} h`;
  }
  return `${hours} h ${rest} min`;
}

/**
 * The heading above a logged day: "Today", "Yesterday", or the full day
 * ("Monday 12 Oct"). Plain formatting, never locale-dependent, so history
 * reads the same on every device.
 */
export function formatDayHeading(localDate: string, today: Date): string {
  const date = parseLocalDate(localDate);
  if (sameDay(date, today)) {
    return "Today";
  }
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (sameDay(date, yesterday)) {
    return "Yesterday";
  }
  const dayName = DAY_NAMES[(date.getDay() + 6) % 7] ?? "";
  const monthName = MONTHS_SHORT[date.getMonth()] ?? "";
  return `${dayName} ${date.getDate()} ${monthName}`;
}

/**
 * "09:30": an ISO timestamp as the device shows it (24-hour, local time).
 * Unparseable input reads "n/a" instead of leaking "Invalid Date".
 */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "n/a";
  }
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * "Today 09:30", "Yesterday 18:02", or "Monday 12 Oct 09:30": one stamp
 * for the last-synced readout. Null (never synced) reads "Never" and an
 * unparseable value reads "n/a", so the panel never shows Invalid Date.
 */
export function formatSyncStamp(iso: string | null, today: Date = new Date()): string {
  if (iso === null || iso.length === 0) {
    return "Never";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "n/a";
  }
  return `${formatDayHeading(localDateString(date), today)} ${formatTime(iso)}`;
}
