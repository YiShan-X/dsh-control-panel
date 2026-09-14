import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { catalogLine, parseSkillFrontmatter } from '../src/core/frontmatter.mjs';

describe('parseSkillFrontmatter', () => {
  it('accepts the canonical shape', () => {
    const fm = parseSkillFrontmatter('---\nname: my-skill\ndescription: Does a thing.\n---\n\n# My skill\n');
    assert.equal(fm.ok, true);
    assert.equal(fm.name, 'my-skill');
    assert.equal(fm.description, 'Does a thing.');
  });

  it('reports a missing frontmatter block instead of guessing', () => {
    const fm = parseSkillFrontmatter('# windows-vision-rpa (v0.3.0)\n\nno frontmatter here\n');
    assert.equal(fm.ok, false);
    assert.match(fm.reason, /missing YAML frontmatter/);
  });

  it('reports an unterminated block', () => {
    const fm = parseSkillFrontmatter('---\nname: x\ndescription: y\n');
    assert.equal(fm.ok, false);
    assert.match(fm.reason, /unterminated/);
  });

  it('names the missing required fields', () => {
    const fm = parseSkillFrontmatter('---\nname: only-a-name\n---\n');
    assert.equal(fm.ok, false);
    assert.match(fm.reason, /missing description/);
  });

  it('enforces the kebab-case rule DSH applies', () => {
    const fm = parseSkillFrontmatter('---\nname: hello_js_reverse_skill\ndescription: x\n---\n');
    assert.equal(fm.ok, false);
    assert.match(fm.reason, /kebab-case/);
    assert.equal(fm.nameProblem, 'hello_js_reverse_skill');
  });

  it('strips matching quotes from scalar values', () => {
    const fm = parseSkillFrontmatter('---\nname: "quoted-name"\ndescription: \'single\'\n---\n');
    assert.equal(fm.ok, true);
    assert.equal(fm.name, 'quoted-name');
    assert.equal(fm.description, 'single');
  });

  it('joins a folded block scalar into one line', () => {
    const fm = parseSkillFrontmatter(
      '---\nname: folded\ndescription: >\n  first part\n  second part\n---\n',
    );
    assert.equal(fm.ok, true);
    assert.equal(fm.description, 'first part second part');
  });

  it('keeps newlines in a literal block scalar', () => {
    const fm = parseSkillFrontmatter(
      '---\nname: literal\ndescription: |\n  line one\n  line two\n---\n',
    );
    assert.equal(fm.ok, true);
    assert.equal(fm.description, 'line one\nline two');
  });

  it('ignores nested keys rather than misreading them', () => {
    const fm = parseSkillFrontmatter(
      '---\nname: nested\ndescription: outer\nmetadata:\n  name: inner\ndescription: outer\n---\n',
    );
    assert.equal(fm.ok, true);
    assert.equal(fm.description, 'outer');
  });

  it('requires the opening --- to be the very first line', () => {
    const fm = parseSkillFrontmatter('\n---\nname: x\ndescription: y\n---\n');
    assert.equal(fm.ok, false);
  });

  it('catalogLine matches the shape the estimate is based on', () => {
    assert.equal(catalogLine('a', 'b'), '- `a`: b');
  });
});
