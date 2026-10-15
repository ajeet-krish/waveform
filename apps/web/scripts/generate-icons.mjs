// Generates the PWA icons into public/ with no image dependencies.
// The mark is a heart outline (structure, kept quiet) with the live magenta ECG
// trace (signal, the one bold element) across it. It rasterizes straight from
// the same path geometry as public/favicon.svg: curves flatten to polylines,
// then get stroked with round caps and joins over a full bleed console
// background. The maskable variant keeps the whole mark inside the centered
// safe zone circle (80 percent of the icon).
// Run with: pnpm icons
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const COLORS = {
  console: [15, 21, 25],
  paperDim: [143, 163, 173],
  live: [242, 80, 155],
};

// Logo geometry, verbatim from the source: a 512 box drawn with 32 wide round
// strokes. Nothing here is hand redrawn, only scaled into each tile.
const VIEW = 512;
const STROKE = 32;
const HEART_PATH =
  "M352.92,80C288,80,256,144,256,144s-32-64-96.92-64C106.32,80,64.54,124.14,64,176.81c-1.1,109.33,86.73,187.08,183,252.42a16,16,0,0,0,18,0c96.26-65.34,184.09-143.09,183-252.42C447.46,124.14,405.68,80,352.92,80Z";
const ECG_POINTS = "48 256 160 256 208 160 256 320 304 224 336 288 464 288";

// Curve flattening tolerance in viewBox units, and the supersampling grid per
// pixel edge used for edge coverage (3 by 3 gives 9 coverage samples per pixel).
const TOL = 0.2;
const SAMPLES = 3;

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

// --------------------------------------------------------------------------
// Path geometry: parse the source path, flatten every curve to a polyline.
// --------------------------------------------------------------------------

function tokenizePath(d) {
  return d.match(/[a-zA-Z]|-?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) ?? [];
}

function distanceToLine(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dx * (a[1] - p[1]) - dy * (a[0] - p[0])) / len;
}

function flattenCubic(p0, p1, p2, p3, out) {
  const rec = (a, b, c, d, depth) => {
    if (
      depth >= 16 ||
      (distanceToLine(b, a, d) <= TOL && distanceToLine(c, a, d) <= TOL)
    ) {
      out.push(d);
      return;
    }
    const ab = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const bc = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2];
    const cd = [(c[0] + d[0]) / 2, (c[1] + d[1]) / 2];
    const abc = [(ab[0] + bc[0]) / 2, (ab[1] + bc[1]) / 2];
    const bcd = [(bc[0] + cd[0]) / 2, (bc[1] + cd[1]) / 2];
    const abcd = [(abc[0] + bcd[0]) / 2, (abc[1] + bcd[1]) / 2];
    rec(a, ab, abc, abcd, depth + 1);
    rec(abcd, bcd, cd, d, depth + 1);
  };
  rec(p0, p1, p2, p3, 0);
}

// Endpoint to center parameterization (SVG appendix F.6.3), then sampled by
// angle with a step small enough to stay within TOL of the true arc.
function flattenArc(x1, y1, rx, ry, rotDeg, largeArc, sweep, x2, y2, out) {
  if (x1 === x2 && y1 === y2) return;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0) {
    out.push([x2, y2]);
    return;
  }
  const rot = (rotDeg * Math.PI) / 180;
  const cosRot = Math.cos(rot);
  const sinRot = Math.sin(rot);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosRot * dx + sinRot * dy;
  const y1p = -sinRot * dx + cosRot * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const sign = largeArc !== sweep ? 1 : -1;
  const numer = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const denom = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = sign * Math.sqrt(Math.max(0, numer / denom));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cosRot * cxp - sinRot * cyp + (x1 + x2) / 2;
  const cy = sinRot * cxp + cosRot * cyp + (y1 + y2) / 2;
  const angle = (ux, uy, vx, vy) => {
    const denom2 = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const cos = denom2 === 0 ? 1 : (ux * vx + uy * vy) / denom2;
    const a = Math.acos(Math.max(-1, Math.min(1, cos)));
    return ux * vy - uy * vx < 0 ? -a : a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle(
    (x1p - cxp) / rx,
    (y1p - cyp) / ry,
    (-x1p - cxp) / rx,
    (-y1p - cyp) / ry,
  );
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const radius = Math.max(rx, ry);
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - TOL / radius)));
  const count = Math.max(2, Math.ceil(Math.abs(delta) / step));
  for (let i = 1; i <= count; i += 1) {
    const t = theta1 + (delta * i) / count;
    const cosT = Math.cos(t);
    const sinT = Math.sin(t);
    out.push([
      cosRot * rx * cosT - sinRot * ry * sinT + cx,
      sinRot * rx * cosT + cosRot * ry * sinT + cy,
    ]);
  }
}

