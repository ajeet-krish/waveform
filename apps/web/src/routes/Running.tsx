/**
 * Running: log a run with distance, duration, and optional elevation,
 * then read the run list newest first. Each row speaks in duration,
 * distance, elevation, and pace.
 */

import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import type { Activity } from "@waveform/api-types";
import { createLocalQuery } from "../db/query";
import type { Repos } from "../db";
import type { LocalRow } from "../db/types";
import ActivityCard from "../components/activity/ActivityCard";
import EnduranceForm from "../components/activity/EnduranceForm";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import Panel from "../components/Panel";
import { useAppData } from "../lib/appData";
import { errorMessage } from "../lib/errors";
import { createToday } from "../lib/today";

export default function Running(): JSX.Element {
  const app = useAppData();
  const today = createToday();
  return (
    <div class="page">
      <PageHeader
        path="Activities / Running"
        title="Running"
        lede="Log a run as activity type running: duration, distance in km, and the elevation you climbed."
      />
      <Show
        when={app.repos()}
        fallback={<p class="panel-note">Opening your log...</p>}
      >
        {(repos) => <RunningView repos={repos()} today={today()} />}
      </Show>
    </div>
  );
}

function RunningView(props: { repos: Repos; today: Date }): JSX.Element {
  const runs = createLocalQuery(() => props.repos.activities.listByType("running"));
  const runRows = createMemo<LocalRow<Activity>[]>(() => runs.latest() ?? []);
  const [editTarget, setEditTarget] = createSignal<LocalRow<Activity> | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  /** Empty-state action: land the reader in the log form. */
  const focusForm = (): void => {
    document.getElementById("running-date")?.focus();
  };

  const remove = async (run: LocalRow<Activity>): Promise<void> => {
    try {
      await props.repos.activities.remove(run.id);
      if (editTarget()?.id === run.id) {
        setEditTarget(null);
      }
    } catch (cause) {
      setError(errorMessage(cause, "That run could not be deleted."));
    }
  };

  return (
    <div class="stack">
      <Show when={error()}>
        <p class="form-status" role="alert">
          {error()}
        </p>
      </Show>

      <Panel label="Log a run" meta={editTarget() ? "Editing a run" : undefined}>
        <Show
          when={editTarget()}
          keyed
          fallback={<EnduranceForm repos={props.repos} type="running" />}
        >
          {(run) => (
            <div class="stack-tight">
              <EnduranceForm
                repos={props.repos}
                type="running"
                initial={run}
                onSaved={() => setEditTarget(null)}
              />
              <div class="form-actions">
                <button
                  type="button"
                  class="btn btn-quiet"
                  onClick={() => setEditTarget(null)}
                >
                  Cancel edit
                </button>
              </div>
            </div>
          )}
        </Show>
      </Panel>

      <Panel label="Runs" meta={runs.loading() ? undefined : `${runRows().length} logged`}>
        <Show
          when={!runs.loading()}
          fallback={<p class="panel-note">Opening your log...</p>}
        >
          <Show
            when={runRows().length > 0}
            fallback={
              <EmptyState
                title="No runs logged"
                body="Log a run with duration and distance. Runs count toward consistency and your daily Effort Points."
                actions={[{ label: "Log a run", onClick: focusForm }]}
                note="Runs weight daily Effort Points at 1.0 per minute"
              />
            }
          >
            <ul class="stack">
              <For each={runRows()}>
                {(run) => (
                  <li>
                    <ActivityCard
                      activity={run}
                      today={props.today}
                      onEdit={() => setEditTarget(run)}
                      onDelete={() => remove(run)}
                    />
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </Panel>

      <p class="panel-note">
        Distances are stored in km. Pace is spoken per km once a run has both distance and
        duration.
      </p>
    </div>
  );
}
