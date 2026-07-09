#!/usr/bin/env node
/**
 * Offline verifier for source-only A2A Escrow Release Proof bundles (#1482).
 *
 * This verifier proves only that release conditions were evaluated and bound to
 * existing A2A evidence. It does NOT move money, authorize payment, hold
 * escrow/custody, call payment rails, decide chargeback liability, deploy a
 * webhook, contact providers, mutate broker state, or use secrets.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';

import { canonicalizeJson, sha256Prefix } from './lib/a2a-offline-verify.mjs';
import { verifyAgentWorkProofBundle } from './verify-agent-work-proof.mjs';
import { verifyVerdict } from './verify-finalizer-verdict.mjs';

export const ESCROW_RELEASE_PROOF_SCHEMA = 'a2a.escrow-release-proof.bundle.v0';
export const ESCROW_RELEASE_CONDITION_SCHEMA = 'a2a.escrow-release.condition.v0';
export const CANONICALIZATION = 'rfc8785-jcs-v1';

const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const RELEASE_DECISIONS = ['release_authorized', 'release_rejected', 'release_pending'];
const CONDITION_STATUSES = ['met', 'failed', 'blocked', 'inconclusive', 'pending'];
const NON_AUTHORIZING_STATUSES = ['failed', 'blocked', 'inconclusive'];
const PENDING_STATUSES = ['pending'];
const PAYMENT_BOUNDARY_FALSE_FIELDS = [
  'paymentRailCall',
  'escrowCustody',
  'fundsMovement',
  'providerCredentialRequired',
  'rawCardDataPresent',
  'liveWebhookDeployed',
  'automaticCapture',
  'payoutExecuted',
  'refundExecuted',
  'releaseExecuted',
];
const PUBLIC_SAFETY_FIELDS = [
  'containsPrivatePaths',
  'containsRawLogs',
  'containsTokens',
  'containsProviderIds',
  'containsPrivateKeys',
  'containsTelegramIds',
  'containsRawCardData',
  'containsRawSessionDump',
];
const REQUIRED_PROVES = ['release-condition-evaluated', 'agent-work-proof-bound', 'offline-verification-path'];
const REQUIRED_DOES_NOT_PROVE = [
  'payment-authorized',
  'funds-available',
  'escrow-custody',
  'legal-settlement',
  'chargeback-liability',
  'card-network-authorization',
  'live-rail-execution',
];
const FORBIDDEN_RUNTIME_STRINGS = [
  '/root/',
  '/home/',
  '/Users/',
  '.openclaw/',
  'AGENTS.md',
  'SOUL.md',
  'USER.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  'IDENTITY.md',
];
const SECRET_LIKE_PATTERNS = [
  /ghp_[A-Za-z0-9_]{20,}/,
  /github_pat_[A-Za-z0-9_]+/,
  /sk_live_[A-Za-z0-9]+/,
  /rk_live_[A-Za-z0-9]+/,
  /pk_live_[A-Za-z0-9]+/,
  /xox[baprs]-[A-Za-z0-9-]+/,
  /A2A_EDGE_SECRET=/,
  /EDGE_SECRET=/,
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
];

function pass(checks, id) {
  checks.push({ id, ok: true });
}

function fail(checks, id, detail) {
  checks.push({ id, ok: false, detail });
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isSha256(value) {
  return typeof value === 'string' && HASH_RE.test(value);
}

function hashObject(value) {
  return sha256Prefix(canonicalizeJson(value));
}

function unsafeStringFindings(value, trail = []) {
  const findings = [];
  const visit = (node, pathParts) => {
    if (typeof node === 'string') {
      for (const marker of FORBIDDEN_RUNTIME_STRINGS) {
        if (node.includes(marker)) findings.push({ id: 'private-runtime-marker', marker, path: pathParts.join('.') });
      }
      for (const pattern of SECRET_LIKE_PATTERNS) {
        if (pattern.test(node)) findings.push({ id: 'secret-like-string', marker: String(pattern), path: pathParts.join('.') });
      }
    } else if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, [...pathParts, String(index)]));
    } else if (node && typeof node === 'object') {
      for (const [key, item] of Object.entries(node)) {
        const lower = key.toLowerCase();
        if (item !== false && item !== null && item !== undefined) {
          if (lower.includes('telegram') && lower.includes('id')) {
            findings.push({ id: 'telegram-id-field', marker: key, path: [...pathParts, key].join('.') });
          }
          if (lower.includes('provider') && lower.includes('id')) {
            findings.push({ id: 'provider-id-field', marker: key, path: [...pathParts, key].join('.') });
          }
          if (['pan', 'cvv', 'cardnumber', 'rawcarddata'].some((marker) => lower.includes(marker))) {
            findings.push({ id: 'raw-card-field', marker: key, path: [...pathParts, key].join('.') });
          }
        }
        visit(item, [...pathParts, key]);
      }
    }
  };
  visit(value, trail);
  return findings;
}

function verifyShape(proof, checks) {
  if (!isPlainObject(proof) || proof.schemaVersion !== ESCROW_RELEASE_PROOF_SCHEMA) {
    fail(checks, 'bundle-shape', `schemaVersion must be ${ESCROW_RELEASE_PROOF_SCHEMA}`);
    return;
  }
  if (proof.canonicalization !== CANONICALIZATION) fail(checks, 'bundle-shape', `canonicalization must be ${CANONICALIZATION}`);
  else if (typeof proof.proofId !== 'string' || proof.proofId.trim() === '') fail(checks, 'bundle-shape', 'proofId required');
  else pass(checks, 'bundle-shape');

  if (proof.sourceOnly !== true || proof.noLive !== true) {
    fail(checks, 'bundle-source-only', 'proof must declare sourceOnly=true and noLive=true');
  } else {
    pass(checks, 'bundle-source-only');
  }
}

function verifyPaymentBoundary(proof, checks) {
  const boundary = proof?.paymentBoundary || {};
  const bad = PAYMENT_BOUNDARY_FALSE_FIELDS.filter((field) => boundary[field] !== false);
  if (bad.length > 0) fail(checks, 'payment-boundary', `payment boundary fields must be false: ${bad.join(', ')}`);
  else pass(checks, 'payment-boundary');
}

function verifyPublicSafety(proof, checks) {
  const safety = proof?.publicSafety || {};
  const bad = PUBLIC_SAFETY_FIELDS.filter((field) => safety[field] !== false);
  const unsafe = unsafeStringFindings(proof);
  if (bad.length > 0 || unsafe.length > 0) {
    const details = [];
    if (bad.length > 0) details.push(`publicSafety fields must be false: ${bad.join(', ')}`);
    if (unsafe.length > 0) details.push(`unsafe marker(s): ${unsafe.map((f) => `${f.id}@${f.path}`).join(', ')}`);
    fail(checks, 'public-safe-bundle', details.join('; '));
  } else {
    pass(checks, 'public-safe-bundle');
  }
}

function verifyAgentWorkProofBinding(proof, keyring, checks, opts) {
  const agentResult = verifyAgentWorkProofBundle(proof?.agentWorkProof, keyring, { now: opts.now });
  const agentWorkProofHash = proof?.agentWorkProof ? hashObject(proof.agentWorkProof) : undefined;
  if (agentResult.green) pass(checks, 'agent-work-proof');
  else fail(checks, 'agent-work-proof', `embedded agent-work-proof failed: ${agentResult.checks.filter((c) => !c.ok).map((c) => c.id).join(', ') || 'unknown'}`);

  if (isSha256(agentWorkProofHash) && proof.agentWorkProofHash === agentWorkProofHash) pass(checks, 'agent-work-proof-hash');
  else fail(checks, 'agent-work-proof-hash', 'agentWorkProofHash must equal sha256:JCS(agentWorkProof)');

  return { agentResult, agentWorkProofHash };
}

function conditionStatuses(condition) {
  return Array.isArray(condition?.checks) ? condition.checks.map((check) => check?.status) : [];
}

function expectedReleaseDecision(condition, agentResult) {
  if (!agentResult.green) return { decision: 'release_rejected', reason: 'AGENT_WORK_PROOF_INVALID' };
  if (!isPlainObject(condition)) return { decision: 'release_rejected', reason: 'RELEASE_CONDITION_MISSING' };
  const statuses = conditionStatuses(condition);
  if (statuses.length === 0 || statuses.some((status) => !CONDITION_STATUSES.includes(status))) {
    return { decision: 'release_rejected', reason: 'INVALID_CONDITION_STATUS' };
  }
  if (statuses.some((status) => NON_AUTHORIZING_STATUSES.includes(status))) {
    return { decision: 'release_rejected', reason: 'CONDITIONS_NOT_MET' };
  }
  if (statuses.some((status) => PENDING_STATUSES.includes(status))) {
    return { decision: 'release_pending', reason: 'CONDITIONS_PENDING' };
  }
  const approval = condition.approval || {};
  if (approval.required === true && approval.status !== 'approved') {
    return { decision: 'release_pending', reason: 'APPROVAL_REQUIRED_MISSING' };
  }
  if (Array.isArray(condition.externalRailConditions) && condition.externalRailConditions.length > 0) {
    return { decision: 'release_pending', reason: 'EXTERNAL_RAIL_CONDITION_PENDING' };
  }
  return { decision: 'release_authorized', reason: 'RELEASE_AUTHORIZED' };
}

function verifyReleaseCondition(proof, agentWorkProofHash, checks) {
  const condition = proof?.releaseCondition;
  if (!isPlainObject(condition) || condition.schemaVersion !== ESCROW_RELEASE_CONDITION_SCHEMA) {
    fail(checks, 'release-condition-shape', `schemaVersion must be ${ESCROW_RELEASE_CONDITION_SCHEMA}`);
    return undefined;
  }
  pass(checks, 'release-condition-shape');

  if (condition.sourceOnly !== true || condition.noLive !== true || condition.providerCredentialRequired !== false) {
    fail(checks, 'release-condition-source-only', 'release condition must be source-only/no-live and require no provider credential');
  } else {
    pass(checks, 'release-condition-source-only');
  }

  if (isSha256(condition.paymentReferenceHash) && condition.escrowReference?.rawEscrowIdPresent === false) {
    pass(checks, 'payment-reference-shape');
  } else {
    fail(checks, 'payment-reference-shape', 'release condition must use a sha256 paymentReferenceHash and declare rawEscrowIdPresent=false');
  }

  if (Array.isArray(condition.externalRailConditions)) {
    pass(checks, 'external-rail-conditions-shape');
  } else {
    fail(checks, 'external-rail-conditions-shape', 'externalRailConditions must be an explicit array; non-empty arrays keep release pending');
  }

  const conditionHash = hashObject(condition);
  if (proof.releaseConditionHash === conditionHash) pass(checks, 'release-condition-hash');
  else fail(checks, 'release-condition-hash', 'releaseConditionHash must equal sha256:JCS(releaseCondition)');

  const evidence = condition.requiredEvidence || {};
  const deterministicChecks = Array.isArray(evidence.deterministicChecks) ? evidence.deterministicChecks : [];
  if (evidence.agentWorkProofHash === agentWorkProofHash && evidence.signedVerdictRequired === true && deterministicChecks.includes('certification-battery')) {
    pass(checks, 'required-evidence-binding');
  } else {
    fail(checks, 'required-evidence-binding', 'condition must bind agentWorkProofHash, require a signed verdict, and reference deterministic certification-battery checks');
  }

  let statusesOk = Array.isArray(condition.checks) && condition.checks.length > 0;
  for (const check of Array.isArray(condition.checks) ? condition.checks : []) {
    if (!check?.id || !CONDITION_STATUSES.includes(check.status)) statusesOk = false;
  }
  if (statusesOk) pass(checks, 'condition-statuses');
  else fail(checks, 'condition-statuses', `condition checks must use statuses: ${CONDITION_STATUSES.join(', ')}`);
  return conditionHash;
}

function verifyReleaseDecision(proof, expected, checks) {
  const decision = proof?.releaseDecision;
  if (!isPlainObject(decision) || !RELEASE_DECISIONS.includes(decision.decision)) {
    fail(checks, 'release-decision-shape', `releaseDecision.decision must be one of ${RELEASE_DECISIONS.join(', ')}`);
    return { releaseAllowed: false };
  }
  pass(checks, 'release-decision-shape');

  if (decision.decision === expected.decision) pass(checks, 'release-decision');
  else fail(checks, 'release-decision', `expected ${expected.decision} from evidence, got ${decision.decision}`);

  const reasonCodes = Array.isArray(decision.reasonCodes) ? decision.reasonCodes : [];
  if (reasonCodes.length === 0) {
    fail(checks, 'release-reason-codes', 'releaseDecision.reasonCodes required');
  } else if (decision.decision === 'release_authorized' && reasonCodes.includes('RELEASE_AUTHORIZED') && !reasonCodes.includes('APPROVAL_REQUIRED_MISSING')) {
    pass(checks, 'release-reason-codes');
  } else if (decision.decision !== 'release_authorized' && reasonCodes.some((code) => code === expected.reason || code.endsWith('_MISSING') || code.endsWith('_INVALID') || code.endsWith('_PENDING') || code.endsWith('_NOT_MET'))) {
    pass(checks, 'release-reason-codes');
  } else {
    fail(checks, 'release-reason-codes', `reason codes must explain ${decision.decision}`);
  }

  const approvalState = decision.approvalState;
  const releaseState = decision.releaseState;
  const separated = ['approval_not_required', 'approval_satisfied', 'approval_required'].includes(approvalState) && releaseState === decision.decision;
  if (separated) pass(checks, 'approval-release-state-separation');
  else fail(checks, 'approval-release-state-separation', 'approvalState and releaseState must be explicit and separate');

  return { releaseAllowed: decision.decision === 'release_authorized' && expected.decision === 'release_authorized' };
}

function expectedReleaseVerdictSubject(proof, conditionHash, agentWorkProofHash) {
  return {
    kind: 'escrow-release-proof',
    proofId: proof?.proofId,
    releaseConditionHash: conditionHash,
    agentWorkProofHash,
    paymentReferenceHash: proof?.releaseCondition?.paymentReferenceHash,
    decision: proof?.releaseDecision?.decision,
  };
}

function verifyReleaseVerdict(proof, conditionHash, agentWorkProofHash, keyring, checks, opts) {
  const expectedSubject = expectedReleaseVerdictSubject(proof, conditionHash, agentWorkProofHash);
  const verdict = verifyVerdict(proof?.releaseVerdict, keyring, { expectedSubject, now: opts.now });
  const expectedVerdictDecision = proof?.releaseDecision?.decision === 'release_authorized' ? 'go' : 'no-go';
  if (verdict.valid && verdict.kind === 'judgment' && verdict.decision === expectedVerdictDecision) {
    pass(checks, 'release-verdict');
  } else {
    fail(checks, 'release-verdict', `release verdict must be valid judgment decision=${expectedVerdictDecision} and subject-bound: ${verdict.checks.filter((c) => !c.ok).map((c) => c.id).join(', ') || `decision=${verdict.decision ?? 'absent'}`}`);
  }
}

function verifyAssurance(proof, checks) {
  const assurance = proof?.assurance || {};
  const proves = Array.isArray(assurance.proves) ? assurance.proves : [];
  const doesNotProve = Array.isArray(assurance.doesNotProve) ? assurance.doesNotProve : [];
  const missing = [
    ...REQUIRED_PROVES.filter((item) => !proves.includes(item)).map((item) => `proves:${item}`),
    ...REQUIRED_DOES_NOT_PROVE.filter((item) => !doesNotProve.includes(item)).map((item) => `doesNotProve:${item}`),
  ];
  if (missing.length > 0 || typeof assurance.disclaimer !== 'string' || assurance.disclaimer.trim() === '') {
    fail(checks, 'assurance-boundary', `missing assurance boundary entries: ${missing.join(', ') || 'disclaimer'}`);
  } else {
    pass(checks, 'assurance-boundary');
  }
}

function verifyExtractionBoundary(proof, checks) {
  const extraction = proof?.extractionReadiness || {};
  if (extraction.repoExtractionReady === false && extraction.registryWrite === false && extraction.badgePublication === false && extraction.liveWebhookDeployment === false && extraction.decision === 'defer-live-rail-integration-until-fresh-approval') {
    pass(checks, 'extraction-boundary');
  } else {
    fail(checks, 'extraction-boundary', 'extraction/live rail integration must remain deferred until fresh approval');
  }
}

export function verifyEscrowReleaseProof(proof, keyring, opts = {}) {
  const checks = [];
  verifyShape(proof, checks);
  verifyPaymentBoundary(proof, checks);
  verifyPublicSafety(proof, checks);
  const { agentResult, agentWorkProofHash } = verifyAgentWorkProofBinding(proof, keyring, checks, opts);
  const conditionHash = verifyReleaseCondition(proof, agentWorkProofHash, checks);
  const expected = expectedReleaseDecision(proof?.releaseCondition, agentResult);
  const decisionResult = verifyReleaseDecision(proof, expected, checks);
  verifyReleaseVerdict(proof, conditionHash, agentWorkProofHash, keyring, checks, opts);
  verifyAssurance(proof, checks);
  verifyExtractionBoundary(proof, checks);
  return {
    green: checks.every((check) => check.ok),
    checks,
    proofId: proof?.proofId,
    decision: proof?.releaseDecision?.decision,
    releaseAllowed: decisionResult.releaseAllowed && checks.every((check) => check.ok),
    expectedDecision: expected.decision,
    agentWorkProofHash,
    releaseConditionHash: conditionHash,
  };
}

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      keyring: { type: 'string' },
      json: { type: 'boolean', default: false },
      now: { type: 'string' },
    },
  });
  const proofPath = positionals[0];
  if (!proofPath || !values.keyring) {
    process.stderr.write('usage: verify-escrow-release-proof.mjs <proof.json> --keyring <keyring.json> [--now ISO] [--json]\n');
    return 2;
  }
  let proof;
  let keyring;
  try {
    proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
  } catch (err) {
    process.stderr.write(`cannot read proof: ${err.message}\n`);
    return 2;
  }
  try {
    keyring = JSON.parse(fs.readFileSync(values.keyring, 'utf8'));
  } catch (err) {
    process.stderr.write(`cannot read keyring: ${err.message}\n`);
    return 2;
  }
  const result = verifyEscrowReleaseProof(proof, keyring, { now: values.now });
  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const check of result.checks) {
      process.stdout.write(`${check.ok ? 'PASS' : 'FAIL'}  ${check.id}${check.detail ? ` — ${check.detail}` : ''}\n`);
    }
    process.stdout.write(`\n${result.releaseAllowed ? 'GREEN — release condition verified as authorized' : 'RED/PENDING — release is not authorized (fail-closed)'}\n`);
  }
  return result.green ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
