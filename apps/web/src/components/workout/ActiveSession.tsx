import { A } from "@solidjs/router";
import { createSignal, Index, Show } from "solid-js";
import type { Repos } from "../../db";
import type { WorkoutDraft, WorkoutDraftSet } from "../../db/types";
import { formatE1rm, formatTime, formatWeight, type WeightUnit } from "../../lib/format";
import { formatTargetHint } from "../../lib/routines";
import {
  addExerciseToDraft,
  addSetToDraft,
  bestE1rm,
  draftTotals,
  removeExerciseFromDraft,
  removeSetFromDraft,
  updateSetInDraft,
  type DraftSetInput,
} from "../../lib/workoutLog";
import Panel from "../Panel";
import ExercisePicker from "./ExercisePicker";
import SetLog, { type SetLogPatch } from "./SetLog";

/**
 * The session in progress: session totals, one editable slot per
 * exercise, the picker to add another, and the two exits (finish into
 * the log, or discard with a confirm step). Every edit goes through a
 * workoutLog reducer, so the draft on screen and the draft the autosave
 * writes are the same object.
 */
export default function ActiveSession(props: {
  draft: WorkoutDraft;
  unit: WeightUnit;
  exerciseName(exerciseId: string): string;
  repos: Repos;
  mutate(updater: (current: WorkoutDraft) => WorkoutDraft): void;
  onFinish(): void;
  /** Asks the console to open its discard confirmation. */
  onDiscard(): void;
}) {
  const [pickerOpen, setPickerOpen] = createSignal(false);

  const totals = () => draftTotals(props.draft);
  const startedLabel = (): string =>
    props.draft.started_at ? formatTime(props.draft.started_at) : "n/a";
  const bestLabel = (sets: readonly WorkoutDraftSet[]): string => {
    const best = bestE1rm(sets);
    return best === undefined ? "n/a" : `${formatE1rm(best)} ${props.unit}`;
  };

  return (
    <div class="stack">
      <Panel label="Session in progress" meta={`Started ${startedLabel()}`}>
        <dl class="stat-list">
          <div class="stat">
            <dt class="label">Sets</dt>
            <dd class="stat-value">{totals().sets}</dd>
          </div>
          <div class="stat">
            <dt class="label">Working volume</dt>
            <dd class="stat-value">{formatWeight(totals().volumeKg, props.unit)}</dd>
          </div>
          <div class="stat">
            <dt class="label">Top e1RM (Brzycki)</dt>
            <dd class="stat-value">
              {formatE1rm(totals().topE1rmKg)}
              <Show when={totals().topE1rmKg !== undefined}>
                <span class="stat-unit">{` ${props.unit}`}</span>
              </Show>
            </dd>
          </div>
        </dl>
      </Panel>

      <Index each={props.draft.entries}>
        {(entry) => (
          <section class="panel" aria-label={props.exerciseName(entry().exercise_id)}>
            <div class="panel-head">
              <h2 class="discipline-name">
                <A class="inline-link" href={`/exercises/${entry().exercise_id}`}>
                  {props.exerciseName(entry().exercise_id)}
                </A>
              </h2>
              <span class="panel-meta">{`Best e1RM (Brzycki): ${bestLabel(entry().sets)}`}</span>
            </div>
            <div class="panel-body">
              <div class="stack-tight">
                <Show when={entry().target}>
                  {(target) => (
                    <p class="panel-note">{`Target: ${formatTargetHint(target(), props.unit)}`}</p>
                  )}
                </Show>
                <SetLog
                  entry={entry()}
                  exerciseName={props.exerciseName(entry().exercise_id)}
                  unit={props.unit}
                  onAddSet={(input: DraftSetInput) =>
                    props.mutate((draft) => addSetToDraft(draft, entry().id, input))
                  }
                  onUpdateSet={(setId: string, patch: SetLogPatch) =>
                    props.mutate((draft) => updateSetInDraft(draft, setId, patch))
                  }
                  onRemoveSet={(setId: string) =>
                    props.mutate((draft) => removeSetFromDraft(draft, setId))
                  }
                />
              </div>
              <div class="form-actions mt-4">
                <button
                  type="button"
                  class="btn btn-quiet"
                  aria-label={`Remove ${props.exerciseName(entry().exercise_id)} from this session`}
                  onClick={() =>
                    props.mutate((draft) => removeExerciseFromDraft(draft, entry().id))
                  }
                >
                  Remove exercise
                </button>
              </div>
            </div>
          </section>
        )}
      </Index>

      <Show
        when={pickerOpen()}
        fallback={
          <div class="form-actions">
            <button
              type="button"
              class="btn btn-secondary"
              onClick={() => setPickerOpen(true)}
            >
              Add an exercise
            </button>
          </div>
        }
      >
        <ExercisePicker
          repos={props.repos}
          onPick={(exerciseId) =>
            props.mutate((draft) => addExerciseToDraft(draft, exerciseId))
          }
        />
        <div class="form-actions mt-4">
          <button type="button" class="btn btn-quiet" onClick={() => setPickerOpen(false)}>
            Hide exercise picker
          </button>
        </div>
      </Show>

      <div class="form-actions">
        <button type="button" class="btn btn-primary" onClick={props.onFinish}>
          Finish session
        </button>
        <button type="button" class="btn btn-secondary" onClick={props.onDiscard}>
          Discard
        </button>
      </div>
    </div>
  );
}
