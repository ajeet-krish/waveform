/**
 * Hikes: log a hike with distance, elevation, and duration, then read
 * the hike list newest first. Each row speaks in duration, distance,
 * elevation, and pace.
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

export default function Hikes(): JSX.Element {
  const app = useAppData();
  const today = createToday();
  return (
    <div class="page">
      <PageHeader
        path="Activities / Hikes"
        title="Hikes"
        lede="Log a hike as activity type hike: distance in km, elevation in m, and time on foot."
      />
      <Show
        when={app.repos()}
        fallback={<p class="panel-note">Opening your log...</p>}
      >
        {(repos) => <HikesView repos={repos()} today={today()} />}
      </Show>
    </div>
  );
}

function HikesView(props: { repos: Repos; today: Date }): JSX.Element {
  const hikes = createLocalQuery(() => props.repos.activities.listByType("hike"));
  const hikeRows = createMemo<LocalRow<Activity>[]>(() => hikes.latest() ?? []);
  const [editTarget, setEditTarget] = createSignal<LocalRow<Activity> | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  /** Empty-state action: land the reader in the log form. */
  const focusForm = (): void => {
    document.getElementById("hike-date")?.focus();
  };

  const remove = async (hike: LocalRow<Activity>): Promise<void> => {
    try {
      await props.repos.activities.remove(hike.id);
      if (editTarget()?.id === hike.id) {
        setEditTarget(null);
      }
    } catch (cause) {
      setError(errorMessage(cause, "That hike could not be deleted."));
    }
  };

  return (
    <div class="stack">
      <Show when={error()}>
        <p class="form-status" role="alert">
          {error()}
        </p>
      </Show>

      <Panel label="Log a hike" meta={editTarget() ? "Editing a hike" : undefined}>
        <Show
          when={editTarget()}
          keyed
          fallback={<EnduranceForm repos={props.repos} type="hike" />}
        >
          {(hike) => (
            <div class="stack-tight">
              <EnduranceForm
                repos={props.repos}
                type="hike"
                initial={hike}
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

      <Panel label="Hikes" meta={hikes.loading() ? undefined : `${hikeRows().length} logged`}>
        <Show
          when={!hikes.loading()}
          fallback={<p class="panel-note">Opening your log...</p>}
        >
          <Show
            when={hikeRows().length > 0}
            fallback={
              <EmptyState
                title="No hikes logged"
                body="Log a hike with distance, elevation, and duration. Hikes count toward consistency and your daily Effort Points."
                actions={[{ label: "Log a hike", onClick: focusForm }]}
                note="Hikes weight daily Effort Points at 0.7 per minute"
              />
            }
          >
            <ul class="stack">
              <For each={hikeRows()}>
                {(hike) => (
                  <li>
                    <ActivityCard
                      activity={hike}
                      today={props.today}
                      onEdit={() => setEditTarget(hike)}
                      onDelete={() => remove(hike)}
                    />
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </Panel>

      <p class="panel-note">
        Distances are stored in km. Hikes earn Effort Points at a gentler 0.7 per minute.
      </p>
    </div>
  );
}
