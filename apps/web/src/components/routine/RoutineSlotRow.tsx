/**
 * One planned exercise in a routine: the movement, its target sets, reps,
 * and optional target weight, plus the reorder and remove controls. The
 * target boxes keep their raw text and only write a value the repo guard
 * accepts, mirroring the set logger's rows.
 */

import type { Exercise, RoutineEntry } from "@waveform/api-types";
import { createEffect, createSignal, createUniqueId, For, Show, type JSX } from "solid-js";
import type { LocalRow } from "../../db/types";
import { ROUTINE_RULES } from "../../db/validation";
import { toDisplayWeight, type WeightUnit } from "../../lib/format";
import { optionalInputValue } from "../../lib/formInputs";
import {
  parseTargetCountInput,
  parseTargetWeightInput,
  routineRepsField,
  routineSetsField,
} from "../../lib/routines";
import { createIdChangeTracker } from "../../lib/rowResync";

export type RoutineSlotPatch = {
  exercise_id?: string;
  target_sets?: number;
  target_reps?: number;
  target_weight_kg?: number | null;
};

export default function RoutineSlotRow(props: {
  entry: LocalRow<RoutineEntry>;
  index: number;
  count: number;
  /** Accessor so a settings change is reflected while the editor is open. */
  unit: () => WeightUnit;
  /** True while another entry write is in flight; row actions are disabled. */
  busy: boolean;
  exercises: readonly LocalRow<Exercise>[];
  onChange(patch: RoutineSlotPatch): void;
  onMove(direction: -1 | 1): void;
  onRemove(): void;
}): JSX.Element {
  const [setsText, setSetsText] = createSignal(String(props.entry.target_sets));
  const [repsText, setRepsText] = createSignal(String(props.entry.target_reps));
  const [weightText, setWeightText] = createSignal(
    props.entry.target_weight_kg === null
      ? ""
      : String(toDisplayWeight(props.entry.target_weight_kg, props.unit())),
  );
  const [setsError, setSetsError] = createSignal<string | null>(null);
  const [repsError, setRepsError] = createSignal<string | null>(null);
  const [weightError, setWeightError] = createSignal<string | null>(null);
  const setsHintId = createUniqueId();
  const repsHintId = createUniqueId();
  const weightHintId = createUniqueId();

  // `<Index>` reuses this instance per position, so when a move or remove
  // shifts a new entry under it the text and errors must resync from that
  // entry. Without this, blurring a moved row would commit its stale text
  // against the new entry's targets.
  const tracker = createIdChangeTracker(`${props.entry.id}:${props.unit()}`);
  createEffect(() => {
    const entry = props.entry;
    const unit = props.unit();
    if (!tracker.isNew(`${entry.id}:${unit}`)) {
      return;
    }
    setSetsText(String(entry.target_sets));
    setRepsText(String(entry.target_reps));
    setWeightText(
      entry.target_weight_kg === null
        ? ""
        : String(toDisplayWeight(entry.target_weight_kg, unit)),
    );
    setSetsError(null);
    setRepsError(null);
    setWeightError(null);
  });

  const currentName = (): string =>
    props.exercises.find((exercise) => exercise.id === props.entry.exercise_id)?.name ??
    "Unavailable exercise";
  const known = (): boolean =>
    props.exercises.some((exercise) => exercise.id === props.entry.exercise_id);

  const commitSets = (): void => {
    const parsed = parseTargetCountInput(setsText(), routineSetsField);
    if (!parsed.ok) {
      setSetsError(parsed.issue);
      return;
    }
    setSetsError(null);
    if (parsed.value !== props.entry.target_sets) {
      props.onChange({ target_sets: parsed.value });
    }
  };

  const commitReps = (): void => {
    const parsed = parseTargetCountInput(repsText(), routineRepsField);
    if (!parsed.ok) {
      setRepsError(parsed.issue);
      return;
    }
    setRepsError(null);
    if (parsed.value !== props.entry.target_reps) {
      props.onChange({ target_reps: parsed.value });
    }
  };

  const commitWeight = (): void => {
    const parsed = parseTargetWeightInput(weightText(), props.unit());
    if (!parsed.ok) {
      setWeightError(parsed.issue);
      return;
    }
    setWeightError(null);
    if (parsed.weight_kg !== props.entry.target_weight_kg) {
      props.onChange({ target_weight_kg: parsed.weight_kg });
    }
  };

  return (
    <tr>
      <td>
        <span class="num">{props.index + 1}</span>
      </td>
      <td>
        <select
          class="input input-sm"
          aria-label={`Exercise for planned slot ${props.index + 1}`}
          value={props.entry.exercise_id}
          onChange={(event) => props.onChange({ exercise_id: event.currentTarget.value })}
        >
          <Show when={!known()}>
            <option value={props.entry.exercise_id}>Unavailable exercise</option>
          </Show>
          <For each={props.exercises}>
            {(exercise) => <option value={exercise.id}>{exercise.name}</option>}
          </For>
        </select>
      </td>
      <td>
        <input
          class="input input-sm"
          type="number"
          inputMode="numeric"
          step="1"
          min={ROUTINE_RULES.targetSetsMin}
          max={ROUTINE_RULES.targetSetsMax}
          aria-label={`${currentName()} target sets`}
          aria-invalid={setsError() ? "true" : undefined}
          aria-describedby={setsError() ? setsHintId : undefined}
          value={setsText()}
          onInput={(event) => {
            setSetsText(event.currentTarget.value);
            setSetsError(null);
          }}
          onBlur={commitSets}
        />
        <Show when={setsError()}>
          <p class="form-hint" id={setsHintId}>
            {setsError()}
          </p>
        </Show>
      </td>
      <td>
        <input
          class="input input-sm"
          type="number"
          inputMode="numeric"
          step="1"
          min={ROUTINE_RULES.targetRepsMin}
          max={ROUTINE_RULES.targetRepsMax}
          aria-label={`${currentName()} target reps`}
          aria-invalid={repsError() ? "true" : undefined}
          aria-describedby={repsError() ? repsHintId : undefined}
          value={repsText()}
          onInput={(event) => {
            setRepsText(event.currentTarget.value);
            setRepsError(null);
          }}
          onBlur={commitReps}
        />
        <Show when={repsError()}>
          <p class="form-hint" id={repsHintId}>
            {repsError()}
          </p>
        </Show>
      </td>
      <td>
        <input
          class="input input-sm"
          type="number"
          inputMode="decimal"
          step="any"
          placeholder={props.unit()}
          aria-label={`${currentName()} target weight in ${props.unit()}`}
          aria-invalid={weightError() ? "true" : undefined}
          aria-describedby={weightError() ? weightHintId : undefined}
          value={optionalInputValue(weightText())}
          onInput={(event) => {
            setWeightText(event.currentTarget.value);
            setWeightError(null);
          }}
          onBlur={commitWeight}
        />
        <Show when={weightError()}>
          <p class="form-hint" id={weightHintId}>
            {weightError()}
          </p>
        </Show>
      </td>
      <td>
        <div class="row-actions">
          <button
            type="button"
            class="btn btn-quiet"
            disabled={props.busy || props.index === 0}
            aria-label={`Up: move ${currentName()} earlier`}
            onClick={() => props.onMove(-1)}
          >
            Up
          </button>
          <button
            type="button"
            class="btn btn-quiet"
            disabled={props.busy || props.index === props.count - 1}
            aria-label={`Down: move ${currentName()} later`}
            onClick={() => props.onMove(1)}
          >
            Down
          </button>
          <button
            type="button"
            class="btn btn-quiet"
            disabled={props.busy}
            aria-label={`Remove ${currentName()} from this routine`}
            onClick={props.onRemove}
          >
            Remove
          </button>
        </div>
      </td>
    </tr>
  );
}
