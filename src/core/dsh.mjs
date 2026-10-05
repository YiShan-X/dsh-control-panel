/**
 * DSH web process probe.
 *
 * The panel no longer starts, stops or restarts `dsh web`: that was process
 * control, and it was removed with the DSH tab when the official DSH desktop
 * app became the thing people run. What is left is the one observation the
 * rest of the app still needs:
 *
 *   1. **The process filter.** `isDshWeb` decides what counts as "the running
 *      `dsh web`". Only one copy exists -- `mcp.mjs` and `plugins.mjs` import
 *      the probe from here -- so the MCP restart banner and the plugin banner
 *      can never disagree about whether the service is up.
 *   2. **The boot-time cache.** `dshWebStartedAt` is what tells the user
 *      whether a pending MCP change has actually taken effect. Probing costs a
 *      PowerShell round trip (~0.6-0.8 s on Windows), so the result is cached
 *      and only an explicit `fresh` read re-measures.
 *
 * The other half of the file is the spawnable-executable layer
 * (`resolveExecutable` and the npm-shim parsing around it), which `plugins.mjs`
 * uses to run the documented `dsh plugin remove`.
 *
 * Honesty rule, in the same spirit as the rest of the codebase: a probe that
 * cannot run reports "not running", which is the reading callers can act on,
 * rather than throwing or pretending to know.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { log } from './util.mjs';

/** How long a boot-time probe stays valid during normal polling. */
export const WEB_START_TTL_MS = 15000;

/**
 * Shortest interval between two consecutive OS probes. An explicit `fresh` read
 * still refuses to re-probe faster than this, so `/api/state` hammered by a
 * browser cannot turn into a PowerShell fork bomb.
 */
const PROBE_FLOOR_MS = 250;

/**
 * Match a `dsh` + `web` process line and exclude this panel.
 *
 * The exclusion is by name, not by pid: when the panel runs under `dsh web`
 * (a client-plugin embedding) the parent is the service we are looking at, and
 * we must still see it. `control-panel` only ever appears in *our own* command
 * lines.
 */
export function isDshWeb(cmdline) {
  const s = String(cmdline ?? '');
  if (!/dsh/i.test(s)) return false;
  if (!/\bweb\b/.test(s)) return false;
  if (/control-panel/i.test(s)) return false;
  return true;
}

/**
 * @typedef {object} DshWebProcess
 * @property {number} pid
 * @property {string} cmdline    Full command line that started the process.
 * @property {string|null} startedAt  ISO timestamp of process creation.
 * @property {number|null} cpuMs      Kernel + user CPU time in milliseconds.
 * @property {number|null} rssBytes   Resident set size in bytes.
 */

/**
 * @typedef {object} DshWebStatus
 * @property {boolean} running
 * @property {number|null} pid
 * @property {string|null} cmdline
 * @property {string|null} startedAt
 * @property {number|null} uptimeMs   Derived from `startedAt`.
 * @property {number|null} cpuMs
 * @property {number|null} rssBytes
 * @property {number} probeMs         How long the last OS probe took.
 */

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

/**
 * Enumerate `dsh web` processes. One OS call, richest available detail.
 *
 * Never throws: a missing `powershell.exe`, a policy-restricted host, or a
 * locale-shaped surprise all degrade to `null`, which callers read as "not
 * running" -- the same thing a dead process looks like.
 *
 * @returns {DshWebProcess|null}
 */
export function findDshWebProcess() {
  try {
    return process.platform === 'win32' ? findWindows() : findPosix();
  } catch (err) {
    log(`WARN could not enumerate dsh web processes: ${String(err.message).split('\n')[0]}`);
    return null;
  }
}

function findWindows() {
  // One row per match, pipe-separated: "PID|CMDLINE|STARTED|CPUMS|RSS".
  //
  // Deliberately not `Select-Object ... | Format-List`: PowerShell object
  // formatting wraps long command lines, and the wrapped text is what made an
  // earlier version of this probe miss its own target. Joining the fields by
  // hand keeps each row on one line no matter how long the command line is.
  // `|` cannot appear unescaped in a Windows command line, so it is a safe
  // separator.
  const ps = [
    '-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | "
    + "Where-Object { $_.CommandLine -match 'dsh' -and $_.CommandLine -match '\\bweb\\b' "
    + "-and $_.CommandLine -notmatch 'control-panel' } | "
    + 'Sort-Object CreationDate | '
    + "ForEach-Object { $_.ProcessId.ToString() + '|' + $_.CommandLine + '|' "
    + "+ $_.CreationDate.ToUniversalTime().ToString('o') + '|' "
    + "+ [string](($_.KernelModeTime + $_.UserModeTime) / 10000) + '|' "
    + "+ $_.WorkingSetSize.ToString() }",
  ];
  const out = execFileSync('powershell.exe', ps, {
    encoding: 'utf8', timeout: 8000, windowsHide: true,
  });
  return parseWindowsRows(out);
}

