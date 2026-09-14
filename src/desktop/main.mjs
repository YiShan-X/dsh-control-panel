/**
 * Electron main process.
 *
 * The desktop build is a thin shell around the same core the browser build
 * uses: start the panel server on an ephemeral loopback port inside this
 * process, then point a window at it. Nothing about the data model changes, and
 * there is no second implementation to keep in sync.
 *
 * Ephemeral port (0) is deliberate. It means the desktop window can never
 * collide with a browser-mode server, a second desktop instance, or whatever
 * else already owns 8791.
 */

import { app, BrowserWindow, Menu, dialog, nativeTheme, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../core/config.mjs';
import { createPanelServer, listen } from '../core/server.mjs';
import { log } from '../core/util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const REPO_URL = 'https://github.com/YiShan-X/dsh-control-panel';

/** @type {{url: string, close: () => Promise<void>}|null} */
let bound = null;
/** @type {BrowserWindow|null} */
let win = null;
/** @type {string|null} */
let logFile = null;
/** Renderer console errors seen during a smoke run. Any entry fails the run. */
const rendererErrors = [];

// ---------------------------------------------------------------------------
// Logging: a packaged GUI app has no console, so keep a file for support.
// ---------------------------------------------------------------------------

function installFileLogging() {
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'panel.log');
    // Truncate on each launch -- this is a support aid, not an audit trail.
    fs.writeFileSync(logFile, `--- DSH Control Panel ${app.getVersion()} ---\n`, 'utf8');
  } catch {
    logFile = null;
    return;
  }

  const original = console.log.bind(console);
  console.log = (...args) => {
    original(...args);
    if (!logFile) return;
    try {
      fs.appendFileSync(logFile, `${args.map(fmt).join(' ')}\n`, 'utf8');
    } catch { /* logging must never break the app */ }
  };
}

function fmt(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

// ---------------------------------------------------------------------------
// Window state
// ---------------------------------------------------------------------------

function statePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  const fallback = { width: 1240, height: 860 };
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    const state = {
      width: Number(raw.width) || fallback.width,
      height: Number(raw.height) || fallback.height,
    };
    if (Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
      state.x = raw.x;
      state.y = raw.y;
    }
    if (raw.maximized) state.maximized = true;
    return state;
  } catch {
    return fallback;
  }
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  try {
    const bounds = win.getNormalBounds();
    fs.writeFileSync(
      statePath(),
      JSON.stringify({ ...bounds, maximized: win.isMaximized() }, null, 2),
      'utf8',
    );
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function createWindow() {
  // Documentation screenshots need a fixed, reproducible frame; a normal
  // launch restores whatever the user last dragged the window to.
  const capturing = Boolean(process.env.DSH_PANEL_SMOKE_CAPTURE);
  const state = capturing ? { width: 1360, height: 900 } : loadWindowState();

  win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 720,
    minHeight: 480,
    title: 'DSH Control Panel',
    // Matches the renderer's initial theme, so resizing neither flashes white
    // nor flashes black before the page paints.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f4f6f9',
    show: false,
    // The menu bar is hidden: it is developer chrome, and every entry has a
    // keyboard accelerator or a button in the UI. Alt still reveals it, which
    // keeps DevTools and zoom reachable when something needs debugging.
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  if (state.maximized) win.maximize();

  win.once('ready-to-show', () => win?.show());
  win.on('close', saveWindowState);
  win.on('closed', () => { win = null; });

  // Smoke mode: boot the real window, prove the UI rendered, then exit. Used by
  // `npm run smoke` and by CI, which has no human to close a window. With
  // DSH_PANEL_SMOKE_CAPTURE it also writes documentation screenshots.
  if (process.env.DSH_PANEL_SMOKE) {
    /*
     * A broken page script used to produce a blank screenshot and a *successful*
     * exit, which is the worst possible failure mode: CI green, product broken.
     * Collect renderer errors and fail the run on any of them.
     */
    win.webContents.on('console-message', (event, level, message, line, source) => {
      // Electron 44 passes an event object; older signatures pass positionals.
      const lvl = event?.level ?? level;
      const msg = event?.message ?? message;
      const src = event?.sourceId ?? source;
      const ln = event?.lineNumber ?? line;
      if (lvl >= 2) console.log(`SMOKE console[${lvl}] ${src}:${ln} ${msg}`);
      if (lvl >= 3) rendererErrors.push(`${src}:${ln} ${msg}`);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      rendererErrors.push(`renderer gone: ${JSON.stringify(details)}`);
    });

    win.webContents.once('did-finish-load', async () => {
      console.log('SMOKE ok: window loaded');
      // The menu bar is chrome, not page content, so capturePage cannot prove it
      // is hidden. Assert it from the window itself instead.
      console.log(`SMOKE menuBarVisible=${win.isMenuBarVisible()}`);
      const capture = process.env.DSH_PANEL_SMOKE_CAPTURE;
      if (capture) {
        try {
          await captureScreenshots(capture);
        } catch (err) {
          console.log(`SMOKE capture failed: ${err.message}`);
          rendererErrors.push(`capture: ${err.message}`);
        }
      }
      if (rendererErrors.length) {
        console.log(`SMOKE fail: ${rendererErrors.length} renderer error(s)`);
        for (const e of rendererErrors) console.log(`  - ${e}`);
        app.exit(1);
        return;
      }
      setTimeout(() => app.exit(0), 300);
    });
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      console.log(`SMOKE fail: ${code} ${desc}`);
      app.exit(1);
    });
  }

  // Everything stays inside the panel. Any real link goes to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!bound || !url.startsWith(bound.url)) {
      event.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  // Documentation screenshots are captured per language and per theme; `?lang=`
  // and `?theme=` let the renderer be told which to use without touching
  // anything the user has stored.
  const params = new URLSearchParams();
  if (process.env.DSH_PANEL_SMOKE_LANG) params.set('lang', process.env.DSH_PANEL_SMOKE_LANG);
  if (process.env.DSH_PANEL_SMOKE_THEME) params.set('theme', process.env.DSH_PANEL_SMOKE_THEME);
  const query = params.toString();
  win.loadURL(query ? `${bound.url}/?${query}` : bound.url);
}

