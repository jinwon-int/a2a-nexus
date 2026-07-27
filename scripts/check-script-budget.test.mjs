import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  evaluateBudgets,
  countTopLevelMjs,
  collectCounts,
  listCoreModules,
  isCeremonyModule,
  BUDGETS,
} from './check-script-budget.mjs';

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

// --- broker core module budgets (#1601) ---

const CORE_BUDGET = { brokerCoreModules: 5, brokerCoreCeremonyModules: 2 };

test('a new core module over budget fails and is told to consolidate', () => {
  const result = evaluateBudgets({ brokerCoreModules: 6, brokerCoreCeremonyModules: 2 }, CORE_BUDGET);
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /broker core modules: 6 exceeds budget 5/);
  assert.match(result.failures[0], /cohesive existing core module/);
});

test('a new ceremony module is told to use the policy document, not a module', () => {
  const result = evaluateBudgets({ brokerCoreModules: 5, brokerCoreCeremonyModules: 3 }, CORE_BUDGET);
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /broker core ceremony modules: 3 exceeds budget 2/);
  assert.match(result.failures[0], /a2a\.broker\.policy\.v1/);
});

test('isCeremonyModule matches approval-workflow stages', () => {
  for (const name of [
    'terminal-brief-sidecar-activation-approval.ts',
    'terminal-brief-sidecar-executor-invocation-rehearsal.ts',
    'terminal-brief-sidecar-dispatcher-preflight-seal.ts',
    'terminal-brief-sidecar-dry-run-start-approval-request.ts',
    'terminal-brief-approval-receipt-ingestor.ts',
    'terminal-brief-sidecar-preflight-evidence-collector.ts',
    'terminal-brief-sidecar-review-decision-ingestor.ts',
    'terminal-brief-sidecar-dry-run-start-canary-plan.ts',
    'terminal-brief-sidecar-approval-grant-proposal.ts',
  ]) {
    assert.equal(isCeremonyModule(name), true, `expected ceremony match: ${name}`);
  }
});

test('isCeremonyModule leaves genuine lifecycle behaviour alone', () => {
  // These name real broker capability, not a stage of a human approval
  // workflow. Catching them would make the budget unfalsifiable — every
  // lifecycle change would read as ceremony regrowth.
  for (const name of [
    'terminal-brief-closeout-gate.ts',
    'terminal-brief-metadata.ts',
    'terminal-brief-routing.ts',
    'cross-broker-terminal-brief.ts',
    'broker.ts',
    'store.ts',
  ]) {
    assert.equal(isCeremonyModule(name), false, `expected no ceremony match: ${name}`);
  }
});

test('listCoreModules walks subdirectories and excludes tests', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-budget-'));
  fs.writeFileSync(path.join(dir, 'broker.ts'), '');
  fs.writeFileSync(path.join(dir, 'broker.test.ts'), '');
  fs.writeFileSync(path.join(dir, 'notes.md'), '');
  fs.mkdirSync(path.join(dir, 'sidecar-default-on'));
  fs.writeFileSync(path.join(dir, 'sidecar-default-on', 'approval-request.ts'), '');
  fs.writeFileSync(path.join(dir, 'sidecar-default-on', 'approval-request.test.ts'), '');

  const modules = listCoreModules(dir).sort();
  assert.deepEqual(modules, ['broker.ts', 'sidecar-default-on/approval-request.ts']);
  assert.equal(modules.filter(isCeremonyModule).length, 1);
});

test('listCoreModules returns empty for a missing directory rather than throwing', () => {
  assert.deepEqual(listCoreModules(path.join(os.tmpdir(), 'definitely-not-here-1601')), []);
});
