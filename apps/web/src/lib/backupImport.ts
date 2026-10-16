/**
 * Backup import: a Waveform v2 backup file becomes local rows again.
 *
 * Parsing is pure and all-or-nothing: parseBackup validates the envelope
 * (format, version, app block), every collection, every row's shape,
 * identity and timestamps, and each row against the same db/validation
 * guards the repos use. A JSON-legal but non-object row element (null, a
 * string, a number, an array) rejects the file with an issue before any
 * field is read off it, so a bad element can never throw a TypeError.
 * One bad row rejects the whole file with per-row issues, so a rejected
 * parse can never cause a write.
 *
 * Applying runs in ONE Dexie transaction per mode. Merge writes only
 * rows whose incoming updated_at is strictly newer than the local copy
 * (last-write-wins on parsed instants, so equal times compare equal
 * however they are shaped) and never touches existing outbox rows;
 * replace wipes the data
 * stores, outbox, and sync_meta, then restores every backup row with one
 * op each. Server-owned catalog exercise rows are the exception in both
 * modes: they are written locally but queue no op, since the server
 * already owns them. Op updated_at always equals the row's own updated_at
 * (LWW truth), while op created_at is import time so the outbox drains in
 * import order. After any apply, ensureCatalog self-heals a backup that
 * carries no catalog rows and reconciles stale global catalog rows back
 * to the current seed (a hard delete writes no ops, so the queue is
 * untouched).
 */

import { e1rmBrzycki } from "@waveform/scoring";
import type { EntityTable, IDType } from "dexie";
import type {
  Activity,
  BodyStats,
  Exercise,
  ExerciseEntry,
  SetEntry,
  WorkoutSession,
} from "@waveform/api-types";
import { ensureCatalog } from "../db/seed/ensureCatalog";
import { buildOutboxOp } from "../db/outbox";
import { isServerOwnedRow } from "../db/serverOwned";
import type { WaveformDb } from "../db/schema";
import type {
  ClimbSends,
  LocalProfile,
  LocalRow,
  OutboxAction,
  OutboxEntity,
  OutboxOp,
  OutboxRowMap,
} from "../db/types";
import {
  assertValidActivity,
  assertValidBodyStat,
  assertValidEntry,
  assertValidSet,
  assertValidWorkout,
  LocalValidationError,
} from "../db/validation";
import { toSetWrite } from "../db/repos/workouts";
import type { WaveformBackupV2 } from "./backup";
import { reportStorageFailure } from "./storage";

/** How an imported backup meets the local log. */
export type ImportMode = "merge" | "replace";

/** A pure parse outcome: a validated backup plus warnings, or issues. */
export type ImportParseResult =
  | { ok: true; backup: WaveformBackupV2; warnings: string[] }
  | { ok: false; issues: string[] };

/** Rows written per store by one applied import. */
export type ImportStoreCounts = {
  exercises: number;
  workout_sessions: number;
  exercise_entries: number;
  set_entries: number;
  activities: number;
  body_stats: number;
  climb_sends: number;
};

/** What one applied import did. */
export type ImportSummary = {
  mode: ImportMode;
  stores: ImportStoreCounts;
  profileRestored: boolean;
  opsQueued: number;
};

export type ImportOptions = {
  mode: ImportMode;
  /** Required (true) for replace: the wipe cannot happen silently. */
  confirmReplace?: boolean;
  /** Import clock override for op created_at; defaults to the wall clock. */
  now?: () => Date;
};

function emptyCounts(): ImportStoreCounts {
  return {
    exercises: 0,
    workout_sessions: 0,
    exercise_entries: 0,
    set_entries: 0,
    activities: 0,
    body_stats: 0,
    climb_sends: 0,
  };
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error && cause.message) {
    return cause.message;
  }
  return "the file could not be read";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for an ISO 8601 timestamp string Date can parse (has a date and a time). */
function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" && value.includes("T") && !Number.isNaN(Date.parse(value))
  );
}

/**
 * Ranks an updated_at for last-write-wins: parsed epoch milliseconds, so
 * equal instants compare equal however they are shaped (2026-10-15T10:00:00Z
 * against 2026-10-15T10:00:00.000Z). An unparseable value ranks oldest,
 * which keeps the order stable and lets every valid timestamp win over it.
 */
