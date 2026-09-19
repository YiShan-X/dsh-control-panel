/**
 * One place that turns the ambient environment into an explicit config object.
 *
 * Every path the panel touches is derived here, so the rest of the code never
 * reads `process.env` and tests can build a config pointing at a temp dir.
 * The project directory is decoupled from the directories it manages: the
 * panel can live anywhere and still manage a DSH install in the user profile.
 */

import os from 'node:os';
import path from 'node:path';

/**
 * @typedef {object} Pool
 * @property {string} id       Stable id used in the UI.
 * @property {string} label    Human label.
 * @property {string} dir      Absolute directory holding skill folders.
 * @property {'cc-switch'|'dsh'|'custom'} source
 */

/**
 * @typedef {object} PanelConfig
 * @property {string} home
 * @property {string} dshHome
 * @property {string} dshSkills        Where DSH discovers skills (link target dir).
 * @property {string} patchFile        cordis.patch.yml -- enabled MCP blocks.
 * @property {string} disabledFile     Parked MCP blocks.
 * @property {string} settingsFile     DSH settings.yaml (model catalog + default).
 * @property {string} profilesDir      DSH profiles -- each one owns its plugins.
 * @property {string} dshPackage       npm package the version card tracks.
 * @property {string} panelRepo        `owner/repo` the panel's own updates come from.
 * @property {boolean} ccEnabled
 * @property {string} ccHome
 * @property {string} ccDb
 * @property {string} ccSkills
 * @property {Pool[]} pools
 * @property {string} host
 * @property {number} port
 * @property {number} pollMs
 * @property {boolean} probeWeb
 * @property {boolean} openBrowser
 */

/** Split a `path.delimiter`-separated list, honouring Windows drive colons. */
function splitPaths(value) {
  return String(value)
    .split(path.delimiter)
    .map((s) => s.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
    .map((s) => path.resolve(s));
}

const uniq = (arr) => [...new Set(arr)];

/**
 * Build the config from an environment bag.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {PanelConfig}
 */
export function resolveConfig(env = process.env) {
  const home = path.resolve(
    env.DSH_PANEL_HOME || env.USERPROFILE || env.HOME || os.homedir(),
  );

  const dshHome = path.resolve(env.DSH_HOME || path.join(home, '.dsh'));
  const ccHome = path.resolve(env.CC_SWITCH_HOME || path.join(home, '.cc-switch'));

  // cc-switch is an optional enrichment source: it owns a multi-agent skill
  // pool and holds MCP server definitions in SQLite. Without it the panel still
  // manages everything DSH itself knows about.
  const ccEnabled = !/^(0|false|no|off)$/i.test(String(env.DSH_PANEL_CC_SWITCH ?? ''));

  /** @type {Pool[]} */
  const pools = [];
  const seen = new Set();
  const addPool = (dir, source, label) => {
    const resolved = path.resolve(dir);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return;
    seen.add(key);
    pools.push({ id: `${source}:${resolved}`, label: label || resolved, dir: resolved, source });
  };

  if (env.DSH_SKILL_POOL) {
    for (const dir of splitPaths(env.DSH_SKILL_POOL)) addPool(dir, 'custom');
  } else {
    if (ccEnabled) addPool(path.join(ccHome, 'skills'), 'cc-switch', 'cc-switch skill pool');
    addPool(path.join(dshHome, 'skill-pool'), 'dsh', 'DSH skill pool');
  }

  /** @type {{id: string, label: string, dir: string, source: string}[]} */
  const config = {
    home,
    dshHome,
    dshSkills: path.resolve(env.DSH_SKILLS_DIR || path.join(dshHome, 'skills')),
    patchFile: path.resolve(env.DSH_PATCH_FILE || path.join(dshHome, 'cordis.patch.yml')),
    disabledFile: path.resolve(
      env.DSH_DISABLED_FILE || path.join(dshHome, 'mcp-manager', 'disabled.yml'),
    ),
    settingsFile: path.resolve(env.DSH_SETTINGS_FILE || path.join(dshHome, 'settings.yaml')),
    // Plugins are profile-scoped, not home-scoped: `dsh plugin --profile <n>`
    // runs pnpm inside `$DSH_HOME/profiles/<n>`, so that directory is the only
    // place the plugin inventory can be read from.
    profilesDir: path.resolve(env.DSH_PROFILES_DIR || path.join(dshHome, 'profiles')),
    // The npm package whose version the DSH tab reports and can install. Kept
    // configurable for the same reason `DSH_WEB_CMD` is: a fork or an internal
    // mirror publishes under a different name, and the alternative -- editing
    // this file -- is not something a user of a packaged app can do.
    dshPackage: String(env.DSH_PANEL_DSH_PACKAGE || '@deepseek-ai/dsh').trim(),
    // `owner/repo` whose releases the panel's own update check reads. Separate
    // from the DSH package above because the two updates are unrelated: one
    // installs an npm package, the other hands an installer to the OS.
    panelRepo: String(env.DSH_PANEL_REPO || 'YiShan-X/dsh-control-panel').trim(),
    ccEnabled,
    ccHome,
    ccDb: path.resolve(env.DSH_PANEL_CC_DB || path.join(ccHome, 'cc-switch.db')),
    ccSkills: path.join(ccHome, 'skills'),
    pools,
    host: env.DSH_PANEL_HOST || '127.0.0.1',
    port: Number(env.DSH_PANEL_PORT || 8791),
    pollMs: Number(env.DSH_PANEL_POLL_MS || 30000),
    // The "is a restart pending?" banner needs the running `dsh web` process.
    // Disabling the probe suppresses the banner entirely -- useful when running
    // against a sandbox, and in documentation screenshots.
    probeWeb: !/^(0|false|no|off)$/i.test(String(env.DSH_PANEL_PROBE_WEB ?? '1')),
    openBrowser: !/^(0|false|no|off)$/i.test(String(env.DSH_PANEL_OPEN ?? '1')),
  };

  return config;
}

/** Directories the panel may need to create before it can write anything. */
export function writableRoots(config) {
  return uniq([
    config.dshHome,
    config.dshSkills,
    path.dirname(config.patchFile),
    path.dirname(config.disabledFile),
  ]);
}
