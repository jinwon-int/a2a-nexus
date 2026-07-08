/**
 * Source-only live rail approval-gate validator for A2A Completion Certificate v0
 * (#1393 option 4).
 *
 * This module validates the packet that must exist before any future rail-specific
 * AP2/x402/Stripe-style live integration work can be considered. It intentionally
 * performs no payment rail calls, no provider sends, no DB/outbox/ACK/replay
 * mutation, no deploy/restart, no package publication, and no secret movement.
 */

export const LIVE_RAIL_APPROVAL_PACKET_SCHEMA = 'a2a.completion.liveRailApprovalPacket.v0';
export const APPROVAL_GATE_MODE = 'offline-approval-gate-only';

export const REQUIRED_FALSE_SAFETY_FLAGS = Object.freeze([
  'paymentRailCall',
  'escrowCustody',
  'fundsMovement',
  'providerSend',
  'telegramSend',
  'databaseMutation',
  'terminalAckReplay',
  'deployOrRestart',
  'secretRequired',
  'liveSigningKeyRequired',
]);

const REQUIRED_ROLLBACK_STEPS = Object.freeze([
  'revoke-credentials',
  'disable-adapter',
  'halt-canary',
  'verify-no-db-outbox-ack-replay',
]);

const SECRET_LIKE = /(?:sk_live|sk_test|rk_live|rk_test|xox[baprs]-|ghp_|github_pat_|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~+/-]{20,}|api[_-]?key\s*[:=])/i;

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isIsoTimestamp(value) {
  return hasText(value) && Number.isFinite(Date.parse(value));
}

function inspectForRawSecret(value, path = '$', findings = []) {
  if (typeof value === 'string') {
    if (SECRET_LIKE.test(value)) findings.push({ ok: false, id: 'raw-secret-forbidden', detail: `${path} contains secret-like material` });
    return findings;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectForRawSecret(item, `${path}[${index}]`, findings));
    return findings;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      inspectForRawSecret(item, `${path}.${key}`, findings);
    }
  }
  return findings;
}

function add(findings, ok, id, detail) {
  findings.push({ ok, id, ...(detail ? { detail } : {}) });
}

function validateSafetyFlags(packet, findings) {
  const safety = packet.safety;
  if (!isPlainObject(safety)) {
    add(findings, false, 'safety-flags-present', 'safety must be an object');
    return;
  }
  add(findings, true, 'safety-flags-present');
  for (const flag of REQUIRED_FALSE_SAFETY_FLAGS) {
    add(findings, safety[flag] === false, `safety-${flag}-false`, `${flag} must be explicit false for approval-gate-only packets`);
  }
}

function validateApproval(packet, findings, now) {
  const approval = packet.approval;
  if (!isPlainObject(approval)) {
    add(findings, false, 'approval-present', 'approval must be an object');
    return;
  }
  add(findings, true, 'approval-present');
  add(findings, hasText(approval.approvalRef), 'approval-ref-present', 'approval.approvalRef is required');
  add(findings, hasText(approval.approvedBy), 'approved-by-present', 'approval.approvedBy is required');
  add(findings, isIsoTimestamp(approval.approvedAt), 'approved-at-iso', 'approval.approvedAt must be an ISO timestamp');
  add(findings, isIsoTimestamp(approval.expiresAt), 'approval-expiry-iso', 'approval.expiresAt must be an ISO timestamp');
  if (isIsoTimestamp(approval.approvedAt) && isIsoTimestamp(approval.expiresAt)) {
    const approvedAt = Date.parse(approval.approvedAt);
    const expiresAt = Date.parse(approval.expiresAt);
    add(findings, expiresAt > approvedAt, 'approval-expiry-after-approved-at', 'expiresAt must be after approvedAt');
    const maxWindowMs = 14 * 24 * 60 * 60 * 1000;
    add(findings, expiresAt - approvedAt <= maxWindowMs, 'approval-window-bounded', 'approval window must be <=14 days');
    if (now) add(findings, Date.parse(now) < expiresAt, 'approval-not-expired', 'approval packet is expired');
  }
  add(findings, approval.executionApproval === false, 'approval-does-not-authorize-execution', 'option 4 approval packet must not authorize execution');
}

function validateRail(packet, findings) {
  const rail = packet.rail;
  if (!isPlainObject(rail)) {
    add(findings, false, 'rail-present', 'rail must be an object');
    return;
  }
  add(findings, true, 'rail-present');
  add(findings, ['ap2', 'x402', 'stripe', 'other'].includes(rail.provider), 'rail-provider-known', 'rail.provider must be ap2/x402/stripe/other');
  add(findings, rail.mode === APPROVAL_GATE_MODE, 'rail-mode-offline-approval-gate-only', `rail.mode must be ${APPROVAL_GATE_MODE}`);
  add(findings, rail.mainnetAllowed === false, 'mainnet-not-allowed', 'mainnetAllowed must be false');
  add(findings, rail.liveCallAllowed === false, 'live-call-not-allowed', 'liveCallAllowed must be false');
}

