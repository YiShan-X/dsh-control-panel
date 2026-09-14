import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  dshWebStatus,
  findDshWebProcess,
  invalidateDshWebCache,
  isDshWeb,
  normalizeIso,
  parseWindowsRows,
  parseNpmShim,
  peekDshWebCache,
  pickExecutable,
  resolveExecutable,
  restartDshWeb,
  shellShimSpec,
  startCommandInfo,
  startDshWeb,
  stopDshWeb,
  tokenizeCmdline,
  unwrapNpmShim,
  warmDshWebCache,
} from '../src/core/dsh.mjs';

describe('spawnable executables', () => {
  /*
   * The DSH tab's Start button shipped broken with `spawn dsh ENOENT`: `dsh` is
   * a `.cmd` shim on Windows, and libuv cannot start one. `mcp.mjs` had always
   * handled this for `npx`; the DSH start path had not. These tests pin both the
   * resolution and the wrapper so it cannot come back.
   */
  it('wraps a Windows shell shim through cmd /c', () => {
    const spec = shellShimSpec('C:\\nvm4w\\nodejs\\dsh.cmd', ['web'], 'win32');
    assert.equal(spec.command, 'cmd');
    assert.deepEqual(spec.args, ['/c', 'C:\\nvm4w\\nodejs\\dsh.cmd', 'web']);
    assert.equal(spec.wrapped, true);
  });

  it('quotes a shim path that contains spaces', () => {
    const spec = shellShimSpec('C:\\Program Files\\nodejs\\dsh.cmd', ['web', '--port', '3080'], 'win32');
    assert.deepEqual(spec.args, ['/c', '"C:\\Program Files\\nodejs\\dsh.cmd"', 'web', '--port', '3080']);
  });

  it('leaves a real executable alone', () => {
    const spec = shellShimSpec('C:\\nvm4w\\nodejs\\node.exe', ['cli.js', 'web'], 'win32');
    assert.equal(spec.wrapped, false);
    assert.equal(spec.command, 'C:\\nvm4w\\nodejs\\node.exe');
  });

  it('never wraps anything on POSIX', () => {
    const spec = shellShimSpec('/usr/local/bin/dsh.sh', ['web'], 'linux');
    assert.equal(spec.wrapped, false);
    assert.equal(spec.command, '/usr/local/bin/dsh.sh');
  });

  it('unwraps an npm .cmd shim to the node launch it stands for', () => {
    // Verbatim shape of an npm global shim (`dsh.cmd` on this machine). The
    // program token is `%_prog%`, not a path, and `%dp0%` already ends in a
    // separator -- both details broke earlier attempts at this parser.
    const text = [
      '@ECHO off',
      'SETLOCAL',
      'CALL :find_dp0',
      '',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      '  SET PATHEXT=%PATHEXT:;.JS;=;%',
      ')',
      '',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*',
      '',
    ].join('\r\n');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshcp-shim-'));
    try {
      const nodeExe = path.join(dir, 'node.exe');
      const entry = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(nodeExe, '', 'utf8');
      fs.writeFileSync(entry, '', 'utf8');

      const parsed = parseNpmShim(text, dir);
      assert.ok(parsed, 'the npm shim should be understood');
      assert.equal(parsed.command, nodeExe);
      assert.deepEqual(parsed.prefixArgs, [entry]);
      // The doubled separator from `%dp0%\` must be collapsed -- left alone it
      // reads as a UNC path -- and the directory must not be glued to the next
      // segment.
      assert.equal(parsed.prefixArgs[0].includes('\\\\'), false);
      assert.ok(parsed.prefixArgs[0].startsWith(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a shim it does not understand', () => {
    assert.equal(parseNpmShim('@ECHO off\r\nREM nothing useful here\r\n', 'C:\\x'), null);
    assert.equal(unwrapNpmShim('/usr/local/bin/dsh.cmd', 'linux'), null);
  });

  it('picks a launchable file out of a where-listing', () => {
    // The real shape of `where dsh` on an nvm4w machine: the extensionless
    // POSIX shim first, the Windows wrappers after it. Taking the first line is
    // what produced ENOENT.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshcp-exe-'));
    try {
      const noExt = path.join(dir, 'dsh');
      const cmd = path.join(dir, 'dsh.cmd');
      const exe = path.join(dir, 'dsh.exe');
      for (const f of [noExt, cmd, exe]) fs.writeFileSync(f, '', 'utf8');

      assert.equal(pickExecutable(`${noExt}\r\n${cmd}\r\n`, 'win32'), cmd);
      // A real .exe is preferred over a wrapper.
      assert.equal(pickExecutable(`${noExt}\r\n${cmd}\r\n${exe}\r\n`, 'win32'), exe);
      // Nothing launchable -> null, so the caller can fall back and explain.
      assert.equal(pickExecutable(`${noExt}\r\n`, 'win32'), null);
      assert.equal(pickExecutable('', 'win32'), null);
      // POSIX has no extension rules: the first hit is the executable.
      assert.equal(pickExecutable(`${noExt}\n`, 'linux'), noExt);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds this machine\'s dsh as something it can actually spawn', { skip: process.platform !== 'win32' }, () => {
    const resolved = resolveExecutable('dsh');
    assert.ok(resolved, 'expected dsh to be on PATH in this environment');
    assert.match(resolved, /\.(exe|com|cmd|bat)$/i, `unlaunchable path resolved: ${resolved}`);
  });

  it('reports a missing command instead of failing with a bare ENOENT', async () => {
    const before = process.env.DSH_WEB_CMD;
    try {
      process.env.DSH_WEB_CMD = 'dsh-definitely-not-on-path-12345 web';
      await assert.rejects(
        () => startDshWeb({
          find: () => null,
          spawn: async () => { throw new Error('must not be reached'); },
          settleMs: 1,
        }),
        (err) => {
          // The executable is resolved before spawning, so the caller gets a
          // sentence it can act on rather than a bare libuv code.
          assert.match(err.message, /could not be launched|failed to spawn|not on PATH|not found/);
          return true;
        },
      );
    } finally {
      if (before === undefined) delete process.env.DSH_WEB_CMD;
      else process.env.DSH_WEB_CMD = before;
    }
  });
});

describe('dsh web probe cache', () => {
  /*
   * These exercise the cache arithmetic through the real accessors. The probe
   * itself still shells out (there is no seam for it at this level), but what
   * is asserted is *when* a measurement is taken, which is the part that can
   * regress into a PowerShell fork per request.
   */
  it('measures once and reuses the measurement', () => {
    warmDshWebCache();                       // forces one probe, keeps the entry
    const first = peekDshWebCache();
    assert.notEqual(first.at, 0, 'warming should leave a cached measurement');

    // A warm-up read is not consumed: the first real request reuses it, which
    // is the entire point of probing at startup instead of on first paint.
    const status = dshWebStatus({ fresh: true });
    assert.equal(peekDshWebCache().at, first.at, 'the warm entry should have been reused');
    assert.equal(status.probed, true);
    assert.ok(Number.isFinite(status.probeMs));
  });

  it('re-probes once invalidated, so a kill is never reported as still running', () => {
    warmDshWebCache();
    const before = peekDshWebCache().at;
    invalidateDshWebCache();
    assert.equal(peekDshWebCache().invalidated, true);

    dshWebStatus();
    const after = peekDshWebCache();
    assert.notEqual(after.at, before, 'an invalidated cache must re-probe');
    assert.equal(after.invalidated, false, 'the re-probe clears the flag');
  });

  it('asks the clock before the OS: a young entry is reused for every poll', () => {
    warmDshWebCache();
    const at = peekDshWebCache().at;
    dshWebStatus();
    dshWebStatus();
    dshWebStatus();
    assert.equal(peekDshWebCache().at, at, 'polling must not re-probe inside the TTL');
  });
});

describe('dsh web process model', () => {
  it('matches a dsh web command line and nothing else', () => {
    assert.equal(isDshWeb('"C:\\nvm4w\\nodejs\\node.exe" C:\\nvm4w\\nodejs/node_modules/@deepseek-ai/dsh/lib/bin.js web'), true);
    assert.equal(isDshWeb('node /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3080'), true);
    // The panel's own command line must never be mistaken for the service.
    assert.equal(isDshWeb('node D:\\GitHub\\dsh-control-panel\\src\\cli.mjs'), false);
    assert.equal(isDshWeb('node .../dsh/bin.js webview'), false);
    assert.equal(isDshWeb('node .../web-worker.js'), false);
    assert.equal(isDshWeb('node some-web-app/server.js'), false);
  });

  it('parses the Windows probe rows', () => {
    const row = '18128|"C:\\nvm4w\\nodejs\\node.exe" C:\\x\\dsh\\lib\\bin.js web|2026-09-14T10:41:56.6530520Z|41563|393211904';
    const proc = parseWindowsRows(`${row}\r\n`);
    assert.equal(proc.pid, 18128);
    assert.equal(proc.cmdline, '"C:\\nvm4w\\nodejs\\node.exe" C:\\x\\dsh\\lib\\bin.js web');
    // Seven fractional digits in, three out: `Date` cannot read the former.
    assert.equal(proc.startedAt, '2026-09-14T10:41:56.653Z');
    assert.equal(proc.cpuMs, 41563);
    assert.equal(proc.rssBytes, 393211904);
  });

  it('ignores blank and malformed probe output', () => {
    assert.equal(parseWindowsRows(''), null);
    assert.equal(parseWindowsRows('not a row'), null);
    assert.equal(parseWindowsRows('0|cmd|bogus|1|2'), null);
  });

  it('normalizes a missing or unparseable timestamp to null', () => {
    assert.equal(normalizeIso(''), null);
    assert.equal(normalizeIso('   '), null);
    assert.equal(normalizeIso('not-a-date'), null);
  });

  it('survives an enumeration failure instead of throwing', () => {
    // The probe shells out; on a locked-down host that call can fail outright.
    // Callers treat null as "not running", which is the only safe reading.
    assert.doesNotThrow(() => findDshWebProcess());
  });
});

describe('dsh web lifecycle', () => {
  const proc = { pid: 111, cmdline: '"C:\\node.exe" dsh web', startedAt: null, cpuMs: null, rssBytes: null };

  it('starts from scratch and reports whether it actually came up', async () => {
    const spawned = [];
    let live = null;
    const result = await startDshWeb({
      find: () => live,
      spawn: (cmd) => { spawned.push(cmd); live = { ...proc, pid: 222 }; return 222; },
      settleMs: 1,
    });
    assert.deepEqual(spawned, ['dsh web']);
    assert.equal(result.changed, true);
    assert.equal(result.newPid, 222);
    assert.equal(result.alive, true);
    assert.equal(result.livePid, 222);
  });

  it('reports a start that never became a process', async () => {
    const result = await startDshWeb({
      find: () => null,
      spawn: () => 333,
      settleMs: 1,
    });
    assert.equal(result.changed, true);
    assert.equal(result.newPid, 333);
    assert.equal(result.alive, false);
    assert.equal(result.livePid, null);
  });

  it('is a no-op when the service is already running', async () => {
    const result = await startDshWeb({
      find: () => proc,
      spawn: () => { throw new Error('must not spawn'); },
      settleMs: 1,
    });
    assert.equal(result.changed, false);
    assert.equal(result.existingPid, 111);
    assert.equal(result.alive, true);
  });

  it('stops nothing without complaining', async () => {
    const result = await stopDshWeb({ find: () => null });
    assert.equal(result.changed, false);
    assert.match(result.note, /not running/);
  });

  it('restarts with the command line it found, not the default', async () => {
    const spawned = [];
    // A live executable, so the stale-command guard has nothing to complain
    // about; `node` is the one binary this test suite is guaranteed to have.
    const withArgs = { ...proc, cmdline: `${process.execPath} fake-dsh-web.mjs --port 3080` };
    const result = await restartDshWeb({
      find: () => withArgs,
      spawn: (cmd) => { spawned.push(cmd); return 444; },
      alive: () => false,
      settleMs: 1,
    });
    assert.deepEqual(spawned, [`${process.execPath} fake-dsh-web.mjs --port 3080`]);
    assert.equal(result.changed, true);
    assert.equal(result.killedPid, 111);
    assert.equal(result.newPid, 444);
    assert.equal(result.commandFellBack, false);
  });

  it('falls back when the captured command no longer resolves', async () => {
    // A switched Node version manager leaves the old absolute path behind.
    const stale = { ...proc, cmdline: '"C:\\nvm4w\\old\\node.exe" dsh web --port 3080' };
    const spawned = [];
    const result = await restartDshWeb({
      find: () => stale,
      spawn: (cmd) => { spawned.push(cmd); return 445; },
      alive: () => false,
      settleMs: 1,
    });
    assert.equal(result.commandFellBack, true);
    assert.equal(result.capturedCommand, stale.cmdline);
    assert.notEqual(spawned[0], stale.cmdline, 'a dead executable must not be replayed');
  });

  it('degrades a restart of nothing into a plain start', async () => {
    let live = null;
    const result = await restartDshWeb({
      find: () => live,
      spawn: () => { live = { ...proc, pid: 555 }; return 555; },
      settleMs: 1,
    });
    assert.equal(result.changed, true);
    assert.equal(result.killedPid, null);
    assert.equal(result.newPid, 555);
  });

  it('reports the command the Start button would run', () => {
    const before = process.env.DSH_WEB_CMD;
    try {
      delete process.env.DSH_WEB_CMD;
      assert.deepEqual(startCommandInfo(), { command: 'dsh web', source: 'default' });
      process.env.DSH_WEB_CMD = 'dsh web --port 9999';
      assert.deepEqual(startCommandInfo(), { command: 'dsh web --port 9999', source: 'DSH_WEB_CMD' });
    } finally {
      if (before === undefined) delete process.env.DSH_WEB_CMD;
      else process.env.DSH_WEB_CMD = before;
    }
  });
});

describe('tokenizeCmdline', () => {
  it('splits a quoted Windows command line', () => {
    assert.deepEqual(
      tokenizeCmdline('"C:\\Program Files\\node.exe" "C:\\a b\\cli.js" web'),
      ['C:\\Program Files\\node.exe', 'C:\\a b\\cli.js', 'web'],
    );
  });

  it('keeps POSIX single-quoted groups together', () => {
    assert.deepEqual(tokenizeCmdline("node '/opt/my app/cli.js' web"), ['node', '/opt/my app/cli.js', 'web']);
  });

  it('joins adjacent quoted and bare text into one token', () => {
    assert.deepEqual(tokenizeCmdline('"foo"bar baz'), ['foobar', 'baz']);
  });

  it('returns nothing for an empty command', () => {
    assert.deepEqual(tokenizeCmdline('   '), []);
  });
});
