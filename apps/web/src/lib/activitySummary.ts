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

/** The figures an endurance (run, hike, swim) session speaks in. */
export type EnduranceFigures = {
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

/** "5:20": a pace in whole minutes and seconds, never negative. */
export function formatPace(minutesPerUnit: number): string {
  const totalSeconds = Math.max(0, Math.round(minutesPerUnit * 60));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The pace figure for an endurance session, or null when it cannot be
 * computed: both duration and distance must be finite and strictly
 * positive, so a zero-distance or zero-duration row never divides by
 * zero. Running and hiking pace is per km; swim pace is per 100 m.
 */
export function endurancePace(
  figures: EnduranceFigures,
  per100m: boolean,
): string | null {
  const { distanceKm, durationMin } = figures;
  if (distanceKm === null || durationMin === null) {
    return null;
  }
  if (!Number.isFinite(distanceKm) || !Number.isFinite(durationMin)) {
    return null;
  }
  if (distanceKm <= 0 || durationMin <= 0) {
    return null;
  }
  const units = per100m ? distanceKm * 10 : distanceKm;
  const pace = durationMin / units;
  return `${formatPace(pace)} ${per100m ? "/100 m" : "/km"}`;
}

/**
 * "1 h 20 min, 12.0 km, 620 m, 4:00 /km": the spoken line for a run,
 * hike, or swim, in duration, distance, elevation, pace order. Elevation
 * is spoken for every endurance type that carries it (running and hiking;
 * swim nulls it in the form). Swim pace is per 100 m; run and hike pace
 * is per km. Missing figures drop out, and pace appears only when
 * duration and distance are both positive. A session with no figures at
 * all invites a log.
 */
export function enduranceSummary(
  figures: EnduranceFigures,
  options: { per100m?: boolean } = {},
): string {
  const parts: string[] = [];
  if (figures.durationMin !== null && Number.isFinite(figures.durationMin)) {
    parts.push(formatDurationMin(figures.durationMin));
  }
  if (figures.distanceKm !== null && Number.isFinite(figures.distanceKm)) {
    parts.push(`${figures.distanceKm.toFixed(1)} km`);
  }
  if (figures.elevationM !== null && Number.isFinite(figures.elevationM)) {
    parts.push(`${Math.round(figures.elevationM)} m`);
  }
  const pace = endurancePace(figures, options.per100m ?? false);
  if (pace !== null) {
    parts.push(pace);
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
 * figure that discipline is judged by (distance for cycling, running,
 * hike, and swim; V-points for climbing). An empty window reads as an
 * invitation, not a zero, and a distance window with sessions but no
 * logged distance (totalKm 0) falls back to sessions-only text rather
 * than printing "0.0 km".
 */
export function disciplineWindowSummary(summary: DisciplineSummary): string {
  if (summary.count === 0) {
    return "Nothing logged in the last 30 days.";
  }
  const sessionWord = summary.count === 1 ? "session" : "sessions";
  const sessions = `${summary.count} ${sessionWord}`;
  if (summary.type === "climbing") {
    const pointWord = summary.totalVPoints === 1 ? "V-point" : "V-points";
    return `${sessions}, ${summary.totalVPoints} ${pointWord} in the last 30 days.`;
  }
  if (
    summary.type === "cycling" ||
    summary.type === "running" ||
    summary.type === "hike" ||
    summary.type === "swim"
  ) {
    if (summary.totalKm > 0) {
      return `${sessions}, ${summary.totalKm.toFixed(1)} km in the last 30 days.`;
    }
  }
  return `${sessions} in the last 30 days.`;
}
