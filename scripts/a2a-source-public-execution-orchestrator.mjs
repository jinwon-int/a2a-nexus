#!/usr/bin/env node
/**
 * A2A Nexus source-public execution orchestrator.
 *
 * Read-only by design: consumes an approved approval rehearsal evidence packet
 * and produces a deterministic, explicitly operator-gated execution plan with
 * dry-run/simulate mode, scanner/history binding, rollback/abort runbook,
 * idempotency/replay protection, and preflight failure semantics.
 *
 * This command never deploys, restarts Gateway, sends Telegram, mutates the
 * broker DB, ACKs terminal-outbox records, or executes approval/release/visibility
 * changes. Execution mode is locked to dry-run/simulate without explicit operator
 * approval.
 */
import { parseArgs } from 'node:util';
import {
  buildGateResults,
  collectRequiredGateBlockers,
  collectRequiredGateSpecFailures,
  collectSpecHeadFailures,
  computeDecision,
  deriveIdempotencyKey,
  findUnredactedEvidence,
  hasEvidence,
  hashKey,
  redactKey,
  runGateCli,
  unredactedReason,
  validateReadinessGate,
} from './lib/source-public-gate-kit.mjs';

const { values } = parseArgs({
  options: {
    spec: { type: 'string', default: 'docs/execution-orchestrator/source-public-execution-orchestrator-schema.json' },
    input: { type: 'string' },
    format: { type: 'string', default: 'json' },
    mode: { type: 'string', default: 'dry-run' },
  },
});

const mandatoryGoGates = [
  'approvalPacketLocked',
  'executionPlanIntegrity',
  'scannerHistoryBinding',
  'rollbackAbortRunbook',
  'idempotencyReplayProtection',
  'preflightFailureSemantics',
  'actionManifestDeterminism',
  'operatorExecutionGate',
  'crossBrokerHandoffEvidence',
  'brokerReadiness',
  'pluginReadiness',
  'runnerReadiness',
  'publicPrivateBoundary',
  'runtimeBootstrapHygiene',
  'redactedEvidencePolicy',
];

/** Orchestrator wording for the shared readiness validators (no plugin context suffix). */
const readinessOptions = {
  pluginContextSuffix: '',
  brokerPassedDetail: 'broker health, workers, queue/stale checks passed',
};

/**
 * Validate the execution-orchestrator schema itself is fail-closed.
 */
function validateSpec(spec) {
  const failures = collectSpecHeadFailures(spec, {
    decisionOutputs: ['GO_CANDIDATE', 'NO_GO', 'NEEDS_OPERATOR_APPROVAL'],
    defaultDecision: 'NO_GO',
  });
  if (!spec.executionModes || !Array.isArray(spec.executionModes)) {
    failures.push('spec.executionModes must be an array');
  } else {
    for (const mode of ['dry-run', 'simulate']) {
      if (!spec.executionModes.includes(mode)) failures.push(`spec.executionModes missing ${mode}`);
    }
  }
  if (spec.defaultExecutionMode !== 'dry-run') failures.push('spec.defaultExecutionMode must be dry-run');
  failures.push(...collectRequiredGateSpecFailures(spec, mandatoryGoGates));
  return failures;
}

/**
 * Build a deterministic execution plan from the input evidence packet.
 *
 * The execution plan contains:
 *  - executionMode: always dry-run/simulate without operator approval
 *  - actionManifest: ordered list of actions with rollback steps
 *  - scannerBinding: scanner/history evidence bound to this plan
 *  - rollbackRunbook: step-by-step rollback
 *  - abortRunbook: step-by-step abort
 *  - idempotencyKey: unique key preventing duplicate execution
 *  - preflightChecks: what must pass before execution
 */
