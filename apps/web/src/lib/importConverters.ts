/**
 * Legacy converter seam: the one place a foreign backup format turns into
 * a Waveform backup.
 *
 * A converter takes the parsed JSON of a legacy export (raw `unknown`,
 * already JSON.parse'd) and returns the same ImportParseResult shape the
 * Waveform importer uses, so applyBackupImport treats both sources
 * identically. Nothing is registered in sub-phase 1d: the seam exists so
 * the LiftLog v1 converter lands in phase 2 without touching the importer.
 *
 * Id-mapping rule for future converters: a legacy row keeps its identity
 * through a deterministic uuidV5 (db/seed/uuidV5.ts, same RFC 4122
 * semantics the catalog seed uses) computed over the namespaced string
 * `liftlog:<legacy-id>`, so importing the same legacy file twice yields
 * the same Waveform ids and the merge stays idempotent. Catalog
 * exercises map onto local catalog rows by normalized name through
 * catalogSeedId, exactly like the v1 import wizard.
 */

import type { ImportParseResult } from "./backupImport";

/** The legacy formats a future converter may arrive for. */
export type ImportSource = "liftlog-v1";

/** One legacy format's converter: parsed raw JSON in, Waveform backup out. */
export type ImportConverter = (raw: unknown) => ImportParseResult;

const SOURCE_LABELS: Record<ImportSource, string> = {
  "liftlog-v1": "LiftLog v1",
};

const converters = new Map<ImportSource, ImportConverter>();

/** Registers (or replaces) the converter for one legacy source. */
export function registerLegacyConverter(kind: ImportSource, converter: ImportConverter): void {
  converters.set(kind, converter);
}

/**
 * Removes the converter for one legacy source, so a test that registers
 * a stub can restore the "detection only, Phase 2 issue" behavior
 * without depending on test order.
 */
export function unregisterLegacyConverter(kind: ImportSource): void {
  converters.delete(kind);
}

/** The registered converter for a source, if any. */
export function getLegacyConverter(kind: ImportSource): ImportConverter | undefined {
  return converters.get(kind);
}

/**
 * Recognizes a raw legacy export by shape. The LiftLog v1 backup is the
 * whole local db blob: `{ v: 1, settings, exercises, workouts, ... }`
 * (legacy/app.js seedDb). Unrecognized input returns null; detection
 * never throws.
 */
export function sniffImportSource(raw: unknown): ImportSource | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const candidate = raw as Record<string, unknown>;
  if (
    candidate.v === 1 &&
    Array.isArray(candidate.exercises) &&
    Array.isArray(candidate.workouts)
  ) {
    return "liftlog-v1";
  }
  return null;
}

/** Human-readable name for one legacy source ("LiftLog v1"). */
export function importSourceLabel(kind: ImportSource): string {
  return SOURCE_LABELS[kind];
}
