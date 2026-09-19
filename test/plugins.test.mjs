/**
 * Plugin inventory + uninstall.
 *
 * Two rules are pinned here because both are easy to break silently:
 *
 *   1. Only a *dependency* of a profile can be removed. The in-box layers
 *      (`@deepseek-ai/dsh-base`, `dsh-web-app`) are entries in
 *      `dsh.profile.bundles` that no dependency backs, and they must never
 *      become removable -- however the route is called.
 *   2. "Uninstalled" is claimed only when the dependency is actually gone
 *      afterwards. A pnpm run that exits 0 without changing anything is a
 *      failure this tool has to report, not a success.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { resolveConfig } from '../src/core/config.mjs';
import { clearExecutableCache } from '../src/core/dsh.mjs';
import {
  assertSafePackageName,
  buildPluginState,
  pluginCommandSpec,
  removePlugin,
  resolveDshLauncher,
} from '../src/core/plugins.mjs';
import { makeSandbox } from './helpers.mjs';

/**
 * A stand-in `dsh` CLI. It records the argv it was handed, then does what pnpm
 * plus the launcher's reconcile step would do to the profile manifest in its
 * working directory -- which is what makes it possible to assert on the state
 * *after* the command, not just on the fact that something was spawned.
 *
 * `DSHCP_FAKE_FAIL=<n>` exits n instead; `DSHCP_FAKE_NOOP=1` exits 0 having
 * done nothing (the "pnpm reported success but the plugin is still there" case).
 */
const FAKE_DSH_SOURCE = [
  "import fs from 'node:fs';",
  "fs.appendFileSync(process.env.DSHCP_FAKE_MARKER, process.argv.slice(2).join(' ') + '\\n');",
  'if (process.env.DSHCP_FAKE_FAIL) process.exit(Number(process.env.DSHCP_FAKE_FAIL));',
  'if (process.env.DSHCP_FAKE_NOOP) process.exit(0);',
  "const file = 'package.json';",
  "const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));",
  'const name = process.argv[process.argv.length - 1];',
  'if (manifest.dependencies) delete manifest.dependencies[name];',
  'const bundles = manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles;',
  'if (Array.isArray(bundles)) manifest.dsh.profile.bundles = bundles.filter((b) => b !== name);',
  "fs.writeFileSync(file, JSON.stringify(manifest, null, 2));",
  '',
].join('\n');

