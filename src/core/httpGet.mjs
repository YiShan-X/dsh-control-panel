/**
 * A dependency-free HTTP(S) GET that honours the proxy environment.
 *
 * Why this exists at all: `src/core/` may not import `node_modules`, and Node's
 * global `fetch` (undici) **does not read `HTTP_PROXY`/`HTTPS_PROXY`**. The DSH
 * version card sidesteps that by shelling out to the user's own `npm`, which
 * already understands proxies, mirrors and auth. The panel's *own* update check
 * has no such tool to lean on -- GitHub is not something npm fetches -- so this
 * module implements the part that is actually needed: one GET, following
 * redirects, optionally through a proxy.
 *
 * Proxy handling is deliberately the plain, well-trodden subset:
 *
 *   - `https://` targets through a proxy use `CONNECT` and then a normal TLS
 *     handshake inside the tunnel.
 *   - `http://` targets use an absolute-form request line, which is what RFC
 *     7230 specifies for a plain-HTTP proxy.
 *   - `https://` *proxy URLs* (TLS to the proxy itself) are supported too, since
 *     some corporate setups require it.
 *
 * What it deliberately does **not** do: connection pooling, HTTP/2, cookies,
 * decompression, or certificate workarounds. A release feed is a few hundred
 * bytes fetched twice a day; the simple implementation is the one that can be
 * read in full.
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';
import { URL } from 'node:url';

/** Bounded so a slow or hostile endpoint cannot wedge a route forever. */
export const DEFAULT_TIMEOUT_MS = 20000;

/** A release installer is ~100-250 MB; downloading needs its own, longer cap. */
export const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

/** Redirects are followed, but not indefinitely. */
const MAX_REDIRECTS = 5;

/**
 * Find the proxy for a target URL, or null for a direct connection.
 *
 * Both cases of each variable are honoured, because the two conventions differ:
 * curl reads only the lowercase forms (uppercase `HTTP_PROXY` is ignored on
 * purpose to stop a CGI environment leaking a proxy into requests), while most
 * Windows tooling and this project's own instructions set the uppercase ones.
 * Reading both is what makes "set HTTPS_PROXY and it works" true.
 *
 * `NO_PROXY` is honoured too -- a host listed there is fetched directly even
 * when a proxy is configured, which is what makes a local mirror usable.
 *
 * @param {string} target
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{url: string, source: string}|null}
 */
export function proxyFor(target, env = process.env) {
  const url = new URL(target);
  if (isExempt(url, env)) return null;

  const secure = url.protocol === 'https:';
  // Ordered most-specific first; the first non-empty value wins.
  const keys = secure
    ? ['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'http_proxy', 'HTTP_PROXY']
    : ['http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'];

  for (const key of keys) {
    const value = String(env[key] ?? '').trim();
    if (!value) continue;
    return { url: normaliseProxy(value), source: key };
  }
  return null;
}

/** Accept a bare `host:port` as well as a full URL, the way curl does. */
export function normaliseProxy(value) {
  const raw = String(value).trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  return `http://${raw}`;
}

/**
 * Should this host bypass the proxy?
 *
 * Mirrors the de-facto `NO_PROXY` grammar: `*` for everything, and entries that
 * are a hostname, a `.suffix` or `host:port`. A port-qualified entry only
 * matches that port.
 *
 * @param {URL} url
 * @param {NodeJS.ProcessEnv} env
 */
export function isExempt(url, env = process.env) {
  const raw = env.no_proxy ?? env.NO_PROXY ?? '';
  const entries = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0) return false;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');

  for (const entry of entries) {
    if (entry === '*') return true;

    const [entryHost, entryPort] = splitHostPort(entry);
    if (!entryHost) continue;
    if (entryPort && entryPort !== port) continue;

    const pattern = entryHost.toLowerCase().replace(/^\*\./, '.');
    if (pattern.startsWith('.')) {
      // `.example.com` covers the domain and every subdomain, not the bare name
      // only -- that is what the leading dot means in this grammar.
      if (host === pattern.slice(1) || host.endsWith(pattern)) return true;
    } else if (host === pattern || host.endsWith(`.${pattern}`)) {
      return true;
    }
  }
  return false;
}

/** Split `host:port`, keeping IPv6 literals in brackets intact. */
function splitHostPort(entry) {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
  if (m) return [m[1], m[2]];
  const idx = entry.lastIndexOf(':');
  if (idx > 0 && entry.indexOf(':') === idx) return [entry.slice(0, idx), entry.slice(idx + 1)];
  return [entry, null];
}

/** Basic auth for a proxy URL that carries credentials. */
function proxyHeaders(proxyUrl) {
  const p = new URL(proxyUrl);
  if (!p.username && !p.password) return {};
  const user = decodeURIComponent(p.username);
  const pass = decodeURIComponent(p.password);
  return { 'proxy-authorization': `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` };
}

