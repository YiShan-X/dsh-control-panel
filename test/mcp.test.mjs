import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ccToDshConfig, renderMcpBlock, sanitizeServerName } from '../src/core/mcp.mjs';
import { parseBlocks } from '../src/core/patch.mjs';

describe('sanitizeServerName', () => {
  it('replaces characters DSH rejects', () => {
    assert.equal(sanitizeServerName('Anything Analyzer'), 'Anything-Analyzer');
    assert.equal(sanitizeServerName('a/b:c'), 'a-b-c');
  });

  it('trims leading and trailing separators', () => {
    assert.equal(sanitizeServerName('  --weird--  '), 'weird');
  });

  it('falls back to a usable name instead of an empty one', () => {
    assert.equal(sanitizeServerName('!!!'), 'mcp');
    assert.equal(sanitizeServerName(''), 'mcp');
    assert.equal(sanitizeServerName(undefined), 'mcp');
  });

  it('caps the name at the 32 characters DSH allows', () => {
    assert.equal(sanitizeServerName('x'.repeat(80)).length, 32);
  });
});

describe('ccToDshConfig', () => {
  it('converts a stdio server unchanged on non-Windows', () => {
    const { config, warnings } = ccToDshConfig('thing', {
      command: 'node', args: ['server.js'], env: { A: '1' },
    }, { platform: 'linux' });
    assert.equal(config.transport, 'stdio');
    assert.equal(config.command, 'node');
    assert.deepEqual(config.args, ['server.js']);
    assert.deepEqual(config.env, { A: '1' });
    assert.deepEqual(warnings, []);
  });

  it('wraps an npx shim through cmd /c on Windows', () => {
    // libuv cannot spawn a .cmd shim directly; this wrapper is the whole reason
    // the generated gitee/github entries say `command: cmd`.
    const { config, warnings } = ccToDshConfig('gh', {
      command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'],
    }, { platform: 'win32' });
    assert.equal(config.command, 'cmd');
    assert.deepEqual(config.args, ['/c', 'npx', '-y', '@modelcontextprotocol/server-github']);
    assert.match(warnings.join(' '), /cmd \/c/);
  });

  it('does not double-wrap an entry that already uses cmd /c', () => {
    const { config } = ccToDshConfig('gh', {
      command: 'cmd', args: ['/c', 'npx', '-y', 'thing'],
    }, { platform: 'win32' });
    assert.equal(config.command, 'cmd');
    assert.deepEqual(config.args, ['/c', 'npx', '-y', 'thing']);
  });

  it('flags a cmd command that is missing its /c flag', () => {
    const { warnings } = ccToDshConfig('gh', { command: 'cmd', args: ['npx'] }, { platform: 'win32' });
    assert.match(warnings.join(' '), /no \/c flag/);
  });

  it('leaves npx alone on non-Windows platforms', () => {
    const { config } = ccToDshConfig('gh', { command: 'npx', args: ['-y', 'thing'] }, { platform: 'darwin' });
    assert.equal(config.command, 'npx');
  });

  it('maps http and sse transports onto streamable-http', () => {
    const http = ccToDshConfig('remote', { type: 'http', url: 'https://x/mcp', headers: { A: 'b' } });
    assert.equal(http.config.transport, 'streamable-http');
    assert.equal(http.config.url, 'https://x/mcp');
    assert.deepEqual(http.config.headers, { A: 'b' });

    const sse = ccToDshConfig('remote', { type: 'sse', url: 'https://x/sse' });
    assert.equal(sse.config.transport, 'streamable-http');
    assert.match(sse.warnings.join(' '), /sse mapped/);
  });

  it('infers http from a url with no command', () => {
    const { config } = ccToDshConfig('remote', { url: 'https://x/mcp' });
    assert.equal(config.transport, 'streamable-http');
  });

  it('drops non-scalar env values with a warning', () => {
    const { config, warnings } = ccToDshConfig('thing', {
      command: 'node', env: { GOOD: 'yes', BAD: { nested: true } },
    });
    assert.deepEqual(config.env, { GOOD: 'yes' });
    assert.match(warnings.join(' '), /env BAD is not a scalar/);
  });

  it('drops a /path/to placeholder cwd', () => {
    const { config, warnings } = ccToDshConfig('thing', {
      command: 'node', cwd: '/path/to/your/project',
    });
    assert.equal(config.cwd, undefined);
    assert.match(warnings.join(' '), /cwd .* does not exist/);
  });

  it('reports configs it cannot render', () => {
    assert.equal(ccToDshConfig('x', {}).config, null);
    assert.match(ccToDshConfig('x', {}).warnings.join(' '), /no command and no url/);
    assert.equal(ccToDshConfig('x', null).config, null);
  });
});

describe('renderMcpBlock', () => {
  it('emits a block the patch parser reads back', () => {
    const { config } = ccToDshConfig('gh', { command: 'npx', args: ['-y', 'thing'] }, { platform: 'win32' });
    const block = renderMcpBlock({ key: 'gh', config, note: 'generated from cc-switch "gh"' });
    const parsed = parseBlocks(`${block}\n`);
    assert.equal(parsed.has('gh'), true);
    assert.equal(parsed.get('gh'), `${block}\n`);
  });

  it('quotes values that are not plain YAML scalars', () => {
    const block = renderMcpBlock({
      key: 'x',
      config: {
        serverName: 'x', transport: 'stdio', command: 'cmd',
        args: ['/c', 'npx', 'a b'], env: {}, toolCallTimeoutMs: 60000,
      },
    });
    assert.match(block, /- "a b"/);
    assert.match(block, /command: cmd/);
  });

  it('renders headers only for the http transport', () => {
    const http = renderMcpBlock({
      key: 'r',
      config: {
        serverName: 'r', transport: 'streamable-http',
        url: 'https://x/mcp', headers: { Authorization: 'Bearer t' }, toolCallTimeoutMs: 60000,
      },
    });
    assert.match(http, /headers:/);
    assert.match(http, /Authorization: "Bearer t"/);
  });
});
