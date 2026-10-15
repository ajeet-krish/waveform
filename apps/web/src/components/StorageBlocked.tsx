import EmptyState from "./EmptyState";

/**
 * Shown instead of the routed page when the local log cannot open:
 * IndexedDB is blocked or the database failed to open. One honest
 * sentence, one action: try again, which re-runs the bootstrap.
 */
export default function StorageBlocked(props: {
  /** The bootstrap failure message, when one exists. */
  message?: string | null;
  onRetry: () => void;
}) {
  return (
    <div class="page" role="alert">
      <section class="panel" aria-label="Local storage blocked">
        <div class="panel-body">
          <EmptyState
            title="The training log cannot open here"
            body={
              props.message ??
              "This browser is blocking local storage (IndexedDB), so Waveform has nowhere to keep your log."
            }
            actions={[{ label: "Try again", onClick: props.onRetry, variant: "primary" }]}
            note="If this keeps happening, check the browser's site settings for storage or private mode."
          />
        </div>
      </section>
    </div>
  );
}
