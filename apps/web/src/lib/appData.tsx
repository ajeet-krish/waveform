/**
 * App data bootstrap: the one place that opens the database, seeds the
 * catalog, and decides what the app is doing right now.
 *
 * status starts at "loading"; an existing local profile means "ready",
 * no profile means "setup" (first run), and any bootstrap failure means
 * "error" with the reason readable through error(). Storage resilience
 * rides along: repos are wrapped with guardRepos so quota failures
 * surface through storage().failure, and retryBootstrap reopens a log
 * that failed to open.
 *
 * Bucket 3 layers the account and sync surfaces on top without changing
 * the local-first contract: while signed out, writes queue in the outbox
 * and nothing leaves the device. The auth store keeps the bearer session
 * in localStorage; the sync engine (single-flight, debounce, backoff)
 * starts once a session exists and the first-sign-in data choice is
 * answered, and stops on sign-out or a 401. The API base URL resolves
 * sync_meta `api_base_url` override, then VITE_API_BASE_URL, then the
 * localhost default. Before sign-in the repos stamp the local profile id
 * onto new rows; after sign-in plus adoption they rebind to the server
 * user id so later writes carry the owner the server expects.
 */

import {
  createContext,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  useContext,
  type Accessor,
  type JSX,
} from "solid-js";
import type { BoardWindow, BoardsResponse, LoginRequest, SignupRequest } from "@waveform/api-types";
import { createRepos, db, ensureCatalog, LocalValidationError, type Repos } from "../db";
import type { LocalProfile } from "../db/types";
import { createApiClient, resolveApiBaseUrl, type ApiClient } from "./api";
import { createAuthStore, readSession, type AuthStore } from "./session";
import { adoptLocalUser, adoptStartEmpty, needsAdoption } from "./sync/adoption";
import { createSyncEngine, type SyncReason, type SyncStatus } from "./sync/engine";
import { API_BASE_URL_KEY, getMeta, setMeta } from "./sync/meta";
import {
  classifyOwnership,
  isWriteBlocked,
  wipeAccountDataFromDevice,
  type DeviceOwnership,
} from "./sync/ownership";
import {
  ensurePersistentStorage,
  guardRepos,
  isIndexedDbAvailable,
  subscribeStorageFailures,
  type PersistState,
  type StorageFailure,
} from "./storage";

export type AppStatus = "loading" | "setup" | "ready" | "error";

export type SetupInput = {
  displayName: string;
  weightUnit: "kg" | "lb";
  lengthUnit: "cm" | "in";
};

/** What the first sign-in does with this device's pre-account data. */
export type AdoptionChoice = "upload" | "start-empty";

export type StorageView = {
  /** The latest quota or availability failure, or null when storage is healthy. */
  failure: Accessor<StorageFailure | null>;
  /** Asks the browser for persistent storage once; reports the outcome. */
  persist(): Promise<PersistState>;
};

/** The sign-in surface the Account screen drives. */
export type AccountActions = {
  signup(input: SignupRequest): Promise<void>;
  login(input: LoginRequest): Promise<void>;
  logout(): Promise<void>;
  /**
   * Answers the first-sign-in data choice: "upload" keeps the local log
   * and rebases it onto the account, "start-empty" wipes the synced
   * stores and pulls the account down fresh. Both then rebind the repos
   * to the server user id and start the sync engine.
   */
  adoptionChoice(choice: AdoptionChoice): Promise<void>;
  /**
   * Sets the sync_meta `api_base_url` override ("" clears it), rebuilds
   * the API client, and re-evaluates sync so a corrected address picks
   * the engine back up.
   */
  setApiBaseUrl(raw: string): Promise<void>;
};

/** The sync engine's view for the chip and the Account status panel. */
export type SyncView = {
  status: Accessor<SyncStatus>;
  pendingCount: Accessor<number>;
  quarantinedCount: Accessor<number>;
  lastSyncedAt: Accessor<string | null>;
  conflicts: Accessor<number>;
  /** Asks for one run now (the "Sync now" button); "manual" by default. */
  syncNow(reason?: SyncReason): void;
  /** Re-reads the outbox counts after a requeue or discard. */
  refreshCounts(): Promise<void>;
};