function buildMenu() {
  const config = resolveConfig();
  const openItem = (label, target) => ({
    label,
    click: async () => {
      const err = await shell.openPath(target);
      if (err) dialog.showErrorBox('Cannot open', `${target}\n\n${err}`);
    },
  });

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    {
      label: 'File',
      submenu: [
        openItem('Open DSH home', config.dshHome),
        openItem('Open DSH skill root', config.dshSkills),
        openItem('Open MCP patch file', config.patchFile),
        { type: 'separator' },
        ...(logFile ? [openItem('Open log file', logFile)] : []),
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Refresh', accelerator: 'F5', click: () => win?.webContents.reload() },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: `Version ${app.getVersion()}`, enabled: false },
        { type: 'separator' },
        { label: 'Project on GitHub', click: () => shell.openExternal(REPO_URL) },
        {
          label: 'Reveal config file',
          click: () => shell.showItemInFolder(path.join(app.getPath('userData'), 'window-state.json')),
        },
        ...(logFile ? [{ label: 'Reveal log file', click: () => shell.showItemInFolder(logFile) }] : []),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Feature the app is expected to have, kept explicit rather than implicit. */
export function focusExistingWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
}

/**
 * Write documentation screenshots from the running window.
 *
 * `base` ends in `.png`; a second file with `-mcp` before the extension is
 * written from the MCP tab. Deliberately driven by the real UI so the images
 * cannot drift away from what the app actually renders.
 */
async function captureScreenshots(base) {
  const dir = path.dirname(base);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(base) || '.png';
  const stem = base.slice(0, base.length - ext.length);

  const shot = async (file) => {
    await new Promise((r) => setTimeout(r, 700));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(file, image.toPNG());
    console.log(`SMOKE captured ${file}`);
  };

  await shot(base);

  // Which secondary tabs to capture is the caller's choice: the full docs set
  // wants all of them, an extra theme variant just wants the hero shot.
  const wanted = (process.env.DSH_PANEL_SMOKE_TABS ?? 'mcp,about').split(',').filter(Boolean);
  for (const [tab, suffix] of [['mcp', '-mcp'], ['about', '-about']]) {
    if (!wanted.includes(tab)) continue;
    const clicked = await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('[data-tab="${tab}"]'); if (!b) return false; b.click(); return true; })()`,
    );
    if (clicked) await shot(`${stem}${suffix}${ext}`);
  }
}

async function startServer() {
  const config = resolveConfig();
  // Honour an explicit port if one was set, otherwise take whatever is free.
  const requestedPort = process.env.DSH_PANEL_PORT ? config.port : 0;

  const { server } = createPanelServer(config, {
    publicDir: path.join(ROOT, 'public'),
    version: app.getVersion(),
    openPath: (p) => shell.openPath(p),
  });

  bound = await listen(server, { host: '127.0.0.1', port: requestedPort });
  log(`panel server on ${bound.url}`);
  return bound;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // A second instance normally just focuses the first window. In smoke mode
  // that would silently do nothing and still exit 0, which reads as success --
  // so fail loudly instead and name the fix.
  if (process.env.DSH_PANEL_SMOKE) {
    console.error(
      'SMOKE fail: another instance already holds the single-instance lock. '
      + 'Isolate the run with --user-data-dir=<temp dir>, as scripts/smoke.mjs does.',
    );
    app.exit(1);
  } else {
    app.quit();
  }
} else {
  app.on('second-instance', () => focusExistingWindow());

  app.setAppUserModelId('io.github.yishan-x.dsh-control-panel');

  app.whenReady().then(async () => {
    installFileLogging();
    try {
      await startServer();
    } catch (err) {
      dialog.showErrorBox('DSH Control Panel could not start', String(err?.stack || err));
      app.exit(1);
      return;
    }
    buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', async () => {
    try { await bound?.close(); } catch { /* already gone */ }
  });
}
