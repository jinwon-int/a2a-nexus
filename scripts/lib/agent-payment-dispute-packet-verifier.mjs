import { canonicalizeJson, sha256Prefix } from './a2a-offline-verify.mjs';
import { verifyVerdict } from '../verify-finalizer-verdict.mjs';
import { verifyEscrowReleaseProof } from '../verify-escrow-release-proof.mjs';

export const DISPUTE_PACKET_SCHEMA = 'a2a.agent-payment-dispute-packet.v0';
export const MANDATE_SCHEMA = 'a2a.agent-payment-mandate.v0';
export const SCOPE_DECISION_SCHEMA = 'a2a.payment-scope-decision.v0';
export const CANONICALIZATION = 'rfc8785-jcs-v1';

const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const RELEASE_DECISIONS = ['release_authorized', 'release_rejected', 'release_pending'];
const SCOPE_DECISIONS = ['allowed', 'rejected', 'pending'];
const SCOPE_STATUSES = ['passed', 'failed', 'pending', 'not_required'];
const PAYMENT_BOUNDARY_FALSE_FIELDS = [
  'paymentRailCall',
  'paymentAuthorization',
  'fundsMovement',
  'escrowCustody',
  'providerCredentialRequired',
  'rawCardDataPresent',
  'rawPanPresent',
  'rawCvvPresent',
  'liveWebhookDeployed',
  'captureExecuted',
  'payoutExecuted',
  'refundExecuted',
  'releaseExecuted',
  'networkAuthorizationClaimed',
  'chargebackDecisionFinal',
  'legalIdentityVerifiedByNexus',
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
  'containsPii',
];
const REQUIRED_DOES_NOT_PROVE = [
  'card_network_authorization',
  'funds_available',
  'legal_identity_of_human',
  'tax_or_regulatory_compliance',
  'final_chargeback_liability',
  'payment_rail_execution',
  'pci_card_data_handling',
];
const REQUIRED_PROVES = [
  'user-delegation-evaluated',
  'agent-identity-bound',
  'scope-decision-evaluated',
  'completion-proof-bound',
  'release-decision-recomputed',
];
const AUTHORIZED_REASON_CODES = [
  'USER_DELEGATION_VALID',
  'AGENT_IDENTITY_VERIFIED',
  'SCOPE_MATCHED',
  'PAYMENT_REFERENCE_BOUND_TO_TASK',
  'COMPLETION_CERTIFICATE_VALID',
  'DETERMINISTIC_CONDITIONS_PASSED',
  'NO_TAMPER_DETECTED',
  'RELEASE_AUTHORIZED',
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
          if (lower.includes('telegram') && lower.includes('id')) findings.push({ id: 'telegram-id-field', marker: key, path: [...pathParts, key].join('.') });
          if (lower.includes('provider') && lower.includes('id')) findings.push({ id: 'provider-id-field', marker: key, path: [...pathParts, key].join('.') });
          if (['pan', 'cvv', 'cardnumber', 'rawcarddata', 'paymenttoken'].some((marker) => lower.includes(marker))) {
            findings.push({ id: 'raw-payment-field', marker: key, path: [...pathParts, key].join('.') });
          }
        }
        visit(item, [...pathParts, key]);
      }
    }
  };
  visit(value, trail);
  return findings;
}

function parseAmountCents(amount) {
  if (!isPlainObject(amount) || typeof amount.currency !== 'string' || typeof amount.value !== 'string') return undefined;
  if (!/^[A-Z]{3}$/.test(amount.currency) || !/^\d+(?:\.\d{2})$/.test(amount.value)) return undefined;
  const [major, minor] = amount.value.split('.');
  const cents = Number(major) * 100 + Number(minor);
  return Number.isSafeInteger(cents) ? { currency: amount.currency, cents } : undefined;
}

function nowMs(opts) {
  const value = opts.now === undefined ? Date.now() : Date.parse(String(opts.now));
  return Number.isFinite(value) ? value : Date.now();
}

