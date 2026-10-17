import { useNavigate, useParams } from "@solidjs/router";
import { createMemo, createSignal, Index, Show, type JSX } from "solid-js";
import { createLocalQuery } from "../db/query";
import type { Repos } from "../db";
import type { RoutineEntryPatch, RoutineWithEntries } from "../db/repos/routines";
import ConfirmDialog from "../components/ConfirmDialog";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import Panel from "../components/Panel";
import ExercisePicker from "../components/workout/ExercisePicker";
import RoutineForm, { type RoutineFormValues } from "../components/routine/RoutineForm";
import RoutineSlotRow from "../components/routine/RoutineSlotRow";
import { useAppData } from "../lib/appData";
import { errorMessage } from "../lib/errors";
import type { WeightUnit } from "../lib/format";
import { moveEntryOrder, seedDraftFromRoutine } from "../lib/routines";

/**
 * The routine editor. Create mode asks only for a name and notes; edit
 * mode adds the ordered exercises with their targets, and a prominent
 * Start workout that seeds a draft from the plan.
 */
export default function RoutineDetail(): JSX.Element {
  const app = useAppData();
  const params = useParams();
  const unit = (): WeightUnit => app.profile()?.settings.display_weight_unit ?? "kg";
  // "new" is the create path; a real routine id is a UUID, so it can never
  // collide. Accepting it here also keeps create working whichever route
  // the router prefers for /routines/new.
  const routineId = (): string | undefined => {
    const id = params.id;
    return id === undefined || id === "new" ? undefined : id;
  };
  return (
    <div class="page">
      <Show
        when={app.repos()}
        fallback={<p class="panel-note">Opening your log...</p>}
      >
        {(repos) => (
          <Show when={routineId()} keyed fallback={<RoutineCreate repos={repos()} />}>
            {(id) => <RoutineEditor repos={repos()} id={id} unit={unit} />}
          </Show>
        )}
      </Show>
    </div>
  );
}

/** Create mode: name and notes, then the editor for exercises. */
function RoutineCreate(props: { repos: Repos }): JSX.Element {
  const navigate = useNavigate();
  return (
    <div class="stack">
      <PageHeader
        path="Training / Routines"
        title="New routine"
        lede="Name the routine, then add the exercises it walks through."
      />
      <Panel label="Routine">
        <RoutineForm
          submitLabel="Create routine"
          onSubmit={async (values: RoutineFormValues) => {
            const created = await props.repos.routines.create({
              name: values.name,
              notes: values.notes,
            });
            navigate(`/routines/${created.row.id}`);
          }}
        />
      </Panel>
      <p class="panel-note">
        A routine is a plan, not a logged session. Starting a workout from it copies the
        exercises into a draft you still fill in.
      </p>
    </div>
  );
}

function RoutineNotFound(): JSX.Element {
  return (
    <div class="stack">
      <PageHeader path="Training / Routines" title="Routines" />
      <EmptyState
        title="Routine not found"
        body="This routine is not on this device. It may have been deleted."
        actions={[{ label: "Back to routines", href: "/routines" }]}
      />
    </div>
  );
}