function parsePath(d) {
  const tokens = tokenizePath(d);
  const lines = [];
  let line = null;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let ctrl = null;
  let ctrlType = "";
  let cmd = "";
  let i = 0;

  const num = () => Number(tokens[i++]);
  const begin = () => {
    line = { points: [[x, y]], closed: false };
    lines.push(line);
  };
  const flatCubic = (x1, y1, x2, y2, x3, y3) => {
    if (line === null) begin();
    flattenCubic([x, y], [x1, y1], [x2, y2], [x3, y3], line.points);
    ctrl = [x2, y2];
    ctrlType = "cubic";
    x = x3;
    y = y3;
  };
  const flatQuad = (qx, qy, x3, y3) => {
    if (line === null) begin();
    const c1 = [x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y)];
    const c2 = [x3 + (2 / 3) * (qx - x3), y3 + (2 / 3) * (qy - y3)];
    flattenCubic([x, y], c1, c2, [x3, y3], line.points);
    ctrl = [qx, qy];
    ctrlType = "quad";
    x = x3;
    y = y3;
  };
  const point = () => {
    if (line === null) begin();
    line.points.push([x, y]);
    ctrl = null;
    ctrlType = "";
  };

  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i])) {
      cmd = tokens[i++];
    } else if (cmd === "") {
      throw new Error(`generate-icons: number before command at token ${i}`);
    }
    const relative = cmd === cmd.toLowerCase();
    switch (cmd.toUpperCase()) {
      case "M": {
        x = num() + (relative ? x : 0);
        y = num() + (relative ? y : 0);
        startX = x;
        startY = y;
        begin();
        ctrl = null;
        ctrlType = "";
        cmd = relative ? "l" : "L";
        break;
      }
      case "L": {
        x = num() + (relative ? x : 0);
        y = num() + (relative ? y : 0);
        point();
        break;
      }
      case "H": {
        x = num() + (relative ? x : 0);
        point();
        break;
      }
      case "V": {
        y = num() + (relative ? y : 0);
        point();
        break;
      }
      case "C": {
        const x1 = num() + (relative ? x : 0);
        const y1 = num() + (relative ? y : 0);
        const x2 = num() + (relative ? x : 0);
        const y2 = num() + (relative ? y : 0);
        const x3 = num() + (relative ? x : 0);
        const y3 = num() + (relative ? y : 0);
        flatCubic(x1, y1, x2, y2, x3, y3);
        break;
      }
      case "S": {
        const x2 = num() + (relative ? x : 0);
        const y2 = num() + (relative ? y : 0);
        const x3 = num() + (relative ? x : 0);
        const y3 = num() + (relative ? y : 0);
        const c1x = ctrlType === "cubic" ? 2 * x - ctrl[0] : x;
        const c1y = ctrlType === "cubic" ? 2 * y - ctrl[1] : y;
        flatCubic(c1x, c1y, x2, y2, x3, y3);
        break;
      }
      case "Q": {
        const qx = num() + (relative ? x : 0);
        const qy = num() + (relative ? y : 0);
        const x3 = num() + (relative ? x : 0);
        const y3 = num() + (relative ? y : 0);
        flatQuad(qx, qy, x3, y3);
        break;
      }
      case "T": {
        const qx = ctrlType === "quad" ? 2 * x - ctrl[0] : x;
        const qy = ctrlType === "quad" ? 2 * y - ctrl[1] : y;
        const x3 = num() + (relative ? x : 0);
        const y3 = num() + (relative ? y : 0);
        flatQuad(qx, qy, x3, y3);
        break;
      }
      case "A": {
        const rx = num();
        const ry = num();
        const rotDeg = num();
        const largeArc = num() !== 0;
        const sweep = num() !== 0;
        const x3 = num() + (relative ? x : 0);
        const y3 = num() + (relative ? y : 0);
        if (line === null) begin();
        flattenArc(x, y, rx, ry, rotDeg, largeArc, sweep, x3, y3, line.points);
        x = x3;
        y = y3;
        ctrl = null;
        ctrlType = "";
        break;
      }
      case "Z": {
        if (line !== null) line.closed = true;
        x = startX;
        y = startY;
        line = null;
        ctrl = null;
        ctrlType = "";
        break;
      }
      default:
        throw new Error(`generate-icons: unsupported path command ${cmd}`);
    }
  }
  return lines;
}

function parsePoints(points) {
  const numbers = (points.match(/-?(?:\d*\.\d+|\d+)/g) ?? []).map(Number);
  const parsed = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    parsed.push([numbers[i], numbers[i + 1]]);
  }
  return { points: parsed, closed: false };
}

// --------------------------------------------------------------------------
// Rasterizer: round capsules (round caps and joins come free from the distance
// field), 3 by 3 coverage samples per pixel, composited over the background.
// --------------------------------------------------------------------------

