/**
 * Effort Points (EP): the heatmap currency.
 *
 * EP is `minutes x per-discipline intensity` plus bounded bonuses, summed
 * per day and capped at 100 EP. Per the scoring ADR (2026-10-14) EP is the
 * heatmap currency only and never a ranked leaderboard board.
 */

/** Lifting, climbing, and cycling weight minutes differently. */
export type Discipline = "strength" | "climbing" | "cycling";

/** Minutes-to-EP intensity per discipline. */
const INTENSITY_BY_DISCIPLINE: Readonly<Record<Discipline, number>> = {
  strength: 1.0,
  climbing: 1.1,
  cycling: 0.9,
};

/** Minutes-to-EP intensity for this discipline. */
export function disciplineIntensity(discipline: Discipline): number {
  return INTENSITY_BY_DISCIPLINE[discipline];
}

/** Parse a raw discipline string; unknown values throw loudly. */
export function parseDiscipline(raw: string): Discipline {
  if (raw === "strength" || raw === "climbing" || raw === "cycling") {
    return raw;
  }
  throw new Error(`unknown discipline: ${raw}`);
}

/** Bounded per-session bonuses. Every bonus type is individually capped so
 * no single axis can dominate a day. */
export interface EffortBonuses {
  /** Personal records set during the session. */
  prCount: number;
  /** Climbing routes sent during the session. */
  sends: number;
  /** Elevation gained, in meters (cycling and hiking). */
  elevationM: number;
}

/** A single session's contribution to a day's Effort Points. */
export interface SessionEffort {
  minutes: number;
  discipline: Discipline;
  bonuses: EffortBonuses;
}

/** EP granted per personal record. */
const EP_PER_PR = 2.0;

/** Daily cap on PR bonus EP. */
const EP_PR_CAP = 10.0;

/** EP granted per climbing send. */
const EP_PER_SEND = 1.0;

/** Daily cap on send bonus EP. */
const EP_SEND_CAP = 10.0;

/** EP granted per 100 m of elevation. */
const EP_PER_ELEVATION_100M = 1.0;

/** Daily cap on elevation bonus EP. */
const EP_ELEVATION_CAP = 15.0;

/** Hard daily cap on total Effort Points. */
export const DAILY_EP_CAP = 100.0;

/** Bounded bonus EP for these bonuses. */
function bonusEffortPoints(bonuses: EffortBonuses): number {
  const prEp = bonuses.prCount * EP_PER_PR;
  const sendEp = bonuses.sends * EP_PER_SEND;
  const elevationEp =
    (Math.max(bonuses.elevationM, 0.0) / 100.0) * EP_PER_ELEVATION_100M;
  return (
    Math.min(prEp, EP_PR_CAP) +
    Math.min(sendEp, EP_SEND_CAP) +
    Math.min(elevationEp, EP_ELEVATION_CAP)
  );
}

/**
 * Effort Points for one session, before the daily cap.
 *
 * Minutes below zero are treated as zero. Bonuses are individually bounded;
 * the aggregate daily cap is applied by [`effortPointsDaily`].
 */
export function effortPoints(
  minutes: number,
  discipline: Discipline,
  bonuses: EffortBonuses,
): number {
  const base = Math.max(minutes, 0.0) * disciplineIntensity(discipline);
  return base + bonusEffortPoints(bonuses);
}

/** Sum a day's sessions and apply the 100 EP daily cap. */
export function effortPointsDaily(sessions: readonly SessionEffort[]): number {
  let total = 0;
  for (const session of sessions) {
    total += effortPoints(session.minutes, session.discipline, session.bonuses);
  }
  return Math.min(total, DAILY_EP_CAP);
}
