import type { ActivityType } from "../types/api";

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
