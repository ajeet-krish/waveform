/**
 * The sync engine: one single-flight loop that keeps this device and the
 * server converging.
 *
 * A run is compactOutbox (guarded by its one-time flag), then
 * drainOutbox until the queue is empty (batches at RuleConstants
 * maxOpsPerPush), then pullAll across every entity cursor. Only one run
 * exists at a time: requestSync while a run is in flight joins that
 * run's promise and asks for exactly one follow-up round, so a burst of
 * triggers collapses into at most one extra pass instead of a thundering
 * herd.
 *
 * Triggers: start() bootstraps a sync, outbox writes debounce for two
 * seconds, `online` and `visibilitychange` (when visible) fire at once,
 * a poll re-syncs an idle, visible engine every SYNC_POLL_MS so open
 * devices converge on their own (it re-arms only while the engine is
 * running), and the UI can ask manually. A chain
 * that reaches its round floor with a rerun still queued re-arms the
 * debounce instead of dropping that trigger, so a write landing during
 * the final round still syncs.
 * Failures schedule an exponential backoff
 * (1s base, x2, 5 minute cap, reset on success) through injectable
 * timers; a 401 parks the engine on "auth-expired" and stops it; a
 * transport failure parks it on "offline"; a run still in flight after
 * two seconds reads as "waking" so a cold free-tier server looks alive
 * instead of frozen. pendingCount, quarantinedCount, lastSyncedAt, and
 * conflicts are recomputed from the outbox and sync_meta after every
 * run and on every queued write.
 */

import { createSignal, type Accessor } from "solid-js";
import { RULE_CONSTANTS } from "@waveform/api-types";
import { subscribeOutboxWrites } from "../../db/outbox";
import type { WaveformDb } from "../../db/schema";
import { ApiError, type ApiClient, type ApiFailureKind } from "../api";
import { compactOutbox } from "./compact";
import { drainOutbox } from "./drain";
import { CONFLICT_LOG_KEY, LAST_SYNCED_AT_KEY, getMeta } from "./meta";
import { pullAll, type SyncPullApi } from "./pull";

/** What the engine is doing right now (the chip and status panel read this). */
export type SyncStatus = "idle" | "syncing" | "offline" | "waking" | "auth-expired" | "error";

/** Why a sync was requested; carried for observability and backoff policy. */
export type SyncReason =
  | "bootstrap"
  | "outbox"
  | "online"
  | "visibility"
  | "poll"
  | "manual"
  | "backoff";

/** The outcome of one run after every failure kind is folded down. */
type RunOutcome = "ok" | "offline" | "auth-expired" | "error";

/** The API slice a run needs (a stub-able subset of ApiClient). */
export type SyncApi = Pick<ApiClient, "push" | "pull">;

/** One scheduled timer handle; injectable clocks decide its shape. */
export type SyncTimerHandle = ReturnType<typeof setTimeout>;

