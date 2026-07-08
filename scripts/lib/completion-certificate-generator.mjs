/**
 * Report-only generator for A2A Completion Certificate v0 (#1393 slice 3).
 *
 * This module converts a public-safe, no-live task completion report into a
 * signed completion certificate JSON object. It is source-only proof-layer code:
 * no payment rails, escrow/funds movement, provider sends, broker state
 * mutation, ACK/replay, deploy/restart, package release, or signing-key/secret
 * movement.
 */
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';

import {
  COMPLETION_CANONICALIZATION,
  COMPLETION_CERTIFICATE_SCHEMA,
  COMPLETION_CONDITIONS_SCHEMA,
  REQUIRED_DOES_NOT_PROVE,
} from './completion-certificate-verifier.mjs';
import { canonicalizeJson } from './a2a-offline-verify.mjs';

const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_ASSURANCE = {
  proves: ['condition-evaluation-occurred', 'subject-binding', 'certificate-integrity'],
  doesNotProve: REQUIRED_DOES_NOT_PROVE,
  disclaimer: 'Attests that A2A Nexus evaluated declared task completion conditions for the bound subject. It does not move funds or certify legal payment eligibility.',
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isSha256(value) {
  return typeof value === 'string' && HASH_RE.test(value);
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function validIso(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp string`);
  }
  return value;
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function normalizeConditions(report) {
  const raw = report.completionConditions ?? report.conditions;
  const conditions = requirePlainObject(raw, 'report.completionConditions');
  if (conditions.schemaVersion !== COMPLETION_CONDITIONS_SCHEMA) {
    throw new Error(`completionConditions.schemaVersion must be ${COMPLETION_CONDITIONS_SCHEMA}`);
  }
  if (!Array.isArray(conditions.requiredBatteries)) {
    throw new Error('completionConditions.requiredBatteries must be an array');
  }
  if (conditions.requiredVerdict !== 'go') {
    throw new Error('completionConditions.requiredVerdict must be "go" in v0');
  }
  if (typeof conditions.artifactHashRequired !== 'boolean') {
    throw new Error('completionConditions.artifactHashRequired must be boolean');
  }
  if (!Array.isArray(conditions.externalConditions)) {
    throw new Error('completionConditions.externalConditions must be an array');
  }
  return clone(conditions);
}

function normalizeSubject(report) {
  const subject = clone(requirePlainObject(report.subject, 'report.subject'));
  if (subject.kind !== 'task-result') throw new Error('subject.kind must be task-result');
  if (typeof subject.taskId !== 'string' || subject.taskId.trim() === '') throw new Error('subject.taskId is required');
  if (typeof subject.workerId !== 'string' || subject.workerId.trim() === '') throw new Error('subject.workerId is required');
  if (subject.resultHash !== undefined && !isSha256(subject.resultHash)) throw new Error('subject.resultHash must be sha256:<64 hex> when present');
  if (subject.artifactHashes !== undefined) {
    if (!Array.isArray(subject.artifactHashes) || !subject.artifactHashes.every(isSha256)) {
      throw new Error('subject.artifactHashes must be sha256:<64 hex>[] when present');
    }
  }
  return subject;
}

function evidenceMap(list = []) {
  if (!Array.isArray(list)) throw new Error('evidence.batteries must be an array when present');
  const map = new Map();
  for (const item of list) {
    if (!isPlainObject(item) || typeof item.id !== 'string' || item.id.trim() === '') {
      throw new Error('each evidence.batteries[] entry must include id');
    }
    map.set(item.id, item);
  }
  return map;
}

function statusForBattery(entry) {
  if (!entry) return 'missing';
  if (entry.status === 'met' || entry.ok === true || entry.decision === 'pass') return 'met';
  if (entry.status === 'missing') return 'missing';
  return 'unmet';
}

function evidenceRefFor(prefix, entry, fallback) {
  if (entry && typeof entry.evidenceRef === 'string' && entry.evidenceRef.trim() !== '') return entry.evidenceRef;
  if (entry && isSha256(entry.hash)) return `${prefix}:sha256:${entry.hash.slice('sha256:'.length)}`;
  return fallback;
}

function finalizerStatus(verdict) {
  if (!verdict) return 'missing';
  const raw = verdict.status ?? verdict.verdict ?? verdict.decision;
  return raw === 'go' || raw === 'met' ? 'met' : 'unmet';
}

function firstBoundHash(subject) {
  if (Array.isArray(subject.artifactHashes) && subject.artifactHashes.length > 0) return subject.artifactHashes[0];
  if (isSha256(subject.resultHash)) return subject.resultHash;
  return undefined;
}

function buildConditionResults(report, subject, conditions) {
  const evidence = isPlainObject(report.evidence) ? report.evidence : {};
  const batteries = evidenceMap(evidence.batteries ?? []);
  const results = [];

  for (const battery of conditions.requiredBatteries) {
    if (typeof battery !== 'string' || battery.trim() === '') throw new Error('requiredBatteries entries must be non-empty strings');
    const entry = batteries.get(battery);
    const status = statusForBattery(entry);
    results.push({
      id: `battery:${battery}`,
      kind: 'battery',
      status,
      evidenceRef: evidenceRefFor(`battery-verdict:${battery}`, entry, status === 'missing' ? `battery-verdict:${battery}:missing` : `battery-verdict:${battery}:unmet`),
    });
  }

  const finalizer = isPlainObject(evidence.finalizerVerdict) ? evidence.finalizerVerdict : undefined;
  const verdictStatus = finalizerStatus(finalizer);
  results.push({
    id: 'judgment:finalizer-go',
    kind: 'finalizer-verdict',
    status: verdictStatus,
    evidenceRef: evidenceRefFor('finalizer-verdict', finalizer, verdictStatus === 'missing' ? 'finalizer-verdict:missing' : 'finalizer-verdict:unmet'),
  });

  if (conditions.artifactHashRequired) {
    const boundHash = firstBoundHash(subject);
    results.push({
      id: 'artifact-hash-bound',
      kind: 'artifact-hash',
      status: boundHash ? 'met' : 'missing',
      evidenceRef: boundHash ?? 'artifact-hash:missing',
    });
  }

  for (const external of conditions.externalConditions) {
    if (!isPlainObject(external) || typeof external.id !== 'string' || external.id.trim() === '') {
      throw new Error('externalConditions[] entries must include id');
    }
    results.push({
      id: `external:${external.id}`,
      kind: 'payment-rail-declared-condition',
      status: 'external-pending',
      evidenceRef: `external-condition:${external.id}`,
    });
  }
  return results;
}

export function deriveCompletionDecision(conditions, conditionResults, subject) {
  if (conditions.artifactHashRequired && !firstBoundHash(subject)) return 'not-eligible';
  for (const battery of conditions.requiredBatteries) {
    const result = conditionResults.find((entry) => entry.id === `battery:${battery}`);
    if (!result || result.status !== 'met') return 'not-eligible';
  }
  const verdict = conditionResults.find((entry) => entry.id === 'judgment:finalizer-go');
  if (!verdict || verdict.status !== 'met') return 'not-eligible';
  const artifact = conditionResults.find((entry) => entry.id === 'artifact-hash-bound');
  if (conditions.artifactHashRequired && (!artifact || artifact.status !== 'met')) return 'not-eligible';
  return conditions.externalConditions.length > 0 ? 'external-pending' : 'eligible';
}

function signCertificate(certificate, privateKeyPem) {
  let key;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch (error) {
    throw new Error(`cannot parse signing key: ${error.message}`);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('completion certificate report-only generator v0 signs Ed25519 test/ephemeral keys only');
  }
  const protectedHeader = base64url(canonicalizeJson({ alg: 'EdDSA', typ: 'JOSE', kid: certificate.issuer.keyId }));
  const payload = base64url(canonicalizeJson(certificate));
  return {
    protected: protectedHeader,
    signature: cryptoSign(null, Buffer.from(`${protectedHeader}.${payload}`, 'utf8'), key).toString('base64url'),
  };
}

export function generateCompletionCertificate(report, options = {}) {
  requirePlainObject(report, 'report');
  if (report.sourceOnly !== true || report.noLive !== true) {
    throw new Error('report-only generator requires report.sourceOnly=true and report.noLive=true');
  }
  const signingKeyPem = options.signingKeyPem;
  if (typeof signingKeyPem !== 'string' || signingKeyPem.trim() === '') {
    throw new Error('options.signingKeyPem is required; use ephemeral/test keys only');
  }
  const subject = normalizeSubject(report);
  const conditions = normalizeConditions(report);
  const conditionResults = buildConditionResults(report, subject, conditions);
  const issuer = {
    kind: 'broker',
    brokerId: options.issuerBrokerId ?? report.issuer?.brokerId,
    keyId: options.issuerKeyId ?? report.issuer?.keyId,
  };
  if (typeof issuer.brokerId !== 'string' || issuer.brokerId.trim() === '') throw new Error('issuer brokerId is required');
  if (typeof issuer.keyId !== 'string' || issuer.keyId.trim() === '') throw new Error('issuer keyId is required');
  const issuedAt = validIso(options.issuedAt ?? report.issuedAt, 'issuedAt');
  const expiresAt = validIso(options.expiresAt ?? report.expiresAt, 'expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) throw new Error('expiresAt must be after issuedAt');

  const certificate = {
    schemaVersion: COMPLETION_CERTIFICATE_SCHEMA,
    canonicalization: COMPLETION_CANONICALIZATION,
    subject,
    conditions,
    conditionResults,
    decision: deriveCompletionDecision(conditions, conditionResults, subject),
    issuedAt,
    expiresAt,
    issuer,
    assurance: clone(DEFAULT_ASSURANCE),
  };
  certificate.sig = signCertificate(certificate, signingKeyPem);
  return certificate;
}
