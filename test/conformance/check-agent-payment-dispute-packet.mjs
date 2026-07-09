#!/usr/bin/env node
// Conformance check: source-only Agent Payment Dispute Packet (#1488).
//
// Validates the sample dispute packet and offline verifier. This check does not
// call payment rails/providers, move funds, custody escrow, deploy webhooks,
// contact brokers, mutate DB/outbox/ACK/replay state, or use secrets.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { verifyAgentPaymentDisputePacket } from '../../scripts/lib/agent-payment-dispute-packet-verifier.mjs';

const PACKET_PATH = 'fixtures/contract/agent-payment-dispute-packet.json';
const KEYRING_PATH = 'fixtures/contract/agent-payment-dispute-packet-keyring.json';
const ISSUE_URL = 'https://github.com/jinwon-int/a2a-nexus/issues/1488';
const NOW = '2026-07-09T08:20:00.000Z';
const ZERO_HASH = `sha256:${'0'.repeat(64)}`;
const ONE_HASH = `sha256:${'1'.repeat(64)}`;

function loadFixture() {
  return {
    packet: JSON.parse(readFileSync(PACKET_PATH, 'utf8')),
    keyring: JSON.parse(readFileSync(KEYRING_PATH, 'utf8')),
  };
}

function checkIds(result) {
  return new Set(result.checks.map((check) => check.id));
}

function assertInvalid(mutator, expectedCheckId) {
  const { packet, keyring } = loadFixture();
  mutator(packet, keyring);
  const result = verifyAgentPaymentDisputePacket(packet, keyring, { now: NOW });
  assert.equal(result.green, false, `mutation should fail: ${expectedCheckId}`);
  assert.equal(result.releaseAllowed, false, `mutation must not allow release: ${expectedCheckId}`);
  assert.ok(checkIds(result).has(expectedCheckId), `missing expected check id ${expectedCheckId}: ${JSON.stringify(result.checks)}`);
}

const { packet, keyring } = loadFixture();
const result = verifyAgentPaymentDisputePacket(packet, keyring, { now: NOW });
assert.equal(result.green, true, JSON.stringify(result.checks));
assert.equal(result.decision, 'release_authorized');
assert.equal(result.expectedDecision, 'release_authorized');
assert.equal(result.expectedReason, 'RELEASE_AUTHORIZED');
assert.equal(result.releaseAllowed, true);
assert.ok(packet.issueRefs.some((issueRef) => issueRef === ISSUE_URL));
for (const id of [
  'packet-source-only',
  'payment-boundary',
  'public-safe-packet',
  'dispute-shape',
  'escrow-release-proof',
  'escrow-release-proof-hash',
  'mandate-shape',
  'mandate-hash',
  'mandate-public-safety',
  'mandate-verification',
  'agent-identity',
  'task-contract-shape',
  'payment-reference-binding',
  'scope-decision-shape',
  'scope-checks',
  'scope-decision',
  'completion-proof',
  'release-decision',
  'reason-codes',
  'packet-verdict',
  'assurance-boundary',
  'extraction-boundary',
]) {
  assert.equal(result.checks.find((check) => check.id === id)?.ok, true, `${id} should pass`);
}
for (const boundary of [
  'card_network_authorization',
  'funds_available',
  'legal_identity_of_human',
  'tax_or_regulatory_compliance',
  'final_chargeback_liability',
]) {
  assert.ok(packet.doesNotProve.includes(boundary), `doesNotProve must include ${boundary}`);
}
assert.equal(packet.paymentBoundary.paymentRailCall, false);
assert.equal(packet.paymentBoundary.paymentAuthorization, false);
assert.equal(packet.paymentBoundary.fundsMovement, false);
assert.equal(packet.paymentBoundary.escrowCustody, false);
assert.equal(packet.paymentBoundary.rawCardDataPresent, false);

const cli = spawnSync(process.execPath, [
  'scripts/verify-agent-payment-dispute-packet.mjs',
  PACKET_PATH,
  '--keyring',
  KEYRING_PATH,
  '--now',
  NOW,
  '--json',
], { encoding: 'utf8' });
assert.equal(cli.status, 0, cli.stderr || cli.stdout);
assert.equal(JSON.parse(cli.stdout).releaseAllowed, true);

