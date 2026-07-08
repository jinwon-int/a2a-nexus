/**
 * Fake/no-live payment rail rehearsal adapter for A2A Completion Certificate v0
 * (#1393 slice 4).
 *
 * This library rehearses the boundary a future payment rail adapter would use:
 * verify a signed completion certificate offline, branch on its decision, and
 * emit a deterministic public-safe fake receipt. It is intentionally library-only
 * and source-only. It does NOT call payment rails/providers, hold/release/refund
 * funds, mutate broker/DB/outbox state, ACK/replay Terminal Brief records,
 * deploy/restart services, publish packages, or move signing keys/secrets.
 */
import { createHash } from 'node:crypto';

import { canonicalizeJson } from './a2a-offline-verify.mjs';
import {
  REQUIRED_DOES_NOT_PROVE,
  verifyCompletionCertificate,
} from './completion-certificate-verifier.mjs';

export const FAKE_RAIL_RECEIPT_SCHEMA = 'a2a.completion.fakeRailReceipt.v0';
export const FAKE_RAIL_ID = 'fake-no-live';

const SAFETY_FLAGS = Object.freeze({
  sourceOnly: true,
  noLive: true,
  paymentRailCall: false,
  escrowCustody: false,
  fundsMovement: false,
  providerSend: false,
  telegramSend: false,
  databaseMutation: false,
  terminalAckReplay: false,
  deployOrRestart: false,
  secretRequired: false,
  liveSigningKeyRequired: false,
});

const DECISION_MAP = Object.freeze({
  eligible: {
    receiptDecision: 'fake-release-authorized',
    releaseAuthorized: true,
    reason: 'completion-certificate-eligible',
  },
  'external-pending': {
    receiptDecision: 'fake-release-pending',
    releaseAuthorized: false,
    reason: 'external-rail-condition-pending',
  },
  'not-eligible': {
    receiptDecision: 'fake-release-rejected',
    releaseAuthorized: false,
    reason: 'completion-certificate-not-eligible',
  },
});

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sha256Hex(value) {
  return createHash('sha256').update(canonicalizeJson(value)).digest('hex');
}

function normalizeAmount(amount) {
  if (amount === undefined) return undefined;
  if (!isPlainObject(amount)) throw new Error('amount must be an object when present');
  const currency = requireText(amount.currency, 'amount.currency');
  const value = requireText(amount.value, 'amount.value');
  if (!/^[A-Z]{3,12}$/.test(currency)) throw new Error('amount.currency must be an uppercase public-safe currency/unit code');
  if (!/^[0-9]+(\.[0-9]+)?$/.test(value)) throw new Error('amount.value must be a decimal string');
  return { currency, value };
}

function summarizeChecks(checks = []) {
  return checks.map((check) => ({
    id: check.id,
    ok: check.ok === true,
    ...(check.detail !== undefined ? { detail: String(check.detail) } : {}),
  }));
}

function receiptIdentityCore(receipt) {
  return {
    schemaVersion: receipt.schemaVersion,
    rail: receipt.rail,
    escrowId: receipt.escrowId,
    idempotencyKey: receipt.idempotencyKey,
    certificateDecision: receipt.certificateDecision,
    rehearsalDecision: receipt.rehearsalDecision,
    releaseAuthorized: receipt.releaseAuthorized,
    reason: receipt.reason,
    subjectHash: receipt.subjectHash,
    issuerKeyId: receipt.issuerKeyId,
    amount: receipt.amount,
  };
}

function buildReceiptId(receipt) {
  return `${FAKE_RAIL_ID}:sha256:${sha256Hex(receiptIdentityCore(receipt))}`;
}

