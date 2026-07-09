#!/usr/bin/env node
// Conformance check: certification battery source-only fixture/verifier (#1487).
//
// This validates deterministic battery schema, result hash binding, battery vs
// judgment verdict boundary, sample product-certificate composition, and the
// extraction/demand-signal gate. It performs no live broker/API call, provider
// send, release/tag/publish, registry/badge write, deploy/restart, DB/outbox/
// ACK/replay mutation, CI-OIDC issuance, SLSA/Sigstore operation, or secret use.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { verifyCertificationBatteryBundle } from '../../scripts/lib/certification-battery-verifier.mjs';

const root = process.cwd();
const fixturePath = path.join(root, 'fixtures', 'contract', 'certification-battery.json');
const fixtureText = fs.readFileSync(fixturePath, 'utf8');
const fixture = JSON.parse(fixtureText);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertInvalid(mutator, expectedCheck) {
  const candidate = clone(fixture);
  mutator(candidate);
  const result = verifyCertificationBatteryBundle(candidate);
  assert.equal(result.ok, false, `${expectedCheck} candidate should fail`);
  assert.ok(
    result.checks.some((check) => check.id === expectedCheck && check.ok === false),
    `missing failing check ${expectedCheck}: ${JSON.stringify(result.checks, null, 2)}`,
  );
}

assert.equal(fixture.meta.contract, 'certification-battery');
assert.equal(fixture.meta.schemaVersion, 'a2a.certification-battery.fixture.v0');
assert.equal(fixture.meta.sourceOnly, true);
assert.equal(fixture.meta.noLive, true);
assert.ok(fixture.meta.issues.includes('https://github.com/jinwon-int/a2a-nexus/issues/1487'));

const valid = verifyCertificationBatteryBundle(fixture, { fixtureText });
assert.equal(valid.ok, true, JSON.stringify(valid.checks.filter((check) => !check.ok), null, 2));
assert.equal(valid.batteryId, 'mcp-plugin-baseline-public-safe');
assert.equal(valid.batteryVersion, 'mcp-plugin-baseline-v0');
assert.match(valid.resultHash, /^sha256:[a-f0-9]{64}$/);

assertInvalid((candidate) => { candidate.batteryPack.deterministic = false; }, 'pack-shape');
assertInvalid((candidate) => { candidate.batteryPack.checks[0].reproducible = false; }, 'pack-checks');
assertInvalid((candidate) => { candidate.batteryResult.packRef.packHash = 'sha256:' + '0'.repeat(64); }, 'result-pack-binding');
assertInvalid((candidate) => { candidate.batteryResult.run.liveNetwork = true; }, 'result-no-live');
assertInvalid((candidate) => { candidate.batteryResult.checkResults[1].status = 'fail'; }, 'result-checks');
assertInvalid((candidate) => { candidate.batteryResult.checkResults.push({ ...candidate.batteryResult.checkResults[0] }); }, 'result-checks');
assertInvalid((candidate) => { candidate.batteryResult.checkResults.push({ id: 'unexpected-check', status: 'pass', outputHash: candidate.batteryResult.checkResults[0].outputHash }); }, 'result-checks');
assertInvalid((candidate) => { candidate.batteryResult.resultHash = 'sha256:' + '1'.repeat(64); }, 'result-hash');
assertInvalid((candidate) => { candidate.batteryVerdict.kind = 'judgment'; }, 'battery-verdict-kind');
assertInvalid((candidate) => { candidate.batteryVerdict.assurance.doesNotProve.push('reproducibility'); }, 'battery-vs-judgment-boundary');
assertInvalid((candidate) => { candidate.judgmentBoundaryExample.assurance.doesNotProve = ['analytical-correctness']; }, 'battery-vs-judgment-boundary');
assertInvalid((candidate) => { candidate.productArtifactCertificateSample.claims[0].evidenceRef = 'battery-verdict:sha256:' + '2'.repeat(64); }, 'certificate-claims');
assertInvalid((candidate) => { candidate.productArtifactCertificateSample.assurance.doesNotProve = ['general-safety']; }, 'certificate-assurance-boundary');
assertInvalid((candidate) => { candidate.extractionReadiness.decision = 'extraction-ready'; }, 'external-demand-ledger');
assertInvalid((candidate) => { candidate.extractionReadiness.registryRequiredForValue = true; }, 'value-without-registry');

assert.ok(fixture.validationCommands.includes('node test/conformance/check-certification-battery.mjs'));
assert.ok(fixture.validationCommands.includes('npm run test:conformance'));

console.log('✅ certification-battery fixture: deterministic pack/result/verdict/certificate binding, no-live boundaries, and extraction demand-signal gate checks passed');
