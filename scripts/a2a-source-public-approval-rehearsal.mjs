#!/usr/bin/env node
/**
 * A2A Nexus source-public approval rehearsal aggregator.
 *
 * Read-only by design: consumes evidence packet metadata for broker, plugin,
 * and runner, produces deterministic GO_CANDIDATE / NO_GO / NEEDS_OPERATOR_APPROVAL
 * decision output with integrated evidence bundles. Never executes approval,
 * release, or visibility changes.
 *
 * This command never deploys, restarts Gateway, sends Telegram, mutates the
 * broker DB, or ACKs terminal-outbox records.
 */
import { parseArgs } from 'node:util';
import {
  buildGateResults,
  collectOperatorEvidence,
  collectRequiredGateBlockers,
  collectRequiredGateSpecFailures,
  collectSpecHeadFailures,
  computeDecision,
  findOperatorEvidenceOverlap,
  findUnredactedEvidence,
  hasEvidence,
  runGateCli,
  unredactedReason,
  validateReadinessGate,
} from './lib/source-public-gate-kit.mjs';

const { values } = parseArgs({
  options: {
    spec: { type: 'string', default: 'docs/approval-rehearsal/source-public-approval-packet-schema.json' },
    input: { type: 'string' },
    format: { type: 'string', default: 'json' },
  },
});

const mandatoryGoGates = [
  'brokerReadiness',
  'pluginReadiness',
  'runnerReadiness',
  'publicPrivateBoundary',
  'terminalEvidence',
  'replaySafety',
  'externalScannerEvidence',
  'runtimeBootstrapHygiene',
  'goNoGoMatrix',
  'redactedEvidencePolicy',
  'operatorApproval',
  'approvalPacketIntegrity',
  'rehearsalIdempotencyProof',
  'rollbackAbortPath',
];

/** Approval-rehearsal wording for the shared readiness validators. */
const readinessOptions = { pluginContextSuffix: ' for approval rehearsal' };

/**
 * Validate the approval-rehearsal schema itself is fail-closed with all required gates.
 */
function validateSpec(spec) {
  return [
    ...collectSpecHeadFailures(spec, {
      decisionOutputs: ['GO_CANDIDATE', 'NO_GO', 'NEEDS_OPERATOR_APPROVAL'],
      defaultDecision: 'NO_GO',
    }),
    ...collectRequiredGateSpecFailures(spec, mandatoryGoGates),
  ];
}

/**
 * Validate approval-packet-integrity gate.
 */
function validateApprovalPacketIntegrity(gateStatuses, spec) {
  const blockers = [];
  for (const id of spec.goDecisionRequires || []) {
    const gate = gateStatuses[id];
    if (!gate || !hasEvidence(gate)) {
      blockers.push(`gate ${id}: missing or no evidence links`);
    }
  }
  if (blockers.length > 0) {
    return { ok: false, check: 'approvalPacketIntegrity', detail: blockers.join('; ') };
  }
  return { ok: true, check: 'approvalPacketIntegrity', detail: 'all required gates present with evidence bundles' };
}

/**
 * Full gate-level evaluation against the input evidence packet.
 */
function evaluateInput(spec, input) {
  const gateStatuses = input.gates && typeof input.gates === 'object' ? input.gates : {};
  const decision = computeDecision(gateStatuses, spec, 'operatorApproval');

  // Evaluate each required gate (with domain-specific deep validation when GO)
  const blockers = collectRequiredGateBlockers(spec, gateStatuses, {
    validateDomain: (id, evidencePacket) => validateReadinessGate(id, evidencePacket, readinessOptions),
  });

  // Approval packet integrity validation
  if (gateStatuses.approvalPacketIntegrity?.status === 'GO') {
    const integrityResult = validateApprovalPacketIntegrity(gateStatuses, spec);
    if (!integrityResult.ok) {
      blockers.push({ gate: 'approvalPacketIntegrity', status: 'GO', reason: integrityResult.detail });
    }
  }

  // Redaction checks on evidence text
  for (const { gateId, kind } of findUnredactedEvidence(gateStatuses)) {
    blockers.push({ gate: gateId, status: 'GO', reason: unredactedReason(kind) });
  }

  // Operator approval separation check
  const operatorEvidence = collectOperatorEvidence(gateStatuses.operatorApproval);
  if (decision === 'GO_CANDIDATE') {
    if (operatorEvidence.size === 0) {
      blockers.push({ gate: 'operatorApproval', reason: 'separate operator approval evidence is required' });
    } else {
      for (const { gateId } of findOperatorEvidenceOverlap(gateStatuses, 'operatorApproval', operatorEvidence)) {
        blockers.push({ gate: gateId, reason: `operator approval evidence must be separate from ${gateId}` });
      }
    }
  }

  // Safety: approval rehearsal never produces GO — always gated
  const safeDecision = decision === 'GO_CANDIDATE' && blockers.length > 0 ? 'NO_GO' : decision;
  return {
    ok: safeDecision !== 'NO_GO' || input.decision === 'NO_GO',
    decision: safeDecision,
    blockers,
    sourcePublicExecution: 'NO_GO',
  };
}

