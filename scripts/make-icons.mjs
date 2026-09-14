#!/usr/bin/env node
/**
 * Generate the application icons with no dependencies at all.
 *
 * The project ships a hand-written PNG encoder (zlib + CRC32, both from Node's
 * standard library) and an ICO container writer, rather than pulling in an
 * image toolchain for four files. Icons are committed to the repository, so
 * this script only needs to run when the artwork changes.
 *
 * Artwork: a dark rounded tile with an "on" toggle. It reads at 16 px, which is
 * the size that actually decides whether a taskbar/Alt-Tab icon looks right.
 *
 *   node scripts/make-icons.mjs
 *
 * Outputs
 *   build/icon.png            1024x1024  (electron-builder derives icns from it)
 *   build/icon.ico            16..256    (Windows)
 *   build/icons/<n>x<n>.png              (Linux)
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');

/** Master render resolution. Downsampled to every output size for clean edges. */
const MASTER = 3072;
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

// ---------------------------------------------------------------------------
// A tiny RGBA canvas
// ---------------------------------------------------------------------------

function createCanvas(size) {
  return { size, data: new Uint8ClampedArray(size * size * 4) };
}

/** Source-over composite of one pixel. */
function blend(canvas, x, y, r, g, b, a) {
  if (a <= 0) return;
  const i = (y * canvas.size + x) * 4;
  const d = canvas.data;
  const sa = a / 255;
  const da = d[i + 3] / 255;
  const outA = sa + da * (1 - sa);
  if (outA <= 0) return;
  d[i] = (r * sa + d[i] * da * (1 - sa)) / outA;
  d[i + 1] = (g * sa + d[i + 1] * da * (1 - sa)) / outA;
  d[i + 2] = (b * sa + d[i + 2] * da * (1 - sa)) / outA;
  d[i + 3] = outA * 255;
}

/**
 * Paint a shape by sampling `inside(u, v)` on a 3x3 grid inside every pixel.
 * That is where the antialiasing comes from; the master is never downsampled
 * by enough on its own to hide a hard edge at the largest output size.
 */
function paint(canvas, bounds, fn) {
  const S = canvas.size;
  const [bx0, by0, bx1, by1] = bounds;
  const x0 = Math.max(0, Math.floor(bx0 * S));
  const y0 = Math.max(0, Math.floor(by0 * S));
  const x1 = Math.min(S - 1, Math.ceil(bx1 * S));
  const y1 = Math.min(S - 1, Math.ceil(by1 * S));
  const SUB = 3;
  const step = 1 / (S * SUB);
  const offset = step / 2;

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let hits = 0;
      let rr = 0;
      let gg = 0;
      let bb = 0;
      let aa = 0;
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const u = x / S + offset + sx * step;
          const v = y / S + offset + sy * step;
          const out = fn(u, v);
          if (out) {
            hits++;
            rr += out[0]; gg += out[1]; bb += out[2]; aa += out[3];
          }
        }
      }
      if (!hits) continue;
      blend(canvas, x, y, rr / hits, gg / hits, bb / hits, aa / hits);
    }
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers (all in normalized 0..1 coordinates)
// ---------------------------------------------------------------------------

function roundedRectInside(u, v, x0, y0, x1, y1, r) {
  if (u < x0 || u > x1 || v < y0 || v > y1) return false;
  const cx = Math.min(Math.max(u, x0 + r), x1 - r);
  const cy = Math.min(Math.max(v, y0 + r), y1 - r);
  const dx = u - cx;
  const dy = v - cy;
  return dx * dx + dy * dy <= r * r;
}

function circleInside(u, v, cx, cy, r) {
  const dx = u - cx;
  const dy = v - cy;
  return dx * dx + dy * dy <= r * r;
}

const lerp = (a, b, k) => a + (b - a) * k;
const mix = (c1, c2, k) => [lerp(c1[0], c2[0], k), lerp(c1[1], c2[1], k), lerp(c1[2], c2[2], k)];

/** Signed distance to a rounded rect, used for the inner border and glow. */
function roundedRectDistance(u, v, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(u, x0 + r), x1 - r);
  const cy = Math.min(Math.max(v, y0 + r), y1 - r);
  return Math.hypot(u - cx, v - cy) - r;
}

// ---------------------------------------------------------------------------
// The icon
// ---------------------------------------------------------------------------

const TOP = [27, 35, 48];
const BOTTOM = [14, 16, 20];
const TRACK_TOP = [70, 214, 146];
const TRACK_BOTTOM = [40, 172, 110];
const GLOW = [53, 192, 122];

