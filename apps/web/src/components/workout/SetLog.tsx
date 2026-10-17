import { e1rmBrzycki } from "@waveform/scoring";
import { createEffect, createUniqueId, createSignal, Index, Show } from "solid-js";
import { SET_RULES } from "../../db/validation";
import { formatE1rm, toDisplayWeight, type WeightUnit } from "../../lib/format";
import { createIdChangeTracker } from "../../lib/rowResync";
import { parseRepsInput, parseSetInput, parseWeightInput, weightInputBounds } from "../../lib/setInput";
import type { DraftSetInput } from "../../lib/workoutLog";
import type { WorkoutDraftEntry, WorkoutDraftSet } from "../../db/types";

export type SetLogPatch = { weight_kg?: number; reps?: number; is_warmup?: boolean };

type SetLogProps = {
  entry: WorkoutDraftEntry;
  /** Shown in labels and captions; the exercise this slot logs. */
  exerciseName: string;
  /** The profile's display weight unit; the draft stores kg underneath. */
  unit: WeightUnit;
  onAddSet(input: DraftSetInput): void;
  onUpdateSet(setId: string, patch: SetLogPatch): void;
  onRemoveSet(setId: string): void;
};

/**
 * One exercise slot's sets: an editable telemetry table plus the add-set
 * form. Every keystroke is parsed against SET_RULES before a reducer
 * touches the draft, so a half-typed number can never reach the log, and
 * the weight inputs carry display-unit min/max from weightInputBounds
 * so the native constraints match the unit on the label.
 */
export default function SetLog(props: SetLogProps) {
  const [weightText, setWeightText] = createSignal("");
  const [repsText, setRepsText] = createSignal("");
  const [warmup, setWarmup] = createSignal(false);
  const [issues, setIssues] = createSignal<string[]>([]);
  const weightId = createUniqueId();
  const repsId = createUniqueId();

  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    const parsed = parseSetInput(weightText(), repsText(), props.unit);
    if (!parsed.ok) {
      setIssues(parsed.issues);
      return;
    }
    setIssues([]);
    props.onAddSet({
      weight_kg: parsed.weight_kg,
      reps: parsed.reps,
      is_warmup: warmup(),
    });
    // The next set usually repeats the weight; reps always change.
    setRepsText("");
    setWarmup(false);
  };

  return (
    <div class="stack-tight">
      <div class="table-wrap">
        <table class="data-table">
          <caption class="sr-only">
            {`Set log for ${props.exerciseName}: set number, weight in ${props.unit}, reps, warmup marks, and e1RM (Brzycki).`}
          </caption>
          <thead>
            <tr>
              <th scope="col">Set</th>
              <th scope="col">{`Weight (${props.unit})`}</th>
              <th scope="col">Reps</th>
              <th scope="col">Warmup</th>
              <th scope="col">e1RM (Brzycki)</th>
              <th scope="col">
                <span class="sr-only">Row actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <Index each={props.entry.sets}>
              {(set) => (
                <SetRow
                  set={set()}
                  unit={props.unit}
                  onUpdate={(patch) => props.onUpdateSet(set().id, patch)}
                  onRemove={() => props.onRemoveSet(set().id)}
                />
              )}
            </Index>
          </tbody>
        </table>
      </div>

      <form aria-label={`Add a set to ${props.exerciseName}`} onSubmit={submit} novalidate>
        <div class="set-add">
          <label class="label" for={weightId}>
            {`Weight (${props.unit})`}
          </label>
          <input
            class="input input-sm"
            id={weightId}
            type="number"
            inputMode="decimal"
            step="any"
            min={weightInputBounds(props.unit).min}
            max={weightInputBounds(props.unit).max}
            placeholder={props.unit}
            value={weightText()}
            onInput={(event) => setWeightText(event.currentTarget.value)}
          />
          <label class="label" for={repsId}>
            Reps
          </label>
          <input
            class="input input-sm"
            id={repsId}
            type="number"
            inputMode="numeric"
            step="1"
            min={SET_RULES.repsMin}
            max={SET_RULES.repsMax}
            placeholder="5"
            value={repsText()}
            onInput={(event) => setRepsText(event.currentTarget.value)}
          />
          <label class="label">
            <input
              class="input-check"
              type="checkbox"
              checked={warmup()}
              onChange={(event) => setWarmup(event.currentTarget.checked)}
            />
            Warmup
          </label>
          <button type="submit" class="btn btn-secondary">
            Add set
          </button>
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
    </div>
  );
}

