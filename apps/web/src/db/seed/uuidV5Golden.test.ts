import { describe, expect, it } from "vitest";
import { catalogSeedId } from "./uuidV5";

/**
 * Golden vectors for the catalog UUIDv5 derivation, pinned in three
 * places: this suite, `crates/db/tests/catalog_uuidv5.rs` (SQL versus
 * `uuid::new_v5`), and migration 0006's `waveform_catalog_id`. The
 * vectors were computed with Python's `uuid.uuid5(NAMESPACE_DNS,
 * lower(name))`. A divergence between the SQL helper and this file fails
 * both suites.
 */
const BENCH_PRESS_ID = "0b665f42-5389-5d9b-8bf2-dfe9b5b56bff";

const GOLDEN: ReadonlyArray<readonly [string, string]> = [
  ["Bench Press (Barbell)", BENCH_PRESS_ID],
  ["Squat (Barbell)", "d0c0f79e-583c-55a9-a9df-45498fa4053b"],
  ["Ab Wheel", "eef99294-6327-5685-8fb0-19659c2dab34"],
  ["Bicep Curl (Dumbbell)", "65e59651-9dd9-53dd-8afc-3f5e52b049e4"],
];

describe("catalog uuidv5 golden vectors (parity with migration 0006)", () => {
  for (const [name, expected] of GOLDEN) {
    it(`derives the pinned id for "${name}"`, async () => {
      expect(await catalogSeedId(name)).toBe(expected);
    });
  }

  it("folds case like the SQL lower(name) unique key", async () => {
    expect(await catalogSeedId("bench press (barbell)")).toBe(BENCH_PRESS_ID);
    expect(await catalogSeedId("BENCH PRESS (BARBELL)")).toBe(BENCH_PRESS_ID);
  });

  it("matches the RFC 4122 example pinned in the Rust test", async () => {
    expect(await catalogSeedId("www.example.com")).toBe(
      "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    );
  });
});