/** Exported for tests: turn the probe's stdout into a process record. */
export function parseWindowsRows(out) {
  for (const line of String(out).split(/\r?\n/)) {
    const parts = line.split('|');
    if (parts.length < 2) continue;
    const pid = Number(parts[0]);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    // The command line is everything between the first and the second field
    // boundary; a `|` inside it would shift STARTED, so validate that the
    // timestamp field still parses before trusting the row.
    const startedRaw = parts[parts.length - 3];
    const started = normalizeIso(startedRaw);
    return {
      pid,
      cmdline: parts.slice(1, parts.length - 3).join('|').trim(),
      startedAt: started,
      cpuMs: toNumberOrNull(parts[parts.length - 2]),
      rssBytes: toNumberOrNull(parts[parts.length - 1]),
    };
  }
  return null;
}

function toNumberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** PowerShell round-trips 7 fractional digits; `Date` wants 3. */
export function normalizeIso(out) {
  const trimmed = String(out ?? '').trim();
  if (!trimmed) return null;
  const fixed = trimmed.replace(/(\.\d{3})\d*Z?$/, '$1Z');
  const at = new Date(fixed);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

function findPosix() {
  // `-o` lets us ask for exactly the fields we need, so nothing is parsed out
  // of whitespace-formatted output: pid, elapsed seconds, cpu seconds, rss KB,
  // then the command line.
  const out = execFileSync('ps', ['-Ao', 'pid=,etimes=,time=,rss=,args='], {
    encoding: 'utf8', timeout: 8000,
  });
  const now = Date.now();
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = /^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(trimmed);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const cmdline = m[5];
    if (!isDshWeb(cmdline)) continue;
    const elapsedSec = Number(m[2]);
    return {
      pid,
      cmdline,
      startedAt: Number.isFinite(elapsedSec) ? new Date(now - elapsedSec * 1000).toISOString() : null,
      cpuMs: parseCpuTime(m[3]),
      rssBytes: Number(m[4]) * 1024,
    };
  }
  return null;
}

/** `ps time=` is `[[dd-]hh:]mm:ss`; return milliseconds or null. */
function parseCpuTime(text) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(text).trim());
  if (!m) return null;
  const [, d, h, min, s] = m;
  const secs = Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min) * 60 + Number(s);
  return Number.isFinite(secs) ? secs * 1000 : null;
}

// ---------------------------------------------------------------------------
// Boot-time cache
// ---------------------------------------------------------------------------

/**
 * The probe cache. Three fields, each with one job:
 *
 *   - `at`        when the value was measured (ms). 0 means "never".
 *   - `value`     the measured process, or null for "nothing running".
 *   - `probeMs`   how long that measurement took, for diagnostics.
 */
let cache = { at: 0, value: null, probeMs: 0 };

/**
 * Read the cache, re-probing when it is due or when the caller insists.
 *
 * Two guards keep the probe from stampeding:
 *
 *   - `ttl` (the normal case): a measurement younger than `WEB_START_TTL_MS`
 *     answers immediately. Every poll in the window shares one measurement
 *     instead of forking PowerShell once per request.
 *   - `PROBE_FLOOR_MS` (the `fresh` case): even an explicit refresh will not
 *     re-probe within a quarter second of the last one. A client that hammers
 *     `/api/state?fresh=1` gets one probe per floor, not one per request.
 *
 * @param {{fresh?: boolean}} opts
 * @returns {DshWebProcess|null}
 */
function readCache(opts) {
  const age = Date.now() - cache.at;
  const due = cache.at === 0 || age >= WEB_START_TTL_MS;
  const forced = opts.fresh === true && age >= PROBE_FLOOR_MS;

  if (due || forced) {
    const t0 = Date.now();
    const value = findDshWebProcess();
    cache = { at: Date.now(), value, probeMs: Date.now() - t0 };
  }
  return cache.value;
}