function verifyShape(packet, checks) {
  if (!isPlainObject(packet) || packet.schemaVersion !== DISPUTE_PACKET_SCHEMA) {
    fail(checks, 'packet-shape', `schemaVersion must be ${DISPUTE_PACKET_SCHEMA}`);
    return;
  }
  if (packet.canonicalization !== CANONICALIZATION) fail(checks, 'packet-shape', `canonicalization must be ${CANONICALIZATION}`);
  else if (typeof packet.packetId !== 'string' || packet.packetId.trim() === '') fail(checks, 'packet-shape', 'packetId required');
  else pass(checks, 'packet-shape');

  if (packet.sourceOnly !== true || packet.noLive !== true) fail(checks, 'packet-source-only', 'packet must declare sourceOnly=true and noLive=true');
  else pass(checks, 'packet-source-only');
}

function verifyPaymentBoundary(packet, checks) {
  const boundary = packet?.paymentBoundary || {};
  const bad = PAYMENT_BOUNDARY_FALSE_FIELDS.filter((field) => boundary[field] !== false);
  if (bad.length > 0) fail(checks, 'payment-boundary', `payment boundary fields must be false: ${bad.join(', ')}`);
  else pass(checks, 'payment-boundary');
}

function verifyPublicSafety(packet, checks) {
  const safety = packet?.publicSafety || {};
  const bad = PUBLIC_SAFETY_FIELDS.filter((field) => safety[field] !== false);
  const unsafe = unsafeStringFindings(packet);
  if (bad.length > 0 || unsafe.length > 0) {
    const details = [];
    if (bad.length > 0) details.push(`publicSafety fields must be false: ${bad.join(', ')}`);
    if (unsafe.length > 0) details.push(`unsafe marker(s): ${unsafe.map((f) => `${f.id}@${f.path}`).join(', ')}`);
    fail(checks, 'public-safe-packet', details.join('; '));
  } else {
    pass(checks, 'public-safe-packet');
  }
}

function verifyDispute(packet, checks) {
  const dispute = packet?.dispute;
  if (!isPlainObject(dispute) || dispute.claim !== 'user_denies_agent_payment_authorization' || !isSha256(dispute.paymentReferenceHash)) {
    fail(checks, 'dispute-shape', 'dispute must carry supported claim and sha256 paymentReferenceHash');
    return undefined;
  }
  if (dispute.rawPaymentReferencePresent !== false || dispute.providerReferencePresent !== false || !Number.isFinite(Date.parse(dispute.openedAt))) {
    fail(checks, 'dispute-shape', 'dispute must be hash/reference-only with valid openedAt');
    return undefined;
  }
  pass(checks, 'dispute-shape');
  return dispute.paymentReferenceHash;
}

function verifyMandate(packet, checks) {
  const mandate = packet?.mandate;
  const payload = mandate?.mandatePayload;
  if (!isPlainObject(mandate) || !isPlainObject(payload) || payload.schemaVersion !== MANDATE_SCHEMA) {
    fail(checks, 'mandate-shape', `mandatePayload.schemaVersion must be ${MANDATE_SCHEMA}`);
    return { payload, hash: undefined, valid: false };
  }
  pass(checks, 'mandate-shape');

  const mandateHash = hashObject(payload);
  if (mandate.mandateHash === mandateHash) pass(checks, 'mandate-hash');
  else fail(checks, 'mandate-hash', 'mandateHash must equal sha256:JCS(mandatePayload)');

  const privacy = payload.privacy || {};
  const authorization = payload.authorization || {};
  if (privacy.piiMode === 'hash_or_reference_only' && privacy.rawCardDataPresent === false && privacy.rawUserIdentifierPresent === false && authorization.rawSignaturePresent === false) {
    pass(checks, 'mandate-public-safety');
  } else {
    fail(checks, 'mandate-public-safety', 'mandate must be hash/reference-only and contain no raw card/user/signature material');
  }

  if (mandate.verification === 'valid' && authorization.verification === 'valid' && typeof authorization.method === 'string' && isSha256(authorization.assertionHash)) {
    pass(checks, 'mandate-verification');
  } else {
    fail(checks, 'mandate-verification', 'mandate authorization must be verified and hash-bound');
  }

  return { payload, hash: mandateHash, valid: mandate.mandateHash === mandateHash && mandate.verification === 'valid' && authorization.verification === 'valid' };
}

