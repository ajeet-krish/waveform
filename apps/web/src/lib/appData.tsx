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
 */

import {
  createContext,
  createSignal,
  onCleanup,
  onMount,
  useContext,
  type Accessor,
  type JSX,
} from "solid-js";
import { createRepos, db, ensureCatalog, LocalValidationError, type Repos } from "../db";
import type { LocalProfile } from "../db/types";
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

export type StorageView = {
  /** The latest quota or availability failure, or null when storage is healthy. */
  failure: Accessor<StorageFailure | null>;
  /** Asks the browser for persistent storage once; reports the outcome. */
  persist(): Promise<PersistState>;
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

  const unsubscribe = subscribeStorageFailures((failure) => setStorageFailure(failure));
  onCleanup(unsubscribe);

  async function bootstrap(): Promise<void> {
    if (!isIndexedDbAvailable()) {
      setError(
        "This browser is blocking local storage (IndexedDB), so the training log cannot open here.",
      );
      setStatus("error");
      return;
    }
    try {
      await ensureCatalog(db);
      const stored = await db.local_profile.toArray();
      // A fast setup submit can finish first; never regress its outcome.
      if (status() !== "loading") {
        return;
      }
      const existing = stored[0] ?? null;
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
