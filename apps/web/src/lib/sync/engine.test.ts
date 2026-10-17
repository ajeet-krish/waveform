import { afterEach, describe, expect, it } from "vitest";
import type { PullPage, PushOp, PushResponse, SyncEntity } from "@waveform/api-types";
import { watchOutboxWrites } from "../../db/outbox";
import { createWaveformDb, type WaveformDb } from "../../db/schema";
import type { LocalRow, OutboxOp } from "../../db/types";
import type { WorkoutSession as WireWorkout } from "@waveform/api-types";
import { ApiError, type PullParams } from "../api";
import {
  SYNC_BACKOFF_BASE_MS,
  SYNC_BACKOFF_CAP_MS,
  SYNC_BACKOFF_FACTOR,
  SYNC_DEBOUNCE_MS,
  SYNC_MAX_ROUNDS,
  SYNC_POLL_MS,
  SYNC_WAKING_MS,
  createSyncEngine,
  type SyncApi,
  type SyncEngine,
  type SyncEventTargetLike,
  type SyncTimerHandle,
} from "./engine";
import { CONFLICT_LOG_KEY, setMeta } from "./meta";

const openDbs: WaveformDb[] = [];
const engines: SyncEngine[] = [];

afterEach(async () => {
  for (const engine of engines) {
    await engine.stop();
  }
  engines.length = 0;
  for (const db of openDbs) {
    db.close();
  }
  openDbs.length = 0;
});

function sessionPayload(id: string, updated_at: string): LocalRow<WireWorkout> {
  return {
    id,
    user_id: "user-1",
    local_date: "2026-10-14",
    started_at: null,
    duration_min: null,
    routine_id: null,
    notes: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at,
    deleted_at: null,
  };
}

function op(id: string, created_at: string, op_id: string): OutboxOp {
  return {
    op_id,
    entity: "workout_sessions",
    action: "update",
    payload: sessionPayload(id, created_at),
    updated_at: created_at,
    created_at,
  };
}

/** Hand-rolled timers so backoff, debounce, waking, and poll delays are probes. */
function fakeTimers(pollMs: number = SYNC_POLL_MS) {
  let nextId = 1;
  let now = 0;
  const scheduled = new Map<number, { at: number; fn: () => void }>();
  // Poll timers are always armed while live, so the sync-timer probes
  // below exclude them to stay focused on backoff, debounce, and waking.
  const pollIds = new Set<number>();
  return {
    setTimeoutFn(fn: () => void, ms: number): SyncTimerHandle {
      const id = nextId;
      nextId += 1;
      scheduled.set(id, { at: now + ms, fn });
      if (ms === pollMs) {
        pollIds.add(id);
      }
      return id as unknown as SyncTimerHandle;
    },
    clearTimeoutFn(handle: SyncTimerHandle): void {
      const id = handle as unknown as number;
      scheduled.delete(id);
      pollIds.delete(id);
    },
    /** Live delays in ms, soonest first, including the poll. */
    pending(): number[] {
      return [...scheduled.entries()]
        .sort((a, b) => a[1].at - b[1].at)
        .map(([, task]) => task.at - now);
    },
    /** Live delays in ms, soonest first, excluding the periodic poll. */
    pendingSync(): number[] {
      return [...scheduled.entries()]
        .filter(([id]) => !pollIds.has(id))
        .sort((a, b) => a[1].at - b[1].at)
        .map(([, task]) => task.at - now);
    },
    /** Fires every timer due within ms, in due order, re-scanning as they schedule. */
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        let dueId: number | null = null;
        let dueTask: { at: number; fn: () => void } | null = null;
        for (const [id, task] of scheduled) {
          if (task.at <= target && (dueTask === null || task.at < dueTask.at)) {
            dueId = id;
            dueTask = task;
          }
        }
        if (dueId === null || dueTask === null) {
          break;
        }
        scheduled.delete(dueId);
        pollIds.delete(dueId);
        now = dueTask.at;
        dueTask.fn();
      }
      now = target;
    },
  };
}

