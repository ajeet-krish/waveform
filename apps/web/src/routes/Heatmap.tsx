import { createMemo, For } from "solid-js";
import EmptyState from "../components/EmptyState";
import { HEAT_LEVEL_RANGES } from "../lib/heat";
import { createToday } from "../lib/today";
import { startOfWeekMonday } from "../lib/week";

const WEEK_COLUMNS = 53;
const WEEKDAY_ROWS = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAY_LABELS: Record<number, string> = { 0: "Mon", 2: "Wed", 4: "Fri" };

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Weeks counted back from the current week; 0 is this week, 52 is a year ago. */
function weeksBack(today: Date, back: number): Date[] {
  const thisMonday = startOfWeekMonday(today);
  return WEEKDAY_ROWS.map(
    (row) =>
      new Date(
        thisMonday.getFullYear(),
        thisMonday.getMonth(),
        thisMonday.getDate() - back * 7 + row,
      ),
  );
}

const isAfter = (date: Date, today: Date) => date.getTime() > today.getTime();

export default function Heatmap() {
  const today = createToday();
  const columns = Array.from({ length: WEEK_COLUMNS }, (_, back) => WEEK_COLUMNS - 1 - back);

  /** Day cells per week column, recomputed when the signal date rolls over. */
  const weeks = createMemo(() => {
    const now = today();
    return columns.map((back) =>
      weeksBack(now, back).map((date) => ({ future: isAfter(date, now) })),
    );
  });

  const monthLabels = createMemo(() => {
    const now = today();
    let lastMonth = -1;
    return columns.map((back) => {
      const monday = weeksBack(now, back)[0] as Date;
      const month = monday.getMonth();
      const label = month !== lastMonth ? (MONTHS[month] ?? "") : "";
      lastMonth = month;
      return label;
    });
  });

  return (
    <div class="stack">
      <div>
        <p class="label">The effort grid</p>
        <div class="heat-calendar">
          <div class="heat-weekdays" aria-hidden="true">
            <For each={WEEKDAY_ROWS}>{(row) => <span>{WEEKDAY_LABELS[row] ?? ""}</span>}</For>
          </div>
          <div
            class="heat-scrollwrap"
            tabindex="0"
            role="group"
            aria-label="Effort grid, scroll sideways for older weeks"
          >
            <div
              role="img"
              aria-label="Effort grid: 53 weeks of training days. Nothing logged yet."
            >
              <div class="heat-months" aria-hidden="true">
                <For each={monthLabels()}>{(label) => <span>{label}</span>}</For>
              </div>
              <div class="heat-grid">
                <For each={weeks()}>
                  {(cells) => (
                    <For each={WEEKDAY_ROWS}>
                      {(row) => (
                        <span
                          class="heat-cell"
                          classList={{ "is-future": cells[row]?.future ?? false }}
                          data-level={0}
                        />
                      )}
                    </For>
                  )}
                </For>
              </div>
            </div>
          </div>
        </div>
        <ul class="heat-legend mt-3">
          <li class="legend-item">Less</li>
          <For each={HEAT_LEVEL_RANGES}>
            {(range) => (
              <li class="legend-item">
                <span class="heat-swatch" data-level={range.level} />
                {range.label}
              </li>
            )}
          </For>
          <li class="legend-item">More</li>
        </ul>
        <p class="panel-note mt-4">
          One square per day, weeks starting Monday. Levels track Effort Points: minutes times
          intensity (lift 1.0, climb 1.1, ride 0.9), plus bounded bonuses for PRs, sends, and
          elevation, capped at 100 a day.
        </p>
      </div>

      <EmptyState
        title="Your grid starts with your first session"
        body="Log a workout, ride, or climb and today's square lights up. Streaks are visible from the second active day on."
        actions={[{ label: "Log a session", href: "/workout" }]}
      />
    </div>
  );
}