function verifyAgentIdentity(packet, mandatePayload, checks) {
  const identity = packet?.agentIdentity;
  const mandateAgent = mandatePayload?.subject?.agentKeyId;
  const valid = isPlainObject(identity) && identity.verification === 'valid' && identity.agentKeyId === mandateAgent && identity.rawRegistryIdPresent === false && isSha256(identity.registryReferenceHash);
  if (valid) pass(checks, 'agent-identity');
  else fail(checks, 'agent-identity', 'agent identity must be verified, hash/reference-only, and match mandate subject');
  return { valid, agentKeyId: identity?.agentKeyId };
}

function taskWithinMandate(task, mandatePayload, paymentReferenceHash) {
  const scope = mandatePayload?.scope || {};
  const taskAmount = parseAmountCents(task?.amount);
  const maxAmount = parseAmountCents(scope.maxAmount);
  return {
    paymentBound: task?.paymentReferenceHash === paymentReferenceHash,
    intentAllowed: task?.intent === scope.intent,
    amountWithinCap: Boolean(taskAmount && maxAmount && taskAmount.currency === maxAmount.currency && taskAmount.cents <= maxAmount.cents),
    merchantAllowed: Array.isArray(scope.merchantAllowlist) && scope.merchantAllowlist.includes(task?.merchantRef),
    productAllowed: scope.productRefHash === undefined || scope.productRefHash === task?.productRefHash,
  };
}

function verifyTaskContract(packet, mandatePayload, paymentReferenceHash, escrowHash, checks) {
  const task = packet?.taskContract;
  if (!isPlainObject(task) || typeof task.taskId !== 'string' || !isSha256(task.acceptanceCriteriaHash) || !isSha256(task.paymentReferenceHash)) {
    fail(checks, 'task-contract-shape', 'task contract must carry taskId, acceptanceCriteriaHash, and hash-only payment reference');
    return { task, taskChecks: {} };
  }
  pass(checks, 'task-contract-shape');

  const taskChecks = taskWithinMandate(task, mandatePayload, paymentReferenceHash);
  const escrowBound = task.escrowReleaseProofHash === escrowHash;
  if (taskChecks.paymentBound && escrowBound) pass(checks, 'payment-reference-binding');
  else fail(checks, 'payment-reference-binding', 'payment reference must bind dispute, task contract, and escrow release proof');
  return { task, taskChecks: { ...taskChecks, escrowBound } };
}

function expectedScopeStatuses(packet, mandatePayload, agentIdentity, taskChecks, escrowResult, opts) {
  const scope = mandatePayload?.scope || {};
  const approval = packet?.scopeDecision?.freshApproval || {};
  const deadlineMs = typeof scope.deadline === 'string' ? Date.parse(scope.deadline) : NaN;
  const expired = !Number.isFinite(deadlineMs) || nowMs(opts) > deadlineMs;
  return new Map([
    ['agent_identity_verified', agentIdentity.valid ? 'passed' : 'failed'],
    ['intent_allowed_by_mandate', taskChecks.intentAllowed ? 'passed' : 'failed'],
    ['amount_within_cap', taskChecks.amountWithinCap ? 'passed' : 'failed'],
    ['merchant_allowed', taskChecks.merchantAllowed && taskChecks.productAllowed ? 'passed' : 'failed'],
    ['mandate_not_expired', expired ? 'failed' : 'passed'],
    ['fresh_user_approval', scope.freshApprovalRequired === true ? (approval.status === 'approved' ? 'passed' : 'pending') : 'not_required'],
    ['payment_reference_bound_to_task', taskChecks.paymentBound && taskChecks.escrowBound ? 'passed' : 'failed'],
    ['completion_proof_valid', escrowResult.green && escrowResult.releaseAllowed ? 'passed' : (escrowResult.green ? 'pending' : 'failed')],
  ]);
}

