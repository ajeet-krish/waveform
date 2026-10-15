/**
 * Storage resilience: persistence probing, quota detection, and a small
 * failure bus, framework-free so the app shell and the repos can both
 * use it.
 *
 * Browsers evict IndexedDB data when storage is tight or the site is not
 * "persistent". ensurePersistentStorage asks for persistence once per
 * StorageManager handle (persist prompts at most once per session per
 * handle); wrapWrite turns repo methods into calls that ask first, then
 * publish exactly one StorageFailure per quota or unavailable failure
 * while rethrowing the original error unchanged. A write path that runs
 * outside the wrapped repos (the backup import) classifies and publishes
 * the same failure itself through reportStorageFailure.
 */

/** The minimal slice of navigator.storage this module needs. */
export type PersistableStorage = {
  persisted(): Promise<boolean>;
  persist(): Promise<boolean>;
};

/** Where persistence stands: already there, just granted, refused, or no API. */
export type PersistState = "persisted" | "granted" | "denied" | "unavailable";

/** A published storage failure: a full disk or a blocked IndexedDB. */
export type StorageFailure = {
  kind: "quota" | "unavailable";
  message: string;
};

type StorageListener = (failure: StorageFailure) => void;

const listeners = new Set<StorageListener>();

/** The quota-exceeded names and legacy codes worth recognizing. */
const QUOTA_NAMES = new Set(["QuotaExceededError", "NS_ERROR_DOM_QUOTA_REACHED"]);

/** The DOMException names that mean IndexedDB cannot open here. */
const UNAVAILABLE_NAMES = new Set(["InvalidStateError", "SecurityError"]);