function renderMaster() {
  const canvas = createCanvas(MASTER);

  // --- tile -----------------------------------------------------------------
  const m = 0.042;
  const r = 0.225;
  const tile = [m, m, 1 - m, 1 - m, r];

  paint(canvas, tile, (u, v) => {
    if (!roundedRectInside(u, v, m, m, 1 - m, 1 - m, r)) return null;
    const [cr, cg, cb] = mix(TOP, BOTTOM, (v - m) / (1 - 2 * m));
    return [cr, cg, cb, 255];
  });

  // Subtle rim so the tile still reads on a light desktop background.
  paint(canvas, tile, (u, v) => {
    const d = roundedRectDistance(u, v, m, m, 1 - m, 1 - m, r);
    if (d > 0.006 || d < -0.006) return null;
    const a = 60 * Math.max(0, 1 - Math.abs(d) / 0.006);
    return [86, 104, 132, a];
  });

  // --- toggle ---------------------------------------------------------------
  const tw = 0.66;
  const th = 0.30;
  const x0 = 0.5 - tw / 2;
  const x1 = 0.5 + tw / 2;
  const y0 = 0.5 - th / 2;
  const y1 = 0.5 + th / 2;
  const tr = th / 2;

  // Glow: a few expanding shells of falling alpha, cheap stand-in for a blur.
  const glowPad = 0.13;
  paint(canvas, [x0 - glowPad, y0 - glowPad, x1 + glowPad, y1 + glowPad], (u, v) => {
    const d = roundedRectDistance(u, v, x0, y0, x1, y1, tr);
    if (d <= 0 || d > glowPad) return null;
    const a = 70 * (1 - d / glowPad) ** 2.2;
    return a < 1 ? null : [GLOW[0], GLOW[1], GLOW[2], a];
  });

  // Track body, lit slightly from above.
  paint(canvas, [x0, y0, x1, y1], (u, v) => {
    if (!roundedRectInside(u, v, x0, y0, x1, y1, tr)) return null;
    const [cr, cg, cb] = mix(TRACK_TOP, TRACK_BOTTOM, (v - y0) / th);
    return [cr, cg, cb, 255];
  });

  // Soft shadow under the knob.
  const pad = th * 0.115;
  const kr = tr - pad;
  const kcx = x1 - pad - kr;
  const kcy = 0.5;
  paint(canvas, [kcx - kr - 0.05, kcy - kr - 0.02, kcx + kr + 0.05, kcy + kr + 0.07], (u, v) => {
    const d = Math.hypot(u - kcx, v - (kcy + 0.012)) - kr;
    if (d <= 0 || d > 0.05) return null;
    const a = 110 * (1 - d / 0.05) ** 2;
    return a < 1 ? null : [0, 0, 0, a];
  });

  // Knob.
  paint(canvas, [kcx - kr, kcy - kr, kcx + kr, kcy + kr], (u, v) => {
    if (!circleInside(u, v, kcx, kcy, kr)) return null;
    const k = (u - (kcx - kr)) / (2 * kr) * 0.55 + (v - (kcy - kr)) / (2 * kr) * 0.45;
    const [cr, cg, cb] = mix([255, 255, 255], [214, 224, 238], Math.min(1, Math.max(0, k)));
    return [cr, cg, cb, 255];
  });

  return canvas;
}

// ---------------------------------------------------------------------------
// Downsampling
// ---------------------------------------------------------------------------

/** Box-filter the master down to `size`. Assumes size <= MASTER. */
function resize(master, size) {
  const out = createCanvas(size);
  const scale = master.size / size;
  const src = master.data;
  const dst = out.data;

  for (let y = 0; y < size; y++) {
    const sy0 = Math.floor(y * scale);
    const sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * scale));
    for (let x = 0; x < size; x++) {
      const sx0 = Math.floor(x * scale);
      const sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * scale));

      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * master.size + sx) * 4;
          const sa = src[i + 3] / 255;
          // Premultiply so transparent pixels do not pull colour toward black.
          r += src[i] * sa; g += src[i + 1] * sa; b += src[i + 2] * sa; a += sa;
          n++;
        }
      }
      if (!n) continue;
      const o = (y * size + x) * 4;
      const outA = a / n;
      if (outA > 0) {
        dst[o] = r / n / outA;
        dst[o + 1] = g / n / outA;
        dst[o + 2] = b / n / outA;
      }
      dst[o + 3] = outA * 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PNG / ICO encoders
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(canvas) {
  const { size, data } = canvas;
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);

  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;                                  // filter: none
    for (let x = 0; x < size * 4; x++) {
      raw[y * stride + 1 + x] = data[y * size * 4 + x];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  ihdr[10] = 0;   // compression
  ihdr[11] = 0;   // filter
  ihdr[12] = 0;   // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Build an ICO container holding PNG-compressed entries. Vista and later read
 * PNG entries at any size, which keeps this writer to about twenty lines.
 */
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);              // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;

  entries.forEach((entry, i) => {
    const base = i * 16;
    dir[base] = entry.size >= 256 ? 0 : entry.size;      // 0 means 256
    dir[base + 1] = entry.size >= 256 ? 0 : entry.size;
    dir[base + 2] = 0;                                   // palette colours
    dir[base + 3] = 0;                                   // reserved
    dir.writeUInt16LE(1, base + 4);                      // colour planes
    dir.writeUInt16LE(32, base + 6);                     // bits per pixel
    dir.writeUInt32LE(entry.png.length, base + 8);
    dir.writeUInt32LE(offset, base + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  process.stdout.write(`rendering ${MASTER}x${MASTER} master...\n`);
  const master = renderMaster();

  fs.mkdirSync(path.join(BUILD, 'icons'), { recursive: true });

  const cache = new Map();
  const png = (size) => {
    if (!cache.has(size)) {
      process.stdout.write(`  ${size}x${size}\n`);
      cache.set(size, encodePng(size === MASTER ? master : resize(master, size)));
    }
    return cache.get(size);
  };

  fs.writeFileSync(path.join(BUILD, 'icon.png'), png(1024));
  fs.writeFileSync(
    path.join(BUILD, 'icon.ico'),
    encodeIco(ICO_SIZES.map((size) => ({ size, png: png(size) }))),
  );
  for (const size of LINUX_SIZES) {
    fs.writeFileSync(path.join(BUILD, 'icons', `${size}x${size}.png`), png(size));
  }

  const listing = fs.readdirSync(BUILD, { recursive: true })
    .filter((f) => /\.(png|ico)$/.test(String(f)))
    .map((f) => `  build/${String(f).replace(/\\/g, '/')}`);
  process.stdout.write(`\nwrote:\n${listing.join('\n')}\n`);
}

main();
