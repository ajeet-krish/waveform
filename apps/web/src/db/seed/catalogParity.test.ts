/**
 * Parity between the local catalog and the SQL migrations.
 *
 * migrations/0002_seed_catalog.sql is the source of truth (the server
 * runs it); this test parses it and fails with a readable diff whenever
 * the transcription drifts in content or in file order. The 27 duplicate
 * names that 0002 seeds are hard-deleted by
 * migrations/0005_catalog_dedup.sql, so CATALOG_SEED must equal exactly
 * 0002 minus CATALOG_REMOVED_NAMES. A second parse holds 0005 against
 * the same removal list, and a third holds the older
 * migrations/0004_catalog_cleanup.sql soft-delete against it too, so no
 * list can drift on its own. File order matters: the first rows are the
 * original catalog names.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATALOG_REMOVED_NAMES, CATALOG_SEED } from "./catalog";

const MIGRATION_URL = new URL(
  "../../../../../migrations/0002_seed_catalog.sql",
  import.meta.url,
);
const CLEANUP_URL = new URL(
  "../../../../../migrations/0004_catalog_cleanup.sql",
  import.meta.url,
);
const DEDUP_URL = new URL("../../../../../migrations/0005_catalog_dedup.sql", import.meta.url);

const SEED_SQL = readFileSync(MIGRATION_URL, "utf8");
const CLEANUP_SQL = readFileSync(CLEANUP_URL, "utf8");
const DEDUP_SQL = readFileSync(DEDUP_URL, "utf8");

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

/** Lowercased retired names, used to subtract the dedup from 0002. */
const REMOVED_LOWER_NAMES: ReadonlySet<string> = new Set(
  CATALOG_REMOVED_NAMES.map((name) => name.toLowerCase()),
);

/** The 0002 rows the dedup does not retire: the expected live seed. */
function expectedLiveRows(sql: string): SqlRow[] {
  return parseSqlRows(sql).filter((row) => !REMOVED_LOWER_NAMES.has(row.name.toLowerCase()));
}

/**
 * Reads the quoted names out of a migration's lower(name) IN (...) list.
 * Names may contain parentheses (for example "Dips (Tricep)"), so the
 * capture runs to the closing paren on its own indented line rather
 * than to the first ")".
 */
function parseInListNames(sql: string): string[] {
  const match = /lower\(name\)\s+IN\s*\(([\s\S]*?)\n\s*\)/.exec(sql);
  const list = match?.[1];
  if (!list) {
    return [];
  }
  return [...list.matchAll(/'([^']*)'/g)].map((entry) => entry[1] ?? "");
}

function lowerSorted(names: readonly string[]): string[] {
  return [...names].map((name) => name.toLowerCase()).sort();
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
  it("declares exactly one INSERT with the expected column order and conflict clause", () => {
    expect(SEED_SQL.match(/INSERT INTO exercises/g)).toHaveLength(1);
    expect(SEED_SQL).toContain(
      "INSERT INTO exercises (id, owner_id, name, muscle_group, equipment) VALUES",
    );
    expect(SEED_SQL).toContain("ON CONFLICT (lower(name)) WHERE (owner_id IS NULL) DO NOTHING");
  });

  it("parses a non-empty tuple list from the migration", () => {
    const rows = parseSqlRows(SEED_SQL);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.name).toBe("Bench Press (Barbell)");
    expect(rows.every((row) => row.name.length > 0)).toBe(true);
  });

  it("has unique lower(name) values in both sources", () => {
    const sqlRows = parseSqlRows(SEED_SQL);
    const sqlNames = sqlRows.map((row) => row.name.toLowerCase());
    const seedNames = CATALOG_SEED.map((row) => row.name.toLowerCase());
    expect(new Set(sqlNames).size, "migration names unique under lower(name)").toBe(
      sqlNames.length,
    );
    expect(new Set(seedNames).size, "seed names unique under lower(name)").toBe(seedNames.length);
  });

  it("retires only names that 0002 actually seeds (typo guard)", () => {
    const sqlNames = lowerNameSet(parseSqlRows(SEED_SQL));
    const missing = CATALOG_REMOVED_NAMES.filter((name) => !sqlNames.has(name.toLowerCase()));
    expect(missing, "every CATALOG_REMOVED_NAMES entry must exist in 0002").toEqual([]);
    const stillSeeded = CATALOG_SEED.filter((row) => REMOVED_LOWER_NAMES.has(row.name.toLowerCase()));
    expect(stillSeeded, "retired names must not remain in CATALOG_SEED").toEqual([]);
  });

  it("matches the migration row count after the 0005 removals", () => {
    const sqlRows = parseSqlRows(SEED_SQL);
    expect(CATALOG_SEED.length, "seed equals migration minus the retired names").toBe(
      expectedLiveRows(SEED_SQL).length,
    );
    // Also catches a duplicated name inside CATALOG_REMOVED_NAMES.
    expect(CATALOG_SEED.length, "118 seeded rows minus 27 retired names").toBe(
      sqlRows.length - CATALOG_REMOVED_NAMES.length,
    );
  });

  it("matches the migration minus removals in exact file order, with a readable diff", () => {
    expect(orderedDiff(CATALOG_SEED, expectedLiveRows(SEED_SQL))).toBeNull();
  });

  it("matches the migration minus removals as a sorted sequence too", () => {
    const expected = expectedLiveRows(SEED_SQL);
    const onlySeed = onlyIn(lowerNameSet(CATALOG_SEED), lowerNameSet(expected));
    const onlyExpected = onlyIn(lowerNameSet(expected), lowerNameSet(CATALOG_SEED));
    expect(
      { onlyInSeed: onlySeed, onlyInMigration: onlyExpected },
      "name sets must be identical",
    ).toEqual({ onlyInSeed: [], onlyInMigration: [] });
    expect(sortedSignature(CATALOG_SEED)).toEqual(sortedSignature(expected));
  });
});

