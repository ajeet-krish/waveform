import { describe, expect, it } from "vitest";
import { syncChip, type SyncChipInput } from "./chip";

function input(overrides: Partial<SyncChipInput> = {}): SyncChipInput {
  return {
    auth: "signed-in",
    adoptionNeeded: false,
    status: "idle",
    pending: 0,
    ...overrides,
  };
}

describe("syncChip", () => {
  it("asks a signed-out or expired session to sign in", () => {
    expect(syncChip(input({ auth: "signed-out" })).label).toBe("sign in");
    expect(syncChip(input({ auth: "auth-expired" })).label).toBe("sign in");
    // Even an engine still reporting a state never speaks for a dead session.
    expect(syncChip(input({ auth: "auth-expired", status: "offline", pending: 4 }))).toEqual({
      label: "sign in",
      tone: "idle",
    });
  });

  it("holds the first-sign-in data choice at local only, null included", () => {
    expect(syncChip(input({ adoptionNeeded: true })).label).toBe("local only");
    expect(syncChip(input({ adoptionNeeded: null })).label).toBe("local only");
    expect(syncChip(input({ adoptionNeeded: null, status: "syncing" })).label).toBe("local only");
  });

  it("maps stopped and moving states onto the lamp", () => {
    expect(syncChip(input({ status: "offline" }))).toEqual({ label: "offline", tone: "load" });
    expect(syncChip(input({ status: "error" }))).toEqual({ label: "sync error", tone: "load" });
    expect(syncChip(input({ status: "syncing" }))).toEqual({ label: "syncing", tone: "live" });
    expect(syncChip(input({ status: "waking" }))).toEqual({ label: "syncing", tone: "live" });
  });

  it("counts queued work before claiming synced", () => {
    expect(syncChip(input({ pending: 3 }))).toEqual({ label: "pending 3", tone: "idle" });
    expect(syncChip(input({ pending: 1, status: "offline" })).label).toBe("offline");
  });

  it("claims synced only when caught up and signed in", () => {
    expect(syncChip(input())).toEqual({ label: "synced", tone: "steady" });
  });
});
