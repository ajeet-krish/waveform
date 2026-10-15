import { For } from "solid-js";

/** The Waveform mark: a 7 by 5 fragment of the effort grid with today lit magenta. */
const PATTERN = ["......M", "....TGG", "...TGGA", "..TGGAA", ".TGGAAA"];

const CELL = 5;
const GAP = 1;

const FILLS: Record<string, string> = {
  T: "var(--heat-1)",
  G: "var(--heat-3)",
  A: "var(--heat-4)",
  M: "var(--live)",
};

type Cell = { x: number; y: number; fill: string };

const CELLS: Cell[] = PATTERN.flatMap((row, rowIndex) =>
  Array.from(row).map((letter, colIndex) => ({
    x: colIndex * (CELL + GAP),
    y: rowIndex * (CELL + GAP),
    fill: FILLS[letter] ?? "var(--heat-0)",
  })),
);

export default function GridMark(props: { height?: number }) {
  const height = () => props.height ?? 16;
  return (
    <svg
      viewBox="0 0 41 29"
      height={height()}
      width={(height() * 41) / 29}
      aria-hidden="true"
    >
      <For each={CELLS}>
        {(cell) => (
          <rect x={cell.x} y={cell.y} width={CELL} height={CELL} rx="1" fill={cell.fill} />
        )}
      </For>
    </svg>
  );
}
