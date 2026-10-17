import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  compareToBaseline,
  findLeakingTestFiles,
  leaksTempDirs,
  loadBaseline,
} from './check-test-mkdtemp-cleanup.mjs';

test('#2386: mkdtemp without any cleanup marker leaks', () => {
  assert.equal(leaksTempDirs("const d = mkdtempSync(join(tmpdir(), 'x-'));"), true);
  assert.equal(leaksTempDirs("const d = await mkdtemp(join(tmpdir(), 'x-'));"), true);
});

test('#2386: any cleanup marker clears the file', () => {
  for (const cleanup of [
    'rmSync(d, { recursive: true, force: true });',
    'await rm(d, { recursive: true });',
    'after(() => {});',
    'afterEach(() => {});',
    't.after(() => {});',
    'withTempDir((d) => d);',
  ]) {
    assert.equal(leaksTempDirs(`const d = mkdtempSync('x-');\n${cleanup}`), false, cleanup);
  }
});

test('#2386: files without mkdtemp never leak', () => {
  assert.equal(leaksTempDirs("const s = 'no temp dirs here';"), false);
});

test('#2386: baseline comparison reports new leaks and removable entries', () => {
  assert.deepEqual(compareToBaseline(['a.test.mjs', 'c.test.mjs'], ['a.test.mjs', 'b.test.mjs']), {
    newLeaks: ['c.test.mjs'],
    removable: ['b.test.mjs'],
  });
});

test('#2386: scanner finds leaking test files and skips node_modules/dist', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'a2a-mkdtemp-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (rel, body) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  write('scripts/leak.test.mjs', "mkdtempSync('x-');");
  write('scripts/clean.test.mjs', "mkdtempSync('x-'); rmSync('x', { recursive: true });");
  write('scripts/helper.mjs', "mkdtempSync('x-');");
  write('node_modules/pkg/leak.test.mjs', "mkdtempSync('x-');");
  write('packages/p/dist/leak.test.js', "mkdtempSync('x-');");
  write('packages/p/src/leak.test.ts', 'mkdtemp(join(tmpdir(), "y-"));');
  assert.deepEqual(findLeakingTestFiles(root), ['packages/p/src/leak.test.ts', 'scripts/leak.test.mjs']);
});

test('#2386: the repository adds no new leaking test file beyond the baseline', () => {
  const { newLeaks } = compareToBaseline(findLeakingTestFiles(), loadBaseline());
  assert.deepEqual(
    newLeaks,
    [],
    'these test files call mkdtemp without cleanup — add rmSync(dir, { recursive: true, force: true }) in an after()/t.after()/finally',
  );
});
