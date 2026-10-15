import { createSignal, For } from "solid-js";
import EmptyState from "../components/EmptyState";
import Panel from "../components/Panel";

const WINDOWS = ["7 days", "4 weeks", "12 weeks"] as const;

const BOARDS = [
  {
    label: "Consistency",
    rule: "Active days in the window. Ties break on weekly streak: weeks with 3 or more active days.",
  },
  {
    label: "Lifting",
    rule: "Weekly volume in kg, best e1RM (Brzycki) per marquee lift, and e1RM relative to bodyweight.",
  },
  {
    label: "Cycling",
    rule: "Distance in km and elevation in m across the window.",
  },
  {
    label: "Climbing",
    rule: "V-points, the sum of 2^grade for every send, and hardest grade logged.",
  },
];

export default function Leaderboard() {
  const [range, setRange] = createSignal<(typeof WINDOWS)[number]>("7 days");

  return (
    <div class="stack">
      <div>
        <p class="label mt-3">Window</p>
        <div class="seg mt-3" role="group" aria-label="Leaderboard window">
          <For each={WINDOWS}>
            {(item) => (
              <button
                type="button"
                class="seg-btn"
                aria-pressed={range() === item}
                onClick={() => setRange(item)}
              >
                {item}
              </button>
            )}
          </For>
        </div>
      </div>

      <div class="panel-grid">
        <For each={BOARDS}>
          {(board) => (
            <Panel label={board.label} meta={`No entries in ${range()}`}>
              <p class="panel-note">{board.rule}</p>
            </Panel>
          )}
        </For>
      </div>

      <EmptyState
        title="The boards arrive with the backend"
        body="Ranks fill in as soon as anyone in your group finishes a session. Ties share a rank, so nobody loses a spot to a coin flip."
        actions={[{ label: "Log a session", href: "/workout" }]}
        note="Boards read from the server once it exists"
      />
    </div>
  );
}
