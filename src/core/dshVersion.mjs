/**
 * DSH version management: which DSH is installed, which ones are published, and
 * how to move between them.
 *
 * This module answers the three questions the DSH tab's version card asks:
 *
 *   1. What version is installed? (`dsh --version`, read through the same
 *      command the Start button would run.)
 *   2. Is something newer available? (the npm package's dist-tags.)
 *   3. Install it. (`npm install -g <package>@<version>`, then *re-observe*.)
 *
 * Three decisions here were made against the obvious alternative, and undoing
 * any of them re-introduces a bug this file exists to prevent:
 *
 *   - **The registry is queried with the user's own `npm`, not with `fetch`.**
 *     Node's global `fetch` ignores `HTTP_PROXY`/`HTTPS_PROXY`, and this project
 *     may not import `node_modules`, so doing it properly would mean hand-rolling
 *     a CONNECT tunnel over `node:tls`. `npm view` already honours the proxy
 *     environment, `.npmrc`, the configured registry (a mirror on a Chinese
 *     machine is the *normal* case, not an edge case) and any auth token -- and
 *     it is the very tool that performs the install, so the version the panel
 *     reports as "available" is by construction the version an update would
 *     fetch. A second, independent HTTP path here could disagree with it.
 *
 *   - **Nothing is cached across a mutation.** After an install the process
 *     executable cache and both entries below are dropped, because every cached
 *     answer describes the pre-update world.
 *
 *   - **Success is reported from the observation, not from npm's exit code.**
 *     `npm install -g` can exit 0 while the `dsh` on PATH still resolves to a
 *     different installation (two package managers, two shims, a stale nvm
 *     version). So the version is read again afterwards and `changed` is true
 *     only when the number actually moved.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  clearExecutableCache,
  resolveExecutable,
  shellShimSpec,
  startCommandInfo,
  tokenizeCmdline,
  unwrapNpmShim,
} from './dsh.mjs';
import { HttpError } from './errors.mjs';
import { compareSemver, isNewer, parseSemver } from './semver.mjs';
import { log } from './util.mjs';

/** How long a `dsh --version` answer is reused. The probe forks a process. */
const INSTALLED_TTL_MS = 60000;

/**
 * How long a registry answer is reused. This one crosses the network, and the
 * registry's own metadata changes on the order of days.
 */
const RELEASE_TTL_MS = 10 * 60 * 1000;

/** `npm view` is a network read; a slow mirror can take a few seconds. */
const VIEW_TIMEOUT_MS = 30000;

/**
 * A global install downloads and unpacks a package tree. Generous on purpose:
 * timing out mid-install leaves a half-installed directory behind, which is a
 * worse outcome than waiting.
 */
const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;

/** Bounded tails, so a chatty npm cannot put a megabyte into a JSON response. */
const TAIL_CHARS = 2000;

// ---------------------------------------------------------------------------
// Running things
// ---------------------------------------------------------------------------

/**
 * Turn a resolved executable into something `spawn` can run silently.
 *
 * npm writes `.cmd` shims on Windows, and running one through `cmd /c` gives the
 * console child a *visible* window (see the long note in `dsh.mjs`). A version
 * probe must never flash a black box, so the npm shim is unwrapped to
 * `node <cli.js>` whenever it matches.
 *
 * @param {string} execPath
 * @returns {{command: string, prefixArgs: string[], unwrapped: boolean}}
 */
function launchSpec(execPath) {
  const unwrapped = unwrapNpmShim(execPath);
  if (unwrapped) {
    return { command: unwrapped.command, prefixArgs: unwrapped.prefixArgs, unwrapped: true };
  }
  const shim = shellShimSpec(execPath, []);
  return { command: shim.command, prefixArgs: shim.args, unwrapped: false };
}

/**
 * Run a command, capture both streams, and never reject on a non-zero exit.
 *
 * A non-zero exit is data here ("npm could not reach the registry"), not an
 * exception: the caller decides what it means and quotes the tail to the user.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{timeoutMs?: number, env?: NodeJS.ProcessEnv}} [opts]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, timedOut: boolean, spawnError: string|null}>}
 */