function buildExecutionPlan(spec, input) {
  const gateStatuses = input.gates && typeof input.gates === 'object' ? input.gates : {};
  const approvalPacketHash = input.approvalPacketHash || gateStatuses.approvalPacketLocked?.packetHash || '';
  // Idempotency key from the run identifier, lane, and approval packet hash.
  // Never includes secrets or raw evidence.
  const idempotencyKey = deriveIdempotencyKey('a2a-exec', spec.run, spec.lane, approvalPacketHash || 'unlocked');

  // Determine execution mode: always dry-run/simulate without operator approval
  const operatorGate = gateStatuses.operatorExecutionGate;
  const operatorApproved = operatorGate?.status === 'GO' && hasEvidence(operatorGate);
  const effectiveMode = operatorApproved ? 'simulate' : 'dry-run';

  // Build the action manifest
  const actionManifest = [];

  // Preflight actions (always included)
  actionManifest.push({
    step: 1,
    action: 'preflight-git-clean',
    targetRepo: 'a2a-plane',
    description: 'Verify working tree is clean with no untracked bootstrap files',
    dryRunSafe: true,
    rollback: 'No rollback needed; preflight is read-only.',
  });

  actionManifest.push({
    step: 2,
    action: 'preflight-scanner-check',
    targetRepo: 'a2a-plane',
    description: 'Run external scanner (gitleaks) against the candidate tree and confirm clean/dispositioned findings',
    dryRunSafe: true,
    rollback: 'No rollback needed; scanner check is read-only.',
  });

  actionManifest.push({
    step: 3,
    action: 'preflight-bootstrap-hygiene',
    targetRepo: 'a2a-plane',
    description: 'Confirm no runtime/bootstrap files (AGENTS.md, SOUL.md, USER.md, TOOLS.md, HEARTBEAT.md, IDENTITY.md, .openclaw/**) would enter the branch or artifact evidence',
    dryRunSafe: true,
    rollback: 'No rollback needed; bootstrap check is read-only.',
  });

  actionManifest.push({
    step: 4,
    action: 'preflight-approval-packet-locked',
    targetRepo: 'a2a-plane',
    description: 'Confirm the approval packet is still locked and unchanged since last rehearsal',
    dryRunSafe: true,
    rollback: 'No rollback needed; packet lock check is read-only.',
  });

  // Dry-run/simulate actions (no live execution)
  actionManifest.push({
    step: 5,
    action: 'orchestrator-dry-run',
    targetRepo: 'a2a-plane',
    description: 'Produce the execution plan with dry-run/simulate mode. Output is a deterministic JSON report.',
    dryRunSafe: true,
    rollback: 'Delete the generated execution plan artifact if it was saved.',
  });

  if (effectiveMode === 'simulate') {
    actionManifest.push({
      step: 6,
      action: 'orchestrator-simulate',
      targetRepo: 'a2a-plane',
      description: 'Simulate the execution plan end-to-end without performing any live actions. Validate all rollback/abort paths.',
      dryRunSafe: true,
      rollback: 'Simulation is read-only; no side effects to roll back.',
    });
  }

  // Operator gate (blocking)
  actionManifest.push({
    step: effectiveMode === 'simulate' ? 7 : 6,
    action: 'operator-execution-gate',
    targetRepo: 'a2a-plane',
    description: 'WAITING: Explicit operator approval required to proceed beyond dry-run/simulate. No live execution is performed in this round.',
    dryRunSafe: true,
    rollback: 'No rollback needed; operator approval is a decision gate, not an action.',
  });

  // Build the scanner binding
  const scannerBinding = {
    boundToExecutionPlan: true,
    scannerRunId: gateStatuses.scannerHistoryBinding?.scannerRunId || 'pending',
    scannerEvidence: gateStatuses.scannerHistoryBinding?.evidence || [],
    commitSha: input.commitSha || gateStatuses.approvalPacketLocked?.commitSha || 'unlocked',
    historyRange: input.historyRange || 'HEAD',
    bindingTimestamp: new Date().toISOString(),
  };

  // Build rollback runbook
  const rollbackRunbook = {
    description: 'Rollback procedure for the execution orchestrator (no-live; no side effects in this round).',
    steps: [
      {
        step: 1,
        action: 'Stop orchestrator execution',
        detail: 'Halt the orchestrator process. Since this round is dry-run/simulate only, no live changes exist.',
      },
      {
        step: 2,
        action: 'Revert any generated artifacts',
        detail: 'Delete the execution plan JSON/Markdown artifact if it was saved to disk.',
      },
      {
        step: 3,
        action: 'Reset gate statuses',
        detail: 'Update the issue comment to indicate orchestrator run was rolled back. Post Block evidence with rollback reason.',
      },
      {
        step: 4,
        action: 'Confirm no side effects',
        detail: 'Verify: no deploys, no Gateway/broker restarts, no provider sends, no DB mutations, no visibility changes, no terminal ACKs.',
      },
    ],
  };

  // Build abort runbook
  const abortRunbook = {
    description: 'Abort procedure for preflight or execution failures.',
    failureModes: [
      {
        when: 'git working tree is dirty',
        abort: 'Post Block evidence: working tree not clean. Clean the tree and re-run.',
      },
      {
        when: 'external scanner finds undispositioned secrets',
        abort: 'Post Block evidence: scanner findings must be dispositioned. Operator must review and clear.',
      },
      {
        when: 'bootstrap files detected in branch or artifacts',
        abort: 'Post Block evidence: runtime/bootstrap context files detected. Remove from branch/artifacts and re-run.',
      },
      {
        when: 'approval packet lock broken (hash mismatch)',
        abort: 'Post Block evidence: approval packet has changed since last lock. Re-run approval rehearsal.',
      },
      {
        when: 'idempotency key collision detected',
        abort: 'Post Block evidence: duplicate execution detected. An execution plan with this idempotency key already exists.',
      },
      {
        when: 'any required gate is MISSING or not GO',
        abort: 'Post Block evidence: gate(s) not ready. Resolve each blocked gate before re-running.',
      },
    ],
    defaultAction: 'Post Block evidence on the issue with the specific failure reason. No partial state is left.',
  };

  return {
    executionMode: effectiveMode,
    executionModesSupported: ['dry-run', 'simulate'],
    idempotencyKey: redactKey(idempotencyKey),
    idempotencyKeyHash: hashKey(idempotencyKey),
    actionManifest,
    scannerBinding,
    rollbackRunbook,
    abortRunbook,
    preflightChecks: {
      gitClean: { required: true, description: 'Working tree must be clean, no untracked bootstrap files' },
      scannerPass: { required: true, description: 'External scanner must pass against candidate tree' },
      bootstrapHygiene: { required: true, description: 'No runtime/bootstrap context files in branch or artifacts' },
      approvalPacketLocked: { required: true, description: 'Approval packet must be locked and unchanged' },
      idempotencyNoCollision: { required: true, description: 'No prior execution plan with the same idempotency key' },
    },
  };
}

