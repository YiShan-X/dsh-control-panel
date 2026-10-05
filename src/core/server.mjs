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
import { dshWebStatus } from './dsh.mjs';
import { buildMcpState, setMcpEnabled } from './mcp.mjs';
import { buildPluginState, removePlugin, resolveDshLauncher } from './plugins.mjs';
import { buildPanelUpdateState, downloadPanelUpdate } from './panelUpdate.mjs';
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
 * @property {boolean} [packaged]         Whether this host is an installed app.
 *   Only a packaged host can replace itself, so a source checkout reports that
 *   instead of offering a download it cannot use.
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

  /**
   * When the running `dsh web` booted, or null when nothing is running -- and
   * also when the host was told not to probe at all (`DSH_PANEL_PROBE_WEB=0`).
   * Both read as "no boot time to compare against", which is the honest answer
   * in each case: the restart banners stay quiet rather than guessing.
   *
   * @param {{fresh?: boolean}} [opts]
   * @returns {string|null}
   */
  function readDshStartedAt(opts = {}) {
    if (config.probeWeb === false) return null;
    return dshWebStatus(opts).startedAt;
  }

  async function buildState(opts = {}) {
    const fresh = opts.force === true;
    // One probe per request, reused by the MCP and plugin restart comparisons
    // below: one OS call, not three.
    const dshWebStartedAt = readDshStartedAt({ fresh });
    const skills = await buildSkillState(config);
    const mcp = await buildMcpState(config, { dshWebStartedAt });
    // Plugins live in the profile manifests, so this is a directory read, not a
    // process probe. The boot time it is handed is only used for the "a plugin
    // changed since dsh web started" comparison.
    const plugins = await buildPluginState(config, { dshWebStartedAt });
    // The panel's own version. The network half is only reached when the user
    // asks: `release` is left false here.
    const panelUpdate = await buildPanelUpdateState(config, {
      current: version,
      fresh,
      packaged: options.packaged === true,
    });
    const restartPending = Boolean(
      mcp.patchMtime && dshWebStartedAt && new Date(mcp.patchMtime) > new Date(dshWebStartedAt),
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
        dshWebStartedAt,
        restartPending,
        files: mcp.files,
      },
      plugins: plugins.plugins,
      pluginProfiles: plugins.profiles,
      pluginsMeta: {
        profilesDir: config.profilesDir,
        manifestMtime: plugins.manifestMtime,
        dshWebStartedAt: plugins.dshWebStartedAt,
        restartPending: plugins.restartPending,
        // A host without a resolvable `dsh` can still list every plugin; the UI
        // says why uninstalling is unavailable instead of offering a button
        // that 501s. Resolved once here, not per row.
        canRemove: resolveDshLauncher() !== null,
      },
      // Which panel is running, and whether a newer release exists. Every field
      // is an observation, and the failure of a check is a value here rather
      // than an exception.
      panelUpdate,
      paths: {
        home: config.home,
        dshHome: config.dshHome,
        dshSkills: config.dshSkills,
        ccHome: config.ccHome,
        ccDb: config.ccDb,
        ccSkills: config.ccSkills,
        patchFile: config.patchFile,
        disabledFile: config.disabledFile,
        profilesDir: config.profilesDir,
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

      // Plugin uninstall. `removePlugin` re-validates both the profile and the
      // package against what is installed on disk before spawning anything, so
      // this route cannot be turned into "run pnpm on an arbitrary spec" --
      // which is the one thing a localhost route any web page can POST to must
      // never become. See plugins.mjs for the full reasoning.
      if (route === 'POST /api/plugins/remove') {
        const { profile, name } = await readBody(req);
        const result = await removePlugin(config, String(profile ?? ''), String(name ?? ''));
        return sendJson(res, 200, { ok: true, restartRequired: true, ...result });
      }

      // Which panel release exists. Off the `/api/state` poll path because the
      // poll must not wait on the network.
      if (route === 'GET /api/panel/release') {
        const fresh = url.searchParams.get('fresh') === '1';
        const panelUpdate = await buildPanelUpdateState(config, {
          current: version,
          fresh,
          release: true,
          packaged: options.packaged === true,
        });
        return sendJson(res, 200, { ok: true, panelUpdate });
      }

      // Download the newest installer and hand it to the OS.
      //
      // Deliberately 501 for a source checkout: there is no installed app to
      // replace, and downloading an installer for a program the user is not
      // running would be busywork dressed up as an update. The response says
      // what to do instead.
      if (route === 'POST /api/panel/update') {
        if (options.packaged !== true) {
          throw new HttpError(
            501,
            'this panel is running from a source checkout, so there is no installation to replace; pull the repository and reinstall dependencies instead',
          );
        }
        const result = await downloadPanelUpdate(config, {
          current: version,
          packaged: true,
        });
        // Opening the file is what actually starts the installer. A host
        // without `openPath` still gets the download and the path, so the user
        // can run it -- reported as `launched: false` rather than assumed.
        let launched = false;
        let openError = null;
        if (options.openPath) {
          openError = await options.openPath(result.file);
          launched = !openError;
        }
        const panelUpdate = await buildPanelUpdateState(config, {
          current: version,
          fresh: false,
          packaged: true,
        });
        return sendJson(res, 200, {
          ok: true,
          ...result,
          launched,
          openError: openError ? String(openError) : null,
          panelUpdate,
        });
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
    profilesDir: config.profilesDir,
  };
  if (Object.hasOwn(table, String(target))) return table[String(target)];
  if (String(target).startsWith('pool:')) {
    const pool = config.pools.find((p) => p.id === String(target).slice('pool:'.length));
    if (pool) return pool.dir;
  }
  // `profile:<name>` is a real profile directory, and only a real one: the
  // manifest has to be there, so a crafted name cannot open an arbitrary path.
  if (String(target).startsWith('profile:')) {
    const name = String(target).slice('profile:'.length);
    if (/^[A-Za-z0-9._-]+$/.test(name) && !name.startsWith('.')) {
      const dir = path.join(config.profilesDir, name);
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    }
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