export function runCapture(command, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? VIEW_TIMEOUT_MS;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: opts.env ?? process.env,
      });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: err.message });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // The child may have grandchildren (npm spawns node again); killing the
      // process group is not portable, so this kills the direct child and the
      // caller reports the timeout rather than pretending it finished.
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);

    child.stdout?.on('data', (c) => { stdout += c; });
    child.stderr?.on('data', (c) => { stderr += c; });

    const finish = (code, spawnError = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, spawnError });
    };

    child.on('error', (err) => finish(null, err.message));
    child.on('close', (code) => finish(code));
  });
}

// ---------------------------------------------------------------------------
// The installed version
// ---------------------------------------------------------------------------

/**
 * The `dsh` executable the panel would actually run.
 *
 * `DSH_WEB_CMD` can point the Start button at a `dsh` that is not on PATH, so
 * the version report follows *that* command's first token. Reporting the version
 * of a different installation than the one the panel starts would be worse than
 * reporting nothing.
 *
 * @returns {{path: string|null, name: string|null, source: string}}
 */
export function resolveDshExecutable() {
  const { command, source } = startCommandInfo();
  const tokens = tokenizeCmdline(command);
  const name = tokens[0] ?? null;
  if (!name) return { path: null, name: null, source };
  return { path: resolveExecutable(name), name, source };
}

