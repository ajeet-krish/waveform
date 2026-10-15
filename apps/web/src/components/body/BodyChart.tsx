/**
 * The body trend: one weight polyline, plus an optional body-fat
 * polyline when the reader turns the second series on and at least two
 * readings carry body fat. Geometry comes from the sparkline model in
 * the same pixel box the SVG renders at (circles stay round), and the
 * chart carries its spoken weight summary as the accessible name, so
 * the picture says what it shows instead of asking anyone to squint.
 */

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { WeightUnit } from "../../lib/format";
import { bodyChartSummary } from "../../lib/bodyChart";
import { buildSparkline, type SparkDay } from "../../lib/sparkline";

const HEIGHT = 56;
const PAD = 6;
const FALLBACK_WIDTH = 320;

export default function BodyChart(props: {
  /** Weight per day, nulls skipped; the primary series. */
  weight: readonly SparkDay[];
  /** Body fat per day, nulls skipped; drawn only with two or more points. */
  bodyfat: readonly SparkDay[];
  unit: WeightUnit;
  today: Date;
}) {
  const [width, setWidth] = createSignal(0);
  const [showBodyFat, setShowBodyFat] = createSignal(false);
  let wrapperRef: HTMLDivElement | undefined;

  onMount(() => {
    const wrapper = wrapperRef;
    if (!wrapper) {
      return;
    }
    const measure = (): void => {
      const measured = wrapper.clientWidth;
      setWidth(measured > 0 ? measured : FALLBACK_WIDTH);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(wrapper);
    onCleanup(() => observer.disconnect());
  });

  const boxWidth = (): number => width() || FALLBACK_WIDTH;
  const box = () => ({ width: boxWidth(), height: HEIGHT, pad: PAD });

  const weightGeometry = createMemo(() =>
    buildSparkline(
      props.weight.map((point) => point.value),
      box(),
    ),
  );
  const bodyfatGeometry = createMemo(() =>
    buildSparkline(
      props.bodyfat.map((point) => point.value),
      box(),
    ),
  );

  /** Two readings are the minimum a trend line means anything. */
  const fatAvailable = (): boolean => props.bodyfat.length >= 2;
  const fatShown = (): boolean => showBodyFat() && fatAvailable();

  const summary = (): string => {
    const base = bodyChartSummary(props.weight, props.today, props.unit);
    if (!fatShown()) {
      return base;
    }
    return `${base} Body fat shown as a second line.`;
  };

  return (
    <div>
      <div
        ref={(el) => {
          wrapperRef = el;
        }}
      >
        <svg
          class="sparkline"
          viewBox={`0 0 ${boxWidth()} ${HEIGHT}`}
          role="img"
          aria-label={summary()}
        >
          <line
            class="sparkline-axis"
            x1="0"
            y1={HEIGHT - 0.5}
            x2={boxWidth()}
            y2={HEIGHT - 0.5}
          />
          <Show when={fatShown()}>
            <polyline class="sparkline-line is-secondary" points={bodyfatGeometry().polyline} />
          </Show>
          <polyline class="sparkline-line" points={weightGeometry().polyline} />
          <For each={weightGeometry().dots}>
            {(dot) => (
              <circle
                classList={{ "sparkline-dot": true, "is-record": dot.record }}
                cx={dot.x}
                cy={dot.y}
                r="3"
              />
            )}
          </For>
          <Show when={fatShown()}>
            <For each={bodyfatGeometry().dots}>
              {(dot) => <circle class="sparkline-dot is-secondary" cx={dot.x} cy={dot.y} r="3" />}
            </For>
          </Show>
        </svg>
      </div>
      <Show when={fatAvailable()}>
        <div class="seg" role="group" aria-label="Chart series">
          <button
            type="button"
            class="seg-btn"
            aria-pressed={!fatShown()}
            onClick={() => setShowBodyFat(false)}
          >
            Weight
          </button>
          <button
            type="button"
            class="seg-btn"
            aria-pressed={fatShown()}
            onClick={() => setShowBodyFat(true)}
          >
            Weight + body fat
          </button>
        </div>
      </Show>
      <Show when={fatShown()}>
        <ul class="heat-legend mt-3">
          <li class="legend-item">
            <span class="spark-swatch" aria-hidden="true" />
            Weight ({props.unit})
          </li>
          <li class="legend-item">
            <span class="spark-swatch is-secondary" aria-hidden="true" />
            Body fat (%)
          </li>
        </ul>
      </Show>
    </div>
  );
}
