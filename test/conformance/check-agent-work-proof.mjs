#!/usr/bin/env node
// Conformance check: source-only a2a-agent-work-proof bundle (#1481).
//
// Validates that the sample work-proof bundle composes existing offline proof
// primitives: verifiable analysis report product, certification battery,
// completion certificate, artifact manifest, and signed work-proof verdict.
// It performs no broker, network, release, registry, badge, provider, DB, ACK,
// deploy, restart, visibility, or secret action.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { verifyAgentWorkProofBundle } from '../../scripts/verify-agent-work-proof.mjs';

const BUNDLE_PATH = 'fixtures/contract/agent-work-proof-bundle.json';
const KEYRING_PATH = 'fixtures/contract/agent-work-proof-keyring.json';
const ISSUE_URL = 'https://github.com/jinwon-int/a2a-nexus/issues/1481';

function loadFixture() {
  return {
    bundle: JSON.parse(readFileSync(BUNDLE_PATH, 'utf8')),
    keyring: JSON.parse(readFileSync(KEYRING_PATH, 'utf8')),
  };
}

function checkIds(result) {
  return new Set(result.checks.map((check) => check.id));
}

function assertInvalid(mutator, expectedCheckId) {
  const { bundle, keyring } = loadFixture();
  mutator(bundle, keyring);
  const result = verifyAgentWorkProofBundle(bundle, keyring, { now: '2026-07-09T06:10:00.000Z' });
  assert.equal(result.green, false, `mutation should fail: ${expectedCheckId}`);
  assert.ok(checkIds(result).has(expectedCheckId), `missing expected check id ${expectedCheckId}: ${JSON.stringify(result.checks)}`);
}

const { bundle, keyring } = loadFixture();
const result = verifyAgentWorkProofBundle(bundle, keyring, { now: '2026-07-09T06:10:00.000Z' });
assert.equal(result.green, true, JSON.stringify(result.checks));
for (const id of [
  'bundle-source-only',
  'public-safe-bundle',
  'evidence-hashes',
  'task-report-binding',
  'verifiable-analysis-report-product',
  'certification-battery',
  'completion-certificate',
  'artifact-manifest-artifacts',
  'work-proof-verdict',
  'assurance-boundary',
  'extraction-boundary',
]) {
  assert.equal(result.checks.find((check) => check.id === id)?.ok, true, `${id} should pass`);
}
assert.equal(bundle.sourceOnly, true);
assert.equal(bundle.noLive, true);
assert.equal(bundle.artifactManifest.releasePublished, false);
assert.equal(bundle.artifactManifest.registryWrite, false);
assert.equal(bundle.artifactManifest.badgePublication, false);
assert.equal(bundle.artifactManifest.liveBrokerDashboard, false);
assert.equal(Array.isArray(bundle.issueRefs), true);
assert.ok(bundle.issueRefs.some((issue) => issue === ISSUE_URL));
assert.equal(bundle.workProofVerdict.kind, 'judgment');
assert.ok(bundle.workProofVerdict.assurance.doesNotProve.includes('reproducibility'));
assert.equal(bundle.extractionReadiness.decision, 'defer-extraction-until-external-demand');

const cli = spawnSync(process.execPath, [
  'scripts/verify-agent-work-proof.mjs',
  BUNDLE_PATH,
  '--keyring',
  KEYRING_PATH,
  '--now',
  '2026-07-09T06:10:00.000Z',
  '--json',
], { encoding: 'utf8' });
assert.equal(cli.status, 0, cli.stderr || cli.stdout);
assert.equal(JSON.parse(cli.stdout).green, true);

assertInvalid((candidate) => { candidate.sourceOnly = false; }, 'bundle-source-only');
assertInvalid((candidate) => { candidate.evidenceHashes.reportProductHash = `sha256:${'0'.repeat(64)}`; }, 'evidence-hashes');
assertInvalid((candidate) => { candidate.task.workerId = 'worker:other'; }, 'task-report-binding');
assertInvalid((candidate) => { candidate.evidence.reportProduct.report.result.summary = 'tampered after work-proof packaging'; }, 'verifiable-analysis-report-product');
assertInvalid((candidate) => { candidate.evidence.certificationBattery.batteryResult.checkResults.push({ ...candidate.evidence.certificationBattery.batteryResult.checkResults[0] }); }, 'certification-battery');
assertInvalid((candidate) => { candidate.evidence.completionCertificate.subject.workerId = 'worker:other'; }, 'completion-certificate');
assertInvalid((candidate) => { candidate.artifactManifest.publicSafety.containsTokens = true; }, 'artifact-manifest-public-safety');
assertInvalid((candidate) => { candidate.artifactManifest.artifacts.pop(); }, 'artifact-manifest-artifacts');
assertInvalid((candidate) => { candidate.workProofVerdict.subject.reportProductHash = `sha256:${'1'.repeat(64)}`; }, 'work-proof-verdict');
assertInvalid((candidate, keys) => { delete keys.keys[candidate.workProofVerdict.finalizerKeyId]; }, 'work-proof-verdict');
assertInvalid((candidate) => { candidate.extractionReadiness.decision = 'extraction-ready'; }, 'extraction-boundary');
assertInvalid((candidate) => { candidate.evidence.reportProduct.report.sources[0].content += '\n/root/private-session.txt\n'; }, 'public-safe-bundle');
assertInvalid((candidate) => { candidate.artifactManifest.telegramChatId = '123456789'; }, 'public-safe-bundle');
assertInvalid((candidate) => { candidate.artifactManifest.providerModelId = 'private-provider-model-1'; }, 'public-safe-bundle');

console.log('agent-work-proof bundle fixture check: passed');
