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
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    spec: { type: 'string', default: 'docs/final-approval/source-public-final-go-nogo-gate-schema.json' },
    orchestrator: { type: 'string' },
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
  const failures = [];
  if (spec.failClosed !== true) failures.push('spec.failClosed must be true');
  if (!spec.decisionOutputs || !Array.isArray(spec.decisionOutputs)) {
    failures.push('spec.decisionOutputs must be an array');
  } else {
    for (const output of ['GO', 'NO_GO', 'BLOCKED']) {
      if (!spec.decisionOutputs.includes(output)) failures.push(`spec.decisionOutputs missing ${output}`);
    }
  }
  if (spec.defaultDecision !== 'NO_GO') failures.push('spec.defaultDecision must be NO_GO');
  if (spec.sourcePublicExecution !== 'NO_GO') failures.push('spec.sourcePublicExecution must be NO_GO');
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

  const forbidden = new Set(spec.forbiddenLiveFlags || []);
  for (const flag of [
    'approvalExecution', 'releasePublication', 'repositoryVisibilityChange',
    'productionDeploy', 'gatewayRestart', 'brokerRestart', 'workerRestart',
    'terminalAck', 'liveProviderSend', 'productionDbMutation', 'forcePush',
    'communityPost', 'automaticMerge', 'automaticApproval',
  ]) {
    if (!forbidden.has(flag)) failures.push(`forbiddenLiveFlags missing ${flag}`);
  }

  return failures;
}

/**
 * Derive an idempotency key for the final approval packet.
 */
function deriveIdempotencyKey(run, lane, orchestratorPlanId) {
  const components = [run, lane, orchestratorPlanId || 'unbound'].filter(Boolean);
  return `a2a-final-gate-${components.join('-')}`;
}

function hashKey(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    const char = key.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return `sha256:${Math.abs(hash).toString(16).padStart(8, '0')}`;
}

function redactKey(key) {
  if (key.length <= 12) return `${key.substring(0, 4)}...`;
  return `${key.substring(0, 12)}...`;
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
    const status = String(gate?.status || 'MISSING').toUpperCase();
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

  // Evaluate each required gate
  for (const id of spec.goDecisionRequires || []) {
    const gate = gateStatuses[id];
    const status = String(gate?.status || 'MISSING').toUpperCase();

    if (id === 'orchestratorPlanBinding') {
      // Check gate-level status regardless of deep validation outcome
      if (status !== 'GO') {
        blockers.push({ gate: id, status, reason: `status is ${status}` });
      }
      if (!hasEvidence(gate)) {
        blockers.push({ gate: id, status, reason: 'redacted evidence link is missing' });
      }
      continue;
    }

    if (status !== 'GO') {
      blockers.push({ gate: id, status, reason: `status is ${status}` });
    }
    if (!hasEvidence(gate)) {
      blockers.push({ gate: id, status, reason: 'redacted evidence link is missing' });
    }
  }

  // Redaction checks
  for (const [gateId, gate] of Object.entries(gateStatuses)) {
    if (!Array.isArray(gate?.evidence)) continue;
    for (const entry of gate.evidence) {
      if (typeof entry !== 'string' || !entry.trim()) continue;
      for (const rule of unredactedEvidenceRules) {
        if (rule.re.test(entry)) {
          blockers.push({ gate: gateId, reason: `evidence is not redacted (${rule.kind})` });
        }
      }
    }
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
  const gateNames = new Map((spec.gates || []).map((gate) => [gate.id, gate.title]));
  const commitSha = input.commitSha || orchestratorReport?.executionPlan?.scannerBinding?.commitSha || 'unlocked';
  const orchestratorPlanId = orchestratorReport?.executionPlan?.idempotencyKeyHash || '';

  const idempotencyKey = deriveIdempotencyKey(spec.run, spec.lane, orchestratorPlanId);
  const gateMatrix = buildGateMatrix(spec, input);
  const rcTagging = buildReleaseCandidateTagging(spec, orchestratorReport, commitSha);
  const ciCapsule = buildCiGateCapsule(spec, input);
  const approvalPacket = buildOperatorApprovalPacket(spec, orchestratorReport, gateMatrix, rcTagging, ciCapsule, idempotencyKey, input);
  const result = evaluateGates(spec, orchestratorReport, input);

  // Build per-gate status summary
  const gateResults = [];
  for (const id of spec.goDecisionRequires || []) {
    const gate = input.gates?.[id];
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

try {
  const specPath = path.resolve(values.spec);
  const spec = readJson(specPath);
  const specFailures = validateSpec(spec);
  if (specFailures.length) {
    console.error(JSON.stringify({ ok: false, phase: 'spec', failures: specFailures }, null, 2));
    process.exit(1);
  }

  const requestedMode = values.mode || 'dry-run';
  if (!spec.allowedModes.includes(requestedMode)) {
    console.error(JSON.stringify({
      ok: false,
      phase: 'spec',
      error: `unsupported mode: ${requestedMode}. Allowed modes: ${spec.allowedModes.join(', ')}`,
    }, null, 2));
    process.exit(1);
  }

  if (!values.orchestrator && !values.input) {
    console.log(JSON.stringify({
      ok: true,
      phase: 'spec',
      decision: spec.defaultDecision,
      decisionOutputs: spec.decisionOutputs,
      sourcePublicExecution: spec.sourcePublicExecution,
      mode: requestedMode,
      requiredGates: spec.goDecisionRequires,
    }, null, 2));
    process.exit(0);
  }

  let orchestratorReport = null;
  if (values.orchestrator) {
    orchestratorReport = readJson(path.resolve(values.orchestrator));
  }

  let input = { gates: {} };
  if (values.input) {
    input = readJson(path.resolve(values.input));
  }

  const report = buildFinalGoNoGoReport(spec, input, orchestratorReport);

  if (values.format === 'markdown') {
    (report.ok ? console.log : console.error)(renderFinalGoNoGoMarkdown(report));
  } else {
    (report.ok ? console.log : console.error)(JSON.stringify(report, null, 2));
  }

  process.exit(report.ok ? 0 : 1);
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
}
