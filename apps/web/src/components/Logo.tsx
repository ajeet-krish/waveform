/**
 * The Waveform mark: a quiet heart outline (structure) with the live ECG trace
 * (signal) running across it. Magenta means active, same as everywhere else.
 * Geometry is the shared 512 viewBox source, also used by public/favicon.svg.
 */
const HEART_PATH =
  "M352.92,80C288,80,256,144,256,144s-32-64-96.92-64C106.32,80,64.54,124.14,64,176.81c-1.1,109.33,86.73,187.08,183,252.42a16,16,0,0,0,18,0c96.26-65.34,184.09-143.09,183-252.42C447.46,124.14,405.68,80,352.92,80Z";

const ECG_POINTS = "48 256 160 256 208 160 256 320 304 224 336 288 464 288";

export default function Logo(props: { height?: number }) {
  const height = () => props.height ?? 16;
  return (
    <svg viewBox="0 0 512 512" height={height()} width={height()} fill="none" aria-hidden="true">
      <path
        d={HEART_PATH}
        stroke="var(--paper-dim)"
        stroke-width="32"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <polyline
        points={ECG_POINTS}
        stroke="var(--live)"
        stroke-width="32"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}
