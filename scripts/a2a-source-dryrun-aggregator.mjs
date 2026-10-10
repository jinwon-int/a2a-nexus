#!/usr/bin/env node
/**
 * A2A Nexus source-public dry-run aggregator and report command.
 *
 * Read-only by design: consumes evidence packet metadata for broker, plugin,
 * and runner, produces deterministic GO/NO-GO JSON/Markdown output, and keeps
 * source-public execution NO-GO without explicit operator approval.
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
  findOperatorEvidenceOverlap,
  findUnredactedEvidence,
  runGateCli,
  unredactedReason,
  validateReadinessGate,
} from './lib/source-public-gate-kit.mjs';

const { values } = parseArgs({
  options: {
    spec: { type: 'string', default: 'docs/dry-run/source-public-dryrun-schema.json' },
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
];

/** Dry-run wording for the shared readiness validators. */
const readinessOptions = { pluginContextSuffix: ' for dry-run' };

/**
 * Validate the dry-run schema itself is fail-closed with all required gates.
 */
function validateSpec(spec) {
  return [
    ...collectSpecHeadFailures(spec, { defaultDecision: 'NO-GO' }),
    ...collectRequiredGateSpecFailures(spec, mandatoryGoGates),
  ];
}

/**
 * Full gate-level evaluation against the input evidence packet.
 */
function evaluateInput(spec, input) {
  const gateStatuses = input.gates && typeof input.gates === 'object' ? input.gates : {};
  const decision = String(input.decision || spec.defaultDecision || 'NO-GO').toUpperCase();

  // Evaluate each required gate (with domain-specific deep validation when GO)
  const blockers = collectRequiredGateBlockers(spec, gateStatuses, {
    validateDomain: (id, evidencePacket) => validateReadinessGate(id, evidencePacket, readinessOptions),
  });

  // GO decision redaction and separation checks
  if (decision === 'GO') {
    // Redaction check: scan evidence text for unredacted material
    for (const { gateId, kind } of findUnredactedEvidence(gateStatuses)) {
      blockers.push({ gate: gateId, status: 'GO', reason: unredactedReason(kind) });
    }

    // Operator approval separation check
    const operatorEvidence = collectOperatorEvidence(gateStatuses.operatorApproval);
    if (operatorEvidence.size === 0) {
      blockers.push({ gate: 'operatorApproval', status: 'GO', reason: 'separate operator approval evidence is required for source-public execution' });
    } else {
      for (const { gateId } of findOperatorEvidenceOverlap(gateStatuses, 'operatorApproval', operatorEvidence)) {
        blockers.push({ gate: gateId, status: 'GO', reason: `operator approval evidence must be separate from ${gateId}` });
      }
    }
  }

  // Source-public execution is NO-GO without explicit operator approval
  if (decision === 'GO' && blockers.length) {
    return { ok: false, decision: 'NO-GO', originalDecision: 'GO', blockers, sourcePublicExecution: 'NO-GO' };
  }
  return {
    ok: true,
    decision,
    blockers,
    sourcePublicExecution: decision === 'GO' ? 'GO' : 'NO-GO',
  };
}

/**
 * Build the full dry-run report with all validation results.
 */
export function buildDryRunReport(spec, input) {
  const gateStatuses = input.gates && typeof input.gates === 'object' ? input.gates : {};
  const gateResults = buildGateResults(spec, gateStatuses);
  const result = evaluateInput(spec, input);

  return {
    kind: 'a2a.source-public-dryrun-report',
    run: spec.run,
    lane: spec.lane,
    issue: spec.issue,
    parentIssue: spec.parentIssue,
    failClosed: spec.failClosed,
    defaultDecision: spec.defaultDecision,
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
export function renderDryRunMarkdown(report) {
  const title = report.decision === 'GO' ? 'Done' : 'Block';
  const lines = [
    `${title}: A2A Nexus source-public dry-run report`,
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
    'Source-public execution remains **NO-GO** without explicit operator approval.',
    'This report is read-only: no deploy, Gateway restart, Telegram send, DB mutation, or terminal ACK is performed.',
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
    sourcePublicExecution: 'NO-GO',
    requiredGates: spec.goDecisionRequires,
  }),
  buildReport: buildDryRunReport,
  renderMarkdown: renderDryRunMarkdown,
});
