import type { Exercise } from "@waveform/api-types";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { Repos } from "../../db";
import { createLocalQuery } from "../../db/query";
import type { LocalRow } from "../../db/types";
import {
  exerciseFormIssues,
  exerciseFormValues,
  MUSCLE_FILTERS,
  MUSCLE_GROUPS,
} from "../../lib/catalog";
import { filterExercises } from "../../lib/exerciseStats";
import { errorMessage } from "../../lib/errors";
import Panel from "../Panel";

/**
 * The catalog as a picker: search, muscle chips, tap to add an entry to
 * the session, and an inline custom-exercise form for the movement that
 * is missing. The list is live, so a custom exercise appears the moment
 * it is created.
 */
export default function ExercisePicker(props: {
  repos: Repos;
  onPick(exerciseId: string): void;
}) {
  const [search, setSearch] = createSignal("");
  const [muscle, setMuscle] = createSignal("all");
  const rows = createLocalQuery(() => props.repos.exercises.listLive());

  const filtered = createMemo(() =>
    filterExercises(rows.latest() ?? [], {
      search: search(),
      muscleGroup: muscle() === "all" ? "" : muscle(),
    }),
  );

  const clearFilters = (): void => {
    setSearch("");
    setMuscle("all");
  };

  return (
    <Panel label="Add an exercise" meta={`${filtered().length} of ${(rows.latest() ?? []).length}`}>
      <div class="form-row">
        <label class="label" for="exercise-picker-search">
          Search exercises
        </label>
        <input
          class="input"
          id="exercise-picker-search"
          type="search"
          placeholder="Squat, press, row..."
          value={search()}
          onInput={(event) => setSearch(event.currentTarget.value)}
        />
      </div>

      <div class="chip-row" role="group" aria-label="Filter by muscle group">
        <For each={MUSCLE_FILTERS}>
          {(group) => (
            <button
              type="button"
              class="seg-btn"
              aria-pressed={muscle() === group}
              onClick={() => setMuscle(group)}
            >
              {group}
            </button>
          )}
        </For>
      </div>

      <Show when={!rows.error()}>
        <Show
          when={filtered().length > 0}
          fallback={
            <div class="stack-tight">
              <p class="panel-note">No exercises match. Clear the search to see the full catalog.</p>
              <div class="form-actions">
                <button type="button" class="btn btn-quiet" onClick={clearFilters}>
                  Clear search
                </button>
              </div>
            </div>
          }
        >
          <ul class="stack-tight">
            <For each={filtered()}>
              {(row: LocalRow<Exercise>) => (
                <li>
                  <button
                    type="button"
                    class="btn btn-secondary"
                    onClick={() => props.onPick(row.id)}
                  >
                    {`${row.name} · ${row.muscle_group}`}
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
      <Show when={rows.error()}>
        <p class="form-status" role="alert">
          The catalog could not be read. Try again.
        </p>
      </Show>

      <CreateCustomForm repos={props.repos} onPick={props.onPick} />
    </Panel>
  );
}

/**
 * The inline custom-exercise form: name, one of the nine muscle groups,
 * optional equipment. It validates before the repo write and hands the
 * new id back so the picker can add it as a session entry.
 */
function CreateCustomForm(props: { repos: Repos; onPick(exerciseId: string): void }) {
  const [name, setName] = createSignal("");
  const [muscleGroup, setMuscleGroup] = createSignal("");
  const [equipment, setEquipment] = createSignal("");
  const [issues, setIssues] = createSignal<string[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const values = {
      name: name(),
      muscle_group: muscleGroup(),
      equipment: equipment(),
    };
    const problems = exerciseFormIssues(values);
    setIssues(problems);
    setError(null);
    if (problems.length > 0) {
      return;
    }
    setSaving(true);
    try {
      const created = await props.repos.exercises.createCustom(exerciseFormValues(values));
      setName("");
      setMuscleGroup("");
      setEquipment("");
      props.onPick(created.row.id);
    } catch (cause) {
      setError(errorMessage(cause, "The exercise could not be saved."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form aria-label="Create custom exercise" onSubmit={submit} novalidate>
      <div class="divider">Create custom exercise</div>
      <div class="form-row">
        <label class="label" for="custom-exercise-name">
          Name
        </label>
        <input
          class="input"
          id="custom-exercise-name"
          type="text"
          maxlength={60}
          placeholder="The movement this catalog is missing"
          value={name()}
          onInput={(event) => setName(event.currentTarget.value)}
        />
      </div>
      <div class="form-row">
        <label class="label" for="custom-exercise-muscle">
          Muscle group
        </label>
        <select
          class="input"
          id="custom-exercise-muscle"
          value={muscleGroup()}
          onChange={(event) => setMuscleGroup(event.currentTarget.value)}
        >
          <option value="">Choose a muscle group</option>
          <For each={[...MUSCLE_GROUPS]}>
            {(group) => <option value={group}>{group}</option>}
          </For>
        </select>
      </div>
      <div class="form-row">
        <label class="label" for="custom-exercise-equipment">
          Equipment (optional)
        </label>
        <input
          class="input"
          id="custom-exercise-equipment"
          type="text"
          placeholder="Barbell, dumbbell, cable..."
          value={equipment()}
          onInput={(event) => setEquipment(event.currentTarget.value)}
        />
      </div>
      <div class="form-actions">
        <button type="submit" class="btn btn-secondary" disabled={saving()}>
          {saving() ? "Creating exercise" : "Create and add"}
        </button>
      </div>
      <Show when={issues().length > 0 || error()}>
        <div class="form-status" role="alert">
          <Show when={issues().length > 0}>
            <p>{issues().join("; ")}</p>
          </Show>
          <Show when={error()}>
            <p>{error()}</p>
          </Show>
        </div>
      </Show>
    </form>
  );
}
