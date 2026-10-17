/**
 * The shared routine name and notes form. It owns validation and the
 * submit lifecycle; the caller supplies the repo write, so the same form
 * serves both "Create routine" and "Save routine".
 */

import { Show, type JSX } from "solid-js";
import { ROUTINE_NAME_MAX_LENGTH } from "../../db/validation";
import { errorMessage } from "../../lib/errors";
import { createForm, createTextField } from "../../lib/forms";

export type RoutineFormValues = {
  name: string;
  notes: string | null;
};

export default function RoutineForm(props: {
  initial?: { name: string; notes: string | null };
  submitLabel: string;
  onSubmit(values: RoutineFormValues): Promise<void>;
  onCancel?(): void;
}): JSX.Element {
  const form = createForm({
    fields: {
      name: createTextField({
        initial: props.initial?.name ?? "",
        trim: true,
        required: true,
        maxLength: ROUTINE_NAME_MAX_LENGTH,
      }),
      notes: createTextField({
        initial: props.initial?.notes ?? "",
        trim: true,
      }),
    },
    submit: async (values) => {
      const notes = values.notes.length > 0 ? values.notes : null;
      try {
        await props.onSubmit({ name: values.name, notes });
      } catch (cause) {
        throw new Error(errorMessage(cause, "That routine could not be saved."));
      }
    },
  });

  const name = form.fields.name;
  const notes = form.fields.notes;
  const saving = () => form.status() === "saving";

  return (
    <form
      aria-label={props.submitLabel}
      onSubmit={(event) => {
        event.preventDefault();
        void form.submit();
      }}
      novalidate
    >
      <div class="form-row">
        <label class="label" for="routine-name">
          Name
        </label>
        <input
          class="input"
          id="routine-name"
          type="text"
          maxlength={ROUTINE_NAME_MAX_LENGTH}
          placeholder="Push day, 5x5 A, Saturday legs"
          value={name.value()}
          onInput={(event) => name.setValue(event.currentTarget.value)}
          onBlur={name.markTouched}
          aria-invalid={name.error() ? "true" : undefined}
          aria-describedby={name.error() ? "routine-name-error" : undefined}
        />
        <Show when={name.error()}>
          <p class="form-hint" id="routine-name-error">
            {name.error()}
          </p>
        </Show>
      </div>

      <div class="form-row">
        <label class="label" for="routine-notes">
          Notes (optional)
        </label>
        <input
          class="input"
          id="routine-notes"
          type="text"
          placeholder="Warm up, rest targets, what to swap when the rack is taken"
          value={notes.value()}
          onInput={(event) => notes.setValue(event.currentTarget.value)}
          onBlur={notes.markTouched}
        />
      </div>

      <div class="form-actions">
        <button type="submit" class="btn btn-secondary" disabled={saving()}>
          {saving() ? "Saving" : props.submitLabel}
        </button>
        <Show when={props.onCancel}>
          <button type="button" class="btn btn-quiet" onClick={() => props.onCancel?.()}>
            Cancel
          </button>
        </Show>
      </div>

      <Show when={form.error()}>
        <p class="form-status" role="alert">
          {form.error()}
        </p>
      </Show>
    </form>
  );
}
