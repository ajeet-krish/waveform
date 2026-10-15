/**
 * History view models: one flat summary per session, grouped into
 * Monday-start week sections with day headings. Week math comes from
 * week.ts, so the grouping matches the WeekStrip and the heatmap.
 */

import type { WorkoutTree } from "../db/repos/workouts";
import { formatDayHeading, localDateString, parseLocalDate } from "./format";
import { bestE1rm, type WorkingSetLike } from "./workoutLog";
import { isoWeek, startOfWeekMonday } from "./week";

/** exercise_id to display name, as built from the live exercise list. */
export type ExerciseNameMap = ReadonlyMap<string, string>;

export type SessionSummary = {
  id: string;
  localDate: string;
  startedAt: string | null;
  durationMin: number | null;
  exerciseCount: number;
  setCount: number;
  /** Working-set tonnage; warmups do not count. */
  volumeKg: number;
  /** Top Brzycki estimate across the session; absent without a loaded set. */
  topE1rmKg?: number;
  exerciseNames: string[];
  notes: string | null;
};

export type HistoryDay = {
  /** "Today", "Yesterday", or "Monday 12 Oct". */
  heading: string;
  localDate: string;
  sessions: SessionSummary[];
};

export type HistoryWeek = {
  /** Monday of the section, "YYYY-MM-DD". */
  weekStart: string;
  /** Sunday of the section, "YYYY-MM-DD". */
  weekEnd: string;
  weekNumber: number;
  days: HistoryDay[];
};

/** Flattens one workout tree into the row history renders. */
export function summarizeSession(tree: WorkoutTree, names: ExerciseNameMap): SessionSummary {
  let setCount = 0;
  let volumeKg = 0;
  const working: WorkingSetLike[] = [];
  const exerciseNames: string[] = [];

  for (const slot of tree.entries) {
    exerciseNames.push(names.get(slot.entry.exercise_id) ?? "Unknown exercise");
    for (const set of slot.sets) {
      setCount += 1;
      if (set.is_warmup || !Number.isFinite(set.weight_kg) || !Number.isFinite(set.reps)) {
        continue;
      }
      if (set.reps >= 1) {
        volumeKg += set.weight_kg * set.reps;
        working.push(set);
      }
    }
  }

  const summary: SessionSummary = {
    id: tree.session.id,
    localDate: tree.session.local_date,
    startedAt: tree.session.started_at,
    durationMin: tree.session.duration_min,
    exerciseCount: tree.entries.length,
    setCount,
    volumeKg,
    exerciseNames,
    notes: tree.session.notes,
  };
  const top = bestE1rm(working);
  if (top !== undefined) {
    summary.topE1rmKg = top;
  }
  return summary;
}

/**
 * Groups sessions into Monday-start weeks, newest week first, newest day
 * first inside a week. Days carry a heading relative to `today`, so a long
 * open session re-reads "Today" correctly after midnight.
 */
export function groupSessionsByWeek(
  trees: readonly WorkoutTree[],
  names: ExerciseNameMap,
  today: Date,
): HistoryWeek[] {
  const weeks = new Map<string, { monday: Date; days: Map<string, SessionSummary[]> }>();

  for (const tree of trees) {
    const summary = summarizeSession(tree, names);
    const monday = startOfWeekMonday(parseLocalDate(summary.localDate));
    const weekKey = localDateString(monday);
    let week = weeks.get(weekKey);
    if (!week) {
      week = { monday, days: new Map() };
      weeks.set(weekKey, week);
    }
    const day = week.days.get(summary.localDate);
    if (day) {
      day.push(summary);
    } else {
      week.days.set(summary.localDate, [summary]);
    }
  }

  const sections: HistoryWeek[] = [];
  for (const week of weeks.values()) {
    const dayKeys = [...week.days.keys()].sort().reverse();
    const days: HistoryDay[] = dayKeys.map((localDate) => ({
      heading: formatDayHeading(localDate, today),
      localDate,
      sessions: week.days.get(localDate) ?? [],
    }));
    const weekEnd = new Date(
      week.monday.getFullYear(),
      week.monday.getMonth(),
      week.monday.getDate() + 6,
    );
    sections.push({
      weekStart: localDateString(week.monday),
      weekEnd: localDateString(weekEnd),
      weekNumber: isoWeek(week.monday),
      days,
    });
  }

  sections.sort((a, b) => (a.weekStart < b.weekStart ? 1 : a.weekStart > b.weekStart ? -1 : 0));
  return sections;
}