function updatedAtRank(value: string): number {
  const epoch = Date.parse(value);
  return Number.isNaN(epoch) ? Number.NEGATIVE_INFINITY : epoch;
}

/** Identity and timestamp fields every synced row carries. */
function baseRowIssues(label: string, row: Record<string, unknown>): string[] {
  const issues: string[] = [];
  if (typeof row.id !== "string" || row.id.length === 0) {
    issues.push(`${label}: id must be a non-empty string`);
  }
  if (!isIsoTimestamp(row.created_at)) {
    issues.push(`${label}: created_at must be an ISO timestamp`);
  }
  if (!isIsoTimestamp(row.updated_at)) {
    issues.push(`${label}: updated_at must be an ISO timestamp`);
  }
  if (!(row.deleted_at === null || isIsoTimestamp(row.deleted_at))) {
    issues.push(`${label}: deleted_at must be null or an ISO timestamp`);
  }
  return issues;
}

/** Runs a repo validation guard, collecting its issues under the row label. */
function guardIssues(label: string, run: () => void): string[] {
  try {
    run();
    return [];
  } catch (cause) {
    if (cause instanceof LocalValidationError) {
      return cause.issues.map((issue) => `${label}: ${issue}`);
    }
    return [`${label}: ${messageOf(cause)}`];
  }
}

function profileIssues(profile: Record<string, unknown>): string[] {
  const issues: string[] = [];
  if (typeof profile.id !== "string" || profile.id.length === 0) {
    issues.push("profile: id must be a non-empty string");
  }
  if (typeof profile.display_name !== "string" || profile.display_name.length === 0) {
    issues.push("profile: display_name must be a non-empty string");
  }
  if (!(profile.email === null || typeof profile.email === "string")) {
    issues.push("profile: email must be null or a string");
  }
  if (!(profile.avatar_url === null || typeof profile.avatar_url === "string")) {
    issues.push("profile: avatar_url must be null or a string");
  }
  if (!isIsoTimestamp(profile.created_at)) {
    issues.push("profile: created_at must be an ISO timestamp");
  }
  if (!isIsoTimestamp(profile.updated_at)) {
    issues.push("profile: updated_at must be an ISO timestamp");
  }
  const settings = profile.settings;
  const validWeight = settings === null || typeof settings !== "object"
    ? false
    : (settings as Record<string, unknown>).display_weight_unit === "kg" ||
      (settings as Record<string, unknown>).display_weight_unit === "lb";
  const validLength = settings === null || typeof settings !== "object"
    ? false
    : (settings as Record<string, unknown>).display_length_unit === "cm" ||
      (settings as Record<string, unknown>).display_length_unit === "in";
  if (!validWeight || !validLength) {
    issues.push(
      "profile: settings must carry display_weight_unit kg|lb and display_length_unit cm|in",
    );
  }
  return issues;
}

/**
 * Validates a parsed backup envelope plus every row, purely. Any issue
 * anywhere rejects the file: an import is all-or-nothing, so the caller
 * never applies a partially valid backup.
 */
