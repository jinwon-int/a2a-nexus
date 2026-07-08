#!/usr/bin/env node
// Conformance check: completion certificate offline verifier (#1393 slice 2).
//
// Generates an ephemeral Ed25519 keypair in-process, signs public-safe fixture
// certificates, and verifies the offline verifier fail-closed matrix. It does
// not contact payment rails, providers, brokers, GitHub, databases, or move any
// credential/key material.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalizeJson } from '../../scripts/lib/a2a-offline-verify.mjs';
import { verifyCompletionCertificate } from '../../scripts/lib/completion-certificate-verifier.mjs';

const root = process.cwd();
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'contract', 'completion-certificate.json'), 'utf8'));
const NOW = '2026-07-09T00:00:00Z';
const KEY_ID = 'broker:broker-alpha:completion:v1';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepMerge(base, patch) {
  if (patch === null) return null;
  if (Array.isArray(patch)) return clone(patch);
  if (!patch || typeof patch !== 'object') return patch;
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? clone(base) : {}) };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = deepMerge(out[key], value);
  }
  return out;
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signCertificate(certificate, privateKey, kid = KEY_ID) {
  const signed = clone(certificate);
  signed.issuer.keyId = kid;
  const protectedHeader = base64url(canonicalizeJson({ alg: 'EdDSA', typ: 'JOSE', kid }));
  const { sig: _old, ...unsigned } = signed;
  const payload = base64url(canonicalizeJson(unsigned));
  signed.sig = {
    protected: protectedHeader,
    signature: sign(null, Buffer.from(`${protectedHeader}.${payload}`, 'utf8'), privateKey).toString('base64url'),
  };
  return signed;
}

function reason(result, id) {
  return result.checks.find((check) => check.id === id)?.detail;
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const keyring = { keys: { [KEY_ID]: { pem, status: 'active', notBefore: '2026-07-01T00:00:00Z', expiresAt: '2026-08-01T00:00:00Z' } } };

const eligible = fixture.positiveCertificates.find((entry) => entry.expectDecision === 'eligible')?.certificate;
const external = fixture.positiveCertificates.find((entry) => entry.expectDecision === 'external-pending')?.certificate;
assert.ok(eligible, 'eligible fixture required');
assert.ok(external, 'external-pending fixture required');

const signedEligible = signCertificate(eligible, privateKey);
const valid = verifyCompletionCertificate(signedEligible, keyring, { now: NOW, expectedSubject: signedEligible.subject });
assert.equal(valid.valid, true, JSON.stringify(valid.checks));
assert.equal(valid.decision, 'eligible');
assert.equal(valid.issuerKeyId, KEY_ID);
assert.ok(valid.checks.some((check) => check.id === 'issuer-signature' && check.ok));
assert.ok(valid.checks.some((check) => check.id === 'subject-binding' && check.ok));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'completion-certificate-verifier-'));
const certPath = path.join(tmp, 'certificate.json');
const keyringPath = path.join(tmp, 'keyring.json');
const subjectPath = path.join(tmp, 'subject.json');
fs.writeFileSync(certPath, `${JSON.stringify(signedEligible, null, 2)}\n`);
fs.writeFileSync(keyringPath, `${JSON.stringify(keyring, null, 2)}\n`);
fs.writeFileSync(subjectPath, `${JSON.stringify(signedEligible.subject, null, 2)}\n`);
const cli = spawnSync(process.execPath, [
  'scripts/verify-completion-certificate.mjs',
  certPath,
  '--keyring', keyringPath,
  '--expected-subject', subjectPath,
  '--now', NOW,
  '--json',
], { cwd: root, encoding: 'utf8' });
assert.equal(cli.status, 0, `${cli.stdout}\n${cli.stderr}`);
const cliResult = JSON.parse(cli.stdout);
assert.equal(cliResult.valid, true, JSON.stringify(cliResult.checks));

