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

    return { available: true, reason: null, skills, mcpServers, repos, agents };
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