function errorName(cause: unknown): string {
  if (cause !== null && typeof cause === "object" && "name" in cause) {
    const name = (cause as { name: unknown }).name;
    if (typeof name === "string") {
      return name;
    }
  }
  return "";
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message) {
    return cause.message;
  }
  if (cause !== null && typeof cause === "object" && "message" in cause) {
    const message = (cause as { message: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return "";
}

/**
 * Walks the cause chain (error.cause, then error.inner) running a probe
 * on each link; cycles are guarded.
 */
function chainMatches(cause: unknown, probe: (error: unknown) => boolean): boolean {
  const seen = new Set<unknown>();
  let current: unknown = cause;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (probe(current)) {
      return true;
    }
    if (typeof current !== "object") {
      return false;
    }
    const link = current as { cause?: unknown; inner?: unknown };
    current = link.cause !== undefined ? link.cause : link.inner;
  }
  return false;
}

/**
 * True for a storage-quota failure: the DOMException named
 * QuotaExceededError, the legacy code 22, or the same through a cause or
 * inner chain.
 */
export function isQuotaExceeded(cause: unknown): boolean {
  return chainMatches(cause, (error) => {
    if (QUOTA_NAMES.has(errorName(error))) {
      return true;
    }
    if (error !== null && typeof error === "object" && "code" in error) {
      return (error as { code: unknown }).code === 22;
    }
    return false;
  });
}

/** True when IndexedDB exists as a usable global in this environment. */
export function isIndexedDbAvailable(): boolean {
  const factory = (globalThis as { indexedDB?: IDBFactory | null }).indexedDB;
  return typeof factory !== "undefined" && factory !== null;
}

/**
 * True for a failure that means IndexedDB itself is unavailable here:
 * the browser blocks it (private mode, disabled storage) or the global
 * is missing entirely.
 */
export function isIndexedDbUnavailable(cause: unknown): boolean {
  if (!isIndexedDbAvailable()) {
    return true;
  }
  return chainMatches(cause, (error) => UNAVAILABLE_NAMES.has(errorName(error)));
}

/** Publishes one failure to every subscriber. */
function publish(failure: StorageFailure): void {
  for (const listener of [...listeners]) {
    listener(failure);
  }
}

/** Subscribes to storage failures; the return value unsubscribes. */
export function subscribeStorageFailures(listener: StorageListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The default persistence handle: navigator.storage when the browser
 * exposes it. setPersistApiOverride swaps it (tests, non-standard hosts).
 */
let apiOverride: PersistableStorage | null | undefined;

/**
 * Overrides the default StorageManager handle: an object pins a fake or
 * non-standard host, null means "no persistence API", and undefined
 * restores the navigator default.
 */
export function setPersistApiOverride(api: PersistableStorage | null | undefined): void {
  apiOverride = api;
}

function defaultApi(): PersistableStorage | null {
  if (apiOverride !== undefined) {
    return apiOverride;
  }
  const nav = (globalThis as { navigator?: { storage?: PersistableStorage } }).navigator;
  return nav?.storage ?? null;
}

function resolveApi(api?: PersistableStorage): PersistableStorage | null {
  return api ?? defaultApi();
}

/** One persist() attempt per StorageManager handle, ever. */
const persistOnce = new WeakMap<PersistableStorage, Promise<PersistState>>();

async function computePersistState(handle: PersistableStorage): Promise<PersistState> {
  try {
    if (await handle.persisted()) {
      return "persisted";
    }
    return (await handle.persist()) ? "granted" : "denied";
  } catch {
    return "denied";
  }
}

/**
 * Asks for persistent storage at most once per handle: the first call
 * runs persisted() then possibly persist(); later calls return the same
 * outcome without prompting again.
 */
export async function ensurePersistentStorage(api?: PersistableStorage): Promise<PersistState> {
  const handle = resolveApi(api);
  if (!handle) {
    return "unavailable";
  }
  const existing = persistOnce.get(handle);
  if (existing) {
    return existing;
  }
  const attempt = computePersistState(handle);
  persistOnce.set(handle, attempt);
  return attempt;
}

/** Read-only persistence status; never calls persist(). */
export async function persistedStatus(api?: PersistableStorage): Promise<PersistState> {
  const handle = resolveApi(api);
  if (!handle) {
    return "unavailable";
  }
  try {
    return (await handle.persisted()) ? "persisted" : "denied";
  } catch {
    return "denied";
  }
}

function failureFor(cause: unknown, kind: StorageFailure["kind"]): StorageFailure {
  const fallback =
    kind === "quota"
      ? "Storage is full. Export a backup to protect your log."
      : "Local storage is unavailable in this browser.";
  return { kind, message: errorMessage(cause) || fallback };
}

/**
 * Classifies a thrown cause and publishes the matching StorageFailure
 * (quota first, then IndexedDB unavailable), returning whether one was
 * published. Writes that run outside the wrapped repos (the backup
 * import's whole-transaction apply) call this themselves, then rethrow.
 */
export function reportStorageFailure(cause: unknown): boolean {
  if (isQuotaExceeded(cause)) {
    publish(failureFor(cause, "quota"));
    return true;
  }
  if (isIndexedDbUnavailable(cause)) {
    publish(failureFor(cause, "unavailable"));
    return true;
  }
  return false;
}

/**
 * Wraps one repo method: the first call attempts persistent storage,
 * quota and unavailable failures publish exactly one StorageFailure, and
 * every error (storage or not) is rethrown unchanged.
 */
export function wrapWrite<F extends (...args: never[]) => unknown>(fn: F): F {
  let persistAttempted = false;
  const wrapped = async (...args: Parameters<F>): Promise<Awaited<ReturnType<F>>> => {
    if (!persistAttempted) {
      persistAttempted = true;
      await ensurePersistentStorage();
    }
    try {
      return (await fn(...args)) as Awaited<ReturnType<F>>;
    } catch (cause) {
      reportStorageFailure(cause);
      throw cause;
    }
  };
  return wrapped as unknown as F;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for a plain object (Object.prototype or null prototype). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function guardValue(value: unknown): unknown {
  if (typeof value === "function") {
    return wrapWrite(value as (...args: never[]) => unknown);
  }
  if (isPlainObject(value)) {
    const guarded: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      guarded[key] = guardValue(member);
    }
    return guarded;
  }
  // Arrays, Dates, Maps, class instances, and any other non-plain value
  // pass through by reference: only plain objects are rebuilt so their
  // function members can be wrapped.
  return value;
}

/**
 * Wraps every function-valued member of a repo tree (recursively) with
 * wrapWrite, so every repo method asks for persistence once and reports
 * quota failures through the failure bus. Only plain objects are
 * rebuilt; arrays and non-plain values (Date, Map, class instances) pass
 * through unchanged by reference, so the tree can carry data values
 * without them being cloned.
 */
export function guardRepos<T>(repos: T): T {
  return guardValue(repos) as T;
}
