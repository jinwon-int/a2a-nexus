#!/usr/bin/env node
// Conformance check: source-only a2a-verifiable-analysis-report product package (#1483).
//
// This validates the public-safe sample report package that would be extracted
// as the first product slice: report hash, offline report verifier, signed
// finalizer verdict subject binding, artifact manifest, and no-live/public-safe
// safety flags. It performs no broker, network, release, publish, or dashboard
// action.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { verifyAnalysisReportProductPackage } from '../../scripts/verify-analysis-report.mjs';

const PRODUCT_PATH = 'fixtures/contract/verifiable-analysis-report-product.json';
const KEYRING_PATH = 'fixtures/contract/verifiable-analysis-report-product-keyring.json';

function loadFixture() {
  return {
    product: JSON.parse(readFileSync(PRODUCT_PATH, 'utf8')),
    keyring: JSON.parse(readFileSync(KEYRING_PATH, 'utf8')),
  };
}

function checkIds(result) {
  return new Set(result.checks.map((check) => check.id));
}

function assertInvalid(mutator, expectedCheckId) {
  const { product, keyring } = loadFixture();
  mutator(product, keyring);
  const result = verifyAnalysisReportProductPackage(product, keyring);
  assert.equal(result.green, false, `mutation should fail: ${expectedCheckId}`);
  assert.ok(checkIds(result).has(expectedCheckId), `missing expected check id ${expectedCheckId}: ${JSON.stringify(result.checks)}`);
}

const { product, keyring } = loadFixture();
const result = verifyAnalysisReportProductPackage(product, keyring);
assert.equal(result.green, true, JSON.stringify(result.checks));
for (const id of [
  'report-verifier',
  'report-hash',
  'artifact-manifest-hash',
  'artifact-manifest-report-artifact',
  'artifact-manifest-public-safety',
  'finalizer-verdict',
  'public-safe-report',
]) {
  assert.equal(result.checks.find((check) => check.id === id)?.ok, true, `${id} should pass`);
}
assert.equal(product.sourceOnly, true);
assert.equal(product.noLive, true);
assert.equal(product.artifactManifest.liveBrokerDashboard, false);
assert.equal(product.artifactManifest.releasePublished, false);
assert.equal(product.artifactManifest.publicSafety.containsPrivatePaths, false);
assert.equal(product.artifactManifest.publicSafety.containsRawLogs, false);
assert.equal(product.artifactManifest.publicSafety.containsTokens, false);
assert.equal(product.artifactManifest.publicSafety.containsProviderIds, false);
assert.match(product.problemStatement, /offline/);

const cli = spawnSync(process.execPath, [
  'scripts/verify-analysis-report.mjs',
  PRODUCT_PATH,
  '--keyring',
  KEYRING_PATH,
  '--product',
  '--json',
], { encoding: 'utf8' });
assert.equal(cli.status, 0, cli.stderr || cli.stdout);
assert.equal(JSON.parse(cli.stdout).green, true);

assertInvalid((candidate) => { candidate.report.result.summary = 'tampered after packaging'; }, 'report-verifier');
assertInvalid((candidate) => { candidate.reportHash = 'sha256:' + '0'.repeat(64); }, 'report-hash');
assertInvalid((candidate) => { candidate.artifactManifest.publicSafety.containsTokens = true; }, 'artifact-manifest-public-safety');
assertInvalid((candidate) => { candidate.artifactManifest.artifacts = []; }, 'artifact-manifest-report-artifact');
assertInvalid((candidate) => { candidate.finalizerVerdict.subject.reportHash = 'sha256:' + '1'.repeat(64); }, 'finalizer-verdict');
assertInvalid((candidate) => { candidate.report.sources[0].content += '\n/root/private-path\n'; }, 'report-verifier');
assertInvalid((candidate) => { candidate.artifactManifest.releasePublished = true; }, 'artifact-manifest-source-only');

console.log('verifiable-analysis-report product fixture check: passed');
