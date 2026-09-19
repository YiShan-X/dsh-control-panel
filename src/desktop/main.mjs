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

import {
  app, BrowserWindow, Menu, Tray, dialog, nativeImage, nativeTheme, shell,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../core/config.mjs';
import {
  dshWebStatus,
  restartDshWeb,
  startDshWeb,
  stopDshWeb,
  warmDshWebCache,
} from '../core/dsh.mjs';
import { createPanelServer, listen } from '../core/server.mjs';
import { log } from '../core/util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const REPO_URL = 'https://github.com/YiShan-X/dsh-control-panel';

/** @type {{url: string, close: () => Promise<void>}|null} */
let bound = null;
/** @type {BrowserWindow|null} */
let win = null;
/** @type {Tray|null} */
let tray = null;
/** @type {string|null} */
let logFile = null;
/** True once the user picked "Quit" from the tray menu. Distinguishes a real
 *  exit from a window-close that the tray should swallow and survive. */
let isQuitting = false;
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
  // 920x700 matches the density of the Skills/MCP/About panels and keeps the
  // first launch from feeling like half the window is empty space. Existing
  // users with a window-state.json keep whatever they last resized to.
  const fallback = { width: 920, height: 700 };
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

  // Window close: save geometry, then either hide (normal mode, tray keeps the
  // app alive) or actually close (smoke mode / a real Quit). The renderer is
  // not destroyed in the hide path, so showing it again is instant.
  win.on('close', (event) => {
    saveWindowState();
    if (isQuitting || process.env.DSH_PANEL_SMOKE) return;
    event.preventDefault();
    win?.hide();
  });
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
  // Recreate the window if the previous one was hidden long enough to be torn
  // down -- on macOS the closed event can fire after a hide, leaving `win`
  // null until the user clicks the dock icon again.
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}

// ---------------------------------------------------------------------------
// Tray: the panel survives closing its window, and a left-click brings it back.
// ---------------------------------------------------------------------------

/**
 * Locate an icon bitmap that ships with the app.
 *
 * The icons are *not* inside the asar: `build/` is excluded from the packaged
 * files, so they are attached as `extraResources` and land next to `app.asar`
 * under `resources/build/`. A development run has no such directory, so both
 * candidates are tried and the asar path is the fallback.
 *
 * Getting this wrong is silent: `createFromPath` on a missing file returns an
 * empty image, so the tray would show a blank slot instead of an icon -- which
 * is exactly the bug that shipped in earlier builds.
 *
 * @param {string} name
 * @returns {Electron.NativeImage}
 */
function loadIcon(name) {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'build', name),
    path.join(ROOT, 'build', name),
  ];
  for (const candidate of candidates) {
    try {
      const image = nativeImage.createFromPath(candidate);
      if (!image.isEmpty()) return image;
    } catch { /* try the next candidate */ }
  }
  log(`WARN no icon found for ${name} (looked in ${candidates.join(', ')})`);
  return nativeImage.createEmpty();
}

/**
 * Pick the tray image for the current taskbar/menu-bar colour.
 *
 * The monochrome glyph is white, which is the right choice on a dark taskbar and
 * invisible on a light one; the full icon carries its own dark tile and reads on
 * both. Choosing by theme is therefore not decoration -- it is the difference
 * between an icon and an empty gap in the notification area.
 *
 * On macOS the glyph is additionally marked as a template image, which is how
 * the system knows to invert it for the menu bar.
 */
function trayImage() {
  const dark = nativeTheme.shouldUseDarkColors;
  const image = loadIcon(dark ? 'icon-mono.png' : 'icon.png');
  if (process.platform === 'darwin' && dark && !image.isEmpty()) image.setTemplateImage(true);
  return image;
}

/**
 * Build and install the tray icon + menu.
 *
 * Skipped in smoke and screenshot modes: those runs exit immediately after the
 * window loads, and a leftover tray icon would be confusing on a CI host.
 */
function installTray() {
  if (tray || process.env.DSH_PANEL_SMOKE) return;

  tray = new Tray(trayImage());
  tray.setToolTip('DSH Control Panel');
  // `setIgnoreDoubleClickEvents(true)` keeps a brisk left-click from being
  // interpreted as two opens on Windows; the menu still appears on right-click.
  tray.setIgnoreDoubleClickEvents(true);

  // A theme switch mid-session would otherwise leave a white glyph on a light
  // taskbar (or the reverse) until the app restarted.
  nativeTheme.on('updated', () => tray?.setImage(trayImage()));

  tray.on('click', () => focusExistingWindow());

  // Refresh the menu on every open so the entries reflect the *current* config
  // (paths may have moved between launches, the log file may or may not exist).
  tray.on('right-click', () => tray?.popUpContextMenu(buildTrayMenu()));

  // Populate the menu once at install -- subsequent rebuilds happen on every
  // right-click so any change to `logFile` or the config takes effect.
  tray.setContextMenu(buildTrayMenu());
}

