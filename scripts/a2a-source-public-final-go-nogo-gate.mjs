#!/usr/bin/env node
/**
 * A2A Nexus final go/no-go gate aggregator.
 *
 * Consumes the execution orchestrator's deterministic dry-run plan and aggregates
 * all gate evidence into a presentable final operator approval packet. Produces a
 * per-repo GO/NO-GO matrix, release candidate tagging readiness assessment, and
 * CI gate capsule.
 *
 * This command never executes approval, release publication, repository visibility
 * changes, live provider/Telegram sends, production deploys, Gateway/broker/worker
 * restarts, terminal ACKs, DB mutations, force-push, or community posts.
 *
 * Source-public execution remains NO_GO pending explicit operator approval.
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  BASE_FORBIDDEN_LIVE_FLAGS,
  buildGateResults,
  collectForbiddenLiveFlagFailures,
  collectRequiredGateBlockers,
  collectRequiredGateSpecFailures,
  collectSpecHeadFailures,
  deriveIdempotencyKey,
  findUnredactedEvidence,
  gateStatus,
  hasEvidence,
  hashKey,
  readJson,
  redactKey,
  runGateCli,
  unredactedReason,
} from './lib/source-public-gate-kit.mjs';

const { values } = parseArgs({
  options: {
    spec: { type: 'string', default: 'docs/final-approval/source-public-final-go-nogo-gate-schema.json' },
    orchestrator: { type: 'string' },
    input: { type: 'string' },
    format: { type: 'string', default: 'json' },
    mode: { type: 'string', default: 'dry-run' },
  },
});

const mandatoryGoGates = [
  'orchestratorPlanBinding',
  'aggregatedGateMatrix',
  'releaseCandidateTagging',
  'ciGateCapsule',
  'operatorApprovalPacket',
  'scannerHistoryBinding',
  'idempotencyReplayProtection',
  'rollbackAbortRunbook',
  'runtimeBootstrapHygiene',
  'redactedEvidencePolicy',
  'publicPrivateBoundary',
  'crossLaneEvidenceBinding',
];

/**
 * Validate the final go/no-go gate schema itself is fail-closed.
 */
function validateSpec(spec) {
  const failures = collectSpecHeadFailures(spec, {
    decisionOutputs: ['GO', 'NO_GO', 'BLOCKED'],
    defaultDecision: 'NO_GO',
  });
  if (spec.sourcePublicExecution !== 'NO_GO') failures.push('spec.sourcePublicExecution must be NO_GO');
  failures.push(...collectRequiredGateSpecFailures(spec, mandatoryGoGates));
  failures.push(...collectForbiddenLiveFlagFailures(spec, BASE_FORBIDDEN_LIVE_FLAGS));
  return failures;
}

/**
 * Validate the orchestrator plan binding.
 */
function validateOrchestratorPlanBinding(orchestratorReport) {
  if (!orchestratorReport) {
    return { ok: false, reason: 'orchestrator report is missing' };
  }
  const blockers = [];
  if (!orchestratorReport.executionPlan) blockers.push('no execution plan in orchestrator report');
  if (orchestratorReport.decision === 'NO_GO') blockers.push('orchestrator decision is NO_GO');
  if (!['dry-run', 'simulate'].includes(orchestratorReport.executionPlan?.executionMode)) {
    blockers.push('orchestrator execution mode is not dry-run/simulate');
  }
  if (!orchestratorReport.executionPlan?.idempotencyKeyHash) blockers.push('missing idempotency key hash');
  return blockers.length > 0 ? { ok: false, reason: blockers.join('; ') } : { ok: true };
}

/**
 * Build the per-repo GO/NO-GO matrix from the round's lane definitions.
 */
