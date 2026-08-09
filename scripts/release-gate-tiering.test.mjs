import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_TIERS,
  TIER_CONSUMER,
  VALID_CONSUMER,
  VALID_OWNER,
  loadReleaseGateInventory,
  parseReleaseGateArgs,
  selectReleaseGateEntries,
  summarizeReleaseGateEntries,
} from './lib/release-gate-steps.mjs';
import { compareInventory } from './check-release-gate-step-inventory.mjs';
import { validateScriptSurfaceManifest } from './lib/script-surface-manifest.mjs';

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
    core: 40,
    'public-readiness': 11,
    'historical-transition': 2,
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

test('--only-tier replaces the default selection for explicit historical checks', () => {
  const parsed = parseReleaseGateArgs([
    '--only-tier', 'historical-transition',
    '--only-tier', 'approval-gated',
    '--only-tier=package-publication',
  ]);
  assert.equal(parsed.all, false);
  assert.deepEqual(parsed.tiers, ['historical-transition', 'approval-gated', 'package-publication']);
  const inventory = loadReleaseGateInventory(INVENTORY);
  const summary = summarizeReleaseGateEntries(selectReleaseGateEntries(inventory, parsed));
  assert.deepEqual(summary, {
    'historical-transition': 2,
  });
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
  assert.match(lines.at(-1), /release gate selected 51\/53 step\(s\)/);
  assert.ok(lines.some((line) => line.startsWith('external-secrets\tpublic-readiness\t')));
  assert.ok(lines.some((line) => line.startsWith('dependency-advisories\tpublic-readiness\t')));
  assert.equal(lines.some((line) => line.startsWith('split-repo-local-demo\thistorical-transition\t')), false);
});

test('release-gate --all --list prints every tier including approval-only paths', () => {
  const inventory = JSON.parse(readFileSync(INVENTORY, 'utf8'));
  const res = runReleaseGate(['--all', '--list']);
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trim().split('\n');
  assert.equal(lines.length, inventory.entries.length + 1);
  assert.match(lines.at(-1), /release gate selected 53\/53 step\(s\)/);
  assert.ok(lines.some((line) => line.startsWith('split-repo-local-demo\thistorical-transition\t')));
  assert.ok(lines.some((line) => line.startsWith('current-state-no-live-smoke\thistorical-transition\t')));
});

test('#1503: every inventory entry declares owner, tier-consistent consumer, and a retirement condition', () => {
  const inventory = loadReleaseGateInventory(INVENTORY);
  for (const entry of inventory.entries) {
    assert.ok(VALID_OWNER.has(entry.owner), `${entry.name}: unexpected owner ${entry.owner}`);
    assert.ok(VALID_CONSUMER.has(entry.consumer), `${entry.name}: unexpected consumer ${entry.consumer}`);
    assert.equal(
      entry.consumer,
      TIER_CONSUMER[entry.tier],
      `${entry.name}: consumer must follow tier ${entry.tier}`,
    );
    assert.equal(typeof entry.retirementCondition, 'string');
    assert.ok(entry.retirementCondition.length >= 20, `${entry.name}: retirementCondition too short`);
  }
});

