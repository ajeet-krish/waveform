import { useNavigate, useParams } from "@solidjs/router";
import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { createLocalQuery } from "../db/query";
import type { Repos } from "../db";
import type { WorkoutTree } from "../db/repos/workouts";
import ConfirmDialog from "../components/ConfirmDialog";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import Panel from "../components/Panel";
import { useAppData } from "../lib/appData";
import { exerciseNameMap } from "../lib/catalog";
import { errorMessage } from "../lib/errors";
import {
  formatDayHeading,
  formatDurationMin,
  formatE1rm,
  formatTime,
  formatWeight,
  type WeightUnit,
} from "../lib/format";
import { summarizeSession } from "../lib/history";
import { routineProvenance } from "../lib/routines";
import { bestE1rm } from "../lib/workoutLog";
import { createToday } from "../lib/today";

/**
 * One finished session, read back from the log: day heading, totals,
 * and every exercise with its sets, warmups marked W and each e1RM
 * (Brzycki) in place. Deleting tombstones the session and its rows, then
 * sends the reader back to history.
 */
export default function HistoryDetail(): JSX.Element {
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
          <Show when={params.id} keyed fallback={<SessionNotFound />}>
            {(id) => <SessionView repos={repos()} id={id} unit={unit()} />}
          </Show>
        )}
      </Show>
    </div>
  );
}

function SessionNotFound(): JSX.Element {
  return (
    <div class="stack">
      <PageHeader path="Training / History" title="History" />
      <EmptyState
        title="Session not found"
        body="This session is not in the local log. It may have been deleted from this device."
        actions={[{ label: "Back to history", href: "/history" }]}
      />
    </div>
  );
}

function SessionView(props: { repos: Repos; id: string; unit: WeightUnit }): JSX.Element {
  const today = createToday();
  const tree = createLocalQuery(() => props.repos.workouts.getTree(props.id));
  const exercises = createLocalQuery(() => props.repos.exercises.listLive());
  const names = createMemo(() => exerciseNameMap(exercises.latest() ?? []));
  const exerciseName = (exerciseId: string): string =>
    names().get(exerciseId) ?? "Unknown exercise";

  return (
    <div class="stack">
      <Show when={tree.error()}>
        <p class="form-status" role="alert">
          {errorMessage(tree.error(), "This session could not be read.")}
        </p>
      </Show>

      <Show
        when={!tree.loading()}
        fallback={<p class="panel-note">Opening your log...</p>}
      >
        <Show when={tree.latest()} fallback={<SessionNotFound />}>
          {(node) => (
            <SessionBody
              repos={props.repos}
              id={props.id}
              tree={node()}
              exerciseName={exerciseName}
              today={today()}
              unit={props.unit}
            />
          )}
        </Show>
      </Show>
    </div>
  );
}

