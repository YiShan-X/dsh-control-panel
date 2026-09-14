/**
 * The MCP model, plus the cc-switch -> DSH config converter.
 *
 * WHY THIS TAB IS NOT LIVE: MCP servers are an assembly-layer concern. `dsh
 * web` reads the composition once at startup and has no hot reload, so every
 * toggle here needs a restart. The UI says so, and the banner only appears when
 * a restart is genuinely pending (patch file newer than the running process).
 *
 * ENABLE ORDER MATTERS: a parked block in `disabled.yml` is restored VERBATIM
 * before cc-switch is ever consulted. That block is the configuration that
 * actually ran -- possibly hand-tuned after it was generated -- and
 * regenerating it from cc-switch would silently throw those edits away.
 * cc-switch is only used to create a block that has never existed in DSH.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './errors.mjs';
import { readCcSwitch } from './ccswitch.mjs';
import { appendBlock, ensureValidArray, parseBlocks, removeBlock } from './patch.mjs';
import { exists, log, readText, writeText, yamlScalar } from './util.mjs';

/** `/path/to/...` placeholders that cc-switch ships but that cannot work. */
const PLACEHOLDER_CWD_RE = /^\/path\/to\//i;

/**
 * Commands that are `.cmd`/`.bat` shims on Windows. libuv cannot spawn them
 * directly (ENOENT), so they have to be reached through `cmd /c`. This is the
 * same reason hand-written gitee/github entries say `command: cmd`.
 */
const SHIM_COMMANDS = new Set([
  'npx', 'npm', 'pnpm', 'yarn', 'bunx', 'bun', 'uvx', 'uv', 'pipx', 'tsx', 'corepack',
]);

/**
 * DSH requires `serverName` to match [A-Za-z0-9_-]{1,32}. cc-switch names are
 * display labels and can violate that outright -- "Anything Analyzer" has a
 * space -- so sanitize and report the mapping rather than emitting a config the
 * loader will silently reject.
 */
