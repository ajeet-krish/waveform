import { A } from "@solidjs/router";
import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { createLocalQuery } from "../db/query";
import type { Repos } from "../db";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import Panel from "../components/Panel";
import { useAppData } from "../lib/appData";
import { exerciseNameMap } from "../lib/catalog";
import { errorMessage } from "../lib/errors";
import {
  formatDurationMin,
  formatE1rm,
  formatTime,
  formatWeight,
  type WeightUnit,
} from "../lib/format";
import { groupSessionsByWeek, type SessionSummary } from "../lib/history";
import { createToday } from "../lib/today";

const SEGMENTS = ["Workouts", "Activities"] as const;

type Segment = (typeof SEGMENTS)[number];

/**
 * The log: workouts grouped into Monday-start weeks with day headings,
 * next to the activities segment that lands in a later phase.
 */
export default function History(): JSX.Element {
  const app = useAppData();
  const [segment, setSegment] = createSignal<Segment>("Workouts");

  const unit = (): WeightUnit =>
    app.profile()?.settings.display_weight_unit ?? "kg";

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

      <Show
        when={segment() === "Workouts"}
        fallback={
          <div class="stack">
            <ActivitiesPlaceholder />
          </div>
        }
      >
        <Show
          when={app.repos()}
          fallback={<p class="panel-note">Opening your log...</p>}
        >
          {(repos) => <WorkoutsView repos={repos()} unit={unit()} />}
        </Show>
      </Show>
    </div>
  );
}

function WorkoutsView(props: { repos: Repos; unit: WeightUnit }): JSX.Element {
  const today = createToday();
  const trees = createLocalQuery(() => props.repos.workouts.listAllTrees());
  const exercises = createLocalQuery(() => props.repos.exercises.listLive());
  const names = createMemo(() => exerciseNameMap(exercises.latest() ?? []));
  const weeks = createMemo(() =>
    groupSessionsByWeek(trees.latest() ?? [], names(), today()),
  );

  return (
    <div class="stack">
      <Show when={trees.error()}>
        <p class="form-status" role="alert">
          {errorMessage(trees.error(), "Your log could not be read.")}
        </p>
      </Show>

      <Show
        when={!trees.loading()}
        fallback={<p class="panel-note">Loading your log...</p>}
      >
        <Show
          when={(trees.latest() ?? []).length > 0}
          fallback={
            <EmptyState
              title="Your log is empty"
              body="Finished sessions land here with sets, weights in kg, reps, and e1RM (Brzycki), grouped by the day they happened."
              actions={[{ label: "Log your first session", href: "/workout" }]}
              note="Coming from the v1 app? The import wizard reads your JSON backup"
            />
          }
        >
          <div class="stack">
            <For each={weeks()}>
              {(week) => (
                <Panel
                  label={`Week ${week.weekNumber}`}
                  meta={`${week.weekStart} to ${week.weekEnd}`}
                >
                  <div class="stack">
                    <For each={week.days}>
                      {(day) => (
                        <section>
                          <h3 class="label">{day.heading}</h3>
                          <div class="discipline-grid">
                            <For each={day.sessions}>
                              {(session) => (
                                <SessionRow session={session} unit={props.unit} />
                              )}
                            </For>
                          </div>
                        </section>
                      )}
                    </For>
                  </div>
                </Panel>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}

/** One finished session as a card: when it started, what it cost. */
function SessionRow(props: { session: SessionSummary; unit: WeightUnit }): JSX.Element {
  const session = () => props.session;
  const started = (): string => {
    const at = session().startedAt;
    return at ? formatTime(at) : "n/a";
  };
  const top = (): string => {
    const best = session().topE1rmKg;
    return best === undefined ? "n/a" : `${formatE1rm(best)} ${props.unit}`;
  };
  return (
    <A class="discipline" href={`/history/${session().id}`}>
      <p class="discipline-name">{started()}</p>
      <p class="discipline-blurb">
        {[
          formatDurationMin(session().durationMin),
          `${session().exerciseCount} exercises`,
          `${session().setCount} sets`,
          formatWeight(session().volumeKg, props.unit),
        ].join(" · ")}
      </p>
      <p class="discipline-metric label">{`Top e1RM (Brzycki): ${top()}`}</p>
    </A>
  );
}

/** Activities sit next to workouts in the log; the forms arrive in phase 2. */
function ActivitiesPlaceholder(): JSX.Element {
  return (
    <div class="stack">
      <EmptyState
        title="No rides or climbs logged"
        body="Activities sit next to your workouts in the log: distance and elevation for rides, grades sent and V-points for climbs."
        actions={[
          { label: "Log a ride", href: "/activities/cycling" },
          { label: "Log a climb", href: "/activities/climbing", variant: "secondary" },
        ]}
      />
      <p class="panel-note">Running, hikes, and swims log through the same form.</p>
      <A class="link" href="/activities">
        See all activities
      </A>
    </div>
  );
}
