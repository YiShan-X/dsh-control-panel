/**
 * The proxy-aware HTTP client.
 *
 * Everything here runs against servers this file starts on 127.0.0.1, so the
 * suite never touches the network. That is not just hygiene: the CONNECT + TLS
 * path is the one piece of this module that is easy to get subtly wrong, and a
 * test that needs a real proxy to exercise it would be skipped exactly when it
 * matters.
 *
 * The TLS server certificate is generated here, at run time, with `openssl` --
 * a throwaway key that never leaves the temp directory. Committing a private key
 * as a fixture would be the alternative, and a public repository does not need
 * one, so the test skips honestly on a host without openssl.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  assertFollowable,
  httpDownload,
  httpGetText,
  isExempt,
  normaliseProxy,
  proxyFor,
} from '../src/core/httpGet.mjs';

/** Throwaway servers and temp directories, torn down once the file is done. */
const cleanup = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

/** Start an HTTP server on a free port; returns its base URL. */
async function serveHttp(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  cleanup.push(() => new Promise((r) => server.close(r)));
  return { url: `http://127.0.0.1:${port}`, port };
}

/**
 * A minimal forward proxy: absolute-form for plain HTTP, `CONNECT` for TLS.
 *
 * `record` collects every request line and header set it sees, which is how the
 * tests check what the client actually sent rather than what it intended to.
 */
async function serveProxy({ refuse = false } = {}) {
  const record = [];
  const server = http.createServer((req, res) => {
    record.push({ method: req.method, url: req.url, headers: req.headers });
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400);
      res.end('not an absolute URL');
      return;
    }
    const upstream = http.request({
      hostname: target.hostname,
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers: req.headers,
    }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end('proxy could not reach upstream'); });
    req.pipe(upstream);
  });

  server.on('connect', (req, clientSocket, head) => {
    record.push({ method: 'CONNECT', url: req.url, headers: req.headers });
    if (refuse) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }
    const idx = req.url.lastIndexOf(':');
    const host = req.url.slice(0, idx);
    const port = Number(req.url.slice(idx + 1));
    const upstream = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  cleanup.push(() => new Promise((r) => server.close(r)));
  return { url: `http://127.0.0.1:${port}`, port, record };
}

/**
 * Generate a self-signed `localhost` certificate, or null when openssl is
 * unavailable (the caller skips rather than pretending to have tested TLS).
 */
function makeCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshcp-tls-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', 'key.pem', '-out', 'cert.pem', '-days', '2',
      '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost',
    ], { cwd: dir, stdio: 'ignore' });
  } catch {
    return null;
  }
  try {
    return {
      key: fs.readFileSync(path.join(dir, 'key.pem')),
      cert: fs.readFileSync(path.join(dir, 'cert.pem')),
    };
  } catch {
    return null;
  }
}

describe('proxy resolution', () => {
  it('reads both cases, because the two conventions differ', () => {
    // curl only honours the lowercase forms; most Windows tooling sets the
    // uppercase ones. Reading both is what makes "set HTTPS_PROXY" work.
    assert.equal(proxyFor('https://example.test/x', { HTTPS_PROXY: 'http://p:1' }).url, 'http://p:1');
    assert.equal(proxyFor('https://example.test/x', { https_proxy: 'http://p:2' }).url, 'http://p:2');
    assert.equal(proxyFor('https://example.test/x', { HTTPS_PROXY: 'http://p:1', https_proxy: 'http://p:2' }).url, 'http://p:2');
  });

  it('prefers the scheme-specific variable and falls back to ALL_PROXY', () => {
    assert.equal(proxyFor('https://e.test/', { HTTP_PROXY: 'http://a:1', HTTPS_PROXY: 'http://b:2' }).url, 'http://b:2');
    assert.equal(proxyFor('http://e.test/', { HTTP_PROXY: 'http://a:1', HTTPS_PROXY: 'http://b:2' }).url, 'http://a:1');
    assert.equal(proxyFor('https://e.test/', { ALL_PROXY: 'http://all:9' }).url, 'http://all:9');
    assert.equal(proxyFor('https://e.test/', { HTTPS_PROXY: 'http://x:1', ALL_PROXY: 'http://all:9' }).url, 'http://x:1');
  });

  it('reports which variable answered', () => {
    assert.equal(proxyFor('https://e.test/', { HTTPS_PROXY: 'http://x:1' }).source, 'HTTPS_PROXY');
  });

  it('accepts a bare host:port, the way curl does', () => {
    assert.equal(normaliseProxy('127.0.0.1:10808'), 'http://127.0.0.1:10808');
    assert.equal(normaliseProxy('http://127.0.0.1:10808'), 'http://127.0.0.1:10808');
    assert.equal(proxyFor('https://e.test/', { HTTPS_PROXY: '127.0.0.1:10808' }).url, 'http://127.0.0.1:10808');
  });

  it('is null when nothing is configured', () => {
    assert.equal(proxyFor('https://e.test/', {}), null);
    assert.equal(proxyFor('https://e.test/', { HTTPS_PROXY: '   ' }), null);
  });

  it('honours NO_PROXY, including the wildcard and suffix forms', () => {
    const env = { HTTPS_PROXY: 'http://p:1' };
    assert.equal(isExempt(new URL('https://github.com/x'), { NO_PROXY: '*' }), true);
    assert.equal(isExempt(new URL('https://github.com/x'), { NO_PROXY: 'github.com' }), true);
    assert.equal(isExempt(new URL('https://api.github.com/x'), { NO_PROXY: '.github.com' }), true);
    assert.equal(isExempt(new URL('https://api.github.com/x'), { NO_PROXY: 'github.com' }), true);
    assert.equal(isExempt(new URL('https://github.com/x'), { no_proxy: 'other.test' }), false);
    assert.equal(isExempt(new URL('https://github.com/x'), {}), false);

    // A port-qualified entry only exempts that port.
    assert.equal(isExempt(new URL('https://github.com:8443/x'), { NO_PROXY: 'github.com:8443' }), true);
    assert.equal(isExempt(new URL('https://github.com/x'), { NO_PROXY: 'github.com:8443' }), false);

    // A suffix entry must not match a different domain that merely ends with it.
    assert.equal(isExempt(new URL('https://notgithub.com/x'), { NO_PROXY: 'github.com' }), false);
    assert.equal(proxyFor('https://github.com/x', { ...env, NO_PROXY: 'github.com' }), null);
  });

  it('resolves NO_PROXY for IPv6 literals', () => {
    assert.equal(isExempt(new URL('https://[::1]:8443/x'), { NO_PROXY: '[::1]:8443' }), true);
    assert.equal(isExempt(new URL('https://[::1]/x'), { NO_PROXY: '[::1]' }), true);
  });
});

