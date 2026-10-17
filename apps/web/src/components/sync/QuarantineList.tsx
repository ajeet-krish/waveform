import { For, Show, createEffect, createSignal, type JSX } from "solid-js";
import ConfirmDialog from "../ConfirmDialog";
import EmptyState from "../EmptyState";
import { useAppData } from "../../lib/appData";
import { errorMessage } from "../../lib/errors";
import {
  formatQuarantineEntries,
  quarantineCopy,
  quarantineUnavailableCopy,
  type QuarantineEntry,
} from "../../lib/sync/quarantine";

const RETRY_FAILURE = "The change could not be returned to the queue. Try again.";
const DISCARD_FAILURE = "The change could not be discarded. Try again.";

const DISCARD_TITLE = "Discard this paused change?";
const DISCARD_BODY =
  "The change is removed from the sync queue. The local row it describes stays on this device and is not deleted. A later change to the same row can still sync. This cannot be undone here.";

/** Busy marker for the "Retry all" button, distinct from any op id. */
const RETRY_ALL = "all";

/**
 * The parked-op list: one expandable row per change the server rejected
 * three times, each with its reason and a Retry or Discard action, plus a
 * Retry all at the top. Retry requeues the op and asks the engine for a
 * sync; Discard drops the op only, leaving the local row, so its confirm
 * copy says exactly that. The list reloads whenever the engine's parked
 * count changes, so a successful retry or discard clears the row. The
 * heading counts the entries actually loaded, not the engine's raw scan,
 * so the summary and the body can never disagree; an unreadable list
 * (no bound repos, or a failed read) gets its own honest copy.
 */
export default function QuarantineList(): JSX.Element {
  const app = useAppData();
  const [entries, setEntries] = createSignal<QuarantineEntry[]>([]);
  const [ready, setReady] = createSignal(false);
  const [unavailable, setUnavailable] = createSignal(false);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [failure, setFailure] = createSignal<string | null>(null);
  const [discardId, setDiscardId] = createSignal<string | null>(null);
  /** Monotonic token so an out-of-order load cannot overwrite a newer one. */
  let loadToken = 0;

  const copy = () =>
    unavailable() ? quarantineUnavailableCopy() : quarantineCopy(entries().length);

  const load = async (): Promise<void> => {
    const token = ++loadToken;
    const repos = app.repos();
    if (repos === null) {
      setEntries([]);
      setUnavailable(true);
      setReady(true);
      return;
    }
    try {
      const ops = await repos.outbox.listQuarantined();
      if (token !== loadToken) {
        // A newer load started while this one was in flight; drop it.
        return;
      }
      setEntries(formatQuarantineEntries(ops, new Date()));
      setUnavailable(false);
    } catch {
      if (token !== loadToken) {
        return;
      }
      setEntries([]);
      setUnavailable(true);
    } finally {
      if (token === loadToken) {
        setReady(true);
      }
    }
  };

  // Reloads on mount and whenever the bound repos or the engine's parked
  // count change. The count moves after a requeue, a discard, or a run.
  createEffect(() => {
    app.repos();
    app.sync().quarantinedCount();
    void load();
  });

  const requeue = async (op_ids: string[], busyKey: string): Promise<void> => {
    const repos = app.repos();
    if (repos === null) {
      return;
    }
    setBusy(busyKey);
    setFailure(null);
    try {
      for (const op_id of op_ids) {
        await repos.outbox.requeue(op_id);
      }
      await app.sync().refreshCounts();
      app.sync().syncNow("requeue");
      await load();
    } catch (cause) {
      setFailure(errorMessage(cause, RETRY_FAILURE));
    } finally {
      setBusy(null);
    }
  };

  const discard = async (op_id: string): Promise<void> => {
    const repos = app.repos();
    if (repos === null) {
      return;
    }
    setBusy(op_id);
    setFailure(null);
    try {
      await repos.outbox.discard(op_id);
      await app.sync().refreshCounts();
      await load();
    } catch (cause) {
      setFailure(errorMessage(cause, DISCARD_FAILURE));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Show
      when={ready()}
      fallback={
        <p class="form-status" role="status">
          Checking paused changes...
        </p>
      }
    >
      <Show when={failure()}>
        <p class="form-status" role="alert">
          {failure()}
        </p>
      </Show>
      <details class="form-details">
        <summary class="label">{copy().heading}</summary>
        <Show
          when={entries().length > 0}
          fallback={<EmptyState title={copy().emptyTitle} body={copy().emptyBody} />}
        >
          <div class="form-actions">
            <button
              type="button"
              class="btn btn-secondary"
              disabled={busy() !== null}
              onClick={() =>
                void requeue(
                  entries().map((entry) => entry.op_id),
                  RETRY_ALL,
                )
              }
            >
              {busy() === RETRY_ALL ? "Retrying" : "Retry all"}
            </button>
          </div>
          <ul class="quarantine-list stack-tight mt-3">
            <For each={entries()}>
              {(entry) => (
                <li class="quarantine-row">
                  <p class="quarantine-summary">{entry.summary}</p>
                  <p class="quarantine-reason">{entry.reason}</p>
                  <p class="quarantine-meta label">
                    {`${entry.attempts} failed ${entry.attempts === 1 ? "attempt" : "attempts"}, parked ${entry.parkedAge}`}
                  </p>
                  <div class="form-actions mt-3">
                    <button
                      type="button"
                      class="btn btn-secondary"
                      disabled={busy() !== null}
                      aria-label={`Retry ${entry.summary}`}
                      onClick={() => void requeue([entry.op_id], entry.op_id)}
                    >
                      {busy() === entry.op_id ? "Retrying" : "Retry"}
                    </button>
                    <button
                      type="button"
                      class="btn btn-quiet"
                      disabled={busy() !== null}
                      aria-label={`Discard ${entry.summary}`}
                      onClick={() => setDiscardId(entry.op_id)}
                    >
                      Discard
                    </button>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </details>
      <ConfirmDialog
        open={discardId() !== null}
        title={DISCARD_TITLE}
        body={DISCARD_BODY}
        confirmLabel="Discard the change"
        onConfirm={() => {
          const id = discardId();
          setDiscardId(null);
          if (id !== null) {
            void discard(id);
          }
        }}
        onCancel={() => setDiscardId(null)}
      />
    </Show>
  );
}
