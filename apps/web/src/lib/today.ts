import { createSignal, onCleanup, type Accessor } from "solid-js";
import { sameDay } from "./week";

/**
 * "Today" as a live signal. A long-open session must still roll over at
 * midnight and across week boundaries, so the clock is re-read whenever the
 * tab becomes visible again and once a minute as a backstop. The signal keeps
 * its identity while the calendar day is unchanged, so derived view models
 * only recompute on a real rollover.
 */
export function createToday(): Accessor<Date> {
  const [today, setToday] = createSignal(new Date());

  const refresh = () => {
    const now = new Date();
    setToday((previous) => (sameDay(previous, now) ? previous : now));
  };

  const refreshIfVisible = () => {
    if (document.visibilityState === "visible") refresh();
  };

  document.addEventListener("visibilitychange", refreshIfVisible);
  const timer = setInterval(refresh, 60_000);

  onCleanup(() => {
    document.removeEventListener("visibilitychange", refreshIfVisible);
    clearInterval(timer);
  });

  return today;
}
