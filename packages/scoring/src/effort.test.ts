import { describe, expect, it } from "vitest";
import {
  DAILY_EP_CAP,
  disciplineIntensity,
  effortPoints,
  effortPointsDaily,
  parseDiscipline,
  type Discipline,
  type EffortBonuses,
  type SessionEffort,
} from "./effort";

const NONE: EffortBonuses = { prCount: 0, sends: 0, elevationM: 0 };

const MAXED: EffortBonuses = {
  prCount: 1000,
  sends: 1000,
  elevationM: 100_000,
};

function assertApprox(actual: number, expected: number, tolerance: number): void {
  expect(
    Math.abs(actual - expected),
    `expected ${expected} (+/- ${tolerance}), got ${actual}`,
  ).toBeLessThan(tolerance);
}

function session(
  minutes: number,
  discipline: Discipline,
  bonuses: EffortBonuses,
): SessionEffort {
  return { minutes, discipline, bonuses };
}

describe("disciplineIntensity", () => {
  it("weights minutes per discipline", () => {
    expect(disciplineIntensity("strength")).toBe(1.0);
    expect(disciplineIntensity("climbing")).toBe(1.1);
    expect(disciplineIntensity("cycling")).toBe(0.9);
  });

  it("parses discipline strings and rejects unknown ones", () => {
    expect(parseDiscipline("strength")).toBe("strength");
    expect(parseDiscipline("climbing")).toBe("climbing");
    expect(parseDiscipline("cycling")).toBe("cycling");
    expect(() => parseDiscipline("rowing")).toThrow("unknown discipline");
  });
});

describe("effortPoints", () => {
  it("scores plain sessions", () => {
    assertApprox(effortPoints(60, "strength", NONE), 60.0, 1e-9);
    assertApprox(effortPoints(45, "climbing", NONE), 49.5, 1e-9);
    assertApprox(effortPoints(90, "cycling", NONE), 81.0, 1e-9);
  });

  it("scores zero minutes across every discipline at zero", () => {
    for (const discipline of ["strength", "climbing", "cycling"] as const) {
      expect(effortPoints(0, discipline, NONE)).toBe(0);
    }
  });

  it("counts bonuses even at zero minutes", () => {
    const bonuses: EffortBonuses = { prCount: 2, sends: 0, elevationM: 0 };
    assertApprox(effortPoints(0, "strength", bonuses), 4.0, 1e-9);
  });

  it("weights minutes by discipline and passes fractions through", () => {
    assertApprox(effortPoints(60, "strength", NONE), 60.0, 1e-9);
    assertApprox(effortPoints(60, "climbing", NONE), 66.0, 1e-9);
    assertApprox(effortPoints(60, "cycling", NONE), 54.0, 1e-9);
    assertApprox(effortPoints(90.9, "strength", NONE), 90.9, 1e-9);
    assertApprox(effortPoints(1.0, "climbing", NONE), 1.1, 1e-9);
  });

  it("caps each bonus type individually", () => {
    const prsMaxed: EffortBonuses = { prCount: 1_000_000, sends: 0, elevationM: 0 };
    assertApprox(effortPoints(0, "strength", prsMaxed), 10.0, 1e-9);

    const sendsMaxed: EffortBonuses = { prCount: 0, sends: 1_000_000, elevationM: 0 };
    assertApprox(effortPoints(0, "climbing", sendsMaxed), 10.0, 1e-9);

    const elevationMaxed: EffortBonuses = { prCount: 0, sends: 0, elevationM: 1_000_000 };
    assertApprox(effortPoints(0, "cycling", elevationMaxed), 15.0, 1e-9);
  });

  it("bounds a heavily bonused session", () => {
    // 10 (PR) + 10 (sends) + 15 (elevation) = 35 bonus EP.
    const bonuses: EffortBonuses = { prCount: 99, sends: 99, elevationM: 10_000 };
    assertApprox(effortPoints(30, "climbing", bonuses), 33.0 + 35.0, 1e-9);
  });

  it("scores a mixed session", () => {
    const bonuses: EffortBonuses = { prCount: 2, sends: 5, elevationM: 250 };
    // 30 min climbing = 33, + 4 (PR) + 5 (sends) + 2.5 (elevation).
    assertApprox(effortPoints(30, "climbing", bonuses), 44.5, 1e-9);
  });

  it("clamps degenerate inputs to zero", () => {
    expect(effortPoints(-45, "strength", NONE)).toBe(0);
    expect(effortPoints(-10, "strength", NONE)).toBe(0);

    const negativeElevation: EffortBonuses = {
      prCount: 0,
      sends: 0,
      elevationM: -500,
    };
    expect(effortPoints(30, "cycling", negativeElevation)).toBe(27);
  });

  it("is monotonic in minutes", () => {
    for (const discipline of ["strength", "climbing", "cycling"] as const) {
      let previous = effortPoints(0, discipline, NONE);
      for (let step = 1; step <= 50; step += 1) {
        const minutes = step * 3.7;
        const current = effortPoints(minutes, discipline, NONE);
        expect(
          current >= previous,
          `effort dropped when minutes grew at ${minutes}`,
        ).toBe(true);
        previous = current;
      }
    }
  });
});

