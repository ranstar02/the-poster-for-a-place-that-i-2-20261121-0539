// NIMBARA — Isles of the Rising Falls
// A travel poster for a place that isn't there.
// Node stdlib only. No network, no external files, fully deterministic.
// Writes one 1024x1024 PNG to /output/entry.png.

import * as fs from "node:fs";
import * as zlib from "node:zlib";

const W = 1024;
const H = 1024;
const HORIZON = 680; // sea starts here

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32, fixed seed)
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261121);

// ---------------------------------------------------------------------------
// Pixel buffer + drawing helpers (flat colours, alpha blend)
// ---------------------------------------------------------------------------
const px = new Uint8Array(W * H * 3);

type RGB = [number, number, number];

function blendPixel(x: number, y: number, c: RGB, a: number): void {
  if (x < 0 || x >= W || y < 0 || y >= H || a <= 0) return;
  const i = (y * W + x) * 3;
  if (a >= 255) {
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
    return;
  }
  const inv = 255 - a;
  px[i] = (c[0] * a + px[i] * inv) / 255;
  px[i + 1] = (c[1] * a + px[i + 1] * inv) / 255;
  px[i + 2] = (c[2] * a + px[i + 2] * inv) / 255;
}

function fillRect(x0: number, y0: number, x1: number, y1: number, c: RGB, a = 255): void {
  const xa = Math.max(0, Math.floor(x0));
  const xb = Math.min(W - 1, Math.ceil(x1));
  const ya = Math.max(0, Math.floor(y0));
  const yb = Math.min(H - 1, Math.ceil(y1));
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) blendPixel(x, y, c, a);
  }
}

function fillCircle(cx: number, cy: number, r: number, c: RGB, a = 255): void {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(H - 1, Math.ceil(cy + r));
  const r2 = r * r;
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      if (dx * dx + dy * dy <= r2) blendPixel(x, y, c, a);
    }
  }
}

// Filled polygon (scanline), flat colour.
function fillPoly(pts: Array<[number, number]>, c: RGB, a = 255): void {
  let minY = H;
  let maxY = 0;
  for (const [, y] of pts) {
    if (y < minY) minY = Math.floor(y);
    if (y > maxY) maxY = Math.ceil(y);
  }
  minY = Math.max(0, minY);
  maxY = Math.min(H - 1, maxY);
  for (let y = minY; y <= maxY; y++) {
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      fillRect(xs[k], y, xs[k + 1], y, c, a);
    }
  }
}

// Thick line via small circles along the segment.
function thickLine(x0: number, y0: number, x1: number, y1: number, r: number, c: RGB, a = 255): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(len));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    fillCircle(x0 + dx * t, y0 + dy * t, r, c, a);
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpColor(c1: RGB, c2: RGB, t: number): RGB {
  return [
    Math.round(lerp(c1[0], c2[0], t)),
    Math.round(lerp(c1[1], c2[1], t)),
    Math.round(lerp(c1[2], c2[2], t)),
  ];
}

// ---------------------------------------------------------------------------
// Sky: dusk gradient in flat horizontal bands (compresses well)
// ---------------------------------------------------------------------------
const SKY_STOPS: Array<[number, RGB]> = [
  [0, [24, 17, 58]], // indigo night top
  [260, [74, 44, 128]], // violet
  [470, [158, 74, 122]], // rose violet
  [600, [226, 122, 78]], // amber glow
  [HORIZON, [247, 185, 94]], // warm amber at the horizon
];

function skyColorAt(y: number): RGB {
  for (let i = 0; i < SKY_STOPS.length - 1; i++) {
    const [y0, c0] = SKY_STOPS[i];
    const [y1, c1] = SKY_STOPS[i + 1];
    if (y <= y1) return lerpColor(c0, c1, (y - y0) / (y1 - y0));
  }
  return SKY_STOPS[SKY_STOPS.length - 1][1];
}

for (let y = 0; y < HORIZON; y++) {
  // Quantise to 8px bands so the PNG stays small.
  const c = skyColorAt(Math.floor(y / 8) * 8);
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
  }
}

