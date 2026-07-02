import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const spec = 'docs/execution-orchestrator/source-public-execution-orchestrator-schema.json';
const script = 'scripts/a2a-source-public-execution-orchestrator.mjs';
const gateIds = [
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

function inputPath(input) {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-exec-orch-'));
  const file = join(dir, 'evidence.json');
  writeFileSync(file, JSON.stringify(input, null, 2));
  return file;
}

function run(input) {
  return spawnSync(process.execPath, [script, '--spec', spec, '--input', inputPath(input)], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
}

function runMarkdown(input) {
  return spawnSync(process.execPath, [script, '--spec', spec, '--input', inputPath(input), '--format', 'markdown'], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
}

/** All gates GO with unique evidence URLs. */
function allGo(overrides = {}) {
  return {
    decision: 'GO_CANDIDATE',
    approvalPacketHash: 'abc123def456',
    commitSha: 'a1b2c3d4e5f6',
    gates: Object.fromEntries(
      gateIds.map((id, index) => [
        id,
        {
          status: 'GO',
          evidence: [`a2a-plane#219 (internal tracker, private)#gate-${index + 1}`],
          ...overrides[id],
        },
      ]),
    ),
  };
}

// ── Spec validation ──────────────────────────────────────────────

test('spec-only mode prints default NO_GO with required gates', () => {
  const result = spawnSync(process.execPath, [script, '--spec', spec], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'NO_GO');
  assert.equal(parsed.sourcePublicExecution, 'NO_GO');
  assert.ok(Array.isArray(parsed.requiredGates));
  assert.ok(parsed.requiredGates.includes('operatorExecutionGate'));
  assert.ok(parsed.decisionOutputs.includes('GO_CANDIDATE'));
  assert.ok(parsed.decisionOutputs.includes('NO_GO'));
  assert.ok(parsed.decisionOutputs.includes('NEEDS_OPERATOR_APPROVAL'));
  assert.equal(parsed.executionMode, 'dry-run');
});

test('spec-only mode respects explicit mode flag', () => {
  const result = spawnSync(process.execPath, [script, '--spec', spec, '--mode', 'simulate'], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.executionMode, 'simulate');
});

test('spec-only mode rejects unsupported execution mode', () => {
  const result = spawnSync(process.execPath, [script, '--spec', spec, '--mode', 'execute'], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
  assert.notEqual(result.status, 0);
});

// ── Decision output: GO_CANDIDATE ─────────────────────────────────

test('all gates GO with operator execution gate GO yields GO_CANDIDATE', () => {
  const input = allGo({
    operatorExecutionGate: {
      status: 'GO',
      evidence: ['a2a-plane#219 (internal tracker, private)#explicit-operator-execution-approval'],
    },
  });
  const result = run(input);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'GO_CANDIDATE');
  assert.equal(parsed.sourcePublicExecution, 'NO_GO');
  assert.equal(parsed.blockers.length, 0);
});

// ── Decision output: NEEDS_OPERATOR_APPROVAL ──────────────────────

test('all gates GO except operatorExecutionGate yields NEEDS_OPERATOR_APPROVAL', () => {
  const input = allGo({
    operatorExecutionGate: { status: 'MISSING', evidence: [] },
  });
  const result = run(input);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'NEEDS_OPERATOR_APPROVAL');
  assert.equal(parsed.sourcePublicExecution, 'NO_GO');
});

test('NEEDS_OPERATOR_APPROVAL with operator gate WAITING', () => {
  const input = allGo({
    operatorExecutionGate: { status: 'WAITING', evidence: ['https://example.com/waiting'] },
  });
  const result = run(input);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'NEEDS_OPERATOR_APPROVAL');
});

// ── Execution plan generation ─────────────────────────────────────

test('execution plan includes action manifest with dry-run steps', () => {
  const input = allGo({
    operatorExecutionGate: { status: 'MISSING', evidence: [] },
  });
  const result = run(input);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  const plan = parsed.executionPlan;
  assert.ok(plan, 'execution plan must exist');
  assert.equal(plan.executionMode, 'dry-run');
  assert.ok(plan.actionManifest.length >= 5, 'action manifest must have at least 5 steps');
  assert.ok(plan.actionManifest.every((a) => a.dryRunSafe === true), 'all actions must be dry-run safe');

  // Verify preflight checks
  assert.ok(plan.preflightChecks.gitClean);
  assert.ok(plan.preflightChecks.scannerPass);
  assert.ok(plan.preflightChecks.bootstrapHygiene);
  assert.ok(plan.preflightChecks.approvalPacketLocked);
  assert.ok(plan.preflightChecks.idempotencyNoCollision);

  // Verify rollback runbook
  assert.ok(plan.rollbackRunbook);
  assert.ok(plan.rollbackRunbook.steps.length >= 3);
  plan.rollbackRunbook.steps.forEach((s) => {
    assert.ok(s.step, 'each rollback step must have a step number');
    assert.ok(s.action, 'each rollback step must have an action');
    assert.ok(s.detail, 'each rollback step must have detail');
  });

  // Verify abort runbook
  assert.ok(plan.abortRunbook);
  assert.ok(plan.abortRunbook.failureModes.length >= 5);
  plan.abortRunbook.failureModes.forEach((fm) => {
    assert.ok(fm.when, 'each failure mode must have a when');
    assert.ok(fm.abort, 'each failure mode must have an abort procedure');
  });

  // No abort procedure references live actions
  const abortText = plan.abortRunbook.failureModes.map((fm) => fm.abort).join(' ');
  assert.ok(!abortText.includes('deploy'), 'abort must not deploy');
  assert.ok(!abortText.includes('restart'), 'abort must not restart');
  assert.ok(!abortText.includes('ACK'), 'abort must not ACK');
});

test('execution plan with operator approval is simulate mode', () => {
  const input = allGo({
    operatorExecutionGate: {
      status: 'GO',
      evidence: ['a2a-plane#219 (internal tracker, private)#operator-execution-approval'],
    },
  });
  const result = run(input);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.executionPlan.executionMode, 'simulate');
  assert.ok(parsed.executionPlan.actionManifest.some((a) => a.action === 'orchestrator-simulate'),
    'simulate step must be in action manifest');
});

