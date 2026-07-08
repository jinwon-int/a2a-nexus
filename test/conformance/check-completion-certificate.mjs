#!/usr/bin/env node
// Conformance check: completion certificate source-only schema/fixture gate (#1393/#1395).
//
// This validates deterministic fixture semantics only. It does not verify JCS/JWS
// signatures, call payment rails, hold/release/refund funds, contact providers,
// mutate broker state, deploy/restart services, move secrets, or ACK/replay any
// terminal outbox records.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const fixturePath = path.join(root, 'fixtures', 'contract', 'completion-certificate.json');
const fixtureText = fs.readFileSync(fixturePath, 'utf8');
const fixture = JSON.parse(fixtureText);

const CERT_SCHEMA = 'a2a.completion.certificate.v0';
const CONDITIONS_SCHEMA = 'a2a.completion.conditions.v0';
const CANONICALIZATION = 'rfc8785-jcs-v1';
const KNOWN_RESULT_KINDS = new Set([
  'battery',
  'finalizer-verdict',
  'artifact-hash',
  'payment-rail-declared-condition',
]);
const RESULT_STATUSES = new Set(['met', 'unmet', 'missing', 'external-pending']);
const DECISIONS = new Set(['eligible', 'not-eligible', 'external-pending']);
const REQUIRED_DOES_NOT_PROVE = [
  'payment-authorized',
  'funds-available',
  'legal-settlement',
  'analytical-correctness',
];
const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const FORBIDDEN_RUNTIME_PATHS = [
  'AGENTS.md',
  'SOUL.md',
  'USER.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  'IDENTITY.md',
  '.openclaw/',
];
const SECRET_LIKE_PATTERNS = [
  /ghp_[A-Za-z0-9_]{20,}/,
  /github_pat_[A-Za-z0-9_]+/,
  /sk_live_[A-Za-z0-9]+/,
  /rk_live_[A-Za-z0-9]+/,
  /pk_live_[A-Za-z0-9]+/,
  /xox[baprs]-[A-Za-z0-9-]+/,
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
  /\/home\/[A-Za-z0-9._-]+\//,
  /\/Users\/[A-Za-z0-9._-]+\//,
];

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

function fail(reason, details = {}) {
  return { ok: false, reason, ...details };
}

function isSha256(value) {
  return typeof value === 'string' && HASH_RE.test(value);
}

function hasArtifactBinding(subject = {}) {
  if (isSha256(subject.resultHash)) return true;
  return Array.isArray(subject.artifactHashes) && subject.artifactHashes.some(isSha256);
}

function resultById(certificate, id) {
  return certificate.conditionResults.find((result) => result.id === id);
}

function verifyShape(certificate) {
  if (!certificate || typeof certificate !== 'object' || Array.isArray(certificate)) return fail('certificate-not-object');
  if (certificate.schemaVersion !== CERT_SCHEMA) return fail('schema-version');
  if (certificate.canonicalization !== CANONICALIZATION) return fail('canonicalization');
  if (!certificate.subject || certificate.subject.kind !== 'task-result') return fail('subject-kind');
  if (!certificate.subject.taskId || !certificate.subject.workerId) return fail('subject-identity');
  if (!certificate.conditions || certificate.conditions.schemaVersion !== CONDITIONS_SCHEMA) return fail('conditions-schema');
  if (!Array.isArray(certificate.conditions.requiredBatteries)) return fail('required-batteries-shape');
  if (certificate.conditions.requiredVerdict !== 'go') return fail('required-verdict');
  if (typeof certificate.conditions.artifactHashRequired !== 'boolean') return fail('artifact-hash-required-shape');
  if (!Array.isArray(certificate.conditions.externalConditions)) return fail('external-conditions-shape');
  if (!Array.isArray(certificate.conditionResults)) return fail('condition-results-shape');
  if (!DECISIONS.has(certificate.decision)) return fail('decision-enum');
  if (!certificate.issuedAt || Number.isNaN(Date.parse(certificate.issuedAt))) return fail('issued-at');
  if (!certificate.expiresAt || Number.isNaN(Date.parse(certificate.expiresAt))) return fail('expires-at');
  if (Date.parse(certificate.expiresAt) <= Date.parse(certificate.issuedAt)) return fail('expiry-window');
  if (!certificate.issuer?.kind || !certificate.issuer?.keyId) return fail('issuer-shape');
  if (!certificate.assurance || !Array.isArray(certificate.assurance.proves) || !Array.isArray(certificate.assurance.doesNotProve)) {
    return fail('assurance-shape');
  }
  for (const required of REQUIRED_DOES_NOT_PROVE) {
    if (!certificate.assurance.doesNotProve.includes(required)) return fail('assurance-boundary-missing', { missing: required });
  }
  if (!certificate.assurance.proves.includes('condition-evaluation-occurred')) return fail('assurance-proves-missing');
  if (!certificate.sig || typeof certificate.sig !== 'object' || !certificate.sig.protected || !certificate.sig.signature) {
    return fail('signature-missing');
  }
  for (const result of certificate.conditionResults) {
    if (!result.id || !result.kind || !result.status || !result.evidenceRef) return fail('condition-result-shape');
    if (!RESULT_STATUSES.has(result.status)) return fail('condition-result-status');
    if (!KNOWN_RESULT_KINDS.has(result.kind) && result.status === 'met') {
      return fail('unknown-met-condition-kind', { kind: result.kind, id: result.id });
    }
  }
  return { ok: true };
}

