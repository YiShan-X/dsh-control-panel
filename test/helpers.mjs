/**
 * Shared fixtures for the test suite.
 *
 * Every test gets its own throwaway "user profile" in the OS temp directory, so
 * nothing here can touch a real DSH install.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshcp-test-'));
  const home = path.join(root, 'home');
  const pool = path.join(root, 'pool');
  const dshHome = path.join(home, '.dsh');

  fs.mkdirSync(pool, { recursive: true });
  fs.mkdirSync(dshHome, { recursive: true });

  const env = {
    DSH_PANEL_HOME: home,
    DSH_HOME: dshHome,
    DSH_SKILL_POOL: pool,
    DSH_PANEL_CC_SWITCH: '0',
    DSH_PANEL_PORT: '0',
  };

  return {
    root,
    home,
    pool,
    dshHome,
    env,
    dshSkills: path.join(dshHome, 'skills'),
    patchFile: path.join(dshHome, 'cordis.patch.yml'),
    disabledFile: path.join(dshHome, 'mcp-manager', 'disabled.yml'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** Drop a well-formed skill into a pool directory. */
export function writeSkill(poolDir, dirName, { name = dirName, description = 'A test skill.' } = {}) {
  const dir = path.join(poolDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    'utf8',
  );
  return dir;
}

/** Drop a SKILL.md whose frontmatter DSH would reject. */
export function writeBrokenSkill(poolDir, dirName, content) {
  const dir = path.join(poolDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
  return dir;
}
