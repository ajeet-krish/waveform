import { createSignal, For } from "solid-js";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import { A } from "@solidjs/router";

const SEGMENTS = ["Workouts", "Activities"] as const;

type Segment = (typeof SEGMENTS)[number];

export default function History() {
  const [segment, setSegment] = createSignal<Segment>("Workouts");

  return (
    <div class="page">
      <PageHeader
        path="Training / History"
        title="History"
        lede="Every finished session, grouped by the day it happened. Weeks start on Monday."
      />

      <div class="seg" role="group" aria-label="History view">
        <For each={SEGMENTS}>
          {(item) => (
            <button
              type="button"
              class="seg-btn"
              aria-pressed={segment() === item}
              onClick={() => setSegment(item)}
            >
              {item}
            </button>
          )}
        </For>
      </div>

      {segment() === "Workouts" ? (
        <EmptyState
          title="Your log is empty"
          body="Finished sessions land here with sets, weights in kg, reps, and e1RM (Brzycki), grouped by the day they happened."
          actions={[{ label: "Log your first session", href: "/workout" }]}
          note="Coming from the v1 app? The import wizard reads your JSON backup"
        />
      ) : (
        <div class="stack">
          <EmptyState
            title="No rides or climbs logged"
            body="Activities sit next to your workouts in the log: distance and elevation for rides, grades sent and V-points for climbs."
            actions={[
              { label: "Log a ride", href: "/activities/cycling" },
              { label: "Log a climb", href: "/activities/climbing", variant: "secondary" },
            ]}
          />
          <p class="panel-note">
            Running, hikes, and swims log through the same form.
          </p>
          <A class="link" href="/activities">
            See all activities
          </A>
        </div>
      )}
    </div>
  );
}