/**
 * When did the running `dsh web` boot? The MCP restart banner keys off this.
 *
 * Cached for `WEB_START_TTL_MS`: probing shells out, and the UI polls on a
 * timer. The cache is deliberately *not* invalidated by every read, so the
 * "must the service be restarted?" answer stays stable across polls instead of
 * flickering.
 *
 * The first caller (usually the `buildState` in server.mjs) reuses the cache;
 * later readers in the same request observe the same value and flip the entry
 * to stale so the *next* request measures again.
 *
 * @param {{fresh?: boolean}} [opts] `fresh` forces a re-probe (still floored to
 *   one probe per `PROBE_FLOOR_MS`, so a hammering client cannot fork-bomb
 *   PowerShell).
 * @returns {string|null} ISO timestamp
 */
export function dshWebStartedAt(opts = {}) {
  return readCache(opts)?.startedAt ?? null;
}

/**
 * The whole probe snapshot, in one OS call.
 *
 * Only `startedAt` has a consumer today (the restart-pending comparison above).
 * The remaining fields come from the same `Get-CimInstance` / `ps` row, and
 * they are what makes a bug report diagnosable -- "which process did the probe
 * actually see?" -- so they are reported rather than discarded.
 *
 * @param {{fresh?: boolean}} [opts]
 * @returns {DshWebStatus}
 */
export function dshWebStatus(opts = {}) {
  const proc = readCache(opts);
  const snapshot = proc
    ? (() => {
      const started = proc.startedAt ? new Date(proc.startedAt).getTime() : NaN;
      return {
        running: true,
        pid: proc.pid,
        cmdline: proc.cmdline,
        startedAt: proc.startedAt,
        uptimeMs: Number.isFinite(started) ? Math.max(0, Date.now() - started) : null,
        cpuMs: proc.cpuMs,
        rssBytes: proc.rssBytes,
      };
    })()
    : {
      running: false,
      pid: null,
      cmdline: null,
      startedAt: null,
      uptimeMs: null,
      cpuMs: null,
      rssBytes: null,
    };
  return { ...snapshot, probeMs: cache.probeMs, probed: true };
}

/**
 * Peek at the probe cache. Exported for tests and diagnostics only: production
 * code must go through the accessors, which own the re-probe rules.
 *
 * @returns {{at: number, probeMs: number, value: DshWebProcess|null}}
 */
export function peekDshWebCache() {
  return { ...cache };
}

/**
 * Warm the boot-time cache.
 *
 * Probing shells out to PowerShell / `ps`, which can take over a second on a
 * cold start. Doing that inside the first `/api/state` request would make the
 * panel's own UI wait for it, so hosts call this once at startup instead and
 * the first request finds a warm cache.
 *
 * The warmed entry is *kept* (unlike a normal read, which consumes it), so the
 * first real request does not pay for a second probe immediately.
 *
 * @returns {DshWebStatus}
 */
export function warmDshWebCache() {
  cache = { at: 0, value: null, probeMs: 0 };
  const proc = readCache({ fresh: true });
  const started = proc?.startedAt ? new Date(proc.startedAt).getTime() : NaN;
  return {
    running: proc != null,
    pid: proc?.pid ?? null,
    cmdline: proc?.cmdline ?? null,
    startedAt: proc?.startedAt ?? null,
    uptimeMs: Number.isFinite(started) ? Math.max(0, Date.now() - started) : null,
    cpuMs: proc?.cpuMs ?? null,
    rssBytes: proc?.rssBytes ?? null,
    probeMs: cache.probeMs,
    probed: true,
  };
}

// ---------------------------------------------------------------------------
// Command-line tokenising
// ---------------------------------------------------------------------------

/**
 * Split a Windows / POSIX command line into argv tokens, handling double and
 * single quotes the way the shells themselves do. Behaviour we need:
 *
 *   - whitespace separates tokens
 *   - a `"..."` group is one token, with the quotes stripped; `\"` inside
 *     keeps the quote
 *   - a `'...'` group is one token, with the quotes stripped; `''` inside
 *     keeps the quote (POSIX convention)
 *   - anything else is taken verbatim
 *
 * Quoted and unquoted text run together without whitespace join into one
 * token, matching how `cmd` and `/bin/sh` tokenise `"foo"bar` as `foobar`.
 *
 * Exported for unit tests; `plugins.mjs` uses it to read the launcher out of
 * `DSH_WEB_CMD` without going through a shell.
 */
export function tokenizeCmdline(s) {
  const tokens = [];
  let cur = '';
  let inDouble = false;
  let inSingle = false;
  let hasContent = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inDouble) {
      if (ch === '\\' && i + 1 < s.length && (s[i + 1] === '"' || s[i + 1] === '\\')) {
        cur += s[++i];
        continue;
      }
      if (ch === '"') { inDouble = false; continue; }
      cur += ch;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        if (s[i + 1] === "'") { cur += "'"; i++; continue; }
        inSingle = false;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"') { inDouble = true; hasContent = true; continue; }
    if (ch === "'") { inSingle = true; hasContent = true; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (hasContent) { tokens.push(cur); cur = ''; hasContent = false; }
      continue;
    }
    cur += ch;
    hasContent = true;
  }
  if (hasContent) tokens.push(cur);
  return tokens;
}

