#!/usr/bin/env node
/**
 * Regenerate the documentation screenshots.
 *
 * Runs the real desktop app against a throwaway sandbox profile filled with
 * invented skills and MCP servers, so the images can never leak a real user's
 * skill names, descriptions or repository URLs -- and can never drift away from
 * what the UI actually renders.
 *
 *   node scripts/screenshot.mjs [docs/screenshot.png]
 *
 * One set is produced per supported language; the Chinese set is written into
 * a `zh/` sibling directory and is used by README.zh-CN.md.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { electronBinary } from './electron-binary.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.resolve(ROOT, process.argv[2] || 'docs/screenshot.png');
/** @type {Array<{lang: string, file: string}>} */
const RUNS = [
  { lang: 'en', file: TARGET },
  { lang: 'zh-CN', file: path.join(path.dirname(TARGET), 'zh', path.basename(TARGET)) },
];

const DEMO_SKILLS = [
  ['git-hygiene', 'Commit message rules, rebase recovery and branch cleanup recipes.'],
  ['sql-explain', 'Read a query plan and suggest the index that is actually missing.'],
  ['pdf-tables', 'Pull tables and metadata out of PDFs without losing the column layout.'],
  ['release-notes', 'Turn a raw git log into release notes a human would want to read.'],
  ['log-triage', 'Group noisy log lines into ranked incident candidates.'],
  ['api-contract', 'Diff two OpenAPI documents and report breaking changes only.'],
];

const ENABLED = new Set(['git-hygiene', 'sql-explain', 'release-notes']);

const STDIO_BLOCK = (key, args) => [
  `# BEGIN MCP: ${key}`,
  `# generated from the configuration hub`,
  '- insert:',
  `    - id: mcp-${key}`,
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  `        serverName: ${key}`,
  '        transport: stdio',
  '        command: cmd',
  '        args:',
  ...args.map((a) => `          - ${a}`),
  '        env: {}',
  '        failOnStartupError: false',
  '        toolCallTimeoutMs: 60000',
  `# END MCP: ${key}`,
  '',
].join('\n');

const HTTP_BLOCK = (key, url) => [
  `# BEGIN MCP: ${key}`,
  '- insert:',
  `    - id: mcp-${key}`,
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  `        serverName: ${key}`,
  '        transport: streamable-http',
  `        url: ${url}`,
  '        failOnStartupError: false',
  '        toolCallTimeoutMs: 60000',
  `# END MCP: ${key}`,
  '',
].join('\n');

function buildSandbox(lang, target) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshcp-shot-'));
  const home = path.join(root, 'home');
  const pool = path.join(root, 'pool');
  const dshHome = path.join(home, '.dsh');
  const dshSkills = path.join(dshHome, 'skills');

  fs.mkdirSync(pool, { recursive: true });
  fs.mkdirSync(dshSkills, { recursive: true });

  for (const [name, description] of DEMO_SKILLS) {
    const dir = path.join(pool, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
      'utf8',
    );
    if (ENABLED.has(name)) {
      fs.symlinkSync(dir, path.join(dshSkills, name), process.platform === 'win32' ? 'junction' : 'dir');
    }
  }

  // One skill DSH would silently drop, so the warning banner is visible.
  const broken = path.join(pool, 'windows-vision-rpa');
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(
    path.join(broken, 'SKILL.md'),
    '# windows-vision-rpa (v0.3.0)\n\nNo YAML frontmatter, so the provider discards this.\n',
    'utf8',
  );

  // And one the user wrote by hand, which the tool must never delete.
  const mine = path.join(dshSkills, 'my-notes');
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, 'SKILL.md'), '---\nname: my-notes\ndescription: Personal notes.\n---\n', 'utf8');

  fs.writeFileSync(
    path.join(dshHome, 'cordis.patch.yml'),
    [
      '# DSH composition patch -- do not hand-edit unless you mean it.',
      '',
      STDIO_BLOCK('github', ['/c', 'npx', '-y', '@modelcontextprotocol/server-github']),
      '',
      HTTP_BLOCK('gitee', 'https://mcp.gitee.com/sse'),
      '',
    ].join('\n'),
    'utf8',
  );

  fs.mkdirSync(path.join(dshHome, 'mcp-manager'), { recursive: true });
  fs.writeFileSync(
    path.join(dshHome, 'mcp-manager', 'disabled.yml'),
    [
      STDIO_BLOCK('playwright', ['/c', 'npx', '-y', '@playwright/mcp@latest']),
      '',
      STDIO_BLOCK('context7', ['/c', 'npx', '-y', '@upstash/context7-mcp']),
      '',
    ].join('\n'),
    'utf8',
  );

  return {
    root,
    env: {
      ...process.env,
      DSH_PANEL_HOME: home,
      DSH_HOME: dshHome,
      DSH_SKILL_POOL: pool,
      DSH_PANEL_CC_SWITCH: '0',
      // Documentation images must not depend on whether this machine happens to
      // be running `dsh web` right now.
      DSH_PANEL_PROBE_WEB: '0',
      DSH_PANEL_SMOKE: '1',
      DSH_PANEL_SMOKE_LANG: lang,
      DSH_PANEL_SMOKE_CAPTURE: target,
    },
  };
}

const ELECTRON_BIN = await electronBinary();

/** Run one capture set, resolving when Electron exits. */
function captureOnce({ lang, file }) {
  return new Promise((resolve) => {
    const sandbox = buildSandbox(lang, file);
    const child = spawn(ELECTRON_BIN, ['.'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: sandbox.env,
    });
    const done = (code, message) => {
      fs.rmSync(sandbox.root, { recursive: true, force: true });
      if (message) process.stderr.write(message);
      resolve(code ?? 1);
    };
    child.on('exit', (code) => done(code));
    child.on('error', (err) => done(1, `could not start Electron: ${err.message}\n`));
  });
}

async function main() {
  // Sequential: the desktop app takes a single-instance lock, so two runs at
  // once would just make the second one focus the first one's window.
  for (const run of RUNS) {
    process.stdout.write(`\n=== ${run.lang} -> ${path.relative(ROOT, run.file)} ===\n`);
    const code = await captureOnce(run);
    if (code !== 0) process.exit(code);
  }
}

main();
