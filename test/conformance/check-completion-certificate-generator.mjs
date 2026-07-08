#!/usr/bin/env node
// Conformance check: report-only completion certificate generator (#1393 slice 3).
//
// Uses an ephemeral in-process Ed25519 test key only. It never contacts payment
// rails, providers, brokers, GitHub, databases, or moves any credential/key
// material outside temporary test files.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateCompletionCertificate } from '../../scripts/lib/completion-certificate-generator.mjs';
import { verifyCompletionCertificate } from '../../scripts/lib/completion-certificate-verifier.mjs';

const root = process.cwd();
const NOW = '2026-07-09T00:00:00Z';
const ISSUED_AT = '2026-07-08T00:00:00Z';
const EXPIRES_AT = '2026-07-15T00:00:00Z';
const KEY_ID = 'broker:broker-alpha:completion:ephemeral-test';
const BROKER_ID = 'broker-alpha';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const keyring = { keys: { [KEY_ID]: { pem: publicPem, status: 'active', notBefore: '2026-07-01T00:00:00Z', expiresAt: '2026-08-01T00:00:00Z' } } };

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function baseReport(patch = {}) {
  const report = {
    schemaVersion: 'a2a.completion.report.v0',
    sourceOnly: true,
    noLive: true,
    subject: {
      kind: 'task-result',
      taskId: 'task-1393-generator-eligible',
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

function generate(report) {
  return generateCompletionCertificate(report, { signingKeyPem: privatePem });
}

const eligible = generate(baseReport());
assert.equal(eligible.schemaVersion, 'a2a.completion.certificate.v0');
assert.equal(eligible.canonicalization, 'rfc8785-jcs-v1');
assert.equal(eligible.decision, 'eligible');
assert.ok(eligible.sig?.protected);
assert.ok(eligible.sig?.signature);
let verified = verifyCompletionCertificate(eligible, keyring, { now: NOW, expectedSubject: eligible.subject });
assert.equal(verified.valid, true, JSON.stringify(verified.checks));

const externalReport = baseReport({
  completionConditions: {
    ...baseReport().completionConditions,
    externalConditions: [
      { id: 'rail-intent-mandate', kind: 'payment-rail-declared-condition', description: 'External rail condition; report-only generator does not evaluate it.' },
    ],
  },
});
const external = generate(externalReport);
assert.equal(external.decision, 'external-pending');
assert.ok(external.conditionResults.some((entry) => entry.id === 'external:rail-intent-mandate' && entry.status === 'external-pending'));
verified = verifyCompletionCertificate(external, keyring, { now: NOW });
assert.equal(verified.valid, true, JSON.stringify(verified.checks));
assert.notEqual(external.decision, 'eligible', 'external-pending must not be release authorization');

const missingBatteryReport = baseReport({
  evidence: {
    batteries: [
      { id: 'unit-tests', status: 'met', evidenceRef: `battery-verdict:unit-tests:sha256:${'3'.repeat(64)}` },
    ],
    finalizerVerdict: { status: 'go', evidenceRef: `finalizer-verdict:sha256:${'5'.repeat(64)}` },
  },
});
const notEligible = generate(missingBatteryReport);
assert.equal(notEligible.decision, 'not-eligible');
assert.ok(notEligible.conditionResults.some((entry) => entry.id === 'battery:contract-conformance' && entry.status === 'missing'));
verified = verifyCompletionCertificate(notEligible, keyring, { now: NOW });
assert.equal(verified.valid, true, JSON.stringify(verified.checks));

const badFinalizer = generate(baseReport({ evidence: { ...baseReport().evidence, finalizerVerdict: { status: 'no-go', evidenceRef: 'finalizer-verdict:blocked' } } }));
assert.equal(badFinalizer.decision, 'not-eligible');
verified = verifyCompletionCertificate(badFinalizer, keyring, { now: NOW });
assert.equal(verified.valid, true, JSON.stringify(verified.checks));

assert.throws(() => generateCompletionCertificate(baseReport({ sourceOnly: false }), { signingKeyPem: privatePem }), /sourceOnly=true/);
assert.throws(() => generateCompletionCertificate(baseReport(), { signingKeyPem: '' }), /signingKeyPem/);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'completion-certificate-generator-'));
const reportPath = path.join(tmp, 'report.json');
const privateKeyPath = path.join(tmp, 'ed25519-private.pem');
const publicKeyringPath = path.join(tmp, 'keyring.json');
const certPath = path.join(tmp, 'certificate.json');
const subjectPath = path.join(tmp, 'subject.json');
fs.writeFileSync(reportPath, `${JSON.stringify(baseReport(), null, 2)}\n`);
fs.writeFileSync(privateKeyPath, privatePem, { mode: 0o600 });
fs.writeFileSync(publicKeyringPath, `${JSON.stringify(keyring, null, 2)}\n`);
fs.writeFileSync(subjectPath, `${JSON.stringify(baseReport().subject, null, 2)}\n`);
const cli = spawnSync(process.execPath, [
  'scripts/generate-completion-certificate.mjs',
  reportPath,
  '--signing-key', privateKeyPath,
  '--out', certPath,
], { cwd: root, encoding: 'utf8' });
assert.equal(cli.status, 0, `${cli.stdout}\n${cli.stderr}`);
const verifyCli = spawnSync(process.execPath, [
  'scripts/verify-completion-certificate.mjs',
  certPath,
  '--keyring', publicKeyringPath,
  '--expected-subject', subjectPath,
  '--now', NOW,
  '--json',
], { cwd: root, encoding: 'utf8' });
assert.equal(verifyCli.status, 0, `${verifyCli.stdout}\n${verifyCli.stderr}`);
const cliVerified = JSON.parse(verifyCli.stdout);
assert.equal(cliVerified.valid, true, JSON.stringify(cliVerified.checks));

console.log('✅ completion-certificate report-only generator: eligible, not-eligible, external-pending, CLI round-trip, and no-live guards passed');
