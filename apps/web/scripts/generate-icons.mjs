// Generates the placeholder PWA icons into public/ with no image dependencies.
// The mark is a 7 column by 5 row fragment of the effort grid: heat rising from
// the empty slate at top left toward today (magenta) at top right.
// Run with: pnpm icons
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const COLORS = {
  console: [15, 21, 25],
  empty: [30, 42, 49],
  teal: [33, 70, 74],
  green: [79, 203, 141],
  amber: [242, 169, 59],
  live: [242, 80, 155],
};

// Rows read top to bottom, columns left to right (Monday start, oldest week on top).
const PATTERN = ["......M", "....TGG", "...TGGA", "..TGGAA", ".TGGAAA"];

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c;
});

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return ~crc >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: none
    rgba.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const rect = (x, y, w, h, [r, g, b]) => {
    for (let yy = y; yy < y + h; yy += 1) {
      for (let xx = x; xx < x + w; xx += 1) {
        const i = (yy * size + xx) * 4;
        rgba[i] = r;
        rgba[i + 1] = g;
        rgba[i + 2] = b;
        rgba[i + 3] = 255;
      }
    }
  };

  rect(0, 0, size, size, COLORS.console);

  const scale = size / 512;
  const cell = Math.max(4, Math.round(34 * scale));
  const gap = Math.max(2, Math.round(8 * scale));
  const gridW = 7 * cell + 6 * gap;
  const gridH = 5 * cell + 4 * gap;
  const originX = Math.round((size - gridW) / 2);
  const originY = Math.round((size - gridH) / 2);

  const fills = { T: COLORS.teal, G: COLORS.green, A: COLORS.amber, M: COLORS.live };
  for (let row = 0; row < PATTERN.length; row += 1) {
    const line = PATTERN[row];
    for (let col = 0; col < 7; col += 1) {
      const letter = line[col];
      const color = fills[letter] ?? COLORS.empty;
      rect(originX + col * (cell + gap), originY + row * (cell + gap), cell, cell, color);
    }
  }

  return encodePng(size, size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
const targets = [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["icon-512-maskable.png", 512],
  ["apple-touch-icon.png", 180],
];
for (const [name, size] of targets) {
  writeFileSync(join(OUT_DIR, name), drawIcon(size));
  console.log(`wrote public/${name} (${size}x${size})`);
}
