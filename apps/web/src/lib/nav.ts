/** Navigation model: six bottom tabs on mobile, the full section list on desktop. */

import type { IconName } from "../components/Icon";

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
  { label: "Exercises", href: "/exercises" },
  { label: "Body", href: "/body" },
  { label: "Social", href: "/social" },
];

export const SECTIONS: readonly NavItem[] = [
  { label: "Home", href: "/", end: true },
  { label: "Workout", href: "/workout" },
  { label: "History", href: "/history" },
  { label: "Exercises", href: "/exercises" },
  { label: "Activities", href: "/activities" },
  { label: "Body", href: "/body" },
  { label: "Social", href: "/social" },
];

export const TAB_ICONS: Record<string, IconName> = {
  Home: "grid",
  Workout: "dumbbell",
  History: "log",
  Exercises: "catalog",
  Body: "body",
  Social: "users",
};

/**
 * Whether a nav item should read as the current page. Sections with children
 * (Social on /social/heatmap) match by prefix; items marked `end` stay exact.
 */
export function isActivePath(item: NavItem, pathname: string): boolean {
  if (item.end) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
