import { createMemo, createSignal, For, onCleanup, onMount } from "solid-js";
import { buildSparkline, sparklineSummary, type SparkDay } from "../lib/sparkline";

const HEIGHT = 56;
const PAD = 6;
const FALLBACK_WIDTH = 320;

/**
 * Best e1RM per day as one polyline. The SVG measures its own wrapper so
 * its coordinate box matches its pixel size (circles stay round), and it
 * carries a generated spoken summary as its accessible name: the chart
 * says what it shows instead of asking anyone to squint at it.
 */
export default function Sparkline(props: {
  points: readonly SparkDay[];
  unit: string;
  today: Date;
}) {
  const [width, setWidth] = createSignal(0);
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
  const geometry = createMemo(() =>
    buildSparkline(
      props.points.map((point) => point.value),
      { width: boxWidth(), height: HEIGHT, pad: PAD },
    ),
  );
  const summary = (): string => sparklineSummary(props.points, props.unit, props.today);

  return (
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
        <polyline class="sparkline-line" points={geometry().polyline} />
        <For each={geometry().dots}>
          {(dot) => (
            <circle
              classList={{ "sparkline-dot": true, "is-record": dot.record }}
              cx={dot.x}
              cy={dot.y}
              r="3"
            />
          )}
        </For>
      </svg>
    </div>
  );
}
