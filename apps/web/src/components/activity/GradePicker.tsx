/**
 * The climbing send grid: one stepper cell per V grade (V0 to V16),
 * each bounded to 0..99 whole sends, over a live footer that speaks
 * the running totals in the same words the saved session will use.
 * Grades outside the 0..16 scale are never rendered.
 */

import { createUniqueId, For } from "solid-js";
import { climbFooterSummary } from "../../lib/activitySummary";
import { normalizeSendCounts, V_GRADE_COUNT } from "../../lib/climbing";

const MAX_SENDS = 99;

type GradeCellProps = {
  grade: number;
  count: number;
  onChange(next: number): void;
};

function GradeCell(props: GradeCellProps) {
  const inputId = createUniqueId();

  const bump = (delta: number): void => {
    props.onChange(Math.min(MAX_SENDS, Math.max(0, props.count + delta)));
  };

  const commit = (raw: string): void => {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
      props.onChange(0);
      return;
    }
    props.onChange(Math.min(MAX_SENDS, Math.max(0, Math.trunc(parsed))));
  };

  return (
    <div class="grade-cell">
      <label class="label" for={inputId}>
        {`V${props.grade}`}
      </label>
      <div class="grade-stepper">
        <button
          type="button"
          class="grade-step"
          aria-label={`One fewer V${props.grade} send`}
          disabled={props.count <= 0}
          onClick={() => bump(-1)}
        >
          -
        </button>
        <input
          id={inputId}
          class="input grade-input"
          type="number"
          inputMode="numeric"
          min={0}
          max={MAX_SENDS}
          step={1}
          value={props.count}
          onInput={(event) => commit(event.currentTarget.value)}
        />
        <button
          type="button"
          class="grade-step"
          aria-label={`One more V${props.grade} send`}
          disabled={props.count >= MAX_SENDS}
          onClick={() => bump(1)}
        >
          +
        </button>
      </div>
    </div>
  );
}

export default function GradePicker(props: {
  /** The send histogram, indexed by integer V grade; normalized on read. */
  value: readonly number[];
  onChange(next: number[]): void;
}) {
  const grades = (): Array<{ grade: number; count: number }> => {
    const counts = normalizeSendCounts(props.value);
    const list: Array<{ grade: number; count: number }> = [];
    for (let grade = 0; grade < V_GRADE_COUNT; grade += 1) {
      list.push({ grade, count: counts[grade] ?? 0 });
    }
    return list;
  };

  const setGrade = (grade: number, next: number): void => {
    const counts = normalizeSendCounts(props.value);
    counts[grade] = next;
    props.onChange(counts);
  };

  return (
    <div>
      <div class="grade-grid" role="group" aria-label="Sends by V grade">
        <For each={grades()}>
          {(cell) => (
            <GradeCell
              grade={cell.grade}
              count={cell.count}
              onChange={(next) => setGrade(cell.grade, next)}
            />
          )}
        </For>
      </div>
      <p class="panel-note mt-3" aria-live="polite">
        {climbFooterSummary(props.value)}
      </p>
    </div>
  );
}
