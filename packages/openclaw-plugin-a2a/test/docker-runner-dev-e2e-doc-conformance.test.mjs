import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const proof = await readFile(new URL('../docs/docker-runner-dev-e2e-proof.md', import.meta.url), 'utf8');

test('docker-runner dev E2E proof pins runner preset and clean commands', () => {
  assert.match(proof, /plugin-a2a-dev/);
  assert.match(proof, /clean per-task checkout|Checkout: clean/i);
  assert.match(proof, /npm ci/);
  assert.match(proof, /npm test/);
  assert.match(proof, /runner-evidence-split-20260430/);
});

test('docker-runner result artifact contract is linkable to plugin monitoring status', () => {
  assert.match(proof, /schemaVersion: "a2a-docker-runner\.result\.v1"/);
  assert.match(proof, /runnerEvidence\.status = "completed"/);
  assert.match(proof, /a2a\.monitor\.status/);
  assert.match(proof, /artifactUrl/);
  assert.match(proof, /additive-tolerant/);
});

test('docker-runner dev E2E proof documents branch mismatch / no-diff terminal evidence contract', () => {
  assert.match(proof, /No commits between main and/);
  assert.match(proof, /Block.*reason.*No commits/);
  assert.match(proof, /propose_patch/);
  assert.match(proof, /github-propose-patch/);
  assert.match(proof, /ProposalState\.BLOCKED/);
  assert.match(proof, /success:\s*false/);
  assert.match(proof, /no-diff/);
});
