/**
 * Conformance check: platform-independent A2A adapter conformance matrix (#918/#922).
 *
 * Safety: source-only fixture validation. This script does not contact a broker,
 * provider, database, Docker runner, Hermes CLI, OpenClaw Gateway, or terminal
 * outbox.
 */

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const fixturePath = path.join(root, 'fixtures', 'contract', 'adapter-conformance-matrix.json');
const fixtureText = fs.readFileSync(fixturePath, 'utf8');
const fixture = JSON.parse(fixtureText);

const forbiddenRuntimePaths = [
  'AGENTS.md',
  'SOUL.md',
  'USER.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  'IDENTITY.md',
  '.openclaw/',
];
const secretLikePatterns = [
  /ghp_[A-Za-z0-9_]{20,}/,
  /github_pat_[A-Za-z0-9_]+/,
  /xox[baprs]-[A-Za-z0-9-]+/,
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
  /\/home\/[A-Za-z0-9._-]+\//,
  /\/Users\/[A-Za-z0-9._-]+\//,
];

for (const forbiddenPath of forbiddenRuntimePaths) {
  assert.ok(
    !fixtureText.includes(forbiddenPath),
    `adapter conformance fixture must not reference runtime/bootstrap path ${forbiddenPath}`,
  );
}
for (const pattern of secretLikePatterns) {
  assert.ok(!pattern.test(fixtureText), `adapter conformance fixture matched forbidden pattern ${pattern}`);
}

assert.equal(fixture.meta.contract, 'adapter-conformance-matrix');
assert.ok(fixture.meta.issues.includes('https://github.com/jinwon-int/a2a-nexus/issues/918'));
assert.ok(fixture.meta.issues.includes('https://github.com/jinwon-int/a2a-nexus/issues/922'));
assert.equal(fixture.meta.redacted, true);
assert.equal(fixture.v0Freeze.sourceOnly, true);
assert.equal(fixture.v0Freeze.noLive, true);

for (const [key, value] of Object.entries(fixture.safety)) {
  assert.equal(value, false, `safety.${key} must be false`);
}

const requiredCategoryIds = [
  'claim-poll',
  'report-status',
  'heartbeat',
  'terminal-evidence',
  'idempotency-dedupe',
  'fail-closed-redaction',
];
const categories = new Map(fixture.conformanceCategories.map((category) => [category.id, category]));
assert.deepEqual([...categories.keys()].sort(), requiredCategoryIds.sort());
for (const id of requiredCategoryIds) {
  const category = categories.get(id);
  assert.ok(category.contractRef, `${id} must carry a contractRef`);
  assert.ok(category.passCriteria.length > 0, `${id} must define passCriteria`);
}

assert.ok(Array.isArray(fixture.adapterFixtures) && fixture.adapterFixtures.length >= 2);
const adapterFixtures = new Map(fixture.adapterFixtures.map((adapter) => [adapter.id, adapter]));
const allowedClassifications = new Set([
  'conformant',
  'reference_conformant',
  'intentional_fail',
  'source_blocked',
  'wrapper_only',
  'fail_closed_redaction',
]);
for (const adapter of fixture.adapterFixtures) {
  assert.ok(adapter.platform, `${adapter.id} must declare platform`);
  assert.ok(adapter.harnessKind, `${adapter.id} must declare harnessKind`);
  assert.ok(allowedClassifications.has(adapter.expectedClassification),
    `${adapter.id} has unknown expectedClassification ${adapter.expectedClassification}`);
  assert.equal(adapter.coreDependency.freeOfOpenClawPluginSdk, true,
    `${adapter.id} core conformance must not depend on the OpenClaw plugin SDK`);
  assert.equal(adapter.coreDependency.freeOfHermesCli, true,
    `${adapter.id} core conformance must not depend on Hermes CLI`);
  assert.equal(adapter.coreDependency.freeOfDockerRunner, true,
    `${adapter.id} core conformance must not depend on Docker runner`);
  const resultIds = new Set(adapter.categoryResults.map((result) => result.categoryId));
  for (const id of requiredCategoryIds) {
    assert.ok(resultIds.has(id), `${adapter.id} must classify ${id}`);
  }
}

const hermesReference = adapterFixtures.get('hermes-native-http-poll-reference');
assert.ok(hermesReference, 'must define Hermes/native http-poll reference path');
assert.equal(hermesReference.platform, 'hermes');
assert.equal(hermesReference.referencePath.transport, 'http-poll');
assert.equal(hermesReference.referencePath.openClawPluginSdkRequired, false);
for (const operation of ['register', 'heartbeat', 'pollTasks', 'claimTask', 'submitEvidence']) {
  assert.ok(hermesReference.referencePath.operations.includes(operation),
    `Hermes reference path must include ${operation}`);
}

const openclawReference = adapterFixtures.get('openclaw-reference-integration');
assert.ok(openclawReference, 'must preserve OpenClaw as a reference integration');
assert.equal(openclawReference.role, 'reference-integration');
assert.equal(openclawReference.substrate, false);
assert.equal(openclawReference.coreDependency.freeOfOpenClawPluginSdk, true);
assert.ok(openclawReference.referenceIntegrationNotes.some((note) => note.includes('optional transport')));

const scenarios = new Map(fixture.classifiedScenarios.map((scenario) => [scenario.id, scenario]));
for (const id of [
  'hermes-http-poll-happy-path',
  'openclaw-reference-wrapper-path',
  'duplicate-terminal-evidence-deduped',
  'unredacted-terminal-evidence-fail-closed',
  'harness-neutral-source-bundle-ok',
  'harness-neutral-missing-source-carrier-blocked',
]) {
  assert.ok(scenarios.has(id), `missing classified scenario ${id}`);
}
assert.equal(scenarios.get('unredacted-terminal-evidence-fail-closed').expect.classification,
  'fail_closed_redaction');
assert.equal(scenarios.get('unredacted-terminal-evidence-fail-closed').expect.countsAsConformance, false);
assert.equal(scenarios.get('unredacted-terminal-evidence-fail-closed').expect.action, 'reject-before-broker-send');
assert.equal(scenarios.get('unredacted-terminal-evidence-fail-closed').expect.liveProviderSend, false);

assert.equal(scenarios.get('duplicate-terminal-evidence-deduped').expect.status, 'deduplicated');
assert.equal(scenarios.get('duplicate-terminal-evidence-deduped').expect.newEvidenceCreated, false);
assert.equal(scenarios.get('duplicate-terminal-evidence-deduped').expect.returnedExistingEvidence, true);

assert.equal(fixture.harnessNeutralAnalysisBridge.sourceOnly, true);
assert.equal(fixture.harnessNeutralAnalysisBridge.noLive, true);
for (const carrier of ['payload.repo+paths', 'payload.sourceBundle.files[]', 'payload.sourceEvidence[]', 'githubRefs']) {
  assert.ok(fixture.harnessNeutralAnalysisBridge.allowedEvidenceCarriers.includes(carrier),
    `missing harness-neutral evidence carrier ${carrier}`);
}
const bridgeScenario = scenarios.get('harness-neutral-missing-source-carrier-blocked');
assert.equal(bridgeScenario.expect.classification, 'source_blocked');
assert.equal(bridgeScenario.expect.countsAsWorkerOpinion, false);
assert.equal(bridgeScenario.expect.countsAsConformance, false);

assert.ok(fixture.validationCommands.includes('node test/conformance/check-adapter-conformance-matrix.mjs'));
assert.ok(fixture.validationCommands.includes('npm run test:conformance'));

console.log('✅ adapter-conformance-matrix fixture: platform-independent checks passed');
