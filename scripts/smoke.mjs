#!/usr/bin/env node
/**
 * Desktop smoke test.
 *
 * Boots the real Electron app, waits for the window to finish loading the UI,
 * and exits. Useful locally and in CI (which has no human to close a window).
 * Setting an environment variable cross-platform needs a script rather than a
 * shell one-liner, which is all this is.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { electronBinary } from './electron-binary.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// `electron` resolves to the platform launcher through node_modules/.bin, but
// on Windows that is a .cmd shim. Point at the real binary instead.
const electronBin = await electronBinary();

const args = ['.'];
if (process.platform === 'linux' && process.env.CI) {
  // Headless CI needs a virtual display; pass through if xvfb-run is wrapping us.
  args.push('--no-sandbox');
}

const child = spawn(electronBin, args, {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, DSH_PANEL_SMOKE: '1' },
});

const timer = setTimeout(() => {
  process.stderr.write('smoke test timed out after 60s\n');
  child.kill();
  process.exit(1);
}, 60000);

child.on('error', (err) => {
  clearTimeout(timer);
  process.stderr.write(`could not start Electron: ${err.message}\n`);
  process.exit(1);
});

child.on('exit', (code) => {
  clearTimeout(timer);
  process.exit(code ?? 1);
});
