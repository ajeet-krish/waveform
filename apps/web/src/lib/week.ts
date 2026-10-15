/** Monday-start week math: Waveform weeks and heatmap columns begin on Monday. */

export const DAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"] as const;

export const DAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

export type WeekDay = {
  dayOfMonth: number;
  iso: string;
  isToday: boolean;
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** True when two dates fall on the same calendar day. */
export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Returns the Monday of the week containing the given date. */
export function startOfWeekMonday(input: Date): Date {
  const date = new Date(input.getFullYear(), input.getMonth(), input.getDate());
  const weekday = date.getDay() || 7;
  date.setDate(date.getDate() - (weekday - 1));
  return date;
}

/** ISO 8601 week number (1 to 53) of the week containing the given date. */
export function isoWeek(input: Date): number {
  const date = new Date(Date.UTC(input.getFullYear(), input.getMonth(), input.getDate()));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const msPerDay = 86_400_000;
  return Math.ceil(((date.getTime() - yearStart.getTime()) / msPerDay + 1) / 7);
}

/** The seven days of the week containing `today`, Monday first. */
export function weekDays(today: Date): WeekDay[] {
  const start = startOfWeekMonday(today);
  const days: WeekDay[] = [];
  for (let index = 0; index < 7; index += 1) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    days.push({
      dayOfMonth: date.getDate(),
      iso: `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
      isToday: sameDay(date, today),
    });
  }
  return days;
}
