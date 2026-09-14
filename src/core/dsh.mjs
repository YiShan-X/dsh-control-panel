/**
 * DSH web process control: find, probe, start, stop, restart.
 *
 * This module is the single owner of two things the rest of the app depends on:
 *
 *   1. **The process filter.** `isDshWeb` decides what counts as "the running
 *      `dsh web`". Only one copy exists -- `mcp.mjs` imports the probe from
 *      here -- so the MCP restart banner and the DSH tab can never disagree
 *      about whether the service is up.
 *   2. **The boot-time cache.** `dshWebStartedAt` is what tells the user
 *      whether a pending MCP change has actually taken effect. Probing costs a
 *      PowerShell round trip (~0.6-0.8 s on Windows), so the result is cached
 *      and `invalidateDshWebCache()` is called after every mutating action --
 *      including a `kill`/`spawn` performed by someone else.
 *
 * Honesty rules, in the same spirit as the rest of the codebase:
 *
 *   - Nothing here claims success on a non-event. Every lifecycle function
 *     reports what it observed AFTER acting (`alive`, `livePid`), not what it
 *     intended to do.
 *   - A failed spawn keeps a bounded stderr tail so the UI can show *why*
 *     "Start" did nothing instead of a silent no-op.
 *   - Killing is two-stage: polite first, forced after a short grace period,
 *     measured by polling `taskkill`/`kill -0` rather than sleeping blindly.
 */

import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { HttpError } from './errors.mjs';
import { log } from './util.mjs';

/** How long a boot-time probe stays valid during normal polling. */
export const WEB_START_TTL_MS = 15000;

/**
 * Shortest interval between two consecutive OS probes. A cache that has been
 * invalidated still refuses to re-probe faster than this, so `/api/state`
 * hammered by a browser cannot turn into a PowerShell fork bomb.
 */
const PROBE_FLOOR_MS = 250;

/** How long a just-killed process is given to exit on its own. */
const KILL_GRACE_MS = 800;
/** Poll cadence while waiting out the grace period. */
const KILL_POLL_MS = 100;

/**
 * Match a `dsh` + `web` process line and exclude this panel.
 *
 * The exclusion is by name, not by pid: when the panel runs under `dsh web`
 * (a client-plugin embedding) the parent is the service we manage, and we must
 * still see it. `control-panel` only ever appears in *our own* command lines.
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

/** Is a pid still alive? Cheap on both platforms (no output captured). */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, just not ours to signal
  }
}

// ---------------------------------------------------------------------------
// Boot-time cache
// ---------------------------------------------------------------------------

/**
 * The probe cache. Four fields, each with one job:
 *
 *   - `at`        when the value was measured (ms). 0 means "never".
 *   - `value`     the measured process, or null for "nothing running".
 *   - `probeMs`   how long that measurement took, for the UI to display.
 *   - `invalidated` set by a mutating action, so the next read re-measures even
 *     though the entry is younger than the TTL. Cleared by the next probe.
 */
