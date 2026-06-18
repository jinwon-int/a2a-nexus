import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDocCheckContext } from './doc-check.mjs';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doc-check-'));
}

test('readRel returns file contents and null on missing', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'present.txt'), 'hello');
  const { readRel } = createDocCheckContext({ root });
  assert.equal(readRel('present.txt'), 'hello');
  assert.equal(readRel('missing.txt'), null);
});

test('expect/fail accumulate into the returned failures array', () => {
  const { expect, fail, failures } = createDocCheckContext({ root: tmpRoot() });
  expect(true, 'should not record');
  expect(false, 'recorded condition');
  fail('explicit failure');
  assert.deepEqual(failures, ['recorded condition', 'explicit failure']);
});

test('parseJson returns object, records missing, and records invalid JSON', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'ok.json'), '{"a":1}');
  fs.writeFileSync(path.join(root, 'bad.json'), '{not json');
  const { parseJson, failures } = createDocCheckContext({ root });

  assert.deepEqual(parseJson('ok.json'), { a: 1 });

  assert.equal(parseJson('absent.json'), null);
  assert.ok(failures.includes('missing absent.json'));

  assert.equal(parseJson('bad.json'), null);
  assert.ok(failures.some((m) => m.startsWith('bad.json: invalid JSON:')));
});

test('each context has an isolated failures accumulator', () => {
  const a = createDocCheckContext({ root: tmpRoot() });
  const b = createDocCheckContext({ root: tmpRoot() });
  a.fail('only-a');
  assert.deepEqual(a.failures, ['only-a']);
  assert.deepEqual(b.failures, []);
});

test('finish logs the success message when there are no failures', () => {
  const ctx = createDocCheckContext({ root: tmpRoot() });
  const logged = [];
  const origLog = console.log;
  console.log = (msg) => logged.push(msg);
  try {
    ctx.finish('all good');
  } finally {
    console.log = origLog;
  }
  assert.deepEqual(logged, ['all good']);
});

test('finish reports failures and exits non-zero', () => {
  const ctx = createDocCheckContext({ root: tmpRoot(), name: 'sample check' });
  ctx.fail('boom');
  const errored = [];
  const origError = console.error;
  const origExit = process.exit;
  let exitCode = null;
  console.error = (msg) => errored.push(msg);
  process.exit = (code) => {
    exitCode = code;
    throw new Error('exit');
  };
  try {
    ctx.finish('unused');
  } catch (error) {
    assert.equal(error.message, 'exit');
  } finally {
    console.error = origError;
    process.exit = origExit;
  }
  assert.equal(exitCode, 1);
  assert.ok(errored[0].startsWith('sample check failed:'));
  assert.ok(errored[0].includes('boom'));
});
