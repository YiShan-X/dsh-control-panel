/**
 * SKILL.md frontmatter parsing, with no YAML dependency.
 *
 * DSH's skill-filesystem provider requires every skill to have a `name` and a
 * `description` in a `---`-delimited YAML frontmatter block, and it enforces
 * the kebab-case shape on `name`. When either is wrong the provider logs a
 * single warning and drops the skill -- from the model's point of view the
 * skill simply does not exist. That silent failure is the single most common
 * way a skill "mysteriously doesn't work", so this parser is deliberately
 * strict and reports *why* rather than guessing.
 */

/** DSH registry rejects any other skill name shape. */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * @typedef {object} FrontmatterResult
 * @property {boolean} ok
 * @property {string} [name]
 * @property {string} [description]
 * @property {string} [reason]        Present when ok is false.
 * @property {string} [nameProblem]   Present when the name is present but invalid.
 */

/**
 * Parse only the two fields DSH actually requires.
 *
 * Supports the common scalar forms (`key: value`, quoted values) plus block
 * scalars (`key: |` and `key: >`), which real-world SKILL.md files use for
 * multi-line descriptions.
 *
 * @param {string} text
 * @returns {FrontmatterResult}
 */
export function parseSkillFrontmatter(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  if ((lines[0] ?? '').replace(/\s+$/, '') !== '---') {
    return { ok: false, reason: 'missing YAML frontmatter (first line is not ---)' };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].replace(/\s+$/, '') === '---') { end = i; break; }
  }
  if (end < 0) return { ok: false, reason: 'unterminated YAML frontmatter' };

  const fields = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (/^[ \t]/.test(line)) continue;                 // nested value: not ours
    const m = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rawVal] = m;

    if (rawVal === '' || /^[|>][-+]?$/.test(rawVal)) {
      // Block scalar: consume the following blank or indented lines.
      const body = [];
      let j = i + 1;
      while (j < end && (lines[j].trim() === '' || /^[ \t]/.test(lines[j]))) {
        body.push(lines[j]); j++;
      }
      const indents = body.filter((l) => l.trim() !== '').map((l) => l.match(/^[ \t]*/)[0].length);
      const strip = indents.length ? Math.min(...indents) : 0;
      const unindented = body.map((l) => l.slice(strip));
      fields[key] = /^[|]/.test(rawVal)
        ? unindented.join('\n').replace(/\n+$/, '')
        : unindented.join(' ').replace(/\s+/g, ' ').trim();
      i = j - 1;
      continue;
    }

    // Inline scalar: strip matching quotes, else take verbatim.
    let v = rawVal.trim();
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    fields[key] = v;
  }

  const name = fields.name;
  const description = fields.description;
  if (!name || !description) {
    const missing = [!name && 'name', !description && 'description'].filter(Boolean).join(' + ');
    return { ok: false, reason: `frontmatter is missing ${missing}` };
  }
  if (!SKILL_NAME_RE.test(name)) {
    return {
      ok: false,
      reason: `invalid skill name ${JSON.stringify(name)} (DSH requires kebab-case: ^[a-z0-9]+(-[a-z0-9]+)*$)`,
      nameProblem: String(name),
    };
  }
  return { ok: true, name, description };
}

/**
 * The exact catalog line DSH injects for one skill. Kept in one place so the
 * token estimate in the UI tracks whatever the provider actually emits.
 */
export function catalogLine(name, description) {
  return `- \`${name}\`: ${description}`;
}