let cache = { at: 0, value: null, probeMs: 0, invalidated: false };

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
  const due = cache.at === 0 || cache.invalidated || age >= WEB_START_TTL_MS;
  const forced = opts.fresh === true && age >= PROBE_FLOOR_MS;

  if (due || forced) {
    const t0 = Date.now();
    const value = findDshWebProcess();
    cache = { at: Date.now(), value, probeMs: Date.now() - t0, invalidated: false };
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
 * The full status the DSH tab renders, in one probe. See `dshWebStartedAt` for
 * the caching rules.
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
 * @returns {{at: number, probeMs: number, invalidated: boolean, value: DshWebProcess|null}}
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
  cache = { at: 0, value: null, probeMs: 0, invalidated: false };
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

/**
 * Shrink the current cache entry so the next read re-probes.
 *
 * Called after a mutating action: the old value describes the process we just
 * killed, and the UI must not show it for another 15 s. The measurement itself
 * is kept, so the read that follows the action can display `probeMs` without
 * paying for another fork.
 */
export function invalidateDshWebCache() {
  cache = { ...cache, invalidated: true };
}

/**
 * @deprecated Kept as a thin alias for callers written before `dshWebStatus`;
 * the returned shape is a superset of the old one.
 */
export function snapshotDshWeb(opts) {
  return dshWebStatus(opts);
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

/**
 * Kill the running `dsh web` (if any).
 *
 * Polite first (`taskkill` without `/F`, or `SIGTERM`), then forced. The grace
 * period is *observed* rather than slept through: as soon as the pid is gone
 * the force step is skipped, so the common case costs one `taskkill` call
 * instead of a fixed two-second wait.
 *
 * Never throws on the kill itself -- a process that has just exited is a happy
 * path.
 *
 * @returns {Promise<{pid: number, forced: boolean}|null>}
 */
async function killDshWeb(proc, { alive = isAlive } = {}) {
  if (!proc) return null;
  const pid = proc.pid;

  const polite = process.platform === 'win32'
    ? ['taskkill', '/PID', String(pid)]
    : ['kill', '-TERM', String(pid)];
  await run(polite[0], polite.slice(1));

  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline) {
    if (!alive(pid)) return { pid, forced: false };
    await sleep(KILL_POLL_MS);
  }

  const force = process.platform === 'win32'
    ? ['taskkill', '/F', '/T', '/PID', String(pid)]
    : ['kill', '-KILL', String(pid)];
  await run(force[0], force.slice(1), { tolerate: ['ESRCH', '128', '1'] });
  return { pid, forced: true };
}

/** `execFile` as a promise that swallows the errors we expect to see. */
function run(cmd, args, { tolerate = [] } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true }, (err) => {
      if (err && !tolerate.includes(String(err.code))) {
        log(`WARN ${cmd} ${args.join(' ')} -> ${err.code ?? ''} ${err.message.split('\n')[0]}`);
      }
      resolve();
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Start / respawn
// ---------------------------------------------------------------------------

/** Where the start command came from, for the UI to explain itself. */
export function startCommandInfo() {
  const override = String(process.env.DSH_WEB_CMD ?? '').trim();
  return override
    ? { command: override, source: 'DSH_WEB_CMD' }
    : { command: 'dsh web', source: 'default' };
}

/**
 * The last error message captured from a failed start. The UI shows it inline
 * so the user knows why "Start" silently failed.
 */
let lastStartError = null;
export function getLastStartError() {
  return lastStartError;
}
function setLastStartError(msg) {
  lastStartError = msg || null;
  if (msg) log(`WARN start dsh web: ${msg}`);
}

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
 * Exported for unit tests; production code only calls it through
 * `spawnDshWeb` below.
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

/**
 * Decide what to launch for a start or a restart.
 *
 * The command line captured from a running process is a snapshot of an earlier
 * session, and it can be stale: a machine that has since switched Node version
 * managers still reports the *old* absolute `node.exe`. So before replaying a
 * captured command the executable is resolved; when it is gone, the panel falls
 * back to its own start command and says so, rather than failing with an error
 * the user cannot act on.
 *
 * @param {string|null} captured Command line copied from the running process.
 * @returns {{command: string, source: string, fellBack: boolean, captured: string|null}}
 */
export function resolveSpawnSpec(captured) {
  const fallback = startCommandInfo();
  const trimmed = String(captured ?? '').trim();
  if (!trimmed) return { ...fallback, fellBack: false, captured: null };

  const tokens = tokenizeCmdline(trimmed);
  if (tokens.length === 0) return { ...fallback, fellBack: false, captured: trimmed };
  if (!resolveExecutable(tokens[0])) {
    log(`WARN captured command ${tokens[0]} no longer resolves; using "${fallback.command}" instead`);
    return { ...fallback, fellBack: true, captured: trimmed };
  }
  return { command: trimmed, source: 'reused', fellBack: false, captured: trimmed };
}

/**
 * Launch a command line detached.
 *
 * Resolves once the child has actually started or failed, so the caller can
 * report a spawn failure instead of guessing from a timer. stderr is captured
 * into a bounded ring buffer so a failed launch leaves a breadcrumb in the
 * panel log *and* in the DSH tab.
 *
 * Exported so the launch path itself can be exercised (and its "does a console
 * window appear?" behaviour measured) without going through the HTTP layer.
 *
 * @param {string} cmdline
 * @returns {Promise<{pid: number|null, error: string|null, spec: {command: string, args: string[], wrapped: boolean}}>}
 */
export function launchDshWeb(cmdline) {
  const tokens = tokenizeCmdline(String(cmdline ?? ''));
  if (tokens.length === 0) {
    throw new HttpError(500, 'could not parse dsh web command line for respawn (empty)');
  }

  // `dsh` is a `.cmd` shim on Windows; spawning it directly is the ENOENT this
  // whole resolution dance exists to avoid.
  const resolved = resolveExecutable(tokens[0]) ?? tokens[0];

  // Prefer running the shim's own node command: `cmd /c` would work, but it
  // hands the console application a visible console window that stays open for
  // as long as the service runs. Falling back to the wrapper keeps a shim this
  // parser does not understand working, just noisily.
  const unwrapped = unwrapNpmShim(resolved);
  const spec = unwrapped
    ? { command: unwrapped.command, args: [...unwrapped.prefixArgs, ...tokens.slice(1)], wrapped: false }
    : shellShimSpec(resolved, tokens.slice(1));

  return new Promise((resolve, reject) => {
    let settled = false;
    let child;
    try {
      child = spawn(spec.command, spec.args, {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: process.env,
      });
    } catch (err) {
      setLastStartError(`${tokens[0]} could not be launched: ${err.message}`);
      reject(err);
      return;
    }

    let stderrTail = '';
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2000);
      });
      // The pipe can close under us when the child exits immediately.
      child.stderr.on('error', () => { /* nothing useful to report */ });
    }

    child.once('spawn', () => {
      settled = true;
      resolve({ pid: child.pid ?? null, error: null, spec });
    });
    child.once('error', (err) => {
      const message = `${tokens[0]} could not be launched: ${err.message}`;
      setLastStartError(message);
      if (!settled) {
        settled = true;
        reject(new Error(message));
      }
    });
    child.on('exit', (code) => {
      if (code !== null && code !== 0) {
        setLastStartError(`dsh web exited with code ${code}: ${stderrTail.slice(-500) || '(no stderr)'}`);
      }
    });
    child.unref();
  });
}

