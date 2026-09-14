/**
 * Optional, strictly READ-ONLY access to the cc-switch configuration hub.
 *
 * cc-switch already uses the same "soft routing" idea this panel implements:
 * it keeps one skill pool on disk and links skill directories into each
 * agent's own skill root, driven by `enabled_<agent>` columns. It does not
 * know about DSH, so this panel treats cc-switch as a *source* -- the pool on
 * disk and the MCP definitions in its SQLite DB -- and keeps DSH's own on/off
 * state in DSH's own files.
 *
 * Two hard rules, both enforced here rather than by convention:
 *   1. The database is opened with `{ readOnly: true }` and no write path
 *      exists anywhere in this module. cc-switch is a running third-party app;
 *      its database is its own, and a schema it does not expect is a way to
 *      break someone's setup or have it overwritten by a migration.
 *   2. Its absence is not an error. `node:sqlite` is a recent Node builtin and
 *      may be missing (older Node, or a desktop runtime that ships an older
 *      V8/Node pairing), so the import is dynamic and failure degrades the
 *      panel to "everything DSH itself knows about".
 */

import fs from 'node:fs';
import { log } from './util.mjs';

/** Resolved once per process; `null` means "not available here". */
let sqliteCtorPromise = null;

/**
 * @returns {Promise<typeof import('node:sqlite').DatabaseSync|null>}
 */
async function loadSqlite() {
  if (!sqliteCtorPromise) {
    // `node:sqlite` still announces itself as experimental on every import.
    // The warning is accurate but useless here -- it fires on the happy path,
    // on every launch, and would otherwise land in the user-facing log file.
    const originalEmit = process.emitWarning;
    process.emitWarning = (warning, ...rest) => {
      const text = typeof warning === 'string' ? warning : (warning?.message ?? '');
      if (/SQLite is an experimental feature/i.test(text)) return;
      return originalEmit.call(process, warning, ...rest);
    };

    sqliteCtorPromise = import('node:sqlite')
      .then((m) => m.DatabaseSync ?? null)
      .catch(() => null)
      .finally(() => { process.emitWarning = originalEmit; });
  }
  return sqliteCtorPromise;
}

/**
 * @typedef {object} CcSwitchData
 * @property {boolean} available
 * @property {string|null} reason
 * @property {Array<Record<string, any>>} skills
 * @property {Array<Record<string, any>>} mcpServers
 * @property {Array<Record<string, any>>} repos
 * @property {string[]} agents   Detected `enabled_<agent>` columns.
 */

const EMPTY = {
  available: false,
  reason: null,
  skills: [],
  mcpServers: [],
  repos: [],
  agents: [],
};

/**
 * Read the whole cc-switch picture in one shot.
 *
 * Never throws: every failure mode is reported through `reason` so the UI can
 * explain what is missing instead of showing an empty page.
 *
 * @param {import('./config.mjs').PanelConfig} config
 * @returns {Promise<CcSwitchData>}
 */
export async function readCcSwitch(config) {
  if (!config.ccEnabled) {
    return { ...EMPTY, reason: 'disabled by DSH_PANEL_CC_SWITCH' };
  }
  if (!fs.existsSync(config.ccDb)) {
    return { ...EMPTY, reason: `no cc-switch database at ${config.ccDb}` };
  }

  const DatabaseSync = await loadSqlite();
  if (!DatabaseSync) {
    return {
      ...EMPTY,
      reason: 'node:sqlite is not available in this runtime (needs Node 22.5+ / Electron 38+)',
    };
  }

  let db = null;
  try {
    db = new DatabaseSync(config.ccDb, { readOnly: true });

    const agents = detectAgents(db);
    const skillCols = [
      'id', 'name', 'description', 'directory', 'repo_owner', 'repo_name',
      'repo_branch', 'updated_at',
      ...agents.map((a) => `enabled_${a}`),
    ].join(', ');

    const skills = all(db, `SELECT ${skillCols} FROM skills ORDER BY name`);
    const mcpServers = all(
      db,
      'SELECT id, name, server_config, description, tags FROM mcp_servers ORDER BY name',
    );
    const repos = all(db, 'SELECT owner, name, branch, enabled FROM skill_repos');
    // The `providers` table exists in modern cc-switch builds; older ones do
    // not have it, so a missing-table error must NOT take the whole panel
    // down -- the rest of the read is still useful.
    const providers = readProviders(db);

    return { available: true, reason: null, skills, mcpServers, repos, providers, agents };
  } catch (err) {
    log(`WARN cannot read cc-switch DB: ${err.message}`);
    return { ...EMPTY, reason: `cannot read cc-switch DB: ${err.message}` };
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

/**
 * Discover which `enabled_<agent>` columns this build of cc-switch has, rather
 * than hardcoding a list that upstream will outgrow.
 */
function detectAgents(db) {
  try {
    const cols = db.prepare('PRAGMA table_info(skills)').all();
    return cols
      .map((c) => String(c.name))
      .filter((n) => /^enabled_[a-z0-9_]+$/.test(n))
      .map((n) => n.slice('enabled_'.length));
  } catch {
    return [];
  }
}

/** `prepare().all()` that degrades to an empty list. */
function all(db, sql) {
  try {
    return db.prepare(sql).all();
  } catch (err) {
    log(`WARN cc-switch query failed: ${err.message}`);
    return [];
  }
}

/**
 * Read cc-switch's provider rows. Older cc-switch builds may not have this
 * table at all, so a missing-table error is logged and the result degrades
 * to `[]` instead of taking the whole read down.
 */
function readProviders(db) {
  try {
    return db.prepare(
      'SELECT id, name, app_type, settings_config, is_current FROM providers ORDER BY name',
    ).all().map((row) => {
      let parsed = null;
      let parseError = null;
      if (row.settings_config) {
        try { parsed = JSON.parse(row.settings_config); }
        catch (err) { parseError = err.message; }
      }
      // Extract the bits the Models tab actually needs: the base URL and the
      // model ids. Auth tokens are deliberately NOT exposed to the importer
      // so a UI button cannot accidentally write a secret to settings.yaml --
      // the user has to bind an env var themselves.
      const env = parsed && typeof parsed === 'object' && parsed.env && typeof parsed.env === 'object'
        ? parsed.env
        : {};
      const baseURL = pickFirst(env, [
        'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'BASE_URL',
      ]);
      const models = pickModels(env);
      const hasAuthToken = pickFirst(env, [
        'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'API_KEY', 'AUTH_TOKEN',
      ]) != null;
      return {
        id: row.id,
        name: row.name,
        appType: row.app_type,
        isCurrent: Boolean(row.is_current),
        baseURL,
        models,
        hasAuthToken,
        parseError,
      };
    });
  } catch (err) {
    log(`WARN cc-switch providers query failed: ${err.message}`);
    return [];
  }
}

/** Return the first non-empty value among the candidate env-var names. */
function pickFirst(obj, names) {
  for (const n of names) {
    const v = obj[n];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

/**
 * Pull a deduplicated list of model ids out of a `settings_config.env` blob.
 * Anthropic-flavoured configs spell the default model three times (one for
 * each tier); other CLIs use just one. Either way the importer wants every
 * distinct id it can find.
 */
function pickModels(env) {
  const out = new Set();
  for (const k of [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'OPENAI_MODEL',
    'MODEL',
  ]) {
    const v = env[k];
    if (typeof v === 'string' && v.trim() !== '') out.add(v.trim());
  }
  return [...out];
}