export type AppData = {
  status: Accessor<AppStatus>;
  /** Null until the profile exists; never a repo without a user id. */
  repos: Accessor<Repos | null>;
  profile: Accessor<LocalProfile | null>;
  error: Accessor<string | null>;
  completeSetup(input: SetupInput): Promise<void>;
  /**
   * Updates display name and units on the local profile row plus the
   * reactive profile signal; writes no outbox op (settings are local).
   */
  saveSettings(input: SetupInput): Promise<void>;
  /** Storage health: the failure bus view plus the persistence ask. */
  storage(): StorageView;
  /** Clears the visible storage alert. */
  dismissStorageAlert(): void;
  /** Re-runs bootstrap, for a log that failed to open. */
  retryBootstrap(): Promise<void>;
  /** Session state and the sign-in surface. */
  auth: AuthStore;
  account: AccountActions;
  /**
   * Fetches the server-aggregated leaderboard boards for one window.
   * Throws the resolver's message when no API address is configured and an
   * ApiError when the call fails; the caller renders both.
   */
  boards(window: BoardWindow): Promise<BoardsResponse>;
  /**
   * True when this device still owes the account its data choice, null
   * while that check is in flight, false otherwise (signed out, already
   * adopted, or just adopted).
   */
  adoptionNeeded: Accessor<boolean | null>;
  /**
   * What this device holds for the signed-in account: "fresh" (nothing),
   * "mine" (adoptable), "foreign" (another account's log, which the
   * Account screen offers to export, remove, or sign out of), or
   * "unknown" (the ownership read failed, so sync stays off). Null while
   * signed out or before the check resolves.
   */
  deviceOwnership: Accessor<DeviceOwnership | null>;
  /**
   * True while the Shell must keep the write console away: this device
   * holds another account's log ("foreign"), or its ownership could not
   * be read ("unknown"). False while signed out or on this device's own
   * log (fresh or mine).
   */
  writeBlocked: Accessor<boolean>;
  /** The stored address override; null means the build's default. */
  apiBaseUrlOverride: Accessor<string | null>;
  /** The address sync uses right now; null when none resolves. */
  apiBaseUrl: Accessor<string | null>;
  sync(): SyncView;
};

const AppDataContext = createContext<AppData | null>(null);

function messageOf(cause: unknown): string {
  if (cause instanceof Error && cause.message) {
    return cause.message;
  }
  return "The local log could not be opened.";
}

function assertDisplayName(displayName: string): string {
  const trimmed = displayName.trim();
  if (trimmed.length < 1 || trimmed.length > 40) {
    throw new Error("Display name must be 1 to 40 characters.");
  }
  return trimmed;
}

