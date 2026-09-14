import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  appendBlock,
  ensureValidArray,
  hasBlocks,
  parseBlocks,
  removeBlock,
  stripEmptyArray,
} from '../src/core/patch.mjs';

const BLOCK_A = [
  '# BEGIN MCP: alpha',
  '# generated for tests',
  '- insert:',
  '    - id: mcp-alpha',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '# END MCP: alpha',
  '',
].join('\n');

const BLOCK_B = [
  '# BEGIN MCP: beta',
  '- insert:',
  '    - id: mcp-beta',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '# END MCP: beta',
  '',
].join('\n');

describe('patch block editor', () => {
  it('finds every delimited block by name', () => {
    const blocks = parseBlocks(`${BLOCK_A}\n${BLOCK_B}`);
    assert.deepEqual([...blocks.keys()], ['alpha', 'beta']);
    assert.equal(blocks.get('alpha'), BLOCK_A);
  });

  it('does not match a block whose END name differs', () => {
    const text = BLOCK_A.replace('# END MCP: alpha', '# END MCP: gamma');
    assert.equal(parseBlocks(text).size, 0);
  });

  it('adds an explicit [] when the last block is removed', () => {
    // This is the guard that keeps `dsh web` bootable: a comments-only file
    // parses to null and the loader throws on a non-array patch.
    const withComment = '# just a note\n';
    const result = ensureValidArray(withComment);
    assert.equal(hasBlocks(result), false);
    assert.match(result, /\n\[\]\n$/);
  });

  it('leaves a file with blocks alone', () => {
    assert.equal(ensureValidArray(BLOCK_A), BLOCK_A);
  });

  it('replaces, rather than duplicates, a stale [] placeholder', () => {
    const result = appendBlock('[]\n', BLOCK_A);
    assert.equal(result.match(/\[\]/g), null);
    assert.equal(result, `${BLOCK_A}\n`);
  });

  it('removes a block and collapses the blank lines it leaves behind', () => {
    const text = `${BLOCK_A}\n${BLOCK_B}`;
    const result = removeBlock(text, BLOCK_A);
    assert.equal(parseBlocks(result).has('alpha'), false);
    assert.equal(parseBlocks(result).has('beta'), true);
    assert.doesNotMatch(result, /\n\n\n/);
  });

  it('round-trips through strip + append', () => {
    const text = `${BLOCK_A}\n[]\n`;
    const result = appendBlock(text, BLOCK_B);
    const blocks = parseBlocks(result);
    assert.deepEqual([...blocks.keys()], ['alpha', 'beta']);
    assert.equal(stripEmptyArray(result).includes('[]'), false);
  });

  it('handles an empty document', () => {
    assert.deepEqual([...parseBlocks('').keys()], []);
    assert.deepEqual([...parseBlocks(null).keys()], []);
    assert.equal(ensureValidArray(''), '[]\n');
  });

  it('tolerates CRLF line endings', () => {
    const crlf = BLOCK_A.replace(/\n/g, '\r\n');
    assert.equal(parseBlocks(crlf).has('alpha'), true);
  });
});
