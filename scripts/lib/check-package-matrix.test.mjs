import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluatePackageMatrix } from './check-package-matrix.mjs';

const README_OK = [
  '## Repository Map',
  '',
  '| Repository | Public role | Canonical source |',
  '| --- | --- | --- |',
  '| a2a-nexus | Canonical monorepo | **Canonical** — `packages/broker`, `packages/plugin`, `packages/runner` |',
  '',
  '## Package Map',
  '',
  '```text',
  'packages/broker/    # broker',
  'packages/plugin/    # plugin',
  'packages/runner/    # runner',
  'contracts/a2a/      # contracts',
  '```',
  '',
  'All packages are `private`/unpublished, so there is no supported npm install.',
].join('\n');

const PKGS_OK = [
  { dir: 'broker', name: 'a2a-broker', private: true },
  { dir: 'plugin', name: 'plugin-a2a', private: true },
  { dir: 'runner', name: '@openclaw/runner', private: true },
];

test('GREEN: consistent README + all-private manifests passes', () => {
  assert.deepEqual(evaluatePackageMatrix(PKGS_OK, README_OK), []);
});

test('RED: a real package missing from the Package Map fails', () => {
  const pkgs = [...PKGS_OK, { dir: 'newpkg', name: 'new-pkg', private: true }];
  const failures = evaluatePackageMatrix(pkgs, README_OK);
  assert.match(failures.join('\n'), /"Package Map" does not list packages\/newpkg\//);
  assert.match(failures.join('\n'), /"Repository Map" canonical row does not reference packages\/newpkg/);
});

test('RED: a stale Package Map entry (no such package) fails', () => {
  const readme = README_OK.replace('packages/runner/    # runner', 'packages/runner/    # runner\npackages/ghost/    # removed');
  const failures = evaluatePackageMatrix(PKGS_OK, readme);
  assert.match(failures.join('\n'), /"Package Map" lists packages\/ghost\/ but no such package exists/);
});

test('RED: a non-private manifest while README claims all-private fails (visibility drift)', () => {
  const pkgs = [
    { dir: 'broker', name: 'a2a-broker', private: true },
    { dir: 'plugin', name: 'plugin-a2a', private: false },
    { dir: 'runner', name: '@openclaw/runner', private: true },
  ];
  const failures = evaluatePackageMatrix(pkgs, README_OK);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /packages\/plugin \(plugin-a2a\) manifest is not private:true/);
});

test('RED: missing all-private claim fails', () => {
  const readme = README_OK.replace('All packages are `private`/unpublished, so there is no supported npm install.', 'Install however you like.');
  const failures = evaluatePackageMatrix(PKGS_OK, readme);
  assert.match(failures.join('\n'), /must state package publish visibility/);
});

test('edge: missing README returns a single missing failure', () => {
  assert.deepEqual(evaluatePackageMatrix(PKGS_OK, null), ['missing README.md']);
});
