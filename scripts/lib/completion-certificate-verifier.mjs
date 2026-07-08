/**
 * Offline verifier for A2A Completion Certificate v0 (#1393).
 *
 * This is the source-only proof-layer verifier. It verifies certificate
 * integrity and decision semantics only: shape, issuer keyring lifecycle,
 * JCS/JWS signature over the certificate without `sig`, optional subject
 * binding, certificate expiry, and the payment-boundary assurance invariants.
 *
 * It deliberately does NOT authorize payment release, call payment rails, hold
 * escrow, move funds, contact providers, mutate broker state, deploy/restart,
 * move secrets/keys, or ACK/replay Terminal Brief records.
 */

import { canonicalizeJson, kidOf, verifyJwsSignature } from './a2a-offline-verify.mjs';

export const COMPLETION_CERTIFICATE_SCHEMA = 'a2a.completion.certificate.v0';
export const COMPLETION_CONDITIONS_SCHEMA = 'a2a.completion.conditions.v0';
export const COMPLETION_CANONICALIZATION = 'rfc8785-jcs-v1';
export const COMPLETION_DECISIONS = new Set(['eligible', 'not-eligible', 'external-pending']);
export const COMPLETION_RESULT_STATUSES = new Set(['met', 'unmet', 'missing', 'external-pending']);
export const COMPLETION_RESULT_KINDS = new Set([
  'battery',
  'finalizer-verdict',
  'artifact-hash',
  'payment-rail-declared-condition',
]);
export const REQUIRED_DOES_NOT_PROVE = [
  'payment-authorized',
  'funds-available',
  'legal-settlement',
  'analytical-correctness',
];

const HASH_RE = /^sha256:[a-f0-9]{64}$/;

function fail(checks, id, detail) {
  checks.push({ id, ok: false, detail });
}

function pass(checks, id) {
  checks.push({ id, ok: true });
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isSha256(value) {
  return typeof value === 'string' && HASH_RE.test(value);
}

function hasArtifactBinding(subject = {}) {
  if (isSha256(subject.resultHash)) return true;
  return Array.isArray(subject.artifactHashes) && subject.artifactHashes.some(isSha256);
}

function resultById(certificate, id) {
  return Array.isArray(certificate?.conditionResults)
    ? certificate.conditionResults.find((result) => result?.id === id)
    : undefined;
}

function subjectsEqual(a, b) {
  return canonicalizeJson(a) === canonicalizeJson(b);
}

function parseTime(value) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : NaN;
}

function keyRecordFor(keyring, keyId) {
  const keys = (keyring && keyring.keys) || {};
  const entry = keys[keyId];
  if (typeof entry === 'string') return { pem: entry };
  if (isPlainObject(entry)) return entry;
  return undefined;
}

function keyLifecycleViolation(record, certificate) {
  if (record.status === 'revoked') return `issuer key '${certificate.issuer.keyId}' is revoked`;
  if (record.notBefore !== undefined || record.expiresAt !== undefined) {
    const issuedMs = parseTime(certificate.issuedAt);
    if (!Number.isFinite(issuedMs)) {
      return `certificate has no valid issuedAt to check against key '${certificate.issuer.keyId}' validity window (fail-closed)`;
    }
    if (record.notBefore !== undefined && issuedMs < Date.parse(record.notBefore)) {
      return `certificate issuedAt is before key '${certificate.issuer.keyId}' notBefore (outside validity window)`;
    }
    if (record.expiresAt !== undefined && issuedMs > Date.parse(record.expiresAt)) {
      return `certificate issuedAt is after key '${certificate.issuer.keyId}' expiresAt (outside validity window)`;
    }
  }
  return undefined;
}

function shapeViolation(certificate) {
  if (!isPlainObject(certificate)) return 'certificate-not-object';
  if (certificate.schemaVersion !== COMPLETION_CERTIFICATE_SCHEMA) return 'schema-version';
  if (certificate.canonicalization !== COMPLETION_CANONICALIZATION) return 'canonicalization';
  if (!isPlainObject(certificate.subject) || certificate.subject.kind !== 'task-result') return 'subject-kind';
  if (!certificate.subject.taskId || !certificate.subject.workerId) return 'subject-identity';
  if (!isPlainObject(certificate.conditions) || certificate.conditions.schemaVersion !== COMPLETION_CONDITIONS_SCHEMA) return 'conditions-schema';
  if (!Array.isArray(certificate.conditions.requiredBatteries)) return 'required-batteries-shape';
  if (certificate.conditions.requiredVerdict !== 'go') return 'required-verdict';
  if (typeof certificate.conditions.artifactHashRequired !== 'boolean') return 'artifact-hash-required-shape';
  if (!Array.isArray(certificate.conditions.externalConditions)) return 'external-conditions-shape';
  if (!Array.isArray(certificate.conditionResults)) return 'condition-results-shape';
  if (!COMPLETION_DECISIONS.has(certificate.decision)) return 'decision-enum';
  if (!Number.isFinite(parseTime(certificate.issuedAt))) return 'issued-at';
  if (!Number.isFinite(parseTime(certificate.expiresAt))) return 'expires-at';
  if (parseTime(certificate.expiresAt) <= parseTime(certificate.issuedAt)) return 'expiry-window';
  if (!isPlainObject(certificate.issuer) || !certificate.issuer.kind || !certificate.issuer.brokerId || !certificate.issuer.keyId) return 'issuer-shape';
  if (!isPlainObject(certificate.assurance) || !Array.isArray(certificate.assurance.proves) || !Array.isArray(certificate.assurance.doesNotProve)) return 'assurance-shape';
  if (!isPlainObject(certificate.sig) || !certificate.sig.protected || !certificate.sig.signature) return 'signature-missing';
  for (const result of certificate.conditionResults) {
    if (!result?.id || !result.kind || !result.status || !result.evidenceRef) return 'condition-result-shape';
    if (!COMPLETION_RESULT_STATUSES.has(result.status)) return 'condition-result-status';
    if (!COMPLETION_RESULT_KINDS.has(result.kind) && result.status === 'met') return 'unknown-met-condition-kind';
  }
  return undefined;
}

