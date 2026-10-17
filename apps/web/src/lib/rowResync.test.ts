import { describe, expect, it } from "vitest";
import { createIdChangeTracker } from "./rowResync";

describe("createIdChangeTracker", () => {
  it("reports the first identity and every change, exactly once each", () => {
    const tracker = createIdChangeTracker("entry-a");
    expect(tracker.isNew("entry-a")).toBe(false);
    expect(tracker.isNew("entry-a")).toBe(false);
    expect(tracker.isNew("entry-b")).toBe(true);
    expect(tracker.isNew("entry-b")).toBe(false);
    // A move back to the first item is a change again.
    expect(tracker.isNew("entry-a")).toBe(true);
    expect(tracker.isNew("entry-a")).toBe(false);
  });

  it("treats the first identity as new when none was given", () => {
    const tracker = createIdChangeTracker();
    expect(tracker.isNew("entry-a")).toBe(true);
    expect(tracker.isNew("entry-a")).toBe(false);
  });

  it("tracks a composite identity such as id plus display unit", () => {
    const tracker = createIdChangeTracker("entry-a:kg");
    expect(tracker.isNew("entry-a:kg")).toBe(false);
    // Same row, new unit: the row must resync its weight text.
    expect(tracker.isNew("entry-a:lb")).toBe(true);
    expect(tracker.isNew("entry-a:lb")).toBe(false);
    expect(tracker.isNew("entry-b:lb")).toBe(true);
  });
});