describe('direct requests', () => {
  it('GETs a plain HTTP URL', async () => {
    const { url } = await serveHttp((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello from the local server');
    });
    const res = await httpGetText(`${url}/thing`, { env: {} });
    assert.equal(res.status, 200);
    assert.equal(res.body, 'hello from the local server');
  });

  it('does not send a proxy to a host NO_PROXY exempts', async () => {
    const { url, record } = await serveProxy();
    const local = await serveHttp((req, res) => { res.end('direct'); });
    const res = await httpGetText(`${local.url}/x`, {
      env: { HTTP_PROXY: url, NO_PROXY: '127.0.0.1' },
    });
    assert.equal(res.body, 'direct');
    assert.deepEqual(record, [], 'the proxy should not have been contacted');
  });

  it('follows a redirect, resolving a relative Location', async () => {
    const { url } = await serveHttp((req, res) => {
      if (req.url === '/from') {
        res.writeHead(302, { location: '/to' });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end('arrived');
    });
    const res = await httpGetText(`${url}/from`, { env: {} });
    assert.equal(res.body, 'arrived');
    assert.equal(res.url, `${url}/to`);
  });

  it('gives up after too many redirects instead of looping forever', async () => {
    const { url } = await serveHttp((req, res) => {
      res.writeHead(302, { location: '/loop' });
      res.end();
    });
    await assert.rejects(() => httpGetText(`${url}/loop`, { env: {}, maxRedirects: 3 }), /too many redirects/);
  });

  it('refuses to follow a redirect off GitHub when the caller asks it to', () => {
    // A redirect is the one place an attacker-influenced value could move the
    // update request to an arbitrary host. `assertFollowable` is that policy for
    // the update path -- it is not applied inside the generic client, which is
    // why a caller fetching anything else can still follow redirects normally.
    assert.throws(() => assertFollowable('https://evil.test/x'), /off GitHub/);
    assert.throws(() => assertFollowable('http://github.com/x'), /non-HTTPS/);
    assert.doesNotThrow(() => assertFollowable('https://github.com/x'));
    assert.doesNotThrow(() => assertFollowable('https://objects.githubusercontent.com/x'));
  });

  it('calls the caller\'s onRedirect hook on every hop, and obeys a refusal', async () => {
    // The hook is the extension point the update path uses to keep an installer
    // on GitHub. What matters here is that it runs before the hop is taken.
    const { url } = await serveHttp((req, res) => {
      res.writeHead(302, { location: '/elsewhere' });
      res.end();
    });
    const seen = [];
    await assert.rejects(
      () => httpGetText(`${url}/from`, {
        env: {},
        onRedirect: (next) => { seen.push(next); throw new Error('policy says no'); },
      }),
      /policy says no/,
    );
    assert.deepEqual(seen, [`${url}/elsewhere`]);
  });

  it('stops reading a response that is larger than it promised to be', async () => {
    const { url } = await serveHttp((req, res) => {
      res.writeHead(200);
      res.end('x'.repeat(5000));
    });
    await assert.rejects(() => httpGetText(`${url}/big`, { env: {}, maxBytes: 100 }), /exceeded 100 bytes/);
  });
});

describe('through a proxy', () => {
  it('sends plain HTTP in absolute form, which is what a proxy expects', async () => {
    const proxy = await serveProxy();
    const origin = await serveHttp((req, res) => { res.end('proxied'); });

    const res = await httpGetText(`${origin.url}/feed.yml`, { env: { HTTP_PROXY: proxy.url } });
    assert.equal(res.body, 'proxied');
    assert.equal(proxy.record.length, 1);
    assert.equal(proxy.record[0].method, 'GET');
    // Absolute-form request line: the proxy has to be told the full URL.
    assert.equal(proxy.record[0].url, `${origin.url}/feed.yml`);
  });

  it('tunnels HTTPS with CONNECT and then speaks TLS inside it', { skip: !makeCert() ? 'openssl is not available to generate a test certificate' : false }, async () => {
    const certs = makeCert();
    const server = https.createServer({ key: certs.key, cert: certs.cert }, (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('tunnelled TLS');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    cleanup.push(() => new Promise((r) => server.close(r)));
    const { port } = server.address();

    const proxy = await serveProxy();
    // `localhost`, not 127.0.0.1: SNI needs a name, and the generated
    // certificate carries it as a subjectAltName.
    const res = await httpGetText(`https://localhost:${port}/feed.yml`, {
      env: { HTTPS_PROXY: proxy.url },
      ca: certs.cert,
    });

    assert.equal(res.body, 'tunnelled TLS');
    // The proxy saw a CONNECT to the real origin, not a plain request.
    assert.equal(proxy.record.length, 1);
    assert.equal(proxy.record[0].method, 'CONNECT');
    assert.equal(proxy.record[0].url, `localhost:${port}`);
  });

  it('reports a proxy that refuses the tunnel, rather than hanging', async () => {
    const proxy = await serveProxy({ refuse: true });
    await assert.rejects(
      () => httpGetText('https://localhost:1/x', { env: { HTTPS_PROXY: proxy.url }, timeoutMs: 5000 }),
      /proxy refused CONNECT \(403/,
    );
  });

  it('always refuses to downgrade HTTPS to HTTP, whatever the caller says', { skip: !makeCert() ? 'openssl is not available to generate a test certificate' : false }, async () => {
    /*
     * Built in rather than delegated to the caller, because it is universally
     * wrong: anyone who can answer for the original host could otherwise strip
     * TLS from a download by redirecting to a plain-HTTP URL, and the caller
     * would have no way to notice. Needs a real TLS origin to set it up, since
     * http -> http is not a downgrade.
     */
    const certs = makeCert();
    const server = https.createServer({ key: certs.key, cert: certs.cert }, (req, res) => {
      res.writeHead(302, { location: 'http://127.0.0.1:1/plain' });
      res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    cleanup.push(() => new Promise((r) => server.close(r)));
    const { port } = server.address();

    await assert.rejects(
      () => httpGetText(`https://localhost:${port}/from`, { env: {}, ca: certs.cert }),
      /refusing to follow an HTTPS redirect down to http:/,
    );
  });

  it('sends proxy credentials when the proxy URL carries them', async () => {
    const proxy = await serveProxy();
    const origin = await serveHttp((req, res) => { res.end('ok'); });
    await httpGetText(`${origin.url}/x`, { env: { HTTP_PROXY: `http://user:pa%40ss@127.0.0.1:${proxy.port}` } });

    const expected = `Basic ${Buffer.from('user:pa@ss').toString('base64')}`;
    assert.equal(proxy.record[0].headers['proxy-authorization'], expected);
  });
});

describe('downloading to a file', () => {
  it('streams the body to disk and reports the byte count', async () => {
    const body = 'installer-bytes'.repeat(1000);
    const { url } = await serveHttp((req, res) => {
      res.writeHead(200, { 'content-length': String(body.length) });
      res.end(body);
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshcp-dl-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dest = path.join(dir, 'nested', 'installer.bin');

    const res = await httpDownload(`${url}/installer.bin`, dest, { env: {} });
    assert.equal(res.bytes, body.length);
    assert.equal(fs.readFileSync(dest, 'utf8'), body);
  });

  it('leaves nothing behind when the download fails', async () => {
    const { url } = await serveHttp((req, res) => {
      res.writeHead(404);
      res.end('nope');
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshcp-dl-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dest = path.join(dir, 'installer.bin');

    await assert.rejects(() => httpDownload(`${url}/x`, dest, { env: {} }), /HTTP 404/);
    // A partial or refused download must not be left looking like an installer.
    assert.equal(fs.existsSync(dest), false);
  });
});
