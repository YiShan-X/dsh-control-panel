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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { electronBinary } from './electron-binary.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// `electron` resolves to the platform launcher through node_modules/.bin, but
// on Windows that is a .cmd shim. Point at the real binary instead.
const electronBin = await electronBinary();

/*
 * Give this run its own user-data directory. The single-instance lock is keyed
 * on it, so without this a smoke test launched while the user has the app open
 * would quietly become a "focus the other window" no-op and still exit 0.
 * Isolating it also means the run cannot touch the real window-state or log.
 */
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dshcp-smoke-'));

const args = [`--user-data-dir=${userData}`, '.'];
if (process.platform === 'linux' && process.env.CI) {
  // Headless CI needs a virtual display; pass through if xvfb-run is wrapping us.
  args.push('--no-sandbox');
}

const child = spawn(electronBin, args, {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, DSH_PANEL_SMOKE: '1' },
});

const cleanup = () => {
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }
};

const timer = setTimeout(() => {
  process.stderr.write('smoke test timed out after 60s\n');
  child.kill();
  cleanup();
  process.exit(1);
}, 60000);

child.on('error', (err) => {
  clearTimeout(timer);
  process.stderr.write(`could not start Electron: ${err.message}\n`);
  cleanup();
  process.exit(1);
});

child.on('exit', (code) => {
  clearTimeout(timer);
  cleanup();
  process.exit(code ?? 1);
});
