/**
 * Session persistence plus the auth state store.
 *
 * The bearer session from signup/login lives in localStorage under
 * `waveform.session` so a reload keeps the user signed in without a
 * network round trip. readSession drops a past-expiry session (and
 * clears the key) so the app boots to "signed-out" instead of retrying a
 * dead token; markExpired clears the stored session for the same reason
 * once a 401 has proved the token dead. createAuthStore wraps that in
 * three signals: "signed-out", "signed-in", and "auth-expired" (a 401
 * landed mid-session; the token is gone but the app may want to show
 * why before resetting).
 */

import { createSignal, type Accessor } from "solid-js";
import type { AuthResponse, LoginRequest, SignupRequest, User } from "@waveform/api-types";
import type { ApiClient } from "./api";

/** The session exactly as it crosses the wire in AuthResponse. */
export type StoredSession = {
  token: string;
  expires_at: string;
  user: User;
};

/** The one localStorage key the session lives under. */
export const SESSION_KEY = "waveform.session";

/** The slice of localStorage the session helpers need (injectable in tests). */
export type SessionStorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function browserStorage(): SessionStorageLike | null {
  const storage = (globalThis as { localStorage?: SessionStorageLike }).localStorage;
  return storage ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates a parsed session candidate; null when anything essential is missing. */
function asStoredSession(raw: unknown): StoredSession | null {
  if (
    isRecord(raw) &&
    typeof raw.token === "string" &&
    raw.token.length > 0 &&
    typeof raw.expires_at === "string" &&
    !Number.isNaN(Date.parse(raw.expires_at)) &&
    isRecord(raw.user) &&
    typeof raw.user.id === "string"
  ) {
    return raw as unknown as StoredSession;
  }
  return null;
}

/**
 * Reads the stored session, or null when absent, malformed, or past its
 * expiry. A malformed or expired row is removed so the next boot skips
 * straight to signed-out.
 */
export function readSession(storage?: SessionStorageLike | null): StoredSession | null {
  const store = storage === undefined ? browserStorage() : storage;
  if (store === null) {
    return null;
  }
  const raw = store.getItem(SESSION_KEY);
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    store.removeItem(SESSION_KEY);
    return null;
  }
  const session = asStoredSession(parsed);
  if (session === null) {
    store.removeItem(SESSION_KEY);
    return null;
  }
  if (Date.parse(session.expires_at) <= Date.now()) {
    store.removeItem(SESSION_KEY);
    return null;
  }
  return session;
}

/** Persists a fresh signup/login session. */
export function writeSession(session: StoredSession, storage?: SessionStorageLike | null): void {
  const store = storage === undefined ? browserStorage() : storage;
  if (store === null) {
    return;
  }
  store.setItem(SESSION_KEY, JSON.stringify(session));
}

/** Forgets the stored session (logout, or an expired read). */
export function clearSession(storage?: SessionStorageLike | null): void {
  const store = storage === undefined ? browserStorage() : storage;
  if (store === null) {
    return;
  }
  store.removeItem(SESSION_KEY);
}

/** Where the auth surface stands right now. */
export type AuthState = "signed-out" | "signed-in" | "auth-expired";

/** The subset of the API client the auth store drives. */
export type AuthApi = Pick<ApiClient, "signup" | "login" | "logout">;

export type AuthStoreOptions = {
  api: AuthApi;
  /** Storage override for tests; defaults to localStorage (or none). */
  storage?: SessionStorageLike | null;
  /**
   * Runs inside logout after the best-effort server call and before the
   * local session is cleared: the seam app-data uses to remove this
   * account's synced data from the device before the app reads as signed
   * out. A throw here leaves the session in place so the caller can
   * report the failure.
   */
  onBeforeSignOut?: (userId: string | null) => Promise<void> | void;
};

export type AuthStore = {
  state: Accessor<AuthState>;
  /** The signed-in user, or null. Kept through "auth-expired" for display. */
  user: Accessor<User | null>;
  signup(input: SignupRequest): Promise<void>;
  login(input: LoginRequest): Promise<void>;
  /** Best-effort server logout, then local sign-out regardless. */
  logout(): Promise<void>;
  /**
   * Marks the session expired (a 401 landed); clears the stored token
   * so a reload boots signed-out instead of signed-in until the next
   * 401, and keeps user for display while the expired state shows.
   */
  markExpired(): void;
};

/**
 * Creates the auth store. It boots from any valid stored session, so a
 * reload restores "signed-in" without calling the API; signup/login
 * store the fresh session and flip to "signed-in"; logout clears
 * locally even when the network call fails (the token may already be
 * dead server-side).
 */
export function createAuthStore(options: AuthStoreOptions): AuthStore {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const boot = readSession(storage);
  const [state, setState] = createSignal<AuthState>(boot === null ? "signed-out" : "signed-in");
  const [user, setUser] = createSignal<User | null>(boot?.user ?? null);

  async function adopt(auth: AuthResponse): Promise<void> {
    writeSession(
      { token: auth.token, expires_at: auth.expires_at, user: auth.user },
      storage,
    );
    setUser(auth.user);
    setState("signed-in");
  }

  return {
    state,
    user,
    signup(input: SignupRequest): Promise<void> {
      return options.api.signup(input).then(adopt);
    },
    login(input: LoginRequest): Promise<void> {
      return options.api.login(input).then(adopt);
    },
    async logout(): Promise<void> {
      try {
        await options.api.logout();
      } catch {
        // The token may already be dead; local sign-out proceeds anyway.
      }
      // The device wipe runs before the state flips: an offline server
      // call must not stop this account's local copy from being removed.
      if (options.onBeforeSignOut !== undefined) {
        await options.onBeforeSignOut(user()?.id ?? null);
      }
      clearSession(storage);
      setUser(null);
      setState("signed-out");
    },
    markExpired(): void {
      // The token is dead server-side: forget it so a reload boots
      // signed-out instead of signed-in until a 401 proves the session
      // dead again. The user signal stays for display.
      clearSession(storage);
      setState("auth-expired");
    },
  };
}
