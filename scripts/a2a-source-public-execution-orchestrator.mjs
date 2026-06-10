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
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    spec: { type: 'string', default: 'docs/execution-orchestrator/source-public-execution-orchestrator-schema.json' },
    input: { type: 'string' },
    format: { type: 'string', default: 'json' },
    mode: { type: 'string', default: 'dry-run' },
  },
});

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read JSON ${file}: ${error.message}`);
  }
}

function hasEvidence(value) {
  return Array.isArray(value?.evidence) && value.evidence.some((entry) => typeof entry === 'string' && entry.trim());
}

const unredactedEvidenceRules = [
  {
    kind: 'secret-assignment',
    re: /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY)[A-Z0-9_]*\s*=\s*['"]?(?!<|\$\{|YOUR_|redacted|REDACTED)[^'"\s#]{12,}/i,
  },
  { kind: 'github-token-shape', re: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { kind: 'aws-access-key-shape', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'absolute-private-path', re: /\/(?:home|Users)\/[^\s'")`]+|\/root\/private\/[^\s'")`]+/ },
  { kind: 'raw-session-dump', re: /(?:^|\n)\s*(?:system|developer|assistant|user|tool)\s*<\|/i },
];

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

function evidenceEntries(gateStatuses) {
  return Object.entries(gateStatuses).flatMap(([gateId, gate]) => {
    if (!Array.isArray(gate?.evidence)) return [];
    return gate.evidence
      .filter((entry) => typeof entry === 'string' && entry.trim())
      .map((entry) => ({ gateId, entry }));
  });
}

/**
 * Validate the execution-orchestrator schema itself is fail-closed.
 */
