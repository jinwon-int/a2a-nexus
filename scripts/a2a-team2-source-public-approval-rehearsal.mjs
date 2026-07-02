#!/usr/bin/env node
/**
 * A2A Nexus source-public approval rehearsal evaluator.
 *
 * Read-only by design. It consumes redacted rehearsal evidence and emits one of:
 * GO_CANDIDATE, NO_GO, or NEEDS_OPERATOR_APPROVAL. It never performs approval,
 * release, visibility, provider-send, deploy, restart, terminal ACK, or DB work.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    spec: { type: 'string', default: 'docs/approval-rehearsal/team2-worker-eta-source-public-approval-rehearsal-schema.json' },
    input: { type: 'string' },
    format: { type: 'string', default: 'json' },
  },
});

const decisionStates = new Set(['GO_CANDIDATE', 'NO_GO', 'NEEDS_OPERATOR_APPROVAL']);

const unredactedEvidenceRules = [
  {
    kind: 'secret-assignment',
    re: /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY)[A-Z0-9_]*\s*=\s*['"]?(?!<|\$\{|YOUR_|redacted|REDACTED)[^'"\s#]{12,}/i,
  },
  { kind: 'github-token-shape', re: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { kind: 'aws-access-key-shape', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'absolute-private-path', re: /\/(?:home|Users)\/[^\s'")`]+|\/root\/private\/[^\s'")`]+/ },
  { kind: 'raw-session-dump', re: /(?:^|\n)\s*(?:system|developer|assistant|user|tool)\s*<\|/i },
  { kind: 'openclaw-cache-boundary', re: /OPENCLAW_CACHE_BOUNDARY/ },
];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read JSON ${file}: ${error.message}`);
  }
}

function asStatus(value) {
  return String(value || 'MISSING').trim().toUpperCase().replace(/-/g, '_');
}

function hasEvidence(gate) {
  return Array.isArray(gate?.evidence) && gate.evidence.some((entry) => typeof entry === 'string' && entry.trim());
}

function evidenceEntries(gates) {
  return Object.entries(gates || {}).flatMap(([gateId, gate]) => {
    if (!Array.isArray(gate?.evidence)) return [];
    return gate.evidence
      .filter((entry) => typeof entry === 'string' && entry.trim())
      .map((entry) => ({ gateId, entry }));
  });
}

function denyPathMatcher(denyPath) {
  if (denyPath.endsWith('/**')) {
    const prefix = denyPath.slice(0, -3);
    return (value) => value === prefix || value.startsWith(`${prefix}/`);
  }
  return (value) => value === denyPath;
}

function findDenyPathReferences(spec, input, gates) {
  const matchers = (spec.runtimeBootstrapDenyPaths || []).map((denyPath) => [denyPath, denyPathMatcher(denyPath)]);
  const candidates = [
    ...(Array.isArray(input.offendingPaths) ? input.offendingPaths : []),
    ...(Array.isArray(input.artifactPaths) ? input.artifactPaths : []),
    ...evidenceEntries(gates).map(({ entry }) => entry),
  ].filter((value) => typeof value === 'string');

  const found = new Set();
  for (const candidate of candidates) {
    for (const token of candidate.split(/[\s,;:()<>[\]{}"'`]+/).filter(Boolean)) {
      const normalized = token.replace(/^\.\//, '').replace(/[#?].*$/, '');
      for (const [, matches] of matchers) {
        if (matches(normalized)) found.add(normalized);
      }
    }
  }
  return [...found].sort();
}

function validateSpec(spec) {
  const failures = [];
  if (spec.failClosed !== true) failures.push('spec.failClosed must be true');
  if (spec.defaultDecision !== 'NO_GO') failures.push('spec.defaultDecision must be NO_GO');
  for (const state of ['GO_CANDIDATE', 'NO_GO', 'NEEDS_OPERATOR_APPROVAL']) {
    if (!Array.isArray(spec.decisionStates) || !spec.decisionStates.includes(state)) {
      failures.push(`spec.decisionStates missing ${state}`);
    }
  }
  if (spec.sourcePublicExecution !== 'NO_GO') failures.push('spec.sourcePublicExecution must remain NO_GO');
  if (spec.approvalExecution !== 'NOT_PERFORMED') failures.push('spec.approvalExecution must be NOT_PERFORMED');

  const gates = new Map((spec.gates || []).map((gate) => [gate.id, gate]));
  for (const id of spec.requiredRehearsalGates || []) {
    const gate = gates.get(id);
    if (!gate) failures.push(`required rehearsal gate missing from spec.gates: ${id}`);
    if (gate && gate.failClosed !== true) failures.push(`${id}: failClosed must be true`);
    if (gate && gate.requiredForCandidate !== true) failures.push(`${id}: requiredForCandidate must be true`);
    if (gate && !gate.blockedWhenMissing) failures.push(`${id}: blockedWhenMissing is required`);
    if (gate && !hasEvidence(gate)) failures.push(`${id}: evidence requirements must be documented`);
  }

  if (!gates.has(spec.operatorApprovalGate)) failures.push('operatorApproval gate must be present but not required for rehearsal validity');
  for (const requiredPath of ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/**']) {
    if (!spec.runtimeBootstrapDenyPaths?.includes(requiredPath)) {
      failures.push(`runtimeBootstrapDenyPaths missing ${requiredPath}`);
    }
  }
  return failures;
}

function validateApprovalPacket(gate) {
  const packet = gate?.evidencePacket || {};
  const blockers = [];
  if (!packet.packetId) blockers.push('approval packet missing packetId');
  if (!packet.manifestDigest) blockers.push('approval packet missing manifestDigest');
  if (packet.deterministic !== true) blockers.push('approval packet must be deterministic=true');
  if (packet.approvalExecution === true || packet.sourcePublicExecution === true) {
    blockers.push('approval packet must not execute approval or source-public actions');
  }
  return blockers;
}

function validateIntegratedBundle(gate) {
  const packet = gate?.evidencePacket || {};
  const blockers = [];
  if (!packet.manifestDigest) blockers.push('integrated evidence bundle missing manifestDigest');
  const components = packet.components || {};
  for (const id of ['broker', 'plugin', 'runner', 'libero']) {
    if (components[id] !== true) blockers.push(`integrated evidence bundle missing ${id} component`);
  }
  return blockers;
}

function validateNoLiveTerminalBrief(gate, input) {
  const packet = gate?.evidencePacket || {};
  const blockers = [];
  const liveSend = packet.liveProviderSend ?? input.liveProviderSend;
  const terminalAck = packet.terminalAck ?? input.terminalAck;
  const dbMutation = packet.productionDbMutation ?? input.productionDbMutation;
  if (liveSend === true) blockers.push('live provider/Telegram send is forbidden in rehearsal');
  if (terminalAck === true) blockers.push('terminal ACK or terminal-outbox ACK is forbidden in rehearsal');
  if (dbMutation === true) blockers.push('production DB mutation is forbidden in rehearsal');
  if (!String(packet.mode || '').match(/^(no-live|rehearsal|projection-only)$/)) {
    blockers.push('Terminal Brief evidence must be mode no-live, rehearsal, or projection-only');
  }
  return blockers;
}

function validateReplayProof(gate) {
  const packet = gate?.evidencePacket || {};
  const blockers = [];
  if (!packet.idempotencyKey && !packet.dedupeKey) blockers.push('replay proof missing idempotencyKey/dedupeKey');
  if (!packet.manifestDigest) blockers.push('replay proof missing manifestDigest');
  if (Number(packet.replayAttemptCount || 0) < 2) blockers.push('replay proof must include at least two attempts');
  if (Number(packet.duplicateTerminalMarkers ?? 0) !== 0) blockers.push('replay proof created duplicate terminal markers');
  if (Number(packet.duplicateProviderSends ?? 0) !== 0) blockers.push('replay proof created duplicate provider sends');
  if (packet.manifestMismatchDecision && packet.manifestMismatchDecision !== 'NO_GO') {
    blockers.push('manifest mismatch must resolve to NO_GO');
  }
  return blockers;
}

function validateRollbackAbort(gate) {
  const packet = gate?.evidencePacket || {};
  const blockers = [];
  if (!packet.abortPath) blockers.push('rollback/abort plan missing abortPath');
  if (!packet.rollbackPath) blockers.push('rollback/abort plan missing rollbackPath');
  if (packet.noExecutionBeforeApproval !== true) blockers.push('rollback/abort plan must set noExecutionBeforeApproval=true');
  return blockers;
}

function validateInput(spec, input) {
  const gates = input.gates && typeof input.gates === 'object' ? input.gates : {};
  const blockers = [];

  for (const gateId of spec.requiredRehearsalGates || []) {
    const gate = gates[gateId];
    const status = asStatus(gate?.status);
    if (status !== 'GO') blockers.push({ gate: gateId, status, reason: `status is ${status}` });
    if (!hasEvidence(gate)) blockers.push({ gate: gateId, status, reason: 'redacted evidence link is missing' });
  }

  const domainChecks = {
    approvalPacket: validateApprovalPacket,
    integratedEvidenceBundle: validateIntegratedBundle,
    noLiveTerminalBriefRehearsal: (gate) => validateNoLiveTerminalBrief(gate, input),
    replayNoDuplicateProof: validateReplayProof,
    rollbackAbortPlan: validateRollbackAbort,
  };
  for (const [gateId, check] of Object.entries(domainChecks)) {
    for (const reason of check(gates[gateId] || {})) {
      blockers.push({ gate: gateId, status: asStatus(gates[gateId]?.status), reason });
    }
  }

  for (const { gateId, entry } of evidenceEntries(gates)) {
    for (const rule of unredactedEvidenceRules) {
      if (rule.re.test(entry)) blockers.push({ gate: gateId, status: asStatus(gates[gateId]?.status), reason: `evidence is not redacted (${rule.kind})` });
    }
  }

  const offendingPaths = findDenyPathReferences(spec, input, gates);
  for (const offendingPath of offendingPaths) {
    blockers.push({ gate: 'runtimeBootstrapHygiene', status: asStatus(gates.runtimeBootstrapHygiene?.status), reason: `runtime/bootstrap path would enter evidence: ${offendingPath}`, path: offendingPath });
  }

  for (const [field, reason] of [
    ['approvalExecution', 'approval execution is forbidden in rehearsal'],
    ['releasePublication', 'release publication is forbidden in rehearsal'],
    ['repositoryVisibilityChange', 'repository visibility change is forbidden in rehearsal'],
    ['productionDeploy', 'production deploy/restart is forbidden in rehearsal'],
    ['gatewayRestart', 'Gateway/broker/worker restart is forbidden in rehearsal'],
    ['terminalAck', 'terminal ACK is forbidden in rehearsal'],
    ['liveProviderSend', 'live provider/Telegram send is forbidden in rehearsal'],
    ['productionDbMutation', 'production DB mutation is forbidden in rehearsal'],
    ['forcePush', 'force-push/history rewrite is forbidden in rehearsal'],
  ]) {
    if (input[field] === true) blockers.push({ gate: 'safety', status: 'NO_GO', reason });
  }

  const operatorApproval = gates[spec.operatorApprovalGate || 'operatorApproval'];
  const operatorApprovalReady = asStatus(operatorApproval?.status) === 'GO' && hasEvidence(operatorApproval);
  const operatorEvidence = new Set((operatorApproval?.evidence || []).filter((entry) => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean));
  if (operatorApprovalReady) {
    for (const { gateId, entry } of evidenceEntries(gates)) {
      if (gateId !== spec.operatorApprovalGate && operatorEvidence.has(entry.trim())) {
        blockers.push({ gate: gateId, status: asStatus(gates[gateId]?.status), reason: `operator approval evidence must be separate from ${gateId}` });
      }
    }
  }

  const decision = blockers.length > 0 ? 'NO_GO' : operatorApprovalReady ? 'GO_CANDIDATE' : 'NEEDS_OPERATOR_APPROVAL';
  return {
    ok: blockers.length === 0,
    decision,
    sourcePublicExecution: 'NO_GO',
    approvalExecution: 'NOT_PERFORMED',
    blockers: blockers.sort((a, b) => `${a.gate}:${a.reason}`.localeCompare(`${b.gate}:${b.reason}`)),
    operatorApprovalReady,
    offendingPaths,
  };
}

export function buildApprovalRehearsalReport(spec, input) {
  const gates = input.gates && typeof input.gates === 'object' ? input.gates : {};
  const gateNames = new Map((spec.gates || []).map((gate) => [gate.id, gate.title]));
  const gateResults = [...(spec.requiredRehearsalGates || []), spec.operatorApprovalGate]
    .filter(Boolean)
    .map((gateId) => {
      const gate = gates[gateId];
      const status = asStatus(gate?.status);
      return {
        gate: gateId,
        title: gateNames.get(gateId) || gateId,
        status,
        ok: status === 'GO' && hasEvidence(gate),
        evidenceCount: Array.isArray(gate?.evidence) ? gate.evidence.filter((entry) => typeof entry === 'string' && entry.trim()).length : 0,
      };
    });

  const result = validateInput(spec, input);
  return {
    kind: 'a2a.source-public-approval-rehearsal-report',
    run: spec.run,
    lane: spec.lane,
    issue: spec.issue,
    parentIssue: spec.parentIssue,
    failClosed: spec.failClosed,
    defaultDecision: spec.defaultDecision,
    decision: result.decision,
    sourcePublicExecution: result.sourcePublicExecution,
    approvalExecution: result.approvalExecution,
    ok: result.ok,
    operatorApprovalReady: result.operatorApprovalReady,
    gateResults,
    blockers: result.blockers,
    offendingPaths: result.offendingPaths,
    requiredRehearsalGates: spec.requiredRehearsalGates,
  };
}

export function renderApprovalRehearsalMarkdown(report) {
  const title = report.decision === 'NO_GO' ? 'Block' : 'Done';
  const lines = [
    `${title}: A2A Nexus source-public approval rehearsal`,
    '',
    `Run: ${report.run}`,
    `Lane: ${report.lane}`,
    `Issue: ${report.issue}`,
    `Parent: ${report.parentIssue}`,
    `Decision: ${report.decision}`,
    `Source-public execution: ${report.sourcePublicExecution}`,
    `Approval execution: ${report.approvalExecution}`,
    '',
    '## Gate status',
    '',
    '| Gate | Status | Evidence |',
    '|------|--------|----------|',
    ...report.gateResults.map((gate) => `| ${gate.title} | ${gate.ok ? '✅ GO' : '❌ ' + gate.status} | ${gate.evidenceCount} link(s) |`),
    '',
  ];

  if (report.blockers.length > 0) {
    lines.push('## Blockers', '');
    for (const blocker of report.blockers) {
      const pathSuffix = blocker.path ? ` (${blocker.path})` : '';
      lines.push(`- **${blocker.gate}**: ${blocker.reason}${pathSuffix}`);
    }
    lines.push('');
  }

  lines.push(
    '## Safety',
    '',
    'This is a no-live rehearsal only. GO_CANDIDATE is not approval execution and does not authorize source-public execution.',
    'Provider-send success is non-ACK evidence only; no terminal ACK, terminal-outbox ACK, live provider send, deploy/restart, DB mutation, release, or visibility change is performed.',
    '',
  );
  return lines.join('\n');
}

try {
  const spec = readJson(path.resolve(values.spec));
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
      sourcePublicExecution: 'NO_GO',
      approvalExecution: 'NOT_PERFORMED',
      decisionStates: [...decisionStates],
      requiredRehearsalGates: spec.requiredRehearsalGates,
    }, null, 2));
    process.exit(0);
  }

  const report = buildApprovalRehearsalReport(spec, readJson(path.resolve(values.input)));
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
