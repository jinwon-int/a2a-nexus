import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { evaluateBudgets, countTopLevelMjs, collectCounts, BUDGETS } from './check-script-budget.mjs';

const BUDGET = { scriptsMjs: 10, rootNpmScripts: 5, brokerNpmScripts: 5 };

test('counts at or under budget pass', () => {
  const result = evaluateBudgets({ scriptsMjs: 10, rootNpmScripts: 4, brokerNpmScripts: 5 }, BUDGET);
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test('any count over budget fails with an actionable message', () => {
  const result = evaluateBudgets({ scriptsMjs: 11, rootNpmScripts: 4, brokerNpmScripts: 5 }, BUDGET);
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /scripts\/\*\.mjs: 11 exceeds budget 10/);
  assert.match(result.failures[0], /a2a-nexus#882/);
});

test('multiple overages are all reported', () => {
  const result = evaluateBudgets({ scriptsMjs: 99, rootNpmScripts: 99, brokerNpmScripts: 99 }, BUDGET);
  assert.equal(result.failures.length, 3);
});

test('countTopLevelMjs counts top-level .mjs and ignores subdirs and other extensions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-'));
  fs.writeFileSync(path.join(dir, 'a.mjs'), '');
  fs.writeFileSync(path.join(dir, 'b.mjs'), '');
  fs.writeFileSync(path.join(dir, 'c.js'), '');
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib', 'd.mjs'), '');
  assert.equal(countTopLevelMjs(dir), 2);
});

test('the live repo stays within its declared budgets', () => {
  const counts = collectCounts(process.cwd());
  const result = evaluateBudgets(counts, BUDGETS);
  assert.ok(result.ok, `budgets exceeded:\n${result.failures.join('\n')}`);
});
