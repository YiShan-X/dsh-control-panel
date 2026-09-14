#!/usr/bin/env node
/**
 * Backwards-compatible entry point.
 *
 * The implementation lives in `src/cli.mjs`; this shim exists so that
 * `node server.mjs` -- the command the original browser-mode README told
 * people to run -- keeps working.
 */

import './src/cli.mjs';
