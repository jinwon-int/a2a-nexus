import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  discoverScriptTests,
  evaluateReleaseGateManifestCoverage,
} from './check-release-gate-manifest-coverage.mjs';

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-gate-coverage-'));
  fs.mkdirSync(path.join(root, 'scripts/lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs/ops'), { recursive: true });
  writeJson(path.join(root, 'scripts/release-gate-manifest.json'), { entries: [] });
  writeJson(path.join(root, 'docs/ops/release-gate-step-inventory.json'), { entries: [] });
  writeJson(path.join(root, 'package.json'), { scripts: {} });
  return root;
}

test('discoverScriptTests covers scripts/*.test.mjs and scripts/lib/*.test.mjs only', () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'scripts/root.test.mjs'), '');
  fs.writeFileSync(path.join(root, 'scripts/root.mjs'), '');
  fs.writeFileSync(path.join(root, 'scripts/lib/helper.test.mjs'), '');
  fs.mkdirSync(path.join(root, 'scripts/archive'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/archive/old.test.mjs'), '');
  assert.deepEqual(discoverScriptTests(root), [
    'scripts/lib/helper.test.mjs',
    'scripts/root.test.mjs',
  ]);
});

test('coverage fails closed and lists missing test files', () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'scripts/a.test.mjs'), '');
  fs.writeFileSync(path.join(root, 'scripts/lib/b.test.mjs'), '');
  writeJson(path.join(root, 'scripts/release-gate-manifest.json'), {
    entries: [{ file: 'scripts/a.test.mjs', class: 'gate' }],
  });
  const result = evaluateReleaseGateManifestCoverage(root);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['scripts/lib/b.test.mjs']);
});

test('coverage accepts manifest, inventory direct args, and package script implementation peers', () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'scripts/manifest.test.mjs'), '');
  fs.writeFileSync(path.join(root, 'scripts/inventory.test.mjs'), '');
  fs.writeFileSync(path.join(root, 'scripts/package-peer.test.mjs'), '');
  writeJson(path.join(root, 'scripts/release-gate-manifest.json'), {
    entries: [{ file: 'scripts/manifest.test.mjs', class: 'gate' }],
  });
  writeJson(path.join(root, 'docs/ops/release-gate-step-inventory.json'), {
    entries: [{ name: 'inventory', command: 'node', args: ['--test', 'scripts/inventory.test.mjs'], tier: 'core' }],
  });
  writeJson(path.join(root, 'package.json'), {
    scripts: { 'check:peer': 'node scripts/package-peer.mjs' },
  });
  const result = evaluateReleaseGateManifestCoverage(root);
  assert.equal(result.ok, true, result.missing.join('\n'));
});
