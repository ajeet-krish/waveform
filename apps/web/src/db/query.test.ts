import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createLocalQuery, observeQuery, type LocalQuery } from "./query";
import { createWaveformDb } from "./schema";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("observeQuery", () => {
  it("emits the initial value, re-emits after a write, and stops after unsubscribe", async () => {
    const db = createWaveformDb(`query-observe-${crypto.randomUUID()}`);
    const seen: number[] = [];
    const stop = observeQuery(() => db.sync_meta.toArray(), {
      onNext: (rows) => seen.push(rows.length),
    });

    await vi.waitFor(() => expect(seen).toEqual([0]));
    await db.sync_meta.put({ key: "a", value: 1 });
    await vi.waitFor(() => expect(seen).toEqual([0, 1]));

    stop();
    await db.sync_meta.put({ key: "b", value: 2 });
    await sleep(50);
    expect(seen).toEqual([0, 1]);
    db.close();
  });

  it("forwards query failures to onError", async () => {
    const db = createWaveformDb(`query-error-${crypto.randomUUID()}`);
    let shouldThrow = false;
    const errors: unknown[] = [];
    const seen: number[] = [];
    const stop = observeQuery(
      () => {
        if (shouldThrow) {
          throw new Error("boom");
        }
        return db.sync_meta.toArray();
      },
      {
        onNext: (rows) => seen.push(rows.length),
        onError: (error) => errors.push(error),
      },
    );

    await vi.waitFor(() => expect(seen).toEqual([0]));
    shouldThrow = true;
    await db.sync_meta.put({ key: "a", value: 1 });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect((errors[0] as Error).message).toBe("boom");
    stop();
    db.close();
  });
});

describe("createLocalQuery", () => {
  it("runs inside a createRoot: loading flips true to false and writes track", async () => {
    const db = createWaveformDb(`query-local-${crypto.randomUUID()}`);
    let disposeRoot: (() => void) | undefined;
    const query: LocalQuery<number> = createRoot((dispose) => {
      const local = createLocalQuery(() =>
        db.sync_meta.toArray().then((rows) => rows.length),
      );
      disposeRoot = dispose;
      return local;
    });

    expect(query.loading()).toBe(true);
    expect(query.latest()).toBeUndefined();
    await vi.waitFor(() => expect(query.loading()).toBe(false));
    expect(query.latest()).toBe(0);
    expect(query.error()).toBeUndefined();

    await db.sync_meta.put({ key: "a", value: 1 });
    await vi.waitFor(() => expect(query.latest()).toBe(1));

    disposeRoot?.();
    await db.sync_meta.put({ key: "b", value: 2 });
    await sleep(50);
    expect(query.latest()).toBe(1);
    db.close();
  });
});
