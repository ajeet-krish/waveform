import type { Activity, ActivityType } from "../types/api";
import type { Discipline } from "@waveform/scoring";
import type { LocalRow } from "../db/types";
import { vPointsForSends } from "./climbing";

/**
 * Discipline cards. The union covers every row the schema accepts
 * (activities.type); all five disciplines now earn their own pages.
 */
export type DisciplineCard = {
  type: ActivityType;
  label: string;
  href?: string;
  blurb: string;
  metric: string;
  pending?: boolean;
};

export const DISCIPLINES: readonly DisciplineCard[] = [
  {
    type: "cycling",
    label: "Cycling",
    href: "/activities/cycling",
    blurb: "Distance, elevation, and time in the saddle.",
    metric: "Weekly distance and elevation feed the cycling board.",
  },
  {
    type: "climbing",
    label: "Climbing",
    href: "/activities/climbing",
    blurb: "Grades sent, hardest send, and V-points.",
    metric: "V-points sum 2^grade, so the hard sends count most.",
  },
  {
    type: "running",
    label: "Running",
    href: "/activities/running",
    blurb: "Distance, duration, and pace.",
    metric: "Runs count toward consistency and daily Effort Points.",
  },
  {
    type: "hike",
    label: "Hike",
    href: "/activities/hike",
    blurb: "Distance, elevation, and time on foot.",
    metric: "Hikes count toward consistency and daily Effort Points.",
  },
  {
    type: "swim",
    label: "Swim",
    href: "/activities/swim",
    blurb: "Distance, duration, and pace in the water.",
    metric: "Swims count toward consistency and daily Effort Points.",
  },
];

/**
 * The Effort Points discipline an activity type scores under. Lifting
 * sessions are not activities and map to "strength" at their own call
 * sites, so this covers the five schema activity types only.
 */
const DISCIPLINE_BY_ACTIVITY_TYPE: Readonly<Record<ActivityType, Discipline>> = {
  climbing: "climbing",
  cycling: "cycling",
  running: "run",
  hike: "hike",
  swim: "swim",
};

/** The Effort Points discipline an activity type scores under. */
export function disciplineForActivityType(type: ActivityType): Discipline {
  return DISCIPLINE_BY_ACTIVITY_TYPE[type];
}

/**
 * An activity row paired with its device-local send histogram. Cycling,
 * running, hike, and swim rows carry no `sends`; climbing rows carry the
 * 17-slot histogram the climb_sends store holds.
 */
export type DisciplineActivity = LocalRow<Activity> & {
  /** Send histogram indexed by integer V grade; absent for non-climbing. */
  sends?: readonly number[];
};

export type DisciplineSummary = {
  type: ActivityType;
  /** Number of activities of this type in the window. */
  count: number;
  /** Total distance in km; meaningful for cycling, running, hike, and swim. */
  totalKm: number;
  /** Total V-points; meaningful for climbing only. */
  totalVPoints: number;
};

/** Activity types whose 30-day summary is judged by distance in km. */
const DISTANCE_TYPES: readonly ActivityType[] = ["cycling", "running", "hike", "swim"];

/**
 * Summarizes one discipline across a [from, to] local_date window (both
 * inclusive) for the overview strip. Climbing totals V-points by summing
 * vPointsForSends over each activity's histogram, so hard sends count
 * most; cycling, running, hike, and swim total distance in km.
 * Non-matching types, tombstones, and out-of-window rows are skipped.
 */
export function summarizeDiscipline(
  type: ActivityType,
  activities: readonly DisciplineActivity[],
  from: string,
  to: string,
): DisciplineSummary {
  let count = 0;
  let totalKm = 0;
  let totalVPoints = 0;
  for (const activity of activities) {
    if (activity.type !== type || activity.deleted_at !== null) {
      continue;
    }
    if (activity.local_date < from || activity.local_date > to) {
      continue;
    }
    count += 1;
    if (
      DISTANCE_TYPES.includes(type) &&
      activity.distance_km !== null &&
      Number.isFinite(activity.distance_km)
    ) {
      totalKm += activity.distance_km;
    }
    if (type === "climbing" && activity.sends !== undefined) {
      totalVPoints += vPointsForSends(activity.sends);
    }
  }
  return { type, count, totalKm, totalVPoints };
}