function RoutineEditor(props: {
  repos: Repos;
  id: string;
  unit: () => WeightUnit;
}): JSX.Element {
  const navigate = useNavigate();
  const detail = createLocalQuery<RoutineWithEntries | undefined>(() =>
    props.repos.routines.getWithEntries(props.id),
  );
  const exercises = createLocalQuery(() => props.repos.exercises.listLive());

  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const [confirmStart, setConfirmStart] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // One in-flight guard per write class, so a double click cannot queue two
  // entry writes (which would race the reorder permutation check) or seed
  // two drafts.
  const [writingEntries, setWritingEntries] = createSignal(false);
  const [starting, setStarting] = createSignal(false);

  const source = () => detail.latest();
  const entries = createMemo(() => source()?.entries ?? []);
  const exerciseRows = createMemo(() => exercises.latest() ?? []);

  /** Runs a repo write and surfaces a failure in the status region. */
  const run = async (action: () => Promise<unknown>, fallback: string): Promise<void> => {
    try {
      setError(null);
      await action();
    } catch (cause) {
      setError(errorMessage(cause, fallback));
    }
  };

  /**
   * Serializes the writes that change the entry set or its order. The
   * guard drops a second click that lands before the first write settles,
   * so a rapid Up/Up cannot re-send a permutation computed from the stale
   * live-query snapshot (which loses the move) and a Remove cannot race a
   * Move into a permutation rejection.
   */
  const runEntryWrite = (action: () => Promise<unknown>, fallback: string): void => {
    if (writingEntries()) {
      return;
    }
    setWritingEntries(true);
    void run(action, fallback).finally(() => setWritingEntries(false));
  };

  const saveRoutine = async (values: RoutineFormValues): Promise<void> => {
    await props.repos.routines.update(props.id, { name: values.name, notes: values.notes });
  };

  const addExercise = (exerciseId: string): void => {
    runEntryWrite(
      () => props.repos.routines.addEntry({ routine_id: props.id, exercise_id: exerciseId }),
      "That exercise could not be added.",
    );
  };

  const updateSlot = (entryId: string, patch: RoutineEntryPatch): void => {
    void run(
      () => props.repos.routines.updateEntry(entryId, patch),
      "That target could not be saved.",
    );
  };

  const removeSlot = (entryId: string): void => {
    runEntryWrite(
      () => props.repos.routines.removeEntry(entryId),
      "That exercise could not be removed.",
    );
  };

  const moveSlot = (index: number, direction: -1 | 1): void => {
    const ids = moveEntryOrder(
      entries().map((entry) => entry.id),
      index,
      direction,
    );
    if (ids === null) {
      return;
    }
    runEntryWrite(
      () => props.repos.routines.reorderEntries(props.id, ids),
      "That order could not be saved.",
    );
  };

  const deleteRoutine = (): void => {
    setConfirmDelete(false);
    void run(async () => {
      await props.repos.routines.softDelete(props.id);
      navigate("/routines");
    }, "That routine could not be deleted.");
  };

  const beginSession = async (): Promise<void> => {
    const current = source();
    if (!current) {
      return;
    }
    const draft = seedDraftFromRoutine(current, new Date());
    await props.repos.drafts.save(draft);
    navigate("/workout");
  };

  const startWorkout = (): void => {
    // Guard the read-check-write: a second click before the first settles
    // would pass the existence check twice and seed an orphan draft.
    if (starting()) {
      return;
    }
    setStarting(true);
    void run(async () => {
      const existing = await props.repos.drafts.current();
      if (existing) {
        setConfirmStart(true);
        return;
      }
      await beginSession();
    }, "That session could not be started.").finally(() => setStarting(false));
  };

  const replaceAndStart = (): void => {
    if (starting()) {
      return;
    }
    setConfirmStart(false);
    setStarting(true);
    void run(async () => {
      const existing = await props.repos.drafts.current();
      if (existing) {
        await props.repos.drafts.discard(existing.id);
      }
      await beginSession();
    }, "That session could not be started.").finally(() => setStarting(false));
  };

  return (
    <>
      <Show when={detail.error()}>
        <p class="form-status" role="alert">
          {errorMessage(detail.error(), "This routine could not be read.")}
        </p>
      </Show>

      <Show
        when={!detail.loading()}
        fallback={<p class="panel-note">Opening your log...</p>}
      >
        <Show when={source()} fallback={<RoutineNotFound />}>
          {(current) => (
            <div class="stack">
              <PageHeader
                path="Training / Routines"
                title={current().routine.name}
                lede={current().routine.notes ?? "A saved plan you can start as a session."}
              />

              <div class="form-actions">
                <button
                  type="button"
                  class="btn btn-primary"
                  disabled={starting() || entries().length === 0}
                  onClick={startWorkout}
                >
                  Start workout
                </button>
              </div>

              <Show when={error()}>
                <p class="form-status" role="alert">
                  {error()}
                </p>
              </Show>

              <Panel label="Routine">
                <RoutineForm
                  initial={{
                    name: current().routine.name,
                    notes: current().routine.notes,
                  }}
                  submitLabel="Save routine"
                  onSubmit={saveRoutine}
                />
              </Panel>

              <Panel label="Exercises" meta={`${entries().length} planned`}>
                <Show
                  when={entries().length > 0}
                  fallback={
                    <EmptyState
                      title="No exercises planned"
                      body="Add the movements this routine walks through, in the order you train them."
                      actions={[
                        { label: "Add an exercise", onClick: () => setPickerOpen(true) },
                      ]}
                    />
                  }
                >
                  <div class="table-wrap">
                    <table class="data-table">
                      <caption class="sr-only">
                        {`Planned exercises in order: position, exercise, target sets, target reps, target weight in ${props.unit()}, and row actions.`}
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">#</th>
                          <th scope="col">Exercise</th>
                          <th scope="col">Sets</th>
                          <th scope="col">Reps</th>
                          <th scope="col">{`Weight (${props.unit()})`}</th>
                          <th scope="col">
                            <span class="sr-only">Row actions</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <Index each={entries()}>
                          {(entry, index) => (
                            <RoutineSlotRow
                              entry={entry()}
                              index={index}
                              count={entries().length}
                              unit={props.unit}
                              busy={writingEntries()}
                              exercises={exerciseRows()}
                              onChange={(patch) => updateSlot(entry().id, patch)}
                              onMove={(direction) => moveSlot(index, direction)}
                              onRemove={() => removeSlot(entry().id)}
                            />
                          )}
                        </Index>
                      </tbody>
                    </table>
                  </div>
                </Show>

                <Show
                  when={pickerOpen()}
                  fallback={
                    <Show when={entries().length > 0}>
                      <div class="form-actions mt-4">
                        <button
                          type="button"
                          class="btn btn-secondary"
                          onClick={() => setPickerOpen(true)}
                        >
                          Add an exercise
                        </button>
                      </div>
                    </Show>
                  }
                >
                  <ExercisePicker
                    repos={props.repos}
                    onPick={(exerciseId) => addExercise(exerciseId)}
                  />
                  <div class="form-actions mt-4">
                    <button
                      type="button"
                      class="btn btn-quiet"
                      onClick={() => setPickerOpen(false)}
                    >
                      Hide exercise picker
                    </button>
                  </div>
                </Show>
              </Panel>

              <div class="form-actions">
                <button
                  type="button"
                  class="btn btn-secondary"
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete routine
                </button>
              </div>

              <ConfirmDialog
                open={confirmDelete()}
                title="Delete this routine?"
                body="The routine and its planned exercises are removed from this device. Sessions you already logged from it keep their history."
                confirmLabel="Delete routine"
                onConfirm={deleteRoutine}
                onCancel={() => setConfirmDelete(false)}
              />

              <ConfirmDialog
                open={confirmStart()}
                title="Replace the unfinished session?"
                body="This device has a session in progress. Starting this routine replaces it, and the sets already logged in it are discarded."
                confirmLabel="Replace and start"
                cancelLabel="Keep session"
                onConfirm={replaceAndStart}
                onCancel={() => setConfirmStart(false)}
              />
            </div>
          )}
        </Show>
      </Show>
    </>
  );
}
