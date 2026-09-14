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

describe('HTTP layer', () => {
  /** @type {ReturnType<typeof makeSandbox>} */
  let sb;
  let base;
  let bound;

  before(async () => {
    sb = makeSandbox();
    const config = resolveConfig(sb.env);
    writeSkill(sb.pool, 'alpha', { description: 'Alpha does a thing.' });
    writeSkill(sb.pool, 'gamma', { description: 'Gamma does a thing.' });
    fs.mkdirSync(path.dirname(sb.patchFile), { recursive: true });
    fs.writeFileSync(sb.patchFile, `# keep me\n${MANUAL_BLOCK}`, 'utf8');

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

  it('only opens named locations', async () => {
    const bad = await post('/api/open', { target: '/etc/passwd' });
    assert.equal(bad.status, 400);

    const good = await post('/api/open', { target: 'dshHome' });
    assert.equal(good.status, 200);
    assert.equal(good.body.path, sb.dshHome);
  });

  it('has no route for unknown paths', async () => {
    const r = await post('/api/nope', {});
    assert.equal(r.status, 404);
  });
});