function SessionBody(props: {
  repos: Repos;
  id: string;
  tree: WorkoutTree;
  exerciseName(exerciseId: string): string;
  today: Date;
  unit: WeightUnit;
}): JSX.Element {
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const session = () => props.tree.session;
  const summary = createMemo(() => summarizeSession(props.tree, new Map()));
  const routines = createLocalQuery(() => props.repos.routines.listLive());
  // A live routine names the session; a tombstoned or missing one reads as
  // "Deleted routine", and a session with no routine id shows nothing.
  const provenance = createMemo(() =>
    routineProvenance(
      session().routine_id,
      (routines.latest() ?? []).find((routine) => routine.id === session().routine_id),
    ),
  );
  const started = (): string => {
    const at = session().started_at;
    return at ? formatTime(at) : "n/a";
  };
  const hasTop = (): boolean => summary().topE1rmKg !== undefined;
  const topFigure = (): string => {
    const best = summary().topE1rmKg;
    return best === undefined ? "n/a" : formatE1rm(best);
  };

  const remove = async (): Promise<void> => {
    try {
      await props.repos.workouts.remove(props.id);
      navigate("/history");
    } catch (cause) {
      setError(errorMessage(cause, "The session could not be deleted."));
    }
  };

  return (
    <div class="stack">
      <PageHeader
        path="Training / History"
        title={formatDayHeading(session().local_date, props.today)}
        lede={`Started ${started()} · ${formatDurationMin(session().duration_min)} · ${summary().exerciseCount} exercises`}
      />

      <Show when={provenance()}>
        <p class="panel-note">{`Routine: ${provenance()}`}</p>
      </Show>

      <Panel label="Session totals">
        <dl class="stat-list">
          <div class="stat">
            <dt class="label">Sets</dt>
            <dd class="stat-value">{summary().setCount}</dd>
          </div>
          <div class="stat">
            <dt class="label">Working volume</dt>
            <dd class="stat-value">{formatWeight(summary().volumeKg, props.unit)}</dd>
          </div>
          <div class="stat">
            <dt class="label">Top e1RM (Brzycki)</dt>
            <dd class="stat-value">
              {topFigure()}
              <Show when={hasTop()}>
                <span class="stat-unit">{` ${props.unit}`}</span>
              </Show>
            </dd>
          </div>
          <div class="stat">
            <dt class="label">Duration</dt>
            <dd class="stat-value">{formatDurationMin(session().duration_min)}</dd>
          </div>
        </dl>
      </Panel>

      <For each={props.tree.entries}>
        {(slot) => (
          <SessionEntry
            slot={slot}
            exerciseName={props.exerciseName}
            unit={props.unit}
          />
        )}
      </For>

      <Show when={error()}>
        <p class="form-status" role="alert">
          {error()}
        </p>
      </Show>

      <div class="form-actions">
        <button
          type="button"
          class="btn btn-secondary"
          onClick={() => setConfirmDelete(true)}
        >
          Delete session
        </button>
      </div>

      <ConfirmDialog
        open={confirmDelete()}
        title="Delete this session?"
        body="The session, its exercises, and its sets are tombstoned on this device. History will no longer show it."
        confirmLabel="Delete session"
        onConfirm={() => {
          setConfirmDelete(false);
          void remove();
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

/** One exercise inside the session: best e1RM callout plus its set table. */
function SessionEntry(props: {
  slot: WorkoutTree["entries"][number];
  exerciseName(exerciseId: string): string;
  unit: WeightUnit;
}): JSX.Element {
  const entry = () => props.slot.entry;
  const sets = () => props.slot.sets;
  const best = (): string => {
    const estimate = bestE1rm(sets());
    return estimate === undefined ? "n/a" : `${formatE1rm(estimate)} ${props.unit}`;
  };
  return (
    <Panel
      label={props.exerciseName(entry().exercise_id)}
      meta={`Best e1RM (Brzycki): ${best()}`}
    >
      <Show
        when={sets().length > 0}
        fallback={<p class="panel-note">No sets were logged for this exercise.</p>}
      >
        <div class="table-wrap">
          <table class="data-table">
            <caption class="sr-only">
              {`Sets for ${props.exerciseName(entry().exercise_id)}: set number, warmup marks, weight in ${props.unit}, reps, and e1RM (Brzycki).`}
            </caption>
            <thead>
              <tr>
                <th scope="col">Set</th>
                <th scope="col">Warmup</th>
                <th scope="col">{`Weight (${props.unit})`}</th>
                <th scope="col">Reps</th>
                <th scope="col">e1RM (Brzycki)</th>
              </tr>
            </thead>
            <tbody>
              <For each={sets()}>
                {(set) => (
                  <tr>
                    <td>
                      <span class="num">{set.set_index + 1}</span>
                    </td>
                    <td>
                      {set.is_warmup ? (
                        <span class="badge">
                          W<span class="sr-only"> warmup</span>
                        </span>
                      ) : null}
                    </td>
                    <td>{formatWeight(set.weight_kg, props.unit)}</td>
                    <td>{set.reps}</td>
                    <td>
                      <span class="num">{formatE1rm(set.e1rm_kg)}</span>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </Panel>
  );
}
