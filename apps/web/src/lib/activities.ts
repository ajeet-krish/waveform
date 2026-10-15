import type { Activity, ActivityType } from "../types/api";
import type { LocalRow } from "../db/types";
import { vPointsForSends } from "./climbing";

/**
 * Discipline cards. The union covers every row the schema accepts
 * (activities.type); only cycling and climbing earn their own pages first.
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
    blurb: "Distance and duration.",
    metric: "Runs count toward consistency and daily Effort Points.",
    pending: true,
  },
  {
    type: "hike",
    label: "Hike",
    blurb: "Distance and elevation on foot.",
    metric: "Hikes count toward consistency and daily Effort Points.",
    pending: true,
  },
  {
    type: "swim",
    label: "Swim",
    blurb: "Distance and duration in the water.",
    metric: "Swims count toward consistency and daily Effort Points.",
    pending: true,
  },
];

/**
 * An activity row paired with its device-local send histogram. Cycling
 * (and later running/hike/swim) rows carry no `sends`; climbing rows
 * carry the 17-slot histogram the climb_sends store holds.
 */
export type DisciplineActivity = LocalRow<Activity> & {
  /** Send histogram indexed by integer V grade; absent for non-climbing. */
  sends?: readonly number[];
};

export type DisciplineSummary = {
  type: ActivityType;
  /** Number of activities of this type in the window. */
  count: number;
  /** Total distance in km; meaningful for cycling (and later run/hike/swim). */
  totalKm: number;
  /** Total V-points; meaningful for climbing only. */
  totalVPoints: number;
};

/**
 * Summarizes one discipline across a [from, to] local_date window (both
 * inclusive) for the overview strip. Climbing totals V-points by summing
 * vPointsForSends over each activity's histogram, so hard sends count
 * most; cycling totals distance in km. Non-matching types, tombstones,
 * and out-of-window rows are skipped.
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
    if (type === "cycling" && activity.distance_km !== null && Number.isFinite(activity.distance_km)) {
      totalKm += activity.distance_km;
    }
    if (type === "climbing" && activity.sends !== undefined) {
      totalVPoints += vPointsForSends(activity.sends);
    }
  }
  return { type, count, totalKm, totalVPoints };
}
