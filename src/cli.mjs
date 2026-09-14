#!/usr/bin/env node
/**
 * Browser mode: run the panel as a local web server and open the system
 * browser. This is the zero-dependency path -- `node src/cli.mjs` needs nothing
 * installed, which keeps the tool usable on a machine where npm is unwelcome.
 *
 * The desktop build (Electron) reuses the same core; see src/desktop/main.mjs.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from './core/config.mjs';
import {
  dshWebStatus,
  restartDshWeb,
  startDshWeb,
  stopDshWeb,
  warmDshWebCache,
} from './core/dsh.mjs';
import { createPanelServer, listen } from './core/server.mjs';
import { log } from './core/util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

function usage() {
  return `dsh-control-panel ${readVersion()}

Toggle the DSH skills and MCP servers that cost tokens on every model request.

Usage
  dsh-control-panel [options]

Options
  --port <n>        Port to listen on            (default 8791, env DSH_PANEL_PORT)
  --host <addr>     Address to bind              (default 127.0.0.1)
  --no-open         Do not open a browser
  --print-config    Print the resolved paths and exit
  -h, --help        Show this help
  -v, --version     Show the version

Environment
  DSH_HOME              DSH home directory              (default ~/.dsh)
  DSH_SKILLS_DIR        DSH skill root                 (default $DSH_HOME/skills)
  DSH_SKILL_POOL        ${path.delimiter}-separated extra skill pools
  DSH_PATCH_FILE        MCP patch file                 (default $DSH_HOME/cordis.patch.yml)
  DSH_DISABLED_FILE     Parked MCP blocks              (default $DSH_HOME/mcp-manager/disabled.yml)
  DSH_WEB_CMD           Command used by the DSH tab's Start button (default "dsh web")
  CC_SWITCH_HOME        cc-switch home                 (default ~/.cc-switch)
  DSH_PANEL_CC_SWITCH   set to 0 to ignore cc-switch entirely
  DSH_PANEL_NO_CONTROL  set to 1 to disable start/stop/restart of dsh web
  DSH_PANEL_PORT        Port (same as --port)
  DSH_PANEL_HOST        Bind address (same as --host)
`;
}

/** Minimal argument parsing; no dependency, no surprises. */
function parseArgs(argv, env) {
  const opts = { open: null, printConfig: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return { help: true };
    if (a === '-v' || a === '--version') return { version: true };
    if (a === '--print-config') { opts.printConfig = true; continue; }
    if (a === '--no-open') { opts.open = false; continue; }
    if (a === '--port' || a === '--host') {
      const value = argv[++i];
      if (value === undefined) return { error: `${a} needs a value` };
      if (a === '--port') env.DSH_PANEL_PORT = value;
      else env.DSH_PANEL_HOST = value;
      continue;
    }
    if (a.startsWith('--port=')) { env.DSH_PANEL_PORT = a.slice(7); continue; }
    if (a.startsWith('--host=')) { env.DSH_PANEL_HOST = a.slice(7); continue; }
    return { error: `unknown option ${a}` };
  }
  return opts;
}

/** Open a path with the platform's file manager. Returns an error string or null. */
export function openPathNative(target) {
  return new Promise((resolve) => {
    let cmd;
    let args;
    if (process.platform === 'win32') {
      cmd = 'cmd';
      args = ['/c', 'start', '', target];
    } else if (process.platform === 'darwin') {
      cmd = 'open';
      args = [target];
    } else {
      cmd = 'xdg-open';
      args = [target];
    }
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', (err) => resolve(err.message));
      child.unref();
      resolve(null);
    } catch (err) {
      resolve(err.message);
    }
  });
}

/** Best-effort browser launch; never fatal. */
function openBrowser(url) {
  return openPathNative(url);
}

/**
 * The DSH process control bundle this host exposes. All four entries are the
 * same functions the desktop build uses, so the two hosts cannot drift.
 */
export const CLI_DSH_CONTROL = {
  status: (opts) => dshWebStatus(opts),
  start: () => startDshWeb(),
  stop: () => stopDshWeb(),
  restart: () => restartDshWeb(),
};

/** `DSH_PANEL_NO_CONTROL=1` degrades the panel to a read-only reporter. */
function controlEnabled(env) {
  return !/^(1|true|yes|on)$/i.test(String(env.DSH_PANEL_NO_CONTROL ?? ''));
}

async function main() {
  const env = { ...process.env };
  const parsed = parseArgs(process.argv.slice(2), env);

  if (parsed.help) { process.stdout.write(usage()); return 0; }
  if (parsed.version) { process.stdout.write(`${readVersion()}\n`); return 0; }
  if (parsed.error) { process.stderr.write(`${parsed.error}\n\n${usage()}`); return 2; }

  const config = resolveConfig(env);
  const control = controlEnabled(env);

  if (parsed.printConfig) {
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return 0;
  }

  const server = createPanelServer(config, {
    publicDir: path.join(ROOT, 'public'),
    version: readVersion(),
    openPath: openPathNative,
    // Browser mode is a real process manager, not a read-only viewer: the
    // person who launched `dsh-control-panel` asked for it to manage `dsh web`.
    // Without this the DSH tab is three permanently disabled buttons, which
    // reads as a bug rather than as a policy.
    //
    // The panel only ever binds loopback, so this is not a remote control
    // surface. `DSH_PANEL_NO_CONTROL=1` turns the whole thing off for a host
    // that should only report.
    ...(control ? { dshControl: CLI_DSH_CONTROL, restartHook: restartDshWeb } : {}),
  }).server;

  let bound;
  try {
    bound = await listen(server, { host: config.host, port: config.port });
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      // Re-running the launcher must not dump a stack trace: the already
      // running panel is fine, and exit 0 lets `start.cmd` be double-clicked.
      log(`Port ${config.port} is already in use -- the panel is probably already running.`);
      log(`Open http://${config.host}:${config.port} , or pass --port to use another one.`);
      return 0;
    }
    throw err;
  }

  log(`DSH Control Panel ${readVersion()} -> ${bound.url}`);
  for (const pool of config.pools) log(`  pool  : ${pool.dir}`);
  log(`  skills: ${config.dshSkills}`);
  log(`  mcp   : ${config.patchFile}`);
  if (!fs.existsSync(config.ccDb)) log(`  note  : no cc-switch DB at ${config.ccDb} (that is fine)`);

  // Probe the service once now, so the first UI paint is not stuck behind a
  // PowerShell round trip. Never fatal: a host that cannot enumerate processes
  // just reports "not running".
  if (config.probeWeb && control) {
    const status = warmDshWebCache();
    log(status.running
      ? `  service: dsh web running (pid ${status.pid}, up ${Math.round((status.uptimeMs ?? 0) / 1000)}s)`
      : '  service: no running dsh web found');
  }

  const shouldOpen = parsed.open === false ? false : config.openBrowser;
  if (shouldOpen) await openBrowser(bound.url);

  const shutdown = async () => {
    await bound.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return new Promise(() => {});   // run until signalled
}

main()
  .then((code) => { if (typeof code === 'number') process.exit(code); })
  .catch((err) => {
    log(`FATAL ${err.stack || err.message}`);
    process.exit(1);
  });