function verifyScopeDecision(packet, expectedStatuses, checks) {
  const decision = packet?.scopeDecision;
  if (!isPlainObject(decision) || decision.schemaVersion !== SCOPE_DECISION_SCHEMA || !SCOPE_DECISIONS.includes(decision.decision) || !Array.isArray(decision.checks)) {
    fail(checks, 'scope-decision-shape', `scopeDecision must use ${SCOPE_DECISION_SCHEMA} with ${SCOPE_DECISIONS.join('/')} decision and checks array`);
    return { expectedDecision: 'rejected', mismatch: true };
  }
  pass(checks, 'scope-decision-shape');

  const declared = new Map(decision.checks.map((entry) => [entry?.id, entry?.status]));
  const missing = [];
  const mismatched = [];
  for (const [id, status] of expectedStatuses.entries()) {
    if (!declared.has(id)) missing.push(id);
    else if (declared.get(id) !== status) mismatched.push(`${id}:expected=${status}:got=${declared.get(id)}`);
  }
  const invalid = decision.checks.filter((entry) => !entry?.id || !SCOPE_STATUSES.includes(entry.status));
  if (missing.length === 0 && mismatched.length === 0 && invalid.length === 0) pass(checks, 'scope-checks');
  else fail(checks, 'scope-checks', `missing=${missing.join(',')}; mismatched=${mismatched.join(',')}; invalid=${invalid.length}`);

  const statuses = [...expectedStatuses.values()];
  const expectedDecision = statuses.includes('failed') ? 'rejected' : (statuses.includes('pending') ? 'pending' : 'allowed');
  if (decision.decision === expectedDecision) pass(checks, 'scope-decision');
  else fail(checks, 'scope-decision', `expected ${expectedDecision}, got ${decision.decision}`);
  return { expectedDecision, mismatch: missing.length > 0 || mismatched.length > 0 || invalid.length > 0 || decision.decision !== expectedDecision };
}

function verifyEscrowBinding(packet, keyring, checks, opts) {
  const escrowResult = verifyEscrowReleaseProof(packet?.escrowReleaseProof, keyring, { now: opts.now });
  const escrowHash = packet?.escrowReleaseProof ? hashObject(packet.escrowReleaseProof) : undefined;
  if (escrowResult.green) pass(checks, 'escrow-release-proof');
  else fail(checks, 'escrow-release-proof', `embedded escrow-release-proof failed: ${escrowResult.checks.filter((c) => !c.ok).map((c) => c.id).join(', ') || 'unknown'}`);

  if (isSha256(escrowHash) && packet.escrowReleaseProofHash === escrowHash) pass(checks, 'escrow-release-proof-hash');
  else fail(checks, 'escrow-release-proof-hash', 'escrowReleaseProofHash must equal sha256:JCS(escrowReleaseProof)');
  return { escrowResult, escrowHash };
}

function verifyCompletionProof(packet, escrowResult, escrowHash, checks) {
  const proof = packet?.completionProof;
  const reasonCodes = Array.isArray(proof?.reasonCodes) ? proof.reasonCodes : [];
  const valid = isPlainObject(proof) && proof.escrowReleaseProofHash === escrowHash && proof.verifierDecision === 'valid' && proof.releaseDecision === escrowResult.decision && reasonCodes.includes('COMPLETION_CERTIFICATE_VALID') && reasonCodes.includes('NO_TAMPER_DETECTED');
  if (valid) pass(checks, 'completion-proof');
  else fail(checks, 'completion-proof', 'completionProof must bind escrowReleaseProofHash, verifier decision, release decision, and no-tamper reason codes');
  return { valid };
}