/**
 * One editable set row. The raw text lives here, so a half-typed number
 * stays visible while the draft only ever receives parsed values.
 */
function SetRow(props: {
  set: WorkoutDraftSet;
  unit: WeightUnit;
  onUpdate(patch: SetLogPatch): void;
  onRemove(): void;
}) {
  // Reactive so a removed set renumbers the rows below it.
  const label = (): string => `Set ${props.set.set_index + 1}`;
  const weightHintId = createUniqueId();
  const repsHintId = createUniqueId();
  const [weightText, setWeightText] = createSignal(
    String(toDisplayWeight(props.set.weight_kg, props.unit)),
  );
  const [repsText, setRepsText] = createSignal(String(props.set.reps));
  const [weightError, setWeightError] = createSignal<string | null>(null);
  const [repsError, setRepsError] = createSignal<string | null>(null);

  // `<Index>` reuses this instance per position, so removing a set shifts
  // the next one under it. Resync the raw text and errors from the set now
  // at this position, or a blur would commit the old set's values.
  const tracker = createIdChangeTracker(props.set.id);
  createEffect(() => {
    const set = props.set;
    if (!tracker.isNew(set.id)) {
      return;
    }
    setWeightText(String(toDisplayWeight(set.weight_kg, props.unit)));
    setRepsText(String(set.reps));
    setWeightError(null);
    setRepsError(null);
  });

  const onWeightInput = (text: string): void => {
    setWeightText(text);
    const parsed = parseWeightInput(text, props.unit);
    if (parsed.ok) {
      setWeightError(null);
      props.onUpdate({ weight_kg: parsed.weight_kg });
      return;
    }
    setWeightError(text.trim() === "" ? null : parsed.issue);
  };

  const onWeightBlur = (): void => {
    const parsed = parseWeightInput(weightText(), props.unit);
    setWeightError(parsed.ok ? null : parsed.issue);
  };

  const onRepsInput = (text: string): void => {
    setRepsText(text);
    const parsed = parseRepsInput(text);
    if (parsed.ok) {
      setRepsError(null);
      props.onUpdate({ reps: parsed.reps });
      return;
    }
    setRepsError(text.trim() === "" ? null : parsed.issue);
  };

  const onRepsBlur = (): void => {
    const parsed = parseRepsInput(repsText());
    setRepsError(parsed.ok ? null : parsed.issue);
  };

  return (
    <tr>
      <td>
        <span class="num">{props.set.set_index + 1}</span>
      </td>
      <td>
        <input
          class="input input-sm"
          type="number"
          inputMode="decimal"
          step="any"
          min={weightInputBounds(props.unit).min}
          max={weightInputBounds(props.unit).max}
          aria-label={`${label()} weight in ${props.unit}`}
          aria-invalid={weightError() ? "true" : undefined}
          aria-describedby={weightError() ? weightHintId : undefined}
          value={weightText()}
          onInput={(event) => onWeightInput(event.currentTarget.value)}
          onBlur={onWeightBlur}
        />
        <Show when={weightError()}>
          <p class="form-hint" id={weightHintId}>
            {weightError()}
          </p>
        </Show>
      </td>
      <td>
        <input
          class="input input-sm"
          type="number"
          inputMode="numeric"
          step="1"
          min={SET_RULES.repsMin}
          max={SET_RULES.repsMax}
          aria-label={`${label()} reps`}
          aria-invalid={repsError() ? "true" : undefined}
          aria-describedby={repsError() ? repsHintId : undefined}
          value={repsText()}
          onInput={(event) => onRepsInput(event.currentTarget.value)}
          onBlur={onRepsBlur}
        />
        <Show when={repsError()}>
          <p class="form-hint" id={repsHintId}>
            {repsError()}
          </p>
        </Show>
      </td>
      <td>
        <input
          class="input-check"
          type="checkbox"
          aria-label={`${label()} warmup`}
          checked={props.set.is_warmup}
          onChange={(event) => props.onUpdate({ is_warmup: event.currentTarget.checked })}
        />
      </td>
      <td>
        <span class="num">{formatE1rm(e1rmBrzycki(props.set.weight_kg, props.set.reps))}</span>
      </td>
      <td>
        <div class="row-actions">
          <button
            type="button"
            class="btn btn-quiet"
            aria-label={`Remove ${label()}`}
            onClick={props.onRemove}
          >
            Remove
          </button>
        </div>
      </td>
    </tr>
  );
}