/**
 * Full gate-level evaluation against the input evidence packet.
 */
function evaluateInput(spec, input) {
  const gateStatuses = input.gates && typeof input.gates === 'object' ? input.gates : {};
  const decision = computeDecision(gateStatuses, spec, 'operatorExecutionGate');

  // Evaluate each required gate (with domain-specific deep validation when GO)
  const blockers = collectRequiredGateBlockers(spec, gateStatuses, {
    validateDomain: (id, evidencePacket) => validateReadinessGate(id, evidencePacket, readinessOptions),
  });

  // Redaction checks on evidence text
  for (const { gateId, kind } of findUnredactedEvidence(gateStatuses)) {
    blockers.push({ gate: gateId, status: 'GO', reason: unredactedReason(kind) });
  }

  // Execution mode lock: never execute without operator approval
  if (decision !== 'GO_CANDIDATE') {
    blockers.push({
      gate: 'operatorExecutionGate',
      status: 'WAITING',
      reason: 'execution mode is locked to dry-run/simulate; explicit operator approval is required to proceed',
    });
  }

  const safeDecision = decision === 'GO_CANDIDATE' && blockers.length > 0 ? 'NO_GO' : decision;
  return {
    ok: safeDecision !== 'NO_GO' || input.decision === 'NO_GO',
    decision: safeDecision,
    blockers,
    sourcePublicExecution: 'NO_GO',
  };
}

