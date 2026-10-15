/**
 * Log or edit one climbing session: day, duration, notes, and the
 * grade picker. A session needs at least one send to save, because a
 * climb with no sends is a rest day. Saving goes through the activity
 * repo, which derives the row's grade summary from the histogram and
 * queues one outbox op.
 */

import { createSignal, Show, type JSX } from "solid-js";
import type { Repos } from "../../db";
import type { ClimbLog } from "../../db/repos/activities";
import { emptySendCounts, normalizeSendCounts, totalSends } from "../../lib/climbing";
import { errorMessage } from "../../lib/errors";
import { createDurationField, createForm, createTextField } from "../../lib/forms";
import { createLocalDateField, optionalInputValue } from "../../lib/formInputs";
import { localDateString } from "../../lib/format";
import GradePicker from "./GradePicker";

export default function ClimbForm(props: {
  repos: Repos;
  /** The session being edited; absent means a fresh log. */
  initial?: ClimbLog | null;
  onSaved?: () => void;
}): JSX.Element {
  const [sends, setSends] = createSignal<number[]>(
    normalizeSendCounts(props.initial?.sends?.counts ?? []),
  );
  const [sendsError, setSendsError] = createSignal<string | null>(null);

  const form = createForm({
    fields: {
      date: createLocalDateField(props.initial?.activity.local_date ?? localDateString(new Date())),
      duration: createDurationField({ initial: props.initial?.activity.duration_min ?? null }),
      notes: createTextField({
        initial: props.initial?.activity.notes ?? "",
        trim: true,
      }),
    },
    submit: async (values) => {
      const counts = normalizeSendCounts(sends());
      if (totalSends(counts) === 0) {
        const problem = "Log at least one send before saving.";
        setSendsError(problem);
        throw new Error(problem);
      }
      setSendsError(null);
      const notes = values.notes.length > 0 ? values.notes : null;
      try {
        if (props.initial) {
          await props.repos.activities.update(props.initial.activity.id, {
            local_date: values.date,
            duration_min: values.duration,
            notes,
            sends: counts,
          });
        } else {
          await props.repos.activities.logActivity({
            type: "climbing",
            local_date: values.date,
            duration_min: values.duration,
            notes,
            sends: counts,
          });
        }
      } catch (cause) {
        throw new Error(errorMessage(cause, "That climb could not be saved."));
      }
      if (props.initial) {
        props.onSaved?.();
      } else {
        // Ready for the next session on the same form.
        form.fields.date.setValue(localDateString(new Date()));
        form.fields.duration.setValue(null);
        form.fields.notes.setValue("");
        setSends(emptySendCounts());
      }
    },
  });

  const updateSends = (next: number[]): void => {
    setSendsError(null);
    setSends(next);
  };

  const date = form.fields.date;
  const duration = form.fields.duration;
  const notes = form.fields.notes;
  const saving = () => form.status() === "saving";

  return (
    <form
      aria-label={props.initial ? "Edit climb" : "Log a climb"}
      onSubmit={(event) => {
        event.preventDefault();
        void form.submit();
      }}
      novalidate
    >
      <div class="form-row">
        <label class="label" for="climb-date">
          Date
        </label>
        <input
          class="input"
          id="climb-date"
          type="date"
          value={date.value()}
          onInput={(event) => date.setValue(event.currentTarget.value)}
          onBlur={date.markTouched}
          aria-invalid={date.error() ? "true" : undefined}
          aria-describedby={date.error() ? "climb-date-error" : undefined}
        />
        <Show when={date.error()}>
          <p class="form-hint" id="climb-date-error">
            {date.error()}
          </p>
        </Show>
      </div>

      <fieldset class="form-row form-fieldset">
        <legend class="label">Sends by grade</legend>
        <GradePicker value={sends()} onChange={updateSends} />
        <Show when={sendsError()}>
          <p class="form-hint" id="climb-sends-error" role="alert">
            {sendsError()}
          </p>
        </Show>
      </fieldset>

      <div class="form-row">
        <label class="label" for="climb-duration">
          Duration (min)
        </label>
        <input
          class="input"
          id="climb-duration"
          type="number"
          inputMode="numeric"
          min={0}
          max={1440}
          step={1}
          placeholder="90"
          value={optionalInputValue(duration.value())}
          onInput={(event) => duration.setValue(event.currentTarget.value)}
          onBlur={duration.markTouched}
          aria-invalid={duration.error() ? "true" : undefined}
          aria-describedby={duration.error() ? "climb-duration-error" : undefined}
        />
        <Show when={duration.error()}>
          <p class="form-hint" id="climb-duration-error">
            {duration.error()}
          </p>
        </Show>
      </div>

      <div class="form-row">
        <label class="label" for="climb-notes">
          Notes
        </label>
        <input
          class="input"
          id="climb-notes"
          type="text"
          placeholder="Project, training wall, skin status"
          value={notes.value()}
          onInput={(event) => notes.setValue(event.currentTarget.value)}
          onBlur={notes.markTouched}
          aria-invalid={notes.error() ? "true" : undefined}
          aria-describedby={notes.error() ? "climb-notes-error" : undefined}
        />
        <Show when={notes.error()}>
          <p class="form-hint" id="climb-notes-error">
            {notes.error()}
          </p>
        </Show>
      </div>

      <div class="form-actions mt-3">
        <button type="submit" class="btn btn-primary" disabled={saving()}>
          {saving() ? "Saving" : props.initial ? "Update climb" : "Log climb"}
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
