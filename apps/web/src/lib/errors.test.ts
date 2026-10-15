import { describe, expect, it } from "vitest";
import { LocalValidationError } from "../db/validation";
import { errorMessage, errorIssues } from "./errors";

describe("errorIssues", () => {
  it("keeps every violation from a LocalValidationError", () => {
    const cause = new LocalValidationError("invalid set", ["reps must be an integer", "weight_kg must be in 0..1500"]);
    expect(errorIssues(cause)).toEqual([
      "reps must be an integer",
      "weight_kg must be in 0..1500",
    ]);
  });

  it("defaults a bare LocalValidationError to its message", () => {
    expect(errorIssues(new LocalValidationError("draft not found: x"))).toEqual([
      "draft not found: x",
    ]);
  });

  it("reads an ordinary error message", () => {
    expect(errorIssues(new Error("storage full"))).toEqual(["storage full"]);
  });

  it("returns nothing for a cause without a message", () => {
    expect(errorIssues("boom")).toEqual([]);
    expect(errorIssues(new Error(""))).toEqual([]);
  });
});

describe("errorMessage", () => {
  it("joins the issues for a status line", () => {
    const cause = new LocalValidationError("invalid set", ["reps must be an integer", "bad weight"]);
    expect(errorMessage(cause, "fallback")).toBe("reps must be an integer; bad weight");
  });

  it("falls back when the cause says nothing useful", () => {
    expect(errorMessage(undefined, "The save failed. Try again.")).toBe(
      "The save failed. Try again.",
    );
  });
});