test('#1503: inventory guard fails closed on missing or inconsistent ownership metadata', () => {
  const base = {
    generatedFrom: 'scripts/release-gate.mjs',
    tiers: ['core', 'public-readiness'],
    entries: [
      {
        name: 'release-gate-inventory',
        command: 'npm',
        args: ['run', 'check:release-gate-inventory'],
        tier: 'core',
        owner: 'release-gate-tooling',
        consumer: 'pr-gate',
        retirement: 'keep',
        retirementCondition: 'Retire only when a narrower owner-scoped gate covers the same invariant.',
        note: 'Self-check keeping the inventory in lockstep with release-gate.mjs.',
      },
      {
        name: 'external-secrets',
        command: 'npm',
        args: ['run', 'scan:external-secrets'],
        tier: 'public-readiness',
        owner: 'supply-chain-security',
        consumer: 'pr-gate',
        retirement: 'keep',
        retirementCondition: 'Retire only when a narrower owner-scoped gate covers the same invariant.',
        note: 'Public-readiness secret hygiene gate; do not retire as generic.',
      },
    ],
  };
  assert.equal(compareInventory({ inventory: base }).ok, true);

  const missingOwner = structuredClone(base);
  delete missingOwner.entries[0].owner;
  const r1 = compareInventory({ inventory: missingOwner });
  assert.equal(r1.ok, false);
  assert.ok(r1.failures.some((f) => f.includes('invalid owner')));

  const badConsumer = structuredClone(base);
  badConsumer.entries[0].consumer = 'operator-approval';
  const r2 = compareInventory({ inventory: badConsumer });
  assert.equal(r2.ok, false);
  assert.ok(r2.failures.some((f) => f.includes('inconsistent with tier')));

  const missingRetirementCondition = structuredClone(base);
  delete missingRetirementCondition.entries[0].retirementCondition;
  const r3 = compareInventory({ inventory: missingRetirementCondition });
  assert.equal(r3.ok, false);
  assert.ok(r3.failures.some((f) => f.includes('retirementCondition')));
});

test('script surface manifest validates current root and broker package scripts', () => {
  const result = validateScriptSurfaceManifest();
  assert.equal(result.ok, true, result.failures.join('\n'));
  const byId = new Map(result.packages.map((pkg) => [pkg.id, pkg]));
  // #1503 ratchet: counts ratchet down as aliases/manual wrappers retire
  // (Wave 0: root 102→101, broker 156→153; Wave 1: broker 153→95;
  // Wave 2: broker 95→54 via orchestration/rollout dispatchers).
  // Update with each retirement wave.
  // #1766: broker 54→55 for build:image, the verified image-build entrypoint
  // (revision preflight -> docker compose build); mirrored in
  // scripts/check-script-budget.mjs BUDGETS.brokerNpmScripts.
  // Monorepo migration retirement: root 101→84 as the 17 check:monorepo-*
  // aliases retire with the migration ceremony they gated.
  assert.equal(byId.get('root')?.scriptCount, 83);
  assert.equal(byId.get('broker')?.scriptCount, 55);
  assert.ok((byId.get('root')?.kindCounts['required-gate'] ?? 0) >= 7);
  assert.ok((byId.get('broker')?.kindCounts['required-gate'] ?? 0) >= 7);
});

test('#1480: the default release gate executes the committed broker policy document', () => {
  const inventory = loadReleaseGateInventory(INVENTORY);
  const entries = selectReleaseGateEntries(inventory);
  const entry = entries.find((e) => e.name === 'broker-policy-document');
  assert.ok(entry, 'default gate must include the broker-policy-document step');
  assert.equal(entry.tier, 'core');
  assert.equal(entry.consumer, 'pr-gate');
  assert.equal(entry.command, 'node');
  assert.deepEqual(entry.args, ['scripts/check-broker-policy.mjs', 'docs/ops/broker-policy.json']);

  const res = spawnSync(process.execPath, [join(REPO_ROOT, entry.args[0]), entry.args[1]], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /broker policy gate ok: docs\/ops\/broker-policy\.json/);
});

test('#1480: an invalid policy document fails the checker closed without mutating state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-policy-gate-'));
  try {
    const badDoc = join(dir, 'broker-policy.json');
    writeFileSync(
      badDoc,
      JSON.stringify({
        schemaVersion: 'a2a.broker.policy.v1',
        mode: 'warn',
        defaultAction: 'allow',
        rules: [{ id: 'x', workerClass: 'a-worker-name', denyIntents: ['nope'] }],
      }),
    );
    const res = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'check-broker-policy.mjs'), badDoc], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /fail-closed/);
    assert.match(res.stdout, /worker names are rejected/);
    const committed = spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts', 'check-broker-policy.mjs'), join(REPO_ROOT, 'docs', 'ops', 'broker-policy.json')],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    assert.equal(committed.status, 0, committed.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