/** Put a fake `dsh` first on PATH for the duration of one test. */
function withFakeDshOnPath({ marker, winCmd } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshcp-plugin-path-'));
  const script = path.join(dir, 'fake-dsh.mjs');
  fs.writeFileSync(script, winCmd ?? FAKE_DSH_SOURCE, 'utf8');

  let bin;
  if (process.platform === 'win32') {
    // The npm shim shape, which is what `unwrapNpmShim` is built to read.
    bin = path.join(dir, 'dsh.cmd');
    fs.writeFileSync(
      bin,
      ['@ECHO off', 'SETLOCAL', `"${process.execPath}" "${script}" %*`, ''].join('\r\n'),
      'utf8',
    );
  } else {
    bin = path.join(dir, 'dsh');
    fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, 'utf8');
    fs.chmodSync(bin, 0o755);
  }

  const beforePath = process.env.PATH;
  const beforeMarker = process.env.DSHCP_FAKE_MARKER;
  process.env.PATH = `${dir}${path.delimiter}${beforePath ?? ''}`;
  if (marker) process.env.DSHCP_FAKE_MARKER = marker;
  clearExecutableCache();

  return {
    dir,
    bin,
    restore: () => {
      process.env.PATH = beforePath;
      if (beforeMarker === undefined) delete process.env.DSHCP_FAKE_MARKER;
      else process.env.DSHCP_FAKE_MARKER = beforeMarker;
      if (beforePath !== undefined) clearExecutableCache();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Write one profile manifest plus whatever packages it has on disk. */
function writeProfile(sb, name, manifest, packages = {}) {
  const dir = path.join(sb.dshHome, 'profiles', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');
  for (const [pkg, pkgManifest] of Object.entries(packages)) {
    const pkgDir = path.join(dir, 'node_modules', pkg);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(pkgManifest, null, 2), 'utf8');
  }
  return dir;
}

const WEB_MANIFEST = {
  name: 'dsh-profile-web',
  private: true,
  dependencies: { 'dsh-config-manager': '0.1.59', 'left-pad': '^1.0.0' },
  dsh: {
    profile: {
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-config-manager'],
    },
  },
};

const CONFIG_MANAGER = {
  name: 'dsh-config-manager',
  version: '0.1.59',
  description: 'Backup, restore, export and migrate your DSH configuration.',
  dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
};

describe('plugin inventory', () => {
  let sb;
  let config;

  before(() => {
    sb = makeSandbox();
    // `probeWeb: false` keeps the boot-time probe (a PowerShell round trip on
    // Windows) out of a test that is only about reading manifests.
    config = { ...resolveConfig(sb.env), probeWeb: false };
    writeProfile(sb, 'web', WEB_MANIFEST, { 'dsh-config-manager': CONFIG_MANAGER });
    writeProfile(sb, 'tui', { name: 'dsh-profile-tui', dependencies: {} });
    // A directory with no manifest is not a bootable profile: not listed.
    fs.mkdirSync(path.join(sb.dshHome, 'profiles', 'empty'), { recursive: true });
  });

  after(() => sb.cleanup());

  it('lists every profile that has a manifest', async () => {
    const state = await buildPluginState(config);
    assert.deepEqual(state.profiles.map((p) => p.name), ['tui', 'web']);
    assert.equal(state.profiles.find((p) => p.name === 'web').dependencies, 2);
  });

  it('classifies layers, plain dependencies and missing packages', async () => {
    const { plugins } = await buildPluginState(config);
    const at = (name) => plugins.find((p) => p.profile === 'web' && p.name === name);

    // A dependency that is also a layer: a real, removable plugin.
    const cm = at('dsh-config-manager');
    assert.equal(cm.removable, true);
    assert.equal(cm.layer, true);
    assert.equal(cm.inBox, false);
    assert.equal(cm.installed, true);
    assert.equal(cm.version, '0.1.59');
    assert.equal(cm.isBundle, true);
    assert.equal(cm.hasClient, true);

    // In-box layers come from the profile template, not from dependencies.
    const base = at('@deepseek-ai/dsh-base');
    assert.equal(base.layer, true);
    assert.equal(base.removable, false);
    assert.equal(base.inBox, true);

    // A plain dependency: declared, not a layer, and not on disk here.
    const leftPad = at('left-pad');
    assert.equal(leftPad.removable, true);
    assert.equal(leftPad.layer, false);
    assert.equal(leftPad.installed, false);
    assert.equal(leftPad.version, null);
  });

  it('reports a restart as pending only when a manifest is newer than the service', async () => {
    const booted = await buildPluginState(config, { dshWebStartedAt: new Date(Date.now() + 60000).toISOString() });
    assert.equal(booted.restartPending, false);
    const stale = await buildPluginState(config, { dshWebStartedAt: new Date(Date.now() - 60000).toISOString() });
    assert.equal(stale.restartPending, true);
  });
});

describe('plugin uninstall guards', () => {
  let sb;
  let config;

  before(() => {
    sb = makeSandbox();
    config = { ...resolveConfig(sb.env), probeWeb: false };
    writeProfile(sb, 'web', WEB_MANIFEST, { 'dsh-config-manager': CONFIG_MANAGER });
  });

  after(() => sb.cleanup());

  it('rejects an unknown profile', async () => {
    await assert.rejects(
      () => removePlugin(config, 'nope', 'dsh-config-manager', { launcher: null }),
      (err) => err.status === 404,
    );
  });

  it('refuses to remove an in-box layer', async () => {
    // The security boundary: a package that is not a dependency of the named
    // profile can never be handed to pnpm, whatever the caller asks for.
    for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'not-installed']) {
      await assert.rejects(
        () => removePlugin(config, 'web', name, { launcher: null }),
        (err) => err.status === 400,
        `expected 400 for ${name}`,
      );
    }
  });

  it('refuses unsafe package names', async () => {
    for (const name of ['..', 'a/b', '-rf', '', 'pkg name', 'pkg;rm']) {
      await assert.rejects(
        () => removePlugin(config, 'web', name, { launcher: null }),
        (err) => err.status === 400,
        `expected 400 for ${JSON.stringify(name)}`,
      );
    }
    assert.equal(assertSafePackageName('@scope/pkg'), '@scope/pkg');
  });

  it('says so when dsh cannot be resolved', async () => {
    await assert.rejects(
      () => removePlugin(config, 'web', 'dsh-config-manager', { launcher: null }),
      (err) => err.status === 501,
    );
  });
});