/** An event target the engine can attach to (window/document stand-in). */
function fakeTarget(): SyncEventTargetLike & { fire(type: string): void } {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    fire(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) {
        listener();
      }
    },
  };
}

type PushHandler = (ops: PushOp[]) => Promise<PushResponse>;
type PullHandler = (params: PullParams) => Promise<PullPage>;

function applied(ops: PushOp[]): PushResponse {
  return { results: ops.map((o) => ({ op_id: o.op_id, status: "applied" as const, error: null })) };
}

/**
 * Every delay the engine uses for sync work (never the poll): the
 * debounce, the waking probe, and the backoff ladder up to its cap.
 * `pendingSync()` tells poll timers apart by delay alone, so a poll
 * cadence equal to any of these would hide a real sync timer; harness()
 * throws on that collision rather than let a probe silently lie.
 */
function syncDelays(): number[] {
  const ladder: number[] = [];
  for (let step = 0; step <= 20; step += 1) {
    ladder.push(Math.min(SYNC_BACKOFF_BASE_MS * SYNC_BACKOFF_FACTOR ** step, SYNC_BACKOFF_CAP_MS));
  }
  return [SYNC_DEBOUNCE_MS, SYNC_WAKING_MS, ...ladder];
}

type HarnessOptions = {
  push?: PushHandler;
  pull?: PullHandler;
  isVisible?: () => boolean;
  /** Overrides the poll cadence; defaults to the engine's SYNC_POLL_MS. */
  pollMs?: number;
  /** null models the signed-out world: no client for the engine to call. */
  api?: SyncApi | null;
};

function harness(options: HarnessOptions = {}) {
  const pollMs = options.pollMs ?? SYNC_POLL_MS;
  if (syncDelays().includes(pollMs)) {
    throw new Error(
      `pollMs ${pollMs} collides with a sync delay, so pendingSync() would mis-tag it`,
    );
  }
  const db = createWaveformDb(`engine-${crypto.randomUUID()}`);
  openDbs.push(db);
  watchOutboxWrites(db);

  const timers = fakeTimers(pollMs);
  const online = fakeTarget();
  const visibility = fakeTarget();

  let pushHandler: PushHandler | undefined = options.push;
  let pullHandler: PullHandler | undefined = options.pull;
  const pushes: PushOp[][] = [];
  const pulled: SyncEntity[] = [];
  const stub: SyncApi = {
    async push(ops: PushOp[]): Promise<PushResponse> {
      pushes.push(ops);
      return pushHandler ? pushHandler(ops) : applied(ops);
    },
    async pull(params: PullParams): Promise<PullPage> {
      pulled.push(params.entity);
      return pullHandler
        ? pullHandler(params)
        : Promise.resolve({ rows: [], next_cursor: null });
    },
  };
  let currentApi: SyncApi | null = options.api === null ? null : stub;

  const engine = createSyncEngine({
    db,
    api: () => currentApi,
    pollMs: options.pollMs,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onlineTarget: online,
    visibilityTarget: visibility,
    isVisible: options.isVisible ?? (() => true),
  });
  engines.push(engine);

  return {
    db,
    engine,
    timers,
    online,
    visibility,
    pushes,
    /** Completed non-aborted runs: pullAll always asks for exercises first. */
    runs: () => pulled.filter((entity) => entity === "exercises").length,
    /** Every entity the pull API was asked for, in call order. */
    pulledEntities: () => [...pulled],
    setPush: (handler: PushHandler | undefined) => {
      pushHandler = handler;
    },
    setPull: (handler: PullHandler | undefined) => {
      pullHandler = handler;
    },
    setApi: (next: SyncApi | null) => {
      currentApi = next;
    },
  };
}

/** Lets queued microtasks and fake-indexeddb transactions settle. */
async function settle(rounds = 24): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Polls a predicate across macrotasks so slow IndexedDB chains finish. */
async function waitFor(predicate: () => boolean, rounds = 200): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("waitFor: condition never became true");
}

