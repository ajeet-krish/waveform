/**
 * Log or edit one endurance session: running, hike, or swim. One
 * type-parameterized form carries the day, a required duration, optional
 * distance and elevation, and notes. Swim hides elevation; running and
 * hike show both distance and elevation. Saving goes through the
 * activity repo, which keeps the climb columns null for endurance rows
 * and queues one outbox op.
 */

import { Show, type JSX } from "solid-js";
import type { Activity } from "@waveform/api-types";
import type { Repos } from "../../db";
import type { LocalRow } from "../../db/types";
import { errorMessage } from "../../lib/errors";
import {
  createDistanceKmField,
  createElevationField,
  createForm,
  createRequiredDurationField,
  createTextField,
} from "../../lib/forms";
import { createLocalDateField, optionalInputValue } from "../../lib/formInputs";
import { localDateString } from "../../lib/format";

/** The endurance activity types this shared form logs. */
export type EnduranceType = "running" | "hike" | "swim";

/** The noun each endurance type speaks in. */
const NOUN_BY_TYPE: Readonly<Record<EnduranceType, string>> = {
  running: "run",
  hike: "hike",
  swim: "swim",
};

/** A distance placeholder that reads plausibly per type. */
const DISTANCE_PLACEHOLDER: Readonly<Record<EnduranceType, string>> = {
  running: "10.0",
  hike: "12.5",
  swim: "1.5",
};