assertInvalid((candidate) => { candidate.sourceOnly = false; }, 'packet-source-only');
assertInvalid((candidate) => { candidate.paymentBoundary.paymentRailCall = true; }, 'payment-boundary');
assertInvalid((candidate) => { candidate.paymentBoundary.rawCardDataPresent = true; }, 'payment-boundary');
assertInvalid((candidate) => { candidate.publicSafety.containsTokens = true; }, 'public-safe-packet');
assertInvalid((candidate) => { candidate.telegramChatId = '123456789'; }, 'public-safe-packet');
assertInvalid((candidate) => { candidate.paymentProviderId = 'private-provider-123'; }, 'public-safe-packet');
assertInvalid((candidate) => { candidate.rawPan = 'redacted-pan-placeholder'; }, 'public-safe-packet');
assertInvalid((candidate) => { candidate.dispute.paymentReferenceHash = 'provider-intent-raw-id'; }, 'dispute-shape');
assertInvalid((candidate) => { candidate.dispute.rawPaymentReferencePresent = true; }, 'dispute-shape');
assertInvalid((candidate) => { delete candidate.mandate; }, 'mandate-shape');
assertInvalid((candidate) => { candidate.mandate.mandateHash = ZERO_HASH; }, 'mandate-hash');
assertInvalid((candidate) => { candidate.mandate.verification = 'invalid'; }, 'mandate-verification');
assertInvalid((candidate) => { candidate.mandate.mandatePayload.authorization.verification = 'invalid'; }, 'mandate-verification');
assertInvalid((candidate) => { candidate.mandate.mandatePayload.privacy.rawCardDataPresent = true; }, 'mandate-public-safety');
assertInvalid((candidate) => { candidate.agentIdentity.agentKeyId = 'agent-key:other'; }, 'agent-identity');
assertInvalid((candidate) => { candidate.taskContract.paymentReferenceHash = ONE_HASH; }, 'payment-reference-binding');
assertInvalid((candidate) => { candidate.taskContract.intent = 'purchase_unapproved_item'; }, 'scope-checks');
assertInvalid((candidate) => { candidate.taskContract.amount.value = '520.00'; }, 'scope-checks');
assertInvalid((candidate) => { candidate.taskContract.merchantRef = 'merchant:unlisted'; }, 'scope-checks');
assertInvalid((candidate) => { candidate.mandate.mandatePayload.scope.deadline = '2026-07-08T00:00:00.000Z'; }, 'scope-checks');
assertInvalid((candidate) => { candidate.mandate.mandatePayload.scope.freshApprovalRequired = true; }, 'scope-checks');
assertInvalid((candidate) => { candidate.scopeDecision.checks[0].status = 'failed'; }, 'scope-checks');
assertInvalid((candidate) => { candidate.scopeDecision.decision = 'pending'; }, 'scope-decision');
assertInvalid((candidate) => { candidate.escrowReleaseProofHash = ZERO_HASH; }, 'escrow-release-proof-hash');
assertInvalid((candidate) => { candidate.escrowReleaseProof.releaseDecision.decision = 'release_pending'; }, 'escrow-release-proof');
assertInvalid((candidate) => { candidate.completionProof.escrowReleaseProofHash = ZERO_HASH; }, 'completion-proof');
assertInvalid((candidate) => { candidate.releaseDecision.decision = 'release_pending'; candidate.releaseDecision.releaseState = 'release_pending'; }, 'release-decision');
assertInvalid((candidate) => { candidate.releaseDecision.reasonCodes = ['USER_DELEGATION_VALID']; }, 'reason-codes');
assertInvalid((candidate) => {
  candidate.taskContract.amount.value = '520.00';
  candidate.scopeDecision.decision = 'rejected';
  candidate.scopeDecision.checks.find((check) => check.id === 'amount_within_cap').status = 'failed';
  candidate.releaseDecision.decision = 'release_rejected';
  candidate.releaseDecision.releaseState = 'release_rejected';
  candidate.releaseDecision.reasonCodes = ['INCONCLUSIVE_EVIDENCE'];
}, 'reason-codes');
assertInvalid((candidate) => { candidate.packetVerdict.subject.mandateHash = ZERO_HASH; }, 'packet-verdict');
assertInvalid((candidate, keys) => { delete keys.keys[candidate.packetVerdict.finalizerKeyId]; }, 'packet-verdict');
assertInvalid((candidate) => { candidate.doesNotProve = ['card_network_authorization']; candidate.assurance.doesNotProve = ['card_network_authorization']; }, 'assurance-boundary');
assertInvalid((candidate) => { candidate.extractionReadiness.pspAdapterEnabled = true; }, 'extraction-boundary');

console.log('agent-payment-dispute-packet fixture check: passed');
