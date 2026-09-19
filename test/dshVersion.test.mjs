/**
 * DSH version management.
 *
 * Two layers, deliberately:
 *
 *   - The pure parts (semver ordering, channel bookkeeping, the update-target
 *     allow-list) are asserted directly, because they are where an off-by-one
 *     comparison would silently tell a user "up to date" forever.
 *   - Everything that shells out is driven against *real* stand-in `npm` and
 *     `dsh` executables on `PATH`, written per platform the way the CLI's shims
 *     really are. A mocked `spawn` cannot prove the program executed, and a
 *     test that reaches the real registry would be asserting something about
 *     the machine it happens to run on.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../src/core/config.mjs';
import { clearExecutableCache } from '../src/core/dsh.mjs';
import {
  buildVersionState,
  compareSemver,
  fetchPublishedVersions,
  findPackageManifest,
  invalidateVersionCache,
  isNewer,
  isUpdateInFlight,
  needsRestart,
  parseSemver,
  parseVersionOutput,
  readInstalledVersion,
  registryOrigin,
  resolveUpdateTarget,
  updateDsh,
} from '../src/core/dshVersion.mjs';
import { HttpError } from '../src/core/errors.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = '@deepseek-ai/dsh';

/**
 * A real executable stand-in for a CLI, in the shape the platform actually uses.
 *
 * On Windows that is an npm-style `.cmd` shim whose last two quoted tokens are
 * the interpreter and the script -- the same shape `unwrapNpmShim` parses -- so
 * these tests exercise the unwrapping path rather than bypassing it. On POSIX it
 * is a shebang script.
 *
 * @param {string} name
 * @param {string} body JavaScript to run.
 * @returns {{dir: string, script: string, restore: () => void}}
 */
