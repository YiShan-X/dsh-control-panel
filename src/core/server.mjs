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
import {
  dshWebStatus,
  getLastStartError,
  restartDshWeb,
  startCommandInfo,
  startDshWeb,
  stopDshWeb,
} from './dsh.mjs';
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
 * @typedef {object} DshControl
 * @property {() => import('./dsh.mjs').DshWebStatus} status   Current status snapshot.
 * @property {() => Promise<any>} start
 * @property {() => Promise<any>} stop
 * @property {() => Promise<any>} restart
 */

/**
 * @typedef {object} PanelServerOptions
 * @property {string} publicDir           Directory holding index.html.
 * @property {string} [version]           Version string shown in the UI footer.
 * @property {(p: string) => any} [openPath]  Hook for "reveal in file manager".
 * @property {() => Promise<any>} [restartHook] Optional "restart dsh web" action.
 * @property {DshControl} [dshControl]    Process control for the DSH tab. Without
 *   it every `/api/dsh/*` route answers 501 and the UI shows the buttons
 *   disabled with a reason -- a host that cannot manage a process must never
 *   pretend it can.
 */

/** The control bundle a host gets when it wires nothing up. */
const NO_DSH_CONTROL = null;

/**
 * What the status looks like when the host was told not to probe at all
 * (`DSH_PANEL_PROBE_WEB=0`). `probed: false` is the honest part: "unknown" is
 * not the same answer as "not running", and the UI says so.
 * @type {import('./dsh.mjs').DshWebStatus & {probed: boolean}}
 */
const NOT_PROBED = {
  running: false,
  pid: null,
  cmdline: null,
  startedAt: null,
  uptimeMs: null,
  cpuMs: null,
  rssBytes: null,
  probeMs: 0,
  probed: false,
};

/**
 * @param {import('./config.mjs').PanelConfig} config
 * @param {PanelServerOptions} options
 */
export function createPanelServer(config, options) {
  const publicDir = path.resolve(options.publicDir);
  const version = options.version ?? '0.0.0';
  const dshControl = options.dshControl ?? NO_DSH_CONTROL;
  const canControlDsh = Boolean(dshControl);

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

  /**
   * Build the whole payload the UI renders from.
   *
   * @param {{force?: boolean}} [opts] `force` bypasses the process-probe cache,
   *   which is what the refresh button and every DSH action want: the user asked
   *   a question, so the answer must be observed now, not up to 15 s ago.
   */
  /**
   * Read the status the host is able to report.
   *
   * @param {{fresh?: boolean}} [opts]
   * @returns {import('./dsh.mjs').DshWebStatus}
   */
  function readDshStatus(opts = {}) {
    if (dshControl) return dshControl.status(opts);
    if (config.probeWeb === false) return NOT_PROBED;
    return dshWebStatus(opts);
  }

  async function buildState(opts = {}) {
    const fresh = opts.force === true;
    const dsh = readDshStatus({ fresh });
    const skills = await buildSkillState(config);
    // Reuse the probe above for the MCP restart comparison: one OS call per
    // request, not two.
    const mcp = await buildMcpState(config, { dshWebStartedAt: dsh.startedAt });
    const start = startCommandInfo();
    const restartPending = Boolean(
      mcp.patchMtime && dsh.startedAt && new Date(mcp.patchMtime) > new Date(dsh.startedAt),
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
        dshWebStartedAt: dsh.startedAt,
        restartPending,
        // Only hosts that wired a `restartHook` can satisfy a click on the
        // banner's "Restart dsh web now" button; CLI mode deliberately does
        // not, so the UI shows the manual instruction instead.
        canRestart: typeof options.restartHook === 'function',
        files: mcp.files,
      },
      dsh: {
        ...dsh,
        canStart: canControlDsh,
        canStop: canControlDsh,
        canRestart: canControlDsh,
        startCommand: start.command,
        startCommandSource: start.source,
        lastStartError: getLastStartError(),
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
      if (route === 'GET /api/state') {
        // `?fresh=1` forces a process probe. The UI sends it for an explicit
        // refresh and right after a DSH action, where the cached answer is
        // exactly the stale one the user is trying to get rid of.
        const fresh = url.searchParams.get('fresh') === '1';
        return sendJson(res, 200, await buildState({ force: fresh }));
      }

      // Answer the browser's automatic favicon probe quietly. A 404 here logs a
      // console error, which would trip the desktop smoke test's "no renderer
      // errors" assertion for a reason that has nothing to do with a bug.
      if (route === 'GET /favicon.ico') {
        res.writeHead(204, 'cache-control: max-age=86400');
        return res.end();
      }

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

      // The "restart dsh web now" button lives in the MCP tab's restart banner.
      // It only does anything in hosts that wired a `restartHook` -- a host
      // that cannot manage processes degrades to a clear 501 instead of
      // silently doing nothing.
      if (route === 'POST /api/restart') {
        if (!options.restartHook) throw new HttpError(501, 'this host cannot restart dsh web');
        const result = await options.restartHook();
        return sendJson(res, 200, { ok: true, ...result });
      }

      // DSH service control, used by the DSH tab. A host without `dshControl`
      // (a plain browser-launched panel that was not asked to manage anything)
      // answers 501 for all three, so the UI can say "this host cannot" rather
      // than offering a button that fails.
      if (route === 'POST /api/dsh/start') {
        if (!dshControl) throw new HttpError(501, 'this host cannot start dsh web');
        const result = await dshControl.start();
        return sendJson(res, 200, { ok: true, ...result });
      }
      if (route === 'POST /api/dsh/stop') {
        if (!dshControl) throw new HttpError(501, 'this host cannot stop dsh web');
        const result = await dshControl.stop();
        return sendJson(res, 200, { ok: true, ...result });
      }
      if (route === 'POST /api/dsh/restart') {
        if (!dshControl) throw new HttpError(501, 'this host cannot restart dsh web');
        const result = await dshControl.restart();
        return sendJson(res, 200, { ok: true, ...result });
      }
      // The status probe on its own, for a caller that wants a cheap answer
      // without the skill/MCP filesystem walk.
      if (route === 'GET /api/dsh/status') {
        const fresh = url.searchParams.get('fresh') === '1';
        const status = readDshStatus({ fresh });
        return sendJson(res, 200, { ok: true, ...status, canControl: canControlDsh });
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