describe("effortPointsDaily", () => {
  it("scores an empty or zero-minute day at zero", () => {
    expect(effortPointsDaily([])).toBe(0);
    expect(effortPointsDaily([session(0, "strength", NONE)])).toBe(0);
  });

  it("applies the daily cap", () => {
    const day = [session(100, "strength", NONE), session(100, "strength", NONE)];
    expect(effortPointsDaily(day)).toBe(DAILY_EP_CAP);
  });

  it("leaves a day below the cap untouched", () => {
    expect(effortPointsDaily([session(40, "cycling", NONE)])).toBe(36);
  });

  it("keeps bonuses from pushing a day past the cap", () => {
    // 90 base (cycling) + 35 max bonuses = 125 before the cap.
    expect(effortPointsDaily([session(100, "cycling", MAXED)])).toBe(DAILY_EP_CAP);
    // A zero-minute day of pure bonuses stays under the cap.
    expect(effortPointsDaily([session(0, "strength", MAXED)])).toBe(35);
    // Four zero-minute maxed sessions sum to 140 bonus EP; the cap bites.
    const bonusStorm = [
      session(0, "strength", MAXED),
      session(0, "climbing", MAXED),
      session(0, "cycling", MAXED),
      session(0, "strength", MAXED),
    ];
    expect(effortPointsDaily(bonusStorm)).toBe(DAILY_EP_CAP);
  });

  it("applies an inclusive, unrounded daily cap", () => {
    const justUnder = [session(99.5, "strength", NONE)];
    assertApprox(effortPointsDaily(justUnder), 99.5, 1e-9);

    const exactlyAtCap = [session(100, "strength", NONE)];
    expect(effortPointsDaily(exactlyAtCap)).toBe(DAILY_EP_CAP);

    const justOver = [session(100.5, "strength", NONE)];
    expect(effortPointsDaily(justOver)).toBe(DAILY_EP_CAP);
  });

  it("keeps every day inside the 0 to 100 band", () => {
    for (const minutes of [0, 1, 45, 90, 600, -30]) {
      for (const discipline of ["strength", "climbing", "cycling"] as const) {
        for (const sends of [0, 7, 500]) {
          const day = [
            session(minutes, discipline, { prCount: 3, sends, elevationM: 850 }),
            session(minutes / 2, discipline, NONE),
          ];
          const total = effortPointsDaily(day);
          expect(
            total >= 0 && total <= DAILY_EP_CAP,
            `daily EP ${total} outside [0, ${DAILY_EP_CAP}]`,
          ).toBe(true);
        }
      }
    }
  });
});