/**
 * Build the full execution orchestrator report.
 */
export function buildExecutionOrchestratorReport(spec, input) {
  const gateStatuses = input.gates && typeof input.gates === 'object' ? input.gates : {};
  const executionPlan = buildExecutionPlan(spec, input);
  const gateResults = buildGateResults(spec, gateStatuses);
  const result = evaluateInput(spec, input);

  return {
    kind: 'a2a.source-public-execution-orchestrator-report',
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
    executionPlan,
    gateResults,
    blockers: result.blockers,
    requiredGates: spec.goDecisionRequires,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Render a deterministic Markdown report.
 */
export function renderExecutionOrchestratorMarkdown(report) {
  const decisionLabel = {
    GO_CANDIDATE: 'GO_CANDIDATE: Execution plan ready for operator review',
    NO_GO: 'NO_GO: Execution orchestrator failed',
    NEEDS_OPERATOR_APPROVAL: 'NEEDS_OPERATOR_APPROVAL: Orchestrator passed; operator sign-off required for execution',
  };
  const label = decisionLabel[report.decision] || `Decision: ${report.decision}`;

  const lines = [
    `# A2A Nexus source-public execution orchestrator report`,
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
  ];

  // Execution plan summary
  if (report.executionPlan) {
    const plan = report.executionPlan;
    lines.push(
      '## Execution Plan',
      '',
      `Execution mode: **${plan.executionMode}**`,
      `Idempotency key: ${plan.idempotencyKey} (hash: ${plan.idempotencyKeyHash})`,
      '',
      '### Action Manifest',
      '',
      '| Step | Action | Target | Dry-run Safe |',
      '|------|--------|--------|-------------|',
      ...plan.actionManifest.map((a) =>
        `| ${a.step} | ${a.action} | ${a.targetRepo} | ${a.dryRunSafe ? '✅' : '⚠️'} |`,
      ),
      '',
      '### Scanner Binding',
      '',
      `Scanner run: ${plan.scannerBinding.scannerRunId}`,
      `Commit SHA: ${plan.scannerBinding.commitSha}`,
      `Binding timestamp: ${plan.scannerBinding.bindingTimestamp}`,
      '',
      '### Rollback Runbook',
      ...plan.rollbackRunbook.steps.map((s) => `- **Step ${s.step}**: ${s.action} — ${s.detail}`),
      '',
      '### Abort Runbook',
      ...plan.abortRunbook.failureModes.map((fm) => `- **${fm.when}**: ${fm.abort}`),
      '',
      '### Preflight Checks',
      ...Object.entries(plan.preflightChecks).map(([name, check]) => `- **${name}**: ${check.description}`),
      '',
    );
  }

  // Gate status
  lines.push('## Gate status', '',
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
    'This is a **dry-run/simulate round only**. No approval, release, visibility change,',
    'live provider send, deploy, Gateway restart, Telegram send, DB mutation, or terminal ACK was performed.',
    '',
    'Source-public execution remains **NO_GO** without explicit operator approval.',
    'The execution plan is locked to dry-run/simulate mode until operatorExecutionGate is GO.',
    '',
    `Generated: ${report.timestamp}`,
    '',
  );

  return lines.join('\n');
}

runGateCli({
  values,
  validateSpec,
  // Validate execution mode
  rejectMode: (spec, opts) => {
    const requestedMode = opts.mode || 'dry-run';
    if (spec.executionModes.includes(requestedMode)) return null;
    return `unsupported execution mode: ${requestedMode}. Supported modes: ${spec.executionModes.join(', ')}`;
  },
  specOnlyPayload: (spec, opts) => ({
    ok: true,
    phase: 'spec',
    decision: spec.defaultDecision,
    decisionOutputs: spec.decisionOutputs,
    sourcePublicExecution: 'NO_GO',
    executionMode: opts.mode || 'dry-run',
    executionModesSupported: spec.executionModes,
    requiredGates: spec.goDecisionRequires,
  }),
  buildReport: buildExecutionOrchestratorReport,
  renderMarkdown: renderExecutionOrchestratorMarkdown,
});