function validateCredentials(packet, findings) {
  const credentials = packet.credentials;
  if (!isPlainObject(credentials)) {
    add(findings, false, 'credentials-present', 'credentials must be an object');
    return;
  }
  add(findings, true, 'credentials-present');
  add(findings, hasText(credentials.credentialRef), 'credential-ref-present', 'credentials.credentialRef is required');
  add(findings, credentials.rawSecretPresent === false, 'raw-secret-not-present', 'rawSecretPresent must be false');
  add(findings, credentials.secretMaterialEmbedded === false, 'secret-material-not-embedded', 'secretMaterialEmbedded must be false');
}

function validateCanaryBounds(packet, findings) {
  const bounds = packet.canaryBounds;
  if (!isPlainObject(bounds)) {
    add(findings, false, 'canary-bounds-present', 'canaryBounds must be an object');
    return;
  }
  add(findings, true, 'canary-bounds-present');
  add(findings, bounds.executionAllowed === false, 'canary-execution-not-allowed', 'executionAllowed must be false for option 4');
  add(findings, bounds.maxAttempts === 0, 'canary-attempts-zero', 'maxAttempts must be 0 until rail-specific live approval');
  add(findings, bounds.maxAmount?.value === '0', 'canary-amount-zero', 'maxAmount.value must be "0" until rail-specific live approval');
  add(findings, hasText(bounds.maxAmount?.currency), 'canary-currency-present', 'maxAmount.currency is required');
  add(findings, bounds.windowSeconds === 0, 'canary-window-zero', 'windowSeconds must be 0 until rail-specific live approval');
  add(findings, bounds.testModeOrTestnetOnly === true, 'test-mode-or-testnet-only', 'testModeOrTestnetOnly must be true');
}

function validateRollback(packet, findings) {
  const rollback = packet.rollbackPlan;
  if (!isPlainObject(rollback)) {
    add(findings, false, 'rollback-plan-present', 'rollbackPlan must be an object');
    return;
  }
  add(findings, true, 'rollback-plan-present');
  add(findings, hasText(rollback.planRef), 'rollback-plan-ref-present', 'rollbackPlan.planRef is required');
  const steps = Array.isArray(rollback.steps) ? rollback.steps : [];
  add(findings, steps.length > 0, 'rollback-steps-present', 'rollbackPlan.steps are required');
  for (const required of REQUIRED_ROLLBACK_STEPS) {
    add(findings, steps.includes(required), `rollback-step-${required}`, `rollbackPlan.steps must include ${required}`);
  }
}

function validateRehearsal(packet, findings) {
  const rehearsal = packet.noLiveRehearsal;
  if (!isPlainObject(rehearsal)) {
    add(findings, false, 'no-live-rehearsal-present', 'noLiveRehearsal must be an object');
    return;
  }
  add(findings, true, 'no-live-rehearsal-present');
  add(findings, rehearsal.adapter === 'fake-no-live', 'fake-rehearsal-adapter-bound', 'noLiveRehearsal.adapter must be fake-no-live');
  add(findings, hasText(rehearsal.receiptRef), 'fake-rehearsal-receipt-ref-present', 'noLiveRehearsal.receiptRef is required');
  add(findings, rehearsal.deterministic === true, 'fake-rehearsal-deterministic', 'noLiveRehearsal.deterministic must be true');
}

export function validateCompletionLiveRailApprovalPacket(packet, options = {}) {
  const findings = [];
  if (!isPlainObject(packet)) {
    return { valid: false, findings: [{ ok: false, id: 'packet-object', detail: 'packet must be an object' }] };
  }
  add(findings, packet.schemaVersion === LIVE_RAIL_APPROVAL_PACKET_SCHEMA, 'schema-version', `schemaVersion must be ${LIVE_RAIL_APPROVAL_PACKET_SCHEMA}`);
  add(findings, packet.issue === 1393, 'issue-bound', 'packet.issue must be 1393');
  add(findings, packet.sourceOnly === true, 'source-only-true', 'sourceOnly must be true for option 4 approval-gate PR');
  add(findings, packet.noLive === true, 'no-live-true', 'noLive must be true for option 4 approval-gate PR');
  add(findings, packet.liveExecutionEnabled === false, 'live-execution-disabled', 'liveExecutionEnabled must be false');
  add(findings, hasText(packet.operatorChoiceRef), 'operator-choice-ref-present', 'operatorChoiceRef is required');
  validateSafetyFlags(packet, findings);
  validateApproval(packet, findings, options.now);
  validateRail(packet, findings);
  validateCredentials(packet, findings);
  validateCanaryBounds(packet, findings);
  validateRollback(packet, findings);
  validateRehearsal(packet, findings);
  for (const secretFinding of inspectForRawSecret(packet)) findings.push(secretFinding);
  const valid = findings.every((finding) => finding.ok === true);
  return { valid, findings };
}
