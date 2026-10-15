import { describe, expect, it } from "vitest";
import { isoWeek, sameDay, startOfWeekMonday, weekDays } from "./week";

describe("sameDay", () => {
  it("is true across times of one date and false across dates", () => {
    expect(sameDay(new Date(2026, 9, 14, 0, 5), new Date(2026, 9, 14, 23, 59))).toBe(true);
    expect(sameDay(new Date(2026, 9, 14, 23, 59), new Date(2026, 9, 15, 0, 1))).toBe(false);
  });
});

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

  it("formats ISO dates when the week spans two months", () => {
    // 2026-11-01 is a Sunday; its week runs 2026-10-26 to 2026-11-01.
    const days = weekDays(new Date(2026, 10, 1));
    expect(days[0]?.iso).toBe("2026-10-26");
    expect(days[6]?.iso).toBe("2026-11-01");
    expect(days[6]?.dayOfMonth).toBe(1);
    expect(days[6]?.isToday).toBe(true);
  });
});

describe("isoWeek year boundaries", () => {
  it("keeps late-December days in week 53 of years that have one", () => {
    // 2020 and 2026 both have 53 ISO weeks.
    expect(isoWeek(new Date(2020, 11, 28))).toBe(53);
    expect(isoWeek(new Date(2020, 11, 31))).toBe(53);
    expect(isoWeek(new Date(2026, 11, 31))).toBe(53);
    // 2021-01-01 (Friday) still belongs to 2020-W53.
    expect(isoWeek(new Date(2021, 0, 1))).toBe(53);
  });

  it("rolls a Tuesday year-end into week 1 when its Thursday says so", () => {
    // 2024-12-31 (Tuesday) sits in the week whose Thursday is 2025-01-02,
    // so ISO assigns it to 2025-W01.
    expect(isoWeek(new Date(2024, 11, 31))).toBe(1);
  });
});
