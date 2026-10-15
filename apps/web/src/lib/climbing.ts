/**
 * Climbing send-count math: the 17-slot V-grade histogram behind every
 * climbing activity.
 *
 * A climb logs one histogram: index = integer V grade (0 = VB), value =
 * sends at that grade. `normalizeSendCounts` is the single boundary that
 * turns user input into this shape (pad or truncate to V_GRADE_COUNT,
 * floor to whole non-negative sends); `toClimbFields` in the activity
 * repo then derives the row's summary columns from it. V-points delegate
 * to @waveform/scoring so the golden fence stays the only formula.
 */

import { MAX_V_GRADE, totalVPoints } from "@waveform/scoring";
import { formatDayHeading } from "./format";

/** Slots in a send histogram: grades 0..=MAX_V_GRADE inclusive (VB to V16). */
export const V_GRADE_COUNT = MAX_V_GRADE + 1;

/** All-zero counts: a session where nothing was sent. */
export function emptySendCounts(): number[] {
  return new Array<number>(V_GRADE_COUNT).fill(0);
}

/**
 * Coerces any input histogram into the stored shape: exactly
 * V_GRADE_COUNT slots, whole numbers, never negative. Short input is
 * zero-padded, long input is truncated, and NaN, Infinity, fractions,
 * and negatives all collapse to a safe slot value.
 */
export function normalizeSendCounts(counts: readonly number[]): number[] {
  const normalized = emptySendCounts();
  const slots = Math.min(counts.length, V_GRADE_COUNT);
  for (let index = 0; index < slots; index += 1) {
    const raw = counts[index] ?? 0;
    const floored = Math.floor(Number.isFinite(raw) ? raw : 0);
    normalized[index] = floored > 0 ? floored : 0;
  }
  return normalized;
}

/** Total routes sent across every grade. */
export function totalSends(counts: readonly number[]): number {
  let total = 0;
  for (const count of counts) {
    if (Number.isFinite(count) && count > 0) {
      total += Math.floor(count);
    }
  }
  return total;
}

/**
 * Hardest grade with at least one send, as the integer V grade, or null
 * when the session sent nothing.
 */
export function hardestGrade(counts: readonly number[]): number | null {
  const slots = Math.min(counts.length, V_GRADE_COUNT);
  for (let grade = slots - 1; grade >= 0; grade -= 1) {
    const count = counts[grade] ?? 0;
    if (Number.isFinite(count) && count > 0) {
      return grade;
    }
  }
  return null;
}

/**
 * The send histogram expanded into one entry per send (a flat grade
 * list), which is what totalVPoints consumes. Two sends at V3 and one at
 * V5 read as [3, 3, 5].
 */
export function gradesSent(counts: readonly number[]): number[] {
  const normalized = normalizeSendCounts(counts);
  const grades: number[] = [];
  for (let grade = 0; grade < V_GRADE_COUNT; grade += 1) {
    const count = normalized[grade] ?? 0;
    for (let send = 0; send < count; send += 1) {
      grades.push(grade);
    }
  }
  return grades;
}

/** V-points for a histogram: sum of 2^grade across sends (via the scoring fence). */
export function vPointsForSends(counts: readonly number[]): number {
  return totalVPoints(gradesSent(counts));
}

/**
 * The spoken summary for a climb's send histogram: total sends, hardest
 * grade, V-points, and a per-grade breakdown of the grades that were
 * actually sent, ordered easy to hard.
 */
export function climbBreakdownSummary(counts: readonly number[], today: Date): string {
  const normalized = normalizeSendCounts(counts);
  const total = totalSends(normalized);
  if (total === 0) {
    return "No sends logged yet.";
  }
  const hardest = hardestGrade(normalized);
  const points = vPointsForSends(normalized);
  const breakdown: string[] = [];
  for (let grade = 0; grade < V_GRADE_COUNT; grade += 1) {
    const count = normalized[grade] ?? 0;
    if (count > 0) {
      breakdown.push(`V${grade} x${count}`);
    }
  }
  const gradeWord = total === 1 ? "send" : "sends";
  return (
    `${total} ${gradeWord}, hardest V${hardest ?? 0}, ${points} V-point${points === 1 ? "" : "s"} ` +
    `(${breakdown.join(", ")}).`
  );
}

/**
 * "Today" / "Yesterday" / "Monday 12 Oct" for a climbing surface that
 * reasons about a logged day. Re-exported here so climbing views do not
 * each import format.ts for one call.
 */
export function climbDayHeading(localDate: string, today: Date): string {
  return formatDayHeading(localDate, today);
}