function invalidReceipt({ certificate, verification, escrowId, idempotencyKey, amount, createdAt }) {
  const subject = isPlainObject(certificate?.subject) ? clone(certificate.subject) : undefined;
  const receipt = {
    schemaVersion: FAKE_RAIL_RECEIPT_SCHEMA,
    rail: FAKE_RAIL_ID,
    sourceOnly: true,
    noLive: true,
    createdAt,
    escrowId,
    idempotencyKey,
    amount,
    certificateDecision: verification.decision ?? certificate?.decision ?? 'unknown',
    rehearsalDecision: 'fake-release-rejected',
    releaseAuthorized: false,
    reason: 'completion-certificate-verification-failed',
    subject,
    subjectHash: subject ? `sha256:${sha256Hex(subject)}` : undefined,
    issuerKeyId: verification.issuerKeyId ?? certificate?.issuer?.keyId,
    verification: {
      valid: false,
      checks: summarizeChecks(verification.checks),
    },
    safety: { ...SAFETY_FLAGS },
    assurance: {
      proves: ['offline-verifier-ran', 'fake-rail-branch-evaluated', 'idempotency-key-bound'],
      doesNotProve: REQUIRED_DOES_NOT_PROVE,
      disclaimer: 'Fake/no-live rehearsal receipt only. It does not authorize payment release, prove funds are available, or represent a live rail receipt.',
    },
  };
  receipt.receiptId = buildReceiptId(receipt);
  return receipt;
}

/**
 * Rehearse a future payment rail release path without performing live side effects.
 *
 * @param {object} certificate signed completion certificate JSON
 * @param {object} keyring verifier keyring `{ keys: { [issuerKeyId]: pem|record } }`
 * @param {object} options no-live rehearsal options
 * @returns {object} deterministic fake/no-live receipt
 */
export function rehearseFakeRailRelease(certificate, keyring, options = {}) {
  if (!isPlainObject(options)) throw new Error('options must be an object');
  if (options.sourceOnly !== true || options.noLive !== true) {
    throw new Error('fake rail rehearsal requires options.sourceOnly=true and options.noLive=true');
  }
  const escrowId = requireText(options.escrowId, 'options.escrowId');
  const idempotencyKey = requireText(options.idempotencyKey, 'options.idempotencyKey');
  const createdAt = options.createdAt === undefined ? new Date().toISOString() : requireText(options.createdAt, 'options.createdAt');
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('options.createdAt must be an ISO timestamp string');
  const amount = normalizeAmount(options.amount);
  const verifierOptions = {
    now: options.now,
    ...(options.expectedSubject !== undefined ? { expectedSubject: options.expectedSubject } : {}),
  };
  const verification = verifyCompletionCertificate(certificate, keyring, verifierOptions);

  if (!verification.valid) {
    return invalidReceipt({ certificate, verification, escrowId, idempotencyKey, amount, createdAt });
  }

  const mapped = DECISION_MAP[verification.decision];
  if (!mapped) {
    return invalidReceipt({ certificate, verification, escrowId, idempotencyKey, amount, createdAt });
  }

  const subject = clone(verification.subject);
  const receipt = {
    schemaVersion: FAKE_RAIL_RECEIPT_SCHEMA,
    rail: FAKE_RAIL_ID,
    sourceOnly: true,
    noLive: true,
    createdAt,
    escrowId,
    idempotencyKey,
    amount,
    certificateDecision: verification.decision,
    rehearsalDecision: mapped.receiptDecision,
    releaseAuthorized: mapped.releaseAuthorized,
    reason: mapped.reason,
    subject,
    subjectHash: `sha256:${sha256Hex(subject)}`,
    issuerKeyId: verification.issuerKeyId,
    verification: {
      valid: true,
      checks: summarizeChecks(verification.checks),
    },
    safety: { ...SAFETY_FLAGS },
    assurance: {
      proves: ['offline-verifier-ran', 'fake-rail-branch-evaluated', 'idempotency-key-bound'],
      doesNotProve: REQUIRED_DOES_NOT_PROVE,
      disclaimer: 'Fake/no-live rehearsal receipt only. It does not authorize payment release, prove funds are available, or represent a live rail receipt.',
    },
  };
  receipt.receiptId = buildReceiptId(receipt);
  return receipt;
}
