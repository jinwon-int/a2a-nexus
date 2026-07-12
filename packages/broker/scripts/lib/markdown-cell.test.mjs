import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeMarkdownCell } from './markdown-cell.mjs';

test('escapes pipe so it cannot open a new table column', () => {
  assert.equal(encodeMarkdownCell('a|b'), 'a\\|b');
  assert.equal(encodeMarkdownCell('a|b|c'), 'a\\|b\\|c');
});

test('neutralizes CR/LF/CRLF row breaks as <br>', () => {
  assert.equal(encodeMarkdownCell('a\nb'), 'a<br>b');
  assert.equal(encodeMarkdownCell('a\r\nb'), 'a<br>b');
  assert.equal(encodeMarkdownCell('a\rb'), 'a<br>b'); // bare CR was previously unhandled
  assert.equal(encodeMarkdownCell('a\n\nb'), 'a<br><br>b');
});

test('drops C0 control chars and DEL but preserves TAB', () => {
  assert.equal(encodeMarkdownCell('x\x00y\x1Fz\x7F'), 'xyz');
  assert.equal(encodeMarkdownCell('a\x08b'), 'ab');
  assert.equal(encodeMarkdownCell('col\tval'), 'col\tval'); // tab preserved inside a cell
});

test('coerces null/undefined/number/boolean like the renderers asText()', () => {
  assert.equal(encodeMarkdownCell(null), '');
  assert.equal(encodeMarkdownCell(undefined), '');
  assert.equal(encodeMarkdownCell(42), '42');
  assert.equal(encodeMarkdownCell(true), 'true');
  assert.equal(encodeMarkdownCell({ a: 1 }), '{"a":1}');
});

test('is behavior-neutral for already-safe input', () => {
  assert.equal(encodeMarkdownCell('plain text'), 'plain text');
  assert.equal(encodeMarkdownCell(''), '');
});

test('is idempotent: encode(encode(x)) === encode(x)', () => {
  const inputs = [
    'a|b',
    'a\nb|c',
    'a\r\n|b',
    'x\x00y\x7F|z',
    'already \\| escaped',
    'plain',
    '|leading',
    'trailing|',
  ];
  for (const input of inputs) {
    const once = encodeMarkdownCell(input);
    const twice = encodeMarkdownCell(once);
    assert.equal(twice, once, `idempotency failed for ${JSON.stringify(input)}`);
  }
});

test('a pre-escaped pipe is not double-escaped', () => {
  assert.equal(encodeMarkdownCell('a\\|b'), 'a\\|b');
});
