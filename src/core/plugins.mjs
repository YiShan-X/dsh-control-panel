/**
 * The plugin model: what each DSH profile has installed, and how to remove one.
 *
 * WHERE PLUGINS ACTUALLY LIVE. A DSH plugin is not a file in `$DSH_HOME`; it is
 * an npm dependency of a *profile* (`$DSH_HOME/profiles/<name>/package.json`),
 * and it only becomes a profile layer when its name is also listed in
 * `dsh.profile.bundles`. Reading those two lists is enough to classify every
 * row, which is why this module needs no DSH import and no pnpm call to render
 * the tab:
 *
 *   in `dependencies` and in `bundles`  -> a third-party plugin (a real layer)
 *   in `bundles` only                   -> an in-box layer from the profile
 *                                          template; never removable from here
 *   in `dependencies` only              -> a plain library, or a plugin whose
 *                                          version dropped its `dsh.bundle`
 *
 * WHY REMOVAL IS DELEGATED TO `dsh plugin`. `dsh plugin --profile <p> remove
 * <name>` forwards to pnpm inside the profile directory and then reconciles
 * `dsh.profile.bundles` against what is actually installed. Hand-editing
 * package.json here would be simpler, and was rejected for a concrete reason:
 * it leaves `pnpm-lock.yaml` describing a dependency the manifest no longer
 * has, and the next `dsh plugin add` (pnpm install) then fails on a lockfile
 * that does not match. So the panel runs the same command the user would type
 * by hand, reports pnpm's own exit code, and re-reads the profile afterwards --
 * "uninstalled" is claimed only when the dependency is actually gone.
 *
 * WHAT IT DOES NOT DO. It never installs, upgrades, enables or disables
 * anything. And because the panel is a localhost HTTP server that any web page
 * can POST to, the route refuses any package that is not already a dependency
 * of the named profile: the worst a hostile page can do is remove a plugin the
 * user installed deliberately, never point `pnpm` at an arbitrary spec.
 *
 * A removed plugin stays loaded until `dsh web` restarts -- the composition is
 * read once at boot -- which is what `restartPending` reports.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './errors.mjs';
import {
  dshWebStartedAt,
  resolveExecutable,
  shellShimSpec,
  tokenizeCmdline,
  unwrapNpmShim,
} from './dsh.mjs';
import { log } from './util.mjs';

/** How long one `dsh plugin remove` may run before it is killed. */
const REMOVE_TIMEOUT_MS = 120000;

/**
 * How much of pnpm's output is kept. A failed install can print hundreds of
 * lines; the tail is the part that says why.
 */
const OUTPUT_CAP = 4000;

/** Read + parse JSON, returning null instead of throwing on anything. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function mtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Every directory under `$DSH_HOME/profiles` that has a readable manifest.
 *
 * A directory without a package.json is not a bootable profile (the launcher
 * would create the manifest on first use), so it is skipped rather than shown
 * as a broken one.
 *
 * @param {import('./config.mjs').PanelConfig} config
 * @returns {{name: string, dir: string, manifest: any}[]}
 */
