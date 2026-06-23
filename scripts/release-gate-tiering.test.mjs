import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_TIERS,
  loadReleaseGateInventory,
  parseReleaseGateArgs,
  selectReleaseGateEntries,
  summarizeReleaseGateEntries,
} from './lib/release-gate-steps.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const RELEASE_GATE = join(HERE, 'release-gate.mjs');
const INVENTORY = join(REPO_ROOT, 'docs/ops/release-gate-step-inventory.json');

function runReleaseGate(args = []) {
  return spawnSync(process.execPath, [RELEASE_GATE, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

test('default release gate selects core and public-readiness tiers only', () => {
  const inventory = loadReleaseGateInventory(INVENTORY);
  const entries = selectReleaseGateEntries(inventory);
  assert.deepEqual(DEFAULT_TIERS, ['core', 'public-readiness']);
  assert.ok(entries.length > 0);
  assert.deepEqual(new Set(entries.map((entry) => entry.tier)), new Set(DEFAULT_TIERS));
  assert.ok(entries.some((entry) => entry.name === 'external-secrets'));
  assert.ok(entries.some((entry) => entry.name === 'release-gate-inventory'));
  assert.equal(entries.some((entry) => entry.tier === 'historical-transition'), false);
  assert.equal(entries.some((entry) => entry.tier === 'approval-gated'), false);
  assert.equal(entries.some((entry) => entry.tier === 'package-publication'), false);
});

test('--all selects every inventory entry', () => {
  const inventory = loadReleaseGateInventory(INVENTORY);
  const entries = selectReleaseGateEntries(inventory, { all: true });
  assert.equal(entries.length, inventory.entries.length);
  assert.deepEqual(summarizeReleaseGateEntries(entries), {
    core: 18,
    'public-readiness': 8,
    'historical-transition': 14,
    'approval-gated': 3,
    'package-publication': 2,
  });
});

test('--tier augments the default tier selection', () => {
  const parsed = parseReleaseGateArgs(['--tier', 'historical-transition']);
  assert.equal(parsed.all, false);
  assert.deepEqual(parsed.tiers, ['core', 'public-readiness', 'historical-transition']);
  const inventory = loadReleaseGateInventory(INVENTORY);
  const entries = selectReleaseGateEntries(inventory, parsed);
  assert.ok(entries.some((entry) => entry.tier === 'historical-transition'));
  assert.equal(entries.some((entry) => entry.tier === 'approval-gated'), false);
});

test('unknown tier fails closed', () => {
  const inventory = loadReleaseGateInventory(INVENTORY);
  assert.throws(
    () => selectReleaseGateEntries(inventory, { tiers: ['core', 'does-not-exist'] }),
    /unknown release-gate tier/,
  );
});

test('release-gate --list prints default tiered selection without running steps', () => {
  const inventory = JSON.parse(readFileSync(INVENTORY, 'utf8'));
  const expectedDefault = inventory.entries.filter((entry) => DEFAULT_TIERS.includes(entry.tier));
  const res = runReleaseGate(['--list']);
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trim().split('\n');
  assert.equal(lines.length, expectedDefault.length + 1);
  assert.match(lines.at(-1), /release gate selected 26\/45 step\(s\)/);
  assert.ok(lines.some((line) => line.startsWith('external-secrets\tpublic-readiness\t')));
  assert.equal(lines.some((line) => line.startsWith('monorepo-reentry\thistorical-transition\t')), false);
});

test('release-gate --all --list prints every tier including approval-only paths', () => {
  const inventory = JSON.parse(readFileSync(INVENTORY, 'utf8'));
  const res = runReleaseGate(['--all', '--list']);
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trim().split('\n');
  assert.equal(lines.length, inventory.entries.length + 1);
  assert.match(lines.at(-1), /release gate selected 45\/45 step\(s\)/);
  assert.ok(lines.some((line) => line.startsWith('monorepo-final-operator-signoff\tapproval-gated\t')));
  assert.ok(lines.some((line) => line.startsWith('monorepo-release-package-tag-approval\tpackage-publication\t')));
});
