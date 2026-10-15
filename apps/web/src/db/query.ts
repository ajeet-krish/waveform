/**
 * Framework-free reactive helpers over Dexie `liveQuery`.
 *
 * `observeQuery` is plain Rx-style plumbing and can be tested on its own;
 * `createLocalQuery` wires it to Solid signals and therefore must run
 * inside a reactive root (it registers an `onCleanup` that unsubscribes).
 */

import { liveQuery } from "dexie";
import { createSignal, onCleanup, type Accessor } from "solid-js";

export type ObserveQueryOptions<T> = {
  onNext: (value: T) => void;
  onError?: (error: unknown) => void;
};

/**
 * Subscribes to a Dexie query and re-emits whenever its observed tables
 * change. Returns a teardown function; calling it stops all further
 * emissions.
 *
 * The querier is wrapped in an async trampoline so a synchronous throw
 * becomes a rejection: Dexie routes rejected queriers to the observer's
 * error handler but lets synchronous throws escape as uncaught
 * exceptions. Errors therefore always arrive on `onError` (or, when no
 * handler is registered, are rethrown rather than swallowed).
 */
export function observeQuery<T>(
  querier: () => T | Promise<T>,
  options: ObserveQueryOptions<T>,
): () => void {
  const guarded = async (): Promise<T> => querier();
  const subscription = liveQuery(guarded).subscribe({
    next: (value) => options.onNext(value),
    error: (cause: unknown) => {
      if (options.onError) {
        options.onError(cause);
      } else {
        // No handler registered: never swallow a failed query silently.
        throw cause;
      }
    },
  });
  return () => subscription.unsubscribe();
}

export type LocalQuery<T> = {
  /** Latest emitted value; undefined until the first emission or after an error. */
  latest: Accessor<T | undefined>;
  /** Last query error, or undefined when the query has not failed. */
  error: Accessor<unknown>;
  /** True until the first emission (or error) arrives. */
  loading: Accessor<boolean>;
};

/**
 * Materializes a live Dexie query into Solid signals. Must be called
 * inside a reactive root so `onCleanup` can unsubscribe when the
 * computation that created it is disposed.
 */
export function createLocalQuery<T>(querier: () => T | Promise<T>): LocalQuery<T> {
  const [latest, setLatest] = createSignal<T | undefined>(undefined);
  const [error, setError] = createSignal<unknown>(undefined);
  const [loading, setLoading] = createSignal(true);

  const stop = observeQuery(querier, {
    onNext: (value) => {
      setLatest(() => value);
      setError(() => undefined);
      setLoading(false);
    },
    onError: (cause) => {
      setError(() => cause);
      setLoading(false);
    },
  });
  onCleanup(stop);

  return { latest, error, loading };
}