/**
 * Build the full approval rehearsal report.
 */
export function buildApprovalRehearsalReport(spec, input) {
  const gateStatuses = input.gates && typeof input.gates === 'object' ? input.gates : {};
  const gateResults = buildGateResults(spec, gateStatuses);
  const result = evaluateInput(spec, input);

  return {
    kind: 'a2a.source-public-approval-rehearsal-report',
    run: spec.run,
    lane: spec.lane,
    issue: spec.issue,
    parentIssue: spec.parentIssue,
    failClosed: spec.failClosed,
    defaultDecision: spec.defaultDecision,
    decisionOutputs: spec.decisionOutputs,
    decision: result.decision,
    sourcePublicExecution: result.sourcePublicExecution,
    ok: result.ok,
    gateResults,
    blockers: result.blockers,
    requiredGates: spec.goDecisionRequires,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Render a deterministic Markdown report.
 */
export function renderApprovalRehearsalMarkdown(report) {
  const decisionLabel = {
    GO_CANDIDATE: 'GO_CANDIDATE: Approval packet ready for operator review',
    NO_GO: 'NO_GO: Approval rehearsal failed',
    NEEDS_OPERATOR_APPROVAL: 'NEEDS_OPERATOR_APPROVAL: Rehearsal passed; operator sign-off required',
  };
  const label = decisionLabel[report.decision] || `Decision: ${report.decision}`;

  const lines = [
    `# A2A Nexus source-public approval rehearsal report`,
    '',
    `**${label}**`,
    '',
    `Run: ${report.run}`,
    `Lane: ${report.lane}`,
    `Issue: ${report.issue}`,
    `Parent: ${report.parentIssue}`,
    `Fail-closed: ${report.failClosed}`,
    `Default decision: ${report.defaultDecision}`,
    `Decision: ${report.decision}`,
    `Source-public execution: ${report.sourcePublicExecution}`,
    '',
    '## Gate status',
    '',
    '| Gate | Status | Evidence |',
    '|------|--------|----------|',
    ...report.gateResults.map((g) => `| ${g.title} | ${g.ok ? '✅ GO' : '❌ ' + g.status} | ${g.evidenceCount} link(s) |`),
    '',
  ];

  if (report.blockers.length > 0) {
    lines.push('## Blockers', '');
    for (const blocker of report.blockers) {
      lines.push(`- **${blocker.gate}**: ${blocker.reason}`);
    }
    lines.push('');
  }

  lines.push(
    '## Safety',
    '',
    'This is an **approval rehearsal round only**. No approval, release, visibility change,',
    'live provider send, deploy, Gateway restart, Telegram send, DB mutation, or terminal ACK was performed.',
    '',
    'Approval execution remains **NO_GO** without explicit operator approval.',
    'Decisions:',
    '- **GO_CANDIDATE** — All rehearsal gates pass; approval packet is ready for operator review.',
    '- **NO_GO** — One or more gates did not pass; evidence is insufficient.',
    '- **NEEDS_OPERATOR_APPROVAL** — Rehearsal passes; explicit operator sign-off required before any action.',
    '',
    `Generated: ${report.timestamp}`,
    '',
  );

  return lines.join('\n');
}

runGateCli({
  values,
  validateSpec,
  specOnlyPayload: (spec) => ({
    ok: true,
    phase: 'spec',
    decision: spec.defaultDecision,
    decisionOutputs: spec.decisionOutputs,
    sourcePublicExecution: 'NO_GO',
    requiredGates: spec.goDecisionRequires,
  }),
  buildReport: buildApprovalRehearsalReport,
  renderMarkdown: renderApprovalRehearsalMarkdown,
});
