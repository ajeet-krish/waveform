import { createUniqueId, onCleanup, onMount, Show } from "solid-js";

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * An accessible confirm step for a destructive action: focus lands on
 * Cancel when the dialog opens, Escape cancels, Tab stays inside the
 * dialog, and focus returns to whatever opened it on close.
 */
export default function ConfirmDialog(props: ConfirmDialogProps) {
  const titleId = createUniqueId();
  const bodyId = createUniqueId();
  return (
    <Show when={props.open}>
      <ConfirmLayer
        title={props.title}
        body={props.body}
        confirmLabel={props.confirmLabel}
        cancelLabel={props.cancelLabel}
        onConfirm={props.onConfirm}
        onCancel={props.onCancel}
        titleId={titleId}
        bodyId={bodyId}
      />
    </Show>
  );
}

type ConfirmLayerProps = Omit<ConfirmDialogProps, "open"> & {
  titleId: string;
  bodyId: string;
};

function ConfirmLayer(props: ConfirmLayerProps) {
  let dialogRef: HTMLDivElement | undefined;
  let cancelRef: HTMLButtonElement | undefined;
  let previous: HTMLElement | null = null;

  const focusables = (): HTMLElement[] => {
    const root = dialogRef;
    if (!root) {
      return [];
    }
    return Array.from(
      root.querySelectorAll<HTMLElement>(
        "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
      ),
    );
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onCancel();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const items = focusables();
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      return;
    }
    const active = document.activeElement;
    const inside = active instanceof Node && dialogRef?.contains(active) === true;
    if (event.shiftKey && (!inside || active === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (!inside || active === last)) {
      event.preventDefault();
      first.focus();
    }
  };

  onMount(() => {
    previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef?.focus();
    document.addEventListener("keydown", onKeyDown);
  });

  onCleanup(() => {
    document.removeEventListener("keydown", onKeyDown);
    if (previous && document.contains(previous)) {
      previous.focus();
    }
  });

  const onBackdropClick = (event: MouseEvent): void => {
    if (event.target === event.currentTarget) {
      props.onCancel();
    }
  };

  return (
    <div class="dialog-backdrop" onClick={onBackdropClick}>
      <div
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={props.titleId}
        aria-describedby={props.body ? props.bodyId : undefined}
        ref={(el) => {
          dialogRef = el;
        }}
      >
        <p class="dialog-title" id={props.titleId}>
          {props.title}
        </p>
        <Show when={props.body}>
          <p class="dialog-body" id={props.bodyId}>
            {props.body}
          </p>
        </Show>
        <div class="dialog-actions">
          <button
            type="button"
            class="btn btn-secondary"
            ref={(el) => {
              cancelRef = el;
            }}
            onClick={props.onCancel}
          >
            {props.cancelLabel ?? "Cancel"}
          </button>
          <button type="button" class="btn btn-primary" onClick={props.onConfirm}>
            {props.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
