import type { JSX } from "solid-js";

export type IconName = "grid" | "dumbbell" | "log" | "body" | "users" | "user";

const PATHS: Record<IconName, () => JSX.Element> = {
  grid: () => (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </>
  ),
  dumbbell: () => (
    <>
      <path d="M7 9.5v5M4 10.5v3M17 9.5v5M20 10.5v3M7.5 12h9" />
    </>
  ),
  log: () => (
    <>
      <path d="M4 6h16M4 12h16M4 18h10" />
    </>
  ),
  body: () => (
    <>
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5.5 19.5c1.5-3.3 3.9-5 6.5-5s5 1.7 6.5 5" />
    </>
  ),
  users: () => (
    <>
      <circle cx="9" cy="9" r="3" />
      <path d="M3.5 19c1.2-2.9 3.2-4.4 5.5-4.4s4.3 1.5 5.5 4.4" />
      <path d="M15.6 6.5a3 3 0 0 1 0 5.8M17.4 14.9c1.7.8 2.8 2.1 3.4 4" />
    </>
  ),
  user: () => (
    <>
      <circle cx="12" cy="8.5" r="3.4" />
      <path d="M5.5 20c1.5-3.4 3.9-5.1 6.5-5.1s5 1.7 6.5 5.1" />
    </>
  ),
};

export default function Icon(props: { name: IconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {PATHS[props.name]()}
    </svg>
  );
}
