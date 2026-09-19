/**
 * The panel's own update check.
 *
 * Network-free by construction: the feed fetch is injected, so the parse and the
 * comparison are exercised against the exact text electron-builder publishes
 * (copied from the real `latest.yml` of release 1.2.0) instead of a hand-made
 * approximation of it.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { resolveConfig } from '../src/core/config.mjs';
import { HttpError } from '../src/core/errors.mjs';
import {
  archTokens,
  assetUrl,
  buildPanelUpdateState,
  downloadPanelUpdate,
  feedFileName,
  fetchLatestRelease,
  invalidateFeedCache,
  isDownloadInFlight,
  parseFeed,
  pickAsset,
  releasePageUrl,
  sha512Of,
  updateDownloadDir,
} from '../src/core/panelUpdate.mjs';

/** Verbatim shape of the real `latest.yml` published with release 1.2.0. */
const REAL_FEED = `version: 1.2.0
files:
  - url: dsh-control-panel-1.2.0-x64-setup.exe
    sha512: U8TMoaLzEIS9Z7YdfuVaU0sEpS4wKLlqyLHy9l0RK4vnDo1W8Dl5o9EMEwkgtXvPdly2JKsH7v64wfbIdMYIGQ==
    size: 111413415
  - url: dsh-control-panel-1.2.0-arm64-setup.exe
    sha512: iV5lD3m0+0FaUFphL2PLKWJ8Ocs5YISYACZjf/E5nUeO6YTYOxOikDZ3eAdC+usiptbh9QL3R9iobFFYOdDnKg==
    size: 105122926
path: dsh-control-panel-1.2.0-x64-setup.exe
sha512: U8TMoaLzEIS9Z7YdfuVaU0sEpS4wKLlqyLHy9l0RK4vnDo1W8Dl5o9EMEwkgtXvPdly2JKsH7v64wfbIdMYIGQ==
releaseDate: '2026-09-14T11:51:43.539Z'
`;

const MAC_FEED = `version: 1.3.0
files:
  - url: dsh-control-panel-1.3.0-x64.zip
    sha512: aaa=
    size: 1
  - url: dsh-control-panel-1.3.0-arm64.zip
    sha512: bbb=
    size: 2
  - url: dsh-control-panel-1.3.0-x64.dmg
    sha512: ccc=
    size: 3
  - url: dsh-control-panel-1.3.0-arm64.dmg
    sha512: ddd=
    size: 4
releaseDate: '2026-09-19T09:00:00.000Z'
`;

/**
 * The real `latest-linux.yml` published with release 1.3.0, verbatim.
 *
 * These names are the reason this fixture exists: electron-builder calls an x64
 * AppImage `x86_64` and an x64 deb `amd64`, so matching Node's `process.arch`
 * (`x64`) against them found nothing on Linux at all. That shipped in 1.3.0 and
 * was only visible once a release existed to look at.
 */
const LINUX_FEED = `version: 1.3.0
files:
  - url: dsh-control-panel-1.3.0-x86_64.AppImage
    sha512: A1HSyub1DKmQFng1SpbMdbOG/GfU0iFlwbpa9a5DFSKALVkYSVpwJfmmmln1p9qhptTQU10lpsoiRd0wKf2moA==
    size: 124941478
    blockMapSize: 132282
  - url: dsh-control-panel-1.3.0-amd64.deb
    sha512: f0gGkQ8cPqmNKbkvzfvn/ABt/Fsez6kkCtUW5yCK4GAI7wiqPSiDSdn1K2EbNLxvXV8fzAHF/RS+MlWSRWJx0Q==
    size: 98783948
path: dsh-control-panel-1.3.0-x86_64.AppImage
sha512: A1HSyub1DKmQFng1SpbMdbOG/GfU0iFlwbpa9a5DFSKALVkYSVpwJfmmmln1p9qhptTQU10lpsoiRd0wKf2moA==
releaseDate: '2026-09-19T09:39:49.146Z'
`;

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
  invalidateFeedCache();
});

function tmpDir(prefix = 'dshcp-panel-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const config = (env = {}) => resolveConfig({
  DSH_PANEL_HOME: path.join(os.tmpdir(), 'dshcp-unused-home'),
  DSH_PANEL_CC_SWITCH: '0',
  DSH_PANEL_REPO: 'acme/panel',
  ...env,
});

