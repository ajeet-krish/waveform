/**
 * App data bootstrap: the one place that opens the database, seeds the
 * catalog, and decides what the app is doing right now.
 *
 * status starts at "loading"; an existing local profile means "ready",
 * no profile means "setup" (first run), and any bootstrap failure means
 * "error" with the reason readable through error().
 */

import {
  createContext,
  createSignal,
  onMount,
  useContext,
  type Accessor,
  type JSX,
} from "solid-js";
import { createRepos, db, ensureCatalog, type Repos } from "../db";
import type { LocalProfile } from "../db/types";

export type AppStatus = "loading" | "setup" | "ready" | "error";

export type SetupInput = {
  displayName: string;
  weightUnit: "kg" | "lb";
  lengthUnit: "cm" | "in";
};

export type AppData = {
  status: Accessor<AppStatus>;
  /** Null until the profile exists; never a repo without a user id. */
  repos: Accessor<Repos | null>;
  profile: Accessor<LocalProfile | null>;
  error: Accessor<string | null>;
  completeSetup(input: SetupInput): Promise<void>;
};

const AppDataContext = createContext<AppData | null>(null);

function messageOf(cause: unknown): string {
  if (cause instanceof Error && cause.message) {
    return cause.message;
  }
  return "The local log could not be opened.";
}

export function AppDataProvider(props: { children: JSX.Element }) {
  const [status, setStatus] = createSignal<AppStatus>("loading");
  const [repos, setRepos] = createSignal<Repos | null>(null);
  const [profile, setProfile] = createSignal<LocalProfile | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  async function bootstrap(): Promise<void> {
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
      setRepos(createRepos(db, { userId: existing.id }));
      setStatus("ready");
    } catch (cause) {
      if (status() !== "loading") {
        return;
      }
      setError(messageOf(cause));
      setStatus("error");
    }
  }

  async function completeSetup(input: SetupInput): Promise<void> {
    const displayName = input.displayName.trim();
    if (displayName.length < 1 || displayName.length > 40) {
      const problem = "Display name must be 1 to 40 characters.";
      setError(problem);
      throw new Error(problem);
    }

    const id = crypto.randomUUID();
    const iso = new Date().toISOString();
    try {
      const next = createRepos(db, { userId: id });
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

  onMount(() => {
    void bootstrap();
  });

  const value: AppData = { status, repos, profile, error, completeSetup };
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