function reasonForExpected(packet, mandate, agentIdentity, taskChecks, scopeExpectedDecision, escrowResult) {
  if (!isPlainObject(mandate.payload)) return { decision: 'release_rejected', reason: 'NO_USER_DELEGATION' };
  if (!mandate.valid) return { decision: 'release_rejected', reason: 'MANDATE_SIGNATURE_INVALID' };
  if (!agentIdentity.valid) return { decision: 'release_rejected', reason: 'AGENT_UNVERIFIED' };
  if (!taskChecks.paymentBound || !taskChecks.escrowBound) return { decision: 'release_rejected', reason: 'PAYMENT_REFERENCE_NOT_BOUND' };
  if (!taskChecks.intentAllowed) return { decision: 'release_rejected', reason: 'INTENT_NOT_AUTHORIZED' };
  if (!taskChecks.amountWithinCap) return { decision: 'release_rejected', reason: 'AMOUNT_EXCEEDED' };
  if (!taskChecks.merchantAllowed || !taskChecks.productAllowed) return { decision: 'release_rejected', reason: 'MERCHANT_SCOPE_MISMATCH' };
  const scope = mandate.payload.scope || {};
  const deadlineMs = Date.parse(scope.deadline);
  if (!Number.isFinite(deadlineMs) || nowMs(packet.__opts || {}) > deadlineMs) return { decision: 'release_rejected', reason: 'MANDATE_EXPIRED' };
  if (scopeExpectedDecision === 'pending') return { decision: 'release_pending', reason: 'APPROVAL_REQUIRED_MISSING' };
  if (scopeExpectedDecision === 'rejected') return { decision: 'release_rejected', reason: 'INCONCLUSIVE_EVIDENCE' };
  if (!escrowResult.green) return { decision: 'release_rejected', reason: 'PROOF_TAMPERED' };
  if (!escrowResult.releaseAllowed) {
    return escrowResult.expectedDecision === 'release_pending'
      ? { decision: 'release_pending', reason: 'COMPLETION_CONDITIONS_PENDING' }
      : { decision: 'release_rejected', reason: 'COMPLETION_CONDITIONS_NOT_MET' };
  }
  return { decision: 'release_authorized', reason: 'RELEASE_AUTHORIZED' };
}

function verifyReleaseDecision(packet, expected, checks) {
  const decision = packet?.releaseDecision;
  if (!isPlainObject(decision) || !RELEASE_DECISIONS.includes(decision.decision)) {
    fail(checks, 'release-decision-shape', `releaseDecision.decision must be one of ${RELEASE_DECISIONS.join(', ')}`);
    return { releaseAllowed: false };
  }
  pass(checks, 'release-decision-shape');

  if (decision.decision === expected.decision) pass(checks, 'release-decision');
  else fail(checks, 'release-decision', `expected ${expected.decision} from evidence, got ${decision.decision}`);

  const reasonCodes = Array.isArray(decision.reasonCodes) ? decision.reasonCodes : [];
  if (decision.decision === 'release_authorized') {
    const missing = AUTHORIZED_REASON_CODES.filter((code) => !reasonCodes.includes(code));
    if (missing.length === 0 && !reasonCodes.includes('APPROVAL_REQUIRED_MISSING')) pass(checks, 'reason-codes');
    else fail(checks, 'reason-codes', `authorized packet missing reason code(s): ${missing.join(', ')}`);
  } else if (reasonCodes.includes(expected.reason)) {
    pass(checks, 'reason-codes');
  } else {
    fail(checks, 'reason-codes', `reason codes must include expected user-protective reason ${expected.reason}`);
  }
  return { releaseAllowed: decision.decision === 'release_authorized' && expected.decision === 'release_authorized' };
}

function expectedVerdictSubject(packet, mandateHash, escrowHash) {
  return {
    kind: 'agent-payment-dispute-packet',
    packetId: packet?.packetId,
    mandateHash,
    escrowReleaseProofHash: escrowHash,
    paymentReferenceHash: packet?.dispute?.paymentReferenceHash,
    decision: packet?.releaseDecision?.decision,
  };
}

