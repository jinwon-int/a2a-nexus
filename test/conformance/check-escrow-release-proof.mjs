#!/usr/bin/env node
// Conformance check: source-only a2a-escrow-proof release-condition proof (#1482).
//
// Validates the sample escrow-release proof bundle and its offline verifier. This
// does not call payment rails/providers, move funds, custody escrow, deploy
// webhooks, contact brokers, mutate DB/outbox/ACK/replay state, or use secrets.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { verifyEscrowReleaseProof } from '../../scripts/verify-escrow-release-proof.mjs';

const PROOF_PATH = 'fixtures/contract/escrow-release-proof.json';
const KEYRING_PATH = 'fixtures/contract/escrow-release-proof-keyring.json';
const ISSUE_URL = 'https://github.com/jinwon-int/a2a-nexus/issues/1482';
const NOW = '2026-07-09T07:35:00.000Z';

function loadFixture() {
  return {
    proof: JSON.parse(readFileSync(PROOF_PATH, 'utf8')),
    keyring: JSON.parse(readFileSync(KEYRING_PATH, 'utf8')),
  };
}

function checkIds(result) {
  return new Set(result.checks.map((check) => check.id));
}

function assertInvalid(mutator, expectedCheckId) {
  const { proof, keyring } = loadFixture();
  mutator(proof, keyring);
  const result = verifyEscrowReleaseProof(proof, keyring, { now: NOW });
  assert.equal(result.green, false, `mutation should fail: ${expectedCheckId}`);
  assert.equal(result.releaseAllowed, false, `mutation must not allow release: ${expectedCheckId}`);
  assert.ok(checkIds(result).has(expectedCheckId), `missing expected check id ${expectedCheckId}: ${JSON.stringify(result.checks)}`);
}

const { proof, keyring } = loadFixture();
const result = verifyEscrowReleaseProof(proof, keyring, { now: NOW });
assert.equal(result.green, true, JSON.stringify(result.checks));
assert.equal(result.decision, 'release_authorized');
assert.equal(result.expectedDecision, 'release_authorized');
assert.equal(result.releaseAllowed, true);
for (const id of [
  'bundle-source-only',
  'payment-boundary',
  'public-safe-bundle',
  'agent-work-proof',
  'agent-work-proof-hash',
  'payment-reference-shape',
  'external-rail-conditions-shape',
  'release-condition-hash',
  'required-evidence-binding',
  'condition-statuses',
  'release-decision',
  'release-verdict',
  'assurance-boundary',
  'extraction-boundary',
]) {
  assert.equal(result.checks.find((check) => check.id === id)?.ok, true, `${id} should pass`);
}
assert.equal(Array.isArray(proof.issueRefs), true);
assert.ok(proof.issueRefs.some((issue) => issue === ISSUE_URL));
assert.equal(proof.paymentBoundary.paymentRailCall, false);
assert.equal(proof.paymentBoundary.escrowCustody, false);
assert.equal(proof.paymentBoundary.fundsMovement, false);
assert.equal(proof.paymentBoundary.providerCredentialRequired, false);
assert.equal(proof.releaseDecision.approvalState, 'approval_not_required');
assert.equal(proof.releaseDecision.releaseState, 'release_authorized');
assert.ok(proof.assurance.doesNotProve.includes('payment-authorized'));
assert.ok(proof.assurance.doesNotProve.includes('chargeback-liability'));

const cli = spawnSync(process.execPath, [
  'scripts/verify-escrow-release-proof.mjs',
  PROOF_PATH,
  '--keyring',
  KEYRING_PATH,
  '--now',
  NOW,
  '--json',
], { encoding: 'utf8' });
assert.equal(cli.status, 0, cli.stderr || cli.stdout);
assert.equal(JSON.parse(cli.stdout).releaseAllowed, true);

assertInvalid((candidate) => { candidate.sourceOnly = false; }, 'bundle-source-only');
assertInvalid((candidate) => { candidate.paymentBoundary.paymentRailCall = true; }, 'payment-boundary');
assertInvalid((candidate) => { candidate.paymentBoundary.escrowCustody = true; }, 'payment-boundary');
assertInvalid((candidate) => { candidate.paymentBoundary.rawCardDataPresent = true; }, 'payment-boundary');
assertInvalid((candidate) => { candidate.publicSafety.containsTokens = true; }, 'public-safe-bundle');
assertInvalid((candidate) => { candidate.paymentProviderId = 'private-provider-123'; }, 'public-safe-bundle');
assertInvalid((candidate) => { candidate.telegramChatId = '123456789'; }, 'public-safe-bundle');
assertInvalid((candidate) => { candidate.cardNumber = 'redacted-card-placeholder'; }, 'public-safe-bundle');
assertInvalid((candidate) => { candidate.agentWorkProof.evidence.completionCertificate.subject.workerId = 'worker:other'; }, 'agent-work-proof');
assertInvalid((candidate) => { candidate.agentWorkProofHash = `sha256:${'0'.repeat(64)}`; }, 'agent-work-proof-hash');
assertInvalid((candidate) => { candidate.releaseCondition.paymentReferenceHash = 'provider-intent-raw-id'; }, 'payment-reference-shape');
assertInvalid((candidate) => { candidate.releaseCondition.escrowReference.rawEscrowIdPresent = true; }, 'payment-reference-shape');
assertInvalid((candidate) => { delete candidate.releaseCondition.externalRailConditions; }, 'external-rail-conditions-shape');
assertInvalid((candidate) => { candidate.releaseCondition.requiredEvidence.deterministicChecks = []; }, 'required-evidence-binding');
assertInvalid((candidate) => { candidate.releaseCondition.checks = []; }, 'condition-statuses');
assertInvalid((candidate) => { candidate.releaseCondition.checks[1].status = 'unknown'; }, 'condition-statuses');
assertInvalid((candidate) => { candidate.releaseCondition.checks[1].status = 'pending'; }, 'release-decision');
assertInvalid((candidate) => { candidate.releaseCondition.externalRailConditions.push({ id: 'future-rail-confirmation', kind: 'rail-side-condition', status: 'pending' }); }, 'release-decision');
assertInvalid((candidate) => { candidate.releaseCondition.checks[1].status = 'failed'; }, 'release-decision');
assertInvalid((candidate) => { candidate.releaseCondition.checks[1].status = 'blocked'; }, 'release-decision');
assertInvalid((candidate) => { candidate.releaseCondition.checks[1].status = 'inconclusive'; }, 'release-decision');
assertInvalid((candidate) => {
  candidate.releaseCondition.approval.required = true;
  candidate.releaseCondition.approval.status = 'missing';
}, 'release-decision');
assertInvalid((candidate) => { candidate.releaseDecision.decision = 'release_pending'; candidate.releaseDecision.releaseState = 'release_pending'; }, 'release-decision');
assertInvalid((candidate) => { candidate.releaseVerdict.subject.agentWorkProofHash = `sha256:${'1'.repeat(64)}`; }, 'release-verdict');
assertInvalid((candidate, keys) => { delete keys.keys[candidate.releaseVerdict.finalizerKeyId]; }, 'release-verdict');
assertInvalid((candidate) => { candidate.extractionReadiness.liveWebhookDeployment = true; }, 'extraction-boundary');
assertInvalid((candidate) => { candidate.assurance.doesNotProve = ['payment-authorized']; }, 'assurance-boundary');

console.log('escrow-release-proof fixture check: passed');
