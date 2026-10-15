import { describe, expect, it } from "vitest";
import type { BodyStats } from "@waveform/api-types";
import type { LocalRow } from "../db/types";
import { bodyChartSummary, bodySeries, buildBodyPoints } from "./bodyChart";

const today = new Date(2026, 9, 15, 9, 0);

function row(
  local_date: string,
  weight_kg: number | null,
  bodyfat_pct: number | null,
): LocalRow<BodyStats> {
  return {
    id: crypto.randomUUID(),
    user_id: "user-1",
    local_date,
    weight_kg,
    bodyfat_pct,
    neck_cm: null,
    shoulders_cm: null,
    chest_cm: null,
    bicep_cm: null,
    waist_cm: null,
    hips_cm: null,
    thigh_cm: null,
    calf_cm: null,
    created_at: "2026-10-14T00:00:00.000Z",
    updated_at: "2026-10-14T00:00:00.000Z",
    deleted_at: null,
  };
}

describe("buildBodyPoints", () => {
  it("maps rows to day/weight/bodyfat points sorted day asc", () => {
    const points = buildBodyPoints([
      row("2026-10-14", 72, 15),
      row("2026-10-12", 73, 15.5),
      row("2026-10-13", 72.5, null),
    ]);
    expect(points).toEqual([
      { day: "2026-10-12", weightKg: 73, bodyfatPct: 15.5 },
      { day: "2026-10-13", weightKg: 72.5, bodyfatPct: null },
      { day: "2026-10-14", weightKg: 72, bodyfatPct: 15 },
    ]);
  });

  it("returns an empty array for no rows", () => {
    expect(buildBodyPoints([])).toEqual([]);
  });
});

describe("bodySeries", () => {
  it("skips nulls independently per series", () => {
    const points = [
      { day: "2026-10-12", weightKg: 73, bodyfatPct: 15.5 },
      { day: "2026-10-13", weightKg: 72.5, bodyfatPct: null },
      { day: "2026-10-14", weightKg: null, bodyfatPct: 15 },
    ];
    const series = bodySeries(points);
    expect(series.weight).toEqual([
      { day: "2026-10-12", value: 73 },
      { day: "2026-10-13", value: 72.5 },
    ]);
    expect(series.bodyfat).toEqual([
      { day: "2026-10-12", value: 15.5 },
      { day: "2026-10-14", value: 15 },
    ]);
  });

  it("returns empty series for empty points", () => {
    expect(bodySeries([])).toEqual({ weight: [], bodyfat: [] });
  });
});

describe("bodyChartSummary", () => {
  it("invites a first log when there is no weight", () => {
    expect(bodyChartSummary([], today, "kg")).toBe("No body weight logged yet.");
  });

  it("names the single logged day and its figure", () => {
    expect(
      bodyChartSummary([{ day: "2026-10-14", value: 72.5 }], today, "kg"),
    ).toBe("Body weight: 72.5 kg, logged Yesterday.");
  });

  it("spans first day, last day, low, and high across a series", () => {
    const weight = [
      { day: "2026-10-05", value: 74 },
      { day: "2026-10-12", value: 73 },
      { day: "2026-10-14", value: 72 },
      { day: "2026-10-15", value: 72.5 },
    ];
    expect(bodyChartSummary(weight, today, "kg")).toBe(
      "Body weight: 4 days logged, 74 kg Monday 5 Oct to 72.5 kg Today, " +
        "low 72 kg Yesterday, high 74 kg Monday 5 Oct.",
    );
  });

  it("formats in the display unit", () => {
    // 72.5 kg is about 159.8 lb (one decimal for lb).
    expect(
      bodyChartSummary([{ day: "2026-10-14", value: 72.5 }], today, "lb"),
    ).toBe("Body weight: 159.8 lb, logged Yesterday.");
  });
});