/** A `getText` stand-in that answers with a fixed feed. */
const feedGetter = (body, status = 200) => async () => ({ status, headers: {}, body, url: 'https://github.com/acme/panel' });

describe('release feed parsing', () => {
  it('reads the version, the files and each digest', () => {
    const parsed = parseFeed(REAL_FEED);
    assert.equal(parsed.version, '1.2.0');
    assert.equal(parsed.releaseDate, '2026-09-14T11:51:43.539Z');
    assert.deepEqual(parsed.files.map((f) => f.url), [
      'dsh-control-panel-1.2.0-x64-setup.exe',
      'dsh-control-panel-1.2.0-arm64-setup.exe',
    ]);
    assert.equal(parsed.files[0].size, 111413415);
    // The digest is what makes a verified download possible.
    assert.match(parsed.files[0].sha512, /^U8TMoaLz/);
  });

  it('refuses to invent a version it cannot parse', () => {
    // A feed that cannot be read must report "could not read the feed", never a
    // guessed version -- the whole card is a comparison against this number.
    assert.equal(parseFeed('version: not-a-version\nfiles:\n  - url: x.exe\n'), null);
    assert.equal(parseFeed('files:\n  - url: x.exe\n'), null);
    assert.equal(parseFeed('version: 1.2.0\nfiles: []\n'), null);
    assert.equal(parseFeed(''), null);
    assert.equal(parseFeed('version: 1.2.0\nfiles:\n  - url: x.exe\n').version, '1.2.0');
  });

  it('survives a file entry with no digest or size', () => {
    const parsed = parseFeed('version: 1.0.0\nfiles:\n  - url: only.exe\n');
    assert.deepEqual(parsed.files, [{ url: 'only.exe', sha512: null, size: null }]);
  });

  it('names the feed and the asset URL per platform', () => {
    assert.equal(feedFileName('win32'), 'latest.yml');
    assert.equal(feedFileName('darwin'), 'latest-mac.yml');
    assert.equal(feedFileName('linux'), 'latest-linux.yml');
    assert.equal(assetUrl('a/b', 'x y.yml'), 'https://github.com/a/b/releases/latest/download/x%20y.yml');
    assert.equal(releasePageUrl('a/b'), 'https://github.com/a/b/releases/latest');
  });
});

describe('artifact selection', () => {
  it('prefers the installer a user would actually run', () => {
    const files = parseFeed(REAL_FEED).files;
    const x64 = pickAsset(files, 'win32', 'x64');
    assert.equal(x64.url, 'dsh-control-panel-1.2.0-x64-setup.exe');
    assert.equal(x64.kind, 'installer');
    assert.equal(pickAsset(files, 'win32', 'arm64').url, 'dsh-control-panel-1.2.0-arm64-setup.exe');
  });

  it('takes the dmg on macOS, not the zip that ships beside it', () => {
    // The `.zip` is the format electron-updater consumes, not something to hand
    // a person. Preference order is the whole point of this function.
    const files = parseFeed(MAC_FEED).files;
    assert.equal(pickAsset(files, 'darwin', 'arm64').url, 'dsh-control-panel-1.3.0-arm64.dmg');
    assert.equal(pickAsset(files, 'darwin', 'x64').url, 'dsh-control-panel-1.3.0-x64.dmg');
  });

  it('does not offer an artifact built for a different architecture', () => {
    const files = parseFeed(REAL_FEED).files;
    // arm64 Windows files exist, but not arm64 macOS ones in this feed.
    assert.equal(pickAsset(files, 'darwin', 'arm64'), null);
    assert.equal(pickAsset(files, 'linux', 'x64'), null);
  });

  it('matches the Linux names electron-builder actually publishes', () => {
    /*
     * `x86_64.AppImage` and `amd64.deb`, not `x64.*`. This shipped broken in
     * 1.3.0: the Linux updater offered nothing because it looked for a token
     * electron-builder never writes.
     */
    const files = parseFeed(LINUX_FEED).files;
    const appImage = pickAsset(files, 'linux', 'x64');
    assert.equal(appImage.url, 'dsh-control-panel-1.3.0-x86_64.AppImage');
    assert.equal(appImage.kind, 'installer');

    // And the deb is still found for the same arch when there is no AppImage.
    const debOnly = files.filter((f) => f.url.endsWith('.deb'));
    assert.equal(pickAsset(debOnly, 'linux', 'x64').url, 'dsh-control-panel-1.3.0-amd64.deb');
    assert.equal(pickAsset(debOnly, 'linux', 'x64').kind, 'package');
  });

  it('names the arch tokens per platform', () => {
    assert.deepEqual(archTokens('linux', 'x64'), ['x86_64', 'amd64', 'x64']);
    assert.deepEqual(archTokens('linux', 'arm64'), ['arm64']);
    assert.deepEqual(archTokens('win32', 'x64'), ['x64']);
    assert.deepEqual(archTokens('darwin', 'arm64'), ['arm64']);
  });

  it('prefers the setup installer over the portable build', () => {
    // The portable build carries no architecture in its name, so it must not
    // shadow the architecture-matched installer.
    const files = parseFeed(`version: 1.3.0
files:
  - url: dsh-control-panel-1.3.0-portable.exe
    sha512: p=
    size: 1
  - url: dsh-control-panel-1.3.0-arm64-setup.exe
    sha512: s=
    size: 2
`).files;
    assert.equal(pickAsset(files, 'win32', 'arm64').url, 'dsh-control-panel-1.3.0-arm64-setup.exe');
    assert.equal(pickAsset(files, 'win32', 'x64').url, 'dsh-control-panel-1.3.0-portable.exe');
  });

  it('falls back to the portable build when there is no setup exe', () => {
    const files = parseFeed('version: 1.0.0\nfiles:\n  - url: panel-1.0.0-portable.exe\n').files;
    assert.equal(pickAsset(files, 'win32', 'x64').kind, 'portable');
  });
});