function fillBackground(rgba, [r, g, b]) {
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = 255;
  }
}

function strokeLines(rgba, size, lines, scale, color) {
  const coverage = Array.from({ length: SAMPLES * SAMPLES }, () =>
    new Float32Array(size * size),
  );
  const half = (STROKE / 2) * scale;

  for (const line of lines) {
    const points = line.points.map(([x, y]) => [
      size / 2 + (x - VIEW / 2) * scale,
      size / 2 + (y - VIEW / 2) * scale,
    ]);
    const segments = [];
    for (let i = 0; i + 1 < points.length; i += 1) {
      segments.push([points[i], points[i + 1]]);
    }
    if (line.closed && points.length > 1) {
      segments.push([points[points.length - 1], points[0]]);
    }

    for (const [a, b] of segments) {
      const abx = b[0] - a[0];
      const aby = b[1] - a[1];
      const ab2 = abx * abx + aby * aby;
      const pad = half + 2;
      const minX = Math.max(0, Math.floor(Math.min(a[0], b[0]) - pad));
      const maxX = Math.min(size - 1, Math.ceil(Math.max(a[0], b[0]) + pad));
      const minY = Math.max(0, Math.floor(Math.min(a[1], b[1]) - pad));
      const maxY = Math.min(size - 1, Math.ceil(Math.max(a[1], b[1]) + pad));
      for (let py = minY; py <= maxY; py += 1) {
        for (let px = minX; px <= maxX; px += 1) {
          const index = py * size + px;
          for (let sy = 0; sy < SAMPLES; sy += 1) {
            const qy = py + (sy + 0.5) / SAMPLES;
            for (let sx = 0; sx < SAMPLES; sx += 1) {
              const qx = px + (sx + 0.5) / SAMPLES;
              let t = ab2 > 0 ? ((qx - a[0]) * abx + (qy - a[1]) * aby) / ab2 : 0;
              if (t < 0) t = 0;
              else if (t > 1) t = 1;
              const dx = qx - (a[0] + t * abx);
              const dy = qy - (a[1] + t * aby);
              let alpha = half + 0.5 - Math.hypot(dx, dy);
              if (alpha <= 0) continue;
              if (alpha > 1) alpha = 1;
              const slot = coverage[sy * SAMPLES + sx];
              if (alpha > slot[index]) slot[index] = alpha;
            }
          }
        }
      }
    }
  }

  const [r, g, b] = color;
  const weight = 1 / (SAMPLES * SAMPLES);
  for (let index = 0; index < size * size; index += 1) {
    let sum = 0;
    for (const slot of coverage) sum += slot[index];
    const alpha = sum * weight;
    if (alpha <= 0) continue;
    const at = index * 4;
    rgba[at] = Math.round(rgba[at] + (r - rgba[at]) * alpha);
    rgba[at + 1] = Math.round(rgba[at + 1] + (g - rgba[at + 1]) * alpha);
    rgba[at + 2] = Math.round(rgba[at + 2] + (b - rgba[at + 2]) * alpha);
    rgba[at + 3] = 255;
  }
}

// --------------------------------------------------------------------------
// Icon assembly.
// --------------------------------------------------------------------------

const HEART = parsePath(HEART_PATH);
const ECG = [parsePoints(ECG_POINTS)];

function measure(lines) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let radius = 0;
  for (const line of lines) {
    for (const [x, y] of line.points) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      radius = Math.max(radius, Math.hypot(x - VIEW / 2, y - VIEW / 2));
    }
  }
  return {
    width: maxX - minX + STROKE,
    height: maxY - minY + STROKE,
    radius: radius + STROKE / 2,
  };
}

const MARK = measure([...HEART, ...ECG]);

// Regular icons fill the tile with an even margin; the maskable one retreats
// to the safe zone so no mask (circle, squircle, rounded square) can clip it.
function fitScale(size, maskable) {
  if (maskable) return (0.4 * size - 1) / MARK.radius;
  return Math.min(
    (0.84 * size) / MARK.width,
    (0.9 * size) / MARK.height,
    (0.46 * size) / MARK.radius,
  );
}

function drawIcon(size, maskable) {
  const rgba = Buffer.alloc(size * size * 4);
  fillBackground(rgba, COLORS.console);
  const scale = fitScale(size, maskable);
  strokeLines(rgba, size, HEART, scale, COLORS.paperDim);
  strokeLines(rgba, size, ECG, scale, COLORS.live);
  return encodePng(size, size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
const targets = [
  ["icon-192.png", 192, false],
  ["icon-512.png", 512, false],
  ["icon-512-maskable.png", 512, true],
  ["apple-touch-icon.png", 180, false],
];
for (const [name, size, maskable] of targets) {
  writeFileSync(join(OUT_DIR, name), drawIcon(size, maskable));
  console.log(`wrote public/${name} (${size}x${size})`);
}