function parseBackupRaw(raw: unknown): ImportParseResult {
  if (!isRecord(raw)) {
    return { ok: false, issues: ["A backup must be a JSON object."] };
  }

  const issues: string[] = [];
  if (raw.format !== "waveform-backup") {
    issues.push(`Unexpected format ${JSON.stringify(raw.format)}; expected "waveform-backup".`);
  }
  if (raw.version === 1) {
    issues.push("This backup was made by an older Waveform version.");
  } else if (typeof raw.version === "number" && raw.version >= 3) {
    issues.push("This backup was made by a newer Waveform. Update this app before importing.");
  } else if (raw.version !== 2) {
    issues.push(`Unsupported backup version ${JSON.stringify(raw.version)}; expected 2.`);
  }
  if (!isRecord(raw.app)) {
    issues.push("The backup is missing its app block.");
  } else {
    if (raw.app.name !== "waveform") {
      issues.push(`Unexpected app name ${JSON.stringify(raw.app.name)}; expected "waveform".`);
    }
    if (raw.app.schema_version !== 2) {
      issues.push(
        `Unsupported app schema_version ${JSON.stringify(raw.app.schema_version)}; expected 2.`,
      );
    }
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const warnings: string[] = [];
  if (!isIsoTimestamp(raw.exported_at)) {
    return { ok: false, issues: ["backup: exported_at must be an ISO timestamp"] };
  }

  const collections: Array<[keyof ImportStoreCounts, string]> = [
    ["exercises", "exercises"],
    ["workout_sessions", "workout_sessions"],
    ["exercise_entries", "exercise_entries"],
    ["set_entries", "set_entries"],
    ["activities", "activities"],
    ["body_stats", "body_stats"],
  ];
  for (const [key, label] of collections) {
    if (!Array.isArray(raw[key])) {
      issues.push(`${label} must be an array.`);
    }
  }
  if (!Array.isArray(raw.climb_sends)) {
    issues.push("climb_sends must be an array.");
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  let profile: LocalProfile | null = null;
  if (raw.profile === null || raw.profile === undefined) {
    if (raw.profile === undefined) {
      warnings.push("The backup carries no profile; the local profile is kept on import.");
    }
  } else if (isRecord(raw.profile)) {
    const found = profileIssues(raw.profile);
    if (found.length > 0) {
      issues.push(...found);
    } else {
      profile = raw.profile as unknown as LocalProfile;
    }
  } else {
    issues.push("profile must be an object or null.");
  }

  const readRows = (key: string): unknown[] => {
    const value = raw[key];
    return Array.isArray(value) ? value : [];
  };

  /**
   * The plain-object rows of one collection. A JSON-legal but
   * non-object element (null, a string, a number, an array) pushes a
   * per-collection issue and never has a field read off it, so the
   * pure parse reports an issue instead of throwing a TypeError.
   */
  const objectRows = (
    label: string,
    rows: unknown[],
  ): Array<Record<string, unknown>> => {
    const objects: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      if (isRecord(row)) {
        objects.push(row);
      } else {
        issues.push(`${label}: must be an object`);
      }
    }
    return objects;
  };

  const exerciseRows = objectRows("exercises", readRows("exercises"));
  const sessionRows = objectRows("workout_sessions", readRows("workout_sessions"));
  const entryRows = objectRows("exercise_entries", readRows("exercise_entries"));
  const setRows = objectRows("set_entries", readRows("set_entries"));
  const activityRows = objectRows("activities", readRows("activities"));
  const bodyRows = objectRows("body_stats", readRows("body_stats"));
  const climbRows = objectRows("climb_sends", readRows("climb_sends"));

  for (const row of exerciseRows) {
    const label = `exercises/${String(row.id)}`;
    issues.push(...baseRowIssues(label, row));
    // isServerOwnedRow classifies a row as server-owned only when owner_id
    // is exactly null; any other shape would read as user-owned and push an
    // op the server then quarantines. Reject it up front instead.
    if (!(row.owner_id === null || typeof row.owner_id === "string")) {
      issues.push(`${label}: owner_id must be null or a string`);
    }
  }
  for (const row of sessionRows) {
    const label = `workout_sessions/${String(row.id)}`;
    issues.push(...baseRowIssues(label, row));
    issues.push(...guardIssues(label, () => assertValidWorkout(row as unknown as WorkoutSession)));
  }
  for (const row of entryRows) {
    const label = `exercise_entries/${String(row.id)}`;
    issues.push(...baseRowIssues(label, row));
    issues.push(...guardIssues(label, () => assertValidEntry(row as unknown as ExerciseEntry)));
  }
  for (const row of setRows) {
    const label = `set_entries/${String(row.id)}`;
    issues.push(...baseRowIssues(label, row));
    if (typeof row.e1rm_kg !== "number" || !Number.isFinite(row.e1rm_kg)) {
      issues.push(`${label}: e1rm_kg must be a finite number`);
    }
    issues.push(...guardIssues(label, () => assertValidSet(row as unknown as SetEntry)));
  }
  for (const row of activityRows) {
    const label = `activities/${String(row.id)}`;
    issues.push(...baseRowIssues(label, row));
    issues.push(...guardIssues(label, () => assertValidActivity(row as unknown as Activity)));
  }
  for (const row of bodyRows) {
    const label = `body_stats/${String(row.id)}`;
    issues.push(...baseRowIssues(label, row));
    issues.push(...guardIssues(label, () => assertValidBodyStat(row as unknown as BodyStats)));
  }

  const activityIds = new Set(activityRows.map((row) => String(row.id)));
  for (const row of climbRows) {
    const label = `climb_sends/${String(row.activity_id)}`;
    if (typeof row.activity_id !== "string" || row.activity_id.length === 0) {
      issues.push(`${label}: activity_id must be a non-empty string`);
    }
    if (!isIsoTimestamp(row.updated_at)) {
      issues.push(`${label}: updated_at must be an ISO timestamp`);
    }
    const counts = row.counts;
    const validCounts =
      Array.isArray(counts) &&
      counts.every((value) => typeof value === "number" && Number.isFinite(value));
    if (!validCounts) {
      issues.push(`${label}: counts must be an array of finite numbers`);
    }
    if (typeof row.activity_id === "string" && !activityIds.has(row.activity_id)) {
      warnings.push(
        `A climb histogram references activity ${row.activity_id}, which the backup does not contain.`,
      );
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const backup: WaveformBackupV2 = {
    format: "waveform-backup",
    version: 2,
    exported_at: raw.exported_at,
    app: { name: "waveform", schema_version: 2 },
    profile,
    exercises: readRows("exercises") as unknown as Array<LocalRow<Exercise>>,
    workout_sessions: readRows("workout_sessions") as unknown as Array<LocalRow<WorkoutSession>>,
    exercise_entries: readRows("exercise_entries") as unknown as Array<LocalRow<ExerciseEntry>>,
    set_entries: readRows("set_entries") as unknown as Array<LocalRow<SetEntry>>,
    activities: readRows("activities") as unknown as Array<LocalRow<Activity>>,
    body_stats: readRows("body_stats") as unknown as Array<LocalRow<BodyStats>>,
    climb_sends: readRows("climb_sends") as unknown as ClimbSends[],
  };
  return { ok: true, backup, warnings };
}

/**
 * Validates a Waveform backup file, purely. All-or-nothing: any issue
 * (bad format, bad version, bad shape, one bad row) returns issues and
 * means zero writes.
 */
export function parseBackup(text: string): ImportParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, issues: ["This file is not valid JSON."] };
  }
  return parseBackupRaw(raw);
}