describe('update state', () => {
  it('reports an available update and the artifact it would install', async () => {
    const st = await buildPanelUpdateState(config(), {
      current: '1.2.0', fresh: true, release: true, packaged: true,
      platform: 'win32', arch: 'x64', getText: feedGetter('version: 1.3.0\nfiles:\n  - url: p-1.3.0-x64-setup.exe\n    sha512: zz=\n    size: 9\n'),
    });
    assert.equal(st.current, '1.2.0');
    assert.equal(st.latest, '1.3.0');
    assert.equal(st.updateAvailable, true);
    assert.equal(st.canUpdate, true);
    assert.equal(st.asset.name, 'p-1.3.0-x64-setup.exe');
    assert.equal(st.asset.hasDigest, true);
    assert.equal(st.repo, 'acme/panel');
  });

  it('does not claim an update when the running version is the newest', async () => {
    const st = await buildPanelUpdateState(config(), {
      current: '1.2.0', fresh: true, release: true, packaged: true,
      platform: 'win32', arch: 'x64', getText: feedGetter(REAL_FEED),
    });
    assert.equal(st.updateAvailable, false);
    assert.equal(st.canUpdate, false);
    assert.equal(st.checked, true);
  });

  it('distinguishes a dev checkout that is ahead of the release', async () => {
    const st = await buildPanelUpdateState(config(), {
      current: '1.4.0', fresh: true, release: true, packaged: true,
      platform: 'win32', arch: 'x64', getText: feedGetter(REAL_FEED),
    });
    assert.equal(st.updateAvailable, false);
    // Calling this "up to date" would be wrong too -- it is a different fact.
    assert.equal(st.aheadOfRelease, true);
  });

  it('offers no update to a source checkout, and says it is one', async () => {
    const st = await buildPanelUpdateState(config(), {
      current: '1.2.0', fresh: true, release: true, packaged: false,
      platform: 'win32', arch: 'x64', getText: feedGetter('version: 1.3.0\nfiles:\n  - url: p-1.3.0-x64-setup.exe\n'),
    });
    assert.equal(st.updateAvailable, true);
    // There is no installer for a checkout to replace, so no button.
    assert.equal(st.canUpdate, false);
    assert.equal(st.packaged, false);
  });

  it('reports a feed failure instead of a version', async () => {
    const st = await buildPanelUpdateState(config(), {
      current: '1.2.0', fresh: true, release: true, packaged: true,
      platform: 'win32', arch: 'x64', getText: feedGetter('', 404),
    });
    assert.equal(st.latest, null);
    assert.equal(st.updateAvailable, false);
    assert.match(st.checkError, /HTTP 404/);
  });

  it('never touches the network unless asked', async () => {
    let called = 0;
    const st = await buildPanelUpdateState(config(), {
      current: '1.2.0', fresh: true, packaged: true, platform: 'win32', arch: 'x64',
      getText: async () => { called += 1; return { status: 200, headers: {}, body: REAL_FEED }; },
    });
    assert.equal(called, 0);
    assert.equal(st.checked, false);
    assert.equal(st.latest, null);
    // The local half is still real: the card shows what is running.
    assert.equal(st.current, '1.2.0');
  });

  it('caches a failure so a poll does not retry it', async () => {
    let called = 0;
    const getText = async () => { called += 1; return { status: 500, headers: {}, body: '' }; };
    await fetchLatestRelease(config(), { fresh: true, getText, platform: 'win32' });
    await fetchLatestRelease(config(), { getText, platform: 'win32' });
    assert.equal(called, 1, 'the second call should have been answered from the cache');
  });
});

