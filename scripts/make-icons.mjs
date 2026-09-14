#!/usr/bin/env node
/**
 * Install the application icons from the design sources into `build/`.
 *
 * Source of truth: `assets/*.svg`, drawn in the Open Design tool that owns this
 * artwork, with `assets/*.png` / `assets/icon.ico` as that tool's own exports.
 *
 *   assets/icon.svg        the app icon: dark tile + green "on" toggle
 *   assets/icon-small.svg  16-32 px tile, chunkier so it survives a taskbar
 *   assets/icon-mono.svg   single-colour glyph; the tray icon
 *   assets/icon.png        1024x1024 export of icon.svg
 *   assets/icon.ico        16..256 export, for Windows
 *   assets/icons/<n>.png   Linux size set
 *
 *   node scripts/make-icons.mjs
 *
 * Why it copies instead of rasterizing: this project ships no drawing
 * toolchain, and the alternative -- a hand-rolled SVG renderer -- would be a
 * second implementation of the artwork that can silently disagree with the
 * designer's own export. The script therefore *verifies* the exports (they must
 * exist, be real PNG/ICO containers, and carry the sizes the packaging config
 * promises) rather than reimplementing them. Edit the SVGs in the design tool
 * and re-export; do not hand-edit the PNGs.
 *
 * Outputs
 *   build/icon.png            1024x1024  (electron-builder derives icns from it)
 *   build/icon.ico            16..256    (Windows)
 *   build/icon-mono.png       1024x1024  (tray glyph, follows the OS theme)
 *   build/icons/<n>x<n>.png              (Linux)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'assets');
const BUILD = path.join(ROOT, 'build');

/** Sizes the packaging config and the tray between them rely on. */
const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function fail(message) {
  process.stderr.write(`make-icons failed: ${message}\n`);
  process.exit(1);
}

function readAsset(name) {
  const file = path.join(ASSETS, name);
  if (!fs.existsSync(file)) fail(`missing design export ${file}`);
  return fs.readFileSync(file);
}

/** PNG dimensions, read from the IHDR chunk. */
function pngSize(buf, what) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) fail(`${what} is not a PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** The sizes an ICO container advertises, so a truncated export cannot ship. */
function icoSizes(buf) {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
    fail('icon.ico is not an icon container');
  }
  const count = buf.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const offset = 6 + i * 16;
    if (offset + 16 > buf.length) fail('icon.ico directory is truncated');
    sizes.push(buf[offset] === 0 ? 256 : buf[offset]);
  }
  return sizes;
}

function main() {
  const app = readAsset('icon.png');
  const smallSvg = path.join(ASSETS, 'icon-small.svg');
  if (!fs.existsSync(smallSvg)) fail(`missing design export ${smallSvg}`);
  const mono = readAsset('icon-mono.png');
  const ico = readAsset('icon.ico');

  const size = pngSize(app, 'assets/icon.png');
  if (size.width !== 1024 || size.height !== 1024) {
    fail(`assets/icon.png must be 1024x1024, got ${size.width}x${size.height}`);
  }
  const monoSized = pngSize(mono, 'assets/icon-mono.png');
  if (monoSized.width !== 1024 || monoSized.height !== 1024) {
    fail(`assets/icon-mono.png must be 1024x1024, got ${monoSized.width}x${monoSized.height}`);
  }
  const inIco = icoSizes(ico);
  const missing = ICO_SIZES.filter((s) => !inIco.includes(s));
  if (missing.length) fail(`assets/icon.ico is missing sizes: ${missing.join(', ')}`);

  fs.mkdirSync(path.join(BUILD, 'icons'), { recursive: true });
  fs.writeFileSync(path.join(BUILD, 'icon.png'), app);
  fs.writeFileSync(path.join(BUILD, 'icon-mono.png'), mono);
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), ico);

  const perSize = path.join(ASSETS, 'icons');
  for (const s of LINUX_SIZES) {
    const file = path.join(perSize, `${s}x${s}.png`);
    if (!fs.existsSync(file)) fail(`missing Linux icon export ${file}`);
    const dim = pngSize(fs.readFileSync(file), `assets/icons/${s}x${s}.png`);
    if (dim.width !== s || dim.height !== s) {
      fail(`assets/icons/${s}x${s}.png is ${dim.width}x${dim.height}`);
    }
    fs.copyFileSync(file, path.join(BUILD, 'icons', `${s}x${s}.png`));
  }

  const listing = fs.readdirSync(BUILD, { recursive: true })
    .filter((f) => /\.(png|ico)$/.test(String(f)))
    .map((f) => `  build/${String(f).replace(/\\/g, '/')}`)
    .sort();
  process.stdout.write(`installed the icon set (ico sizes: ${inIco.join(', ')})\nwrote:\n${listing.join('\n')}\n`);
}

main();
