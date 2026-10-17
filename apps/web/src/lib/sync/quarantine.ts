/**
 * Quarantine view model: the pure display shape behind the Account
 * screen's "Paused changes" list.
 *
 * The outbox records only the last server error and an attempt count, so
 * every sentence here is derived from those fields plus the op's own
 * payload. Keeping the mapping pure lets the list, its count copy, and
 * their tests share one source of truth without touching IndexedDB or the
 * DOM.
 *
 * The outbox has no separate quarantine timestamp, so "parked age" is
 * measured from `created_at`: how long the change has been unable to
 * reach the server.
 */

import type { ActivityType, ApiErrorCode } from "@waveform/api-types";
import type { OutboxAction, OutboxEntity, OutboxOp, OutboxRowMap } from "../../db/types";
import { DISCIPLINES } from "../activities";

/** One parked op as the list renders it. */
export type QuarantineEntry = {
  op_id: string;
  entity: OutboxEntity;
  action: OutboxAction;
  /** One line naming the change: action, entity, and the row's key figure. */
  summary: string;
  /** The server's rejection reason in plain words. */
  reason: string;
  /** Failed push attempts recorded for the op. */
  attempts: number;
  /** How long the change has been waiting, relative to `now`. */
  parkedAge: string;
};

/** The count line and empty-state copy the list shows. */
export type QuarantineCopy = {
  /** The disclosure summary: "Paused changes", with a count when any. */
  heading: string;
  /** Empty-state title when nothing is parked. */
  emptyTitle: string;
  /** Empty-state body when nothing is parked. */
  emptyBody: string;
};

/** Singular entity names, read after an action verb ("Edit exercise ..."). */
const ENTITY_NAMES: Readonly<Record<OutboxEntity, string>> = {
  exercises: "exercise",
  workout_sessions: "workout",
  exercise_entries: "exercise entry",
  set_entries: "set",
  activities: "activity",
  body_stats: "body stats",
  routines: "routine",
  routine_entries: "routine entry",
};

const ACTION_NAMES: Readonly<Record<OutboxAction, string>> = {
  create: "New",
  update: "Edit",
  delete: "Delete",
};

/**
 * Plain sentences for the server's rejection codes. Partial so a code the
 * server may add later still falls back at runtime, while a stale or
 * misspelled key here is a compile error to resolve deliberately.
 */
const REASON_COPY: Readonly<Partial<Record<ApiErrorCode, string>>> = {
  bad_request: "The server rejected the change as malformed.",
  invalid_payload: "The server rejected the change as invalid.",
  payload_too_large: "The change was too large for the server.",
  unauthorized: "The session expired before the change was pushed.",
  forbidden: "This device is not allowed to change that row.",
  not_found: "The server no longer has the row this change targets.",
  conflict: "The server found a newer copy of the row.",
  rate_limited: "The server was rate limiting the change.",
  internal: "The server hit an internal error.",
};

/**
 * Recovers the entity/payload pairing an OutboxOp carries by construction.
 * `OutboxOp` stores `payload` as the union of every row type, so a switch
 * on `entity` cannot narrow it; this mapped union restores that link.
 */
type CorrelatedOp = {
  [E in OutboxEntity]: { entity: E; payload: OutboxRowMap[E] };
}[OutboxEntity];

/** The display label for an activity type, reusing the discipline cards. */
function activityTypeLabel(type: ActivityType): string {
  return DISCIPLINES.find((card) => card.type === type)?.label ?? type;
}

/** The identifying figure for one op's row, read from its payload. */
function describeRow(op: CorrelatedOp): string {
  switch (op.entity) {
    case "exercises":
      return `"${op.payload.name}"`;
    case "workout_sessions":
      return `on ${op.payload.local_date}`;
    case "exercise_entries":
      return "in a workout";
    case "set_entries":
      return `${op.payload.weight_kg} kg x ${op.payload.reps}`;
    case "activities":
      return `${activityTypeLabel(op.payload.type)} on ${op.payload.local_date}`;
    case "body_stats":
      return `on ${op.payload.local_date}`;
    case "routines":
      return `"${op.payload.name}"`;
    case "routine_entries":
      return `${op.payload.target_sets} x ${op.payload.target_reps}`;
  }
}

/** The server's reason in plain words, or a fallback when none is stored. */
function reasonCopy(error: string | null | undefined): string {
  if (error === null || error === undefined || error.length === 0) {
    return "The server gave no reason.";
  }
  // The stored code is untyped text from the outbox; read it as a known
  // code for the lookup and let the fallback cover anything unrecognized.
  const copy: string | undefined = REASON_COPY[error as ApiErrorCode];
  return copy ?? `The server said: ${error}.`;
}

/**
 * "just now", "5 min ago", "3 h ago", "2 d ago", or "1 mo ago": how long
 * an op has waited, from `createdAt` to `now`. An unparseable stamp reads
 * "at an unknown time" instead of leaking Invalid Date.
 */
export function formatParkedAge(createdAt: string, now: Date): string {
  const createdMs = new Date(createdAt).getTime();
  if (Number.isNaN(createdMs)) {
    return "at an unknown time";
  }
  const minutes = Math.floor((now.getTime() - createdMs) / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days} d ago`;
  }
  return `${Math.floor(days / 30)} mo ago`;
}

/**
 * One entry per parked op, in the order the repo returns them (drain
 * order). `now` anchors the relative age so tests and the UI agree.
 */
export function formatQuarantineEntries(
  ops: readonly OutboxOp[],
  now: Date,
): QuarantineEntry[] {
  return ops.map((op) => ({
    op_id: op.op_id,
    entity: op.entity,
    action: op.action,
    summary: `${ACTION_NAMES[op.action]} ${ENTITY_NAMES[op.entity]} ${describeRow(op as CorrelatedOp)}`,
    reason: reasonCopy(op.last_error),
    attempts: op.attempts ?? 0,
    parkedAge: formatParkedAge(op.created_at, now),
  }));
}

/**
 * The disclosure heading and empty-state copy for a parked count. The
 * heading carries the number only when there is something to show, so the
 * collapsed line stays quiet at zero. The caller passes the number of
 * entries it actually loaded, so the heading can never count more than
 * the body shows.
 */
export function quarantineCopy(count: number): QuarantineCopy {
  return {
    heading: count > 0 ? `Paused changes (${count})` : "Paused changes",
    emptyTitle: "Nothing is paused",
    emptyBody:
      "Changes the server rejects three times park here. Right now every change has reached the server.",
  };
}

/**
 * The copy for when the parked list cannot be read: this device holds no
 * bound repos (a foreign or unknown log) or the read failed. It says so
 * plainly instead of reusing the reassuring empty state, which would
 * claim every change reached the server when that is unknown.
 */
export function quarantineUnavailableCopy(): QuarantineCopy {
  return {
    heading: "Paused changes",
    emptyTitle: "Paused changes are unavailable",
    emptyBody:
      "This device cannot read its sync queue right now, so it cannot say whether any change is paused.",
  };
}
