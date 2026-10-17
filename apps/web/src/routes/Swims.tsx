/**
 * Swims: log a swim with distance and duration, then read the swim list
 * newest first. Each row speaks in duration, distance, and pace per
 * 100 m.
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

export default function Swims(): JSX.Element {
  const app = useAppData();
  const today = createToday();
  return (
    <div class="page">
      <PageHeader
        path="Activities / Swims"
        title="Swims"
        lede="Log a swim as activity type swim: distance in km and time in the water."
      />
      <Show
        when={app.repos()}
        fallback={<p class="panel-note">Opening your log...</p>}
      >
        {(repos) => <SwimsView repos={repos()} today={today()} />}
      </Show>
    </div>
  );
}

function SwimsView(props: { repos: Repos; today: Date }): JSX.Element {
  const swims = createLocalQuery(() => props.repos.activities.listByType("swim"));
  const swimRows = createMemo<LocalRow<Activity>[]>(() => swims.latest() ?? []);
  const [editTarget, setEditTarget] = createSignal<LocalRow<Activity> | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  /** Empty-state action: land the reader in the log form. */
  const focusForm = (): void => {
    document.getElementById("swim-date")?.focus();
  };

  const remove = async (swim: LocalRow<Activity>): Promise<void> => {
    try {
      await props.repos.activities.remove(swim.id);
      if (editTarget()?.id === swim.id) {
        setEditTarget(null);
      }
    } catch (cause) {
      setError(errorMessage(cause, "That swim could not be deleted."));
    }
  };

  return (
    <div class="stack">
      <Show when={error()}>
        <p class="form-status" role="alert">
          {error()}
        </p>
      </Show>

      <Panel label="Log a swim" meta={editTarget() ? "Editing a swim" : undefined}>
        <Show
          when={editTarget()}
          keyed
          fallback={<EnduranceForm repos={props.repos} type="swim" />}
        >
          {(swim) => (
            <div class="stack-tight">
              <EnduranceForm
                repos={props.repos}
                type="swim"
                initial={swim}
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

      <Panel label="Swims" meta={swims.loading() ? undefined : `${swimRows().length} logged`}>
        <Show
          when={!swims.loading()}
          fallback={<p class="panel-note">Opening your log...</p>}
        >
          <Show
            when={swimRows().length > 0}
            fallback={
              <EmptyState
                title="No swims logged"
                body="Log a swim with distance and duration. Swims count toward consistency and your daily Effort Points."
                actions={[{ label: "Log a swim", onClick: focusForm }]}
                note="Swims weight daily Effort Points at 1.0 per minute"
              />
            }
          >
            <ul class="stack">
              <For each={swimRows()}>
                {(swim) => (
                  <li>
                    <ActivityCard
                      activity={swim}
                      today={props.today}
                      onEdit={() => setEditTarget(swim)}
                      onDelete={() => remove(swim)}
                    />
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </Panel>

      <p class="panel-note">
        Distances are stored in km. Pace is spoken per 100 m once a swim has both distance and
        duration.
      </p>
    </div>
  );
}