describe("createSyncEngine single flight", () => {
  it("coalesces concurrent requests into one shared run plus one reround", async () => {
    const h = harness();
    await h.db.outbox.add(op("w1", "2026-10-01T00:00:00.000Z", "op-a"));

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.setPush(async (ops) => {
      await gate;
      return applied(ops);
    });

    const started = h.engine.start();
    await waitFor(() => h.pushes.length === 1);
    expect(h.engine.status()).toBe("syncing");

    // Three triggers land mid-run: they all join the same promise.
    const second = h.engine.requestSync("manual");
    const third = h.engine.requestSync("outbox");
    const fourth = h.engine.requestSync("visibility");
    expect(second).toBe(started);
    expect(third).toBe(started);
    expect(fourth).toBe(started);

    release();
    await started;
    // The burst bought exactly one follow-up round, not three.
    await waitFor(() => h.runs() >= 2);
    await settle();
    expect(h.runs()).toBe(2);
    expect(h.pushes).toHaveLength(1);
    expect(h.engine.status()).toBe("idle");
    expect(await h.db.outbox.count()).toBe(0);
  });

  it("answers requests with a resolved promise once stopped", async () => {
    const h = harness();
    await h.engine.stop();
    await h.engine.requestSync("manual");
    expect(h.runs()).toBe(0);
    expect(h.engine.status()).toBe("idle");
  });

  it("stop() waits for the in-flight run and aborts it between units", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstPull = true;
    const h = harness({
      pull: async (params) => {
        if (params.entity === "exercises" && firstPull) {
          firstPull = false;
          await gate;
        }
        return { rows: [], next_cursor: null };
      },
    });

    const started = h.engine.start();
    await waitFor(() => h.pulledEntities().length === 1);
    expect(h.engine.status()).toBe("syncing");

    const stopped = h.engine.stop();
    let settled = false;
    void stopped.then(() => {
      settled = true;
    });
    await settle();
    // The run is still parked inside the gated pull, so stop() has not
    // resolved even though the status already flipped to idle.
    expect(settled).toBe(false);
    expect(h.engine.status()).toBe("idle");

    release();
    await stopped;
    await started;
    expect(settled).toBe(true);
    // The stop was seen between pages: the run aborted after exercises
    // rather than walking the remaining entities.
    expect(h.pulledEntities()).toEqual(["exercises"]);
  });

  it("stop() from the run's synchronous prefix still waits for that run", async () => {
    const db = createWaveformDb(`engine-${crypto.randomUUID()}`);
    openDbs.push(db);
    watchOutboxWrites(db);
    const timers = fakeTimers();
    const online = fakeTarget();
    const visibility = fakeTarget();

    const stub: SyncApi = {
      async push(ops): Promise<PushResponse> {
        return applied(ops);
      },
      async pull(): Promise<PullPage> {
        return { rows: [], next_cursor: null };
      },
    };

    let engine!: SyncEngine;
    let stopPromise: Promise<void> | null = null;
    let stopResolved = false;
    const setTimeoutFn = (fn: () => void, ms: number): SyncTimerHandle => {
      // The waking probe is scheduled inside requestSync's synchronous
      // prefix, after currentRun must already be assigned. Stop
      // re-entrantly from here: a stop that missed the run would resolve
      // before it settled.
      if (stopPromise === null && ms === SYNC_WAKING_MS) {
        stopPromise = engine.stop();
        void stopPromise.then(() => {
          stopResolved = true;
        });
      }
      return timers.setTimeoutFn(fn, ms);
    };
    engine = createSyncEngine({
      db,
      api: () => stub,
      setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      onlineTarget: online,
      visibilityTarget: visibility,
      isVisible: () => true,
    });
    engines.push(engine);

    const started = engine.start();
    expect(stopPromise).not.toBeNull();

    // Exactly one microtask: a fresh resolved promise (the missed-run bug)
    // would already have resolved, while the real in-flight run has not.
    await Promise.resolve();
    expect(stopResolved).toBe(false);

    await stopPromise;
    await started;
    expect(stopResolved).toBe(true);
    expect(engine.status()).toBe("idle");
  });
});