test('execution plan includes idempotency key', () => {
  const input = allGo({
    operatorExecutionGate: { status: 'MISSING', evidence: [] },
  });
  const result = run(input);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.executionPlan.idempotencyKey, 'idempotency key must exist');
  assert.ok(parsed.executionPlan.idempotencyKeyHash, 'idempotency key hash must exist');
  assert.ok(parsed.executionPlan.idempotencyKey.includes('...'), 'idempotency key must be redacted');
});

test('execution plan includes scanner binding', () => {
  const input = allGo({
    operatorExecutionGate: { status: 'MISSING', evidence: [] },
  });
  const result = run(input);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.executionPlan.scannerBinding.boundToExecutionPlan);
  assert.ok(parsed.executionPlan.scannerBinding.commitSha);
  assert.ok(parsed.executionPlan.scannerBinding.bindingTimestamp);
});

test('operator execution gate is always last action', () => {
  const input = allGo({
    operatorExecutionGate: { status: 'MISSING', evidence: [] },
  });
  const result = run(input);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  const actions = parsed.executionPlan.actionManifest;
  const lastAction = actions[actions.length - 1];
  assert.equal(lastAction.action, 'operator-execution-gate',
    'operator execution gate must be the last action in manifest');
});

// ── Decision output: NO_GO ────────────────────────────────────────

