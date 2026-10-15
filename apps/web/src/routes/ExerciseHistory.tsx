import { useParams } from "@solidjs/router";
import { createMemo, For, Show, type JSX } from "solid-js";
import type { Exercise } from "@waveform/api-types";
import { createLocalQuery } from "../db/query";
import type { Repos } from "../db";
import type { LocalRow } from "../db/types";
import type { WorkoutTree } from "../db/repos/workouts";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import Panel from "../components/Panel";
import Sparkline from "../components/Sparkline";
import { useAppData } from "../lib/appData";
import { exerciseSetRows } from "../lib/exerciseDetail";
import { errorMessage } from "../lib/errors";
import {
  formatDayHeading,
  formatE1rm,
  formatWeight,
  type WeightUnit,
} from "../lib/format";
import { bestE1rmByDay } from "../lib/exerciseStats";
import { createToday } from "../lib/today";
import type { SparkDay } from "../lib/sparkline";

/**
 * One exercise's history: the trend of best e1RM per day as a
 * sparkline, then every set underneath it, newest first. Working sets
 * drive the chart; the table keeps warmups marked W so a session reads
 * exactly as it happened.
 */
export default function ExerciseHistory(): JSX.Element {
  const app = useAppData();
  const params = useParams();
  const unit = (): WeightUnit =>
    app.profile()?.settings.display_weight_unit ?? "kg";
  return (
    <div class="page">
      <Show
        when={app.repos()}
        fallback={<p class="panel-note">Opening your log...</p>}
      >
        {(repos) => (
          <Show when={params.id} keyed fallback={<ExerciseNotFound />}>
            {(id) => <ExerciseView repos={repos()} id={id} unit={unit()} />}
          </Show>
        )}
      </Show>
    </div>
  );
}

function ExerciseNotFound(): JSX.Element {
  return (
    <div class="stack">
      <PageHeader path="Training / Exercises" title="Exercises" />
      <EmptyState
        title="Exercise not found"
        body="This exercise is not in the local catalog. It may have been deleted from this device."
        actions={[{ label: "Back to exercises", href: "/exercises" }]}
      />
    </div>
  );
}

function ExerciseView(props: { repos: Repos; id: string; unit: WeightUnit }): JSX.Element {
  const today = createToday();
  const exercise = createLocalQuery(() => props.repos.exercises.get(props.id));
  const trees = createLocalQuery(() => props.repos.workouts.listAllTrees());

  return (
    <div class="stack">
      <Show when={exercise.error() || trees.error()}>
        <p class="form-status" role="alert">
          {errorMessage(exercise.error() ?? trees.error(), "This history could not be read.")}
        </p>
      </Show>

      <Show
        when={!exercise.loading() && !trees.loading()}
        fallback={<p class="panel-note">Opening your log...</p>}
      >
        <Show when={exercise.latest()} fallback={<ExerciseNotFound />}>
          {(row) => (
            <ExerciseBody
              row={row()}
              trees={trees.latest() ?? []}
              unit={props.unit}
              today={today()}
            />
          )}
        </Show>
      </Show>
    </div>
  );
}

function ExerciseBody(props: {
  row: LocalRow<Exercise>;
  trees: WorkoutTree[];
  unit: WeightUnit;
  today: Date;
}): JSX.Element {
  const exercise = () => props.row;
  const setRows = createMemo(() => exerciseSetRows(props.trees, exercise().id));
  const dayPoints = createMemo<SparkDay[]>(() => {
    const best = bestE1rmByDay(props.trees, exercise().id);
    return [...best.entries()]
      .map(([day, value]) => ({ day, value }))
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  });
  const lede = (): string =>
    [exercise().muscle_group, exercise().equipment ?? "no equipment"].join(" · ");

  return (
    <div class="stack">
      <PageHeader
        path="Training / Exercises"
        title={exercise().name}
        lede={lede()}
      />

      <Show
        when={setRows().length > 0}
        fallback={
          <EmptyState
            title="No sets logged yet"
            body="Sets you log for this exercise land here with weight, reps, and e1RM (Brzycki), newest first."
            actions={[{ label: "Log this exercise", href: "/workout" }]}
            note="Working sets feed the chart; warmups stay in the table"
          />
        }
      >
        <Panel
          label="Best e1RM (Brzycki) by day"
          meta={`${dayPoints().length} days on the chart`}
        >
          <Show
            when={dayPoints().length > 0}
            fallback={
              <p class="panel-note">
                No loaded working sets yet, so there is nothing to chart. Warmups and
                bodyweight work still appear in the table below.
              </p>
            }
          >
            <Sparkline points={dayPoints()} unit={props.unit} today={props.today} />
          </Show>
        </Panel>

        <Panel label="Sets" meta={`${setRows().length} logged`}>
          <div class="table-wrap">
            <table class="data-table">
              <caption class="sr-only">
                {`Sets for ${exercise().name}: date, weight in ${props.unit}, reps, warmup marks, and e1RM (Brzycki), newest first.`}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">{`Weight (${props.unit})`}</th>
                  <th scope="col">Reps</th>
                  <th scope="col">Warmup</th>
                  <th scope="col">e1RM (Brzycki)</th>
                </tr>
              </thead>
              <tbody>
                <For each={setRows()}>
                  {(set) => (
                    <tr>
                      <td>{formatDayHeading(set.localDate, props.today)}</td>
                      <td>{formatWeight(set.weightKg, props.unit)}</td>
                      <td>{set.reps}</td>
                      <td>
                        {set.isWarmup ? (
                          <span class="badge">
                            W<span class="sr-only"> warmup</span>
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <span class="num">{formatE1rm(set.e1rmKg)}</span>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Panel>
      </Show>
    </div>
  );
}