/** Pull a version out of whatever `dsh --version` printed. */
export function parseVersionOutput(text) {
  const m = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/**
 * Walk up from a shim's target looking for the package manifest it belongs to.
 *
 * This is the fallback for a host where `dsh --version` cannot run (a broken
 * shim, a Node version manager that moved). Reading the manifest still gives the
 * user a real answer, and `packagePath` tells the UI where that answer came
 * from -- which is what makes a wrong answer diagnosable instead of mysterious.
 *
 * @param {string} startDir
 * @param {string} packageName
 * @returns {{version: string, dir: string}|null}
 */
export function findPackageManifest(startDir, packageName) {
  let dir = startDir;
  for (let depth = 0; depth < 6 && dir; depth += 1) {
    const manifest = path.join(dir, 'package.json');
    try {
      const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (!packageName || data.name === packageName) {
        if (typeof data.version === 'string') return { version: data.version, dir };
      }
    } catch { /* no manifest here; keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Where to start looking for the manifest behind a resolved `dsh`.
 *
 * The two platforms install a global CLI differently, so the walk has to start
 * from the right place on each:
 *
 *   - **POSIX** puts a *symlink* in the bin directory pointing at the package
 *     (`.../bin/dsh -> ../lib/node_modules/@deepseek-ai/dsh/lib/bin.js`), so the
 *     symlink has to be resolved first. Skipping that step looked like it worked
 *     on Windows and silently found no manifest at all on Linux and macOS.
 *   - **Windows** writes a `.cmd` shim whose text names the script, because
 *     libuv cannot execute a batch file at all -- hence `unwrapNpmShim`.
 *
 * A path that is neither (a hand-written wrapper) yields its own directory, and
 * the walk simply fails to find a manifest. That is the honest outcome: guessing
 * a version from an unrelated `package.json` would be worse than reporting none.
 *
 * @param {string} execPath
 * @returns {string}
 */
function manifestSearchStart(execPath) {
  let real = execPath;
  try {
    real = fs.realpathSync(execPath);
  } catch { /* a path that does not resolve is still worth walking from */ }

  const unwrapped = unwrapNpmShim(real);
  if (unwrapped) return path.dirname(unwrapped.prefixArgs[0]);
  return path.dirname(real);
}

/**
 * Read the installed DSH version.
 *
 * `dsh --version` is authoritative and quick (~0.24 s), so it is tried first.
 * The manifest fallback exists because a shim can outlive the installation it
 * points at, and "the file on disk says 0.1.5-rc.2 but the command is broken" is
 * a more useful report than "unknown".
 *
 * @param {{dshExecutable?: {path: string|null, name: string|null, source: string}, timeoutMs?: number}} [opts]
 * @returns {Promise<{version: string|null, source: string, command: string|null, packagePath: string|null, error: string|null}>}
 */
export async function readInstalledVersion(opts = {}) {
  const exe = opts.dshExecutable ?? resolveDshExecutable();
  const command = exe.name ? [exe.name, '--version'].join(' ') : null;

  let fallback = null;
  if (exe.path) {
    // Derive the manifest location from the shim before running anything: it is
    // the same directory either way, and having it lets the fallback run even
    // when the spawn itself fails.
    fallback = findPackageManifest(manifestSearchStart(exe.path), null);
  }

  if (!exe.path) {
    return {
      version: fallback?.version ?? null,
      source: fallback ? 'package.json' : 'missing',
      command,
      packagePath: fallback?.dir ?? null,
      error: exe.name
        ? `${exe.name} was not found on PATH`
        : 'no dsh command is configured',
    };
  }

  const spec = launchSpec(exe.path);
  const res = await runCapture(spec.command, [...spec.prefixArgs, '--version'], {
    timeoutMs: opts.timeoutMs ?? 15000,
  });
  const parsed = res.code === 0 ? parseVersionOutput(res.stdout) : null;

  if (parsed) {
    return {
      version: parsed,
      source: 'dsh --version',
      command,
      packagePath: fallback?.dir ?? null,
      error: null,
    };
  }

  const detail = res.spawnError
    || (res.timedOut ? 'timed out' : `exit ${res.code}`)
    + (res.stderr ? `: ${String(res.stderr).trim().split('\n')[0]}` : '');
  return {
    version: fallback?.version ?? null,
    source: fallback ? 'package.json' : 'missing',
    command,
    packagePath: fallback?.dir ?? null,
    error: `could not read ${command ?? 'dsh'} (${detail})`,
  };
}

// ---------------------------------------------------------------------------
// What is published
// ---------------------------------------------------------------------------

/**
 * Ask npm what versions of the package exist.
 *
 * One `npm view --json` call returns dist-tags, every version and the publish
 * time of each, so the three questions the UI has ("what is the latest", "what
 * channels exist", "when was it published") cost a single network round trip.
 *
 * @param {import('./config.mjs').PanelConfig} config
 * @param {{npmPath?: string|null, timeoutMs?: number, run?: typeof runCapture}} [opts]
 * @returns {Promise<{distTags: Record<string,string>, versions: string[], time: Record<string,string>, registry: string|null, packageName: string}>}
 */
export async function fetchPublishedVersions(config, opts = {}) {
  const npmPath = opts.npmPath !== undefined ? opts.npmPath : resolveExecutable('npm');
  if (!npmPath) {
    throw new HttpError(
      501,
      'npm was not found on PATH, so the panel cannot ask the registry what versions exist. The installed version is still shown above.',
    );
  }

  const spec = launchSpec(npmPath);
  const args = [...spec.prefixArgs, 'view', config.dshPackage, '--json'];
  const run = opts.run ?? runCapture;
  const res = await run(spec.command, args, { timeoutMs: opts.timeoutMs ?? VIEW_TIMEOUT_MS });

  if (res.timedOut) {
    throw new HttpError(504, `npm view ${config.dshPackage} timed out after ${Math.round((opts.timeoutMs ?? VIEW_TIMEOUT_MS) / 1000)}s`);
  }
  if (res.spawnError) {
    throw new HttpError(500, `could not run npm: ${res.spawnError}`);
  }

  let data = null;
  try {
    // Strip a leading BOM before parsing. npm itself writes plain UTF-8, but a
    // wrapper script or a Windows console can prepend one, and `JSON.parse`
    // rejects it -- which would surface to the user as "the registry is broken"
    // for a reason that has nothing to do with the registry.
    data = JSON.parse(String(res.stdout).replace(/^\uFEFF/, ''));
  } catch { /* npm printed something that is not JSON; report the tail below */ }

  // npm reports registry failures as JSON on stdout with a non-zero exit, so a
  // parseable error object is the *expected* shape of "no such package" and is
  // worth surfacing verbatim -- it names the registry that answered.
  const npmError = data?.error?.summary ?? data?.error?.detail;
  if (res.code !== 0 || npmError) {
    const tail = String(res.stderr || '').trim().split('\n').slice(-4).join(' ').slice(-400);
    throw new HttpError(
      502,
      npmError
        ? `npm could not read ${config.dshPackage}: ${npmError}`
        : `npm view exited ${res.code}${tail ? `: ${tail}` : ''}`,
    );
  }
  if (!data || typeof data !== 'object') {
    throw new HttpError(502, `npm view returned no usable JSON: ${String(res.stdout).slice(0, 200)}`);
  }

  const distTags = data['dist-tags'] && typeof data['dist-tags'] === 'object'
    ? data['dist-tags']
    : {};
  const versions = Array.isArray(data.versions) ? data.versions : [];
  const time = data.time && typeof data.time === 'object' ? data.time : {};

  return {
    packageName: data.name ?? config.dshPackage,
    distTags,
    versions,
    time,
    // Where the answer came from. Without this the panel shows a version with
    // no way to tell that it came from a mirror instead of npmjs.org.
    //
    // Read from `dist.tarball`, not `_resolved`: `_resolved` is recorded by the
    // *publisher* and points at the path their build produced
    // (`/home/runner/work/...`), so it names nothing a user could act on.
    // `dist.tarball` is rewritten by whichever registry answered this request.
    registry: registryOrigin(data.dist?.tarball) ?? null,
  };
}

/** Reduce a tarball URL to the registry it was served by. */
export function registryOrigin(resolved) {
  if (typeof resolved !== 'string' || !resolved) return null;
  try {
    return new URL(resolved).origin;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const installedCache = { at: 0, value: null };
const releaseCache = { at: 0, value: null };

/**
 * When this process last replaced the installed version, as an ISO string.
 *
 * This is an observation about the machine, not a cache entry, so
 * `invalidateVersionCache()` deliberately leaves it alone. It is what makes
 * "restart dsh web" honest: the running service booted at `dshWebStartedAt` and
 * the files were swapped at `lastUpdateAt`, so only an update that landed
 * *after* that boot can be waiting to take effect. The MCP restart banner makes
 * the same comparison against a file mtime.
 */
let lastUpdateAt = null;

/**
 * Forget every cached answer. Called after an install.
 *
 * The process-executable cache in `dsh.mjs` is dropped too: an update can move
 * or replace the shim, and a cached path to the old one would keep reporting the
 * old version forever.
 */
export function invalidateVersionCache() {
  installedCache.at = 0;
  installedCache.value = null;
  releaseCache.at = 0;
  releaseCache.value = null;
  clearExecutableCache();
}

/**
 * The installed version, from cache unless it is stale or the caller insists.
 *
 * @param {import('./config.mjs').PanelConfig} config
 * @param {{fresh?: boolean, dshExecutable?: any, readInstalled?: typeof readInstalledVersion}} [opts]
 */
export async function installedVersion(config, opts = {}) {
  const fresh = opts.fresh === true;
  if (!fresh && installedCache.value && Date.now() - installedCache.at < INSTALLED_TTL_MS) {
    return installedCache.value;
  }
  const read = opts.readInstalled ?? readInstalledVersion;
  const value = await read({ dshExecutable: opts.dshExecutable });
  installedCache.at = Date.now();
  installedCache.value = value;
  return value;
}

/**
 * The published versions, from cache unless stale or asked for explicitly.
 *
 * A failure is cached too. A machine that is offline would otherwise pay the
 * full npm timeout on every poll, and re-asking does not make the network come
 * back. `fresh` is the escape hatch -- which is what the "check again" button
 * sends.
 *
 * @param {import('./config.mjs').PanelConfig} config
 * @param {{fresh?: boolean}} [opts]
 */
export async function publishedVersions(config, opts = {}) {
  const fresh = opts.fresh === true;
  if (!fresh && releaseCache.value && Date.now() - releaseCache.at < RELEASE_TTL_MS) {
    return releaseCache.value;
  }
  try {
    const value = await fetchPublishedVersions(config, opts);
    releaseCache.at = Date.now();
    releaseCache.value = { ...value, error: null, checkedAt: new Date().toISOString() };
  } catch (err) {
    releaseCache.at = Date.now();
    releaseCache.value = {
      distTags: {},
      versions: [],
      time: {},
      registry: null,
      packageName: config.dshPackage,
      error: err instanceof HttpError ? err.message : String(err?.message ?? err),
      checkedAt: new Date().toISOString(),
    };
    log(`WARN version check failed: ${releaseCache.value.error}`);
  }
  return releaseCache.value;
}

// ---------------------------------------------------------------------------
// The state the UI renders
// ---------------------------------------------------------------------------

/**
 * Compose everything the version card needs.
 *
 * @param {import('./config.mjs').PanelConfig} config
 * @param {{fresh?: boolean, release?: boolean, dshWebStartedAt?: string|null,
 *          dshExecutable?: any, readInstalled?: typeof readInstalledVersion}} [opts]
 */
export async function buildVersionState(config, opts = {}) {
  const installed = await installedVersion(config, opts);
  // Only an explicit `release: true` crosses the network. `/api/state` is
  // polled by every open panel, and turning that poll into an `npm view` would
  // make the whole UI wait on a registry round trip.
  const release = opts.release === true
    ? await publishedVersions(config, opts)
    : releaseCache.value;

  const installedVersionString = installed.version;
  const channels = Object.entries(release?.distTags ?? {})
    .filter(([, version]) => typeof version === 'string' && parseSemver(version))
    .map(([name, version]) => ({
      name,
      version,
      publishedAt: release?.time?.[version] ?? null,
      current: version === installedVersionString,
      newer: isNewer(version, installedVersionString),
      cmp: compareSemver(version, installedVersionString),
    }))
    // Newest first, so the top row is the version a user most likely wants.
    .sort((a, b) => -(compareSemver(a.version, b.version) ?? 0));

  const winner = channels.find((c) => c.newer) ?? null;

  return {
    packageName: release?.packageName ?? config.dshPackage,
    installed: installedVersionString,
    // Which of the two readers answered. The UI has to say this: a version that
    // came from the manifest on disk is weaker evidence than one the command
    // itself printed, and the card names which it is.
    installedSource: installed.source,
    installedError: installed.error,
    installedCommand: installed.command,
    packagePath: installed.packagePath,
    channels,
    updateAvailable: Boolean(winner),
    newest: winner ? { version: winner.version, channel: winner.name } : null,
    registry: release?.registry ?? null,
    checkedAt: release?.checkedAt ?? null,
    checkError: release?.error ?? null,
    canCheck: resolveExecutable('npm') !== null,
    lastUpdateAt,
    // Only an install that happened *after* the service booted is waiting to be
    // applied: the running process keeps the code it started with. An update
    // installed before the boot is already live, so claiming otherwise would
    // send the user to restart a service that is perfectly current.
    restartRequired: needsRestart(lastUpdateAt, opts.dshWebStartedAt),
  };
}

/**
 * Is the running service older than the last install?
 *
 * Unparseable timestamps answer `false`: "I could not tell" must not turn into
 * a prompt to restart the service that is hosting the panel.
 */
export function needsRestart(updatedAt, dshWebStartedAt) {
  if (!updatedAt || !dshWebStartedAt) return false;
  const updated = new Date(updatedAt).getTime();
  const booted = new Date(dshWebStartedAt).getTime();
  if (!Number.isFinite(updated) || !Number.isFinite(booted)) return false;
  return updated > booted;
}

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

/**
 * A global install must never be driven by an arbitrary string.
 *
 * This route is reachable by any web page the user has open (it is plain
 * localhost HTTP), so the target is not interpolated into a command line until
 * it is known to be either a channel we just fetched from the registry or a
 * version that appears in that registry's own version list.
 *
 * @param {{distTags: Record<string,string>, versions: string[]}} release
 * @param {string} requested
 * @returns {string} The concrete version to install.
 */
export function resolveUpdateTarget(release, requested) {
  const raw = String(requested ?? '').trim();
  if (!raw) throw new HttpError(400, 'a version or channel name is required');

  if (Object.hasOwn(release.distTags ?? {}, raw)) {
    const version = release.distTags[raw];
    if (!parseSemver(version)) {
      throw new HttpError(502, `channel ${raw} points at ${JSON.stringify(version)}, which is not a version`);
    }
    return version;
  }

  const bare = raw.startsWith('v') ? raw.slice(1) : raw;
  if (!parseSemver(bare)) {
    throw new HttpError(400, `${JSON.stringify(raw)} is not a version or a known channel`);
  }
  // Membership, not just shape: this is what keeps the route from becoming
  // "install any spec off the registry".
  if (!(release.versions ?? []).includes(bare)) {
    throw new HttpError(400, `${bare} is not a published version of the package`);
  }
  return bare;
}

/** Guards against two installs racing in the same process. */
let updateInFlight = null;

export function isUpdateInFlight() {
  return updateInFlight !== null;
}

/**
 * Install a published version globally, then check what actually happened.
 *
 * @param {import('./config.mjs').PanelConfig} config
 * @param {string} requested A channel name or an exact published version.
 * @param {{fresh?: boolean, dshWebStartedAt?: string|null, npmPath?: string|null,
 *          run?: typeof runCapture, timeoutMs?: number, readInstalled?: typeof readInstalledVersion}} [opts]
 */
export async function updateDsh(config, requested, opts = {}) {
  if (updateInFlight) {
    throw new HttpError(409, 'another update is already running');
  }
  updateInFlight = requested;
  try {
    const npmPath = opts.npmPath !== undefined ? opts.npmPath : resolveExecutable('npm');
    if (!npmPath) {
      throw new HttpError(501, 'npm was not found on PATH, so the panel cannot install a different DSH');
    }

    // Never install a version the registry has not confirmed: `resolveUpdateTarget`
    // is the security boundary described above.
    const release = await publishedVersions(config, { fresh: true, npmPath });
    if (release.error) throw new HttpError(502, release.error);

    const target = resolveUpdateTarget(release, requested);
    const before = (await installedVersion(config, { fresh: true })).version;

    const spec = launchSpec(npmPath);
    // `--no-fund --no-audit` keep a global install from spending a second
    // network round trip on output that cannot apply to it: there is no project
    // lockfile here for an audit to describe.
    const args = [...spec.prefixArgs, 'install', '-g', `${config.dshPackage}@${target}`, '--no-fund', '--no-audit'];
    const shown = `npm install -g ${config.dshPackage}@${target}`;
    log(`version: ${shown} (via ${npmPath})`);

    const run = opts.run ?? runCapture;
    const res = await run(spec.command, args, { timeoutMs: opts.timeoutMs ?? UPDATE_TIMEOUT_MS });

    const stdout = String(res.stdout ?? '').trim().slice(-TAIL_CHARS);
    const stderr = String(res.stderr ?? '').trim().slice(-TAIL_CHARS);

    if (res.spawnError) {
      throw new HttpError(500, `could not run npm: ${res.spawnError}`);
    }
    if (res.timedOut) {
      throw new HttpError(504, `${shown} timed out after ${Math.round((opts.timeoutMs ?? UPDATE_TIMEOUT_MS) / 1000)}s; the installation may be incomplete`);
    }
    if (res.code !== 0) {
      throw new HttpError(500, `${shown} failed (exit ${res.code})${stderr ? `: ${stderr.split('\n').slice(-3).join(' ')}` : ''}`);
    }

    // Everything cached describes the pre-install world, including the path to
    // the executable itself. Drop it all, then observe.
    invalidateVersionCache();
    const after = await installedVersion(config, { fresh: true });
    const changed = before !== after.version;

    // Recorded even when the number did not move: npm did rewrite the install
    // tree, and the running service is still holding the code it booted with.
    lastUpdateAt = new Date().toISOString();

    return {
      changed,
      target,
      before,
      after: after.version,
      // True only when the number moved. npm exiting 0 proves npm ran, nothing
      // more: a second installation earlier on PATH would swallow the update.
      reachedTarget: after.version === target,
      command: shown,
      registry: release.registry ?? null,
      stdout,
      stderr,
      restartRequired: needsRestart(lastUpdateAt, opts.dshWebStartedAt),
    };
  } finally {
    updateInFlight = null;
  }
}