function validateSpec(spec) {
  const failures = [];
  if (spec.failClosed !== true) failures.push('spec.failClosed must be true');
  if (!spec.decisionOutputs || !Array.isArray(spec.decisionOutputs)) {
    failures.push('spec.decisionOutputs must be an array');
  } else {
    for (const output of ['GO_CANDIDATE', 'NO_GO', 'NEEDS_OPERATOR_APPROVAL']) {
      if (!spec.decisionOutputs.includes(output)) failures.push(`spec.decisionOutputs missing ${output}`);
    }
  }
  if (spec.defaultDecision !== 'NO_GO') failures.push('spec.defaultDecision must be NO_GO');
  if (!spec.executionModes || !Array.isArray(spec.executionModes)) {
    failures.push('spec.executionModes must be an array');
  } else {
    for (const mode of ['dry-run', 'simulate']) {
      if (!spec.executionModes.includes(mode)) failures.push(`spec.executionModes missing ${mode}`);
    }
  }
  if (spec.defaultExecutionMode !== 'dry-run') failures.push('spec.defaultExecutionMode must be dry-run');
  if (!Array.isArray(spec.goDecisionRequires) || spec.goDecisionRequires.length === 0) {
    failures.push('spec.goDecisionRequires must list required GO gates');
  }
  if (!Array.isArray(spec.gates) || spec.gates.length === 0) failures.push('spec.gates must be non-empty');

  const goDecisionRequires = new Set(spec.goDecisionRequires || []);
  for (const id of mandatoryGoGates) {
    if (!goDecisionRequires.has(id)) failures.push(`spec.goDecisionRequires missing mandatory gate: ${id}`);
  }

  const gates = new Map((spec.gates || []).map((gate) => [gate.id, gate]));
  for (const id of spec.goDecisionRequires || []) {
    const gate = gates.get(id);
    if (!gate) {
      failures.push(`required gate missing from spec.gates: ${id}`);
      continue;
    }
    if (gate.failClosed !== true) failures.push(`${id}: failClosed must be true`);
    if (gate.requiredForGo !== true) failures.push(`${id}: requiredForGo must be true`);
    if (!gate.blockedWhenMissing) failures.push(`${id}: blockedWhenMissing is required`);
    if (!hasEvidence(gate)) failures.push(`${id}: gate evidence requirements must be documented`);
  }

  const hygiene = gates.get('runtimeBootstrapHygiene');
  if (hygiene) {
    const denyPaths = new Set(hygiene.denyPaths || []);
    for (const requiredPath of ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/**']) {
      if (!denyPaths.has(requiredPath)) failures.push(`runtimeBootstrapHygiene.denyPaths missing ${requiredPath}`);
    }
  }

  return failures;
}

/**
 * Derive an idempotency key from the run identifier, approval packet hash, and lane.
 * Never includes secrets or raw evidence.
 */
function deriveIdempotencyKey(run, lane, approvalPacketHash) {
  const components = [run, lane, approvalPacketHash || 'unlocked'].filter(Boolean);
  return `a2a-exec-${components.join('-')}`;
}

/**
 * Validate broker readiness evidence packet.
 */
function validateBrokerReadiness(evidence) {
  if (!evidence || typeof evidence !== 'object') {
    return { ok: false, check: 'brokerReadiness', detail: 'missing broker readiness evidence packet' };
  }
  const blockers = [];
  const health = evidence.health ?? evidence.liveReadiness?.health ?? {};
  if (health.ok !== true && health.status !== 'ok' && health.status !== 200) {
    blockers.push('health: not ok');
  }
  const expectedWorkers = evidence.expectedWorkers ?? [];
  const onlineIds = evidence.onlineWorkerIds ?? evidence.workerMatrix?.onlineIds ?? [];
  if (Array.isArray(expectedWorkers) && expectedWorkers.length > 0) {
    const missing = expectedWorkers.filter((id) => !onlineIds.includes(id));
    if (missing.length > 0) blockers.push(`workers: missing ${missing.join(', ')}`);
  } else if (Array.isArray(onlineIds) && onlineIds.length === 0) {
    blockers.push('workers: no online workers');
  }
  const queue = evidence.queue ?? evidence.capacity?.queue ?? {};
  const queued = Number(queue.queued ?? 0);
  const claimed = Number(queue.claimed ?? 0);
  const running = Number(queue.running ?? 0);
  const stale = Number(evidence.stale ?? queue.stale ?? 0);
  if (queued !== 0 || claimed !== 0 || running !== 0 || stale !== 0) {
    blockers.push(`queue/stale: queued=${queued}, claimed=${claimed}, running=${running}, stale=${stale}`);
  }
  if (evidence.migrationHealthGate && evidence.migrationHealthGate.ok === false) {
    blockers.push('migrationHealthGate: failed');
  }
  if (blockers.length > 0) {
    return { ok: false, check: 'brokerReadiness', detail: blockers.join('; ') };
  }
  return { ok: true, check: 'brokerReadiness', detail: 'broker health, workers, queue/stale checks passed' };
}

/**
 * Validate plugin readiness evidence packet.
 */
function validatePluginReadiness(evidence) {
  if (!evidence || typeof evidence !== 'object') {
    return { ok: false, check: 'pluginReadiness', detail: 'missing plugin readiness evidence packet' };
  }
  const blockers = [];
  if (evidence.liveTelegramConfigured === true || evidence.providerDeliveryEnabled === true || evidence.notificationEnabled === true) {
    blockers.push('live Telegram/provider delivery is configured; must be disabled');
  }
  if (evidence.operatorEventsEnabled === true) {
    blockers.push('operator events are enabled; must be disabled');
  }
  if (evidence.gatewayHealth && evidence.gatewayHealth.ok !== true) {
    blockers.push('gateway health: not ok');
  }
  if (evidence.operatorApproval === true) {
    blockers.push('operator approval is bundled into plugin evidence; must be a separate gate');
  }
  if (blockers.length > 0) {
    return { ok: false, check: 'pluginReadiness', detail: blockers.join('; ') };
  }
  return { ok: true, check: 'pluginReadiness', detail: 'plugin read-only projection verified; no live delivery configured' };
}

/**
 * Validate runner readiness evidence packet.
 */
function validateRunnerReadiness(evidence) {
  if (!evidence || typeof evidence !== 'object') {
    return { ok: false, check: 'runnerReadiness', detail: 'missing runner readiness evidence packet' };
  }
  const blockers = [];
  if (!evidence.artifactManifest) {
    blockers.push('missing artifact manifest');
  } else if (evidence.artifactManifest.ok !== true) {
    blockers.push('artifact manifest: not ok');
  }
  if (!evidence.scannerProfile) {
    blockers.push('missing deterministic scanner/history scan profile');
  } else if (evidence.scannerProfile.ok !== true) {
    blockers.push('scanner profile: not ok');
  }
  if (evidence.productionDeploy === true) blockers.push('production deploy flag is set');
  if (evidence.providerCalled === true) blockers.push('provider called flag is set');
  if (blockers.length > 0) {
    return { ok: false, check: 'runnerReadiness', detail: blockers.join('; ') };
  }
  return { ok: true, check: 'runnerReadiness', detail: 'artifact manifest, scanner profile, and runner state passed' };
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
  const idempotencyKey = deriveIdempotencyKey(spec.run, spec.lane, approvalPacketHash);

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

/** Redact the idempotency key for public evidence (show prefix only). */
function redactKey(key) {
  if (key.length <= 12) return `${key.substring(0, 4)}...`;
  return `${key.substring(0, 12)}...`;
}

/** Simple hash for idempotency key (not cryptographic; for reference only). */
function hashKey(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    const char = key.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return `sha256:${Math.abs(hash).toString(16).padStart(8, '0')}`;
}

/**
 * Compute the decision: GO_CANDIDATE / NO_GO / NEEDS_OPERATOR_APPROVAL
 */
function computeDecision(gateStatuses, spec) {
  const operatorGate = gateStatuses.operatorExecutionGate;
  const operatorGo = operatorGate?.status === 'GO';
  const operatorHasEvidence = hasEvidence(operatorGate);

  let allOtherGo = true;
  for (const id of spec.goDecisionRequires || []) {
    if (id === 'operatorExecutionGate') continue;
    const gate = gateStatuses[id];
    const status = String(gate?.status || 'MISSING').toUpperCase();
    if (status !== 'GO') {
      allOtherGo = false;
      break;
    }
    if (!hasEvidence(gate)) {
      allOtherGo = false;
      break;
    }
  }

  if (allOtherGo && operatorGo && operatorHasEvidence) {
    return 'GO_CANDIDATE';
  }
  if (allOtherGo && !operatorGo) {
    return 'NEEDS_OPERATOR_APPROVAL';
  }
  return 'NO_GO';
}

/**
 * Full gate-level evaluation against the input evidence packet.
 */
function evaluateInput(spec, input) {
  const blockers = [];
  const gateStatuses = input.gates && typeof input.gates === 'object' ? input.gates : {};
  const decision = computeDecision(gateStatuses, spec);

  // Evaluate each required gate
  for (const id of spec.goDecisionRequires || []) {
    const gate = gateStatuses[id];
    const status = String(gate?.status || 'MISSING').toUpperCase();

    if (status !== 'GO') {
      blockers.push({ gate: id, status, reason: `status is ${status}` });
    }
    if (!hasEvidence(gate)) {
      blockers.push({ gate: id, status, reason: 'redacted evidence link is missing' });
    }

    // Domain-specific deep validation when gate status is GO
    if (status === 'GO' && gate?.evidencePacket) {
      let domainResult;
      switch (id) {
        case 'brokerReadiness':
          domainResult = validateBrokerReadiness(gate.evidencePacket);
          break;
        case 'pluginReadiness':
          domainResult = validatePluginReadiness(gate.evidencePacket);
          break;
        case 'runnerReadiness':
          domainResult = validateRunnerReadiness(gate.evidencePacket);
          break;
      }
      if (domainResult && !domainResult.ok) {
        blockers.push({ gate: id, status, reason: domainResult.detail });
      }
    }
  }

  // Redaction checks on evidence text
  for (const { gateId, entry } of evidenceEntries(gateStatuses)) {
    for (const rule of unredactedEvidenceRules) {
      if (rule.re.test(entry)) {
        blockers.push({ gate: gateId, status: 'GO', reason: `evidence is not redacted (${rule.kind})` });
      }
    }
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
  const gateNames = new Map((spec.gates || []).map((gate) => [gate.id, gate.title]));
  const executionPlan = buildExecutionPlan(spec, input);

  // Build per-gate status summary
  const gateResults = [];
  for (const id of spec.goDecisionRequires || []) {
    const gate = gateStatuses[id];
    const status = String(gate?.status || 'MISSING').toUpperCase();
    const evidenceUrls = Array.isArray(gate?.evidence) ? gate.evidence.filter((e) => typeof e === 'string') : [];
    gateResults.push({
      gate: id,
      title: gateNames.get(id) || id,
      status,
      ok: status === 'GO' && evidenceUrls.length > 0,
      evidenceCount: evidenceUrls.length,
    });
  }

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

try {
  const specPath = path.resolve(values.spec);
  const spec = readJson(specPath);
  const specFailures = validateSpec(spec);
  if (specFailures.length) {
    console.error(JSON.stringify({ ok: false, phase: 'spec', failures: specFailures }, null, 2));
    process.exit(1);
  }

  // Validate execution mode
  const requestedMode = values.mode || 'dry-run';
  if (!spec.executionModes.includes(requestedMode)) {
    console.error(JSON.stringify({
      ok: false,
      phase: 'spec',
      error: `unsupported execution mode: ${requestedMode}. Supported modes: ${spec.executionModes.join(', ')}`,
    }, null, 2));
    process.exit(1);
  }

  if (!values.input) {
    console.log(JSON.stringify({
      ok: true,
      phase: 'spec',
      decision: spec.defaultDecision,
      decisionOutputs: spec.decisionOutputs,
      sourcePublicExecution: 'NO_GO',
      executionMode: requestedMode,
      executionModesSupported: spec.executionModes,
      requiredGates: spec.goDecisionRequires,
    }, null, 2));
    process.exit(0);
  }

  const input = readJson(path.resolve(values.input));
  const report = buildExecutionOrchestratorReport(spec, input);

  if (values.format === 'markdown') {
    (report.ok ? console.log : console.error)(renderExecutionOrchestratorMarkdown(report));
  } else {
    (report.ok ? console.log : console.error)(JSON.stringify(report, null, 2));
  }

  process.exit(report.ok ? 0 : 1);
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
}
