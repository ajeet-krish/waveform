/**
 * Debounced draft autosave.
 *
 * schedule() arms a debounce; the timer snapshots the latest draft, so a
 * burst of edits collapses into one write. Writes are serialized on a
 * promise chain: even if a save is still in flight when the next one is
 * launched, they land one after another and the newest draft wins. flush()
 * runs any pending save immediately and awaits the chain, which is what a
 * cleanup (or a pagehide) should call.
 */

export type DraftAutosaveOptions<T> = {
  /** Reads the current draft; null or undefined means "nothing to save". */
  getDraft(): T | null | undefined;
  save(draft: T): void | Promise<void>;
  debounceMs?: number;
};

export type DraftAutosave = {
  /** Arms (or re-arms) the debounce. */
  schedule(): void;
  /** Saves pending work now and resolves when every write has landed. */
  flush(): Promise<void>;
  /** True while a debounce is armed or a write is in flight. */
  pending(): boolean;
};

export function createDraftAutosave<T>(options: DraftAutosaveOptions<T>): DraftAutosave {
  const debounceMs = options.debounceMs ?? 400;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let waiting = false;
  let inFlight = false;
  let chain: Promise<void> = Promise.resolve();

  const launch = (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    waiting = false;
    const draft = options.getDraft();
    if (draft === null || draft === undefined) {
      return chain;
    }
    const snapshot = draft;
    inFlight = true;
    const outcome = chain.then(
      () => options.save(snapshot),
      () => options.save(snapshot),
    );
    chain = outcome.then(
      () => {
        inFlight = false;
      },
      (cause: unknown) => {
        inFlight = false;
        throw cause;
      },
    );
    return chain;
  };

  return {
    schedule(): void {
      if (timer !== null) {
        clearTimeout(timer);
      }
      waiting = true;
      timer = setTimeout(() => {
        timer = null;
        // Failures are not swallowed, just held until flush() awaits them.
        void launch().catch(() => undefined);
      }, debounceMs);
    },

    flush(): Promise<void> {
      if (timer !== null || waiting) {
        return launch();
      }
      return chain;
    },

    pending(): boolean {
      return timer !== null || waiting || inFlight;
    },
  };
}
