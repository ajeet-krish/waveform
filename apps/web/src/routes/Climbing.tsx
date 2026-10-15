/**
 * Climbing: log a session with the GradePicker, then read the session
 * list newest first. Each row carries its per-grade histogram, so the
 * card summary speaks in sends, hardest grade, and V-points.
 */

import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { createLocalQuery } from "../db/query";
import type { Repos } from "../db";
import type { ClimbLog } from "../db/repos/activities";
import ActivityCard from "../components/activity/ActivityCard";
import ClimbForm from "../components/activity/ClimbForm";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import Panel from "../components/Panel";
import { useAppData } from "../lib/appData";
import { errorMessage } from "../lib/errors";
import { createToday } from "../lib/today";

export default function Climbing(): JSX.Element {
  const app = useAppData();
  const today = createToday();
  return (
    <div class="page">
      <PageHeader
        path="Activities / Climbing"
        title="Climbing"
        lede="Log a session as activity type climbing: the grades you sent and how many of each."
      />
      <Show
        when={app.repos()}
        fallback={<p class="panel-note">Opening your log...</p>}
      >
        {(repos) => <ClimbingView repos={repos()} today={today()} />}
      </Show>
    </div>
  );
}

function ClimbingView(props: { repos: Repos; today: Date }): JSX.Element {
  const climbs = createLocalQuery(() => props.repos.activities.listClimbs());
  const climbLogs = createMemo<ClimbLog[]>(() => climbs.latest() ?? []);
  const [editTarget, setEditTarget] = createSignal<ClimbLog | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  /** Empty-state action: land the reader in the log form. */
  const focusForm = (): void => {
    document.getElementById("climb-date")?.focus();
  };

  const remove = async (log: ClimbLog): Promise<void> => {
    try {
      await props.repos.activities.remove(log.activity.id);
      if (editTarget()?.activity.id === log.activity.id) {
        setEditTarget(null);
      }
    } catch (cause) {
      setError(errorMessage(cause, "That session could not be deleted."));
    }
  };

  return (
    <div class="stack">
      <Show when={error()}>
        <p class="form-status" role="alert">
          {error()}
        </p>
      </Show>

      <Panel label="Log a climb" meta={editTarget() ? "Editing a session" : undefined}>
        <Show
          when={editTarget()}
          keyed
          fallback={<ClimbForm repos={props.repos} />}
        >
          {(log) => (
            <div class="stack-tight">
              <ClimbForm repos={props.repos} initial={log} onSaved={() => setEditTarget(null)} />
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

      <Panel label="Sessions" meta={climbs.loading() ? undefined : `${climbLogs().length} logged`}>
        <Show
          when={!climbs.loading()}
          fallback={<p class="panel-note">Opening your log...</p>}
        >
          <Show
            when={climbLogs().length > 0}
            fallback={
              <EmptyState
                title="No climbing sessions logged"
                body="Log a session with the grades you sent. V-points sum 2^grade, so quality beats volume on the climbing board."
                actions={[{ label: "Log a climb", onClick: focusForm }]}
                note="Climbs weight daily Effort Points at 1.1 per minute"
              />
            }
          >
            <ul class="stack">
              <For each={climbLogs()}>
                {(log) => (
                  <li>
                    <ActivityCard
                      activity={log.activity}
                      sends={log.sends?.counts}
                      today={props.today}
                      onEdit={() => setEditTarget(log)}
                      onDelete={() => remove(log)}
                    />
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </Panel>

      <p class="panel-note">
        Grades are stored as the label you logged, for example V4, alongside a numeric value
        used for V-points.
      </p>
    </div>
  );
}