/**
 * Start `dsh web` from scratch.
 *
 * If the service is already running this is a no-op that reports the existing
 * pid -- never a second copy. Spawning is asynchronous by nature, so the result
 * is resolved only after the new process has had a chance to claim its port and
 * appear in the process table; `alive` tells the caller whether it actually
 * came up.
 *
 * @param {{find?: () => DshWebProcess|null, spawn?: (cmd: string) => Promise<{pid: number|null, error: string|null}>|[number|null],
 *          settleMs?: number, alive?: (pid: number) => boolean}} [opts] Test seams.
 */
export async function startDshWeb(opts = {}) {
  const find = opts.find ?? findDshWebProcess;
  const spawnFn = opts.spawn ?? launchDshWeb;
  const settleMs = Number.isFinite(opts.settleMs) ? opts.settleMs : 1500;

  setLastStartError(null);
  const existing = find();
  if (existing) {
    return {
      changed: false,
      note: 'dsh web is already running',
      existingPid: existing.pid,
      alive: true,
      livePid: existing.pid,
    };
  }

  const { command, source } = startCommandInfo();
  const tokens = tokenizeCmdline(command);
  if (tokens.length === 0) {
    setLastStartError('start command is empty');
    throw new HttpError(400, 'start command is empty');
  }

  // Resolve the executable *before* spawning, so a command that is not on PATH
  // fails with a sentence instead of a bare ENOENT. `dsh` on Windows is a
  // `dsh.cmd` shim, and only the resolved path can be spawned at all.
  const resolved = resolveExecutable(tokens[0]);
  if (!resolved) {
    const message = `${tokens[0]} was not found on PATH`
      + (source === 'default' ? '; set DSH_WEB_CMD to the command that starts dsh web' : '');
    setLastStartError(message);
    throw new HttpError(500, message);
  }

  let pid = null;
  try {
    const result = await spawnFn(command);
    pid = typeof result === 'number' ? result : result?.pid ?? null;
  } catch (err) {
    setLastStartError(err.message);
    throw new HttpError(500, `failed to spawn dsh web: ${err.message}`);
  }

  await sleep(settleMs);
  const live = find();
  invalidateDshWebCache();
  return {
    changed: true,
    newPid: pid,
    startedCmd: command,
    commandSource: source,
    alive: live != null,
    livePid: live ? live.pid : null,
    error: live ? null : lastStartError,
  };
}

