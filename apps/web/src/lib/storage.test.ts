import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensurePersistentStorage,
  guardRepos,
  isIndexedDbAvailable,
  isIndexedDbUnavailable,
  isQuotaExceeded,
  persistedStatus,
  reportStorageFailure,
  setPersistApiOverride,
  subscribeStorageFailures,
  wrapWrite,
  type PersistableStorage,
  type StorageFailure,
} from "./storage";

function fakeStorage(options: { persisted: boolean; grant: boolean }): PersistableStorage & {
  persisted: ReturnType<typeof vi.fn>;
  persist: ReturnType<typeof vi.fn>;
} {
  return {
    persisted: vi.fn(async () => options.persisted),
    persist: vi.fn(async () => options.grant),
  };
}

afterEach(() => {
  setPersistApiOverride(undefined);
});

describe("isQuotaExceeded", () => {
  it("recognizes a QuotaExceededError DOMException", () => {
    const error = new DOMException("The quota has been exceeded.", "QuotaExceededError");
    expect(isQuotaExceeded(error)).toBe(true);
  });

  it("recognizes the legacy code 22 shape", () => {
    expect(isQuotaExceeded({ name: "NS_ERROR_DOM_QUOTA_REACHED", code: 22 })).toBe(true);
    expect(isQuotaExceeded({ code: 22, message: "legacy Safari" })).toBe(true);
  });

  it("finds the quota through a cause chain", () => {
    const quota = new DOMException("full", "QuotaExceededError");
    const wrapped = new Error("write failed", { cause: quota });
    expect(isQuotaExceeded(wrapped)).toBe(true);
    expect(isQuotaExceeded(new Error("outer", { cause: new Error("inner", { cause: quota }) }))).toBe(
      true,
    );
  });

  it("finds the quota through an inner chain", () => {
    expect(isQuotaExceeded({ message: "wrapper", inner: { name: "QuotaExceededError" } })).toBe(
      true,
    );
  });

  it("rejects unrelated errors and survives cycles", () => {
    expect(isQuotaExceeded(new TypeError("not storage"))).toBe(false);
    expect(isQuotaExceeded(null)).toBe(false);
    expect(isQuotaExceeded("QuotaExceededError")).toBe(false);
    const cyclic: { name: string; cause?: unknown } = { name: "TypeError" };
    cyclic.cause = cyclic;
    expect(isQuotaExceeded(cyclic)).toBe(false);
  });
});

describe("isIndexedDbAvailable / isIndexedDbUnavailable", () => {
  it("sees fake-indexeddb as available in this test environment", () => {
    expect(isIndexedDbAvailable()).toBe(true);
  });

  it("flags the open-failure DOMExceptions", () => {
    expect(isIndexedDbUnavailable(new DOMException("blocked", "InvalidStateError"))).toBe(true);
    expect(isIndexedDbUnavailable(new DOMException("insecure", "SecurityError"))).toBe(true);
    expect(isIndexedDbUnavailable(new TypeError("nope"))).toBe(false);
  });
});

describe("ensurePersistentStorage", () => {
  it("calls persist at most once across calls (one-shot)", async () => {
    const api = fakeStorage({ persisted: false, grant: true });
    const first = await ensurePersistentStorage(api);
    const second = await ensurePersistentStorage(api);
    const third = await ensurePersistentStorage(api);
    expect(first).toBe("granted");
    expect(second).toBe("granted");
    expect(third).toBe("granted");
    expect(api.persist).toHaveBeenCalledTimes(1);
    expect(api.persisted).toHaveBeenCalledTimes(1);
  });

  it("reports persisted without prompting again", async () => {
    const api = fakeStorage({ persisted: true, grant: false });
    expect(await ensurePersistentStorage(api)).toBe("persisted");
    expect(api.persist).not.toHaveBeenCalled();
  });

  it("reports denied when the browser refuses persistence", async () => {
    const api = fakeStorage({ persisted: false, grant: false });
    expect(await ensurePersistentStorage(api)).toBe("denied");
  });

  it("reports unavailable when there is no StorageManager", async () => {
    setPersistApiOverride(null);
    expect(await ensurePersistentStorage()).toBe("unavailable");
    expect(await persistedStatus()).toBe("unavailable");
  });
});

describe("persistedStatus", () => {
  it("reads the current state without calling persist", async () => {
    const api = fakeStorage({ persisted: false, grant: true });
    expect(await persistedStatus(api)).toBe("denied");
    expect(api.persist).not.toHaveBeenCalled();
    const granted = fakeStorage({ persisted: true, grant: true });
    expect(await persistedStatus(granted)).toBe("persisted");
  });
});

describe("subscribeStorageFailures", () => {
  it("delivers failures and unsubscribes cleanly", () => {
    const received: StorageFailure[] = [];
    const unsubscribe = subscribeStorageFailures((failure) => received.push(failure));
    unsubscribe();
    // Nothing else publishes here; the unsubscribe must not throw either.
    expect(received).toEqual([]);
  });
});

