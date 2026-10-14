import { For } from "solid-js";
import { DAY_LETTERS, DAY_NAMES, isoWeek, weekDays } from "../lib/week";

/**
 * The signature element: the current week as seven day cells, Monday first,
 * with today ringed in live magenta. It echoes the heatmap at chrome scale so
 * consistency stays visible on every screen.
 */
export default function WeekStrip() {
  const today = new Date();
  const days = weekDays(today);
  const week = isoWeek(today);

  return (
    <section class="wk" aria-label="This week">
      <div class="wk-heading">
        <span class="label">This week</span>
        <span class="wk-weeknum num">W{week}</span>
      </div>
      <ol class="wk-days">
        <For each={days}>
          {(day, index) => (
            <li
              class="wk-cell"
              classList={{ "is-today": day.isToday }}
              aria-label={`${DAY_NAMES[index()]}, ${day.iso}, no effort logged`}
            >
              <span class="wk-day" aria-hidden="true">
                {DAY_LETTERS[index()]}
              </span>
              <span class="wk-date" aria-hidden="true">
                {day.dayOfMonth}
              </span>
            </li>
          )}
        </For>
      </ol>
      <span class="wk-readout">0 of 7 days active</span>
    </section>
  );
}