function verifyPacketVerdict(packet, mandateHash, escrowHash, keyring, checks, opts) {
  const expectedSubject = expectedVerdictSubject(packet, mandateHash, escrowHash);
  const verdict = verifyVerdict(packet?.packetVerdict, keyring, { expectedSubject, now: opts.now });
  const expectedVerdictDecision = packet?.releaseDecision?.decision === 'release_authorized' ? 'go' : 'no-go';
  if (verdict.valid && verdict.kind === 'judgment' && verdict.decision === expectedVerdictDecision) {
    pass(checks, 'packet-verdict');
  } else {
    fail(checks, 'packet-verdict', `packet verdict must be valid judgment decision=${expectedVerdictDecision} and subject-bound: ${verdict.checks.filter((c) => !c.ok).map((c) => c.id).join(', ') || `decision=${verdict.decision ?? 'absent'}`}`);
  }
}

function verifyAssurance(packet, checks) {
  const proves = Array.isArray(packet?.assurance?.proves) ? packet.assurance.proves : [];
  const doesNotProve = Array.isArray(packet?.doesNotProve) ? packet.doesNotProve : [];
  const assuranceDoesNotProve = Array.isArray(packet?.assurance?.doesNotProve) ? packet.assurance.doesNotProve : [];
  const combinedDoesNotProve = new Set([...doesNotProve, ...assuranceDoesNotProve]);
  const missing = [
    ...REQUIRED_PROVES.filter((item) => !proves.includes(item)).map((item) => `proves:${item}`),
    ...REQUIRED_DOES_NOT_PROVE.filter((item) => !combinedDoesNotProve.has(item)).map((item) => `doesNotProve:${item}`),
  ];
  if (missing.length > 0 || typeof packet?.assurance?.disclaimer !== 'string' || packet.assurance.disclaimer.trim() === '') {
    fail(checks, 'assurance-boundary', `missing assurance boundary entries: ${missing.join(', ') || 'disclaimer'}`);
  } else {
    pass(checks, 'assurance-boundary');
  }
}

function verifyExtractionBoundary(packet, checks) {
  const extraction = packet?.extractionReadiness || {};
  if (extraction.repoExtractionReady === false && extraction.registryWrite === false && extraction.badgePublication === false && extraction.liveWebhookDeployment === false && extraction.pspAdapterEnabled === false && extraction.decision === 'defer-product-extraction-and-live-rail-integration-until-fresh-approval') {
    pass(checks, 'extraction-boundary');
  } else {
    fail(checks, 'extraction-boundary', 'extraction/live rail integration must remain deferred until fresh approval');
  }
}

export function verifyAgentPaymentDisputePacket(packet, keyring, opts = {}) {
  const checks = [];
  const optsCarrier = { ...packet, __opts: opts };
  verifyShape(packet, checks);
  verifyPaymentBoundary(packet, checks);
  verifyPublicSafety(packet, checks);
  const paymentReferenceHash = verifyDispute(packet, checks);
  const { escrowResult, escrowHash } = verifyEscrowBinding(packet, keyring, checks, opts);
  const mandate = verifyMandate(packet, checks);
  const agentIdentity = verifyAgentIdentity(packet, mandate.payload, checks);
  const { taskChecks } = verifyTaskContract(packet, mandate.payload, paymentReferenceHash, escrowHash, checks);
  const expectedStatuses = expectedScopeStatuses(packet, mandate.payload, agentIdentity, taskChecks, escrowResult, opts);
  const scope = verifyScopeDecision(packet, expectedStatuses, checks);
  verifyCompletionProof(packet, escrowResult, escrowHash, checks);
  const expected = reasonForExpected(optsCarrier, mandate, agentIdentity, taskChecks, scope.expectedDecision, escrowResult);
  const decisionResult = verifyReleaseDecision(packet, expected, checks);
  verifyPacketVerdict(packet, mandate.hash, escrowHash, keyring, checks, opts);
  verifyAssurance(packet, checks);
  verifyExtractionBoundary(packet, checks);
  const green = checks.every((check) => check.ok);
  return {
    green,
    checks,
    packetId: packet?.packetId,
    decision: packet?.releaseDecision?.decision,
    expectedDecision: expected.decision,
    expectedReason: expected.reason,
    releaseAllowed: decisionResult.releaseAllowed && green,
    mandateHash: mandate.hash,
    escrowReleaseProofHash: escrowHash,
    paymentReferenceHash,
  };
}
