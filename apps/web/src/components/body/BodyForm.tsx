/**
 * One body reading: day, weight, body fat, and a collapsible group of
 * the eight tape circumferences. The same form is the edit surface:
 * pass the stored row and the button reads "Update reading". Saving
 * always lands exactly one live row per day, because upsertBodyStat
 * patches a same-day row instead of adding a second one.
 */

import { For, Show, type JSX } from "solid-js";
import type { BodyStats } from "@waveform/api-types";
import type { Repos } from "../../db";
import type { LocalRow } from "../../db/types";
import { CIRCUMFERENCE_FIELDS, toBodyStatInput } from "../../lib/bodyReadings";
import { errorMessage } from "../../lib/errors";
import {
  createBodyFatField,
  createBodyWeightField,
  createCircumferenceField,
  createForm,
  type FieldHandle,
  type OptionalNumberInput,
} from "../../lib/forms";
import { createLocalDateField, optionalInputValue } from "../../lib/formInputs";
import { localDateString } from "../../lib/format";

/** One label and bounded numeric box for a nullable figure. */
function FigureRow(props: {
  id: string;
  label: string;
  handle: FieldHandle<OptionalNumberInput>;
}): JSX.Element {
  return (
    <div class="form-row">
      <label class="label" for={props.id}>
        {props.label}
      </label>
      <input
        class="input"
        id={props.id}
        type="number"
        inputMode="decimal"
        step="any"
        placeholder="0.0"
        value={optionalInputValue(props.handle.value())}
        onInput={(event) => props.handle.setValue(event.currentTarget.value)}
        onBlur={props.handle.markTouched}
        aria-invalid={props.handle.error() ? "true" : undefined}
        aria-describedby={props.handle.error() ? `${props.id}-error` : undefined}
      />
      <Show when={props.handle.error()}>
        <p class="form-hint" id={`${props.id}-error`}>
          {props.handle.error()}
        </p>
      </Show>
    </div>
  );
}

export default function BodyForm(props: {
  repos: Repos;
  /** The stored reading being edited; absent means a fresh entry. */
  initial?: LocalRow<BodyStats> | null;
  onSaved?: () => void;
}): JSX.Element {
  const editing = props.initial != null;

  const form = createForm({
    fields: {
      local_date: createLocalDateField(props.initial?.local_date ?? localDateString(new Date())),
      weight_kg: createBodyWeightField({ initial: props.initial?.weight_kg ?? null }),
      bodyfat_pct: createBodyFatField({ initial: props.initial?.bodyfat_pct ?? null }),
      neck_cm: createCircumferenceField({ initial: props.initial?.neck_cm ?? null }),
      shoulders_cm: createCircumferenceField({ initial: props.initial?.shoulders_cm ?? null }),
      chest_cm: createCircumferenceField({ initial: props.initial?.chest_cm ?? null }),
      bicep_cm: createCircumferenceField({ initial: props.initial?.bicep_cm ?? null }),
      waist_cm: createCircumferenceField({ initial: props.initial?.waist_cm ?? null }),
      hips_cm: createCircumferenceField({ initial: props.initial?.hips_cm ?? null }),
      thigh_cm: createCircumferenceField({ initial: props.initial?.thigh_cm ?? null }),
      calf_cm: createCircumferenceField({ initial: props.initial?.calf_cm ?? null }),
    },
    submit: async (values) => {
      const hasAnyFigure =
        values.weight_kg !== null ||
        values.bodyfat_pct !== null ||
        CIRCUMFERENCE_FIELDS.some((field) => values[field.key] !== null);
      if (!hasAnyFigure) {
        throw new Error("Enter at least one measurement.");
      }
      try {
        await props.repos.body.upsertBodyStat(
          toBodyStatInput(values, editing ? "edit" : "create"),
        );
      } catch (cause) {
        throw new Error(errorMessage(cause, "That reading could not be saved."));
      }
      if (editing) {
        props.onSaved?.();
      }
    },
  });

  const date = form.fields.local_date;
  const saving = () => form.status() === "saving";
  const hasTape = (): boolean =>
    props.initial != null &&
    CIRCUMFERENCE_FIELDS.some((field) => props.initial?.[field.key] != null);

  return (
    <form
      aria-label={editing ? "Update body reading" : "Log body reading"}
      onSubmit={(event) => {
        event.preventDefault();
        void form.submit();
      }}
      novalidate
    >
      <div class="form-row">
        <label class="label" for="body-local_date">
          Date
        </label>
        <input
          class="input"
          id="body-local_date"
          type="date"
          value={date.value()}
          onInput={(event) => date.setValue(event.currentTarget.value)}
          onBlur={date.markTouched}
          aria-invalid={date.error() ? "true" : undefined}
          aria-describedby={date.error() ? "body-local_date-error" : undefined}
        />
        <Show when={date.error()}>
          <p class="form-hint" id="body-local_date-error">
            {date.error()}
          </p>
        </Show>
      </div>

      <FigureRow id="body-weight" label="Weight (kg)" handle={form.fields.weight_kg} />
      <FigureRow id="body-bodyfat" label="Body fat (%)" handle={form.fields.bodyfat_pct} />

      <details class="form-details" open={hasTape()}>
        <summary class="label">Circumferences (cm)</summary>
        <For each={CIRCUMFERENCE_FIELDS}>
          {(field) => (
            <FigureRow
              id={`body-${field.key}`}
              label={`${field.label} (cm)`}
              handle={form.fields[field.key]}
            />
          )}
        </For>
      </details>

      <div class="form-actions mt-3">
        <button type="submit" class="btn btn-primary" disabled={saving()}>
          {saving() ? "Saving" : editing ? "Update reading" : "Save reading"}
        </button>
      </div>

      <Show when={form.status() === "saved" && !editing}>
        <p class="form-status">Reading saved.</p>
      </Show>
      <Show when={form.error()}>
        <p class="form-status" role="alert">
          {form.error()}
        </p>
      </Show>
    </form>
  );
}