const signedExternal = signCertificate(external, privateKey);
const externalResult = verifyCompletionCertificate(signedExternal, keyring, { now: NOW });
assert.equal(externalResult.valid, true, JSON.stringify(externalResult.checks));
assert.equal(externalResult.decision, 'external-pending');
assert.notEqual(externalResult.decision, 'eligible', 'external-pending must not be release authorization');

const tampered = clone(signedEligible);
tampered.subject.taskId = 'task-1393-fixture-tampered';
const tamperedResult = verifyCompletionCertificate(tampered, keyring, { now: NOW });
assert.equal(tamperedResult.valid, false);
assert.match(reason(tamperedResult, 'issuer-signature'), /signature failed/);

const wrongSubject = verifyCompletionCertificate(signedEligible, keyring, {
  now: NOW,
  expectedSubject: { ...signedEligible.subject, taskId: 'different-task' },
});
assert.equal(wrongSubject.valid, false);
assert.match(reason(wrongSubject, 'subject-binding'), /does not match/);

const missingKey = verifyCompletionCertificate(signedEligible, { keys: {} }, { now: NOW });
assert.equal(missingKey.valid, false);
assert.match(reason(missingKey, 'issuer-signature'), /not in keyring/);

const revoked = verifyCompletionCertificate(signedEligible, { keys: { [KEY_ID]: { pem, status: 'revoked' } } }, { now: NOW });
assert.equal(revoked.valid, false);
assert.match(reason(revoked, 'issuer-signature'), /revoked/);

const outsideKeyWindow = verifyCompletionCertificate(signedEligible, { keys: { [KEY_ID]: { pem, status: 'active', notBefore: '2026-07-09T00:00:00Z' } } }, { now: NOW });
assert.equal(outsideKeyWindow.valid, false);
assert.match(reason(outsideKeyWindow, 'issuer-signature'), /notBefore/);

const expiredCert = verifyCompletionCertificate(signedEligible, keyring, { now: '2026-07-16T00:00:00Z' });
assert.equal(expiredCert.valid, false);
assert.match(reason(expiredCert, 'certificate-expiry'), /expired/);

const missingBoundary = signCertificate(deepMerge(eligible, {
  assurance: {
    proves: ['condition-evaluation-occurred', 'subject-binding', 'certificate-integrity'],
    doesNotProve: ['legal-settlement', 'analytical-correctness'],
    disclaimer: 'Incomplete fixture: missing payment boundary caveats.',
  },
}), privateKey);
const boundaryResult = verifyCompletionCertificate(missingBoundary, keyring, { now: NOW });
assert.equal(boundaryResult.valid, false);
assert.match(reason(boundaryResult, 'assurance-boundary'), /payment-authorized/);

const decisionMismatch = signCertificate(deepMerge(eligible, { decision: 'not-eligible' }), privateKey);
const mismatchResult = verifyCompletionCertificate(decisionMismatch, keyring, { now: NOW });
assert.equal(mismatchResult.valid, false);
assert.match(reason(mismatchResult, 'decision-semantics'), /decision-mismatch/);

const unknownMet = signCertificate(deepMerge(eligible, {
  conditionResults: [
    ...eligible.conditionResults,
    { id: 'rail:live-release', kind: 'live-payment-release', status: 'met', evidenceRef: 'forbidden-live-rail-placeholder' },
  ],
}), privateKey);
const unknownResult = verifyCompletionCertificate(unknownMet, keyring, { now: NOW });
assert.equal(unknownResult.valid, false);
assert.match(reason(unknownResult, 'shape'), /unknown-met-condition-kind/);

const kidMismatch = signCertificate(eligible, privateKey, 'broker:broker-alpha:completion:other');
kidMismatch.issuer.keyId = KEY_ID;
const kidMismatchResult = verifyCompletionCertificate(kidMismatch, keyring, { now: NOW });
assert.equal(kidMismatchResult.valid, false);
assert.match(reason(kidMismatchResult, 'issuer-signature'), /kid/);

console.log('✅ completion-certificate offline verifier: signature, subject, expiry, keyring, and payment-boundary checks passed');