export default function EnduranceForm(props: {
  repos: Repos;
  /** Which endurance discipline this form logs. */
  type: EnduranceType;
  /** The session being edited; absent means a fresh log. */
  initial?: LocalRow<Activity> | null;
  onSaved?: () => void;
}): JSX.Element {
  const noun = NOUN_BY_TYPE[props.type];
  const showElevation = props.type !== "swim";

  // Divergence from the schema, kept deliberately: duration_min is
  // nullable in activities, but this form requires it on create AND edit,
  // because an endurance session with no time on the clock is not a
  // session. The consequence is that a legacy null-duration endurance row
  // (from sync or a backup import) cannot be saved unchanged through this
  // form; every other surface treats a null duration benignly, and
  // RideForm keeps it optional. createRequiredDurationField owns the
  // guard. distance and elevation reject negatives in their shared
  // builders, so RideForm and this form agree.
  const form = createForm({
    fields: {
      date: createLocalDateField(props.initial?.local_date ?? localDateString(new Date())),
      distance: createDistanceKmField({ initial: props.initial?.distance_km ?? null }),
      elevation: createElevationField({ initial: props.initial?.elevation_m ?? null }),
      duration: createRequiredDurationField({ initial: props.initial?.duration_min ?? null }),
      notes: createTextField({
        initial: props.initial?.notes ?? "",
        trim: true,
      }),
    },
    submit: async (values) => {
      const notes = values.notes.length > 0 ? values.notes : null;
      const elevation = showElevation ? values.elevation : null;
      try {
        if (props.initial) {
          await props.repos.activities.update(props.initial.id, {
            local_date: values.date,
            distance_km: values.distance,
            elevation_m: elevation,
            duration_min: values.duration,
            notes,
          });
        } else {
          await props.repos.activities.logActivity({
            type: props.type,
            local_date: values.date,
            distance_km: values.distance,
            elevation_m: elevation,
            duration_min: values.duration,
            notes,
          });
        }
      } catch (cause) {
        throw new Error(errorMessage(cause, `That ${noun} could not be saved.`));
      }
      if (props.initial) {
        props.onSaved?.();
      } else {
        // Ready for the next session on the same form.
        form.fields.date.setValue(localDateString(new Date()));
        form.fields.distance.setValue(null);
        form.fields.elevation.setValue(null);
        form.fields.duration.setValue(null);
        form.fields.notes.setValue("");
      }
    },
  });

  const date = form.fields.date;
  const distance = form.fields.distance;
  const elevation = form.fields.elevation;
  const duration = form.fields.duration;
  const notes = form.fields.notes;
  const saving = () => form.status() === "saving";
  const idPrefix = props.type;

  return (
    <form
      aria-label={props.initial ? `Edit ${noun}` : `Log ${noun}`}
      onSubmit={(event) => {
        event.preventDefault();
        void form.submit();
      }}
      novalidate
    >
      <div class="form-row">
        <label class="label" for={`${idPrefix}-date`}>
          Date
        </label>
        <input
          class="input"
          id={`${idPrefix}-date`}
          type="date"
          value={date.value()}
          onInput={(event) => date.setValue(event.currentTarget.value)}
          onBlur={date.markTouched}
          aria-invalid={date.error() ? "true" : undefined}
          aria-describedby={date.error() ? `${idPrefix}-date-error` : undefined}
        />
        <Show when={date.error()}>
          <p class="form-hint" id={`${idPrefix}-date-error`}>
            {date.error()}
          </p>
        </Show>
      </div>

      <div class="form-row">
        <label class="label" for={`${idPrefix}-duration`}>
          Duration (min)
        </label>
        <input
          class="input"
          id={`${idPrefix}-duration`}
          type="number"
          inputMode="numeric"
          min={0}
          max={1440}
          step={1}
          placeholder="45"
          value={optionalInputValue(duration.value())}
          onInput={(event) => duration.setValue(event.currentTarget.value)}
          onBlur={duration.markTouched}
          aria-invalid={duration.error() ? "true" : undefined}
          aria-describedby={duration.error() ? `${idPrefix}-duration-error` : undefined}
        />
        <Show when={duration.error()}>
          <p class="form-hint" id={`${idPrefix}-duration-error`}>
            {duration.error()}
          </p>
        </Show>
      </div>

      <div class="form-row">
        <label class="label" for={`${idPrefix}-distance`}>
          Distance (km)
        </label>
        <input
          class="input"
          id={`${idPrefix}-distance`}
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          placeholder={DISTANCE_PLACEHOLDER[props.type]}
          value={optionalInputValue(distance.value())}
          onInput={(event) => distance.setValue(event.currentTarget.value)}
          onBlur={distance.markTouched}
          aria-invalid={distance.error() ? "true" : undefined}
          aria-describedby={distance.error() ? `${idPrefix}-distance-error` : undefined}
        />
        <Show when={distance.error()}>
          <p class="form-hint" id={`${idPrefix}-distance-error`}>
            {distance.error()}
          </p>
        </Show>
      </div>

      <Show when={showElevation}>
        <div class="form-row">
          <label class="label" for={`${idPrefix}-elevation`}>
            Elevation (m)
          </label>
          <input
            class="input"
            id={`${idPrefix}-elevation`}
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            placeholder="320"
            value={optionalInputValue(elevation.value())}
            onInput={(event) => elevation.setValue(event.currentTarget.value)}
            onBlur={elevation.markTouched}
            aria-invalid={elevation.error() ? "true" : undefined}
            aria-describedby={elevation.error() ? `${idPrefix}-elevation-error` : undefined}
          />
          <Show when={elevation.error()}>
            <p class="form-hint" id={`${idPrefix}-elevation-error`}>
              {elevation.error()}
            </p>
          </Show>
        </div>
      </Show>

      <div class="form-row">
        <label class="label" for={`${idPrefix}-notes`}>
          Notes
        </label>
        <input
          class="input"
          id={`${idPrefix}-notes`}
          type="text"
          placeholder="Route, weather, how it felt"
          value={notes.value()}
          onInput={(event) => notes.setValue(event.currentTarget.value)}
          onBlur={notes.markTouched}
          aria-invalid={notes.error() ? "true" : undefined}
          aria-describedby={notes.error() ? `${idPrefix}-notes-error` : undefined}
        />
        <Show when={notes.error()}>
          <p class="form-hint" id={`${idPrefix}-notes-error`}>
            {notes.error()}
          </p>
        </Show>
      </div>

      <div class="form-actions mt-3">
        <button type="submit" class="btn btn-primary" disabled={saving()}>
          {saving() ? "Saving" : props.initial ? `Update ${noun}` : `Log ${noun}`}
        </button>
      </div>

      <Show when={form.status() === "saved" && !props.initial}>
        <p class="form-status">Session saved.</p>
      </Show>
      <Show when={form.error()}>
        <p class="form-status" role="alert">
          {form.error()}
        </p>
      </Show>
    </form>
  );
}