// ---------------------------------------------------------------------------
// Spawnable executables
// ---------------------------------------------------------------------------

/**
 * Windows cannot spawn a `.cmd`/`.bat` shim directly: `CreateProcess` has no
 * idea what to do with one, and libuv surfaces that as `ENOENT` — the same
 * error as "there is no such program", which is what makes it so confusing.
 * `dsh` is exactly this on Windows: `where dsh` finds `dsh` *and* `dsh.cmd`,
 * and only the wrapper can actually run.
 *
 * So the command is routed through `cmd /c`, which is what the shell does and
 * what every npm-installed CLI expects. The command itself is quoted as one
 * token so a path with spaces survives; the remaining arguments are passed as
 * separate tokens and quoted by libuv.
 *
 * Exported for tests, which pin the wrapper without needing a Windows host.
 *
 * @param {string} executable Resolved executable path or bare command name.
 * @param {string[]} args
 * @param {NodeJS.Platform} [platform]
 * @returns {{command: string, args: string[], wrapped: boolean}}
 */
export function shellShimSpec(executable, args, platform = process.platform) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(executable)) {
    return { command: executable, args, wrapped: false };
  }
  const quoted = /\s/.test(executable) && !/^".*"$/.test(executable)
    ? `"${executable}"`
    : executable;
  return { command: 'cmd', args: ['/c', quoted, ...args], wrapped: true };
}

/** `where`/`which` results, so the lookup happens once per name per process. */
const executableCache = new Map();

/**
 * Forget the resolution cache.
 *
 * Exported for tests: the cache is keyed by bare name, and a test that changes
 * PATH to supply a stand-in command (a CI runner has no `dsh` installed) would
 * otherwise be answered by a cached miss.
 */
export function clearExecutableCache() {
  executableCache.clear();
}

/** Extensions Windows can start directly. `.cmd`/`.bat` still need `cmd /c`. */
const WINDOWS_EXEC_EXTS = ['.exe', '.com', '.cmd', '.bat'];

/**
 * Read an npm-generated `.cmd` shim and return the `node` command it stands for.
 *
 * npm writes these shims for every globally-installed CLI, and they all end in
 * the same line:
 *
 *   endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\..." %*
 *
 * Going through `cmd /c` works but is **not silent**: `cmd` itself stays hidden,
 * while the console application it starts gets a *visible* console allocated for
 * it, so a black box appears and stays for the service's whole life. Launching
 * the same `node` and script directly is what makes the start silent -- `spawn`
 * creates that child with `CREATE_NO_WINDOW`.
 *
 * `%dp0%` (the shim's own directory) and `%~dp0` are substituted; `%*` is
 * dropped because the caller supplies the arguments. Returns null for anything
 * that does not match, so a hand-written or future shim falls back to `cmd /c`
 * rather than to a guess.
 *
 * Exported for tests.
 *
 * @param {string} cmdPath
 * @param {NodeJS.Platform} [platform]
 * @returns {{command: string, prefixArgs: string[]}|null}
 */
export function parseNpmShim(text, dir) {
  /**
   * npm's shims pick the interpreter at run time:
   *
   *   IF EXIST "%dp0%\node.exe" (SET "_prog=%dp0%\node.exe") ELSE (SET "_prog=node")
   *
   * so the program token is the variable `%_prog%`, not a literal path. Follow
   * the same branch: prefer the `node.exe` shipped next to the shim, else the
   * `node` on PATH.
   */
  const localNode = path.win32.join(dir, 'node.exe');
  const progVar = fs.existsSync(localNode) ? localNode : 'node';

  /**
   * Substitute the shim's variables.
   *
   * `%dp0%` ends with a separator, the shim adds another one, so the naive
   * substitution leaves `...\nodejs\\node_modules\...`. `path.win32.normalize`
   * collapses that -- and is deliberately the *only* step, because swallowing
   * the extra separator in the regex instead glues the directory to the next
   * segment (`nodejsnode_modules`), which is a worse failure than a doubled
   * backslash.
   */
  const expand = (s) => path.win32.normalize(String(s)
    .replace(/%~?dp0%~?/gi, dir)
    .replace(/%_prog%/gi, progVar)
    .trim());

  // The invocation line is the last quoted pair in the file; earlier quoted
  // tokens belong to the IF/ELSE that chose `_prog`.
  const pairs = [...String(text).matchAll(/"([^"\n]*)"\s+"([^"\n]*)"[^\n]*/g)];
  for (let i = pairs.length - 1; i >= 0; i--) {
    const program = expand(pairs[i][1]);
    const script = expand(pairs[i][2]);
    if (!program || !script) continue;

    // `_prog=node` is a PATH lookup, not a path; resolve it the same way the
    // panel resolves any other bare command.
    const exe = program.includes('\\') || program.includes('/')
      ? (/\.(exe|com)$/i.test(program) && fs.existsSync(program) ? program : null)
      : resolveExecutable(program);
    if (!exe) continue;
    if (!fs.existsSync(script)) continue;
    return { command: exe, prefixArgs: [script] };
  }
  return null;
}

