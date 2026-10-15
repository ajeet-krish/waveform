import { A } from "@solidjs/router";
import {
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Index,
  Show,
  type JSX,
} from "solid-js";
import type { Exercise } from "@waveform/api-types";
import { createLocalQuery } from "../db/query";
import type { Repos } from "../db";
import type { LocalRow } from "../db/types";
import ConfirmDialog from "../components/ConfirmDialog";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import { useAppData } from "../lib/appData";
import {
  exerciseFormIssues,
  exerciseFormValues,
  MUSCLE_FILTERS,
  MUSCLE_GROUPS,
  type ExerciseFormValues,
} from "../lib/catalog";
import { filterExercises } from "../lib/exerciseStats";
import { errorMessage, errorIssues } from "../lib/errors";

const READ_FALLBACK = "The catalog could not be read.";
const SAVE_FALLBACK = "The exercise could not be saved.";

/**
 * The exercise catalog: search and muscle chips over the live rows,
 * custom rows carrying their own edit and delete, and an expanding form
 * for the movement that is missing. Catalog rows are shared by the
 * group, so nothing here lets one person rewrite them.
 */
export default function Exercises(): JSX.Element {
  const app = useAppData();
  return (
    <div class="page">
      <PageHeader
        path="Training / Exercises"
        title="Exercises"
        lede="The catalog behind every set: shared movements for the group, plus custom entries only you can see. Muscle groups and units live here, so every screen labels a squat the same way."
      />
      <Show
        when={app.repos()}
        fallback={<p class="panel-note">Opening your log...</p>}
      >
        {(repos) => <CatalogView repos={repos()} />}
      </Show>
    </div>
  );
}

