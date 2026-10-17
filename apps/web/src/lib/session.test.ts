import { describe, expect, it, vi } from "vitest";
import type { AuthResponse, User } from "@waveform/api-types";
import type { ApiClient } from "./api";
import {
  createAuthStore,
  clearSession,
  readSession,
  SESSION_KEY,
  writeSession,
  type SessionStorageLike,
  type StoredSession,
} from "./session";

const USER: User = {
  id: "user-1",
  email: "ada@example.com",
  display_name: "Ada",
  github_id: null,
  avatar_url: null,
  created_at: "2026-10-14T00:00:00.000Z",
  updated_at: "2026-10-14T00:00:00.000Z",
  deleted_at: null,
};

const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";

/** An in-memory localStorage stand-in for the node test env. */
function memStorage(): SessionStorageLike & { raw(): string | null } {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    raw: () => store.get(SESSION_KEY) ?? null,
  };
}

function session(overrides: Partial<StoredSession> = {}): StoredSession {
  return { token: "tok-1", expires_at: FUTURE, user: USER, ...overrides };
}

/** An auth API stub that hands back a canned AuthResponse per call. */
function stubAuthApi(
  response: AuthResponse,
): Pick<ApiClient, "signup" | "login" | "logout"> & { logoutCalls: () => number } {
  let logouts = 0;
  return {
    signup: vi.fn(async () => response),
    login: vi.fn(async () => response),
    logout: vi.fn(async () => {
      logouts += 1;
    }),
    logoutCalls: () => logouts,
  };
}

describe("session persistence", () => {
  it("round-trips a stored session", () => {
    const storage = memStorage();
    writeSession(session(), storage);
    expect(readSession(storage)).toEqual(session());
  });

  it("drops and clears a past-expiry session", () => {
    const storage = memStorage();
    writeSession(session({ expires_at: PAST }), storage);
    expect(readSession(storage)).toBeNull();
    expect(storage.raw()).toBeNull();
  });

  it("clears malformed JSON and invalid shapes", () => {
    const storage = memStorage();
    storage.setItem(SESSION_KEY, "{not json");
    expect(readSession(storage)).toBeNull();
    expect(storage.raw()).toBeNull();

    storage.setItem(SESSION_KEY, JSON.stringify({ token: "t" }));
    expect(readSession(storage)).toBeNull();
    expect(storage.raw()).toBeNull();
  });

  it("clearSession removes the key", () => {
    const storage = memStorage();
    writeSession(session(), storage);
    clearSession(storage);
    expect(storage.raw()).toBeNull();
  });
});

describe("createAuthStore", () => {
  it("boots signed-out with no stored session", () => {
    const api = stubAuthApi({ token: "t", expires_at: FUTURE, user: USER });
    const store = createAuthStore({ api, storage: memStorage() });
    expect(store.state()).toBe("signed-out");
    expect(store.user()).toBeNull();
  });

  it("boots signed-in from a valid stored session", () => {
    const storage = memStorage();
    writeSession(session(), storage);
    const api = stubAuthApi({ token: "t", expires_at: FUTURE, user: USER });
    const store = createAuthStore({ api, storage });
    expect(store.state()).toBe("signed-in");
    expect(store.user()?.id).toBe("user-1");
  });

  it("login stores the session and flips to signed-in", async () => {
    const storage = memStorage();
    const api = stubAuthApi({ token: "tok-9", expires_at: FUTURE, user: USER });
    const store = createAuthStore({ api, storage });

    await store.login({ email: "ada@example.com", password: "hunter hunted" });
    expect(store.state()).toBe("signed-in");
    expect(store.user()?.display_name).toBe("Ada");
    expect(readSession(storage)?.token).toBe("tok-9");
  });

  it("signup stores the session too", async () => {
    const storage = memStorage();
    const api = stubAuthApi({ token: "tok-2", expires_at: FUTURE, user: USER });
    const store = createAuthStore({ api, storage });

    await store.signup({
      email: "ada@example.com",
      password: "hunter hunted",
      display_name: "Ada",
    });
    expect(store.state()).toBe("signed-in");
    expect(readSession(storage)?.token).toBe("tok-2");
  });

  it("a failed login leaves the store signed-out", async () => {
    const storage = memStorage();
    const api = stubAuthApi({ token: "t", expires_at: FUTURE, user: USER });
    api.login = vi.fn(async () => {
      throw new Error("invalid email or password");
    });
    const store = createAuthStore({ api, storage });

    await expect(
      store.login({ email: "ada@example.com", password: "nope" }),
    ).rejects.toThrow(/invalid email or password/);
    expect(store.state()).toBe("signed-out");
    expect(readSession(storage)).toBeNull();
  });

  it("logout clears locally even when the network call fails", async () => {
    const storage = memStorage();
    writeSession(session(), storage);
    const api = stubAuthApi({ token: "t", expires_at: FUTURE, user: USER });
    api.logout = vi.fn(async () => {
      throw new Error("offline");
    });
    const store = createAuthStore({ api, storage });
    expect(store.state()).toBe("signed-in");

    await store.logout();
    expect(store.state()).toBe("signed-out");
    expect(store.user()).toBeNull();
    expect(storage.raw()).toBeNull();
  });

  it("markExpired flips to auth-expired, keeps the user, and forgets the token", async () => {
    const storage = memStorage();
    const api = stubAuthApi({ token: "t", expires_at: FUTURE, user: USER });
    const store = createAuthStore({ api, storage });
    await store.login({ email: "a@b.co", password: "hunter hunted" });

    store.markExpired();
    expect(store.state()).toBe("auth-expired");
    expect(store.user()?.id).toBe("user-1");
    // The dead token is gone from storage, so a reload boots signed-out
    // instead of signed-in until a 401 proves the session dead again.
    expect(storage.raw()).toBeNull();
    expect(readSession(storage)).toBeNull();
  });

  it("runs onBeforeSignOut before flipping state, even when the server call fails", async () => {
    const storage = memStorage();
    writeSession(session(), storage);
    const api = stubAuthApi({ token: "t", expires_at: FUTURE, user: USER });
    api.logout = vi.fn(async () => {
      throw new Error("offline");
    });
    const order: string[] = [];
    const store = createAuthStore({
      api,
      storage,
      onBeforeSignOut: (userId) => {
        // The wipe runs while the app still reads signed-in, so the
        // account's data is removed before the state flips.
        order.push(`${userId}:${store.state()}`);
      },
    });

    await store.logout();

    expect(order).toEqual(["user-1:signed-in"]);
    expect(store.state()).toBe("signed-out");
    expect(store.user()).toBeNull();
    expect(storage.raw()).toBeNull();
  });

  it("keeps the session when onBeforeSignOut throws", async () => {
    const storage = memStorage();
    writeSession(session(), storage);
    const api = stubAuthApi({ token: "t", expires_at: FUTURE, user: USER });
    const store = createAuthStore({
      api,
      storage,
      onBeforeSignOut: () => {
        throw new Error("quota");
      },
    });

    await expect(store.logout()).rejects.toThrow(/quota/);
    // The failed wipe leaves the session in place so the caller can report it.
    expect(store.state()).toBe("signed-in");
    expect(store.user()?.id).toBe("user-1");
    expect(storage.raw()).not.toBeNull();
  });
});