describe('downloading an update', () => {
  /** Write `bytes` to the destination the way httpDownload would. */
  const fakeDownload = (bytes) => async (url, dest) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
    return { status: 200, bytes: bytes.length, url, headers: {} };
  };

  const digest = (buf) => crypto.createHash('sha512').update(buf).digest('base64');

  it('downloads the right artifact and verifies its digest', async () => {
    const bytes = Buffer.from('a pretend installer');
    const feed = `version: 1.3.0\nfiles:\n  - url: p-1.3.0-x64-setup.exe\n    sha512: ${digest(bytes)}\n    size: ${bytes.length}\n`;
    const dir = tmpDir();

    const res = await downloadPanelUpdate(config(), {
      current: '1.2.0', packaged: true, platform: 'win32', arch: 'x64',
      downloadDir: dir, getText: feedGetter(feed), download: fakeDownload(bytes),
    });

    assert.equal(res.version, '1.3.0');
    assert.equal(res.from, '1.2.0');
    assert.equal(res.verified, true);
    assert.equal(res.file, path.join(dir, 'p-1.3.0-x64-setup.exe'));
    assert.equal(fs.readFileSync(res.file, 'utf8'), bytes.toString());
    assert.equal(isDownloadInFlight(), false);
  });

  it('deletes the file and fails when the digest does not match', async () => {
    // The file is handed to the OS to execute, so a mismatch has to be fatal.
    const feed = `version: 1.3.0\nfiles:\n  - url: p-1.3.0-x64-setup.exe\n    sha512: ${digest(Buffer.from('expected'))}\n`;
    const dir = tmpDir();

    await assert.rejects(
      () => downloadPanelUpdate(config(), {
        current: '1.2.0', packaged: true, platform: 'win32', arch: 'x64',
        downloadDir: dir, getText: feedGetter(feed),
        download: fakeDownload(Buffer.from('tampered')),
      }),
      (err) => err instanceof HttpError && err.status === 502 && /did not match the digest/.test(err.message),
    );
    assert.equal(fs.existsSync(path.join(dir, 'p-1.3.0-x64-setup.exe')), false);
  });

  it('reports "not verified" rather than implying a check it did not make', async () => {
    const feed = 'version: 1.3.0\nfiles:\n  - url: p-1.3.0-x64-setup.exe\n';
    const dir = tmpDir();
    const res = await downloadPanelUpdate(config(), {
      current: '1.2.0', packaged: true, platform: 'win32', arch: 'x64',
      downloadDir: dir, getText: feedGetter(feed),
      download: fakeDownload(Buffer.from('no digest published')),
    });
    assert.equal(res.verified, null);
  });

  it('refuses when the release has no artifact for this platform', async () => {
    const dir = tmpDir();
    await assert.rejects(
      () => downloadPanelUpdate(config(), {
        current: '1.2.0', packaged: true, platform: 'linux', arch: 'x64',
        downloadDir: dir, getText: feedGetter(REAL_FEED),
        download: fakeDownload(Buffer.from('x')),
      }),
      (err) => err instanceof HttpError && err.status === 501 && /no artifact for linux\/x64/.test(err.message),
    );
  });

  it('reports a feed failure as a 502', async () => {
    await assert.rejects(
      () => downloadPanelUpdate(config(), {
        current: '1.2.0', packaged: true, platform: 'win32', arch: 'x64',
        downloadDir: tmpDir(), getText: feedGetter('', 503),
        download: fakeDownload(Buffer.from('x')),
      }),
      (err) => err instanceof HttpError && err.status === 502,
    );
    assert.equal(isDownloadInFlight(), false);
  });

  it('cannot be steered outside the download directory by the feed', async () => {
    // The asset name becomes a path. A feed entry with separators must not be
    // able to write anywhere else.
    const dir = tmpDir();
    const feed = 'version: 1.3.0\nfiles:\n  - url: ../../escaped-x64-setup.exe\n';
    const res = await downloadPanelUpdate(config(), {
      current: '1.2.0', packaged: true, platform: 'win32', arch: 'x64',
      downloadDir: dir, getText: feedGetter(feed),
      download: fakeDownload(Buffer.from('x')),
    });
    assert.equal(res.file, path.join(dir, 'escaped-x64-setup.exe'));
    assert.equal(path.dirname(res.file), dir);
  });
});