describe("createSyncEngine triggers", () => {
  it("debounces outbox writes for two seconds before draining", async () => {
    const h = harness();
    await h.engine.start();
    await waitFor(() => h.runs() >= 1);
    expect(h.pushes).toHaveLength(0);

    await h.db.outbox.add(op("w1", "2026-10-01T00:00:00.000Z", "op-a"));
    await settle();
    expect(h.pushes).toHaveLength(0);

    h.timers.advance(1000);
    await settle();
    expect(h.pushes).toHaveLength(0);
    h.timers.advance(999);
    await settle();
    expect(h.pushes).toHaveLength(0);

    h.timers.advance(1);
    await waitFor(() => h.pushes.length === 1);
    await settle();
    expect(h.engine.status()).toBe("idle");
    expect(await h.db.outbox.count()).toBe(0);
    expect(h.pushes[0]?.map((o) => o.op_id)).toEqual(["op-a"]);
  });

  it("runs on window online, and stops listening once stopped", async () => {
    const h = harness();
    await h.engine.start();
    await waitFor(() => h.runs() >= 1);
    expect(h.runs()).toBe(1);

    h.online.fire("online");
    await waitFor(() => h.runs() >= 2);
    expect(h.runs()).toBe(2);

    await h.engine.stop();
    h.online.fire("online");
    await settle();
    expect(h.runs()).toBe(2);
  });

  it("runs on visibilitychange only when the page is visible", async () => {
    let visible = false;
    const h = harness({ isVisible: () => visible });
    await h.engine.start();
    await waitFor(() => h.runs() >= 1);

    h.visibility.fire("visibilitychange");
    await settle();
    expect(h.runs()).toBe(1);

    visible = true;
    h.visibility.fire("visibilitychange");
    await waitFor(() => h.runs() >= 2);
    expect(h.runs()).toBe(2);
  });

  it("re-arms the debounce when the round floor exits with a rerun queued", async () => {
    // Every completed round earns one joined request, the same shape as
    // a write whose debounce fired mid-run, so the chain keeps asking
    // for a follow-up round until the floor stops it with one queued.
    const h = harness({
      pull: () => {
        void h.engine.requestSync("online");
        return Promise.resolve({ rows: [], next_cursor: null });
      },
    });

    await h.engine.start();
    await settle();
    expect(h.runs()).toBe(SYNC_MAX_ROUNDS);

    // The queued rerun was re-armed, not dropped: a timer is pending.
    expect(h.timers.pendingSync()).toEqual([SYNC_DEBOUNCE_MS]);

    // Firing it earns the follow-up round the join asked for.
    h.timers.advance(SYNC_DEBOUNCE_MS);
    await waitFor(() => h.runs() > SYNC_MAX_ROUNDS);
  });
});

