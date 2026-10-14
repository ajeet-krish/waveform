import { describe, expect, it } from "vitest";
import { isoWeek, startOfWeekMonday, weekDays } from "./week";

describe("isoWeek", () => {
  it("numbers weeks the ISO way, with Monday as the first day", () => {
    expect(isoWeek(new Date(2026, 0, 1))).toBe(1);
    expect(isoWeek(new Date(2026, 9, 14))).toBe(42);
    expect(isoWeek(new Date(2025, 11, 29))).toBe(1);
  });
});

describe("startOfWeekMonday", () => {
  it("walks any day back to its Monday", () => {
    expect(startOfWeekMonday(new Date(2026, 9, 14)).getDate()).toBe(12);
    expect(startOfWeekMonday(new Date(2026, 9, 12)).getDate()).toBe(12);
    expect(startOfWeekMonday(new Date(2026, 9, 18)).getDate()).toBe(12);
  });
});

describe("weekDays", () => {
  it("returns seven Monday-first days and flags today", () => {
    const days = weekDays(new Date(2026, 9, 14));
    expect(days).toHaveLength(7);
    expect(days[0]?.iso).toBe("2026-10-12");
    expect(days[6]?.iso).toBe("2026-10-18");
    expect(days.filter((day) => day.isToday)).toHaveLength(1);
    expect(days[2]?.isToday).toBe(true);
  });
});
