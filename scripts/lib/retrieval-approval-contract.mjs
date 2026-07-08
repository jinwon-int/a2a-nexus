/**
 * Source-only K2 retrieval allowlist/approval contract validator (#1374).
 *
 * This validator checks the non-executable approval packet that must exist
 * before a future docker-runner egress proxy/GitHub-read fetch path can be
 * enabled. It intentionally performs no network fetch, no proxy enablement, no
 * broker/docker-runner deploy or restart, no DB/outbox/ACK/replay mutation, and
 * no secret or signing-key movement.
 */

export const RETRIEVAL_APPROVAL_PACKET_SCHEMA = 'a2a.retrieval.approvalPacket.v0';
export const RETRIEVAL_SOURCE_GITHUB = 'github';
export const EGRESS_MODE_DENY_BY_DEFAULT = 'deny-by-default';
export const GITHUB_READ_ONLY_MODE = 'github-read-only';
export const UNTRUSTED_EXTERNAL_DATA_TAG = 'untrusted_external_data';

export const REQUIRED_FALSE_SAFETY_FLAGS = Object.freeze([
  'liveFetchPerformed',
  'egressProxyEnabled',
  'networkPolicyChanged',
  'databaseMutation',
  'terminalAckReplay',
  'deployOrRestart',
  'providerSend',
  'signingKeyMovement',
  'rawSecretMaterial',
]);

export const REQUIRED_TRUE_EGRESS_GUARDS = Object.freeze([
  'requireHttps',
  'blockLoopback',
  'blockPrivateNetworks',
  'blockLinkLocal',
  'blockImds',
  'blockRedirectToPrivate',
  'blockDnsRebind',
  'logEveryRequest',
  'captureResponseHash',
]);

const MAX_PATHS = 32;
const MAX_TOTAL_BYTES = 1_048_576;
const SHA_REF = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ABSOLUTE_OR_DOTDOT = /(?:^\/|^~|(?:^|\/)\.\.(?:\/|$)|\\)/;
const SECRET_LIKE = /(?:ghp_|github_pat_|xox[baprs]-|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~+/-]{20,}|api[_-]?key\s*[:=])/i;

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function add(findings, ok, id, detail) {
  findings.push({ ok, id, ...(detail ? { detail } : {}) });
}

function isIsoTimestamp(value) {
  return hasText(value) && Number.isFinite(Date.parse(value));
}

function inspectForRawSecret(value, path = '$', findings = []) {
  if (typeof value === 'string') {
    if (SECRET_LIKE.test(value)) {
      findings.push({ ok: false, id: 'raw-secret-forbidden', detail: `${path} contains secret-like material` });
    }
    return findings;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectForRawSecret(item, `${path}[${index}]`, findings));
    return findings;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) inspectForRawSecret(item, `${path}.${key}`, findings);
  }
  return findings;
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
  add(findings, isIsoTimestamp(approval.approvedAt), 'approved-at-iso', 'approval.approvedAt must be ISO timestamp');
  add(findings, isIsoTimestamp(approval.expiresAt), 'approval-expiry-iso', 'approval.expiresAt must be ISO timestamp');
  add(findings, approval.executionApproval === false, 'approval-does-not-authorize-execution', 'source-only K2 packet must not authorize live execution');
  if (isIsoTimestamp(approval.approvedAt) && isIsoTimestamp(approval.expiresAt)) {
    const approvedAt = Date.parse(approval.approvedAt);
    const expiresAt = Date.parse(approval.expiresAt);
    add(findings, expiresAt > approvedAt, 'approval-expiry-after-approved-at', 'expiresAt must be after approvedAt');
    add(findings, expiresAt - approvedAt <= 14 * 24 * 60 * 60 * 1000, 'approval-window-bounded', 'approval window must be <=14 days');
    if (now) add(findings, Date.parse(now) < expiresAt, 'approval-not-expired', 'approval packet is expired');
  }
}

function validateRetrievalRequest(packet, findings) {
  const request = packet.retrievalRequest;
  if (!isPlainObject(request)) {
    add(findings, false, 'retrieval-request-present', 'retrievalRequest must be an object');
    return;
  }
  add(findings, true, 'retrieval-request-present');
  add(findings, request.source === RETRIEVAL_SOURCE_GITHUB, 'source-github-only', 'v1 source must be github');
  add(findings, typeof request.repo === 'string' && REPO.test(request.repo), 'repo-owner-name', 'repo must be owner/name');
  add(findings, typeof request.ref === 'string' && SHA_REF.test(request.ref), 'ref-sha-only', 'ref must be a 40- or 64-char lowercase SHA');
  add(findings, request.ref === request.resolvedRef, 'requested-ref-resolved-ref-match', 'requested ref must already be the resolved immutable ref');
  add(findings, request.symbolicRefAllowed === false, 'symbolic-ref-forbidden', 'symbolic refs such as main/master/tags are forbidden');
  const paths = Array.isArray(request.paths) ? request.paths : [];
  add(findings, paths.length > 0, 'paths-present', 'paths must be non-empty');
  add(findings, paths.length <= MAX_PATHS, 'paths-within-count-budget', `paths must be <=${MAX_PATHS}`);
  for (const path of paths) {
    add(findings, hasText(path) && !ABSOLUTE_OR_DOTDOT.test(path), 'path-safe-relative', `unsafe path ${JSON.stringify(path)}`);
  }
  const budget = request.byteBudget;
  if (!isPlainObject(budget)) {
    add(findings, false, 'byte-budget-present', 'byteBudget must be an object');
  } else {
    add(findings, true, 'byte-budget-present');
    add(findings, Number.isInteger(budget.maxTotalBytes) && budget.maxTotalBytes > 0 && budget.maxTotalBytes <= MAX_TOTAL_BYTES, 'byte-budget-total-bounded', `maxTotalBytes must be 1..${MAX_TOTAL_BYTES}`);
    add(findings, Number.isInteger(budget.maxFileBytes) && budget.maxFileBytes > 0 && budget.maxFileBytes <= MAX_TOTAL_BYTES, 'byte-budget-file-bounded', `maxFileBytes must be 1..${MAX_TOTAL_BYTES}`);
  }
}

