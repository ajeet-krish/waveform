/**
 * Cycling: log a ride with distance, elevation, and duration, then
 * read the ride list newest first. Each row speaks in km, m, and
 * minutes.
 */

import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import type { Activity } from "@waveform/api-types";
import { createLocalQuery } from "../db/query";
import type { Repos } from "../db";
import type { LocalRow } from "../db/types";
import ActivityCard from "../components/activity/ActivityCard";
import RideForm from "../components/activity/RideForm";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import Panel from "../components/Panel";
import { useAppData } from "../lib/appData";
import { errorMessage } from "../lib/errors";
import { createToday } from "../lib/today";

export default function Cycling(): JSX.Element {
  const app = useAppData();
  const today = createToday();
  return (
    <div class="page">
      <PageHeader
        path="Activities / Cycling"
        title="Cycling"
        lede="Log a ride as activity type cycling: distance in km, elevation in m, and time in the saddle."
      />
      <Show
        when={app.repos()}
        fallback={<p class="panel-note">Opening your log...</p>}
      >
        {(repos) => <CyclingView repos={repos()} today={today()} />}
      </Show>
    </div>
  );
}

function CyclingView(props: { repos: Repos; today: Date }): JSX.Element {
  const rides = createLocalQuery(() => props.repos.activities.listByType("cycling"));
  const rideRows = createMemo<LocalRow<Activity>[]>(() => rides.latest() ?? []);
  const [editTarget, setEditTarget] = createSignal<LocalRow<Activity> | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  /** Empty-state action: land the reader in the log form. */
  const focusForm = (): void => {
    document.getElementById("ride-date")?.focus();
  };

  const remove = async (ride: LocalRow<Activity>): Promise<void> => {
    try {
      await props.repos.activities.remove(ride.id);
      if (editTarget()?.id === ride.id) {
        setEditTarget(null);
      }
    } catch (cause) {
      setError(errorMessage(cause, "That ride could not be deleted."));
    }
  };

  return (
    <div class="stack">
      <Show when={error()}>
        <p class="form-status" role="alert">
          {error()}
        </p>
      </Show>

      <Panel label="Log a ride" meta={editTarget() ? "Editing a ride" : undefined}>
        <Show
          when={editTarget()}
          keyed
          fallback={<RideForm repos={props.repos} />}
        >
          {(ride) => (
            <div class="stack-tight">
              <RideForm repos={props.repos} initial={ride} onSaved={() => setEditTarget(null)} />
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

      <Panel label="Rides" meta={rides.loading() ? undefined : `${rideRows().length} logged`}>
        <Show
          when={!rides.loading()}
          fallback={<p class="panel-note">Opening your log...</p>}
        >
          <Show
            when={rideRows().length > 0}
            fallback={
              <EmptyState
                title="No rides logged"
                body="Log a ride with distance, elevation, and duration. Weekly distance and elevation place you on the cycling board."
                actions={[{ label: "Log a ride", onClick: focusForm }]}
                note="Rides weight daily Effort Points at 0.9 per minute"
              />
            }
          >
            <ul class="stack">
              <For each={rideRows()}>
                {(ride) => (
                  <li>
                    <ActivityCard
                      activity={ride}
                      today={props.today}
                      onEdit={() => setEditTarget(ride)}
                      onDelete={() => remove(ride)}
                    />
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </Panel>

      <p class="panel-note">
        Distances are stored in km. A hard climb counts more than the flat spin home.
      </p>
    </div>
  );
}
