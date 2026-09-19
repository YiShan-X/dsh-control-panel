import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../src/core/config.mjs';
import { createPanelServer, listen } from '../src/core/server.mjs';
import { parseBlocks } from '../src/core/patch.mjs';
import { makeSandbox, writeSkill } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MANUAL_BLOCK = [
  '# BEGIN MCP: handrolled',
  '# written by hand, so it must survive a round trip byte for byte',
  '- insert:',
  '    - id: mcp-handrolled',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        serverName: handrolled',
  '        transport: stdio',
  '        command: node',
  '        args:',
  '          - ./server.js',
  '        env: {}',
  '        failOnStartupError: false',
  '        toolCallTimeoutMs: 60000',
  '# END MCP: handrolled',
  '',
].join('\n');

/**
 * A fake `dsh web` process table plus a fake control bundle, so the DSH routes
 * can be exercised without touching the test runner's own machine state. The
 * server only ever sees the four functions.
 */
function makeFakeControl() {
  const calls = [];
  let status = {
    running: true,
    pid: 4242,
    cmdline: '"C:\\node.exe" dsh web',
    startedAt: '2026-09-14T10:00:00.000Z',
    uptimeMs: 60000,
    cpuMs: 1200,
    rssBytes: 64 * 1024 * 1024,
    probeMs: 7,
    probed: true,
  };
  return {
    calls,
    setStatus(next) { status = { ...status, ...next }; },
    bundle: {
      status: (opts) => {
        calls.push({ kind: 'status', fresh: Boolean(opts?.fresh) });
        return status;
      },
      start: async () => {
        calls.push({ kind: 'start' });
        status = { ...status, running: true, pid: 5001 };
        return { changed: true, newPid: 5001, alive: true, livePid: 5001 };
      },
      stop: async () => {
        calls.push({ kind: 'stop' });
        status = { ...status, running: false, pid: null, startedAt: null, uptimeMs: null };
        return { changed: true, killedPid: 4242, forced: false };
      },
      restart: async () => {
        calls.push({ kind: 'restart' });
        status = { ...status, running: true, pid: 6001, startedAt: '2026-09-14T11:00:00.000Z' };
        return { changed: true, killedPid: 4242, newPid: 6001, alive: true, livePid: 6001 };
      },
    },
  };
}