/**
 * Open a `CONNECT` tunnel and wrap it in TLS.
 *
 * Resolves with a connected, authenticated TLS socket that a normal
 * `https.request` can speak over. `head` matters: the proxy is allowed to send
 * the first bytes of the tunnelled stream in the same packet as its 200
 * response, and dropping them corrupts the TLS handshake.
 *
 * @param {string} proxyUrl
 * @param {URL} target
 * @param {number} timeoutMs
 * @param {string|Buffer} [ca] Extra CA to trust. Needed when the proxy inspects
 *   TLS (a corporate MITM appliance re-signs the connection, so the certificate
 *   the client sees is the proxy's, not GitHub's) and used by the tests to trust
 *   a throwaway local certificate.
 * @returns {Promise<import('node:tls').TLSSocket>}
 */
function connectTunnel(proxyUrl, target, timeoutMs, ca) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyUrl);
    const secureProxy = p.protocol === 'https:';
    const proxyPort = Number(p.port) || (secureProxy ? 443 : 80);
    const targetPort = Number(target.port) || 443;

    const headers = {
      host: `${target.hostname}:${targetPort}`,
      'proxy-connection': 'keep-alive',
      ...proxyHeaders(proxyUrl),
    };

    const send = secureProxy ? https.request : http.request;
    const req = send({
      hostname: p.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: `${target.hostname}:${targetPort}`,
      headers,
      timeout: timeoutMs,
      ...(ca ? { ca } : {}),
    });

    req.on('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy refused CONNECT (${res.statusCode} ${res.statusMessage ?? ''})`.trim()));
        return;
      }
      if (head && head.length) socket.unshift(head);
      const secure = tls.connect(
        { socket, servername: target.hostname, ...(ca ? { ca } : {}) },
        () => resolve(secure),
      );
      secure.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`proxy CONNECT timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end();
  });
}

/**
 * One request, no redirect following. Resolves with the response stream so the
 * caller can either collect it or pipe it to a file.
 *
 * @param {string} target
 * @param {{headers?: Record<string,string>, timeoutMs?: number, proxy?: {url: string}|null,
 *          env?: NodeJS.ProcessEnv, ca?: string|Buffer}} [opts]
 * @returns {Promise<{status: number, headers: Record<string,string>, stream: NodeJS.ReadableStream, url: string}>}
 */
export async function openStream(target, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = opts.env ?? process.env;
  const proxy = opts.proxy !== undefined ? opts.proxy : proxyFor(target, env);
  const ca = opts.ca;
  const url = new URL(target);
  const secure = url.protocol === 'https:';
  const port = Number(url.port) || (secure ? 443 : 80);
  const headers = { host: url.host, ...opts.headers };

  return new Promise((resolve, reject) => {
    const onResponse = (res) => resolve({
      status: res.statusCode ?? 0,
      headers: res.headers,
      stream: res,
      url: target,
    });
    const onError = (err) => reject(err);

    if (!proxy) {
      const send = secure ? https.request : http.request;
      const req = send({
        hostname: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers,
        timeout: timeoutMs,
        ...(ca ? { ca } : {}),
      });
      req.on('response', onResponse);
      req.on('timeout', () => req.destroy(new Error(`request timed out after ${timeoutMs} ms`)));
      req.on('error', onError);
      req.end();
      return;
    }

    if (!secure) {
      // Plain HTTP through a proxy: the request line carries the absolute URL.
      const p = new URL(proxy.url);
      const req = http.request({
        hostname: p.hostname,
        port: Number(p.port) || 80,
        path: target,
        method: 'GET',
        headers: { ...headers, ...proxyHeaders(proxy.url) },
        timeout: timeoutMs,
      });
      req.on('response', onResponse);
      req.on('timeout', () => req.destroy(new Error(`request timed out after ${timeoutMs} ms`)));
      req.on('error', onError);
      req.end();
      return;
    }

    // HTTPS through a proxy: tunnel first, then speak TLS inside it.
    connectTunnel(proxy.url, url, timeoutMs, ca).then((socket) => {
      const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
      // The one hook that lets a pre-made socket be used: `options.createConnection`
      // on the *request* is ignored (the agent's own method wins), so the agent
      // instance is the place to override it.
      agent.createConnection = () => socket;
      const req = https.request({
        hostname: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers,
        agent,
        timeout: timeoutMs,
        ...(ca ? { ca } : {}),
      });
      req.on('response', onResponse);
      req.on('timeout', () => { req.destroy(new Error(`request timed out after ${timeoutMs} ms`)); socket.destroy(); });
      req.on('error', onError);
      req.end();
    }, reject);
  });
}

/**
 * GET a URL as text, following redirects.
 *
 * @param {string} target
 * @param {{headers?: Record<string,string>, timeoutMs?: number, env?: NodeJS.ProcessEnv,
 *          maxRedirects?: number, maxBytes?: number, onRedirect?: (url: string) => void}} [opts]
 * @returns {Promise<{status: number, headers: Record<string,string>, body: string, url: string}>}
 */
export async function httpGetText(target, opts = {}) {
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  let current = target;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const res = await openStream(current, opts);
    const location = res.headers.location;
    if (isRedirect(res.status) && location) {
      await drain(res.stream);
      const next = new URL(location, current).href;
      followRedirect(current, next, opts);
      current = next;
      continue;
    }

    const chunks = [];
    let total = 0;
    for await (const chunk of res.stream) {
      total += chunk.length;
      if (total > maxBytes) {
        res.stream.destroy();
        throw new Error(`response exceeded ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
    return { status: res.status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), url: current };
  }
  throw new Error(`too many redirects (more than ${maxRedirects})`);
}