describe("hard-delete parity with migrations/0005_catalog_dedup.sql", () => {
  it("deletes with one global-only DELETE statement", () => {
    expect(DEDUP_SQL.match(/DELETE FROM exercises/g)).toHaveLength(1);
    expect(DEDUP_SQL).toContain("WHERE owner_id IS NULL");
    expect(DEDUP_SQL).toContain("AND lower(name) IN (");
  });

  it("deletes exactly the CATALOG_REMOVED_NAMES list, in any order", () => {
    const dedupNames = parseInListNames(DEDUP_SQL);
    expect(dedupNames).toHaveLength(CATALOG_REMOVED_NAMES.length);
    expect(lowerSorted(dedupNames)).toEqual(lowerSorted(CATALOG_REMOVED_NAMES));
  });

  it("deletes only names that 0002 seeds, so no target is missing or foreign", () => {
    const sqlNames = lowerNameSet(parseSqlRows(SEED_SQL));
    for (const name of parseInListNames(DEDUP_SQL)) {
      expect(
        sqlNames.has(name.toLowerCase()),
        `0005 deletes "${name}", which 0002 never seeded`,
      ).toBe(true);
    }
  });

  it("restores exactly 'ab wheel' with one idempotent global-only UPDATE", () => {
    expect(DEDUP_SQL.match(/UPDATE exercises/g)).toHaveLength(1);
    expect(DEDUP_SQL).toContain("SET deleted_at = NULL");
    expect(DEDUP_SQL).toContain("WHERE owner_id IS NULL");
    expect(DEDUP_SQL).toContain("lower(name) = 'ab wheel'");
    expect(DEDUP_SQL).toContain("AND deleted_at IS NOT NULL");
  });
});

describe("soft-delete parity with migrations/0004_catalog_cleanup.sql", () => {
  it("retires rows with one idempotent, global-only soft-delete UPDATE", () => {
    expect(CLEANUP_SQL.match(/UPDATE exercises/g)).toHaveLength(1);
    expect(CLEANUP_SQL).toContain("SET deleted_at = now(), updated_at = now()");
    expect(CLEANUP_SQL).toContain("owner_id IS NULL");
    expect(CLEANUP_SQL).toContain("AND deleted_at IS NULL");
  });

  it("soft-deletes a subset of the 0005 list plus 'ab wheel', which 0005 restores", () => {
    const cleanupNames = parseInListNames(CLEANUP_SQL);
    expect(cleanupNames).toHaveLength(7);
    for (const name of cleanupNames) {
      if (name.toLowerCase() === "ab wheel") {
        // 0004 retired it, but the kept first set restores it in 0005.
        expect(REMOVED_LOWER_NAMES.has(name.toLowerCase())).toBe(false);
        continue;
      }
      expect(
        REMOVED_LOWER_NAMES.has(name.toLowerCase()),
        `0004 retires "${name}", which 0005 must also delete`,
      ).toBe(true);
    }
  });

  it("retires only names that 0002 seeds, so no target is missing or foreign", () => {
    const sqlNames = lowerNameSet(parseSqlRows(SEED_SQL));
    for (const name of parseInListNames(CLEANUP_SQL)) {
      expect(
        sqlNames.has(name.toLowerCase()),
        `0004 retires "${name}", which 0002 never seeded`,
      ).toBe(true);
    }
  });
});
