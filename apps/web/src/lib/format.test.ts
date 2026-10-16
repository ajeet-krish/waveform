import { describe, expect, it } from "vitest";
import {
  formatDayHeading,
  formatDurationMin,
  formatE1rm,
  formatSyncStamp,
  formatTime,
  formatWeight,
  localDateString,
  parseLocalDate,
  toDisplayWeight,
  toKg,
} from "./format";

describe("toKg", () => {
  it("rounds lb to two decimals at the input boundary and passes kg through", () => {
    expect(toKg(225, "lb")).toBe(102.06);
    expect(toKg(135, "lb")).toBe(61.23);
    expect(toKg(0, "lb")).toBe(0);
    expect(toKg(62.5, "kg")).toBe(62.5);
  });
});

describe("toDisplayWeight", () => {
  it("keeps kg exact to two decimals and rounds lb to one", () => {
    expect(toDisplayWeight(100, "kg")).toBe(100);
    expect(toDisplayWeight(62.5, "kg")).toBe(62.5);
    expect(toDisplayWeight(100, "lb")).toBe(220.5);
    expect(toDisplayWeight(0, "lb")).toBe(0);
  });

  it("round-trips through toKg within display precision", () => {
    expect(toDisplayWeight(toKg(225, "lb"), "lb")).toBe(225);
  });
});

describe("formatWeight", () => {
  it("labels the figure with the display unit", () => {
    expect(formatWeight(100, "kg")).toBe("100 kg");
    expect(formatWeight(62.5, "kg")).toBe("62.5 kg");
    expect(formatWeight(100, "lb")).toBe("220.5 lb");
    expect(formatWeight(0, "kg")).toBe("0 kg");
  });
});

describe("formatE1rm", () => {
  it("renders one decimal and falls back to n/a without a working set", () => {
    expect(formatE1rm(112.51129402114975)).toBe("112.5");
    expect(formatE1rm(100)).toBe("100");
    expect(formatE1rm(undefined)).toBe("n/a");
    expect(formatE1rm(Number.NaN)).toBe("n/a");
  });
});

describe("formatDurationMin", () => {
  it("formats minutes and hours without a locale", () => {
    expect(formatDurationMin(null)).toBe("n/a");
    expect(formatDurationMin(0)).toBe("0 min");
    expect(formatDurationMin(45)).toBe("45 min");
    expect(formatDurationMin(60)).toBe("1 h");
    expect(formatDurationMin(75)).toBe("1 h 15 min");
    expect(formatDurationMin(1440)).toBe("24 h");
  });

  it("clamps negative durations to zero instead of printing below zero", () => {
    expect(formatDurationMin(-10)).toBe("0 min");
  });
});

describe("formatDayHeading", () => {
  const today = new Date(2026, 9, 14, 15, 30);

  it("reads today and yesterday relative to the given day", () => {
    expect(formatDayHeading("2026-10-14", today)).toBe("Today");
    expect(formatDayHeading("2026-10-13", today)).toBe("Yesterday");
  });

  it("spells out older days as weekday, day, and short month", () => {
    expect(formatDayHeading("2026-10-12", today)).toBe("Monday 12 Oct");
    expect(formatDayHeading("2026-10-18", today)).toBe("Sunday 18 Oct");
    expect(formatDayHeading("2026-01-01", new Date(2026, 0, 3))).toBe("Thursday 1 Jan");
  });

  it("does not treat tomorrow as today", () => {
    expect(formatDayHeading("2026-10-15", today)).toBe("Thursday 15 Oct");
  });
});

describe("formatTime", () => {
  it("renders the device-local time of an ISO timestamp", () => {
    const iso = "2026-10-14T09:30:00.000Z";
    const date = new Date(iso);
    const pad = (value: number) => String(value).padStart(2, "0");
    expect(formatTime(iso)).toBe(`${pad(date.getHours())}:${pad(date.getMinutes())}`);
  });

  it("reads unparseable input as n/a", () => {
    expect(formatTime("not-a-timestamp")).toBe("n/a");
  });
});

describe("formatSyncStamp", () => {
  const today = new Date(2026, 9, 14, 15, 30);

  it("reads never-synced and unparseable stamps without leaking Invalid Date", () => {
    expect(formatSyncStamp(null)).toBe("Never");
    expect(formatSyncStamp("")).toBe("Never");
    expect(formatSyncStamp("not-a-timestamp")).toBe("n/a");
  });

  it("joins the day heading with the device-local time", () => {
    const now = new Date(2026, 9, 14, 9, 30).toISOString();
    const yesterday = new Date(2026, 9, 13, 18, 2).toISOString();
    expect(formatSyncStamp(now, today)).toBe("Today 09:30");
    expect(formatSyncStamp(yesterday, today)).toBe("Yesterday 18:02");
  });
});

describe("local calendar days", () => {
  it("parses bare days as local dates and formats them back", () => {
    const date = parseLocalDate("2026-10-14");
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(9);
    expect(date.getDate()).toBe(14);
    expect(localDateString(date)).toBe("2026-10-14");
    expect(localDateString(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("rejects malformed and impossible days", () => {
    expect(() => parseLocalDate("14/10/2026")).toThrow(RangeError);
    expect(() => parseLocalDate("2026-10-14T00:00:00Z")).toThrow(RangeError);
    expect(() => parseLocalDate("2026-02-30")).toThrow(RangeError);
  });
});
