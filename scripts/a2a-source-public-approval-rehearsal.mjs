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
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    spec: { type: 'string', default: 'docs/approval-rehearsal/source-public-approval-packet-schema.json' },
    input: { type: 'string' },
    format: { type: 'string', default: 'json' },
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

function evidenceEntries(gateStatuses) {
  return Object.entries(gateStatuses).flatMap(([gateId, gate]) => {
    if (!Array.isArray(gate?.evidence)) return [];
    return gate.evidence
      .filter((entry) => typeof entry === 'string' && entry.trim())
      .map((entry) => ({ gateId, entry }));
  });
}

/**
 * Validate the approval-rehearsal schema itself is fail-closed with all required gates.
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
  if (evidence.migrationHealthGate) {
    const mg = evidence.migrationHealthGate;
    if (mg.ok === false) blockers.push('migrationHealthGate: failed');
  }
  if (blockers.length > 0) {
    return { ok: false, check: 'brokerReadiness', detail: blockers.join('; ') };
  }
  return { ok: true, check: 'brokerReadiness', detail: 'broker health, workers, queue/stale, and migration checks passed' };
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
    blockers.push('live Telegram/provider delivery is configured; must be disabled for approval rehearsal');
  }
  if (evidence.operatorEventsEnabled === true) {
    blockers.push('operator events are enabled; must be disabled for approval rehearsal');
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
  } else {
    const manifest = evidence.artifactManifest;
    if (manifest.ok !== true) blockers.push('artifact manifest: not ok');
  }
  if (!evidence.scannerProfile) {
    blockers.push('missing deterministic scanner/history scan profile');
  } else {
    const scan = evidence.scannerProfile;
    if (scan.ok !== true) blockers.push('scanner profile: not ok');
  }
  if (evidence.productionDeploy === true) blockers.push('production deploy flag is set');
  if (evidence.providerCalled === true) blockers.push('provider called flag is set');
  if (blockers.length > 0) {
    return { ok: false, check: 'runnerReadiness', detail: blockers.join('; ') };
  }
  return { ok: true, check: 'runnerReadiness', detail: 'artifact manifest, scanner profile, and runner state passed' };
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
 * Determine the final decision output.
 *
 * - GO_CANDIDATE: all required gates are GO, operator approval is present
 * - NEEDS_OPERATOR_APPROVAL: all gates GO except operatorApproval
 * - NO_GO: any required gate is not GO (including MISSING)
 */
function computeDecision(gateStatuses, spec) {
  const operatorGate = gateStatuses.operatorApproval;
  const operatorGo = operatorGate?.status === 'GO';
  const operatorHasEvidence = hasEvidence(operatorGate);

  let allOtherGo = true;
  for (const id of spec.goDecisionRequires || []) {
    if (id === 'operatorApproval') continue;
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

  // Approval packet integrity validation
  if (gateStatuses.approvalPacketIntegrity?.status === 'GO') {
    const integrityResult = validateApprovalPacketIntegrity(gateStatuses, spec);
    if (!integrityResult.ok) {
      blockers.push({ gate: 'approvalPacketIntegrity', status: 'GO', reason: integrityResult.detail });
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

  // Operator approval separation check
  const operatorEvidence = new Set(
    (gateStatuses.operatorApproval?.evidence || [])
      .filter((entry) => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  if (decision === 'GO_CANDIDATE') {
    if (operatorEvidence.size === 0) {
      blockers.push({ gate: 'operatorApproval', reason: 'separate operator approval evidence is required' });
    } else {
      for (const { gateId, entry } of evidenceEntries(gateStatuses)) {
        if (gateId !== 'operatorApproval' && operatorEvidence.has(entry.trim())) {
          blockers.push({ gate: gateId, reason: `operator approval evidence must be separate from ${gateId}` });
        }
      }
    }
  }

  // Safety: approval rehearsal never produces GO — always gated
  const safeDecision = decision === 'GO_CANDIDATE' && blockers.length > 0 ? 'NO_GO' : decision;
  const ok = safeDecision !== 'NO_GO' || (blockers.length > 0 && safeDecision === 'NO_GO');
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
  const gateNames = new Map((spec.gates || []).map((gate) => [gate.id, gate.title]));

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

try {
  const specPath = path.resolve(values.spec);
  const spec = readJson(specPath);
  const specFailures = validateSpec(spec);
  if (specFailures.length) {
    console.error(JSON.stringify({ ok: false, phase: 'spec', failures: specFailures }, null, 2));
    process.exit(1);
  }

  if (!values.input) {
    console.log(JSON.stringify({
      ok: true,
      phase: 'spec',
      decision: spec.defaultDecision,
      decisionOutputs: spec.decisionOutputs,
      sourcePublicExecution: 'NO_GO',
      requiredGates: spec.goDecisionRequires,
    }, null, 2));
    process.exit(0);
  }

  const input = readJson(path.resolve(values.input));
  const report = buildApprovalRehearsalReport(spec, input);

  if (values.format === 'markdown') {
    (report.ok ? console.log : console.error)(renderApprovalRehearsalMarkdown(report));
  } else {
    (report.ok ? console.log : console.error)(JSON.stringify(report, null, 2));
  }

  process.exit(report.ok ? 0 : 1);
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
}