function buildGateMatrix(spec, input) {
  const lanes = spec.roundLanes || {};
  const matrix = [];
  for (const [repo, laneInfo] of Object.entries(lanes)) {
    const laneStatus = input.laneStatuses?.[repo];
    matrix.push({
      repo,
      owner: laneInfo.owner,
      issue: laneInfo.issue,
      role: laneInfo.role,
      status: laneStatus?.status || 'PENDING',
      evidence: laneStatus?.evidence || null,
      timestamp: laneStatus?.timestamp || null,
    });
  }
  return matrix;
}

/**
 * Build the release candidate tagging assessment.
 */
function buildReleaseCandidateTagging(spec, orchestratorReport, commitSha) {
  const runId = spec.run;
  const planHash = orchestratorReport?.executionPlan?.idempotencyKeyHash || 'unbound';
  const tagName = `a2a-plane-rc-${runId.substring(0, 13)}-${planHash}`;
  const effectiveSha = (commitSha && commitSha !== 'unlocked') ? commitSha : null;
  return {
    ready: Boolean(effectiveSha && orchestratorReport),
    tagName,
    commitSha: effectiveSha || 'pending',
    namingScheme: 'a2a-plane-rc-{runShort}-{planHashShort}',
    planId: orchestratorReport?.executionPlan?.idempotencyKeyHash || null,
    note: 'This is a release candidate tag only. It does not imply release publication, npm publish, Docker publish, or visibility change.',
  };
}

/**
 * Build the CI gate capsule.
 */
function buildCiGateCapsule(spec, input) {
  const checks = [
    { name: 'build', status: input.ciStatus?.build || 'PENDING' },
    { name: 'test', status: input.ciStatus?.test || 'PENDING' },
    { name: 'lint', status: input.ciStatus?.lint || 'PENDING' },
    { name: 'scanner', status: input.ciStatus?.scanner || 'PENDING' },
    { name: 'conformance', status: input.ciStatus?.conformance || 'PENDING' },
  ];
  const allPassed = checks.every((c) => c.status === 'PASS');
  return {
    ready: allPassed,
    ciRunId: input.ciStatus?.runId || null,
    checks,
    note: 'CI gate does not mutate production state, deploy, restart, or send provider messages.',
  };
}

/**
 * Build the final operator approval packet.
 */
function buildOperatorApprovalPacket(spec, orchestratorReport, gateMatrix, rcTagging, ciCapsule, idempotencyKey, input) {
  const gateStatuses = input?.gates && typeof input.gates === 'object' ? input.gates : {};
  const blockedGates = [];
  const readyGates = [];

  for (const id of spec.goDecisionRequires || []) {
    const gate = gateStatuses[id];
    const status = gateStatus(gate);
    if (status === 'GO' && hasEvidence(gate)) {
      readyGates.push(id);
    } else {
      blockedGates.push({ id, status });
    }
  }

  // Evaluate cross-lane gate matrix
  const crossLaneOk = (input?.crossLaneEvidence || []).length >= 1;

  const packetId = `a2a-final-approval-${spec.run}-${idempotencyKey.substring(0, 8)}`;
  const manifestDigest = hashKey(
    `${packetId}|${orchestratorReport?.executionPlan?.idempotencyKeyHash || ''}|${JSON.stringify(gateMatrix)}|${rcTagging.tagName}|${ciCapsule.ciRunId || ''}`,
  );

  return {
    packetId,
    manifestDigest,
    summary: {
      totalGates: (spec.goDecisionRequires || []).length,
      readyGates: readyGates.length,
      blockedGates: blockedGates.length,
      crossLaneEvidenceCount: (input?.crossLaneEvidence || []).length,
      crossLaneOk,
    },
    orchestratorPlanBinding: {
      planId: orchestratorReport?.executionPlan?.idempotencyKeyHash || null,
      decision: orchestratorReport?.decision || null,
      executionMode: orchestratorReport?.executionPlan?.executionMode || null,
    },
    gateMatrix,
    releaseCandidateTagging: rcTagging,
    ciGateCapsule: ciCapsule,
    blockedGateDetails: blockedGates,
    idempotencyKey: redactKey(idempotencyKey),
    idempotencyKeyHash: hashKey(idempotencyKey),
    operatorApprovalRequired: true,
    note: 'This packet is evidence only. Operator approval is a separate explicit action. No execution, release, or visibility change is implied.',
  };
}

