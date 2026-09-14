/**
 * The skill model.
 *
 * A skill is "enabled" exactly when a directory with its name exists in DSH's
 * skill root (`$DSH_HOME/skills`). DSH's skill-filesystem provider watches that
 * directory, so adding or removing an entry there changes the catalog on the
 * very next model request -- no restart. That is the whole reason this tab can
 * offer an instant switch while the MCP tab cannot.
 *
 * The tool never deletes anything it did not create: disabling first proves the
 * entry is a link, and refuses outright (HTTP 409) when it is a real directory.
 */

import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './errors.mjs';
import { readCcSwitch } from './ccswitch.mjs';
import { catalogLine, parseSkillFrontmatter } from './frontmatter.mjs';
import { createDirLink, estimateTokens, exists, linkStat, readText, removeDirLink } from './util.mjs';

export const SKILL_MD = 'SKILL.md';

/** Every skill folder that lives in one of the configured pools. */
function scanPools(config) {
  /** @type {Map<string, {pool: import('./config.mjs').Pool, dir: string}>} */
  const index = new Map();
  /** @type {string[]} */
  const duplicates = [];

  for (const pool of config.pools) {
    if (!exists(pool.dir)) continue;
    let entries;
    try {
      entries = fs.readdirSync(pool.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (index.has(e.name)) {
        duplicates.push(`${e.name} (also in ${index.get(e.name).pool.dir})`);
        continue;
      }
      index.set(e.name, { pool, dir: path.join(pool.dir, e.name) });
    }
  }
  return { index, duplicates };
}

/** Everything currently sitting in DSH's skill root (real dirs and links). */
function scanDshRoot(config) {
  /** @type {Map<string, {full: string, isLink: boolean, isDir: boolean, target: string|null}>} */
  const entries = new Map();
  if (!exists(config.dshSkills)) return entries;
  let dirents;
  try {
    dirents = fs.readdirSync(config.dshSkills, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const e of dirents) {
    const full = path.join(config.dshSkills, e.name);
    const st = linkStat(full);
    if (!st) continue;
    entries.set(e.name, {
      full,
      isLink: st.isLink,
      isDir: st.isDir,
      target: st.target,
    });
  }
  return entries;
}

/**
 * Build the complete skill view.
 *
 * @param {import('./config.mjs').PanelConfig} config
 */
export async function buildSkillState(config) {
  const cc = await readCcSwitch(config);
  const { index: poolIndex, duplicates } = scanPools(config);
  const dshEntries = scanDshRoot(config);

  const skills = [];
  const claimed = new Set();

  // 1. Skills cc-switch knows about: richest metadata, DB description fallback.
  for (const row of cc.skills) {
    const dirName = String(row.directory ?? '').trim();
    if (!dirName) continue;
    const inPool = poolIndex.get(dirName);
    if (inPool) claimed.add(dirName);
    skills.push(buildSkillEntry({
      config,
      dirName,
      poolPath: inPool?.dir ?? null,
      poolDir: inPool?.pool.dir ?? null,
      poolLabel: inPool?.pool.label ?? null,
      source: 'cc-switch',
      cc: {
        name: row.name,
        description: row.description,
        id: row.id,
        repo: row.repo_owner && row.repo_name
          ? `${row.repo_owner}/${row.repo_name}@${row.repo_branch ?? 'main'}`
          : null,
        updatedAt: row.updated_at ?? 0,
        flags: Object.fromEntries(cc.agents.map((a) => [a, row[`enabled_${a}`] === 1])),
      },
      dsh: dshEntries.get(dirName) ?? null,
    }));
  }

  // 2. Pool directories cc-switch does not track -- dropped in by hand, or a
  //    leftover artifact. First-class citizens: without cc-switch this is the
  //    entire content of the tool.
  for (const [dirName, { pool, dir }] of poolIndex) {
    if (claimed.has(dirName)) continue;
    claimed.add(dirName);
    skills.push(buildSkillEntry({
      config,
      dirName,
      poolPath: dir,
      poolDir: pool.dir,
      poolLabel: pool.label,
      source: pool.source,
      cc: null,
      dsh: dshEntries.get(dirName) ?? null,
    }));
  }

  // 3. Entries in DSH's skill root that no pool accounts for -- most often a
  //    hand-written skill. Shown, never adopted, never deletable from here.
  for (const [name, info] of dshEntries) {
    if (claimed.has(name)) continue;
    claimed.add(name);
    skills.push(buildSkillEntry({
      config,
      dirName: name,
      poolPath: info.isLink ? info.target : info.full,
      poolDir: null,
      poolLabel: null,
      source: 'dsh-local',
      cc: null,
      dsh: info,
    }));
  }

  skills.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));

  const enabled = skills.filter((s) => s.enabled);
  return {
    skills,
    repos: cc.repos,
    ccSwitch: { available: cc.available, reason: cc.reason, agents: cc.agents },
    duplicates,
    summary: {
      total: skills.length,
      enabled: enabled.length,
      enabledTokens: enabled.reduce((n, s) => n + s.tokens, 0),
      enabledChars: enabled.reduce((n, s) => n + s.catalogChars, 0),
      invalid: skills.filter((s) => s.valid === false).length,
      pooled: skills.filter((s) => s.installed).length,
      removable: skills.filter((s) => s.canDisable).length,
    },
  };
}

