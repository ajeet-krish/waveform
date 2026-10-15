/**
 * Parity between the local CATALOG_SEED array and the SQL seed migration.
 *
 * The migration is the source of truth (the server runs it); this test
 * parses migrations/0002_seed_catalog.sql and fails with a readable diff
 * whenever the transcription drifts in content or in file order. File
 * order matters: the first rows are the v1 legacy names the import wizard
 * maps on.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATALOG_SEED, type CatalogSeedRow } from "./catalog";

const MIGRATION_URL = new URL(
  "../../../../../migrations/0002_seed_catalog.sql",
  import.meta.url,
);

type SqlRow = { name: string; muscle_group: string; equipment: string | null };

function parseSqlRows(sql: string): SqlRow[] {
  const pattern =
    /\(gen_random_uuid\(\),\s*NULL,\s*'([^']*)',\s*'([^']*)',\s*(?:'([^']*)'|NULL)\)/g;
  const rows: SqlRow[] = [];
  for (const match of sql.matchAll(pattern)) {
    rows.push({
      name: match[1] ?? "",
      muscle_group: match[2] ?? "",
      equipment: match[3] ?? null,
    });
  }
  return rows;
}

function formatRow(row: SqlRow): string {
  return `${row.name} / ${row.muscle_group} / ${row.equipment ?? "null"}`;
}

/** Returns a human-readable description of the first ordered mismatch, or null. */
function orderedDiff(expected: readonly SqlRow[], actual: readonly SqlRow[]): string | null {
  if (expected.length !== actual.length) {
    return `length mismatch: seed has ${expected.length}, migration has ${actual.length}`;
  }
  for (const [index, row] of expected.entries()) {
    const other = actual[index];
    if (!other) {
      return `migration ended early at row ${index + 1} (${formatRow(row)})`;
    }
    if (
      row.name !== other.name ||
      row.muscle_group !== other.muscle_group ||
      row.equipment !== other.equipment
    ) {
      return [
        `first mismatch at row ${index + 1}:`,
        `  seed:      ${formatRow(row)}`,
        `  migration: ${formatRow(other)}`,
      ].join("\n");
    }
  }
  return null;
}

function lowerNameSet(rows: readonly SqlRow[]): Set<string> {
  return new Set(rows.map((row) => row.name.toLowerCase()));
}

function onlyIn(left: Set<string>, right: Set<string>): string[] {
  const out: string[] = [];
  for (const name of left) {
    if (!right.has(name)) {
      out.push(name);
    }
  }
  return out;
}

function sortedSignature(rows: readonly SqlRow[]): string[] {
  return rows
    .map((row) => `${row.name.toLowerCase()}|${row.muscle_group}|${row.equipment ?? ""}`)
    .sort();
}

describe("catalog parity with migrations/0002_seed_catalog.sql", () => {
  const sql = readFileSync(MIGRATION_URL, "utf8");

  it("declares exactly one INSERT with the expected column order and conflict clause", () => {
    expect(sql.match(/INSERT INTO exercises/g)).toHaveLength(1);
    expect(sql).toContain(
      "INSERT INTO exercises (id, owner_id, name, muscle_group, equipment) VALUES",
    );
    expect(sql).toContain("ON CONFLICT (lower(name)) WHERE (owner_id IS NULL) DO NOTHING");
  });

  it("parses a non-empty tuple list from the migration", () => {
    const rows = parseSqlRows(sql);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.name).toBe("Bench Press (Barbell)");
    expect(rows.every((row) => row.name.length > 0)).toBe(true);
  });

  it("has unique lower(name) values in both sources", () => {
    const sqlRows = parseSqlRows(sql);
    const sqlNames = sqlRows.map((row) => row.name.toLowerCase());
    const seedNames = CATALOG_SEED.map((row) => row.name.toLowerCase());
    expect(new Set(sqlNames).size, "migration names unique under lower(name)").toBe(
      sqlNames.length,
    );
    expect(new Set(seedNames).size, "seed names unique under lower(name)").toBe(seedNames.length);
  });

  it("matches the migration row count", () => {
    const sqlRows = parseSqlRows(sql);
    expect(CATALOG_SEED.length, "seed row count equals migration row count").toBe(sqlRows.length);
  });

  it("matches the migration in exact file order, with a readable diff", () => {
    const sqlRows = parseSqlRows(sql);
    expect(orderedDiff(CATALOG_SEED, sqlRows)).toBeNull();
  });

  it("matches the migration as a sorted sequence too", () => {
    const sqlRows = parseSqlRows(sql);
    const onlySeed = onlyIn(lowerNameSet(CATALOG_SEED), lowerNameSet(sqlRows));
    const onlySql = onlyIn(lowerNameSet(sqlRows), lowerNameSet(CATALOG_SEED));
    expect(
      { onlyInSeed: onlySeed, onlyInMigration: onlySql },
      "name sets must be identical",
    ).toEqual({ onlyInSeed: [], onlyInMigration: [] });
    expect(sortedSignature(CATALOG_SEED)).toEqual(sortedSignature(sqlRows));
  });
});
