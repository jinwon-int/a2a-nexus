#!/usr/bin/env node
// Conformance check: fake/no-live rail rehearsal adapter (#1393 slice 4).
//
// The test composes the source-only report generator, offline certificate
// verifier, and fake rail adapter. It uses ephemeral in-process Ed25519 keys and
// never contacts payment rails, providers, brokers, GitHub, databases, or moves
// any credential/key material outside temporary test memory.

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

import { generateCompletionCertificate } from '../../scripts/lib/completion-certificate-generator.mjs';
import { rehearseFakeRailRelease } from '../../scripts/lib/completion-certificate-fake-rail.mjs';

const NOW = '2026-07-09T00:00:00Z';
const ISSUED_AT = '2026-07-08T00:00:00Z';
const EXPIRES_AT = '2026-07-15T00:00:00Z';
const CREATED_AT = '2026-07-09T00:01:00Z';
const KEY_ID = 'broker:broker-alpha:completion:fake-rail-ephemeral-test';
const BROKER_ID = 'broker-alpha';
const BASE_OPTIONS = {
  sourceOnly: true,
  noLive: true,
  escrowId: 'fake-escrow-1393-rehearsal',
  idempotencyKey: 'idem-1393-fake-rail-001',
  amount: { currency: 'TESTUSD', value: '12.34' },
  now: NOW,
  createdAt: CREATED_AT,
};

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const keyring = { keys: { [KEY_ID]: { pem: publicPem, status: 'active', notBefore: '2026-07-01T00:00:00Z', expiresAt: '2026-08-01T00:00:00Z' } } };

function baseReport(patch = {}) {
  const report = {
    schemaVersion: 'a2a.completion.report.v0',
    sourceOnly: true,
    noLive: true,
    subject: {
      kind: 'task-result',
      taskId: 'task-1393-fake-rail-eligible',
      workerId: 'worker-alpha',
      resultHash: `sha256:${'1'.repeat(64)}`,
      artifactHashes: [`sha256:${'2'.repeat(64)}`],
    },
    completionConditions: {
      schemaVersion: 'a2a.completion.conditions.v0',
      requiredBatteries: ['unit-tests', 'contract-conformance'],
      requiredVerdict: 'go',
      artifactHashRequired: true,
      externalConditions: [],
    },
    evidence: {
      batteries: [
        { id: 'unit-tests', status: 'met', evidenceRef: `battery-verdict:unit-tests:sha256:${'3'.repeat(64)}` },
        { id: 'contract-conformance', status: 'met', evidenceRef: `battery-verdict:contract-conformance:sha256:${'4'.repeat(64)}` },
      ],
      finalizerVerdict: { status: 'go', evidenceRef: `finalizer-verdict:sha256:${'5'.repeat(64)}` },
    },
    issuer: { brokerId: BROKER_ID, keyId: KEY_ID },
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
  };
  return { ...report, ...patch };
}

function cert(report) {
  return generateCompletionCertificate(report, { signingKeyPem: privatePem });
}

const eligible = cert(baseReport());
const eligibleReceipt = rehearseFakeRailRelease(eligible, keyring, {
  ...BASE_OPTIONS,
  expectedSubject: eligible.subject,
});
assert.equal(eligibleReceipt.schemaVersion, 'a2a.completion.fakeRailReceipt.v0');
assert.equal(eligibleReceipt.rail, 'fake-no-live');
assert.equal(eligibleReceipt.releaseAuthorized, true);
assert.equal(eligibleReceipt.rehearsalDecision, 'fake-release-authorized');
assert.equal(eligibleReceipt.reason, 'completion-certificate-eligible');
assert.equal(eligibleReceipt.safety.paymentRailCall, false);
assert.equal(eligibleReceipt.safety.fundsMovement, false);
assert.equal(eligibleReceipt.safety.databaseMutation, false);
assert.ok(eligibleReceipt.assurance.doesNotProve.includes('payment-authorized'));
assert.ok(eligibleReceipt.assurance.doesNotProve.includes('funds-available'));
assert.ok(eligibleReceipt.receiptId.startsWith('fake-no-live:sha256:'));

