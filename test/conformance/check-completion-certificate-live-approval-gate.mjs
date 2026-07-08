#!/usr/bin/env node
// Conformance check: completion-certificate live rail approval-gate packet (#1393 option 4).
//
// This check validates only the source-only approval gate that must precede any
// future rail-specific live integration. It performs no payment rail calls,
// provider sends, DB/outbox/ACK/replay mutation, deploy/restart, package
// publication, or secret movement.

import assert from 'node:assert/strict';

import {
  APPROVAL_GATE_MODE,
  REQUIRED_FALSE_SAFETY_FLAGS,
  validateCompletionLiveRailApprovalPacket,
} from '../../scripts/lib/completion-certificate-live-approval-gate.mjs';

const NOW = '2026-07-09T00:00:00Z';

function validPacket(patch = {}) {
  const packet = {
    schemaVersion: 'a2a.completion.liveRailApprovalPacket.v0',
    issue: 1393,
    sourceOnly: true,
    noLive: true,
    liveExecutionEnabled: false,
    operatorChoiceRef: 'issue-comment:#1393:option-4-approval-gate-pr-only',
    safety: {
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
    },
    approval: {
      approvalRef: 'issue-comment:#1393:option-4',
      approvedBy: 'Seo Jin On',
      approvedAt: '2026-07-08T15:25:00Z',
      expiresAt: '2026-07-15T15:25:00Z',
      executionApproval: false,
    },
    rail: {
      provider: 'stripe',
      mode: APPROVAL_GATE_MODE,
      mainnetAllowed: false,
      liveCallAllowed: false,
    },
    credentials: {
      credentialRef: 'vault-ref://payment-rails/stripe/test-mode/operator-approved-future-ref',
      rawSecretPresent: false,
      secretMaterialEmbedded: false,
    },
    canaryBounds: {
      executionAllowed: false,
      maxAttempts: 0,
      maxAmount: { currency: 'TESTUSD', value: '0' },
      windowSeconds: 0,
      testModeOrTestnetOnly: true,
    },
    rollbackPlan: {
      planRef: 'runbook-ref://a2a/completion-certificate/live-rail-rollback-v0',
      steps: [
        'revoke-credentials',
        'disable-adapter',
        'halt-canary',
        'verify-no-db-outbox-ack-replay',
      ],
    },
    noLiveRehearsal: {
      adapter: 'fake-no-live',
      receiptRef: 'fake-no-live:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      deterministic: true,
    },
  };
  return deepMerge(packet, patch);
}

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
  const result = validateCompletionLiveRailApprovalPacket(validPacket(patch), { now: NOW });
  assert.equal(result.valid, false, `packet should be invalid for ${expectedFinding}`);
  assert.ok(result.findings.some((finding) => finding.id === expectedFinding && finding.ok === false), `missing finding ${expectedFinding}`);
}

const ok = validateCompletionLiveRailApprovalPacket(validPacket(), { now: NOW });
assert.equal(ok.valid, true, JSON.stringify(ok.findings.filter((finding) => !finding.ok), null, 2));
for (const flag of REQUIRED_FALSE_SAFETY_FLAGS) {
  assert.ok(ok.findings.some((finding) => finding.id === `safety-${flag}-false` && finding.ok === true), `${flag} must be asserted`);
}

assertInvalid({ liveExecutionEnabled: true }, 'live-execution-disabled');
assertInvalid({ safety: { paymentRailCall: true } }, 'safety-paymentRailCall-false');
assertInvalid({ safety: { fundsMovement: true } }, 'safety-fundsMovement-false');
assertInvalid({ safety: { databaseMutation: true } }, 'safety-databaseMutation-false');
assertInvalid({ approval: { executionApproval: true } }, 'approval-does-not-authorize-execution');
assertInvalid({ approval: { approvedAt: '2026-07-08T15:25:00Z', expiresAt: '2026-08-01T15:25:00Z' } }, 'approval-window-bounded');
assertInvalid({ approval: { expiresAt: '2026-07-08T15:26:00Z' } }, 'approval-not-expired');
assertInvalid({ rail: { mode: 'test-mode' } }, 'rail-mode-offline-approval-gate-only');
assertInvalid({ rail: { mainnetAllowed: true } }, 'mainnet-not-allowed');
assertInvalid({ rail: { liveCallAllowed: true } }, 'live-call-not-allowed');
assertInvalid({ credentials: { rawSecretPresent: true } }, 'raw-secret-not-present');
assertInvalid({ credentials: { secretMaterialEmbedded: true } }, 'secret-material-not-embedded');
const syntheticStripeLikeToken = `sk_${'test'}_${'a'.repeat(24)}`;
assertInvalid({ credentials: { credentialRef: syntheticStripeLikeToken } }, 'raw-secret-forbidden');
assertInvalid({ canaryBounds: { executionAllowed: true } }, 'canary-execution-not-allowed');
assertInvalid({ canaryBounds: { maxAttempts: 1 } }, 'canary-attempts-zero');
assertInvalid({ canaryBounds: { maxAmount: { currency: 'TESTUSD', value: '1' } } }, 'canary-amount-zero');
assertInvalid({ rollbackPlan: { steps: ['revoke-credentials', 'disable-adapter', 'halt-canary'] } }, 'rollback-step-verify-no-db-outbox-ack-replay');
assertInvalid({ noLiveRehearsal: { adapter: 'live-stripe' } }, 'fake-rehearsal-adapter-bound');
assertInvalid({ noLiveRehearsal: { deterministic: false } }, 'fake-rehearsal-deterministic');

console.log('✅ completion-certificate live rail approval gate: source-only packet, no-live safety, approval freshness, rollback, canary, secret, and fake rehearsal checks passed');
