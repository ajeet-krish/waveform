/**
 * The command bar's sync chip, as one pure function.
 *
 * The chip is the console's status lamp: it answers "should I sign in?",
 * "is this moving?", or "is this caught up?" in three mono words at most.
 * The tone rides along so the command bar and the account readout can
 * paint the same dot and word from the same decision: steady green means
 * synced, live magenta means syncing right now, load amber means a
 * stopped or failing state, and faint means quiet waiting.
 */

import type { AuthState } from "../session";
import type { SyncStatus } from "./engine";

/** The lamp color a chip state earns (maps to the signal tokens). */
export type SyncChipTone = "steady" | "live" | "load" | "idle";

export type SyncChip = {
  /** The chip's short text: "synced", "pending 3", "offline", "sign in". */
  label: string;
  tone: SyncChipTone;
};

export type SyncChipInput = {
  auth: AuthState;
  /** Null while the first-sign-in data choice is still being checked. */
  adoptionNeeded: boolean | null;
  status: SyncStatus;
  pending: number;
  /** Ops parked after repeated failures; they will not retry on their own. */
  quarantinedCount: number;
};

export function syncChip(input: SyncChipInput): SyncChip {
  if (input.auth === "signed-out" || input.auth === "auth-expired") {
    return { label: "sign in", tone: "idle" };
  }
  if (input.adoptionNeeded !== false) {
    // Signed in, but syncing waits on the first-sign-in data choice
    // (true, or null while that check is still running).
    return { label: "local only", tone: "idle" };
  }
  switch (input.status) {
    case "offline":
      return { label: "offline", tone: "load" };
    case "error":
      return { label: "sync error", tone: "load" };
    case "syncing":
    case "waking":
      return { label: "syncing", tone: "live" };
    case "auth-expired":
      return { label: "sign in", tone: "idle" };
    case "idle":
    default:
      break;
  }
  // Parked work outranks queued work: it needs a manual retry, so the chip
  // must not read "synced" (or only "pending") while the Account panel
  // warns that these changes will never retry on their own.
  if (input.quarantinedCount > 0) {
    return { label: `${input.quarantinedCount} paused`, tone: "load" };
  }
  if (input.pending > 0) {
    return { label: `pending ${input.pending}`, tone: "idle" };
  }
  return { label: "synced", tone: "steady" };
}