function validateEgressPolicy(packet, findings) {
  const policy = packet.egressPolicy;
  if (!isPlainObject(policy)) {
    add(findings, false, 'egress-policy-present', 'egressPolicy must be an object');
    return;
  }
  add(findings, true, 'egress-policy-present');
  add(findings, policy.mode === EGRESS_MODE_DENY_BY_DEFAULT, 'egress-deny-by-default', `egressPolicy.mode must be ${EGRESS_MODE_DENY_BY_DEFAULT}`);
  add(findings, policy.profile === GITHUB_READ_ONLY_MODE, 'egress-github-read-only', `egressPolicy.profile must be ${GITHUB_READ_ONLY_MODE}`);
  const hosts = Array.isArray(policy.allowedHosts) ? policy.allowedHosts : [];
  add(findings, hosts.length > 0, 'egress-hosts-present', 'allowedHosts must be non-empty');
  add(findings, hosts.every((host) => host === 'api.github.com'), 'egress-hosts-github-api-only', 'v1 allowedHosts must contain only api.github.com');
  const guards = policy.guards;
  if (!isPlainObject(guards)) {
    add(findings, false, 'egress-guards-present', 'egressPolicy.guards must be an object');
  } else {
    add(findings, true, 'egress-guards-present');
    for (const guard of REQUIRED_TRUE_EGRESS_GUARDS) {
      add(findings, guards[guard] === true, `egress-guard-${guard}`, `${guard} must be true`);
    }
  }
}

function validateSnapshotContract(packet, findings) {
  const contract = packet.snapshotContract;
  if (!isPlainObject(contract)) {
    add(findings, false, 'snapshot-contract-present', 'snapshotContract must be an object');
    return;
  }
  add(findings, true, 'snapshot-contract-present');
  add(findings, contract.schemaVersion === 'a2a.retrieval.snapshot.v1', 'snapshot-schema-v1', 'snapshot schema must be a2a.retrieval.snapshot.v1');
  add(findings, contract.signWholeTuple === true, 'snapshot-signs-whole-tuple', 'snapshot must sign metadata and content together');
  add(findings, contract.requireContentHash === true, 'snapshot-content-hash-required', 'snapshot contentHash is required');
  add(findings, contract.requireByteLen === true, 'snapshot-byte-len-required', 'snapshot byteLen is required');
  add(findings, contract.analysisNetworkAccess === false, 'analysis-network-access-forbidden', 'analysis lane must not receive network access');
  add(findings, contract.sourceCarrierEnvelope === UNTRUSTED_EXTERNAL_DATA_TAG, 'untrusted-envelope-required', `source carrier envelope must be ${UNTRUSTED_EXTERNAL_DATA_TAG}`);
  add(findings, contract.contentHashCitationRequired === true, 'content-hash-citation-required', 'analysis citations must cite contentHash');
  add(findings, contract.redactionRequired === true, 'redaction-required', 'captured content must pass redaction path');
}

function validateSafety(packet, findings) {
  const safety = packet.safety;
  if (!isPlainObject(safety)) {
    add(findings, false, 'safety-present', 'safety must be an object');
    return;
  }
  add(findings, true, 'safety-present');
  for (const flag of REQUIRED_FALSE_SAFETY_FLAGS) {
    add(findings, safety[flag] === false, `safety-${flag}-false`, `${flag} must be explicit false`);
  }
  add(findings, safety.futureLiveActivationRequiresFreshApproval === true, 'future-activation-requires-fresh-approval', 'future live/proxy activation must require fresh approval');
}

export function validateRetrievalApprovalPacket(packet, options = {}) {
  const findings = [];
  if (!isPlainObject(packet)) {
    return { valid: false, findings: [{ ok: false, id: 'packet-object', detail: 'packet must be an object' }] };
  }
  add(findings, packet.schemaVersion === RETRIEVAL_APPROVAL_PACKET_SCHEMA, 'schema-version', `schemaVersion must be ${RETRIEVAL_APPROVAL_PACKET_SCHEMA}`);
  add(findings, packet.issue === 1374, 'issue-bound', 'packet.issue must be 1374');
  add(findings, packet.sourceOnly === true, 'source-only-true', 'sourceOnly must be true');
  add(findings, packet.noLive === true, 'no-live-true', 'noLive must be true');
  add(findings, packet.liveRetrievalEnabled === false, 'live-retrieval-disabled', 'liveRetrievalEnabled must be false');
  add(findings, hasText(packet.operatorChoiceRef), 'operator-choice-ref-present', 'operatorChoiceRef is required');
  validateApproval(packet, findings, options.now);
  validateRetrievalRequest(packet, findings);
  validateEgressPolicy(packet, findings);
  validateSnapshotContract(packet, findings);
  validateSafety(packet, findings);
  for (const secretFinding of inspectForRawSecret(packet)) findings.push(secretFinding);
  return { valid: findings.every((finding) => finding.ok === true), findings };
}
