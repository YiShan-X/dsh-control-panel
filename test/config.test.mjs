import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { resolveConfig, writableRoots } from '../src/core/config.mjs';

describe('resolveConfig', () => {
  it('derives every managed path from a single home', () => {
    const config = resolveConfig({
      DSH_PANEL_HOME: '/home/u',
      DSH_PANEL_CC_SWITCH: '0',
    });
    assert.equal(config.home, path.resolve('/home/u'));
    assert.equal(config.dshHome, path.resolve('/home/u/.dsh'));
    assert.equal(config.dshSkills, path.resolve('/home/u/.dsh/skills'));
    assert.equal(config.patchFile, path.resolve('/home/u/.dsh/cordis.patch.yml'));
    assert.equal(config.disabledFile, path.resolve('/home/u/.dsh/mcp-manager/disabled.yml'));
    assert.equal(config.ccHome, path.resolve('/home/u/.cc-switch'));
  });

  it('honours DSH_HOME over the default', () => {
    const config = resolveConfig({ DSH_PANEL_HOME: '/home/u', DSH_HOME: '/opt/dsh', DSH_PANEL_CC_SWITCH: '0' });
    assert.equal(config.dshHome, path.resolve('/opt/dsh'));
    assert.equal(config.dshSkills, path.resolve('/opt/dsh/skills'));
  });

  it('defaults to two pools, cc-switch first', () => {
    const config = resolveConfig({ DSH_PANEL_HOME: '/home/u' });
    assert.deepEqual(config.pools.map((p) => p.source), ['cc-switch', 'dsh']);
  });

  it('drops cc-switch entirely when disabled', () => {
    const config = resolveConfig({ DSH_PANEL_HOME: '/home/u', DSH_PANEL_CC_SWITCH: '0' });
    assert.equal(config.ccEnabled, false);
    assert.deepEqual(config.pools.map((p) => p.source), ['dsh']);
  });

  it('accepts an explicit pool list instead of the defaults', () => {
    const config = resolveConfig({
      DSH_PANEL_HOME: '/home/u',
      DSH_SKILL_POOL: ['/a/pool', '/b/pool'].join(path.delimiter),
    });
    assert.deepEqual(config.pools.map((p) => p.dir), [path.resolve('/a/pool'), path.resolve('/b/pool')]);
    assert.deepEqual(config.pools.map((p) => p.source), ['custom', 'custom']);
  });

  it('strips surrounding quotes from an env pool path', () => {
    const config = resolveConfig({
      DSH_PANEL_HOME: '/home/u',
      DSH_SKILL_POOL: '"/a/with space/pool"',
    });
    assert.deepEqual(config.pools.map((p) => p.dir), [path.resolve('/a/with space/pool')]);
  });

  it('de-duplicates a pool listed twice', () => {
    const config = resolveConfig({
      DSH_PANEL_HOME: '/home/u',
      DSH_SKILL_POOL: ['/a/pool', '/a/pool'].join(path.delimiter),
    });
    assert.equal(config.pools.length, 1);
  });

  it('defaults host and port, and accepts overrides', () => {
    const base = resolveConfig({ DSH_PANEL_HOME: '/home/u' });
    assert.equal(base.host, '127.0.0.1');
    assert.equal(base.port, 8791);
    assert.equal(base.openBrowser, true);

    const custom = resolveConfig({
      DSH_PANEL_HOME: '/home/u', DSH_PANEL_PORT: '9001', DSH_PANEL_HOST: '0.0.0.0', DSH_PANEL_OPEN: '0',
    });
    assert.equal(custom.port, 9001);
    assert.equal(custom.host, '0.0.0.0');
    assert.equal(custom.openBrowser, false);
  });

  it('lists the directories it may need to create', () => {
    const config = resolveConfig({ DSH_PANEL_HOME: '/home/u' });
    const roots = writableRoots(config);
    assert.ok(roots.includes(config.dshHome));
    assert.ok(roots.includes(config.dshSkills));
    assert.ok(roots.includes(path.dirname(config.disabledFile)));
  });
});