describe("createSyncEngine poll", () => {
  it("re-syncs on its own cadence while idle and visible", async () => {
    const h = harness();
    await h.engine.start();
    await waitFor(() => h.runs() >= 1);
    expect(h.runs()).toBe(1);

    // Idle and visible with no local trigger: the poll runs anyway.
    h.timers.advance(SYNC_POLL_MS);
    await waitFor(() => h.runs() >= 2 && h.engine.status() === "idle");
    expect(h.runs()).toBe(2);
  });

  it("re-arms after every tick so a later interval fires again", async () => {
    const h = harness();
    await h.engine.start();
    await waitFor(() => h.runs() >= 1);

    h.timers.advance(SYNC_POLL_MS);
    await waitFor(() => h.runs() >= 2 && h.engine.status() === "idle");
    expect(h.runs()).toBe(2);

    // The tick re-armed the timer rather than firing once.
    h.timers.advance(SYNC_POLL_MS);
    await waitFor(() => h.runs() >= 3 && h.engine.status() === "idle");
    expect(h.runs()).toBe(3);
  });

  it("does not sync while a run is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      pollMs: 100,
      push: async (ops) => {
        await gate;
        return applied(ops);
      },
    });
    await h.db.outbox.add(op("w1", "2026-10-01T00:00:00.000Z", "op-a"));

    const started = h.engine.start();
    await waitFor(() => h.pushes.length === 1);
    expect(h.engine.status()).toBe("syncing");

    // Ticks landing mid-push re-arm but start nothing.
    h.timers.advance(100);
    await settle();
    expect(h.pushes).toHaveLength(1);
    expect(h.engine.status()).toBe("syncing");

    // "waking" is not "idle" either.
    h.timers.advance(2000);
    expect(h.engine.status()).toBe("waking");
    h.timers.advance(100);
    await settle();
    expect(h.pushes).toHaveLength(1);

    release();
    await started;
    expect(h.engine.status()).toBe("idle");
  });

  it("stays parked while offline instead of bypassing backoff", async () => {
    const h = harness({
      pollMs: 100,
      pull: () => Promise.reject(new ApiError("offline", "gone")),
    });
    await h.engine.start();
    expect(h.engine.status()).toBe("offline");
    expect(h.timers.pendingSync()).toEqual([1000]);
    const runsSoFar = h.runs();

    // Poll ticks land well before the backoff retry is due: no run.
    h.timers.advance(100);
    await settle();
    h.timers.advance(100);
    await settle();
    expect(h.runs()).toBe(runsSoFar);
    expect(h.engine.status()).toBe("offline");
    // Only the elapsed 200 ms moved the retry; the ticks neither
    // cleared nor re-armed it, so its original 1000 ms due still stands.
    expect(h.timers.pendingSync()).toEqual([800]);

    // The retry still fires exactly once on its own schedule, not per tick.
    h.timers.advance(800);
    await waitFor(() => h.runs() > runsSoFar);
    await settle();
    expect(h.runs()).toBe(runsSoFar + 1);
  });

  it("re-arms while signed out and never runs without a client", async () => {
    const h = harness({ api: null });
    await h.engine.start();
    expect(h.engine.status()).toBe("idle");
    expect(h.runs()).toBe(0);
    // The poll is armed even with no client to call.
    expect(h.timers.pending()).toEqual([SYNC_POLL_MS]);

    // The tick has no client to sync with, so it stays idle...
    h.timers.advance(SYNC_POLL_MS);
    await settle();
    expect(h.runs()).toBe(0);
    expect(h.engine.status()).toBe("idle");
    // ...but it re-arms, so the next interval still fires.
    expect(h.timers.pending()).toEqual([SYNC_POLL_MS]);
  });

  it("skips the sync while hidden and fires on the next visible tick", async () => {
    let visible = false;
    const h = harness({ isVisible: () => visible });
    await h.engine.start();
    await waitFor(() => h.runs() >= 1);
    expect(h.runs()).toBe(1);

    // Hidden: the tick re-arms without a run.
    h.timers.advance(SYNC_POLL_MS);
    await settle();
    expect(h.runs()).toBe(1);
    expect(h.engine.status()).toBe("idle");

    visible = true;
    h.timers.advance(SYNC_POLL_MS);
    await waitFor(() => h.runs() >= 2);
    expect(h.runs()).toBe(2);
  });

  it("cancels the poll on stop", async () => {
    const h = harness();
    await h.engine.start();
    await waitFor(() => h.runs() >= 1);
    expect(h.runs()).toBe(1);

    await h.engine.stop();
    expect(h.timers.pending()).toEqual([]);

    h.timers.advance(SYNC_POLL_MS * 3);
    await settle();
    expect(h.runs()).toBe(1);
  });
});