function CatalogView(props: { repos: Repos }): JSX.Element {
  const [search, setSearch] = createSignal("");
  const [muscle, setMuscle] = createSignal("all");
  const [adding, setAdding] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [deleteTarget, setDeleteTarget] = createSignal<LocalRow<Exercise> | null>(null);
  const [status, setStatus] = createSignal<string | null>(null);

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

  const createExercise = async (values: ExerciseFormValues): Promise<void> => {
    await props.repos.exercises.createCustom(exerciseFormValues(values));
    setAdding(false);
  };

  const saveEdit = async (values: ExerciseFormValues): Promise<void> => {
    const target = editingId();
    if (!target) {
      return;
    }
    await props.repos.exercises.updateCustom(target, exerciseFormValues(values));
    setEditingId(null);
  };

  const confirmDelete = async (): Promise<void> => {
    const target = deleteTarget();
    if (!target) {
      return;
    }
    try {
      await props.repos.exercises.softDelete(target.id);
      setDeleteTarget(null);
      setStatus(null);
    } catch (cause) {
      setDeleteTarget(null);
      setStatus(errorMessage(cause, SAVE_FALLBACK));
    }
  };

  return (
    <div class="stack">
      <Show when={status()}>
        <p class="form-status" role="alert">
          {status()}
        </p>
      </Show>
      <Show when={rows.error()}>
        <p class="form-status" role="alert">
          {errorMessage(rows.error(), READ_FALLBACK)}
        </p>
      </Show>

      <div class="form-row">
        <label class="label" for="exercise-search">
          Search exercises
        </label>
        <input
          class="input"
          id="exercise-search"
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

      <Show
        when={adding()}
        fallback={
          <div class="form-actions">
            <button type="button" class="btn btn-primary" onClick={() => setAdding(true)}>
              Add an exercise
            </button>
          </div>
        }
      >
        <div class="panel">
          <div class="panel-head">
            <h2 class="label">Add an exercise</h2>
          </div>
          <div class="panel-body">
            <ExerciseForm
              submitLabel="Create exercise"
              onSubmit={createExercise}
              onCancel={() => setAdding(false)}
            />
          </div>
        </div>
      </Show>

      <Show when={!rows.loading()} fallback={<p class="panel-note">Opening your log...</p>}>
        <Show
          when={filtered().length > 0}
          fallback={
            <EmptyState
              title="No exercises match"
              body="No exercise in the catalog matches that search and muscle group. Clear them to see every movement."
              actions={[{ label: "Clear search", onClick: clearFilters }]}
            />
          }
        >
          <div class="table-wrap">
            <table class="data-table">
              <caption class="sr-only">
                Exercise catalog: name, muscle group, equipment, and row actions.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Muscle</th>
                  <th scope="col">Equipment</th>
                  <th scope="col">
                    <span class="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <Index each={filtered()}>
                  {(row) =>
                    editingId() === row().id ? (
                      <EditRow
                        row={row()}
                        onSubmit={saveEdit}
                        onCancel={() => setEditingId(null)}
                      />
                    ) : (
                      <ViewRow
                        row={row()}
                        onEdit={() => setEditingId(row().id)}
                        onDelete={() => setDeleteTarget(row())}
                      />
                    )
                  }
                </Index>
              </tbody>
            </table>
          </div>
        </Show>
      </Show>

      <p class="panel-note">
        Sets log weight in kg and reps, and e1RM is computed with the Brzycki formula
        wherever an exercise appears.
      </p>
      <A class="link" href="/workout">
        Open the workout screen
      </A>

      <ConfirmDialog
        open={deleteTarget() !== null}
        title="Delete this exercise?"
        body={
          deleteTarget()
            ? `${deleteTarget()?.name} disappears from the catalog. Sets you already logged keep their history.`
            : undefined
        }
        confirmLabel="Delete exercise"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

/** One catalog row as listed: name link, tags, and custom-only actions. */
function ViewRow(props: {
  row: LocalRow<Exercise>;
  onEdit(): void;
  onDelete(): void;
}): JSX.Element {
  const custom = props.row.owner_id !== null;
  return (
    <tr>
      <td>
        <A class="inline-link" href={`/exercises/${props.row.id}`}>
          {props.row.name}
        </A>
        <Show when={custom}>
          {" "}
          <span class="badge">Custom</span>
        </Show>
      </td>
      <td>{props.row.muscle_group}</td>
      <td>{props.row.equipment ?? "none"}</td>
      <td>
        <Show when={custom}>
          <div class="row-actions">
            <button type="button" class="btn btn-quiet" onClick={props.onEdit}>
              Edit
            </button>
            <button type="button" class="btn btn-quiet" onClick={props.onDelete}>
              Delete
            </button>
          </div>
        </Show>
      </td>
    </tr>
  );
}

/** The same row widened into an inline edit form for a custom exercise. */
function EditRow(props: {
  row: LocalRow<Exercise>;
  onSubmit(values: ExerciseFormValues): Promise<void>;
  onCancel(): void;
}): JSX.Element {
  return (
    <tr>
      <td colspan={4}>
        <ExerciseForm
          initial={{
            name: props.row.name,
            muscle_group: props.row.muscle_group,
            equipment: props.row.equipment ?? "",
          }}
          submitLabel="Save changes"
          onSubmit={props.onSubmit}
          onCancel={props.onCancel}
        />
      </td>
    </tr>
  );
}

/**
 * The shared create/edit exercise form: name (required, 1 to 60
 * characters trimmed), one of the nine muscle groups, optional
 * equipment. Validation runs before the repo write; a rejection stays on
 * screen instead of clearing what was typed.
 */
function ExerciseForm(props: {
  initial?: ExerciseFormValues;
  submitLabel: string;
  onSubmit(values: ExerciseFormValues): Promise<void>;
  onCancel?(): void;
}): JSX.Element {
  const [name, setName] = createSignal(props.initial?.name ?? "");
  const [muscleGroup, setMuscleGroup] = createSignal(props.initial?.muscle_group ?? "");
  const [equipment, setEquipment] = createSignal(props.initial?.equipment ?? "");
  const [issues, setIssues] = createSignal<string[]>([]);
  const [saving, setSaving] = createSignal(false);
  const nameId = createUniqueId();
  const muscleId = createUniqueId();
  const equipmentId = createUniqueId();

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const values: ExerciseFormValues = {
      name: name(),
      muscle_group: muscleGroup(),
      equipment: equipment(),
    };
    const problems = exerciseFormIssues(values);
    setIssues(problems);
    if (problems.length > 0) {
      return;
    }
    setSaving(true);
    try {
      await props.onSubmit(values);
    } catch (cause) {
      const found = errorIssues(cause);
      setIssues(found.length > 0 ? found : [SAVE_FALLBACK]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form aria-label={props.submitLabel} onSubmit={submit} novalidate>
      <div class="form-row">
        <label class="label" for={nameId}>
          Name
        </label>
        <input
          class="input"
          id={nameId}
          type="text"
          maxlength={60}
          placeholder="The movement this catalog is missing"
          value={name()}
          onInput={(event) => setName(event.currentTarget.value)}
        />
      </div>
      <div class="form-row">
        <label class="label" for={muscleId}>
          Muscle group
        </label>
        <select
          class="input"
          id={muscleId}
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
        <label class="label" for={equipmentId}>
          Equipment (optional)
        </label>
        <input
          class="input"
          id={equipmentId}
          type="text"
          placeholder="Barbell, dumbbell, cable..."
          value={equipment()}
          onInput={(event) => setEquipment(event.currentTarget.value)}
        />
      </div>
      <div class="form-actions">
        <button type="submit" class="btn btn-secondary" disabled={saving()}>
          {saving() ? "Saving" : props.submitLabel}
        </button>
        <Show when={props.onCancel}>
          <button
            type="button"
            class="btn btn-quiet"
            onClick={() => props.onCancel?.()}
          >
            Cancel
          </button>
        </Show>
      </div>
      <Show when={issues().length > 0}>
        <div class="form-status" role="alert">
          <ul class="stack-tight">
            <Index each={issues()}>
              {(issue) => <li>{issue()}</li>}
            </Index>
          </ul>
        </div>
      </Show>
    </form>
  );
}
