/**
 * Log or edit one ride: day, distance, elevation, duration, and notes.
 * Saving goes through the activity repo, which keeps the climb columns
 * null for cycling rows and queues one outbox op.
 */

import { Show, type JSX } from "solid-js";
import type { Activity } from "@waveform/api-types";
import type { Repos } from "../../db";
import type { LocalRow } from "../../db/types";
import { errorMessage } from "../../lib/errors";
import {
  createDistanceKmField,
  createDurationField,
  createElevationField,
  createForm,
  createTextField,
} from "../../lib/forms";
import { createLocalDateField, optionalInputValue } from "../../lib/formInputs";
import { localDateString } from "../../lib/format";

export default function RideForm(props: {
  repos: Repos;
  /** The ride being edited; absent means a fresh log. */
  initial?: LocalRow<Activity> | null;
  onSaved?: () => void;
}): JSX.Element {
  const form = createForm({
    fields: {
      date: createLocalDateField(props.initial?.local_date ?? localDateString(new Date())),
      distance: createDistanceKmField({ initial: props.initial?.distance_km ?? null }),
      elevation: createElevationField({ initial: props.initial?.elevation_m ?? null }),
      duration: createDurationField({ initial: props.initial?.duration_min ?? null }),
      notes: createTextField({
        initial: props.initial?.notes ?? "",
        trim: true,
      }),
    },
    submit: async (values) => {
      const notes = values.notes.length > 0 ? values.notes : null;
      try {
        if (props.initial) {
          await props.repos.activities.update(props.initial.id, {
            local_date: values.date,
            distance_km: values.distance,
            elevation_m: values.elevation,
            duration_min: values.duration,
            notes,
          });
        } else {
          await props.repos.activities.logActivity({
            type: "cycling",
            local_date: values.date,
            distance_km: values.distance,
            elevation_m: values.elevation,
            duration_min: values.duration,
            notes,
          });
        }
      } catch (cause) {
        throw new Error(errorMessage(cause, "That ride could not be saved."));
      }
      if (props.initial) {
        props.onSaved?.();
      } else {
        // Ready for the next ride on the same form.
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

  return (
    <form
      aria-label={props.initial ? "Edit ride" : "Log a ride"}
      onSubmit={(event) => {
        event.preventDefault();
        void form.submit();
      }}
      novalidate
    >
      <div class="form-row">
        <label class="label" for="ride-date">
          Date
        </label>
        <input
          class="input"
          id="ride-date"
          type="date"
          value={date.value()}
          onInput={(event) => date.setValue(event.currentTarget.value)}
          onBlur={date.markTouched}
          aria-invalid={date.error() ? "true" : undefined}
          aria-describedby={date.error() ? "ride-date-error" : undefined}
        />
        <Show when={date.error()}>
          <p class="form-hint" id="ride-date-error">
            {date.error()}
          </p>
        </Show>
      </div>

      <div class="form-row">
        <label class="label" for="ride-distance">
          Distance (km)
        </label>
        <input
          class="input"
          id="ride-distance"
          type="number"
          inputMode="decimal"
          step="any"
          placeholder="42.0"
          value={optionalInputValue(distance.value())}
          onInput={(event) => distance.setValue(event.currentTarget.value)}
          onBlur={distance.markTouched}
          aria-invalid={distance.error() ? "true" : undefined}
          aria-describedby={distance.error() ? "ride-distance-error" : undefined}
        />
        <Show when={distance.error()}>
          <p class="form-hint" id="ride-distance-error">
            {distance.error()}
          </p>
        </Show>
      </div>

      <div class="form-row">
        <label class="label" for="ride-elevation">
          Elevation (m)
        </label>
        <input
          class="input"
          id="ride-elevation"
          type="number"
          inputMode="decimal"
          step="any"
          placeholder="380"
          value={optionalInputValue(elevation.value())}
          onInput={(event) => elevation.setValue(event.currentTarget.value)}
          onBlur={elevation.markTouched}
          aria-invalid={elevation.error() ? "true" : undefined}
          aria-describedby={elevation.error() ? "ride-elevation-error" : undefined}
        />
        <Show when={elevation.error()}>
          <p class="form-hint" id="ride-elevation-error">
            {elevation.error()}
          </p>
        </Show>
      </div>

      <div class="form-row">
        <label class="label" for="ride-duration">
          Duration (min)
        </label>
        <input
          class="input"
          id="ride-duration"
          type="number"
          inputMode="numeric"
          min={0}
          max={1440}
          step={1}
          placeholder="80"
          value={optionalInputValue(duration.value())}
          onInput={(event) => duration.setValue(event.currentTarget.value)}
          onBlur={duration.markTouched}
          aria-invalid={duration.error() ? "true" : undefined}
          aria-describedby={duration.error() ? "ride-duration-error" : undefined}
        />
        <Show when={duration.error()}>
          <p class="form-hint" id="ride-duration-error">
            {duration.error()}
          </p>
        </Show>
      </div>

      <div class="form-row">
        <label class="label" for="ride-notes">
          Notes
        </label>
        <input
          class="input"
          id="ride-notes"
          type="text"
          placeholder="Route, weather, group ride"
          value={notes.value()}
          onInput={(event) => notes.setValue(event.currentTarget.value)}
          onBlur={notes.markTouched}
          aria-invalid={notes.error() ? "true" : undefined}
          aria-describedby={notes.error() ? "ride-notes-error" : undefined}
        />
        <Show when={notes.error()}>
          <p class="form-hint" id="ride-notes-error">
            {notes.error()}
          </p>
        </Show>
      </div>

      <div class="form-actions mt-3">
        <button type="submit" class="btn btn-primary" disabled={saving()}>
          {saving() ? "Saving" : props.initial ? "Update ride" : "Log ride"}
        </button>
      </div>

      <Show when={form.status() === "saved" && !props.initial}>
        <p class="form-status">Ride saved.</p>
      </Show>
      <Show when={form.error()}>
        <p class="form-status" role="alert">
          {form.error()}
        </p>
      </Show>
    </form>
  );
}
