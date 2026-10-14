import { A } from "@solidjs/router";
import { For, Show } from "solid-js";

export type EmptyAction = {
  label: string;
  /** Real destination when one exists; otherwise the action renders disabled. */
  href?: string;
  variant?: "primary" | "secondary";
};

/**
 * An empty state is an invitation to act: a specific title, one plain sentence
 * about what will appear here, and the action that makes it appear.
 */
export default function EmptyState(props: {
  title: string;
  body: string;
  actions?: EmptyAction[];
  note?: string;
}) {
  return (
    <div class="empty">
      <p class="empty-title">{props.title}</p>
      <p class="empty-body">{props.body}</p>
      <Show when={props.actions && props.actions.length > 0}>
        <div class="empty-actions">
          <For each={props.actions}>
            {(action) =>
              action.href ? (
                <A href={action.href} class={`btn btn-${action.variant ?? "primary"}`}>
                  {action.label}
                </A>
              ) : (
                <button
                  type="button"
                  class="btn btn-secondary"
                  disabled
                  title="Arrives with the data layer"
                >
                  {action.label}
                </button>
              )
            }
          </For>
        </div>
      </Show>
      <Show when={props.note}>
        <p class="empty-note label">{props.note}</p>
      </Show>
    </div>
  );
}
