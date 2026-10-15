/**
 * Spoken summaries for the activity surfaces: one line per ride in a
 * session list, the live footer under the climb grade picker, and the
 * 30-day meta line each discipline card carries. Every figure comes
 * from the same helpers the repos derive rows with, so a summary can
 * never disagree with the stored row.
 */

import type { DisciplineSummary } from "./activities";
import { hardestGrade, totalSends, vPointsForSends } from "./climbing";
import { formatDurationMin } from "./format";

export type RideFigures = {
  distanceKm: number | null;
  elevationM: number | null;
  durationMin: number | null;
};

/**
 * "42.0 km, 380 m, 1 h 20 min": whichever figures the ride carries, in
 * distance, elevation, duration order. Null or non-finite figures drop
 * out, and a ride with no figures at all invites a log instead of
 * showing zeros.
 */
export function rideSummary(figures: RideFigures): string {
  const parts: string[] = [];
  if (figures.distanceKm !== null && Number.isFinite(figures.distanceKm)) {
    parts.push(`${figures.distanceKm.toFixed(1)} km`);
  }
  if (figures.elevationM !== null && Number.isFinite(figures.elevationM)) {
    parts.push(`${Math.round(figures.elevationM)} m`);
  }
  if (figures.durationMin !== null && Number.isFinite(figures.durationMin)) {
    parts.push(formatDurationMin(figures.durationMin));
  }
  if (parts.length === 0) {
    return "No figures logged yet.";
  }
  return parts.join(", ");
}

/**
 * "4 sends, hardest V4, 24 V-points.": the live footer under the grade
 * picker, built from the same climbing helpers the activity repo uses
 * to derive a session's summary columns.
 */
export function climbFooterSummary(counts: readonly number[]): string {
  const sends = totalSends(counts);
  if (sends === 0) {
    return "No sends yet.";
  }
  const hardest = hardestGrade(counts);
  const points = vPointsForSends(counts);
  const sendWord = sends === 1 ? "send" : "sends";
  const pointWord = points === 1 ? "V-point" : "V-points";
  return `${sends} ${sendWord}, hardest V${hardest ?? 0}, ${points} ${pointWord}.`;
}

/**
 * The 30-day line under a discipline card: sessions first, then the
 * figure that discipline is judged by (distance for cycling, V-points
 * for climbing). An empty window reads as an invitation, not a zero.
 */
export function disciplineWindowSummary(summary: DisciplineSummary): string {
  if (summary.count === 0) {
    return "Nothing logged in the last 30 days.";
  }
  const sessionWord = summary.count === 1 ? "session" : "sessions";
  const sessions = `${summary.count} ${sessionWord}`;
  if (summary.type === "cycling") {
    return `${sessions}, ${summary.totalKm.toFixed(1)} km in the last 30 days.`;
  }
  if (summary.type === "climbing") {
    const pointWord = summary.totalVPoints === 1 ? "V-point" : "V-points";
    return `${sessions}, ${summary.totalVPoints} ${pointWord} in the last 30 days.`;
  }
  return `${sessions} in the last 30 days.`;
}