function expectedDecision(certificate) {
  const shape = verifyShape(certificate);
  if (!shape.ok) return shape;

  if (certificate.conditions.artifactHashRequired && !hasArtifactBinding(certificate.subject)) {
    return fail('artifact-hash-required');
  }

  for (const battery of certificate.conditions.requiredBatteries) {
    const result = resultById(certificate, `battery:${battery}`);
    if (!result || result.status === 'missing') return fail('required-battery-missing', { battery });
    if (result.status !== 'met') return fail('required-battery-not-met', { battery, status: result.status });
  }

  const verdict = resultById(certificate, 'judgment:finalizer-go');
  if (!verdict || verdict.kind !== 'finalizer-verdict' || verdict.status !== 'met') {
    return fail('required-finalizer-verdict-not-met');
  }

  const artifactResult = resultById(certificate, 'artifact-hash-bound');
  if (certificate.conditions.artifactHashRequired && (!artifactResult || artifactResult.status !== 'met')) {
    return fail('artifact-hash-required');
  }

  const hasExternalCondition = certificate.conditions.externalConditions.length > 0;
  if (hasExternalCondition) return { ok: true, decision: 'external-pending' };
  return { ok: true, decision: 'eligible' };
}

function validateCertificate(certificate) {
  const expected = expectedDecision(certificate);
  if (!expected.ok) {
    if (certificate.decision === 'eligible') return expected;
    // A certificate with an explicit not-eligible decision can still be a valid
    // negative fixture when the derived reason explains why it cannot release.
    if (certificate.decision === 'not-eligible') return { ok: true, decision: 'not-eligible', reason: expected.reason };
    return expected;
  }
  if (certificate.decision !== expected.decision) {
    return fail('decision-mismatch', { expected: expected.decision, actual: certificate.decision });
  }
  return { ok: true, decision: certificate.decision };
}

for (const forbiddenPath of FORBIDDEN_RUNTIME_PATHS) {
  assert.ok(!fixtureText.includes(forbiddenPath), `completion certificate fixture must not reference runtime/bootstrap path ${forbiddenPath}`);
}
for (const pattern of SECRET_LIKE_PATTERNS) {
  assert.ok(!pattern.test(fixtureText), `completion certificate fixture matched forbidden secret pattern ${pattern}`);
}

assert.equal(fixture.meta.contract, 'completion-certificate');
assert.equal(fixture.meta.schemaVersion, 'a2a.completion.fixture.v0');
assert.equal(fixture.meta.sourceOnly, true);
assert.equal(fixture.meta.noLive, true);
assert.ok(fixture.meta.issues.some((issue) => issue === 'https://github.com/jinwon-int/a2a-nexus/issues/1393'));
assert.ok(fixture.meta.issues.some((issue) => issue === 'https://github.com/jinwon-int/a2a-nexus/issues/1395'));
assert.equal(fixture.v0Freeze.sourceOnly, true);
assert.equal(fixture.v0Freeze.noLive, true);
for (const [key, value] of Object.entries(fixture.safety)) {
  assert.equal(value, false, `safety.${key} must be false`);
}
assert.equal(fixture.completionConditionsPassthrough.expectedGateActive, false);

const positives = fixture.positiveCertificates;
assert.ok(Array.isArray(positives) && positives.length >= 2, 'positive certificate fixtures are required');
for (const { id, expectDecision, certificate } of positives) {
  const result = validateCertificate(certificate);
  assert.equal(result.ok, true, `${id} should validate: ${JSON.stringify(result)}`);
  assert.equal(result.decision, expectDecision, `${id} decision mismatch`);
}

const eligible = positives.find((entry) => entry.expectDecision === 'eligible')?.certificate;
assert.ok(eligible, 'eligible baseline fixture is required');

const negatives = fixture.negativeCertificates;
assert.ok(Array.isArray(negatives) && negatives.length >= 6, 'negative certificate fixtures are required');
for (const { id, expectReason, certificatePatch } of negatives) {
  const candidate = deepMerge(eligible, certificatePatch);
  const result = validateCertificate(candidate);
  assert.equal(result.ok, expectReason === 'required-battery-missing' || expectReason === 'required-finalizer-verdict-not-met' || expectReason === 'artifact-hash-required' ? true : false,
    `${id} ok posture mismatch: ${JSON.stringify(result)}`);
  assert.equal(result.reason, expectReason, `${id} reason mismatch: ${JSON.stringify(result)}`);
  assert.notEqual(result.decision, 'eligible', `${id} must not derive eligible`);
}

assert.ok(fixture.validationCommands.includes('node test/conformance/check-completion-certificate.mjs'));
assert.ok(fixture.validationCommands.includes('npm run test:conformance'));

console.log('✅ completion-certificate fixture: source-only condition gate checks passed');
