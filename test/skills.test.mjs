import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { resolveConfig } from '../src/core/config.mjs';
import {
  buildSkillState,
  disableSkill,
  enableSkill,
  resolvePoolPath,
} from '../src/core/skills.mjs';
import { linkStat } from '../src/core/util.mjs';
import { makeSandbox, writeBrokenSkill, writeSkill } from './helpers.mjs';

describe('skill model', () => {
  /** @type {ReturnType<typeof makeSandbox>} */
  let sb;
  /** @type {ReturnType<typeof resolveConfig>} */
  let config;

  before(() => {
    sb = makeSandbox();
    config = resolveConfig(sb.env);
    writeSkill(sb.pool, 'alpha', { description: 'Alpha does a thing.' });
    writeSkill(sb.pool, 'beta', { description: 'Beta does another thing.' });
  });

  after(() => sb.cleanup());

  it('lists pool skills as available but not enabled', async () => {
    const state = await buildSkillState(config);
    const alpha = state.skills.find((s) => s.key === 'alpha');
    assert.equal(alpha.enabled, false);
    assert.equal(alpha.installed, true);
    assert.equal(alpha.valid, true);
    assert.equal(alpha.canEnable, true);
    assert.equal(alpha.canDisable, false);
    assert.equal(alpha.source, 'custom');
    assert.equal(alpha.poolDir, sb.pool);
    assert.ok(alpha.tokens > 0);
  });

  it('enables a skill by creating a link into the DSH skill root', async () => {
    const result = enableSkill(config, 'alpha', sb.pool);
    assert.equal(result.changed, true);

    const linkPath = path.join(config.dshSkills, 'alpha');
    const st = linkStat(linkPath);
    assert.equal(st.isLink, true);
    assert.equal(fs.existsSync(linkPath), true);

    // The point of the link is that DSH reads the pool file through it.
    const md = fs.readFileSync(path.join(linkPath, 'SKILL.md'), 'utf8');
    assert.match(md, /name: alpha/);

    const state = await buildSkillState(config);
    const alpha = state.skills.find((s) => s.key === 'alpha');
    assert.equal(alpha.enabled, true);
    assert.equal(alpha.canDisable, true);
    assert.equal(alpha.canEnable, false);
    assert.equal(state.summary.enabled, 1);
  });

  it('is idempotent when the skill is already on', () => {
    const again = enableSkill(config, 'alpha', sb.pool);
    assert.equal(again.changed, false);
    assert.match(again.note, /already linked/);
  });

  it('disables a skill by removing only the link', () => {
    const result = disableSkill(config, 'alpha');
    assert.equal(result.changed, true);
    assert.equal(result.targetIntact, true);

    assert.equal(fs.existsSync(path.join(config.dshSkills, 'alpha')), false);
    // The source of truth is untouched -- that is the whole safety contract.
    assert.equal(fs.existsSync(path.join(sb.pool, 'alpha', 'SKILL.md')), true);
  });

  it('never deletes a real directory in the skill root', () => {
    const realDir = path.join(config.dshSkills, 'hand-written');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 'notes.txt'), 'mine', 'utf8');

    const st = linkStat(realDir);
    assert.equal(st.isLink, false);
    assert.throws(() => disableSkill(config, 'hand-written'), /real directory/);
    assert.equal(fs.existsSync(path.join(realDir, 'notes.txt')), true);

    fs.rmSync(realDir, { recursive: true, force: true });
  });

  it('reports a real directory as enabled but not removable', async () => {
    const realDir = path.join(config.dshSkills, 'hand-written');
    fs.mkdirSync(realDir, { recursive: true });
    const state = await buildSkillState(config);
    const entry = state.skills.find((s) => s.key === 'hand-written');
    assert.equal(entry.isRealDir, true);
    assert.equal(entry.enabled, true);
    assert.equal(entry.canDisable, false);
    assert.equal(entry.source, 'dsh-local');
    fs.rmSync(realDir, { recursive: true, force: true });
  });

  it('refuses to enable a skill whose name DSH would reject', () => {
    writeBrokenSkill(
      sb.pool,
      'bad_name',
      '---\nname: bad_name\ndescription: underscores are not kebab-case\n---\n',
    );
    assert.throws(() => enableSkill(config, 'bad_name', sb.pool), /kebab-case/);
    assert.equal(fs.existsSync(path.join(config.dshSkills, 'bad_name')), false);
  });

  it('refuses to enable a directory with no SKILL.md', () => {
    fs.mkdirSync(path.join(sb.pool, 'empty-dir'), { recursive: true });
    assert.throws(() => enableSkill(config, 'empty-dir', sb.pool), /no SKILL\.md/);
  });

  it('flags skills that DSH would silently drop', async () => {
    const state = await buildSkillState(config);
    const bad = state.skills.find((s) => s.key === 'bad_name');
    assert.equal(bad.valid, false);
    assert.equal(bad.installed, true);
    assert.equal(bad.canEnable, false);
    assert.match(bad.reason, /kebab-case/);
    assert.ok(state.summary.invalid >= 1);
  });

  it('validates a caller-supplied pool directory against the configured pools', () => {
    assert.throws(
      () => resolvePoolPath(config, 'alpha', path.join(sb.root, 'not-a-pool')),
      /not one of the configured pools/,
    );
  });

  it('finds a skill in whichever pool holds it', () => {
    const resolved = resolvePoolPath(config, 'beta');
    assert.equal(resolved, path.join(sb.pool, 'beta'));
  });

  it('marks a broken link instead of pretending it works', async () => {
    // Build a link to a real directory, then delete the directory underneath it.
    const target = path.join(sb.root, 'temporary-target');
    fs.mkdirSync(target, { recursive: true });
    const linkPath = path.join(config.dshSkills, 'dangling');
    fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    fs.rmSync(target, { recursive: true, force: true });

    const state = await buildSkillState(config);
    const entry = state.skills.find((s) => s.key === 'dangling');
    assert.equal(entry.brokenLink, true);
    assert.equal(entry.installed, false);
    // A link is still a link: removing it is safe even when its target is gone.
    const result = disableSkill(config, 'dangling');
    assert.equal(result.changed, true);
  });
});