describe("createSyncEngine backoff", () => {
  it("doubles from one second to the five-minute cap and resets on success", async () => {
    const h = harness({
      pull: () => Promise.reject(new ApiError("offline", "gone")),
    });
    await h.engine.start();
    expect(h.engine.status()).toBe("offline");
    expect(h.timers.pendingSync()).toEqual([1000]);

    const scheduled = [
      2000, 4000, 8000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000, 300_000,
    ];
    let delay = 1000;
    for (const next of scheduled) {
      h.timers.advance(delay);
      // The run in flight parks on "syncing" with its waking timer; the
      // probe waits for the failed run to settle and re-arm backoff.
      await waitFor(
        () => h.engine.status() === "offline" && h.timers.pendingSync().join() === String(next),
      );
      expect(h.timers.pendingSync()).toEqual([next]);
      delay = next;
    }

    // A success resets the schedule: the next failure starts at 1s again.
    h.setPull(undefined);
    h.timers.advance(delay);
    await waitFor(() => h.engine.status() === "idle");
    expect(h.timers.pendingSync()).toEqual([]);

    h.setPull(() => Promise.reject(new ApiError("offline", "gone")));
    await h.engine.requestSync("manual");
    expect(h.engine.status()).toBe("offline");
    expect(h.timers.pendingSync()).toEqual([1000]);
  });

  it("restarts the schedule at one second when the browser comes back online", async () => {
    const h = harness({
      pull: () => Promise.reject(new ApiError("offline", "gone")),
    });
    await h.engine.start();
    expect(h.timers.pendingSync()).toEqual([1000]);

    h.timers.advance(1000);
    await waitFor(
      () => h.engine.status() === "offline" && h.timers.pendingSync().join() === "2000",
    );
    expect(h.timers.pendingSync()).toEqual([2000]);

    h.online.fire("online");
    await waitFor(
      () => h.engine.status() === "offline" && h.timers.pendingSync().join() === "1000",
    );
    expect(h.timers.pendingSync()).toEqual([1000]);
  });
});

describe("createSyncEngine states", () => {
  it("parks on offline when push cannot reach the server, keeping the queue", async () => {
    const h = harness({
      push: () => Promise.reject(new ApiError("offline", "The server could not be reached.")),
    });
    await h.db.outbox.add(op("w1", "2026-10-01T00:00:00.000Z", "op-a"));

    await h.engine.start();
    expect(h.engine.status()).toBe("offline");
    expect(h.runs()).toBe(0);
    expect(await h.db.outbox.count()).toBe(1);
    expect(h.engine.pendingCount()).toBe(1);
    expect(h.timers.pendingSync()).toEqual([1000]);
  });

  it("parks on auth-expired from push, stops, and recovers after a restart", async () => {
    const h = harness({
      push: () =>
        Promise.reject(new ApiError("auth-expired", "Your session has expired.", { status: 401 })),
    });
    await h.db.outbox.add(op("w1", "2026-10-01T00:00:00.000Z", "op-a"));

    await h.engine.start();
    expect(h.engine.status()).toBe("auth-expired");
    const pushesSoFar = h.pushes.length;

    // Stopped: manual requests resolve without running, writes arm nothing.
    await h.engine.requestSync("manual");
    expect(h.pushes).toHaveLength(pushesSoFar);
    // Every timer, poll included, is gone once the engine halts.
    expect(h.timers.pending()).toEqual([]);
    await h.db.outbox.add(op("w2", "2026-10-02T00:00:00.000Z", "op-b"));
    h.timers.advance(10_000);
    await settle();
    expect(h.pushes).toHaveLength(pushesSoFar);

    // A healthy server on restart drains both ops and settles on idle.
    h.setPush(undefined);
    await h.engine.start();
    expect(h.engine.status()).toBe("idle");
    expect(await h.db.outbox.count()).toBe(0);
    expect(h.engine.pendingCount()).toBe(0);
  });

  it("parks on auth-expired when the 401 arrives during pull", async () => {
    const h = harness({
      pull: () => Promise.reject(new ApiError("auth-expired", "expired", { status: 401 })),
    });
    await h.engine.start();
    expect(h.engine.status()).toBe("auth-expired");
    // Halted on the 401, poll included.
    expect(h.timers.pending()).toEqual([]);
  });

  it("maps an unreachable timeout to offline and a 5xx to error", async () => {
    const offline = harness({
      pull: () => Promise.reject(new ApiError("timeout", "The request timed out.")),
    });
    await offline.engine.start();
    expect(offline.engine.status()).toBe("offline");

    const failed = harness({
      pull: () => Promise.reject(new ApiError("server", "boom", { status: 500, code: "internal" })),
    });
    await failed.engine.start();
    expect(failed.engine.status()).toBe("error");
    expect(failed.timers.pendingSync()).toEqual([1000]);
  });

  it("reads a slow run as waking once two seconds pass", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      push: async (ops) => {
        await gate;
        return applied(ops);
      },
    });
    await h.db.outbox.add(op("w1", "2026-10-01T00:00:00.000Z", "op-a"));

    const started = h.engine.start();
    await waitFor(() => h.pushes.length === 1);
    expect(h.engine.status()).toBe("syncing");

    h.timers.advance(2000);
    expect(h.engine.status()).toBe("waking");

    release();
    await started;
    expect(h.engine.status()).toBe("idle");
    // The waking timer was cleared with the run, not left to fire later.
    expect(h.timers.pendingSync()).toEqual([]);
    expect(h.runs()).toBe(1);
  });

  it("stays idle without a client and still reports the local queue", async () => {
    const h = harness({ api: null });
    await h.db.outbox.add(op("w1", "2026-10-01T00:00:00.000Z", "op-a"));

    await h.engine.start();
    expect(h.engine.status()).toBe("idle");
    expect(h.runs()).toBe(0);
    expect(h.pushes).toHaveLength(0);
    expect(h.engine.pendingCount()).toBe(1);
  });
});

