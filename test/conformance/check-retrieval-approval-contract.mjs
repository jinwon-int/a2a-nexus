#!/usr/bin/env node
// Conformance check: K2 retrieval allowlist/approval contract (#1374).
//
// This check validates the source-only contract packet that precedes any future
// docker-runner egress proxy or GitHub-read fetch activation. It performs no
// network fetch, no proxy enablement, no deploy/restart, no DB/outbox/ACK/replay
// mutation, and no secret/signing-key movement.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  REQUIRED_FALSE_SAFETY_FLAGS,
  REQUIRED_TRUE_EGRESS_GUARDS,
  validateRetrievalApprovalPacket,
} from '../../scripts/lib/retrieval-approval-contract.mjs';

const NOW = '2026-07-09T00:00:00.000Z';
const fixture = JSON.parse(readFileSync('fixtures/contract/retrieval-approval-contract.json', 'utf8'));

function deepMerge(base, patch) {
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function assertInvalid(patch, expectedFinding) {
  const result = validateRetrievalApprovalPacket(deepMerge(fixture, patch), { now: NOW });
  assert.equal(result.valid, false, `packet should be invalid for ${expectedFinding}`);
  assert.ok(
    result.findings.some((finding) => finding.id === expectedFinding && finding.ok === false),
    `missing finding ${expectedFinding}: ${JSON.stringify(result.findings, null, 2)}`,
  );
}

const ok = validateRetrievalApprovalPacket(fixture, { now: NOW });
assert.equal(ok.valid, true, JSON.stringify(ok.findings.filter((finding) => !finding.ok), null, 2));
for (const flag of REQUIRED_FALSE_SAFETY_FLAGS) {
  assert.ok(ok.findings.some((finding) => finding.id === `safety-${flag}-false` && finding.ok === true), `${flag} must be asserted false`);
}
for (const guard of REQUIRED_TRUE_EGRESS_GUARDS) {
  assert.ok(ok.findings.some((finding) => finding.id === `egress-guard-${guard}` && finding.ok === true), `${guard} must be asserted true`);
}

// Execution / approval boundary.
assertInvalid({ liveRetrievalEnabled: true }, 'live-retrieval-disabled');
assertInvalid({ approval: { executionApproval: true } }, 'approval-does-not-authorize-execution');
assertInvalid({ approval: { expiresAt: '2026-08-01T16:03:24.000Z' } }, 'approval-window-bounded');
assertInvalid({ approval: { expiresAt: '2026-07-08T16:03:25.000Z' } }, 'approval-not-expired');

// GitHub-read request contract.
assertInvalid({ retrievalRequest: { source: 'web' } }, 'source-github-only');
assertInvalid({ retrievalRequest: { repo: 'not-a-repo' } }, 'repo-owner-name');
assertInvalid({ retrievalRequest: { ref: 'main', resolvedRef: 'main' } }, 'ref-sha-only');
assertInvalid({ retrievalRequest: { ref: '73c47399096fce9686edda8ed3ed97ba7f6a0424', resolvedRef: 'main' } }, 'requested-ref-resolved-ref-match');
assertInvalid({ retrievalRequest: { symbolicRefAllowed: true } }, 'symbolic-ref-forbidden');
assertInvalid({ retrievalRequest: { paths: [] } }, 'paths-present');
assertInvalid({ retrievalRequest: { paths: ['../secret.txt'] } }, 'path-safe-relative');
assertInvalid({ retrievalRequest: { paths: ['/etc/passwd'] } }, 'path-safe-relative');
assertInvalid({ retrievalRequest: { byteBudget: { maxFileBytes: 262144, maxTotalBytes: 2_000_000 } } }, 'byte-budget-total-bounded');

// Egress policy: deny-by-default, GitHub API only, internal network defenses.
assertInvalid({ egressPolicy: { mode: 'allow-all' } }, 'egress-deny-by-default');
assertInvalid({ egressPolicy: { profile: 'general-web' } }, 'egress-github-read-only');
assertInvalid({ egressPolicy: { allowedHosts: ['api.github.com', 'example.com'] } }, 'egress-hosts-github-api-only');
assertInvalid({ egressPolicy: { guards: { blockImds: false } } }, 'egress-guard-blockImds');
assertInvalid({ egressPolicy: { guards: { blockRedirectToPrivate: false } } }, 'egress-guard-blockRedirectToPrivate');
assertInvalid({ egressPolicy: { guards: { blockDnsRebind: false } } }, 'egress-guard-blockDnsRebind');

// Snapshot/source-carrier seam: signed tuple, untrusted envelope, no analysis network.
assertInvalid({ snapshotContract: { signWholeTuple: false } }, 'snapshot-signs-whole-tuple');
assertInvalid({ snapshotContract: { analysisNetworkAccess: true } }, 'analysis-network-access-forbidden');
assertInvalid({ snapshotContract: { sourceCarrierEnvelope: 'trusted_data' } }, 'untrusted-envelope-required');
assertInvalid({ snapshotContract: { contentHashCitationRequired: false } }, 'content-hash-citation-required');
assertInvalid({ snapshotContract: { redactionRequired: false } }, 'redaction-required');

// Safety flags and secret material.
assertInvalid({ safety: { liveFetchPerformed: true } }, 'safety-liveFetchPerformed-false');
assertInvalid({ safety: { egressProxyEnabled: true } }, 'safety-egressProxyEnabled-false');
assertInvalid({ safety: { networkPolicyChanged: true } }, 'safety-networkPolicyChanged-false');
assertInvalid({ safety: { signingKeyMovement: true } }, 'safety-signingKeyMovement-false');
assertInvalid({ safety: { futureLiveActivationRequiresFreshApproval: false } }, 'future-activation-requires-fresh-approval');
const syntheticToken = `ghp_${'a'.repeat(24)}`;
assertInvalid({ approval: { approvalRef: syntheticToken } }, 'raw-secret-forbidden');

console.log('✅ retrieval approval contract: SHA-only GitHub request, deny-by-default egress policy, no-live safety, untrusted envelope, rollback-to-fresh-approval, and secret denial checks passed');