export function AppDataProvider(props: { children: JSX.Element }) {
  const [status, setStatus] = createSignal<AppStatus>("loading");
  const [repos, setRepos] = createSignal<Repos | null>(null);
  const [profile, setProfile] = createSignal<LocalProfile | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [storageFailure, setStorageFailure] = createSignal<StorageFailure | null>(null);
  const [apiOverride, setApiOverride] = createSignal<string | null>(null);
  const [apiClient, setApiClient] = createSignal<ApiClient | null>(null);
  const [adoptionNeeded, setAdoptionNeeded] = createSignal<boolean | null>(null);
  const [deviceOwnership, setDeviceOwnership] = createSignal<DeviceOwnership | null>(null);

  const unsubscribe = subscribeStorageFailures((failure) => setStorageFailure(failure));
  onCleanup(unsubscribe);

  // Sign-in must not race the bootstrap read of the stored address
  // override: the engine only starts once bootstrap has resolved it.
  let markBootstrapReady!: () => void;
  const bootstrapReady = new Promise<void>((resolve) => {
    markBootstrapReady = resolve;
  });

  /** The configured address: override, then env, then localhost (throws if none). */
  function currentBaseUrl(): string {
    return resolveApiBaseUrl(apiOverride(), import.meta.env.VITE_API_BASE_URL ?? null);
  }

  /** The configured address when one resolves; null on a misconfigured host. */
  function resolvedApiBaseUrl(): string | null {
    try {
      return currentBaseUrl();
    } catch {
      return null;
    }
  }

  /** Rebuilds the API client for the current address and session token. */
  function refreshClient(): void {
    try {
      const client = createApiClient({
        baseUrl: currentBaseUrl(),
        token: readSession()?.token ?? null,
        onAuthExpired: () => {
          // A 401 during login is a wrong password, not a dead session:
          // only a signed-in session can expire out from under the app.
          if (auth.state() === "signed-in") {
            auth.markExpired();
          }
        },
      });
      setApiClient(client);
    } catch {
      // No address configured (deployed without env and no override).
      // Sign-in surfaces the resolve error through its own status
      // region; sync simply has no client to run against.
      setApiClient(null);
    }
  }

  /** The client for an auth call; throws the resolver's message when none. */
  function currentClient(): ApiClient {
    const existing = apiClient();
    if (existing !== null) {
      return existing;
    }
    refreshClient();
    const rebuilt = apiClient();
    if (rebuilt !== null) {
      return rebuilt;
    }
    throw new Error(
      "No API address is configured: set one under Account, Advanced, before signing in.",
    );
  }

  const auth: AuthStore = createAuthStore({
    api: {
      signup: (input) => currentClient().signup(input),
      login: (input) => currentClient().login(input),
      logout: async () => {
        const client = apiClient();
        if (client !== null) {
          await client.logout();
        }
      },
    },
    onBeforeSignOut: async (userId) => {
      // A shared or handed-down device must not keep an account's synced
      // copy after sign-out; the server copy is untouched.
      if (userId !== null) {
        await wipeAccountDataFromDevice(db, userId);
      }
    },
  });

  const engine = createSyncEngine({
    db,
    api: () => (auth.state() === "signed-in" ? apiClient() : null),
  });
  onCleanup(() => {
    void engine.stop();
  });

  /** Latest evaluateAuth wins; a stale async check never binds or starts. */
  let authEval = 0;

  function bindRepos(userId: string): void {
    setRepos(guardRepos(createRepos(db, { userId })));
  }

  /**
   * Binds repos to this device's own local profile id (the signed-out
   * local-first console). A stale call is dropped so it cannot clobber a
   * newer sign-in decision; a device with no profile row stays unbound.
   */
  async function bindLocalRepos(token: number): Promise<void> {
    let rows: LocalProfile[];
    try {
      rows = await db.local_profile.toArray();
    } catch {
      // Storage is unavailable; bootstrap reports it and no repos bind.
      return;
    }
    if (token !== authEval) {
      return;
    }
    const existing = rows[0] ?? null;
    if (existing !== null) {
      setRepos(guardRepos(createRepos(db, { userId: existing.id })));
    }
  }

  /** Re-reads the profile row (adoption re-keys it to the server id). */
  async function refreshProfile(): Promise<void> {
    const rows = await db.local_profile.toArray();
    const next = rows[0] ?? null;
    if (next !== null) {
      setProfile(next);
    }
  }

  /**
   * Reconciles session state with sync: signed out stops the engine,
   * signed in classifies device ownership (waiting out bootstrap so the
   * address is settled first). A foreign device's log is never pushed,
   * merged, or adopted: the engine stops and the Account screen shows
   * the export, remove, or sign out choice. A failed ownership read fails
   * closed to "unknown": the engine stops and nothing binds, so a device
   * of unknown ownership never syncs. Otherwise it checks the adoption
   * marker and only an adopted device binds repos to the server user id
   * and starts the engine.
   */
  async function evaluateAuth(): Promise<void> {
    const token = ++authEval;
    const state = auth.state();
    const user = auth.user();
    if (state !== "signed-in" || user === null) {
      setAdoptionNeeded(false);
      setDeviceOwnership(null);
      void engine.stop();
      // Signed out is the local-first console: rebind to this device's
      // own profile row. A foreign sign-out just unbound it, and the
      // stored profile is this device's own identity again.
      await bindLocalRepos(token);
      return;
    }
    setAdoptionNeeded(null);
    await bootstrapReady;
    if (token !== authEval) {
      return;
    }
    let needed: boolean;
    let ownership: DeviceOwnership;
    try {
      needed = await needsAdoption(db, user.id);
      ownership = await classifyOwnership(db, user.id);
    } catch {
      if (token !== authEval) {
        return;
      }
      // Fail closed: a failed ownership read must not be treated as
      // "mine", or a live session could start syncing a device whose
      // owner is unknown. Stop the engine, leave repos unbound, and
      // expose the unknown state; the next auth change re-checks.
      setDeviceOwnership({ kind: "unknown" });
      setRepos(null);
      void engine.stop();
      return;
    }
    if (token !== authEval) {
      return;
    }
    setDeviceOwnership(ownership);
    setAdoptionNeeded(needed);
    if (ownership.kind === "foreign" || ownership.kind === "unknown") {
      // Another account's log (or an unknown device state): do not bind
      // repos for adoption (unbind any profile-id binding bootstrap made)
      // and do not start the engine, so nothing edits or re-syncs it into
      // this account.
      setRepos(null);
      void engine.stop();
      return;
    }
    if (needed) {
      // The data choice comes first: starting the engine here could push
      // (or for "start-empty", resurrect) data the user is about to drop.
      void engine.stop();
      return;
    }
    bindRepos(user.id);
    void engine.start();
  }

  async function bootstrap(): Promise<void> {
    if (!isIndexedDbAvailable()) {
      setError(
        "This browser is blocking local storage (IndexedDB), so the training log cannot open here.",
      );
      setStatus("error");
      markBootstrapReady();
      return;
    }
    try {
      const stored = await getMeta(db, API_BASE_URL_KEY);
      if (typeof stored === "string" && stored.trim().length > 0) {
        setApiOverride(stored.trim());
      }
      await ensureCatalog(db);
      const rows = await db.local_profile.toArray();
      // A fast setup submit can finish first; never regress its outcome.
      if (status() !== "loading") {
        return;
      }
      const existing = rows[0] ?? null;
      if (!existing) {
        setStatus("setup");
        return;
      }
      setProfile(existing);
      setRepos(guardRepos(createRepos(db, { userId: existing.id })));
      setStatus("ready");
    } catch (cause) {
      if (status() !== "loading") {
        return;
      }
      setError(messageOf(cause));
      setStatus("error");
    } finally {
      markBootstrapReady();
    }
  }

  async function retryBootstrap(): Promise<void> {
    setError(null);
    setStatus("loading");
    await bootstrap();
  }

  async function completeSetup(input: SetupInput): Promise<void> {
    let displayName: string;
    try {
      displayName = assertDisplayName(input.displayName);
    } catch (cause) {
      setError(messageOf(cause));
      throw cause;
    }

    const id = crypto.randomUUID();
    const iso = new Date().toISOString();
    try {
      const next = guardRepos(createRepos(db, { userId: id }));
      const saved = await next.profile.save({
        id,
        display_name: displayName,
        email: null,
        avatar_url: null,
        created_at: iso,
        updated_at: iso,
        settings: {
          display_weight_unit: input.weightUnit,
          display_length_unit: input.lengthUnit,
        },
      });
      setProfile(saved);
      setRepos(next);
      setError(null);
      setStatus("ready");
    } catch (cause) {
      setError(messageOf(cause));
      throw cause;
    }
  }

  async function saveSettings(input: SetupInput): Promise<void> {
    const current = profile();
    const currentRepos = repos();
    if (!current || !currentRepos) {
      throw new LocalValidationError("no local profile");
    }
    const displayName = assertDisplayName(input.displayName);
    const saved = await currentRepos.profile.save({
      ...current,
      display_name: displayName,
      settings: {
        display_weight_unit: input.weightUnit,
        display_length_unit: input.lengthUnit,
      },
    });
    setProfile(saved);
  }

  async function adoptionChoice(choice: AdoptionChoice): Promise<void> {
    const state = auth.state();
    const user = auth.user();
    if (state !== "signed-in" || user === null) {
      throw new LocalValidationError("no signed-in account to adopt");
    }
    if (choice === "upload") {
      await adoptLocalUser(db, user.id);
    } else {
      await adoptStartEmpty(db, user.id);
      // The wipe also took the global catalog rows with it.
      await ensureCatalog(db);
    }
    await refreshProfile();
    setAdoptionNeeded(false);
    setDeviceOwnership({ kind: "mine" });
    bindRepos(user.id);
    await engine.start();
  }

  async function boards(window: BoardWindow): Promise<BoardsResponse> {
    return currentClient().boards(window);
  }

  async function setApiBaseUrl(raw: string): Promise<void> {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      await db.sync_meta.delete(API_BASE_URL_KEY);
      setApiOverride(null);
    } else {
      let normalized: string;
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new Error("unsupported scheme");
        }
        normalized = resolveApiBaseUrl(trimmed, null);
      } catch {
        throw new Error(
          "Enter a full API address with http:// or https://, for example https://waveform-api-94et.onrender.com.",
        );
      }
      await setMeta(db, API_BASE_URL_KEY, normalized);
      setApiOverride(normalized);
    }
    refreshClient();
    if (auth.state() === "signed-in") {
      // Re-runs the adoption/start check, which restarts a halted
      // engine (for example one parked on auth-expired by a typo'd
      // address, or by the bad address the clear just removed) or
      // simply syncs against the corrected one.
      void evaluateAuth();
    }
  }

  // The client follows the address and the session token. Created before
  // the auth evaluation effect so a fresh sign-in always has its bearer
  // token in place before the engine can start.
  createEffect(() => {
    apiOverride();
    auth.state();
    auth.user();
    refreshClient();
  });

  createEffect(() => {
    void evaluateAuth();
  });

  const account: AccountActions = {
    signup: (input) => auth.signup(input),
    login: (input) => auth.login(input),
    logout: async () => {
      // Await the stop so the in-flight run has settled before the server
      // call and the wipe: no run can re-pull or re-push rows the wipe is
      // removing. auth.logout then runs the server call, the local wipe
      // (onBeforeSignOut), and the state flip in that order.
      await engine.stop();
      try {
        await auth.logout();
      } catch (cause) {
        // The local wipe failed before the state flipped: re-evaluate so
        // a still-signed-in app keeps a live engine, then surface it.
        void evaluateAuth();
        throw cause;
      }
    },
    adoptionChoice,
    setApiBaseUrl,
  };

  const syncView: SyncView = {
    status: engine.status,
    pendingCount: engine.pendingCount,
    quarantinedCount: engine.quarantinedCount,
    lastSyncedAt: engine.lastSyncedAt,
    conflicts: engine.conflicts,
    syncNow: (reason = "manual") => {
      void engine.requestSync(reason);
    },
    refreshCounts: () => engine.refreshCounts(),
  };

  const storageView: StorageView = {
    failure: storageFailure,
    persist: () => ensurePersistentStorage(),
  };

  onMount(() => {
    void bootstrap();
  });

  const value: AppData = {
    status,
    repos,
    profile,
    error,
    completeSetup,
    saveSettings,
    storage: () => storageView,
    dismissStorageAlert: () => setStorageFailure(null),
    retryBootstrap,
    auth,
    account,
    boards,
    adoptionNeeded,
    deviceOwnership,
    writeBlocked: () => isWriteBlocked(deviceOwnership()),
    apiBaseUrlOverride: apiOverride,
    apiBaseUrl: resolvedApiBaseUrl,
    sync: () => syncView,
  };
  return <AppDataContext.Provider value={value}>{props.children}</AppDataContext.Provider>;
}

/** Reads the app data bootstrap. Throws outside AppDataProvider. */
export function useAppData(): AppData {
  const context = useContext(AppDataContext);
  if (!context) {
    throw new Error("useAppData must be used inside AppDataProvider");
  }
  return context;
}