export function sanitizeServerName(raw) {
  const cleaned = String(raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (cleaned || 'mcp').slice(0, 32);
}

/**
 * Translate one cc-switch `server_config` JSON blob into DSH's mcp-client
 * config shape (`StdioConfig | StreamableHttpConfig`).
 *
 * @param {string} displayName
 * @param {Record<string, any>} raw
 * @param {{platform?: NodeJS.Platform}} [opts]
 * @returns {{config: object|null, warnings: string[]}}
 */
export function ccToDshConfig(displayName, raw, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const warnings = [];
  const serverName = sanitizeServerName(displayName);
  if (serverName !== displayName) {
    warnings.push(`server name ${JSON.stringify(displayName)} sanitized to ${JSON.stringify(serverName)}`);
  }

  if (!raw || typeof raw !== 'object') {
    return { config: null, warnings: ['server_config is not an object'] };
  }

  const isHttp = raw.type === 'http' || raw.type === 'streamable-http' || raw.type === 'sse'
    || (!raw.command && raw.url);

  if (isHttp) {
    if (!raw.url) return { config: null, warnings: ['http transport without a url'] };
    if (raw.type === 'sse') warnings.push('sse mapped to streamable-http (DSH has no sse transport)');
    const headers = {};
    for (const [k, v] of Object.entries(raw.headers || {})) headers[k] = String(v);
    return {
      config: {
        serverName,
        transport: 'streamable-http',
        url: String(raw.url),
        headers,
        toolCallTimeoutMs: 60000,
        failOnStartupError: false,
      },
      warnings,
    };
  }

  if (!raw.command) return { config: null, warnings: ['no command and no url'] };

  let command = String(raw.command);
  let args = Array.isArray(raw.args) ? raw.args.map(String) : [];

  // A `.cmd` shim cannot be spawned by libuv on Windows; route it via cmd /c.
  const base = path.basename(command).replace(/\.(cmd|bat|exe)$/i, '').toLowerCase();
  const alreadyWrapped = /^cmd(\.exe)?$/i.test(path.basename(command));
  const needsWrap = platform === 'win32'
    && !alreadyWrapped
    && (SHIM_COMMANDS.has(base) || /\.(cmd|bat)$/i.test(command));
  if (needsWrap) {
    args = ['/c', command, ...args];
    command = 'cmd';
    warnings.push(`wrapped through cmd /c (${path.basename(String(raw.command))} is a shell shim)`);
  } else if (alreadyWrapped && args.length && !/^\/[ck]/i.test(args[0])) {
    warnings.push('command is cmd but no /c flag; verify it actually launches');
  }

  const env = {};
  for (const [k, v] of Object.entries(raw.env || {})) {
    if (v === null || typeof v === 'object') {
      warnings.push(`env ${k} is not a scalar, skipped`);
      continue;
    }
    env[k] = String(v);
  }

  let cwd;
  if (raw.cwd) {
    if (PLACEHOLDER_CWD_RE.test(String(raw.cwd)) || !exists(String(raw.cwd))) {
      warnings.push(`cwd ${JSON.stringify(raw.cwd)} does not exist; dropped`);
    } else {
      cwd = String(raw.cwd);
    }
  }

  /** @type {Record<string, any>} */
  const config = {
    serverName,
    transport: 'stdio',
    command,
    args,
    env,
    failOnStartupError: false,
    toolCallTimeoutMs: 60000,
  };
  if (cwd) config.cwd = cwd;
  return { config, warnings };
}

/** Render a DSH patch block for one MCP server. */
export function renderMcpBlock({ key, config, note }) {
  const lines = [`# BEGIN MCP: ${key}`];
  if (note) for (const l of String(note).split('\n')) lines.push(`# ${l}`);
  lines.push('- insert:');
  lines.push(`    - id: mcp-${key}`);
  lines.push("      name: '@deepseek-ai/dsh-mcp-client'");
  lines.push('      config:');
  lines.push(`        serverName: ${yamlScalar(config.serverName)}`);
  lines.push(`        transport: ${yamlScalar(config.transport)}`);

  if (config.transport === 'streamable-http') {
    lines.push(`        url: ${yamlScalar(config.url)}`);
    const hk = Object.keys(config.headers || {});
    if (hk.length) {
      lines.push('        headers:');
      for (const k of hk) lines.push(`          ${yamlScalar(k)}: ${yamlScalar(config.headers[k])}`);
    }
  } else {
    lines.push(`        command: ${yamlScalar(config.command)}`);
    if (config.args?.length) {
      lines.push('        args:');
      for (const a of config.args) lines.push(`          - ${yamlScalar(a)}`);
    }
    const ek = Object.keys(config.env || {});
    if (ek.length) {
      lines.push('        env:');
      for (const k of ek) lines.push(`          ${yamlScalar(k)}: ${yamlScalar(config.env[k])}`);
    }
    if (config.cwd) lines.push(`        cwd: ${yamlScalar(config.cwd)}`);
  }

  lines.push('        failOnStartupError: false');
  lines.push(`        toolCallTimeoutMs: ${config.toolCallTimeoutMs ?? 60000}`);
  lines.push(`# END MCP: ${key}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Patch file state
// ---------------------------------------------------------------------------

function readPatchState(config) {
  const patchText = readText(config.patchFile) ?? '';
  const disabledText = readText(config.disabledFile) ?? '';
  return {
    patchText,
    disabledText,
    on: parseBlocks(patchText),
    off: parseBlocks(disabledText),
  };
}

/** One-line description of a server's launch configuration. */
export function summarize(config, raw) {
  if (!config) return raw?.url ? `http ${raw.url}` : 'unrenderable config';
  if (config.transport === 'streamable-http') return config.url;
  const parts = [config.command, ...(config.args || [])].join(' ');
  return parts.length > 96 ? `${parts.slice(0, 93)}...` : parts;
}

/**
 * Build the complete MCP view.
 *
 * @param {import('./config.mjs').PanelConfig} config
 */
export async function buildMcpState(config) {
  const cc = await readCcSwitch(config);
  const { patchText, disabledText, on, off } = readPatchState(config);

  const byKey = new Map();

  // A DSH block id and a cc-switch display name need not agree on case: the DB
  // may say "GitHub" while the hand-written DSH block is `github`. Resolve to
  // the EXISTING block id when one matches, otherwise the same server shows up
  // twice and the two rows contradict each other.
  const canonicalKey = new Map();
  for (const k of [...on.keys(), ...off.keys()]) canonicalKey.set(k.toLowerCase(), k);

  for (const row of cc.mcpServers) {
    let raw = null;
    let parseError = null;
    try { raw = JSON.parse(row.server_config); } catch (e) { parseError = e.message; }

    const sanitized = sanitizeServerName(row.name);
    const key = canonicalKey.get(sanitized.toLowerCase()) ?? sanitized;
    const { config: serverConfig, warnings } = raw
      ? ccToDshConfig(row.name, raw, { platform: process.platform })
      : { config: null, warnings: [] };
    if (parseError) warnings.unshift(`server_config is not JSON: ${parseError}`);
    if (raw?.disabled) warnings.push('cc-switch config carries disabled:true');

    const status = on.has(key) ? 'on' : off.has(key) ? 'off' : 'never';
    byKey.set(key, {
      key,
      ccId: row.id,
      ccName: row.name,
      displayName: row.name,
      description: row.description || '',
      tags: row.tags || '',
      status,
      enabled: status === 'on',
      transport: serverConfig?.transport ?? (raw?.url ? 'streamable-http' : 'stdio'),
      summary: summarize(serverConfig, raw),
      warnings,
      renderable: Boolean(serverConfig),
      serverName: serverConfig?.serverName ?? key,
      managed: 'cc-switch',
      pool: null,
    });
    void patchText;
    void disabledText;
  }

  // Blocks present in a patch file but with no cc-switch row (hand-written, or
  // a server deleted from cc-switch). Reported so nothing is invisible, and
  // still toggleable: disabling parks the block, enabling restores it.
  for (const [key, block] of [...on, ...off]) {
    if (byKey.has(key)) continue;
    byKey.set(key, {
      key,
      ccId: null,
      ccName: key,
      displayName: key,
      description: '',
      tags: '',
      status: on.has(key) ? 'on' : 'off',
      enabled: on.has(key),
      transport: /transport: streamable-http/.test(block) ? 'streamable-http' : 'stdio',
      summary: on.has(key)
        ? 'defined in the DSH patch file'
        : 'parked in disabled.yml',
      warnings: cc.available ? ['no matching cc-switch entry'] : [],
      renderable: false,
      serverName: key,
      managed: 'dsh',
      pool: null,
    });
  }

  return {
    mcp: [...byKey.values()].sort(
      (a, b) => Number(b.enabled) - Number(a.enabled) || a.displayName.localeCompare(b.displayName),
    ),
    patchMtime: mtimeOf(config.patchFile),
    disabledMtime: mtimeOf(config.disabledFile),
    dshWebStartedAt: config.probeWeb === false ? null : dshWebStartedAt(),
    files: { patch: config.patchFile, disabled: config.disabledFile },
    ccSwitch: { available: cc.available, reason: cc.reason },
  };
}

function mtimeOf(p) {
  try { return fs.statSync(p).mtime.toISOString(); } catch { return null; }
}

/**
 * Enable or disable one MCP server by moving its delimited block between
 * `cordis.patch.yml` and the parked `disabled.yml`.
 *
 * @param {import('./config.mjs').PanelConfig} config
 * @param {string} key
 * @param {boolean} enabled
 */
export async function setMcpEnabled(config, key, enabled) {
  const state = readPatchState(config);

  if (enabled) {
    if (state.on.has(key)) return { changed: false, note: 'already enabled' };

    // 1. Restore a parked block VERBATIM. See the module header.
    const parked = state.off.get(key);
    if (parked) {
      writeText(config.patchFile, appendBlock(state.patchText, parked));
      writeText(config.disabledFile, removeBlock(state.disabledText, parked));
      return { changed: true, restored: true };
    }

    // 2. Otherwise generate a fresh block from the config hub, if it has one.
    const cc = await readCcSwitch(config);
    const row = cc.mcpServers.find(
      (r) => sanitizeServerName(r.name).toLowerCase() === key.toLowerCase(),
    );
    if (!row) {
      throw new HttpError(
        404,
        'no parked block and no config-hub definition for that server; add one to cordis.patch.yml by hand',
      );
    }

    let raw;
    try { raw = JSON.parse(row.server_config); } catch { raw = null; }
    if (!raw) throw new HttpError(400, 'the config-hub server_config is not valid JSON');

    const { config: serverConfig, warnings } = ccToDshConfig(row.name, raw, { platform: process.platform });
    if (!serverConfig) {
      throw new HttpError(
        400,
        `config-hub definition could not be converted: ${warnings.join('; ') || 'unknown reason'}`,
      );
    }

    const note = [
      `generated from cc-switch "${row.name}"`,
      ...(warnings.length ? [warnings.join('; ')] : []),
    ].join('\n');
    const block = renderMcpBlock({ key, config: serverConfig, note });
    writeText(config.patchFile, appendBlock(state.patchText, block));
    return { changed: true, generated: true, warnings };
  }

  // Disable: move the block out of the patch into the parked store.
  const block = state.on.get(key);
  if (!block) return { changed: false, note: 'not enabled' };

  writeText(config.patchFile, ensureValidArray(removeBlock(state.patchText, block)));
  writeText(config.disabledFile, appendBlock(state.disabledText, block));
  return { changed: true };
}

// ---------------------------------------------------------------------------
// "Is a restart actually pending?"
// ---------------------------------------------------------------------------

/**
 * When did the running `dsh web` boot?
 *
 * MCP composition is read once at startup, so comparing this against the patch
 * file's mtime is what tells the user whether a restart is genuinely pending
 * rather than nagging them forever. Best-effort by design: a null result just
 * hides the banner.
 *
 * Cached: this shells out, and the UI polls `/api/state` on a timer.
 *
 * @returns {string|null} ISO timestamp
 */
const WEB_START_TTL_MS = 20000;
let webStartCache = { at: 0, value: null };

export function dshWebStartedAt() {
  const now = Date.now();
  if (now - webStartCache.at < WEB_START_TTL_MS) return webStartCache.value;
  webStartCache = { at: now, value: probeWebStartedAt() };
  return webStartCache.value;
}

function probeWebStartedAt() {
  try {
    return process.platform === 'win32' ? webStartedWindows() : webStartedPosix();
  } catch (err) {
    log(`WARN could not determine dsh web start time: ${String(err.message).split('\n')[0]}`);
    return null;
  }
}

function isDshWeb(cmdline) {
  const s = String(cmdline);
  if (!/dsh/i.test(s)) return false;
  if (!/\bweb\b/.test(s)) return false;
  if (/control-panel/i.test(s)) return false;
  return true;
}

function normalizeIso(out) {
  const trimmed = String(out).trim();
  if (!trimmed) return null;
  // PowerShell's round-trip format carries 7 fractional digits; Date wants 3.
  return trimmed.replace(/(\.\d{3})\d*Z?$/, '$1Z');
}

function webStartedWindows() {
  const ps = [
    '-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    "Where-Object { $_.CommandLine -match 'dsh' -and $_.CommandLine -match '\\bweb\\b' -and $_.CommandLine -notmatch 'control-panel' } | " +
    'Sort-Object CreationDate | Select-Object -First 1 | ' +
    "ForEach-Object { $_.CreationDate.ToUniversalTime().ToString('o') }",
  ];
  const out = execFileSync('powershell.exe', ps, {
    encoding: 'utf8', timeout: 8000, windowsHide: true,
  });
  return normalizeIso(out);
}

function webStartedPosix() {
  // `lstart` is a fixed-width 24-character field, so the command line that
  // follows can contain spaces without breaking the parse.
  const out = execFileSync('ps', ['-Ao', 'lstart=,args='], {
    encoding: 'utf8', timeout: 8000,
  });
  const rows = out
    .split('\n')
    .map((line) => ({ start: line.slice(0, 24).trim(), cmd: line.slice(24) }))
    .filter((r) => r.start && isDshWeb(r.cmd))
    .map((r) => ({ ...r, at: new Date(r.start) }))
    .filter((r) => !Number.isNaN(r.at.getTime()))
    .sort((a, b) => a.at - b.at);
  return rows.length ? rows[0].at.toISOString() : null;
}
