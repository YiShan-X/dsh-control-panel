/**
 * The HTTP layer.
 *
 * Deliberately a factory rather than a script: the desktop app starts this on
 * an ephemeral port inside its own process, while `src/cli.mjs` starts it on a
 * fixed port for browser use. Both share exactly one implementation.
 */

import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { HttpError } from './errors.mjs';
import { buildMcpState, setMcpEnabled } from './mcp.mjs';
import { buildSkillState, disableSkill, enableSkill } from './skills.mjs';
import { log } from './util.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

/**
 * @typedef {object} PanelServerOptions
 * @property {string} publicDir           Directory holding index.html.
 * @property {string} [version]           Version string shown in the UI footer.
 * @property {(p: string) => any} [openPath]  Hook for "reveal in file manager".
 * @property {() => Promise<any>} [restartHook] Optional "restart dsh web" action.
 */

/**
 * @param {import('./config.mjs').PanelConfig} config
 * @param {PanelServerOptions} options
 */
export function createPanelServer(config, options) {
  const publicDir = path.resolve(options.publicDir);
  const version = options.version ?? '0.0.0';

  function serveStatic(res, urlPath) {
    const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
    const full = path.join(publicDir, rel);
    // Path traversal guard: the resolved file must stay inside public/.
    const root = publicDir.endsWith(path.sep) ? publicDir : publicDir + path.sep;
    if (full !== publicDir && !full.startsWith(root)) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    let data;
    try { data = fs.readFileSync(full); } catch { return sendJson(res, 404, { error: 'not found' }); }
    res.writeHead(200, {
      'content-type': MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  }

  async function buildState() {
    const skills = await buildSkillState(config);
    const mcp = await buildMcpState(config);
    const restartPending = Boolean(
      mcp.patchMtime && mcp.dshWebStartedAt && new Date(mcp.patchMtime) > new Date(mcp.dshWebStartedAt),
    );
    return {
      version,
      platform: process.platform,
      runtime: {
        node: process.versions.node,
        electron: process.versions.electron ?? null,
      },
      skills: skills.skills,
      skillSummary: skills.summary,
      repos: skills.repos,
      ccSwitch: skills.ccSwitch,
      duplicates: skills.duplicates,
      mcp: mcp.mcp,
      mcpMeta: {
        patchMtime: mcp.patchMtime,
        disabledMtime: mcp.disabledMtime,
        dshWebStartedAt: mcp.dshWebStartedAt,
        restartPending,
        files: mcp.files,
      },
      paths: {
        home: config.home,
        dshHome: config.dshHome,
        dshSkills: config.dshSkills,
        ccHome: config.ccHome,
        ccDb: config.ccDb,
        ccSkills: config.ccSkills,
        patchFile: config.patchFile,
        disabledFile: config.disabledFile,
      },
      pools: config.pools,
      pollMs: config.pollMs,
    };
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = `${req.method} ${url.pathname}`;

    try {
      if (route === 'GET /api/health') return sendJson(res, 200, { ok: true, version });
      if (route === 'GET /api/state') return sendJson(res, 200, await buildState());

      if (route === 'POST /api/skills/toggle') {
        const { key, enabled, poolDir } = await readBody(req);
        if (!key || typeof key !== 'string') throw new HttpError(400, 'key is required');
        ensureSafeName(key);
        const result = enabled
          ? enableSkill(config, key, poolDir)
          : disableSkill(config, key);
        return sendJson(res, 200, { ok: true, ...result, live: true });
      }

      if (route === 'POST /api/skills/bulk') {
        const body = await readBody(req);
        const items = Array.isArray(body.items)
          ? body.items
          : (Array.isArray(body.keys) ? body.keys.map((key) => ({ key })) : null);
        if (!items) throw new HttpError(400, 'items (or keys) must be an array');
        if (items.length > 500) throw new HttpError(400, 'refusing to touch more than 500 skills at once');
        const enabled = Boolean(body.enabled);
        const results = [];
        for (const item of items) {
          const key = typeof item === 'string' ? item : item?.key;
          try {
            ensureSafeName(key);
            const r = enabled
              ? enableSkill(config, key, typeof item === 'object' ? item.poolDir : undefined)
              : disableSkill(config, key);
            results.push({ key, ok: true, ...r });
          } catch (err) {
            results.push({ key, ok: false, error: err.message });
          }
        }
        return sendJson(res, 200, {
          ok: true,
          results,
          changed: results.filter((r) => r.ok && r.changed).length,
          failed: results.filter((r) => !r.ok).length,
          live: true,
        });
      }

      if (route === 'POST /api/mcp/toggle') {
        const { key, enabled } = await readBody(req);
        if (!key || typeof key !== 'string') throw new HttpError(400, 'key is required');
        ensureSafeName(key);
        const result = await setMcpEnabled(config, key, Boolean(enabled));
        return sendJson(res, 200, { ok: true, ...result, restartRequired: true });
      }

      if (route === 'POST /api/open') {
        const { target } = await readBody(req);
        // Validate the target BEFORE asking the host to act: the allow-list is
        // a security boundary and must hold even on a host that cannot open
        // paths yet.
        const resolved = resolveOpenTarget(config, target);
        if (!resolved) throw new HttpError(400, `unknown target ${JSON.stringify(target)}`);
        if (!options.openPath) throw new HttpError(501, 'this host cannot open paths');
        const err = await options.openPath(resolved);
        return sendJson(res, 200, { ok: true, path: resolved, error: err ? String(err) : null });
      }

      if (req.method === 'GET') return serveStatic(res, url.pathname);
      return sendJson(res, 404, { error: `no route for ${route}` });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log(`ERROR ${route}: ${err.stack || err.message}`);
      return sendJson(res, status, { error: err.message });
    }
  });

  return { server, config, buildState };
}

/**
 * Only known, named locations may be opened -- never a caller-supplied path.
 * Without this the API would be a "launch anything" primitive, which matters
 * even on localhost because any web page can POST to a localhost port.
 */
function resolveOpenTarget(config, target) {
  const table = {
    home: config.home,
    dshHome: config.dshHome,
    dshSkills: config.dshSkills,
    patchFile: config.patchFile,
    disabledFile: config.disabledFile,
    ccHome: config.ccHome,
    ccSkills: config.ccSkills,
    ccDb: config.ccDb,
  };
  if (Object.hasOwn(table, String(target))) return table[String(target)];
  if (String(target).startsWith('pool:')) {
    const pool = config.pools.find((p) => p.id === String(target).slice('pool:'.length));
    if (pool) return pool.dir;
  }
  return null;
}

/**
 * Skill directory names and block ids are single path segments by construction.
 * Rejecting separators and `..` here keeps every later `path.join` safe.
 */
function ensureSafeName(name) {
  if (
    typeof name !== 'string'
    || name === ''
    || name === '.'
    || name === '..'
    || name.includes('/')
    || name.includes('\\')
    || name.includes('\0')
  ) {
    throw new HttpError(400, `unsafe name ${JSON.stringify(name)}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new HttpError(400, `name ${JSON.stringify(name)} contains unsupported characters`);
  }
}

/**
 * Start listening.
 *
 * Port 0 asks the OS for a free port, which is what the desktop app wants so it
 * can never collide with the browser-mode server or another instance.
 *
 * @returns {Promise<{port: number, host: string, url: string, close: () => Promise<void>}>}
 */
export function listen(server, { host = '127.0.0.1', port = 8791 } = {}) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.off('listening', onListening); reject(err); };
    const onListening = () => {
      server.off('error', onError);
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      const actualHost = typeof addr === 'object' && addr ? addr.address : host;
      resolve({
        port: actualPort,
        host: actualHost,
        url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}