/** Assemble one row of the skill table. */
function buildSkillEntry(ctx) {
  const { config, dirName, poolPath, dsh } = ctx;

  let valid = null;                 // null = cannot tell (no SKILL.md at all)
  let reason = null;
  let name = ctx.cc?.name ?? dirName;
  let description = ctx.cc?.description || '';
  let descSource = description ? 'cc-switch' : 'none';

  const installed = Boolean(poolPath && exists(poolPath));
  const mdPath = poolPath ? path.join(poolPath, SKILL_MD) : null;
  const md = mdPath ? readText(mdPath) : null;

  if (!poolPath || !installed) {
    reason = 'skill directory is missing on disk';
  } else if (md === null) {
    reason = `no ${SKILL_MD} in the directory`;
  } else {
    const fm = parseSkillFrontmatter(md);
    if (fm.ok) {
      valid = true;
      name = fm.name;
      description = fm.description;
      descSource = SKILL_MD;
    } else {
      valid = false;
      reason = fm.reason;
    }
  }
  if (valid === null) valid = false;

  // "present" is what DSH actually cares about: a real directory in the skill
  // root loads exactly like a link does, so it is just as enabled. Only the
  // ability to REMOVE it differs.
  const present = Boolean(dsh);
  const catalogChars = valid ? catalogLine(name, description).length : 0;

  return {
    key: dirName,
    dirName,
    name,
    description,
    descSource,
    valid,
    reason,
    installed,
    poolPath,
    poolDir: ctx.poolDir ?? null,
    poolLabel: ctx.poolLabel,
    source: ctx.source,
    managed: ctx.source,
    enabled: present,
    dshPath: path.join(config.dshSkills, dirName),
    isLink: Boolean(dsh?.isLink),
    isRealDir: Boolean(dsh && !dsh.isLink && dsh.isDir),
    linkTarget: dsh?.target ?? null,
    brokenLink: Boolean(dsh?.isLink && dsh.target && !exists(dsh.target)),
    ccId: ctx.cc?.id ?? null,
    repo: ctx.cc?.repo ?? null,
    flags: ctx.cc?.flags ?? null,
    updatedAt: ctx.cc?.updatedAt ?? 0,
    catalogChars,
    tokens: estimateTokens(catalogChars),
    canEnable: Boolean(installed && valid && !present),
    canDisable: Boolean(present && dsh?.isLink),
  };
}

/**
 * Turn a skill on by linking its pool directory into DSH's skill root.
 *
 * @param {import('./config.mjs').PanelConfig} config
 * @param {string} dirName
 * @param {string} [poolDir]
 */
export function enableSkill(config, dirName, poolDir) {
  const poolPath = resolvePoolPath(config, dirName, poolDir);

  const md = readText(path.join(poolPath, SKILL_MD));
  if (md === null) throw new HttpError(400, `no ${SKILL_MD} in ${poolPath}; DSH would ignore it`);
  const fm = parseSkillFrontmatter(md);
  if (!fm.ok) throw new HttpError(400, `${SKILL_MD} would be rejected by DSH: ${fm.reason}`);

  const linkPath = path.join(config.dshSkills, dirName);
  const st = linkStat(linkPath);
  if (st) {
    if (st.isLink) return { changed: false, note: 'already linked' };
    throw new HttpError(409, 'a real directory already exists at that path; refusing to touch it');
  }
  createDirLink(poolPath, linkPath);
  return { changed: true, link: linkPath, target: poolPath };
}

/**
 * Turn a skill off by removing the link.
 *
 * The single most important guard in the codebase: a real directory is the
 * user's own skill, not a link this tool made, and deleting it would destroy
 * data. It is refused and reported, never removed.
 *
 * @param {import('./config.mjs').PanelConfig} config
 * @param {string} dirName
 */
export function disableSkill(config, dirName) {
  const linkPath = path.join(config.dshSkills, dirName);
  const st = linkStat(linkPath);
  if (!st) return { changed: false, note: 'not present' };
  if (!st.isLink) {
    throw new HttpError(409, 'that is a real directory, not a link; refusing to delete it');
  }
  const target = st.target;
  removeDirLink(linkPath);
  return { changed: true, targetIntact: target ? exists(target) : true };
}

/**
 * Resolve which pool directory a skill should be linked from.
 *
 * `poolDir` arrives over HTTP, so it is validated against the configured pools
 * rather than trusted: otherwise the API would be an arbitrary-symlink
 * primitive pointing anywhere on disk.
 */
export function resolvePoolPath(config, dirName, poolDir) {
  if (poolDir) {
    const match = config.pools.find(
      (p) => path.resolve(p.dir) === path.resolve(poolDir),
    );
    if (!match) throw new HttpError(400, `pool directory is not one of the configured pools: ${poolDir}`);
    const full = path.join(match.dir, dirName);
    if (!exists(full)) throw new HttpError(400, `no such skill directory: ${full}`);
    return full;
  }

  for (const pool of config.pools) {
    const full = path.join(pool.dir, dirName);
    if (exists(full)) return full;
  }
  throw new HttpError(400, `skill ${JSON.stringify(dirName)} was not found in any configured pool`);
}
