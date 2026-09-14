/**
 * The `# BEGIN MCP: <key>` / `# END MCP: <key>` block editor for
 * `cordis.patch.yml` and the parked `disabled.yml`.
 *
 * The delimited-block convention is not invented here: it is the same format
 * the `dsh-mcp-manager` skill's `mcp.ps1` writes, so the two management paths
 * can be mixed freely without either one corrupting the other's entries.
 *
 * THE ONE RULE THAT MATTERS: `cordis.patch.yml` must always parse to a
 * top-level YAML array. A file containing only comments parses to `null`, and
 * the boot loader throws on "exists but is not an array" -- which means a
 * careless edit here can stop `dsh web` from starting at all. `ensureValidArray`
 * is the guard that makes that impossible.
 */

/** Matches one delimited block. Indices are not needed; only the text is. */
const blockRe = () =>
  /^# BEGIN MCP: (?<name>[A-Za-z0-9_-]+)[ \t]*\r?\n(?<body>[\s\S]*?)^# END MCP: \k<name>[ \t]*\r?\n?/gm;

/** An empty-array placeholder line. */
const EMPTY_ARRAY_RE = /^[ \t]*\[[ \t]*\][ \t]*\r?\n?/m;

/**
 * Index the delimited blocks in a patch file.
 *
 * @param {string} text
 * @returns {Map<string, string>} key -> verbatim block text
 */
export function parseBlocks(text) {
  const blocks = new Map();
  if (!text) return blocks;
  const re = blockRe();
  let m;
  while ((m = re.exec(text)) !== null) blocks.set(m.groups.name, m[0]);
  return blocks;
}

/** True when the text still holds at least one delimited block. */
export function hasBlocks(text) {
  return /^# BEGIN MCP: /m.test(text ?? '');
}

/**
 * Guarantee the file still parses to a top-level array.
 *
 * When the last block is removed the file is left with an explicit `[]`, which
 * is a valid empty array and the value the loader expects.
 */
export function ensureValidArray(text) {
  if (hasBlocks(text)) return text;
  const stripped = String(text ?? '').replace(EMPTY_ARRAY_RE, '');
  if (stripped.trim() === '') return '[]\n';
  const body = stripped.endsWith('\n') ? stripped : `${stripped}\n`;
  return `${body}[]\n`;
}

/** Strip the `[]` placeholder so a block can be appended cleanly. */
export function stripEmptyArray(text) {
  return String(text ?? '').replace(EMPTY_ARRAY_RE, '');
}

/** Append a block, collapsing the blank-line damage a prior removal left. */
export function appendBlock(text, block) {
  const base = stripEmptyArray(text).replace(/(\r?\n){3,}/g, '\n\n');
  const tail = base === '' || base.endsWith('\n') ? base : `${base}\n`;
  return `${tail}${tail === '' ? '' : '\n'}${block}\n`;
}

/** Remove a block by its verbatim text. */
export function removeBlock(text, block) {
  return String(text ?? '').replace(block, '').replace(/(\r?\n){3,}/g, '\n\n');
}

export const _internal = { blockRe, EMPTY_ARRAY_RE };