export function listProfiles(config) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(config.profilesDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const dir = path.join(config.profilesDir, e.name);
    const manifest = readJson(path.join(dir, 'package.json'));
    if (!manifest || typeof manifest !== 'object') continue;
    out.push({ name: e.name, dir, manifest });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Package names may not contain anything that could be read as a flag or a
 * path. This is belt-and-braces: the dependency check below is the real gate,
 * and the command is spawned without a shell.
 *
 * @param {unknown} name
 * @returns {string}
 */
export function assertSafePackageName(name) {
  const s = String(name ?? '');
  // Scoped names keep their single `/`; nothing else about a name is free-form.
  const ok = /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(s)
    && s !== '.'
    && s !== '..'
    && !s.startsWith('-');
  if (!ok) throw new HttpError(400, `unsafe package name ${JSON.stringify(name)}`);
  return s;
}

/**
 * Resolve the `dsh` launcher used for plugin commands.
 *
 * `DSH_WEB_CMD` is the documented escape hatch for a DSH that is not on PATH,
 * so it wins *when its first token is a dsh executable*; a `DSH_WEB_CMD` that
 * points at something else (a wrapper script, `node cli.mjs`) is ignored rather
 * than guessed at, and the plain PATH lookup decides.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{path: string, source: 'DSH_WEB_CMD'|'PATH'}|null}
 */
export function resolveDshLauncher(env = process.env) {
  const first = tokenizeCmdline(String(env.DSH_WEB_CMD ?? ''))[0];
  if (first && /(^|[\\/])dsh(\.(cmd|bat|exe))?$/i.test(first)) {
    const resolved = resolveExecutable(first);
    if (resolved) return { path: resolved, source: 'DSH_WEB_CMD' };
  }
  const resolved = resolveExecutable('dsh');
  return resolved ? { path: resolved, source: 'PATH' } : null;
}

/**
 * The spawn spec for one plugin command.
 *
 * `dsh` is a `.cmd` shim on Windows, which libuv cannot start; the shim's own
 * `node` + script is preferred over `cmd /c` for the same reason the start path
 * prefers it (a `cmd /c` child gets a visible console window).
 *
 * @param {string} launcher Resolved path to the dsh launcher.
 * @param {string} profile
 * @param {string} name
 * @returns {{command: string, args: string[], wrapped: boolean}}
 */
export function pluginCommandSpec(launcher, profile, name) {
  // `dsh plugin` forwards everything after `--profile <name>` to pnpm in the
  // profile directory, then reconciles `dsh.profile.bundles` itself.
  const args = ['plugin', '--profile', profile, 'remove', name];
  const unwrapped = unwrapNpmShim(launcher);
  return unwrapped
    ? { command: unwrapped.command, args: [...unwrapped.prefixArgs, ...args], wrapped: false }
    : shellShimSpec(launcher, args);
}

/**
 * Run one command to completion, capturing a bounded tail of its output.
 *
 * Never throws for a non-zero exit: the caller decides what an exit code means
 * and how to report it. It does reject when the process could not be started at
 * all, because that is a different fact from "pnpm said no".
 *
 * @param {{command: string, args: string[], wrapped: boolean}} spec
 * @param {string} cwd
 * @param {{timeoutMs?: number, spawn?: typeof spawn}} [opts] Test seams.
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, timedOut: boolean}>}
 */
export function runPluginCommand(spec, cwd, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : REMOVE_TIMEOUT_MS;
  const spawnFn = opts.spawn ?? spawn;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(spec.command, spec.args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new HttpError(500, `could not run ${spec.command}: ${err.message}`));
      return;
    }

    let settled = false;
    let stdout = '';
    let stderr = '';
    const keep = (prev, chunk) => (prev + chunk.toString()).slice(-OUTPUT_CAP);

    child.stdout?.on('data', (c) => { stdout = keep(stdout, c); });
    child.stderr?.on('data', (c) => { stderr = keep(stderr, c); });
    // A pipe can close under us when the child exits immediately.
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});

    const timer = setTimeout(() => {
      if (settled) return;
      try { child.kill(); } catch { /* already gone */ }
      settled = true;
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new HttpError(500, `could not run ${spec.command}: ${err.message}`));
    });

    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
  });
}

/** One-line description of what a package's manifest says it is. */
function describePackage(installed, dependencySpec) {
  const description = String(installed?.description ?? '').split('\n')[0].trim();
  return {
    version: installed?.version ?? null,
    // Installed-but-unreadable is its own state: the dependency exists, the
    // package directory does not (a broken or half-removed install).
    installed: Boolean(installed),
    spec: dependencySpec ?? null,
    isBundle: Boolean(installed?.dsh?.bundle?.patch),
    hasClient: Boolean(installed?.dsh?.client),
    description: description.length > 200 ? `${description.slice(0, 197)}...` : description,
  };
}

/**
 * Build the complete plugin view.
 *
 * @param {import('./config.mjs').PanelConfig} config
 * @param {{dshWebStartedAt?: string|null}} [opts] The caller may pass the boot
 *   time it already measured, so rendering this tab costs no extra probe.
 */
