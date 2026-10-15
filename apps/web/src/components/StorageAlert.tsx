import { createSignal, Show } from "solid-js";
import { db } from "../db";
import { exportBackupNow } from "../lib/backup";

type ExportState = "idle" | "working" | "done" | "error";

/**
 * A quota alert bar: the device is low on storage, so the next write may
 * fail. The one useful move is a fresh backup; the bar stays until it is
 * exported or dismissed.
 */
export default function StorageAlert(props: { onDismiss: () => void }) {
  const [exportState, setExportState] = createSignal<ExportState>("idle");

  const exportNow = async (): Promise<void> => {
    setExportState("working");
    try {
      await exportBackupNow(db);
      setExportState("done");
    } catch {
      setExportState("error");
    }
  };

  return (
    <div class="storage-alert" role="alert">
      <p class="storage-alert-text">
        This device is low on storage. New sets may fail to save until space is freed.
      </p>
      <div class="storage-alert-actions">
        <button
          type="button"
          class="btn btn-primary"
          disabled={exportState() === "working"}
          onClick={() => void exportNow()}
        >
          {exportState() === "working" ? "Exporting" : "Export backup now"}
        </button>
        <button type="button" class="btn btn-quiet" onClick={props.onDismiss}>
          Dismiss
        </button>
      </div>
      <Show when={exportState() === "done"}>
        <p class="storage-alert-note">Backup downloaded to this device.</p>
      </Show>
      <Show when={exportState() === "error"}>
        <p class="storage-alert-note" role="alert">
          The backup could not be created. Try again.
        </p>
      </Show>
    </div>
  );
}