describe("reportStorageFailure", () => {
  it("publishes one quota failure and reports that it did", () => {
    const quota = new DOMException("The quota has been exceeded.", "QuotaExceededError");
    const received: StorageFailure[] = [];
    const unsubscribe = subscribeStorageFailures((failure) => received.push(failure));
    try {
      expect(reportStorageFailure(quota)).toBe(true);
    } finally {
      unsubscribe();
    }
    expect(received).toEqual([{ kind: "quota", message: "The quota has been exceeded." }]);
  });

  it("publishes nothing for a non-storage error", () => {
    const received: StorageFailure[] = [];
    const unsubscribe = subscribeStorageFailures((failure) => received.push(failure));
    try {
      expect(reportStorageFailure(new TypeError("logic bug"))).toBe(false);
      expect(reportStorageFailure(null)).toBe(false);
    } finally {
      unsubscribe();
    }
    expect(received).toEqual([]);
  });
});

describe("wrapWrite", () => {
  it("attempts persistence once across calls, then runs the wrapped method", async () => {
    const api = fakeStorage({ persisted: false, grant: true });
    setPersistApiOverride(api);
    const method = vi.fn(async (value: number) => value * 2);
    const wrapped = wrapWrite(method);

    expect(await wrapped(21)).toBe(42);
    expect(await wrapped(10)).toBe(20);
    expect(api.persist).toHaveBeenCalledTimes(1);
    expect(method).toHaveBeenCalledTimes(2);
  });

  it("rethrows the original error unchanged and publishes one quota failure", async () => {
    setPersistApiOverride(fakeStorage({ persisted: true, grant: false }));
    const quota = new DOMException("The quota has been exceeded.", "QuotaExceededError");
    const failing = vi.fn(async () => {
      throw quota;
    });
    const wrapped = wrapWrite(failing);
    const received: StorageFailure[] = [];
    const unsubscribe = subscribeStorageFailures((failure) => received.push(failure));

    await expect(wrapped()).rejects.toBe(quota);
    expect(received).toEqual([
      { kind: "quota", message: "The quota has been exceeded." },
    ]);
    unsubscribe();
  });

  it("publishes nothing for a non-quota error", async () => {
    setPersistApiOverride(fakeStorage({ persisted: true, grant: false }));
    const boom = new TypeError("logic bug");
    const wrapped = wrapWrite(async () => {
      throw boom;
    });
    const received: StorageFailure[] = [];
    const unsubscribe = subscribeStorageFailures((failure) => received.push(failure));

    await expect(wrapped()).rejects.toBe(boom);
    expect(received).toEqual([]);
    unsubscribe();
  });

  it("publishes an unavailable failure when IndexedDB itself is blocked", async () => {
    setPersistApiOverride(fakeStorage({ persisted: true, grant: false }));
    const blocked = new DOMException("databases are not available", "InvalidStateError");
    const wrapped = wrapWrite(async () => {
      throw blocked;
    });
    const received: StorageFailure[] = [];
    const unsubscribe = subscribeStorageFailures((failure) => received.push(failure));

    await expect(wrapped()).rejects.toBe(blocked);
    expect(received).toHaveLength(1);
    expect(received[0]?.kind).toBe("unavailable");
    unsubscribe();
  });
});

describe("guardRepos", () => {
  it("wraps every function-valued member recursively and leaves data alone", async () => {
    setPersistApiOverride(fakeStorage({ persisted: false, grant: true }));
    const quota = new DOMException("full", "QuotaExceededError");
    const repos = {
      sessions: {
        create: async () => "created",
        boom: async () => {
          throw quota;
        },
        meta: { label: "untouched" },
      },
      count: 7,
    };

    const guarded = guardRepos(repos);
    expect(guarded.count).toBe(7);
    expect(guarded.sessions.meta).toEqual({ label: "untouched" });
    expect(await guarded.sessions.create()).toBe("created");

    const received: StorageFailure[] = [];
    const unsubscribe = subscribeStorageFailures((failure) => received.push(failure));
    await expect(guarded.sessions.boom()).rejects.toBe(quota);
    expect(received).toEqual([{ kind: "quota", message: "full" }]);
    unsubscribe();
  });

  it("passes non-plain values through by reference instead of cloning them", () => {
    setPersistApiOverride(fakeStorage({ persisted: true, grant: false }));
    const openedAt = new Date("2026-10-14T00:00:00.000Z");
    const tags = new Map([["focus", "chest"]]);
    const rows = [{ id: "row-1" }];
    const guarded = guardRepos({
      meta: { openedAt, tags },
      rows,
      read: async () => "read",
    });

    // Only plain objects are rebuilt; Date, Map, and Array keep identity.
    expect(guarded.meta.openedAt).toBe(openedAt);
    expect(guarded.meta.tags).toBe(tags);
    expect(guarded.rows).toBe(rows);
  });
});