describe('HTTP layer', () => {
  /** @type {ReturnType<typeof makeSandbox>} */
  let sb;
  let base;
  let bound;
  let fake;

  before(async () => {
    sb = makeSandbox();
    const config = resolveConfig(sb.env);
    writeSkill(sb.pool, 'alpha', { description: 'Alpha does a thing.' });
    writeSkill(sb.pool, 'gamma', { description: 'Gamma does a thing.' });
    fs.mkdirSync(path.dirname(sb.patchFile), { recursive: true });
    fs.writeFileSync(sb.patchFile, `# keep me\n${MANUAL_BLOCK}`, 'utf8');

    // One profile with one installed plugin and one in-box layer. The plugin
    // rows are read from files, so no `dsh` has to exist for these assertions.
    const profileDir = path.join(sb.dshHome, 'profiles', 'web');
    fs.mkdirSync(path.join(profileDir, 'node_modules', 'fake-plugin'), { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: { 'fake-plugin': '1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'fake-plugin'] } },
    }, null, 2), 'utf8');
    fs.writeFileSync(
      path.join(profileDir, 'node_modules', 'fake-plugin', 'package.json'),
      JSON.stringify({ name: 'fake-plugin', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
      'utf8',
    );

    fake = makeFakeControl();
    const { server } = createPanelServer(config, {
      publicDir: path.join(ROOT, 'public'),
      version: 'test',
      openPath: async () => null,
      dshControl: fake.bundle,
    });
    bound = await listen(server, { host: '127.0.0.1', port: 0 });
    base = bound.url;
  });

  after(async () => {
    await bound?.close();
    sb.cleanup();
  });

  const get = async (p) => {
    const res = await fetch(base + p);
    return { status: res.status, body: await res.json() };
  };
  const post = async (p, body) => {
    const res = await fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  it('answers the health probe', async () => {
    const r = await get('/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });

  it('answers the favicon probe without an error', async () => {
    // A 404 here logs a console error and would trip the desktop smoke test's
    // "no renderer errors" assertion for an unrelated reason.
    const res = await fetch(`${base}/favicon.ico`);
    assert.equal(res.status, 204);
  });

  it('serves the UI at /', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
  });

  it('refuses path traversal out of public/', async () => {
    // Percent-encoded so the URL parser does not normalise it away before it
    // reaches the handler.
    const res = await fetch(`${base}/..%2fpackage.json`);
    assert.notEqual(res.status, 200);
    assert.equal(res.status, 403);
  });

  it('reports the full state shape', async () => {
    const { status, body } = await get('/api/state');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.skills));
    assert.ok(Array.isArray(body.mcp));
    assert.equal(body.paths.dshSkills, path.join(sb.dshHome, 'skills'));
    assert.equal(body.ccSwitch.available, false);
    assert.equal(body.version, 'test');
  });

  it('toggles a skill on and off through the API', async () => {
    const on = await post('/api/skills/toggle', { key: 'alpha', enabled: true });
    assert.equal(on.status, 200);
    assert.equal(on.body.changed, true);

    let state = (await get('/api/state')).body;
    assert.equal(state.skills.find((s) => s.key === 'alpha').enabled, true);

    const off = await post('/api/skills/toggle', { key: 'alpha', enabled: false });
    assert.equal(off.status, 200);

    state = (await get('/api/state')).body;
    assert.equal(state.skills.find((s) => s.key === 'alpha').enabled, false);
    assert.equal(fs.existsSync(path.join(sb.pool, 'alpha', 'SKILL.md')), true);
  });

  it('rejects traversal-shaped keys', async () => {
    for (const key of ['../../evil', 'a/b', '..', '', 'a\\b']) {
      const r = await post('/api/skills/toggle', { key, enabled: true });
      assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(key)}`);
    }
  });

  it('bulk-enables and bulk-disables by item list', async () => {
    const on = await post('/api/skills/bulk', {
      items: [{ key: 'alpha', poolDir: sb.pool }, { key: 'gamma', poolDir: sb.pool }],
      enabled: true,
    });
    assert.equal(on.status, 200);
    assert.equal(on.body.failed, 0);
    assert.equal(on.body.changed, 2);

    const off = await post('/api/skills/bulk', {
      items: [{ key: 'alpha' }, { key: 'gamma' }],
      enabled: false,
    });
    assert.equal(off.body.changed, 2);
  });

  it('parks a hand-written MCP block and restores it verbatim', async () => {
    const before = fs.readFileSync(sb.patchFile, 'utf8');
    assert.equal(parseBlocks(before).has('handrolled'), true);

    const off = await post('/api/mcp/toggle', { key: 'handrolled', enabled: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.changed, true);

    const parkedPatch = fs.readFileSync(sb.patchFile, 'utf8');
    assert.equal(parseBlocks(parkedPatch).has('handrolled'), false);
    // The patch must still be a valid top-level array, never comments-only.
    assert.match(parkedPatch, /^\[\]$/m);
    assert.equal(parseBlocks(fs.readFileSync(sb.disabledFile, 'utf8')).has('handrolled'), true);

    const on = await post('/api/mcp/toggle', { key: 'handrolled', enabled: true });
    assert.equal(on.body.restored, true);

    const restored = fs.readFileSync(sb.patchFile, 'utf8');
    // Byte-for-byte, including the hand-written comment: this is the rule that
    // stops the tool from silently rewriting a config someone tuned by hand.
    assert.equal(parseBlocks(restored).get('handrolled'), MANUAL_BLOCK);
  });

  it('cannot generate an MCP block without a config hub', async () => {
    const r = await post('/api/mcp/toggle', { key: 'nowhere', enabled: true });
    assert.equal(r.status, 404);
  });

  it('lists plugins per profile without spawning anything', async () => {
    const state = (await get('/api/state')).body;
    assert.equal(state.paths.profilesDir, path.join(sb.dshHome, 'profiles'));
    assert.equal(state.pluginProfiles.length, 1);

    const plugin = state.plugins.find((p) => p.name === 'fake-plugin');
    assert.equal(plugin.profile, 'web');
    assert.equal(plugin.version, '1.0.0');
    assert.equal(plugin.removable, true);
    assert.equal(plugin.layer, true);

    const inBox = state.plugins.find((p) => p.name === '@deepseek-ai/dsh-base');
    assert.equal(inBox.removable, false);
    assert.equal(inBox.inBox, true);
  });

  it('refuses to uninstall anything that is not a plugin of that profile', async () => {
    // Every one of these is rejected before a process is ever spawned, which is
    // what keeps this route from becoming "run pnpm on an arbitrary spec".
    const notADependency = await post('/api/plugins/remove', {
      profile: 'web',
      name: '@deepseek-ai/dsh-base',
    });
    assert.equal(notADependency.status, 400);

    const unsafe = await post('/api/plugins/remove', { profile: 'web', name: '../../evil' });
    assert.equal(unsafe.status, 400);

    const noProfile = await post('/api/plugins/remove', { profile: 'nope', name: 'fake-plugin' });
    assert.equal(noProfile.status, 404);
  });

  it('opens only profile directories that exist', async () => {
    const good = await post('/api/open', { target: 'profile:web' });
    assert.equal(good.status, 200);
    assert.equal(good.body.path, path.join(sb.dshHome, 'profiles', 'web'));

    const bad = await post('/api/open', { target: 'profile:..\\..' });
    assert.equal(bad.status, 400);
  });

  it('only opens named locations', async () => {
    const bad = await post('/api/open', { target: '/etc/passwd' });
    assert.equal(bad.status, 400);

    const good = await post('/api/open', { target: 'dshHome' });
    assert.equal(good.status, 200);
    assert.equal(good.body.path, sb.dshHome);
  });

  it('reports the DSH status through /api/state', async () => {
    const state = (await get('/api/state')).body;
    assert.equal(state.dsh.running, true);
    assert.equal(state.dsh.pid, 4242);
    assert.equal(state.dsh.canStart, true);
    assert.equal(state.dsh.canStop, true);
    assert.equal(state.dsh.canRestart, true);
    assert.equal(state.dsh.probed, true);
    assert.equal(state.dsh.uptimeMs, 60000);
    assert.equal(state.dsh.startCommand, 'dsh web');
    assert.equal(state.dsh.startCommandSource, 'default');
  });

  it('reuses one probe for both the DSH tab and the MCP restart banner', async () => {
    const seen = fake.calls.length;
    const state = (await get('/api/state')).body;
    const statusCalls = fake.calls.slice(seen).filter((c) => c.kind === 'status');
    assert.equal(statusCalls.length, 1, 'expected exactly one status probe per request');
    // The banner compares the patch mtime with the boot time the DSH tab shows.
    assert.equal(state.mcpMeta.dshWebStartedAt, state.dsh.startedAt);
  });

  it('forces a re-probe only when asked', async () => {
    const cached = fake.calls.length;
    await get('/api/state');
    assert.equal(fake.calls.slice(cached).at(-1).fresh, false);

    const forced = fake.calls.length;
    await get('/api/state?fresh=1');
    assert.equal(fake.calls.slice(forced).at(-1).fresh, true);
  });

  it('exposes the process probe on its own route', async () => {
    const r = await get('/api/dsh/status');
    assert.equal(r.status, 200);
    assert.equal(r.body.running, true);
    assert.equal(r.body.pid, 4242);
    assert.equal(r.body.canControl, true);
  });

  it('starts, stops and restarts through the API', async () => {
    const stopped = await post('/api/dsh/stop', {});
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.killedPid, 4242);
    assert.equal((await get('/api/dsh/status')).body.running, false);

    const started = await post('/api/dsh/start', {});
    assert.equal(started.status, 200);
    assert.equal(started.body.alive, true);
    assert.equal((await get('/api/dsh/status')).body.pid, 5001);

    const restarted = await post('/api/dsh/restart', {});
    assert.equal(restarted.status, 200);
    assert.equal(restarted.body.newPid, 6001);
    assert.equal((await get('/api/dsh/status')).body.pid, 6001);
  });

  it('has no route for unknown paths', async () => {
    const r = await post('/api/nope', {});
    assert.equal(r.status, 404);
  });
});

describe('HTTP layer without process control', () => {
  /** @type {ReturnType<typeof makeSandbox>} */
  let sb;
  let base;
  let bound;

  before(async () => {
    sb = makeSandbox();
    const config = resolveConfig(sb.env);
    const { server } = createPanelServer(config, {
      publicDir: path.join(ROOT, 'public'),
      version: 'test',
      openPath: async () => null,
    });
    bound = await listen(server, { host: '127.0.0.1', port: 0 });
    base = bound.url;
  });

  after(async () => {
    await bound?.close();
    sb.cleanup();
  });

  it('says so instead of offering a button that would fail', async () => {
    const res = await fetch(`${base}/api/state`);
    const state = await res.json();
    assert.equal(state.dsh.canStart, false);
    assert.equal(state.dsh.canStop, false);
    assert.equal(state.dsh.canRestart, false);
    assert.equal(state.mcpMeta.canRestart, false);
  });

  it('answers 501 for every DSH action', async () => {
    for (const action of ['start', 'stop', 'restart']) {
      const res = await fetch(`${base}/api/dsh/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(res.status, 501, `expected 501 for ${action}`);
    }
    const banner = await fetch(`${base}/api/restart`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(banner.status, 501);
  });
});