describe("createSyncEngine counts", () => {
  it("surfaces a quarantined op without deleting or re-queueing it", async () => {
    const h = harness({
      push: async (ops) => ({
        results: ops.map((o) => ({
          op_id: o.op_id,
          status: "rejected" as const,
          error: "invalid_payload" as const,
        })),
      }),
    });
    // A fresh drain attempts a rejected op once and defers it, so it is
    // not quarantined until three separate drains have run. Seed the
    // post-three-drain state directly to test the count surfacing.
    await h.db.outbox.add({
      ...op("w1", "2026-10-01T00:00:00.000Z", "op-a"),
      attempts: 3,
      last_error: "invalid_payload",
      quarantined: true,
    });

    await h.engine.start();
    expect(h.engine.status()).toBe("idle");
    expect(h.engine.quarantinedCount()).toBe(1);
    expect(h.engine.pendingCount()).toBe(0);
    expect(await h.db.outbox.count()).toBe(1);

    // A fresh write refreshes the counts even before its debounced run.
    await h.db.outbox.add(op("w2", "2026-10-02T00:00:00.000Z", "op-b"));
    await waitFor(() => h.engine.pendingCount() === 1);
    expect(h.engine.quarantinedCount()).toBe(1);
  });

  it("recomputes pending, last synced, and conflicts from local state", async () => {
    const h = harness();
    await h.db.outbox.bulkAdd([
      op("w1", "2026-10-01T00:00:00.000Z", "op-a"),
      op("w2", "2026-10-02T00:00:00.000Z", "op-b"),
    ]);
    await setMeta(h.db, CONFLICT_LOG_KEY, [
      { entity: "workout_sessions", id: "w1", dropped: 1 },
    ]);

    await h.engine.start();
    expect(h.engine.pendingCount()).toBe(0);
    expect(h.engine.quarantinedCount()).toBe(0);
    expect(h.engine.lastSyncedAt()).not.toBeNull();
    expect(h.engine.conflicts()).toBe(1);
    expect(h.pushes).toHaveLength(1);

    await h.db.outbox.add(op("w3", "2026-10-03T00:00:00.000Z", "op-c"));
    await waitFor(() => h.engine.pendingCount() === 1);
    expect(h.engine.lastSyncedAt()).not.toBeNull();
    expect(h.engine.conflicts()).toBe(1);
  });

  it("drains the whole queue inside one run", async () => {
    const h = harness();
    const ops: OutboxOp[] = [];
    for (let i = 0; i < 3; i += 1) {
      ops.push(op(`w${i}`, `2026-10-0${i + 1}T00:00:00.000Z`, `op-${i}`));
    }
    await h.db.outbox.bulkAdd(ops);

    await h.engine.start();
    expect(h.runs()).toBe(1);
    expect(h.engine.pendingCount()).toBe(0);
    expect(await h.db.outbox.count()).toBe(0);
  });
});