function fakeExecutable(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dshcp-fake-${name}-`));
  const script = path.join(dir, `${name}-impl.mjs`);
  fs.writeFileSync(script, body, 'utf8');

  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(dir, `${name}.cmd`),
      `@ECHO off\r\n"${process.execPath}" "${script}" %*\r\n`,
      'utf8',
    );
  } else {
    const sh = path.join(dir, name);
    fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, 'utf8');
    fs.chmodSync(sh, 0o755);
  }
  return { dir, script };
}

/** A packument shaped the way `npm view <pkg> --json` prints one. */
function packument({ latest = '0.1.5-rc.2', alpha = '0.1.6-alpha.2', tarballHost = 'https://registry.example.test' } = {}) {
  const versions = ['0.1.5-rc.2', '0.1.6-alpha.2'];
  return {
    name: PKG,
    'dist-tags': { latest, alpha, next: latest },
    versions,
    time: {
      created: '2026-08-13T12:35:18.048Z',
      '0.1.5-rc.2': '2026-09-10T14:57:10.790Z',
      '0.1.6-alpha.2': '2026-09-17T13:52:10.201Z',
    },
    // The field the panel reads for "which registry answered".
    dist: { tarball: `${tarballHost}/${PKG}/-/dsh-0.1.6-alpha.2.tgz` },
  };
}

/**
 * Install stand-in `npm` and `dsh` on PATH for one test.
 *
 * `versionFile` is the single source of truth for "what is installed": the fake
 * `dsh` prints it and the fake `npm` rewrites it on install, which is what makes
 * the after-the-fact version check observable instead of assumed.
 *
 * @param {{packument?: object, installExits?: number, viewExits?: number, rewriteVersion?: boolean}} [opts]
 */
function withFakeTools(opts = {}) {
  const calls = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dshcp-tools-')), 'calls.jsonl');
  const versionFile = path.join(path.dirname(calls), 'installed.txt');
  fs.writeFileSync(versionFile, '0.1.5-rc.2\n', 'utf8');

  const doc = JSON.stringify(opts.packument ?? packument());

  const dsh = fakeExecutable('dsh', `
import fs from 'node:fs';
const file = process.env.DSHCP_TEST_VERSION_FILE;
if (process.argv.includes('--version')) {
  process.stdout.write(fs.readFileSync(file, 'utf8').trim() + '\\n');
  process.exit(0);
}
process.exit(1);
`);

  const npm = fakeExecutable('npm', `
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DSHCP_TEST_CALLS, JSON.stringify(args) + '\\n');
if (args.includes('view')) {
  if (${opts.viewExits ?? 0} !== 0) { process.stderr.write('npm error network boom\\n'); process.exit(${opts.viewExits ?? 0}); }
  process.stdout.write(${JSON.stringify(doc)});
  process.exit(0);
}
if (args.includes('install')) {
  if (${opts.installExits ?? 0} !== 0) { process.stderr.write('npm error install boom\\n'); process.exit(${opts.installExits ?? 0}); }
  const spec = args.find((a) => a.startsWith(${JSON.stringify(PKG + '@')}));
  if (spec && ${opts.rewriteVersion === false ? 'false' : 'true'}) {
    fs.writeFileSync(process.env.DSHCP_TEST_VERSION_FILE, spec.slice(${PKG.length + 1}) + '\\n');
  }
  process.stdout.write('added 1 package\\n');
  process.exit(0);
}
process.exit(1);
`);

  const before = {
    PATH: process.env.PATH,
    versionFile: process.env.DSHCP_TEST_VERSION_FILE,
    calls: process.env.DSHCP_TEST_CALLS,
  };
  process.env.PATH = [dsh.dir, npm.dir, before.PATH ?? ''].join(path.delimiter);
  process.env.DSHCP_TEST_VERSION_FILE = versionFile;
  process.env.DSHCP_TEST_CALLS = calls;
  clearExecutableCache();
  invalidateVersionCache();

  return {
    versionFile,
    calls,
    // Absent means npm was never run, which several tests assert directly --
    // so this must answer "no calls" rather than throwing ENOENT.
    argv: () => (fs.existsSync(calls)
      ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : []),
    setInstalled: (v) => fs.writeFileSync(versionFile, `${v}\n`, 'utf8'),
    config: (env = {}) => resolveConfig({ ...sandboxEnv(), DSH_PANEL_DSH_PACKAGE: PKG, ...env }),
    restore: () => {
      process.env.PATH = before.PATH;
      if (before.versionFile === undefined) delete process.env.DSHCP_TEST_VERSION_FILE;
      else process.env.DSHCP_TEST_VERSION_FILE = before.versionFile;
      if (before.calls === undefined) delete process.env.DSHCP_TEST_CALLS;
      else process.env.DSHCP_TEST_CALLS = before.calls;
      clearExecutableCache();
      invalidateVersionCache();
      fs.rmSync(path.dirname(calls), { recursive: true, force: true });
      fs.rmSync(dsh.dir, { recursive: true, force: true });
      fs.rmSync(npm.dir, { recursive: true, force: true });
    },
  };
}

function sandboxEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshcp-ver-'));
  return {
    DSH_PANEL_HOME: path.join(root, 'home'),
    DSH_HOME: path.join(root, '.dsh'),
    DSH_PANEL_CC_SWITCH: '0',
  };
}

describe('semver ordering', () => {
  it('parses the shapes npm actually publishes', () => {
    assert.deepEqual(parseSemver('0.1.5-rc.2'), {
      major: 0, minor: 1, patch: 5, prerelease: ['rc', '2'], raw: '0.1.5-rc.2',
    });
    assert.deepEqual(parseSemver('v1.2.3').prerelease, []);
    assert.equal(parseSemver('1.2.3+build.5').prerelease.length, 0);
    assert.equal(parseSemver('not-a-version'), null);
    assert.equal(parseSemver('1.2'), null);
    assert.equal(parseSemver(''), null);
  });

  it('orders a release above its own prereleases', () => {
    assert.equal(compareSemver('1.0.0', '1.0.0-rc.1'), 1);
    assert.equal(compareSemver('1.0.0-rc.1', '1.0.0'), -1);
    assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  });

  it('compares prerelease identifiers by the spec, not as strings', () => {
    // The case this whole function exists for: DSH ships both of these, and a
    // string compare ranks "0.1.5-rc.2" above "0.1.6-alpha.2" because "r" > "a".
    assert.equal(compareSemver('0.1.6-alpha.2', '0.1.5-rc.2'), 1);
    assert.equal(isNewer('0.1.6-alpha.2', '0.1.5-rc.2'), true);

    assert.equal(compareSemver('1.0.0-alpha', '1.0.0-beta'), -1);
    assert.equal(compareSemver('1.0.0-alpha.2', '1.0.0-alpha.10'), -1);
    assert.equal(compareSemver('1.0.0-2', '1.0.0-10'), -1);
    // Numeric identifiers rank below alphanumeric ones.
    assert.equal(compareSemver('1.0.0-1', '1.0.0-alpha'), -1);
    // A shorter identifier list is lower when every preceding one matched.
    assert.equal(compareSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  });

  it('refuses to order what it cannot parse', () => {
    assert.equal(compareSemver('banana', '1.0.0'), null);
    assert.equal(compareSemver('1.0.0', 'banana'), null);
    // "I could not compare these" must never masquerade as "you are current".
    assert.equal(isNewer('banana', '1.0.0'), false);
    assert.equal(isNewer('1.0.0', 'banana'), false);
  });
});

describe('version output and manifests', () => {
  it('reads a version out of whatever dsh printed', () => {
    assert.equal(parseVersionOutput('0.1.5-rc.2\n'), '0.1.5-rc.2');
    assert.equal(parseVersionOutput('  v0.1.5-rc.2  '), '0.1.5-rc.2');
    assert.equal(parseVersionOutput('garbage'), null);
  });

  it('walks up to the manifest rather than guessing one', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshcp-manifest-'));
    const pkgDir = path.join(root, 'node_modules', PKG);
    fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: PKG, version: '9.9.9' }), 'utf8');

    assert.deepEqual(findPackageManifest(path.join(pkgDir, 'lib'), PKG), { version: '9.9.9', dir: pkgDir });
    // A mismatch is not silently accepted: the wrong package's version is worse
    // than no version.
    assert.equal(findPackageManifest(path.join(pkgDir, 'lib'), '@other/pkg'), null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports a missing dsh as an error instead of an empty success', async () => {
    const read = await readInstalledVersion({
      dshExecutable: { path: null, name: 'dsh', source: 'default' },
    });
    assert.equal(read.version, null);
    assert.equal(read.source, 'missing');
    assert.match(read.error, /not found on PATH/);
  });

  it('falls back to the manifest and says so when the command is broken', async () => {
    /*
     * A shim can outlive the installation it points at. The version on disk is
     * still a real answer, but it is weaker evidence than `dsh --version`
     * printing it -- so `source` has to distinguish the two. The renderer reads
     * this field to decide which sentence to show, and reporting "read from
     * dsh --version" here would misreport exactly when the command is broken.
     */
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshcp-broken-'));
    const pkgDir = path.join(root, 'node_modules', PKG);
    fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: PKG, version: '9.9.9' }), 'utf8');
    // Exits non-zero: the install is there, the command is not runnable.
    const bin = path.join(pkgDir, 'lib', 'bin.js');
    fs.writeFileSync(bin, 'process.exit(3);\n', 'utf8');

    let shim;
    if (process.platform === 'win32') {
      shim = path.join(root, 'dsh.cmd');
      fs.writeFileSync(shim, `@ECHO off\r\n"${process.execPath}" "${bin}" %*\r\n`, 'utf8');
    } else {
      shim = path.join(root, 'dsh');
      fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${bin}" "$@"\n`, 'utf8');
      fs.chmodSync(shim, 0o755);
    }

    const read = await readInstalledVersion({
      dshExecutable: { path: shim, name: 'dsh', source: 'default' },
    });
    assert.equal(read.version, '9.9.9');
    assert.equal(read.source, 'package.json');
    assert.equal(read.packagePath, pkgDir);
    assert.match(read.error, /could not read dsh --version/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('registry client', () => {
  /** @type {ReturnType<typeof withFakeTools>} */
  let tools;
  afterEach(() => tools?.restore());

  it('runs the real npm and parses its JSON', async () => {
    tools = withFakeTools();
    const info = await fetchPublishedVersions(tools.config());
    assert.equal(info.packageName, PKG);
    assert.deepEqual(info.distTags, { latest: '0.1.5-rc.2', alpha: '0.1.6-alpha.2', next: '0.1.5-rc.2' });
    assert.deepEqual(info.versions, ['0.1.5-rc.2', '0.1.6-alpha.2']);
    // The registry is read from dist.tarball, which follows whoever answered.
    assert.equal(info.registry, 'https://registry.example.test');
  });

  it('surfaces an npm failure with the registry\'s own words', async () => {
    tools = withFakeTools({ viewExits: 1 });
    await assert.rejects(
      () => fetchPublishedVersions(tools.config()),
      (err) => err instanceof HttpError && err.status === 502 && /network boom/.test(err.message),
    );
  });

  it('says npm is missing rather than reporting no versions exist', async () => {
    // An empty PATH is the honest way to test this: no `npm` anywhere.
    const before = process.env.PATH;
    process.env.PATH = '';
    clearExecutableCache();
    try {
      await assert.rejects(
        () => fetchPublishedVersions({ dshPackage: PKG }),
        (err) => err instanceof HttpError && err.status === 501 && /not found on PATH/.test(err.message),
      );
    } finally {
      process.env.PATH = before;
      clearExecutableCache();
    }
  });

  it('derives the registry origin from a tarball URL', () => {
    assert.equal(registryOrigin('https://registry.npmjs.org/a/-/a-1.tgz'), 'https://registry.npmjs.org');
    assert.equal(registryOrigin('/home/runner/work/a.tgz'), null);
    assert.equal(registryOrigin(null), null);
  });

  it('tracks the official package unless a fork overrides it', () => {
    assert.equal(resolveConfig(sandboxEnv()).dshPackage, PKG);
    assert.equal(resolveConfig({ ...sandboxEnv(), DSH_PANEL_DSH_PACKAGE: '@corp/dsh' }).dshPackage, '@corp/dsh');
  });
});

describe('update target allow-list', () => {
  const release = { distTags: { latest: '0.1.5-rc.2', alpha: '0.1.6-alpha.2' }, versions: ['0.1.5-rc.2', '0.1.6-alpha.2'] };

  it('resolves a channel name to its version', () => {
    assert.equal(resolveUpdateTarget(release, 'alpha'), '0.1.6-alpha.2');
    assert.equal(resolveUpdateTarget(release, 'latest'), '0.1.5-rc.2');
  });

  it('accepts a published version, with or without a v prefix', () => {
    assert.equal(resolveUpdateTarget(release, '0.1.6-alpha.2'), '0.1.6-alpha.2');
    assert.equal(resolveUpdateTarget(release, 'v0.1.5-rc.2'), '0.1.5-rc.2');
  });

  it('refuses anything the registry did not publish', () => {
    // This is the security boundary: the route is plain localhost HTTP that any
    // open web page can POST to, so a target must never reach a command line
    // just because it looks like a version.
    for (const bad of ['9.9.9', 'latest; rm -rf /', '../../etc', 'file:/tmp/x.tgz', 'github:evil/repo', '']) {
      assert.throws(() => resolveUpdateTarget(release, bad), (err) => err instanceof HttpError && err.status === 400,
        `expected ${JSON.stringify(bad)} to be refused`);
    }
  });
});

describe('version state', () => {
  /** @type {ReturnType<typeof withFakeTools>} */
  let tools;
  afterEach(() => tools?.restore());

  it('reports an available update from the installed side of the comparison', async () => {
    tools = withFakeTools();
    const st = await buildVersionState(tools.config(), { fresh: true, release: true });
    assert.equal(st.installed, '0.1.5-rc.2');
    assert.equal(st.installedSource, 'dsh --version');
    assert.equal(st.updateAvailable, true);
    assert.deepEqual(st.newest, { version: '0.1.6-alpha.2', channel: 'alpha' });
    // Newest first, so the top row is the one a user most likely wants.
    assert.deepEqual(st.channels.map((c) => c.name), ['alpha', 'latest', 'next']);
    assert.equal(st.channels.find((c) => c.name === 'latest').current, true);
    assert.equal(st.registry, 'https://registry.example.test');
  });

  it('does not claim an update when the installed version is the newest', async () => {
    tools = withFakeTools();
    tools.setInstalled('0.1.6-alpha.2');
    const st = await buildVersionState(tools.config(), { fresh: true, release: true });
    assert.equal(st.updateAvailable, false);
    assert.equal(st.newest, null);
    assert.equal(st.installCommand, null);
  });

  it('never touches the network unless asked', async () => {
    tools = withFakeTools();
    // No `release: true` -- exactly what /api/state does on every poll.
    const st = await buildVersionState(tools.config(), { fresh: true });
    assert.equal(st.checkedAt, null);
    assert.equal(st.channels.length, 0);
    assert.equal(tools.argv().filter((a) => a.includes('view')).length, 0);
    // The installed version is still real, which is the point: the cheap local
    // half of the card never waits on a registry.
    assert.equal(st.installed, '0.1.5-rc.2');
  });

  it('caches a registry failure instead of retrying on every poll', async () => {
    tools = withFakeTools({ viewExits: 1 });
    const first = await buildVersionState(tools.config(), { fresh: true, release: true });
    assert.match(first.checkError, /network boom/);
    // Second call without `fresh`: the cached failure is reused, so a machine
    // that is offline does not pay the full npm timeout on every request.
    tools.setInstalled('0.1.5-rc.2');
    const second = await buildVersionState(tools.config(), {});
    assert.match(second.checkError, /network boom/);
    assert.equal(tools.argv().filter((a) => a.includes('view')).length, 1);
  });
});

describe('installing a version', () => {
  /** @type {ReturnType<typeof withFakeTools>} */
  let tools;
  afterEach(() => tools?.restore());

  it('installs, then reports the version it observed afterwards', async () => {
    tools = withFakeTools();
    const res = await updateDsh(tools.config(), 'alpha', { dshWebStartedAt: '2020-01-01T00:00:00.000Z' });

    assert.equal(res.before, '0.1.5-rc.2');
    assert.equal(res.target, '0.1.6-alpha.2');
    assert.equal(res.after, '0.1.6-alpha.2');
    assert.equal(res.changed, true);
    assert.equal(res.reachedTarget, true);

    const install = tools.argv().find((a) => a.includes('install'));
    assert.deepEqual(install, ['install', '-g', `${PKG}@0.1.6-alpha.2`, '--no-fund', '--no-audit']);
    // The service booted long before the install, so the new files are not live.
    assert.equal(res.restartRequired, true);
  });

  it('does not claim success when the version did not actually move', async () => {
    // npm exits 0 but the `dsh` on PATH is a different installation: this is the
    // exact scenario where trusting the exit code would lie to the user.
    tools = withFakeTools({ rewriteVersion: false });
    const res = await updateDsh(tools.config(), 'alpha', { dshWebStartedAt: null });
    assert.equal(res.changed, false);
    assert.equal(res.reachedTarget, false);
    assert.equal(res.after, '0.1.5-rc.2');
    assert.equal(res.restartRequired, false);
  });

  it('refuses an unpublished version before running npm at all', async () => {
    tools = withFakeTools();
    await assert.rejects(
      () => updateDsh(tools.config(), '9.9.9', {}),
      (err) => err instanceof HttpError && err.status === 400,
    );
    assert.equal(tools.argv().filter((a) => a.includes('install')).length, 0);
  });

  it('reports a failing install as a failure, with npm\'s tail', async () => {
    tools = withFakeTools({ installExits: 1 });
    await assert.rejects(
      () => updateDsh(tools.config(), 'alpha', {}),
      (err) => err instanceof HttpError && err.status === 500 && /install boom/.test(err.message),
    );
    assert.equal(isUpdateInFlight(), false);
  });

  it('leaves the in-flight guard clear after a failure', async () => {
    tools = withFakeTools({ installExits: 1 });
    await updateDsh(tools.config(), 'alpha', {}).catch(() => {});
    assert.equal(isUpdateInFlight(), false);
  });
});

describe('restart bookkeeping', () => {
  it('asks for a restart only when the install landed after the service booted', () => {
    const install = '2026-09-19T10:00:00.000Z';
    assert.equal(needsRestart(install, '2026-09-19T09:00:00.000Z'), true);
    assert.equal(needsRestart(install, '2026-09-19T11:00:00.000Z'), false);
    // Unknown must not turn into a prompt to restart the service hosting the UI.
    assert.equal(needsRestart(install, null), false);
    assert.equal(needsRestart(null, install), false);
    assert.equal(needsRestart(install, 'not a date'), false);
  });
});

describe('version routes over HTTP', () => {
  /** @type {ReturnType<typeof withFakeTools>} */
  let tools;
  let bound;
  afterEach(async () => {
    await bound?.close();
    tools?.restore();
  });

  async function serve() {
    const { createPanelServer, listen } = await import('../src/core/server.mjs');
    const config = tools.config();
    const { server } = createPanelServer(config, {
      publicDir: path.join(ROOT, 'public'),
      version: 'test',
      // A running service booted long ago, so an install is genuinely pending.
      dshControl: {
        status: () => ({
          running: true, pid: 4242, cmdline: 'dsh web', startedAt: '2020-01-01T00:00:00.000Z',
          uptimeMs: 1000, cpuMs: 1, rssBytes: 1, probeMs: 1, probed: true,
        }),
        start: async () => ({}), stop: async () => ({}), restart: async () => ({}),
      },
    });
    bound = await listen(server, { host: '127.0.0.1', port: 0 });
    return bound.url;
  }

  it('answers the release probe with channels and an install command', async () => {
    tools = withFakeTools();
    const base = await serve();
    const res = await fetch(`${base}/api/dsh/release?fresh=1`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.dshVersion.installed, '0.1.5-rc.2');
    assert.equal(body.dshVersion.updateAvailable, true);
    assert.equal(body.dshVersion.installCommand, `npm install -g ${PKG}@0.1.6-alpha.2`);
  });

  it('installs through the route and reports the pending restart', async () => {
    tools = withFakeTools();
    const base = await serve();
    const res = await fetch(`${base}/api/dsh/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 'alpha' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.before, '0.1.5-rc.2');
    assert.equal(body.after, '0.1.6-alpha.2');
    assert.equal(body.reachedTarget, true);
    assert.equal(body.restartRequired, true);
    // The state that comes back is re-read, not echoed: the card repaints from
    // the observation in the same response.
    assert.equal(body.dshVersion.installed, '0.1.6-alpha.2');
    assert.equal(body.dshVersion.restartRequired, true);
  });

  it('refuses an unpublished version with 400, not a 500 from npm', async () => {
    tools = withFakeTools();
    const base = await serve();
    const res = await fetch(`${base}/api/dsh/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '9.9.9' }),
    });
    assert.equal(res.status, 400);
    assert.equal(tools.argv().filter((a) => a.includes('install')).length, 0);
  });
});