/**
 * Dispatches an imported file: JSON that carries the Waveform backup
 * format goes to the full version and row validation; anything else is
 * not a Waveform backup and says so.
 */
export function parseImportFile(text: string): ImportParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, issues: ["This file is not valid JSON."] };
  }
  if (isRecord(raw) && raw.format === "waveform-backup") {
    return parseBackupRaw(raw);
  }
  return {
    ok: false,
    issues: ["This does not look like a Waveform backup file."],
  };
}

type MergeRow = { id: string; updated_at: string; deleted_at: string | null };

/** The action a restored or merged row queues: delete ops carry tombstones. */
function rowAction(row: { deleted_at: string | null }, existed: boolean): OutboxAction {
  if (row.deleted_at !== null) {
    return "delete";
  }
  return existed ? "update" : "create";
}

/** Replaced rows never "existed" after the wipe: live rows queue creates. */
function restoreAction(row: { deleted_at: string | null }): OutboxAction {
  return row.deleted_at !== null ? "delete" : "create";
}

/**
 * Merges one id-keyed store: absent rows are written (create, or a
 * delete op when the incoming row is a tombstone), present rows win only
 * when the incoming updated_at is strictly newer, and the rest are
 * skipped without an op. Server-owned catalog rows are written locally
 * without an op. Returns rows written; ops append to `ops`.
 */