/**
 * Stream a URL to a file, following redirects.
 *
 * Streamed rather than buffered because an installer is hundreds of megabytes,
 * and a 250 MB Buffer in the panel's own process to hand to the filesystem is
 * exactly the kind of thing that makes an Electron app look broken.
 *
 * @returns {Promise<{status: number, bytes: number, url: string, headers: Record<string,string>}>}
 */
export async function httpDownload(target, destPath, opts = {}) {
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  let current = target;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const res = await openStream(current, { ...opts, timeoutMs: opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS });
    const location = res.headers.location;
    if (isRedirect(res.status) && location) {
      await drain(res.stream);
      const next = new URL(location, current).href;
      followRedirect(current, next, opts);
      current = next;
      continue;
    }
    if (res.status !== 200) {
      await drain(res.stream);
      throw new Error(`download failed with HTTP ${res.status}`);
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const out = fs.createWriteStream(destPath);
    let bytes = 0;
    try {
      for await (const chunk of res.stream) {
        bytes += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    } catch (err) {
      res.stream.destroy();
      out.destroy();
      // A partial download is not a file worth keeping: leaving it behind would
      // let a later attempt see a plausible-looking but truncated installer.
      fs.rmSync(destPath, { force: true });
      throw err;
    }
    return { status: res.status, bytes, url: current, headers: res.headers };
  }
  throw new Error(`too many redirects (more than ${maxRedirects})`);
}

/**
 * Refuse to follow a redirect somewhere a release asset can never be.
 *
 * This is *policy for the panel update path*, handed to the client as
 * `onRedirect` rather than applied inside it: the client is generic HTTP
 * machinery, and a caller fetching something that is not a GitHub release should
 * not inherit this rule.
 *
 * The update route builds its download URL from a release feed, and a redirect
 * is the one place an attacker-influenced value could move the request to an
 * arbitrary host. GitHub serves assets from `github.com` and hands off to
 * `*.githubusercontent.com`, so anything else is a bug or an attack.
 */
export function assertFollowable(urlString) {
  const url = new URL(urlString);
  if (url.protocol !== 'https:') throw new Error(`refusing to follow a non-HTTPS redirect to ${url.origin}`);
  const host = url.hostname.toLowerCase();
  const ok = host === 'github.com'
    || host === 'api.github.com'
    || host.endsWith('.githubusercontent.com');
  if (!ok) throw new Error(`refusing to follow a redirect off GitHub (${host})`);
}

/**
 * Decide whether a redirect may be followed.
 *
 * Two rules, and the split matters:
 *
 *   - **Refusing to downgrade HTTPS to HTTP is built in**, because it is
 *     universally wrong: it would let anyone who can answer for the original
 *     host strip TLS from a download.
 *   - **Everything else is the caller's policy.** This module is generic HTTP
 *     machinery -- what counts as an acceptable destination depends on what is
 *     being fetched. The panel update path passes `assertFollowable` below,
 *     because an installer's URL must stay on GitHub; a caller fetching
 *     something else should not inherit that rule.
 *
 * @param {string} from
 * @param {string} to
 * @param {{onRedirect?: (url: string) => void}} opts
 */
function followRedirect(from, to, opts) {
  if (new URL(from).protocol === 'https:' && new URL(to).protocol !== 'https:') {
    throw new Error(`refusing to follow an HTTPS redirect down to ${new URL(to).protocol}`);
  }
  opts.onRedirect?.(to);
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Read and discard a body so the socket can be reused or closed cleanly. */
async function drain(stream) {
  try {
    for await (const _ of stream) { /* discard */ }
  } catch { /* the connection is going away anyway */ }
}
