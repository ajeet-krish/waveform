import { describe, expect, it } from "vitest";
import { DISCIPLINES } from "./activities";

/** The activity types the schema CHECK constraint accepts (0001_init.sql). */
const SCHEMA_ACTIVITY_TYPES = ["cycling", "climbing", "running", "hike", "swim"];

describe("discipline cards", () => {
  it("covers every schema activity type exactly once", () => {
    const types = DISCIPLINES.map((card) => card.type).sort();
    expect(types).toEqual([...SCHEMA_ACTIVITY_TYPES].sort());
  });

  it("links only the two discipline pages that ship first", () => {
    const linked = DISCIPLINES.filter((card) => card.href !== undefined).map(
      (card) => card.type,
    );
    expect(linked).toEqual(["cycling", "climbing"]);
  });

  it("keeps labels unique so the cards render distinctly", () => {
    const labels = DISCIPLINES.map((card) => card.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