// ---------------------------------------------------------------------------
// Stars in the upper sky
// ---------------------------------------------------------------------------
for (let s = 0; s < 170; s++) {
  const x = Math.floor(rand() * W);
  const y = Math.floor(rand() * 400);
  const bright = 150 + Math.floor(rand() * 105);
  const a = 90 + Math.floor(rand() * 140);
  const size = rand() < 0.12 ? 2 : 1;
  fillRect(x, y, x + size - 1, y + size - 1, [bright, bright, 235], a);
}

// ---------------------------------------------------------------------------
// Aurora: thin pale-green ribbons high in the sky
// ---------------------------------------------------------------------------
const AURORA: RGB = [140, 230, 195];
for (let band = 0; band < 3; band++) {
  const baseY = 70 + band * 55;
  const phase = band * 1.7;
  for (let x = 0; x < W; x += 2) {
    const y = baseY + 26 * Math.sin(x * 0.005 + phase) + 10 * Math.sin(x * 0.013 + phase * 2);
    for (let dy = -7; dy <= 7; dy++) {
      const a = Math.max(0, 46 - Math.abs(dy) * 6 - band * 8);
      blendPixel(x, Math.round(y) + dy, AURORA, a);
      blendPixel(x + 1, Math.round(y) + dy, AURORA, a);
    }
  }
}

// ---------------------------------------------------------------------------
// Ringed planet, upper right
// ---------------------------------------------------------------------------
const PLANET: [number, number] = [748, 168];
const PR = 62;
const RING_RX = 112;
const RING_RY = 26;
const RING_TILT = -0.32; // radians
const RING: RGB = [232, 200, 143];

function ringPoint(t: number): [number, number] {
  const ex = RING_RX * Math.cos(t);
  const ey = RING_RY * Math.sin(t);
  const cos = Math.cos(RING_TILT);
  const sin = Math.sin(RING_TILT);
  return [PLANET[0] + ex * cos - ey * sin, PLANET[1] + ex * sin + ey * cos];
}

// Back half of the ring (behind the planet).
for (let d = 0; d <= 180; d++) {
  const t = Math.PI + (d * Math.PI) / 180;
  const [x, y] = ringPoint(t);
  fillCircle(x, y, 3.5, RING, 235);
}
// Planet disc.
fillCircle(PLANET[0], PLANET[1], PR, [245, 214, 168], 255);
// Soft bands across the disc (clipped to the circle by hand).
for (let row = -PR; row <= PR; row += 13) {
  const half = Math.sqrt(Math.max(0, PR * PR - row * row));
  fillRect(PLANET[0] - half, PLANET[1] + row, PLANET[0] + half, PLANET[1] + row + 4, [214, 168, 118], 200);
}
// Shading on the disc's lower edge.
for (let row = 20; row <= PR; row++) {
  const half = Math.sqrt(Math.max(0, PR * PR - row * row));
  fillRect(PLANET[0] - half, PLANET[1] + row, PLANET[0] + half, PLANET[1] + row, [196, 146, 96], 60);
}
// Front half of the ring (in front of the planet).
for (let d = 0; d <= 180; d++) {
  const t = (d * Math.PI) / 180;
  const [x, y] = ringPoint(t);
  fillCircle(x, y, 3.5, RING, 255);
}

// ---------------------------------------------------------------------------
// Sun glow behind the island, on the horizon
// ---------------------------------------------------------------------------
for (let r = 190; r > 0; r -= 6) {
  const a = Math.round(26 * (1 - r / 200));
  fillCircle(512, HORIZON - 6, r, [255, 190, 110], Math.max(4, a));
}

// ---------------------------------------------------------------------------
// Sea: bottom third, deep teal-indigo bands
// ---------------------------------------------------------------------------
const SEA_STOPS: Array<[number, RGB]> = [
  [HORIZON, [30, 62, 88]],
  [820, [18, 40, 64]],
  [H, [9, 20, 38]],
];
function seaColorAt(y: number): RGB {
  for (let i = 0; i < SEA_STOPS.length - 1; i++) {
    const [y0, c0] = SEA_STOPS[i];
    const [y1, c1] = SEA_STOPS[i + 1];
    if (y <= y1) return lerpColor(c0, c1, (y - y0) / (y1 - y0));
  }
  return SEA_STOPS[SEA_STOPS.length - 1][1];
}
for (let y = HORIZON; y < H; y++) {
  const c = seaColorAt(Math.floor(y / 8) * 8);
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
  }
}