/**
 * Build the tray context menu. Reuses the same "Open X" helpers the menu bar
 * uses, so renaming or adding one only needs to happen in one place.
 */
function buildTrayMenu() {
  const config = resolveConfig();
  const openItem = (label, target) => ({
    label,
    click: async () => {
      const err = await shell.openPath(target);
      if (err) dialog.showErrorBox('Cannot open', `${target}\n\n${err}`);
    },
  });

  return Menu.buildFromTemplate([
    { label: 'Open Panel', click: () => focusExistingWindow() },
    { type: 'separator' },
    openItem('Open DSH home', config.dshHome),
    openItem('Open DSH skill root', config.dshSkills),
    openItem('Open MCP patch file', config.patchFile),
    ...(logFile ? [openItem('Open log file', logFile)] : []),
    { type: 'separator' },
    {
      label: 'Quit',
      // Setting `isQuitting` first lets the window's close handler know this
      // is a real shutdown, not a "hide me in the tray" click.
      click: () => { isQuitting = true; app.quit(); },
    },
  ]);
}

function destroyTray() {
  if (!tray) return;
  try { tray.destroy(); } catch { /* already gone */ }
  tray = null;
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
  for (const [tab, suffix] of [['mcp', '-mcp'], ['dsh', '-dsh'], ['about', '-about']]) {
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

  // One bundle serves both entry points into process control: the MCP tab's
  // "restart dsh web now" banner and the DSH tab's three buttons. Sharing the
  // implementation is what keeps the two from disagreeing about what happened.
  const dshControl = {
    status: (opts) => dshWebStatus(opts),
    start: () => startDshWeb(),
    stop: () => stopDshWeb(),
    restart: () => restartDshWeb(),
  };

  /*
   * Synthetic process status for documentation captures.
   *
   * `scripts/screenshot.mjs` sets `DSH_PANEL_PROBE_WEB=0` so its images cannot
   * depend on what this machine happens to be running -- but a host that wires
   * real process control *bypasses that flag* (`readDshStatus` prefers
   * `dshControl`), so the DSH tab screenshot ended up printing this machine's
   * real pid, start time and uptime. That is exactly the leak the screenshot
   * script exists to prevent, and the leak only became visible once the DSH tab
   * was added to the capture set.
   *
   * A fixed, plausible status is also simply better documentation: the rest of
   * that script's fixtures are synthetic too, and a demo image should not change
   * depending on whether the machine generating it is busy. Start and stop stay
   * wired to the real implementation -- capturing never clicks them.
   */
  const captureStatus = process.env.DSH_PANEL_SMOKE && process.env.DSH_PANEL_SMOKE_CAPTURE
    ? {
      running: true,
      pid: 4242,
      cmdline: '"C:\\Program Files\\nodejs\\node.exe" "C:\\...\\dsh\\lib\\bin.js" web',
      // Relative to capture time so the uptime reads sensibly and stays stable.
      startedAt: new Date(Date.now() - (2 * 3600 + 14 * 60) * 1000).toISOString(),
      uptimeMs: (2 * 3600 + 14 * 60) * 1000,
      cpuMs: 41230,
      rssBytes: 214 * 1024 * 1024,
      probeMs: 6,
      probed: true,
    }
    : null;

  if (captureStatus) {
    dshControl.status = () => captureStatus;
  }

  const { server } = createPanelServer(config, {
    publicDir: path.join(ROOT, 'public'),
    version: app.getVersion(),
    openPath: (p) => shell.openPath(p),
    dshControl,
    restartHook: () => restartDshWeb(),
    // Only an installed app has an installation to replace. A dev run
    // (`npm run desktop`) reports that honestly instead of offering to download
    // an installer for a program it is not running from.
    packaged: app.isPackaged,
  });

  bound = await listen(server, { host: '127.0.0.1', port: requestedPort });
  log(`panel server on ${bound.url}`);

  // Warm the process probe before the window asks for state, so the first paint
  // is not blocked behind PowerShell. Never fatal.
  if (config.probeWeb) {
    const status = warmDshWebCache();
    log(status.running
      ? `dsh web running (pid ${status.pid})`
      : 'no running dsh web found');
  }
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
    installTray();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // The tray owns the lifecycle now: closing the window only hides it, and
    // `app.quit()` only fires from the tray menu or `before-quit`. On macOS
    // the OS convention is "stay alive even with no windows", which the tray
    // also honours -- so the rule is the same on every platform: do nothing.
  });

  app.on('before-quit', async () => {
    destroyTray();
    try { await bound?.close(); } catch { /* already gone */ }
  });
}
