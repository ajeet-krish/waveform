import { describe, expect, it } from "vitest";
import type { Exercise } from "@waveform/api-types";
import type { LocalRow } from "../db/types";
import {
  exerciseFormIssues,
  exerciseFormValues,
  exerciseNameMap,
  isMuscleGroup,
  MUSCLE_FILTERS,
  MUSCLE_GROUPS,
} from "./catalog";

function row(id: string, name: string): LocalRow<Exercise> {
  const iso = "2026-10-14T08:00:00.000Z";
  return {
    id,
    owner_id: null,
    name,
    muscle_group: "chest",
    equipment: "barbell",
    created_at: iso,
    updated_at: iso,
    deleted_at: null,
  };
}

describe("MUSCLE_GROUPS", () => {
  it("lists the nine catalog groups in chip order", () => {
    expect([...MUSCLE_GROUPS]).toEqual([
      "chest",
      "back",
      "legs",
      "shoulders",
      "biceps",
      "triceps",
      "core",
      "cardio",
      "other",
    ]);
  });

  it("prefixes every chip list with All", () => {
    expect(MUSCLE_FILTERS[0]).toBe("all");
    expect(MUSCLE_FILTERS).toHaveLength(MUSCLE_GROUPS.length + 1);
  });

  it("narrows only known groups", () => {
    expect(isMuscleGroup("chest")).toBe(true);
    expect(isMuscleGroup("other")).toBe(true);
    expect(isMuscleGroup("neck")).toBe(false);
  });
});

describe("exerciseNameMap", () => {
  it("maps ids to display names", () => {
    const names = exerciseNameMap([row("a", "Bench Press"), row("b", "Squat")]);
    expect(names.get("a")).toBe("Bench Press");
    expect(names.get("b")).toBe("Squat");
    expect(names.get("missing")).toBeUndefined();
  });

  it("is empty for an empty catalog", () => {
    expect(exerciseNameMap([]).size).toBe(0);
  });
});

describe("exerciseFormIssues", () => {
  it("accepts a trimmed name and a catalog muscle group", () => {
    expect(exerciseFormIssues({ name: "  Landmine press  ", muscle_group: "chest" })).toEqual([]);
  });

  it("requires a name", () => {
    expect(exerciseFormIssues({ name: "   ", muscle_group: "chest" })).toEqual([
      "Enter an exercise name.",
    ]);
  });

  it("caps the name at 60 characters after trimming", () => {
    const name = ` ${"x".repeat(61)} `;
    expect(exerciseFormIssues({ name, muscle_group: "chest" })).toEqual([
      "Use 60 characters or fewer.",
    ]);
  });

  it("requires a muscle group from the catalog list", () => {
    expect(
      exerciseFormIssues({ name: "Face Pull", muscle_group: "neck" }),
    ).toEqual(["Choose a muscle group."]);
  });

  it("reports every problem at once", () => {
    expect(exerciseFormIssues({ name: "", muscle_group: "" })).toEqual([
      "Enter an exercise name.",
      "Choose a muscle group.",
    ]);
  });
});

describe("exerciseFormValues", () => {
  it("trims the name and turns blank equipment into null", () => {
    expect(
      exerciseFormValues({ name: "  Goblet Squat ", muscle_group: "legs", equipment: "  " }),
    ).toEqual({ name: "Goblet Squat", muscle_group: "legs", equipment: null });
  });

  it("keeps equipment when it is given", () => {
    expect(
      exerciseFormValues({ name: "Row", muscle_group: "back", equipment: "cable" }),
    ).toEqual({ name: "Row", muscle_group: "back", equipment: "cable" });
  });
});