// Horizon light line.
fillRect(0, HORIZON - 1, W - 1, HORIZON + 1, [255, 205, 130], 200);

// Sea reflections: warm horizontal streaks under the falls.
for (let s = 0; s < 46; s++) {
  const y = HORIZON + 8 + Math.floor(rand() * 300);
  const halfW = 40 + Math.floor(rand() * 260);
  const cx = 512 + Math.floor((rand() - 0.5) * 260);
  const a = 24 + Math.floor(rand() * 60);
  const warm: RGB = rand() < 0.6 ? [255, 196, 120] : [150, 220, 235];
  fillRect(cx - halfW, y, cx + halfW, y + 2, warm, a);
}

// ---------------------------------------------------------------------------
// Central island / cliff silhouette
// ---------------------------------------------------------------------------
const ISLAND: RGB = [20, 15, 44];
fillPoly(
  [
    [372, 702],
    [388, 640],
    [408, 600],
    [438, 572],
    [472, 552],
    [512, 542],
    [552, 552],
    [586, 572],
    [616, 600],
    [636, 640],
    [652, 702],
  ],
  ISLAND,
);
// Small side rock, left.
fillPoly(
  [
    [300, 702],
    [312, 668],
    [330, 648],
    [352, 640],
    [372, 652],
    [380, 702],
  ],
  ISLAND,
);
// Small side rock, right.
fillPoly(
  [
    [644, 702],
    [656, 660],
    [676, 644],
    [700, 648],
    [716, 672],
    [724, 702],
  ],
  ISLAND,
);
// Pale rim light along the cliff's top edge.
thickLine(438, 572, 472, 552, 2, [122, 92, 168], 160);
thickLine(472, 552, 512, 542, 2, [122, 92, 168], 160);
thickLine(512, 542, 552, 552, 2, [122, 92, 168], 160);
thickLine(552, 552, 586, 572, 2, [122, 92, 168], 160);

// ---------------------------------------------------------------------------
// The Rising Falls: columns of light climbing from the cliff into the sky
// ---------------------------------------------------------------------------
const FALLS: Array<{ x: number; top: number; phase: number }> = [
  { x: 452, top: 250, phase: 0.0 },
  { x: 478, top: 190, phase: 1.1 },
  { x: 500, top: 150, phase: 2.3 },
  { x: 524, top: 180, phase: 3.4 },
  { x: 548, top: 230, phase: 4.6 },
  { x: 572, top: 290, phase: 5.8 },
];

// Bright pool where the falls leave the cliff: a low, wide glow, not a disc.
for (let k = 0; k < 5; k++) {
  fillCircle(512 - 30 + k * 15, 556, 16, [170, 235, 255], 26);
}
fillCircle(512, 556, 20, [220, 248, 255], 60);

for (const f of FALLS) {
  const baseY = 556;
  // Wide soft glow.
  for (let y = f.top; y <= baseY; y++) {
    const wob = 7 * Math.sin(y * 0.02 + f.phase);
    const x = f.x + wob;
    const fade = 1 - (baseY - y) / (baseY - f.top + 60);
    for (let dx = -11; dx <= 11; dx++) {
      const a = Math.round(62 * fade * (1 - Math.abs(dx) / 12));
      blendPixel(Math.round(x) + dx, y, [140, 220, 255], Math.max(0, a));
    }
  }
  // Bright core.
  for (let y = f.top; y <= baseY; y++) {
    const wob = 7 * Math.sin(y * 0.02 + f.phase);
    const x = f.x + wob;
    for (let dx = -2; dx <= 2; dx++) {
      blendPixel(Math.round(x) + dx, y, [235, 250, 255], 235);
    }
    blendPixel(Math.round(x), y, [255, 255, 255], 255);
  }
}