const replayReceipt = rehearseFakeRailRelease(eligible, keyring, {
  ...BASE_OPTIONS,
  expectedSubject: eligible.subject,
});
assert.equal(replayReceipt.receiptId, eligibleReceipt.receiptId, 'same idempotency key + same certificate must produce stable receipt id');
const newIdempotencyReceipt = rehearseFakeRailRelease(eligible, keyring, {
  ...BASE_OPTIONS,
  idempotencyKey: 'idem-1393-fake-rail-002',
  expectedSubject: eligible.subject,
});
assert.notEqual(newIdempotencyReceipt.receiptId, eligibleReceipt.receiptId, 'idempotency key must be receipt-bound');

const external = cert(baseReport({
  completionConditions: {
    ...baseReport().completionConditions,
    externalConditions: [
      { id: 'rail-intent-mandate', kind: 'payment-rail-declared-condition', description: 'External rail condition; fake rail does not evaluate it.' },
    ],
  },
}));
const externalReceipt = rehearseFakeRailRelease(external, keyring, BASE_OPTIONS);
assert.equal(external.decision, 'external-pending');
assert.equal(externalReceipt.releaseAuthorized, false);
assert.equal(externalReceipt.rehearsalDecision, 'fake-release-pending');
assert.equal(externalReceipt.reason, 'external-rail-condition-pending');
assert.notEqual(externalReceipt.rehearsalDecision, 'fake-release-authorized', 'external-pending must not be release authorization');

const notEligible = cert(baseReport({
  evidence: {
    batteries: [
      { id: 'unit-tests', status: 'met', evidenceRef: `battery-verdict:unit-tests:sha256:${'3'.repeat(64)}` },
    ],
    finalizerVerdict: { status: 'go', evidenceRef: `finalizer-verdict:sha256:${'5'.repeat(64)}` },
  },
}));
const rejectedReceipt = rehearseFakeRailRelease(notEligible, keyring, BASE_OPTIONS);
assert.equal(notEligible.decision, 'not-eligible');
assert.equal(rejectedReceipt.releaseAuthorized, false);
assert.equal(rejectedReceipt.rehearsalDecision, 'fake-release-rejected');
assert.equal(rejectedReceipt.reason, 'completion-certificate-not-eligible');
assert.equal(rejectedReceipt.verification.valid, true, 'honestly derived not-eligible certificate should verify but still reject release rehearsal');

const tampered = JSON.parse(JSON.stringify(eligible));
tampered.subject.taskId = 'task-1393-fake-rail-tampered';
const invalidReceipt = rehearseFakeRailRelease(tampered, keyring, BASE_OPTIONS);
assert.equal(invalidReceipt.releaseAuthorized, false);
assert.equal(invalidReceipt.rehearsalDecision, 'fake-release-rejected');
assert.equal(invalidReceipt.reason, 'completion-certificate-verification-failed');
assert.equal(invalidReceipt.verification.valid, false);
assert.ok(invalidReceipt.verification.checks.some((check) => check.id === 'issuer-signature' && check.ok === false));

assert.throws(() => rehearseFakeRailRelease(eligible, keyring, { ...BASE_OPTIONS, sourceOnly: false }), /sourceOnly=true/);
assert.throws(() => rehearseFakeRailRelease(eligible, keyring, { ...BASE_OPTIONS, noLive: false }), /noLive=true/);
assert.throws(() => rehearseFakeRailRelease(eligible, keyring, { ...BASE_OPTIONS, idempotencyKey: '' }), /idempotencyKey/);

console.log('✅ completion-certificate fake/no-live rail rehearsal: eligible, external-pending, not-eligible, invalid certificate, idempotency, and no-live guards passed');