export async function buildPluginState(config, opts = {}) {
  const profiles = listProfiles(config);
  const plugins = [];
  let manifestMtimeMs = null;

  for (const profile of profiles) {
    const dependencies = profile.manifest.dependencies ?? {};
    const depNames = Object.keys(dependencies);
    const bundles = Array.isArray(profile.manifest.dsh?.profile?.bundles)
      ? profile.manifest.dsh.profile.bundles.map(String)
      : [];
    // `bundles` alone would hide a plugin that is still installed but no longer
    // a layer; `dependencies` alone would hide the in-box layers, which are the
    // rows the user needs in order to see why the removable list is short.
    const names = [...new Set([...bundles, ...depNames])].sort();

    const mtime = mtimeMs(path.join(profile.dir, 'package.json'));
    if (mtime != null) manifestMtimeMs = Math.max(manifestMtimeMs ?? 0, mtime);

    for (const name of names) {
      const isDependency = Object.hasOwn(dependencies, name);
      const installed = readJson(path.join(profile.dir, 'node_modules', name, 'package.json'));
      const info = describePackage(installed, dependencies[name]);
      plugins.push({
        key: `${profile.name}:${name}`,
        profile: profile.name,
        profileDir: profile.dir,
        name,
        ...info,
        layer: bundles.includes(name),
        dependency: isDependency,
        // In-box layers come from the profile template and are not
        // dependencies, which is exactly what makes them non-removable.
        inBox: !isDependency,
        removable: isDependency,
      });
    }
  }

  const startedAt = opts.dshWebStartedAt !== undefined
    ? opts.dshWebStartedAt
    : (config.probeWeb === false ? null : dshWebStartedAt());
  const manifestMtime = manifestMtimeMs == null ? null : new Date(manifestMtimeMs).toISOString();

  return {
    profiles: profiles.map((p) => {
      const deps = Object.keys(p.manifest.dependencies ?? {}).length;
      return {
        name: p.name,
        dir: p.dir,
        dependencies: deps,
        layers: Array.isArray(p.manifest.dsh?.profile?.bundles)
          ? p.manifest.dsh.profile.bundles.length
          : 0,
      };
    }),
    plugins,
    manifestMtime,
    dshWebStartedAt: startedAt,
    // A plugin change rewrites the profile manifest, so "manifest newer than the
    // running service" is the same honest test the MCP banner uses.
    restartPending: Boolean(manifestMtime && startedAt && new Date(manifestMtime) > new Date(startedAt)),
  };
}

/**
 * Uninstall one plugin from one profile.
 *
 * Order of the guards matters: the profile and the package are both validated
 * against what is on disk *before* anything is spawned, so an HTTP caller can
 * only ever name a plugin that is already installed in a profile that exists.
 *
 * @param {import('./config.mjs').PanelConfig} config
 * @param {string} profileName
 * @param {string} packageName
 * @param {{launcher?: {path: string, source: string}|null, timeoutMs?: number, spawn?: typeof spawn}} [opts]
 */
export async function removePlugin(config, profileName, packageName, opts = {}) {
  const profiles = listProfiles(config);
  const profile = profiles.find((p) => p.name === profileName);
  if (!profile) {
    throw new HttpError(
      404,
      `no DSH profile named ${JSON.stringify(profileName)} under ${config.profilesDir}`,
    );
  }

  const name = assertSafePackageName(packageName);
  const dependencies = profile.manifest.dependencies ?? {};
  if (!Object.hasOwn(dependencies, name)) {
    throw new HttpError(
      400,
      `${name} is not a dependency of profile ${profileName}; only installed plugins can be removed from here`,
    );
  }

  const launcher = opts.launcher !== undefined ? opts.launcher : resolveDshLauncher();
  if (!launcher) {
    throw new HttpError(
      501,
      'dsh was not found on PATH, so the panel cannot run "dsh plugin remove". Install it, or set DSH_WEB_CMD to the launcher.',
    );
  }

  const spec = pluginCommandSpec(launcher.path, profile.name, name);
  const shown = ['dsh', ...spec.args.slice(1)].join(' ');
  log(`plugin: ${shown} (cwd ${profile.dir})`);

  const result = await runPluginCommand(spec, profile.dir, opts);
  const tail = (result.stderr || result.stdout || '').trim().slice(-600);
  if (result.timedOut) {
    throw new HttpError(500, `dsh plugin remove ${name} timed out after ${Math.round((opts.timeoutMs ?? REMOVE_TIMEOUT_MS) / 1000)}s`);
  }
  if (result.code !== 0) {
    throw new HttpError(
      500,
      `dsh plugin remove ${name} failed (exit ${result.code})${tail ? `: ${tail}` : ''}`,
    );
  }

  // Re-read instead of trusting the exit code: the report is what is true now,
  // and a "successful" pnpm run that left the dependency in place is a failure
  // this tool must not paper over.
  const after = await buildPluginState(config, opts);
  const stillThere = after.plugins.some(
    (p) => p.profile === profile.name && p.name === name && p.dependency,
  );
  if (stillThere) {
    throw new HttpError(500, `${name} is still a dependency of profile ${profile.name} after pnpm reported success`);
  }

  return {
    changed: true,
    profile: profile.name,
    name,
    command: shown,
    launcher: launcher.source,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    plugins: after.plugins,
    pluginProfiles: after.profiles,
    pluginsMeta: {
      manifestMtime: after.manifestMtime,
      dshWebStartedAt: after.dshWebStartedAt,
      restartPending: after.restartPending,
    },
  };
}