/**
 * Evaluate all gates and compute the final decision.
 */
function evaluateGates(spec, orchestratorReport, input) {
  const blockers = [];
  const gateStatuses = input.gates && typeof input.gates === 'object' ? input.gates : {};

  // Validate orchestrator plan binding first
  const orchestratorOk = validateOrchestratorPlanBinding(orchestratorReport);
  if (!orchestratorOk.ok) {
    blockers.push({ gate: 'orchestratorPlanBinding', reason: orchestratorOk.reason });
  }

  // Evaluate each required gate (gate-level status/evidence only; no domain validation)
  blockers.push(...collectRequiredGateBlockers(spec, gateStatuses));

  // Redaction checks
  for (const { gateId, kind } of findUnredactedEvidence(gateStatuses)) {
    blockers.push({ gate: gateId, reason: unredactedReason(kind) });
  }

  // Cross-lane evidence check
  const crossLaneOk = (input?.crossLaneEvidence || []).length >= 1;
  if (!crossLaneOk) {
    blockers.push({ gate: 'crossLaneEvidenceBinding', reason: 'cross-lane evidence is missing or incomplete' });
  }

  let decision = 'NO_GO';
  if (blockers.length === 0) {
    decision = 'GO';
  } else if (blockers.some((b) => b.reason && b.reason.includes('not redacted'))) {
    decision = 'BLOCKED';
  }

  return {
    ok: decision === 'GO',
    decision,
    blockers,
    sourcePublicExecution: 'NO_GO',
  };
}

/**
 * Build the full final go/no-go gate report.
 */