async function mergeById<E extends OutboxEntity>(
  table: EntityTable<OutboxRowMap[E], "id">,
  entity: E,
  incoming: OutboxRowMap[E][],
  now: Date,
  ops: OutboxOp[],
): Promise<number> {
  let written = 0;
  for (const row of incoming) {
    const local: MergeRow | undefined = await table.get(
      row.id as IDType<OutboxRowMap[E], "id">,
    );
    if (local && updatedAtRank(row.updated_at) <= updatedAtRank(local.updated_at)) {
      continue;
    }
    await table.put(row);
    written += 1;
    if (!isServerOwnedRow(entity, row)) {
      ops.push(buildOutboxOp(entity, rowAction(row, local !== undefined), row, now, row.updated_at));
    }
  }
  return written;
}

/** Merge for set_entries: same rule, but e1rm_kg is recomputed and kept out of the payload. */
async function mergeSets(
  db: WaveformDb,
  incoming: LocalRow<SetEntry>[],
  now: Date,
  ops: OutboxOp[],
): Promise<number> {
  let written = 0;
  for (const raw of incoming) {
    const row: LocalRow<SetEntry> = { ...raw, e1rm_kg: e1rmBrzycki(raw.weight_kg, raw.reps) };
    const local = await db.set_entries.get(row.id);
    if (local && updatedAtRank(row.updated_at) <= updatedAtRank(local.updated_at)) {
      continue;
    }
    await db.set_entries.put(row);
    written += 1;
    ops.push(
      buildOutboxOp(
        "set_entries",
        rowAction(row, local !== undefined),
        toSetWrite(row),
        now,
        row.updated_at,
      ),
    );
  }
  return written;
}

/** Merge for climb_sends (device-local, keyed by activity id, no ops). */
async function mergeClimbSends(db: WaveformDb, incoming: ClimbSends[]): Promise<number> {
  let written = 0;
  for (const row of incoming) {
    const local = await db.climb_sends.get(row.activity_id);
    if (local && updatedAtRank(row.updated_at) <= updatedAtRank(local.updated_at)) {
      continue;
    }
    await db.climb_sends.put(row);
    written += 1;
  }
  return written;
}

async function runMerge(
  db: WaveformDb,
  backup: WaveformBackupV2,
  now: Date,
): Promise<ImportSummary> {
  return db.transaction(
    "rw",
    [
      db.exercises,
      db.workout_sessions,
      db.exercise_entries,
      db.set_entries,
      db.activities,
      db.body_stats,
      db.climb_sends,
      db.local_profile,
      db.outbox,
    ],
    async () => {
      const stores = emptyCounts();
      const ops: OutboxOp[] = [];
      stores.exercises = await mergeById(db.exercises, "exercises", backup.exercises, now, ops);
      stores.workout_sessions = await mergeById(
        db.workout_sessions,
        "workout_sessions",
        backup.workout_sessions,
        now,
        ops,
      );
      stores.exercise_entries = await mergeById(
        db.exercise_entries,
        "exercise_entries",
        backup.exercise_entries,
        now,
        ops,
      );
      stores.set_entries = await mergeSets(db, backup.set_entries, now, ops);
      stores.activities = await mergeById(db.activities, "activities", backup.activities, now, ops);
      stores.body_stats = await mergeById(db.body_stats, "body_stats", backup.body_stats, now, ops);
      stores.climb_sends = await mergeClimbSends(db, backup.climb_sends);
      await db.outbox.bulkAdd(ops);
      let profileRestored = false;
      if (backup.profile !== null && (await db.local_profile.count()) === 0) {
        await db.local_profile.put(backup.profile);
        profileRestored = true;
      }
      return { mode: "merge", stores, profileRestored, opsQueued: ops.length };
    },
  );
}

