import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const EN_START = HTML.indexOf('  en: {');
const ZH_START = HTML.indexOf("  'zh-CN': {");
const DICT_END = HTML.indexOf('\n};', ZH_START);
const EN = HTML.slice(EN_START, ZH_START);
const ZH = HTML.slice(ZH_START, DICT_END);

const defined = (block, key) => new RegExp(`(^|\\s)${key}\\s*:`).test(block);

describe('renderer i18n', () => {
  it('defines every key the renderer asks for, in both languages', () => {
    /*
     * This is a regression guard, not a lint. `t()` falls back to the key name
     * when a translation is missing, so a typo or an unfinished tab renders as
     * "dshControlUnavailable" in the UI and nothing anywhere fails. That is
     * exactly how the DSH tab shipped with 21 missing keys.
     */
    const used = [...new Set([...HTML.matchAll(/\bt\('([A-Za-z0-9_]+)'/g)].map((m) => m[1]))];
    assert.ok(used.length > 50, 'expected the renderer to use translation keys');

    const missingEn = used.filter((k) => !defined(EN, k));
    const missingZh = used.filter((k) => !defined(ZH, k));
    assert.deepEqual(missingEn, [], `keys missing from the en dictionary: ${missingEn.join(', ')}`);
    assert.deepEqual(missingZh, [], `keys missing from the zh-CN dictionary: ${missingZh.join(', ')}`);
  });

  it('keeps the two dictionaries in step', () => {
    const keys = (block) => new Set(
      [...block.matchAll(/^\s{4}([A-Za-z0-9_]+)\s*:/gm)].map((m) => m[1]),
    );
    const en = keys(EN);
    const zh = keys(ZH);
    const onlyEn = [...en].filter((k) => !zh.has(k));
    const onlyZh = [...zh].filter((k) => !en.has(k));
    assert.deepEqual(onlyEn, [], `defined in en but not zh-CN: ${onlyEn.join(', ')}`);
    assert.deepEqual(onlyZh, [], `defined in zh-CN but not en: ${onlyZh.join(', ')}`);
  });

  it('only queries element ids that exist in the markup', () => {
    /*
     * `$('#x')` returns null for a missing element and the failure surfaces as
     * a TypeError deep inside a render function, which blanks the page. The
     * smoke test catches that, but only for whichever tab it happens to click.
     */
    const ids = new Set([...HTML.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const queried = [...new Set([...HTML.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]))];
    const unknown = queried.filter((id) => !ids.has(id));
    assert.deepEqual(unknown, [], `selectors with no matching element: ${unknown.join(', ')}`);
  });
});
