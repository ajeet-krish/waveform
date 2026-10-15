import goldenData from "../golden/scoring.golden.json";
import type { EffortBonuses } from "./effort";

/** One Brzycki e1RM vector. */
export interface E1rmVector {
  weightKg: number;
  reps: number;
  expected: number;
}

/** One single-send V-point vector. */
export interface VPointsVector {
  grade: number;
  expected: number;
}

/** One summed V-points vector. */
export interface TotalVPointsVector {
  grades: number[];
  expected: number;
}

/** One session Effort Points vector. Discipline is the raw string so the
 * golden file stays language neutral; callers parse it with
 * `parseDiscipline`. */
export interface EffortPointsVector {
  minutes: number;
  discipline: string;
  bonuses: EffortBonuses;
  expected: number;
}

/** One session entry inside a daily Effort Points vector. */
export interface GoldenSession {
  minutes: number;
  discipline: string;
  bonuses: EffortBonuses;
}

/** One daily Effort Points vector. */
export interface EffortPointsDailyVector {
  sessions: GoldenSession[];
  expected: number;
}

/** Shape of `golden/scoring.golden.json`, the single shared vector file. */
export interface ScoringGolden {
  version: number;
  tolerance: number;
  e1rm: E1rmVector[];
  vPoints: VPointsVector[];
  totalVPoints: TotalVPointsVector[];
  effortPoints: EffortPointsVector[];
  effortPointsDaily: EffortPointsDailyVector[];
}

/** Load the shared golden vectors, also read by the Rust golden test. */
export function loadGolden(): ScoringGolden {
  return goldenData;
}
