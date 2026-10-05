import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  clearExecutableCache,
  dshWebStatus,
  findDshWebProcess,
  isDshWeb,
  normalizeIso,
  parseWindowsRows,
  parseNpmShim,
  peekDshWebCache,
  pickExecutable,
  resolveExecutable,
  shellShimSpec,
  tokenizeCmdline,
  unwrapNpmShim,
  warmDshWebCache,
} from '../src/core/dsh.mjs';

/**
 * Put a `dsh` on PATH for the duration of one test.
 *
 * CI runners do not have this CLI installed, so any assertion about resolving
 * the *real* command has to supply one -- otherwise the test is really asserting
 * something about the machine it happens to run on, which is how the first
 * version of these tests passed locally and failed on every runner.
 *
 * @returns {{dir: string, restore: () => void}}
 */
function withFakeDshOnPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshcp-path-'));
  const script = path.join(dir, 'dsh-cli.mjs');
  fs.writeFileSync(script, '// stand-in\n', 'utf8');

  if (process.platform === 'win32') {
    // Only the `.cmd` shim, plus the extensionless file `where` lists first --
    // which is exactly what the resolver must NOT pick.
    fs.writeFileSync(path.join(dir, 'dsh'), '#!/bin/sh\n', 'utf8');
    fs.writeFileSync(
      path.join(dir, 'dsh.cmd'),
      `@ECHO off\r\n"${process.execPath}" "${script}" %*\r\n`,
      'utf8',
    );
  } else {
    const sh = path.join(dir, 'dsh');
    fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, 'utf8');
    fs.chmodSync(sh, 0o755);
  }

  const before = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${before ?? ''}`;
  clearExecutableCache();
  return {
    dir,
    restore: () => {
      process.env.PATH = before;
      clearExecutableCache();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('spawnable executables', () => {
  /*
   * `dsh` is a `.cmd` shim on Windows, and libuv cannot start one: spawning it
   * raises ENOENT, the same error as "there is no such program". `plugins.mjs`
   * runs `dsh plugin remove` through this layer, so these tests pin both the
   * resolution and the wrapper.
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

  it('unwraps an npm .cmd shim to the node launch it stands for', { skip: process.platform !== 'win32' }, () => {
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

  it('resolves the shim\'s `_prog=node` branch from PATH', { skip: process.platform !== 'win32' }, () => {
    /*
     * After a version-manager switch there is no `node.exe` next to the shim, so
     * npm's IF takes the ELSE branch and the program token is a bare `node` that
     * must be resolved from PATH. The earlier version of this parser turned that
     * into `null` -- shim understood, launch impossible.
     */
    const text = [
      '@ECHO off',
      'SETLOCAL',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      ')',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\entry.js" %*',
    ].join('\r\n');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshcp-nopath-'));
    try {
      const entry = path.join(dir, 'entry.js');
      fs.writeFileSync(entry, '// entry\n', 'utf8');

      const parsed = parseNpmShim(text, dir);
      assert.ok(parsed, 'a shim without a bundled node.exe must still be understood');
      assert.ok(fs.existsSync(parsed.command), `${parsed.command} should exist`);
      assert.deepEqual(parsed.prefixArgs, [entry]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
    // The runner has no `dsh`; supply one, so the assertion is about the
    // resolver rather than about the image Node happens to run on.
    const fake = withFakeDshOnPath();
    try {
      const resolved = resolveExecutable('dsh');
      assert.ok(resolved, 'expected the stand-in dsh to resolve');
      assert.match(resolved, /\.(exe|com|cmd|bat)$/i, `unlaunchable path resolved: ${resolved}`);
      // The extensionless file `where` lists first is a POSIX script Windows
      // cannot start; picking it is the bug this resolver exists to prevent.
      assert.notEqual(path.basename(resolved), 'dsh');
    } finally {
      fake.restore();
    }
  });

  it('reports a missing command as null instead of throwing', () => {
    // The resolver is what turns "the user can type it" into "we can spawn it";
    // a name that is not there has to come back as null so the caller can say
    // why, rather than as a bare libuv code.
    assert.equal(resolveExecutable('dsh-definitely-not-on-path-12345'), null);
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