/** The narrow event-target seam the online/visibility triggers need. */
export type SyncEventTargetLike = {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

/** Outbox writes settle for this long before a debounced run fires. */
export const SYNC_DEBOUNCE_MS = 2000;

/**
 * How often an idle, visible engine proactively re-syncs while signed
 * in, so open devices converge without a local trigger.
 */
export const SYNC_POLL_MS = 30000;

/** A run still in flight after this long reads as "waking". */
export const SYNC_WAKING_MS = 2000;

/** First retry delay; doubles per failure up to the cap. */
export const SYNC_BACKOFF_BASE_MS = 1000;

/** Multiplier per consecutive failure. */
export const SYNC_BACKOFF_FACTOR = 2;

/** Retry ceiling: five minutes. */
export const SYNC_BACKOFF_CAP_MS = 300_000;

/**
 * How many back-to-back rounds one requestSync chain may run while
 * triggers keep landing; a floor against a writer that never pauses.
 * A chain that stops here with a rerun still queued re-arms the
 * debounce so that trigger is not dropped (see requestSync).
 */
export const SYNC_MAX_ROUNDS = 8;

export type SyncEngineDeps = {
  db: WaveformDb;
  /** The current API client, or null while signed out. Read per run. */
  api: Accessor<SyncApi | null>;
  debounceMs?: number;
  wakingMs?: number;
  /** How often an idle, visible engine re-syncs; defaults to SYNC_POLL_MS. */
  pollMs?: number;
  backoffBaseMs?: number;
  backoffFactor?: number;
  backoffCapMs?: number;
  /** Timer injection for tests; defaults to the global setTimeout. */
  setTimeoutFn?: (fn: () => void, ms: number) => SyncTimerHandle;
  clearTimeoutFn?: (handle: SyncTimerHandle) => void;
  /** Where `online` fires; defaults to window (null outside a browser). */
  onlineTarget?: SyncEventTargetLike | null;
  /** Where `visibilitychange` fires; defaults to document. */
  visibilityTarget?: SyncEventTargetLike | null;
  /** Page-visibility probe; defaults to document.visibilityState. */
  isVisible?: () => boolean;
};

export type SyncEngine = {
  status: Accessor<SyncStatus>;
  /** Queued ops the drain will push next (quarantined ones excluded). */
  pendingCount: Accessor<number>;
  /** Ops parked after three failed pushes; stored, never auto-retried. */
  quarantinedCount: Accessor<number>;
  /** ISO stamp of the last pull that reached every entity's tip. */
  lastSyncedAt: Accessor<string | null>;
  /** Entries in the conflict log: merges that dropped queued ops. */
  conflicts: Accessor<number>;
  /** Starts the triggers and bootstraps a sync. Safe to call twice. */
  start(): Promise<void>;
  /** Detaches every trigger and timer. An in-flight run stops early. */
  stop(): void;
  /** Requests a run; concurrent calls share one run plus one reround. */
  requestSync(reason: SyncReason): Promise<void>;
};

/** Folds one API failure kind into the engine's outcome vocabulary. */
function outcomeForFailure(kind: ApiFailureKind): RunOutcome {
  if (kind === "auth-expired") {
    return "auth-expired";
  }
  if (kind === "offline" || kind === "timeout") {
    return "offline";
  }
  return "error";
}

/** Classifies anything thrown during a run; unknown throws are bugs. */
function outcomeForCause(cause: unknown): RunOutcome {
  if (cause instanceof ApiError) {
    return outcomeForFailure(cause.kind);
  }
  return "error";
}

function defaultOnlineTarget(): SyncEventTargetLike | null {
  const target = (globalThis as { window?: SyncEventTargetLike }).window;
  return target ?? null;
}

function defaultVisibilityTarget(): SyncEventTargetLike | null {
  const target = (globalThis as { document?: SyncEventTargetLike }).document;
  return target ?? null;
}

function defaultIsVisible(): boolean {
  const doc = (globalThis as { document?: { visibilityState?: string } }).document;
  return doc?.visibilityState !== "hidden";
}

export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  const debounceMs = deps.debounceMs ?? SYNC_DEBOUNCE_MS;
  const wakingMs = deps.wakingMs ?? SYNC_WAKING_MS;
  const pollMs = deps.pollMs ?? SYNC_POLL_MS;
  const backoffBaseMs = deps.backoffBaseMs ?? SYNC_BACKOFF_BASE_MS;
  const backoffFactor = deps.backoffFactor ?? SYNC_BACKOFF_FACTOR;
  const backoffCapMs = deps.backoffCapMs ?? SYNC_BACKOFF_CAP_MS;
  const schedule: (fn: () => void, ms: number) => SyncTimerHandle =
    deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel: (handle: SyncTimerHandle) => void =
    deps.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
  const onlineTarget = deps.onlineTarget !== undefined ? deps.onlineTarget : defaultOnlineTarget();
  const visibilityTarget =
    deps.visibilityTarget !== undefined ? deps.visibilityTarget : defaultVisibilityTarget();
  const isVisible = deps.isVisible ?? defaultIsVisible;

  const [status, setStatus] = createSignal<SyncStatus>("idle");
  const [pendingCount, setPendingCount] = createSignal(0);
  const [quarantinedCount, setQuarantinedCount] = createSignal(0);
  const [lastSyncedAt, setLastSyncedAt] = createSignal<string | null>(null);
  const [conflicts, setConflicts] = createSignal(0);

  let running = false;
  /** Bumped by start/stop/halt so a stale run can detect it was left behind. */
  let epoch = 0;
  let currentRun: Promise<void> | null = null;
  let rerunQueued = false;
  /** The latest joined trigger's reason; it drives the follow-up round. */
  let pendingReason: SyncReason | null = null;
  let backoffAttempt = 0;
  let debounceTimer: SyncTimerHandle | null = null;
  let wakingTimer: SyncTimerHandle | null = null;
  let backoffTimer: SyncTimerHandle | null = null;
  let pollTimer: SyncTimerHandle | null = null;
  let unsubscribeOutbox: (() => void) | null = null;
  /** True while a post-write count refresh waits for its macrotask. */
  let writeRefreshQueued = false;

  /**
   * Recomputes every count signal from the outbox and sync_meta. A
   * storage failure keeps the previous numbers rather than throwing
   * into a fire-and-forget call site.
   */
  async function recompute(): Promise<void> {
    try {
      const rows = await deps.db.outbox.toArray();
      let pending = 0;
      let quarantined = 0;
      for (const row of rows) {
        if (row.quarantined === true) {
          quarantined += 1;
        } else {
          pending += 1;
        }
      }
      setPendingCount(pending);
      setQuarantinedCount(quarantined);
      const last = await getMeta(deps.db, LAST_SYNCED_AT_KEY);
      setLastSyncedAt(typeof last === "string" && last.length > 0 ? last : null);
      const log = await getMeta(deps.db, CONFLICT_LOG_KEY);
      setConflicts(Array.isArray(log) ? log.length : 0);
    } catch {
      // Last known numbers stand; the next run or write recomputes.
    }
  }

  function clearDebounce(): void {
    if (debounceTimer !== null) {
      cancel(debounceTimer);
      debounceTimer = null;
    }
  }

  function clearWaking(): void {
    if (wakingTimer !== null) {
      cancel(wakingTimer);
      wakingTimer = null;
    }
  }

  function clearBackoff(): void {
    if (backoffTimer !== null) {
      cancel(backoffTimer);
      backoffTimer = null;
    }
  }

  function clearPoll(): void {
    if (pollTimer !== null) {
      cancel(pollTimer);
      pollTimer = null;
    }
  }

  function scheduleWaking(): void {
    clearWaking();
    wakingTimer = schedule(() => {
      wakingTimer = null;
      if (status() === "syncing") {
        setStatus("waking");
      }
    }, wakingMs);
  }

  function scheduleBackoff(): void {
    if (backoffTimer !== null || !running) {
      return;
    }
    // Cap the exponent before the multiply so the delay never overflows
    // past the cap in floating point; the Math.min is the real bound.
    const step = Math.min(backoffAttempt, 20);
    const delay = Math.min(backoffBaseMs * backoffFactor ** step, backoffCapMs);
    backoffAttempt += 1;
    backoffTimer = schedule(() => {
      backoffTimer = null;
      if (!running) {
        return;
      }
      void requestSync("backoff");
    }, delay);
  }

  function scheduleDebounce(reason: SyncReason = "outbox"): void {
    clearDebounce();
    debounceTimer = schedule(() => {
      debounceTimer = null;
      void requestSync(reason);
    }, debounceMs);
  }

  /**
   * Re-arms the periodic poll. A tick only syncs an idle, visible
   * engine, so it never fights backoff or stacks runs; it re-arms only
   * while the engine is running, including a tick that skipped the run,
   * so a halt landing mid-tick cannot revive the timer.
   */
  function schedulePoll(): void {
    clearPoll();
    pollTimer = schedule(() => {
      pollTimer = null;
      if (running && isVisible() && status() === "idle") {
        void requestSync("poll");
      }
      if (running) {
        schedulePoll();
      }
    }, pollMs);
  }

  /**
   * One queued write: counts refresh now, the run waits out the
   * debounce. The Dexie creating hook fires inside the write's own
   * transaction and sync_meta sits outside its scope, so the recompute
   * hops one macrotask first; the flag coalesces a burst into one read.
   */
  function handleOutboxWrite(): void {
    if (!writeRefreshQueued) {
      writeRefreshQueued = true;
      setTimeout(() => {
        writeRefreshQueued = false;
        void recompute();
      }, 0);
    }
    if (!running) {
      return;
    }
    scheduleDebounce();
  }

  function handleOnline(): void {
    if (!running) {
      return;
    }
    void requestSync("online");
  }

  function handleVisibilityChange(): void {
    if (!running || !isVisible()) {
      return;
    }
    void requestSync("visibility");
  }

  /** Detaches every trigger and timer without touching status. */
  function halt(): void {
    running = false;
    epoch += 1;
    clearDebounce();
    clearWaking();
    clearBackoff();
    clearPoll();
    if (unsubscribeOutbox !== null) {
      unsubscribeOutbox();
      unsubscribeOutbox = null;
    }
    onlineTarget?.removeEventListener("online", handleOnline);
    visibilityTarget?.removeEventListener("visibilitychange", handleVisibilityChange);
  }

  /** Applies one run's outcome to status, backoff, and liveness. */
  function applyOutcome(outcome: RunOutcome): void {
    if (outcome === "ok") {
      setStatus("idle");
      backoffAttempt = 0;
      clearBackoff();
      return;
    }
    if (outcome === "auth-expired") {
      // Status first: halt below must not read "syncing" and clobber it.
      setStatus("auth-expired");
      halt();
      return;
    }
    setStatus(outcome === "offline" ? "offline" : "error");
    scheduleBackoff();
  }

  /** Pull failures are swallowed inside pullAll, so watch them here. */
  function watchingPullApi(api: SyncApi, record: (kind: ApiFailureKind) => void): SyncPullApi {
    return {
      async pull(params) {
        try {
          return await api.pull(params);
        } catch (cause) {
          if (cause instanceof ApiError) {
            record(cause.kind);
          }
          throw cause;
        }
      },
    };
  }

  async function performRun(reason: SyncReason): Promise<void> {
    const runEpoch = epoch;
    const api = deps.api();
    if (api === null) {
      await recompute();
      return;
    }
    if (reason === "online") {
      // The network just came back: restart the backoff schedule so the
      // first real attempt gets the short delay again.
      backoffAttempt = 0;
      clearBackoff();
    }

    let pullFailure: ApiFailureKind | null = null;
    const pullApi = watchingPullApi(api, (kind) => {
      pullFailure = kind;
    });

    setStatus("syncing");
    scheduleWaking();
    let outcome: RunOutcome = "ok";
    try {
      await compactOutbox(deps.db);
      if (runEpoch !== epoch) {
        return;
      }
      const drained = await drainOutbox({
        db: deps.db,
        api,
        cap: RULE_CONSTANTS.sync.maxOpsPerPush,
      });
      if (runEpoch !== epoch) {
        return;
      }
      if (drained.aborted !== undefined) {
        outcome = drained.aborted;
      } else {
        const pulled = await pullAll({ db: deps.db, api: pullApi });
        if (runEpoch !== epoch) {
          return;
        }
        if (!pulled.complete) {
          outcome = pullFailure === null ? "error" : outcomeForFailure(pullFailure);
        }
      }
    } catch (cause) {
      if (runEpoch !== epoch) {
        return;
      }
      outcome = outcomeForCause(cause);
    }
    clearWaking();
    applyOutcome(outcome);
    await recompute();
  }

  function requestSync(reason: SyncReason): Promise<void> {
    if (!running) {
      return Promise.resolve();
    }
    if (currentRun !== null) {
      // Single flight: join the run in progress and ask for exactly one
      // follow-up round so a write that landed mid-run is not dropped.
      // The follow-up runs under the newest trigger's reason, so an
      // "online" join still earns its fresh backoff schedule.
      rerunQueued = true;
      pendingReason = reason;
      return currentRun;
    }
    const chain = (async () => {
      try {
        let rounds = 0;
        let roundReason = reason;
        do {
          rerunQueued = false;
          pendingReason = null;
          await performRun(roundReason);
          rounds += 1;
          if (rerunQueued) {
            roundReason = pendingReason ?? roundReason;
          }
        } while (rerunQueued && running && rounds < SYNC_MAX_ROUNDS);
        if (rerunQueued && running) {
          // The floor hit with a trigger still joined (a write whose
          // debounce fired mid-run, for example): re-arm the debounce
          // under that trigger's reason so the queued work runs in a
          // fresh chain instead of being dropped here.
          const queuedReason = pendingReason ?? "outbox";
          rerunQueued = false;
          pendingReason = null;
          scheduleDebounce(queuedReason);
        }
      } catch {
        // performRun classifies its own failures; anything that escapes
        // it is a client-side bug, reported as an error run rather than
        // a rejection thrown at every awaiting caller.
        clearWaking();
        if (running) {
          applyOutcome("error");
        }
      } finally {
        currentRun = null;
      }
    })();
    currentRun = chain;
    return chain;
  }

  function start(): Promise<void> {
    if (!running) {
      running = true;
      epoch += 1;
      backoffAttempt = 0;
      clearDebounce();
      clearBackoff();
      unsubscribeOutbox = subscribeOutboxWrites(handleOutboxWrite);
      onlineTarget?.addEventListener("online", handleOnline);
      visibilityTarget?.addEventListener("visibilitychange", handleVisibilityChange);
      void recompute();
      schedulePoll();
    }
    return requestSync("bootstrap");
  }

  function stop(): void {
    const wasLive = status() === "syncing" || status() === "waking";
    halt();
    if (wasLive) {
      setStatus("idle");
    }
  }

  return {
    status,
    pendingCount,
    quarantinedCount,
    lastSyncedAt,
    conflicts,
    start,
    stop,
    requestSync,
  };
}