/**
 * Read an npm-generated `.cmd` shim and return the `node` command it stands for.
 *
 * npm writes these shims for every globally-installed CLI, and they all end in
 * the same line:
 *
 *   endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\..." %*
 *
 * Going through `cmd /c` works but is **not silent**: `cmd` itself stays hidden,
 * while the console application it starts gets a *visible* console allocated for
 * it, so a black box appears and stays for the service's whole life. Launching
 * the same `node` and script directly is what makes the start silent -- `spawn`
 * creates that child with `CREATE_NO_WINDOW`.
 *
 * `%*` is dropped because the caller supplies the arguments. Returns null for
 * anything that does not match, so a hand-written or future shim falls back to
 * `cmd /c` rather than to a guess.
 *
 * Exported for tests.
 *
 * @param {string} cmdPath
 * @param {NodeJS.Platform} [platform]
 * @returns {{command: string, prefixArgs: string[]}|null}
 */
export function unwrapNpmShim(cmdPath, platform = process.platform) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(cmdPath)) return null;
  let text;
  try {
    text = fs.readFileSync(cmdPath, 'utf8');
  } catch {
    return null;
  }
  return parseNpmShim(text, path.win32.dirname(cmdPath));
}

/**
 * Pick the entry a shell would actually run out of `where`'s output.
 *
 * `where dsh` on an nvm4w machine lists *four* paths and the first is the
 * extensionless `C:\nvm4w\nodejs\dsh` -- a POSIX shell script that Windows
 * cannot start at all. Taking that line, as an earlier version did, reproduced
 * the very ENOENT this resolver exists to prevent. Only a path with a runnable
 * extension counts, and a real `.exe` wins over a wrapper.
 *
 * Exported for tests.
 *
 * @param {string} stdout
 * @param {NodeJS.Platform} platform
 * @returns {string|null}
 */
export function pickExecutable(stdout, platform) {
  const candidates = String(stdout)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && fs.existsSync(l));
  if (candidates.length === 0) return null;
  if (platform !== 'win32') return candidates[0];

  const ranked = candidates
    .map((path) => ({ path, rank: WINDOWS_EXEC_EXTS.indexOf(path.slice(path.lastIndexOf('.')).toLowerCase()) }))
    .filter((c) => c.rank >= 0)
    .sort((a, b) => a.rank - b.rank);
  return ranked.length ? ranked[0].path : null;
}

/**
 * Resolve a command the way the shell would, to a path `spawn` can run.
 *
 * This is the difference between "the user can type it" and "we can spawn it":
 * `execFileSync('dsh')` succeeds through the shell while `spawn('dsh')` fails
 * with ENOENT, which is precisely the bug this function exists to close.
 *
 * @param {string} name
 * @returns {string|null} A launchable path, or null.
 */
export function resolveExecutable(name) {
  const bare = String(name ?? '').trim();
  if (!bare) return null;
  if (executableCache.has(bare)) return executableCache.get(bare);

  let resolved = null;
  if (bare.includes('/') || bare.includes('\\')) {
    // An explicit path: nothing to search for, but on Windows it still has to
    // be a file the OS will actually start.
    if (fs.existsSync(bare)) {
      const launchable = process.platform !== 'win32'
        || WINDOWS_EXEC_EXTS.includes(bare.slice(bare.lastIndexOf('.')).toLowerCase());
      resolved = launchable ? bare : null;
    }
  } else {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    // `where` is itself a .cmd on Windows, so it needs the wrapper too.
    const cmd = shellShimSpec(finder, [bare]);
    try {
      const out = execFileSync(cmd.command, cmd.args, {
        encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
      resolved = pickExecutable(out, process.platform);
    } catch {
      resolved = null;
    }
  }

  executableCache.set(bare, resolved);
  return resolved;
}