async function runReplace(
  db: WaveformDb,
  backup: WaveformBackupV2,
  now: Date,
): Promise<ImportSummary> {
  return db.transaction(
    "rw",
    [
      db.exercises,
      db.workout_sessions,
      db.exercise_entries,
      db.set_entries,
      db.activities,
      db.body_stats,
      db.climb_sends,
      db.local_profile,
      db.outbox,
      db.sync_meta,
    ],
    async () => {
      // Capture the local profile before the wipe so a backup without
      // one keeps the device's own account row.
      const keepProfile = (await db.local_profile.toCollection().first()) ?? null;
      await db.exercises.clear();
      await db.workout_sessions.clear();
      await db.exercise_entries.clear();
      await db.set_entries.clear();
      await db.activities.clear();
      await db.body_stats.clear();
      await db.climb_sends.clear();
      await db.local_profile.clear();
      await db.outbox.clear();
      await db.sync_meta.clear();

      const ops: OutboxOp[] = [];
      for (const row of backup.exercises) {
        await db.exercises.put(row);
        // Catalog rows are server-owned: restore them locally, queue no op.
        if (!isServerOwnedRow("exercises", row)) {
          ops.push(buildOutboxOp("exercises", restoreAction(row), row, now, row.updated_at));
        }
      }
      for (const row of backup.workout_sessions) {
        await db.workout_sessions.put(row);
        ops.push(buildOutboxOp("workout_sessions", restoreAction(row), row, now, row.updated_at));
      }
      for (const row of backup.exercise_entries) {
        await db.exercise_entries.put(row);
        ops.push(buildOutboxOp("exercise_entries", restoreAction(row), row, now, row.updated_at));
      }
      for (const raw of backup.set_entries) {
        const row: LocalRow<SetEntry> = { ...raw, e1rm_kg: e1rmBrzycki(raw.weight_kg, raw.reps) };
        await db.set_entries.put(row);
        ops.push(buildOutboxOp("set_entries", restoreAction(row), toSetWrite(row), now, row.updated_at));
      }
      for (const row of backup.activities) {
        await db.activities.put(row);
        ops.push(buildOutboxOp("activities", restoreAction(row), row, now, row.updated_at));
      }
      for (const row of backup.body_stats) {
        await db.body_stats.put(row);
        ops.push(buildOutboxOp("body_stats", restoreAction(row), row, now, row.updated_at));
      }
      for (const sends of backup.climb_sends) {
        await db.climb_sends.put(sends);
      }
      await db.outbox.bulkAdd(ops);

      const restored = backup.profile ?? keepProfile;
      let profileRestored = false;
      if (restored !== null) {
        await db.local_profile.put(restored);
        profileRestored = backup.profile !== null;
      }

      const stores: ImportStoreCounts = {
        exercises: backup.exercises.length,
        workout_sessions: backup.workout_sessions.length,
        exercise_entries: backup.exercise_entries.length,
        set_entries: backup.set_entries.length,
        activities: backup.activities.length,
        body_stats: backup.body_stats.length,
        climb_sends: backup.climb_sends.length,
      };
      return { mode: "replace", stores, profileRestored, opsQueued: ops.length };
    },
  );
}

/**
 * Applies a parsed backup inside ONE transaction, then self-heals the
 * catalog. Merge queues one op per written row and leaves existing outbox
 * rows alone; replace wipes data stores, outbox, and sync_meta (drafts
 * survive) and re-queues one op per restored row. A quota or blocked
 * IndexedDB failure publishes one StorageFailure on the storage bus, then
 * rethrows unchanged (the transaction has already rolled back).
 *
 * @throws LocalValidationError when mode is replace without confirmReplace.
 */
export async function applyBackupImport(
  db: WaveformDb,
  backup: WaveformBackupV2,
  options: ImportOptions,
): Promise<ImportSummary> {
  if (options.mode === "replace" && options.confirmReplace !== true) {
    throw new LocalValidationError(
      "replace import requires confirmation",
      ["Replacing the local log needs its confirmation step before anything is wiped."],
    );
  }
  const now = options.now ?? (() => new Date());
  try {
    const summary =
      options.mode === "replace"
        ? await runReplace(db, backup, now())
        : await runMerge(db, backup, now());
    await ensureCatalog(db);
    return summary;
  } catch (cause) {
    // The import writes run in one Dexie transaction outside the wrapped
    // repos, so a quota failure would otherwise publish nothing and its
    // raw message would reach the UI. Report it on the storage failure
    // bus (so StorageAlert appears), then rethrow unchanged so the
    // caller's own error path still runs.
    reportStorageFailure(cause);
    throw cause;
  }
}
