/** Navigation model: five bottom tabs on mobile, the full section list on desktop. */

export type NavItem = {
  label: string;
  href: string;
  /** Exact-match only (used for the dashboard root). */
  end?: boolean;
};

export const TABS: readonly NavItem[] = [
  { label: "Home", href: "/", end: true },
  { label: "Workout", href: "/workout" },
  { label: "History", href: "/history" },
  { label: "Body", href: "/body" },
  { label: "Social", href: "/social" },
];

export const SECTIONS: readonly NavItem[] = [
  { label: "Home", href: "/", end: true },
  { label: "Workout", href: "/workout" },
  { label: "History", href: "/history" },
  { label: "Activities", href: "/activities" },
  { label: "Body", href: "/body" },
  { label: "Social", href: "/social" },
];

export const TAB_ICONS: Record<string, "grid" | "dumbbell" | "log" | "body" | "users"> = {
  Home: "grid",
  Workout: "dumbbell",
  History: "log",
  Body: "body",
  Social: "users",
};
