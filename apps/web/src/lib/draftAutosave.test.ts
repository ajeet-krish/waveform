import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDraftAutosave } from "./draftAutosave";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createDraftAutosave", () => {
  it("collapses a burst of schedules into one save with the latest draft", async () => {
    const saved: number[] = [];
    let draft: { rev: number } | null = { rev: 0 };
    const autosave = createDraftAutosave({
      getDraft: () => draft,
      save: (value) => {
        saved.push(value.rev);
      },
    });

    autosave.schedule();
    draft = { rev: 1 };
    autosave.schedule();
    draft = { rev: 2 };
    autosave.schedule();

    expect(autosave.pending()).toBe(true);
    await vi.advanceTimersByTimeAsync(399);
    expect(saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(saved).toEqual([2]);
    expect(autosave.pending()).toBe(false);
    await autosave.flush();
  });

  it("flush saves pending work immediately, without waiting for the debounce", async () => {
    const saved: string[] = [];
    let draft: string | null = "draft-a";
    const autosave = createDraftAutosave({
      getDraft: () => draft,
      save: (value) => {
        saved.push(value);
      },
      debounceMs: 400,
    });

    autosave.schedule();
    expect(autosave.pending()).toBe(true);
    expect(saved).toEqual([]);

    await autosave.flush();
    expect(saved).toEqual(["draft-a"]);
    expect(autosave.pending()).toBe(false);

    // Cleanup on a clean slate resolves without writing anything again.
    await autosave.flush();
    expect(saved).toEqual(["draft-a"]);
  });

  it("serializes writes so the last write wins even mid-flight", async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let draft = "a";
    const autosave = createDraftAutosave({
      getDraft: () => draft,
      save: (value) => {
        order.push(`start:${value}`);
        if (value === "a") {
          return first.then(() => {
            order.push("end:a");
          });
        }
        order.push(`end:${value}`);
        return Promise.resolve();
      },
    });

    autosave.schedule();
    await vi.advanceTimersByTimeAsync(400);
    expect(order).toEqual(["start:a"]);
    expect(autosave.pending()).toBe(true);

    draft = "b";
    autosave.schedule();
    const flushed = autosave.flush();
    await Promise.resolve();
    // The second write must not overtake the first.
    expect(order).toEqual(["start:a"]);
    expect(autosave.pending()).toBe(true);

    releaseFirst?.();
    await flushed;
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
    expect(autosave.pending()).toBe(false);
  });

  it("skips the write when the draft is gone", async () => {
    const saved: string[] = [];
    let draft: string | null = "draft-a";
    const autosave = createDraftAutosave({
      getDraft: () => draft,
      save: (value) => {
        saved.push(value);
      },
    });

    draft = null;
    autosave.schedule();
    await vi.advanceTimersByTimeAsync(400);
    expect(saved).toEqual([]);
    expect(autosave.pending()).toBe(false);

    draft = "draft-b";
    autosave.schedule();
    await autosave.flush();
    expect(saved).toEqual(["draft-b"]);
  });

  it("surfaces save failures through flush instead of losing them", async () => {
    let draft: string | null = "draft-a";
    const autosave = createDraftAutosave({
      getDraft: () => draft,
      save: () => {
        draft = null;
        throw new Error("storage is full");
      },
    });

    autosave.schedule();
    await vi.advanceTimersByTimeAsync(400);
    await expect(autosave.flush()).rejects.toThrow("storage is full");
    expect(autosave.pending()).toBe(false);
  });
});