describe('download location', () => {
  it('prefers the user\'s Downloads directory', () => {
    const home = tmpDir('dshcp-home-');
    fs.mkdirSync(path.join(home, 'Downloads'));
    assert.equal(updateDownloadDir({}, home), path.join(home, 'Downloads'));
  });

  it('falls back to a temp directory when there is none', () => {
    const home = tmpDir('dshcp-home-');
    assert.equal(updateDownloadDir({}, home), path.join(os.tmpdir(), 'dsh-control-panel-update'));
  });

  it('honours an explicit override', () => {
    assert.equal(updateDownloadDir({ DSH_PANEL_DOWNLOAD_DIR: path.join(os.tmpdir(), 'chosen') }), path.resolve(path.join(os.tmpdir(), 'chosen')));
  });
});

describe('digest helper', () => {
  it('hashes a file in the form the feed publishes', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'x.bin');
    const bytes = Buffer.from('installer');
    fs.writeFileSync(file, bytes);
    assert.equal(await sha512Of(file), crypto.createHash('sha512').update(bytes).digest('base64'));
  });
});

describe('update routes', () => {
  let bound;
  afterEach(async () => { await bound?.close(); bound = null; });

  async function serve(options = {}) {
    const { createPanelServer, listen } = await import('../src/core/server.mjs');
    const publicDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'public');
    const { server } = createPanelServer(config(), {
      publicDir,
      version: '1.2.0',
      openPath: async () => null,
      ...options,
    });
    bound = await listen(server, { host: '127.0.0.1', port: 0 });
    return bound.url;
  }

  it('refuses to update a source checkout, and says what to do instead', async () => {
    // Deterministic and network-free: the packaged check comes before anything
    // is fetched, so this cannot accidentally download an installer in CI.
    const base = await serve({ packaged: false });
    const res = await fetch(`${base}/api/panel/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 501);
    const body = await res.json();
    assert.match(body.error, /source checkout/);
  });

  it('reports a check failure as a value, not as a 500', async () => {
    /*
     * Point the proxy at a closed port so the failure is immediate and
     * deterministic -- a test that waits out a real DNS timeout is slow when the
     * network is down and different when it is up. This doubles as proof that
     * the route's fetch honours the proxy environment, which is the whole reason
     * the HTTP client reads it.
     */
    const saved = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
    try {
      const base = await serve({ packaged: false });
      const res = await fetch(`${base}/api/panel/release?fresh=1`);
      assert.equal(res.status, 200, 'an unreachable feed is a reported state, not a server error');
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.panelUpdate.current, '1.2.0');
      assert.equal(body.panelUpdate.checked, true);
      assert.equal(body.panelUpdate.latest, null);
      assert.match(body.panelUpdate.checkError, /ECONNREFUSED|connect/i);
      // A source checkout can never offer the button.
      assert.equal(body.panelUpdate.canUpdate, false);
    } finally {
      if (saved === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = saved;
      invalidateFeedCache();
    }
  });
});