function assuranceViolation(certificate) {
  const doesNotProve = certificate.assurance.doesNotProve;
  for (const required of REQUIRED_DOES_NOT_PROVE) {
    if (!doesNotProve.includes(required)) return `assurance.doesNotProve missing '${required}'`;
  }
  if (!certificate.assurance.proves.includes('condition-evaluation-occurred')) {
    return "assurance.proves missing 'condition-evaluation-occurred'";
  }
  if (!certificate.assurance.proves.includes('subject-binding')) {
    return "assurance.proves missing 'subject-binding'";
  }
  if (!certificate.assurance.proves.includes('certificate-integrity')) {
    return "assurance.proves missing 'certificate-integrity'";
  }
  if (typeof certificate.assurance.disclaimer !== 'string' || certificate.assurance.disclaimer.trim() === '') {
    return 'assurance.disclaimer must be non-empty';
  }
  return undefined;
}

function derivedDecisionViolation(certificate) {
  if (certificate.conditions.artifactHashRequired && !hasArtifactBinding(certificate.subject)) {
    return { reason: 'artifact-hash-required' };
  }
  for (const battery of certificate.conditions.requiredBatteries) {
    const result = resultById(certificate, `battery:${battery}`);
    if (!result || result.status === 'missing') return { reason: 'required-battery-missing', battery };
    if (result.status !== 'met') return { reason: 'required-battery-not-met', battery, status: result.status };
  }
  const verdict = resultById(certificate, 'judgment:finalizer-go');
  if (!verdict || verdict.kind !== 'finalizer-verdict' || verdict.status !== 'met') {
    return { reason: 'required-finalizer-verdict-not-met' };
  }
  const artifactResult = resultById(certificate, 'artifact-hash-bound');
  if (certificate.conditions.artifactHashRequired && (!artifactResult || artifactResult.status !== 'met')) {
    return { reason: 'artifact-hash-required' };
  }
  const expected = certificate.conditions.externalConditions.length > 0 ? 'external-pending' : 'eligible';
  if (certificate.decision !== expected) {
    return { reason: 'decision-mismatch', expected, actual: certificate.decision };
  }
  return undefined;
}

function expiryViolation(certificate, { now } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : (now === undefined ? Date.now() : Date.parse(String(now)));
  if (!Number.isFinite(nowMs)) return `invalid verifier time '${now}'`;
  if (nowMs > parseTime(certificate.expiresAt)) return 'certificate is expired';
  if (nowMs < parseTime(certificate.issuedAt)) return 'certificate issuedAt is in the future relative to verifier clock';
  return undefined;
}

/**
 * Verify one completion certificate against `{ keys: { [issuerKeyId]: pem|record } }`.
 * Returns `{ valid, decision, subject, issuerKeyId, checks }` and never throws.
 */
export function verifyCompletionCertificate(certificate, keyring, opts = {}) {
  const checks = [];
  const shape = shapeViolation(certificate);
  if (shape) {
    fail(checks, 'shape', shape);
    return { valid: false, decision: undefined, subject: undefined, issuerKeyId: undefined, checks };
  }
  pass(checks, 'shape');

  const assurance = assuranceViolation(certificate);
  if (assurance) fail(checks, 'assurance-boundary', assurance);
  else pass(checks, 'assurance-boundary');

  const decision = derivedDecisionViolation(certificate);
  if (decision) fail(checks, 'decision-semantics', decision.reason);
  else pass(checks, 'decision-semantics');

  const expiry = expiryViolation(certificate, opts);
  if (expiry) fail(checks, 'certificate-expiry', expiry);
  else pass(checks, 'certificate-expiry');

  if (opts.expectedSubject !== undefined) {
    if (subjectsEqual(certificate.subject, opts.expectedSubject)) pass(checks, 'subject-binding');
    else fail(checks, 'subject-binding', 'certificate.subject does not match the expected task result/artifact subject');
  }

  const record = keyRecordFor(keyring, certificate.issuer.keyId);
  const lifecycle = record ? keyLifecycleViolation(record, certificate) : undefined;
  if (!record || typeof record.pem !== 'string') {
    fail(checks, 'issuer-signature', `issuer key '${certificate.issuer.keyId}' not in keyring (fail-closed)`);
  } else if (lifecycle) {
    fail(checks, 'issuer-signature', lifecycle);
  } else if (kidOf(certificate.sig) !== certificate.issuer.keyId) {
    fail(checks, 'issuer-signature', 'JWS protected header kid does not match certificate.issuer.keyId');
  } else {
    const { sig: _omit, ...unsigned } = certificate;
    if (verifyJwsSignature(unsigned, certificate.sig, record.pem)) pass(checks, 'issuer-signature');
    else fail(checks, 'issuer-signature', 'completion certificate signature failed verification');
  }

  return {
    valid: checks.every((check) => check.ok),
    decision: certificate.decision,
    subject: certificate.subject,
    issuerKeyId: certificate.issuer.keyId,
    checks,
  };
}
