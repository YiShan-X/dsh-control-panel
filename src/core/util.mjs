/**
 * Small, dependency-free filesystem and formatting helpers used across the
 * panel. Everything here is deliberately defensive: this tool runs against a
 * live user profile, so a missing file or a locked directory must degrade the
 * view, never crash the app.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Timestamped console line. The Electron shell pipes stdout into its log. */
export const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

/** `lstat` returning null instead of throwing. */
function statOrNull(p) {
  try { return fs.lstatSync(p); } catch { return null; }
}

/** True when the path exists at all (link or real). */
export function exists(p) {
  return statOrNull(p) !== null;
}

/**
 * `lstat` without following the link, so a junction/symlink can be told apart
 * from a real directory. This is what makes "never delete a real skill
 * directory" implementable at all.
 *
 * @returns {{isLink: boolean, isDir: boolean, target: string|null}|null}
 */
export function linkStat(p) {
  const st = statOrNull(p);
  if (!st) return null;
  const isLink = st.isSymbolicLink();
  return {
    isLink,
    isDir: st.isDirectory(),
    target: isLink ? safeReadlink(p) : null,
  };
}

export function safeReadlink(p) {
  try { return fs.readlinkSync(p); } catch { return null; }
}

/** Read a UTF-8 text file, returning null when it is absent or unreadable. */
export function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

export function writeText(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
}

/**
 * Create a directory link (junction on Windows, directory symlink elsewhere)
 * pointing at `target`.
 *
 * Junctions are the right primitive on Windows: they need no elevation and
 * Developer Mode, unlike real symlinks.
 */
export function createDirLink(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(path.resolve(target), linkPath, type);
}

/**
 * Remove a directory link WITHOUT touching what it points at.
 *
 * Windows refuses `unlink` on a junction with EPERM and wants `rmdir`; POSIX is
 * the other way round for directory symlinks in some Node versions. Try the
 * cheap one, then the other, and never fall back to a recursive delete -- that
 * is the one call that could follow the link and destroy the target.
 */
export function removeDirLink(linkPath) {
  try {
    fs.unlinkSync(linkPath);
    return;
  } catch (err) {
    if (!['EPERM', 'EISDIR', 'ENOTEMPTY', 'EACCES'].includes(err.code)) throw err;
  }
  fs.rmdirSync(linkPath);
}

/**
 * Emit a YAML scalar. Conservative by design: anything not provably plain gets
 * JSON-style double quoting, which is also valid YAML, and removes any need to
 * reason about YAML's implicit-typing and escaping traps.
 */
export function yamlScalar(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const s = String(value);
  if (s === '') return "''";
  const plainSafe =
    /^[/A-Za-z0-9_][A-Za-z0-9_./@+-]*$/.test(s) &&
    !/^(true|false|null|yes|no|on|off|y|n|~)$/i.test(s);
  return plainSafe ? s : JSON.stringify(s);
}

/** Rough token estimate. Deliberately labelled as an estimate in the UI. */
export const estimateTokens = (chars) => Math.round(chars / 3.5);