/**
 * Stop the running `dsh web`. No-op when nothing is running.
 *
 * @param {{find?: () => DshWebProcess|null, alive?: (pid: number) => boolean}} [opts]
 */
export async function stopDshWeb(opts = {}) {
  const find = opts.find ?? findDshWebProcess;
  const proc = find();
  invalidateDshWebCache();
  if (!proc) return { changed: false, note: 'dsh web is not running' };
  const killed = await killDshWeb(proc, { alive: opts.alive ?? isAlive });
  invalidateDshWebCache();
  return {
    changed: true,
    killedPid: killed?.pid ?? null,
    forced: killed?.forced ?? false,
  };
}

/**
 * Restart `dsh web`: stop what is running, wait for the port to free, relaunch
 * with the command line that was actually in use.
 *
 * The cmdline is reused verbatim (tokenised, never through a shell) so a
 * `dsh web --port 3080` keeps its port. When nothing was running there is
 * nothing to copy, so the restart degrades into a plain start.
 *
 * @param {{find?: () => DshWebProcess|null, spawn?: (cmd: string) => Promise<{pid: number|null, error: string|null}>|[number|null],
 *          alive?: (pid: number) => boolean, settleMs?: number}} [opts]
 */
export async function restartDshWeb(opts = {}) {
  const find = opts.find ?? findDshWebProcess;
  const spawnFn = opts.spawn ?? launchDshWeb;
  const settleMs = Number.isFinite(opts.settleMs) ? opts.settleMs : 800;

  setLastStartError(null);
  const proc = find();
  if (!proc) {
    const started = await startDshWeb(opts);
    return { changed: started.changed, killedPid: null, newPid: started.newPid ?? null, ...started };
  }

  const killed = await killDshWeb(proc, { alive: opts.alive ?? isAlive });
  // The new process needs the previous one to release its port. Give the OS a
  // moment, then hand off to the same "did it actually come up?" check the
  // start path uses.
  await sleep(settleMs);

  const spec = resolveSpawnSpec(proc.cmdline);
  let newPid = null;
  let spawnError = null;
  try {
    const result = await spawnFn(spec.command);
    newPid = typeof result === 'number' ? result : result?.pid ?? null;
  } catch (err) {
    spawnError = err.message;
    log(`WARN restart: respawn failed: ${err.message}`);
  }

  invalidateDshWebCache();
  await sleep(Math.max(settleMs, 600));
  const live = find();
  invalidateDshWebCache();

  return {
    changed: true,
    killedPid: killed?.pid ?? null,
    forced: killed?.forced ?? false,
    newPid,
    alive: live != null,
    livePid: live ? live.pid : null,
    restartCommand: spec.command,
    capturedCommand: spec.captured,
    commandFellBack: spec.fellBack,
    error: live ? null : (spawnError ?? lastStartError),
  };
}