// Rising droplets / sparks climbing with the falls.
for (let p = 0; p < 90; p++) {
  const f = FALLS[Math.floor(rand() * FALLS.length)];
  const t = rand();
  const y = Math.round(556 - t * (556 - f.top));
  const x = Math.round(f.x + 7 * Math.sin(y * 0.02 + f.phase) + (rand() - 0.5) * 26);
  const a = 120 + Math.floor(rand() * 120);
  const big = rand() < 0.2;
  fillRect(x, y, x + (big ? 2 : 1), y + (big ? 2 : 1), [210, 240, 255], a);
}

// ---------------------------------------------------------------------------
// Birds: small dark silhouettes in the sky
// ---------------------------------------------------------------------------
const BIRDS: Array<[number, number, number]> = [
  [196, 300, 10],
  [258, 252, 8],
  [330, 208, 9],
  [150, 176, 7],
  [806, 318, 9],
  [862, 268, 8],
  [890, 178, 7],
  [620, 210, 7],
];
for (const [bx, by, s] of BIRDS) {
  thickLine(bx - s, by - 3, bx, by, 1.6, [26, 20, 54], 235);
  thickLine(bx, by, bx + s, by - 3, 1.6, [26, 20, 54], 235);
}

// ---------------------------------------------------------------------------
// Bitmap font (5x7) + typography
// ---------------------------------------------------------------------------
const FONT: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

function textWidth(str: string, scale: number): number {
  // Each glyph is 5 columns + 1 column gap, except after the last glyph.
  return str.length * 6 * scale - scale;
}

function drawTextRaw(str: string, x0: number, y0: number, scale: number, c: RGB): void {
  let cx = x0;
  for (const ch of str) {
    const glyph = FONT[ch];
    if (glyph) {
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (glyph[row][col] === "1") {
            fillRect(cx + col * scale, y0 + row * scale, cx + (col + 1) * scale - 1, y0 + (row + 1) * scale - 1, c, 255);
          }
        }
      }
    }
    cx += 6 * scale;
  }
}

function drawText(str: string, x0: number, y0: number, scale: number, fill: RGB, outline: RGB, outlinePx: number): void {
  const offs: Array<[number, number]> = [
    [-outlinePx, 0],
    [outlinePx, 0],
    [0, -outlinePx],
    [0, outlinePx],
    [-outlinePx, -outlinePx],
    [outlinePx, -outlinePx],
    [-outlinePx, outlinePx],
    [outlinePx, outlinePx],
  ];
  for (const [dx, dy] of offs) drawTextRaw(str, x0 + dx, y0 + dy, scale, outline);
  drawTextRaw(str, x0, y0, scale, fill);
}

// Main name: NIMBARA, large, cream-gold with a dark outline, lower third.
const NAME = "NIMBARA";
const NAME_SCALE = 20;
const nameW = textWidth(NAME, NAME_SCALE);
const nameX = Math.round((W - nameW) / 2);
const nameY = 800;
drawText(NAME, nameX, nameY, NAME_SCALE, [247, 227, 176], [26, 16, 48], 3);

// Subline: the place's promise, small, same treatment.
const SUB = "ISLES OF THE RISING FALLS";
const SUB_SCALE = 4;
const subW = textWidth(SUB, SUB_SCALE);
const subX = Math.round((W - subW) / 2);
drawText(SUB, subX, 958, SUB_SCALE, [255, 233, 192], [26, 16, 48], 2);

// ---------------------------------------------------------------------------
// PNG encoder (node:zlib + hand-rolled CRC32, filter 0 rows)
// ---------------------------------------------------------------------------
const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t.push(c >>> 0);
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(): Buffer {
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0; // filter: none
    raw.set(px.subarray(y * W * 3, (y + 1) * W * 3), y * (1 + W * 3) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const out = encodePNG();
fs.mkdirSync("/output", { recursive: true });
fs.writeFileSync("/output/entry.png", out);
console.log(`wrote /output/entry.png (${out.length} bytes, ${W}x${H})`);