test('any non-operator gate MISSING yields NO_GO', () => {
  const input = allGo({
    approvalPacketLocked: { status: 'MISSING', evidence: [] },
    operatorExecutionGate: {
      status: 'GO',
      evidence: ['a2a-plane#219 (internal tracker, private)#approval'],
    },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.decision, 'NO_GO');
});

test('orchestrator-specific gate MISSING yields NO_GO', () => {
  const input = allGo({
    executionPlanIntegrity: { status: 'MISSING', evidence: [] },
    operatorExecutionGate: {
      status: 'GO',
      evidence: ['a2a-plane#219 (internal tracker, private)#approval'],
    },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.decision, 'NO_GO');
});

test('scannerHistoryBinding missing yields NO_GO', () => {
  const input = allGo({
    scannerHistoryBinding: { status: 'MISSING', evidence: [] },
    operatorExecutionGate: {
      status: 'GO',
      evidence: ['a2a-plane#219 (internal tracker, private)#approval'],
    },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.decision, 'NO_GO');
});

test('rollbackAbortRunbook missing yields NO_GO', () => {
  const input = allGo({
    rollbackAbortRunbook: { status: 'MISSING', evidence: [] },
    operatorExecutionGate: {
      status: 'GO',
      evidence: ['a2a-plane#219 (internal tracker, private)#approval'],
    },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.decision, 'NO_GO');
});

test('idempotencyReplayProtection missing yields NO_GO', () => {
  const input = allGo({
    idempotencyReplayProtection: { status: 'MISSING', evidence: [] },
    operatorExecutionGate: {
      status: 'GO',
      evidence: ['a2a-plane#219 (internal tracker, private)#approval'],
    },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.decision, 'NO_GO');
});

test('preflightFailureSemantics missing yields NO_GO', () => {
  const input = allGo({
    preflightFailureSemantics: { status: 'MISSING', evidence: [] },
    operatorExecutionGate: {
      status: 'GO',
      evidence: ['a2a-plane#219 (internal tracker, private)#approval'],
    },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.decision, 'NO_GO');
});

test('actionManifestDeterminism missing yields NO_GO', () => {
  const input = allGo({
    actionManifestDeterminism: { status: 'MISSING', evidence: [] },
    operatorExecutionGate: {
      status: 'GO',
      evidence: ['a2a-plane#219 (internal tracker, private)#approval'],
    },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.decision, 'NO_GO');
});

test('crossBrokerHandoffEvidence missing yields NO_GO', () => {
  const input = allGo({
    crossBrokerHandoffEvidence: { status: 'MISSING', evidence: [] },
    operatorExecutionGate: {
      status: 'GO',
      evidence: ['a2a-plane#219 (internal tracker, private)#approval'],
    },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.decision, 'NO_GO');
});

// ── Domain validation with evidence packets ──────────────────────

test('broker readiness GO validates evidence packet', () => {
  const input = allGo({
    brokerReadiness: {
      status: 'GO',
      evidence: ['a2a-plane#219 (internal tracker, private)#broker'],
      evidencePacket: {
        health: { ok: true },
        expectedWorkers: ['workerGamma'],
        onlineWorkerIds: ['workerGamma'],
        queue: { queued: 0, claimed: 0, running: 0 },
        stale: 0,
      },
    },
    operatorExecutionGate: {
      status: 'GO',
      evidence: ['a2a-plane#219 (internal tracker, private)#operator-execution-approval'],
    },
  });
  const result = run(input);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'GO_CANDIDATE');
});

test('broker readiness fails on non-zero queue', () => {
  const input = allGo({
    brokerReadiness: {
      status: 'GO',
      evidence: ['a2a-plane#219 (internal tracker, private)#broker'],
      evidencePacket: {
        health: { ok: true },
        expectedWorkers: [],
        onlineWorkerIds: [],
        queue: { queued: 5, claimed: 2, running: 1 },
        stale: 1,
      },
    },
    operatorExecutionGate: {
      status: 'GO',
      evidence: ['a2a-plane#219 (internal tracker, private)#approval'],
    },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((b) => b.gate === 'brokerReadiness' && b.reason.includes('queued=5')));
});

test('plugin readiness fails when live Telegram is configured', () => {
  const input = allGo({
    pluginReadiness: {
      status: 'GO',
      evidence: ['a2a-plane#219 (internal tracker, private)#plugin'],
      evidencePacket: { liveTelegramConfigured: true },
    },
    operatorExecutionGate: {
      status: 'GO',
      evidence: ['a2a-plane#219 (internal tracker, private)#approval'],
    },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((b) => b.gate === 'pluginReadiness' && b.reason.includes('live Telegram')));
});

test('runner readiness fails when production deploy flag is set', () => {
  const input = allGo({
    runnerReadiness: {
      status: 'GO',
      evidence: ['a2a-plane#219 (internal tracker, private)#runner'],
      evidencePacket: {
        artifactManifest: { ok: true },
        scannerProfile: { ok: true },
        productionDeploy: true,
      },
    },
    operatorExecutionGate: {
      status: 'GO',
      evidence: ['a2a-plane#219 (internal tracker, private)#approval'],
    },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((b) => b.gate === 'runnerReadiness' && b.reason.includes('production deploy')));
});

// ── Redaction checks ─────────────────────────────────────────────

test('GO_CANDIDATE fails when evidence contains unredacted private path', () => {
  const unsafePath = '/home/operator/private-key.pem';
  const input = allGo({
    scannerHistoryBinding: { status: 'GO', evidence: [unsafePath] },
    operatorExecutionGate: {
      status: 'GO',
      evidence: ['a2a-plane#219 (internal tracker, private)#approval'],
    },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((b) => b.reason && b.reason.includes('absolute-private-path')));
});

test('GO_CANDIDATE fails when evidence contains raw session dump markers', () => {
  const dumpLine = 'assistant <| this is raw context';
  const input = allGo({
    scannerHistoryBinding: { status: 'GO', evidence: [dumpLine] },
    operatorExecutionGate: {
      status: 'GO',
      evidence: ['a2a-plane#219 (internal tracker, private)#approval'],
    },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((b) => b.reason && b.reason.includes('raw-session-dump')));
});

// ── Source-public execution remains NO_GO ────────────────────────

test('source-public execution is NO_GO when any gate is missing', () => {
  const input = allGo({
    operatorExecutionGate: { status: 'MISSING', evidence: [] },
  });
  const result = run(input);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.sourcePublicExecution, 'NO_GO');
});

test('source-public execution is NO_GO even in GO_CANDIDATE', () => {
  const input = allGo({
    operatorExecutionGate: {
      status: 'GO',
      evidence: ['a2a-plane#219 (internal tracker, private)#explicit-operator-execution-approval'],
    },
  });
  const result = run(input);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'GO_CANDIDATE');
  assert.equal(parsed.sourcePublicExecution, 'NO_GO');
});

// ── NO_GO is a valid fail-closed outcome ─────────────────────────

test('NO_GO is a valid fail-closed outcome with unresolved gates', () => {
  const input = {
    decision: 'NO_GO',
    gates: {
      approvalPacketLocked: { status: 'GO', evidence: ['a2a-plane#219 (internal tracker, private)#locked'] },
    },
  };
  const result = run(input);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'NO_GO');
  assert.equal(parsed.sourcePublicExecution, 'NO_GO');
  assert.ok(parsed.blockers.length > 0);
});

// ── Markdown output ──────────────────────────────────────────────

test('markdown format produces deterministic report for NO_GO', () => {
  const input = {
    decision: 'NO_GO',
    gates: {
      approvalPacketLocked: { status: 'GO', evidence: ['a2a-plane#219 (internal tracker, private)#locked'] },
      executionPlanIntegrity: { status: 'GO', evidence: ['a2a-plane#219 (internal tracker, private)#integrity'] },
    },
  };
  const result = runMarkdown(input);
  const out = result.stdout || result.stderr;
  assert.ok(out.includes('A2A Nexus source-public execution orchestrator report'));
  assert.ok(out.includes('NO_GO'));
  assert.ok(out.includes('## Gate status'));
  assert.ok(out.includes('Execution Plan'));
  assert.ok(out.includes('Action Manifest'));
  assert.ok(out.includes('Scanner Binding'));
  assert.ok(out.includes('Rollback Runbook'));
  assert.ok(out.includes('Abort Runbook'));
  assert.ok(out.includes('Preflight Checks'));
});

test('markdown output for GO_CANDIDATE shows execution plan ready', () => {
  const input = allGo({
    operatorExecutionGate: {
      status: 'GO',
      evidence: ['a2a-plane#219 (internal tracker, private)#operator-execution-approval'],
    },
  });
  const result = runMarkdown(input);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes('GO_CANDIDATE'));
  assert.ok(result.stdout.includes('Execution plan ready'));
  assert.ok(result.stdout.includes('simulate'));
});

test('markdown output for NEEDS_OPERATOR_APPROVAL shows operator sign-off required', () => {
  const input = allGo({
    operatorExecutionGate: { status: 'MISSING', evidence: [] },
  });
  const result = runMarkdown(input);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes('NEEDS_OPERATOR_APPROVAL'));
  assert.ok(result.stdout.includes('operator sign-off required'));
});

// ── Execution plan determinism ────────────────────────────────────

test('identical input produces identical execution plan', () => {
  const input = allGo({
    operatorExecutionGate: { status: 'MISSING', evidence: [] },
    approvalPacketLocked: {
      status: 'GO',
      evidence: ['a2a-plane#219 (internal tracker, private)#locked'],
      packetHash: 'abc123',
    },
  });

  const result1 = run(input);
  const result2 = run(input);

  assert.equal(result1.status, result2.status);
  const plan1 = JSON.parse(result1.stdout).executionPlan;
  const plan2 = JSON.parse(result2.stdout).executionPlan;

  // Execution mode must be deterministic
  assert.equal(plan1.executionMode, plan2.executionMode);
  // Action count must be deterministic
  assert.equal(plan1.actionManifest.length, plan2.actionManifest.length);
  // Rollback steps must be deterministic
  assert.equal(plan1.rollbackRunbook.steps.length, plan2.rollbackRunbook.steps.length);
  // Abort failure modes must be deterministic
  assert.equal(plan1.abortRunbook.failureModes.length, plan2.abortRunbook.failureModes.length);
  // Preflight checks must be deterministic
  assert.equal(Object.keys(plan1.preflightChecks).length, Object.keys(plan2.preflightChecks).length);
});

// ── Safety: execution mode is always dry-run/simulate ─────────────

test('dry-run execution plan never contains live actions', () => {
  const input = allGo({
    operatorExecutionGate: { status: 'MISSING', evidence: [] },
  });
  const result = run(input);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  const plan = parsed.executionPlan;
  assert.ok(['dry-run', 'simulate'].includes(plan.executionMode));

  // Every action must be dryRunSafe
  for (const action of plan.actionManifest) {
    assert.equal(action.dryRunSafe, true,
      `action "${action.action}" must be dry-run safe`);
  }

  // Abort runbook must not contain live actions
  const allAbortText = plan.abortRunbook.failureModes.map((fm) => fm.abort).join(' ');
  assert.doesNotMatch(allAbortText, /deploy/);
  assert.doesNotMatch(allAbortText, /restart Gateway/);
  assert.doesNotMatch(allAbortText, /send.*Telegram/);
  assert.doesNotMatch(allAbortText, /ACK/);
  assert.doesNotMatch(allAbortText, /mutate.*DB/);
  assert.doesNotMatch(allAbortText, /force.push/);
  assert.doesNotMatch(allAbortText, /visibility change/);
});

// ── Fixture validation ───────────────────────────────────────────

test('team1-workerGamma execution orchestrator fixture yields NEEDS_OPERATOR_APPROVAL', () => {
  const result = spawnSync(process.execPath, [
    script,
    '--spec', spec,
    '--input', 'fixtures/execution-orchestrator/team1-workerGamma-execution-plan-evidence.json',
  ], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'NEEDS_OPERATOR_APPROVAL');
  assert.equal(parsed.sourcePublicExecution, 'NO_GO');
  assert.ok(parsed.executionPlan);
  assert.equal(parsed.executionPlan.executionMode, 'dry-run');
});

// ── Null/empty evidence input ────────────────────────────────────

test('null evidence packet is treated as missing all gates', () => {
  const input = {
    decision: 'GO_CANDIDATE',
    gates: {},
  };
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.decision, 'NO_GO');
  assert.ok(parsed.blockers.length > 0);
});