describe('plugin uninstall command', () => {
  it('builds the launcher argv dsh itself documents', () => {
    const spec = pluginCommandSpec('/usr/local/bin/dsh', 'web', 'dsh-config-manager');
    assert.equal(spec.command, '/usr/local/bin/dsh');
    assert.deepEqual(spec.args, ['plugin', '--profile', 'web', 'remove', 'dsh-config-manager']);
  });

  it('prefers a dsh launcher from DSH_WEB_CMD and ignores an unrelated one', () => {
    const before = process.env.DSH_WEB_CMD;
    const fake = withFakeDshOnPath();
    try {
      // A launcher named by DSH_WEB_CMD wins: that is the documented escape
      // hatch for a DSH that is not on PATH at all.
      process.env.DSH_WEB_CMD = `${fake.bin} web`;
      clearExecutableCache();
      assert.deepEqual(resolveDshLauncher(), { path: fake.bin, source: 'DSH_WEB_CMD' });

      // A DSH_WEB_CMD that is not a dsh executable is ignored rather than
      // guessed at -- the PATH lookup decides.
      process.env.DSH_WEB_CMD = 'node /somewhere/cli.mjs web';
      clearExecutableCache();
      assert.equal(resolveDshLauncher().source, 'PATH');
    } finally {
      if (before === undefined) delete process.env.DSH_WEB_CMD;
      else process.env.DSH_WEB_CMD = before;
      clearExecutableCache();
      fake.restore();
    }
  });
});

describe('plugin uninstall, end to end against a stand-in dsh', () => {
  let sb;
  let config;
  let marker;

  before(() => {
    sb = makeSandbox();
    config = { ...resolveConfig(sb.env), probeWeb: false };
    writeProfile(sb, 'web', WEB_MANIFEST, { 'dsh-config-manager': CONFIG_MANAGER });
    marker = path.join(sb.root, 'ran.txt');
  });

  after(() => {
    sb.cleanup();
    delete process.env.DSHCP_FAKE_FAIL;
    delete process.env.DSHCP_FAKE_NOOP;
  });

  it('runs `dsh plugin remove` and reports the plugin gone afterwards', async () => {
    const fake = withFakeDshOnPath({ marker });
    try {
      // The launcher is injected so the test cannot be steered by a DSH_WEB_CMD
      // that happens to be set on the machine running it.
      const launcher = { path: fake.bin, source: 'PATH' };
      const result = await removePlugin(config, 'web', 'dsh-config-manager', { launcher });
      // The program actually executed, and with the documented argument order.
      assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'plugin --profile web remove dsh-config-manager');
      assert.equal(result.changed, true);
      assert.equal(result.profile, 'web');
      assert.equal(result.name, 'dsh-config-manager');

      // The dependency and its layer are both gone from the manifest.
      const manifest = JSON.parse(fs.readFileSync(path.join(sb.dshHome, 'profiles', 'web', 'package.json'), 'utf8'));
      assert.equal(Object.hasOwn(manifest.dependencies, 'dsh-config-manager'), false);
      assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
      assert.equal(result.plugins.some((p) => p.name === 'dsh-config-manager' && p.dependency), false);

      // A sibling dependency the user did not ask about is untouched.
      assert.equal(Object.hasOwn(manifest.dependencies, 'left-pad'), true);
    } finally {
      fake.restore();
    }
  });

  it('reports a non-zero exit instead of claiming success', async () => {
    const fake = withFakeDshOnPath({ marker });
    process.env.DSHCP_FAKE_FAIL = '7';
    try {
      await assert.rejects(
        () => removePlugin(config, 'web', 'left-pad', { launcher: { path: fake.bin, source: 'PATH' } }),
        (err) => err.status === 500 && /exit 7/.test(err.message),
      );
    } finally {
      delete process.env.DSHCP_FAKE_FAIL;
      fake.restore();
    }
  });

  it('does not believe a pnpm run that changed nothing', async () => {
    // The honesty rule: exit 0 is not the answer, the re-read manifest is.
    // `left-pad` is still a dependency here, so this must fail loudly.
    const fake = withFakeDshOnPath({ marker });
    process.env.DSHCP_FAKE_NOOP = '1';
    try {
      await assert.rejects(
        () => removePlugin(config, 'web', 'left-pad', { launcher: { path: fake.bin, source: 'PATH' } }),
        (err) => err.status === 500 && /still a dependency/.test(err.message),
      );
    } finally {
      delete process.env.DSHCP_FAKE_NOOP;
      fake.restore();
    }
  });
});