export function buildFinalGoNoGoReport(spec, input, orchestratorReport) {
  const commitSha = input.commitSha || orchestratorReport?.executionPlan?.scannerBinding?.commitSha || 'unlocked';
  const orchestratorPlanId = orchestratorReport?.executionPlan?.idempotencyKeyHash || '';

  const idempotencyKey = deriveIdempotencyKey('a2a-final-gate', spec.run, spec.lane, orchestratorPlanId || 'unbound');
  const gateMatrix = buildGateMatrix(spec, input);
  const rcTagging = buildReleaseCandidateTagging(spec, orchestratorReport, commitSha);
  const ciCapsule = buildCiGateCapsule(spec, input);
  const approvalPacket = buildOperatorApprovalPacket(spec, orchestratorReport, gateMatrix, rcTagging, ciCapsule, idempotencyKey, input);
  const result = evaluateGates(spec, orchestratorReport, input);
  const gateResults = buildGateResults(spec, input.gates);

  return {
    kind: 'a2a.source-public-final-go-nogo-gate-report',
    run: spec.run,
    lane: spec.lane,
    issue: spec.issue,
    parentIssue: spec.parentIssue,
    failClosed: spec.failClosed,
    defaultDecision: spec.defaultDecision,
    decision: result.decision,
    sourcePublicExecution: result.sourcePublicExecution,
    ok: result.ok,
    approvalPacket,
    gateResults,
    blockers: result.blockers,
    requiredGates: spec.goDecisionRequires,
    orchestratorDecision: orchestratorReport?.decision || null,
    orchestratorPlanBinding: orchestratorReport?.executionPlan?.idempotencyKeyHash || null,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Render a deterministic Markdown report.
 */
export function renderFinalGoNoGoMarkdown(report) {
  const decisionLabel = {
    GO: '✅ GO: Final go/no-go gate passed. Approval packet ready for operator review.',
    NO_GO: '❌ NO_GO: Final go/no-go gate failed. Unresolved gates remain.',
    BLOCKED: '🛑 BLOCKED: Final go/no-go gate blocked. Evidence violations detected.',
  };
  const label = decisionLabel[report.decision] || `Decision: ${report.decision}`;

  const lines = [
    `# A2A Nexus final go/no-go gate report`,
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
    `Orchestrator binding: ${report.orchestratorDecision || 'not bound'} (plan: ${report.orchestratorPlanBinding || 'N/A'})`,
    '',
  ];

  // Approval packet summary
  if (report.approvalPacket) {
    const p = report.approvalPacket;
    lines.push(
      '## Final Operator Approval Packet',
      '',
      `Packet ID: \`${p.packetId}\``,
      `Manifest digest: \`${p.manifestDigest}\``,
      '',
      '### Summary',
      `- Total gates: ${p.summary.totalGates}`,
      `- Ready: ${p.summary.readyGates}`,
      `- Blocked: ${p.summary.blockedGates}`,
      `- Cross-lane evidence links: ${p.summary.crossLaneEvidenceCount}`,
      `- Cross-lane ok: ${p.summary.crossLaneOk ? '✅' : '❌'}`,
      '',
      '### Per-Repo GO/NO-GO Matrix',
      '',
      '| Repo | Owner | Status | Evidence |',
      '|------|-------|--------|----------|',
      ...p.gateMatrix.map((lane) =>
        `| ${lane.repo} | ${lane.owner} | ${lane.status} | ${lane.evidence || 'pending'} |`,
      ),
      '',
      '### Release Candidate Tagging',
      `- Ready: ${p.releaseCandidateTagging.ready ? '✅' : '❌'}`,
      `- Tag: \`${p.releaseCandidateTagging.tagName}\``,
      `- Commit: \`${p.releaseCandidateTagging.commitSha}\``,
      '',
      '### CI Gate Capsule',
      `- Ready: ${p.ciGateCapsule.ready ? '✅' : '❌'}`,
      ...p.ciGateCapsule.checks.map((c) => `  - ${c.name}: ${c.status}`),
      '',
    );
  }

  // Gate status
  lines.push('## Gate Status', '',
    '| Gate | Status | Evidence |',
    '|------|--------|----------|',
    ...report.gateResults.map((g) => `| ${g.title} | ${g.ok ? '✅ GO' : '❌ ' + g.status} | ${g.evidenceCount} link(s) |`),
    '',
  );

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
    'This is a **dry-run/simulate final gate round only**. No approval, release, visibility change,',
    'live provider send, deploy, Gateway restart, Telegram send, DB mutation,',
    'release candidate publication, or CI mutation was performed.',
    '',
    'Source-public execution remains **NO_GO** without explicit operator approval.',
    'The final approval packet is evidence only and does not authorize execution.',
    '',
    `Generated: ${report.timestamp}`,
    '',
  );

  return lines.join('\n');
}

runGateCli({
  values,
  validateSpec,
  rejectMode: (spec, opts) => {
    const requestedMode = opts.mode || 'dry-run';
    if (spec.allowedModes.includes(requestedMode)) return null;
    return `unsupported mode: ${requestedMode}. Allowed modes: ${spec.allowedModes.join(', ')}`;
  },
  hasInput: (opts) => Boolean(opts.orchestrator || opts.input),
  specOnlyPayload: (spec, opts) => ({
    ok: true,
    phase: 'spec',
    decision: spec.defaultDecision,
    decisionOutputs: spec.decisionOutputs,
    sourcePublicExecution: spec.sourcePublicExecution,
    mode: opts.mode || 'dry-run',
    requiredGates: spec.goDecisionRequires,
  }),
  loadInputs: (opts) => {
    let orchestratorReport = null;
    if (opts.orchestrator) {
      orchestratorReport = readJson(path.resolve(opts.orchestrator));
    }

    let input = { gates: {} };
    if (opts.input) {
      input = readJson(path.resolve(opts.input));
    }

    return [input, orchestratorReport];
  },
  buildReport: buildFinalGoNoGoReport,
  renderMarkdown: renderFinalGoNoGoMarkdown,
});
