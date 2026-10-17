import { A } from "@solidjs/router";
import { createMemo, For, Show, type JSX } from "solid-js";
import { createLocalQuery } from "../db/query";
import type { Repos } from "../db";
import type { RoutineWithEntries } from "../db/repos/routines";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import { useAppData } from "../lib/appData";
import { errorMessage } from "../lib/errors";

/**
 * The routines list: every live plan as a card, newest information from
 * the routine and its planned entries. An empty list invites the first
 * routine; the create action opens the editor.
 */
export default function Routines(): JSX.Element {
  const app = useAppData();
  return (
    <div class="page">
      <PageHeader
        path="Training / Routines"
        title="Routines"
        lede="Saved plans you start again: the exercises, their order, and the targets you aim for. Starting a routine copies it into a workout draft, and nothing is logged until you finish."
      />
      <Show
        when={app.repos()}
        fallback={<p class="panel-note">Opening your log...</p>}
      >
        {(repos) => <RoutinesView repos={repos()} />}
      </Show>
    </div>
  );
}

function RoutinesView(props: { repos: Repos }): JSX.Element {
  // One live query over the routines and their entries, so an edit on the
  // detail screen updates the count here without a manual refresh. This
  // reads entries per routine (an N+1); a bulk listWithEntries on the repo
  // is the follow-up once the list can grow.
  const overview = createLocalQuery<RoutineWithEntries[]>(async () => {
    const routines = await props.repos.routines.listLive();
    const rows: RoutineWithEntries[] = [];
    for (const routine of routines) {
      const withEntries = await props.repos.routines.getWithEntries(routine.id);
      if (withEntries) {
        rows.push(withEntries);
      }
    }
    return rows;
  });
  const rows = createMemo<RoutineWithEntries[]>(() => overview.latest() ?? []);

  return (
    <div class="stack">
      <Show when={overview.error()}>
        <p class="form-status" role="alert">
          {errorMessage(overview.error(), "Your routines could not be read.")}
        </p>
      </Show>

      <Show
        when={!overview.loading()}
        fallback={<p class="panel-note">Opening your log...</p>}
      >
        <Show
          when={rows().length > 0}
          fallback={
            <EmptyState
              title="No routines yet"
              body="A routine is a plan you start again: pick the exercises, set their order, and carry the targets into the next session."
              actions={[{ label: "Create a routine", href: "/routines/new" }]}
              note="Starting a routine opens a workout draft pre-filled with its exercises"
            />
          }
        >
          <div class="form-actions">
            <A class="btn btn-primary" href="/routines/new">
              Create a routine
            </A>
          </div>
          <div class="discipline-grid">
            <For each={rows()}>
              {(item) => (
                <A class="discipline" href={`/routines/${item.routine.id}`}>
                  <p class="discipline-name">{item.routine.name}</p>
                  <p class="discipline-blurb">{item.routine.notes ?? "No notes yet."}</p>
                  <p class="discipline-metric label">
                    {`${item.entries.length} ${item.entries.length === 1 ? "exercise" : "exercises"}`}
                  </p>
                </A>
              )}
            </For>
          </div>
        </Show>
      </Show>

      <p class="panel-note">
        A routine is a plan, not a finished session. Start one to log the sets you actually
        perform.
      </p>
    </div>
  );
}
