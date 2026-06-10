import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const spec = 'docs/final-approval/source-public-final-go-nogo-gate-schema.json';
const script = 'scripts/a2a-source-public-final-go-nogo-gate.mjs';
const gateIds = [
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

function inputPath(input) {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-final-gate-'));
  const file = join(dir, 'evidence.json');
  writeFileSync(file, JSON.stringify(input, null, 2));
  return file;
}

function tmpPath(data, prefix = 'orchestrator-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const file = join(dir, 'report.json');
  writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

function run(input, orchestratorReport) {
  const args = [script, '--spec', spec, '--input', inputPath(input)];
  if (orchestratorReport) {
    args.push('--orchestrator', tmpPath(orchestratorReport));
  }
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
}

function runMarkdown(input, orchestratorReport) {
  const args = [script, '--spec', spec, '--input', inputPath(input), '--format', 'markdown'];
  if (orchestratorReport) {
    args.push('--orchestrator', tmpPath(orchestratorReport));
  }
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
}

/** Create a mock orchestrator report with the given decision and mode. */
function mockOrchestrator(overrides = {}) {
  return {
    kind: 'a2a.source-public-execution-orchestrator-report',
    decision: 'NEEDS_OPERATOR_APPROVAL',
    executionPlan: {
      executionMode: 'dry-run',
      idempotencyKey: 'a2a-exec-test...',
      idempotencyKeyHash: 'sha256:abc12345',
      actionManifest: [
        { step: 1, action: 'preflight-git-clean', targetRepo: 'a2a-plane', dryRunSafe: true },
        { step: 2, action: 'orchestrator-dry-run', targetRepo: 'a2a-plane', dryRunSafe: true },
      ],
      scannerBinding: {
        commitSha: 'a1b2c3d4e5f6',
        bindingTimestamp: new Date().toISOString(),
      },
      rollbackRunbook: { steps: [{ step: 1, action: 'Stop', detail: 'Halt' }] },
      abortRunbook: { failureModes: [{ when: 'error', abort: 'Post Block' }] },
      preflightChecks: {},
    },
    gateResults: [],
    blockers: [],
    ...overrides,
  };
}

/** All gates GO with unique evidence URLs and cross-lane evidence. */
function allGo(overrides = {}) {
  return {
    commitSha: 'a1b2c3d4e5f6',
    crossLaneEvidence: ['https://github.com/jinwon-int/a2a-plane/issues/226#cross-lane-evidence'],
    laneStatuses: {
      'a2a-plane': { status: 'GO', evidence: 'https://github.com/jinwon-int/a2a-plane/issues/226', timestamp: new Date().toISOString() },
      'openclaw-plugin-a2a': { status: 'GO', evidence: 'https://github.com/jinwon-int/a2a-plane/issues/265', timestamp: new Date().toISOString() },
      'a2a-docker-runner': { status: 'GO', evidence: 'https://github.com/jinwon-int/a2a-plane/issues/195', timestamp: new Date().toISOString() },
      'a2a-broker': { status: 'GO', evidence: 'https://github.com/jinwon-int/a2a-plane/issues/488', timestamp: new Date().toISOString() },
    },
    ciStatus: {
      build: 'PASS',
      test: 'PASS',
      lint: 'PASS',
      scanner: 'PASS',
      conformance: 'PASS',
      runId: 'ci-run-12345',
    },
    gates: Object.fromEntries(
      gateIds.map((id, index) => [
        id,
        {
          status: 'GO',
          evidence: [`https://github.com/jinwon-int/a2a-plane/issues/226#gate-${index + 1}`],
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
  assert.ok(parsed.requiredGates.includes('orchestratorPlanBinding'));
  assert.ok(parsed.requiredGates.includes('operatorApprovalPacket'));
  assert.ok(parsed.requiredGates.includes('aggregatedGateMatrix'));
  assert.ok(parsed.requiredGates.includes('releaseCandidateTagging'));
  assert.ok(parsed.requiredGates.includes('ciGateCapsule'));
  assert.ok(parsed.requiredGates.includes('crossLaneEvidenceBinding'));
});

test('spec-only mode rejects unsupported mode', () => {
  const result = spawnSync(process.execPath, [script, '--spec', spec, '--mode', 'execute'], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
  assert.notEqual(result.status, 0);
});

// ── GO decision ──────────────────────────────────────────────────

test('all gates GO with orchestrator NEEDS_OPERATOR_APPROVAL yields GO', () => {
  const input = allGo();
  const orchestratorReport = mockOrchestrator();
  const result = run(input, orchestratorReport);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'GO');
  assert.equal(parsed.sourcePublicExecution, 'NO_GO');
  assert.equal(parsed.blockers.length, 0);
});

test('GO output includes final approval packet', () => {
  const input = allGo();
  const orchestratorReport = mockOrchestrator();
  const result = run(input, orchestratorReport);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  const pkt = parsed.approvalPacket;
  assert.ok(pkt, 'approval packet must exist');
  assert.ok(pkt.packetId, 'packet must have id');
  assert.ok(pkt.manifestDigest, 'packet must have manifest digest');
  assert.ok(pkt.summary, 'packet must have summary');
  assert.equal(pkt.summary.totalGates, gateIds.length);
  assert.equal(pkt.summary.blockedGates, 0);
  assert.ok(pkt.operatorApprovalRequired, 'operator approval must be required');
});

// ── GO/NO-GO matrix ──────────────────────────────────────────────

test('GO output includes per-repo GO/NO-GO matrix', () => {
  const input = allGo();
  const orchestratorReport = mockOrchestrator();
  const result = run(input, orchestratorReport);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  const matrix = parsed.approvalPacket.gateMatrix;
  assert.ok(Array.isArray(matrix), 'gate matrix must be an array');
  assert.ok(matrix.length >= 4, 'matrix must cover all round lanes');

  const repos = matrix.map((l) => l.repo);
  assert.ok(repos.includes('a2a-plane'));
  assert.ok(repos.includes('openclaw-plugin-a2a'));
  assert.ok(repos.includes('a2a-docker-runner'));
  assert.ok(repos.includes('a2a-broker'));

  for (const lane of matrix) {
    assert.ok(lane.owner, 'each lane must have an owner');
    assert.ok(lane.status, 'each lane must have a status');
    assert.ok(lane.issue, 'each lane must have an issue link');
  }
});

// ── Release candidate tagging ────────────────────────────────────

test('GO output includes release candidate tagging', () => {
  const input = allGo();
  const orchestratorReport = mockOrchestrator();
  const result = run(input, orchestratorReport);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  const rc = parsed.approvalPacket.releaseCandidateTagging;
  assert.ok(rc, 'release candidate tagging must exist');
  assert.ok(rc.ready, 'RC tagging must be ready when commit SHA and orchestrator are present');
  assert.ok(rc.tagName, 'RC tag must have a name');
  assert.ok(rc.tagName.startsWith('a2a-plane-rc-'));
  assert.ok(rc.commitSha);
  assert.ok(rc.note.includes('does not imply release'), 'must include safety note');
});

test('release candidate tagging is not ready without commit SHA', () => {
  const input = allGo();
  delete input.commitSha;
  const orchestratorReport = mockOrchestrator({ executionPlan: { ...mockOrchestrator().executionPlan, scannerBinding: { commitSha: undefined } } });
  const result = run(input, orchestratorReport);
  const parsed = JSON.parse(result.status === 0 ? result.stdout : result.stderr);
  assert.equal(parsed.approvalPacket.releaseCandidateTagging.ready, false);
});

// ── CI gate capsule ──────────────────────────────────────────────

test('GO output includes CI gate capsule', () => {
  const input = allGo();
  const orchestratorReport = mockOrchestrator();
  const result = run(input, orchestratorReport);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  const ci = parsed.approvalPacket.ciGateCapsule;
  assert.ok(ci, 'CI gate capsule must exist');
  assert.ok(ci.ready, 'CI capsule must be ready when all checks pass');
  assert.ok(ci.checks.length >= 5);
  assert.ok(ci.checks.some((c) => c.name === 'build'));
  assert.ok(ci.checks.some((c) => c.name === 'test'));
  assert.ok(ci.checks.some((c) => c.name === 'scanner'));
  assert.ok(ci.checks.some((c) => c.name === 'conformance'));
});

test('CI gate capsule is not ready when any check fails', () => {
  const input = allGo();
  input.ciStatus = { build: 'PASS', test: 'FAIL', lint: 'PASS', scanner: 'PASS', conformance: 'PASS' };
  const orchestratorReport = mockOrchestrator();
  const result = run(input, orchestratorReport);
  const parsed = JSON.parse(result.status === 0 ? result.stdout : result.stderr);
  assert.equal(parsed.approvalPacket.ciGateCapsule.ready, false);
});

// ── NO_GO decision ───────────────────────────────────────────────

test('any gate MISSING yields NO_GO', () => {
  const input = allGo({ orchestratorPlanBinding: { status: 'MISSING', evidence: [] } });
  const orchestratorReport = mockOrchestrator();
  const result = run(input, orchestratorReport);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.decision, 'NO_GO');
});

test('missing cross-lane evidence yields NO_GO', () => {
  const input = allGo();
  input.crossLaneEvidence = [];
  const orchestratorReport = mockOrchestrator();
  const result = run(input, orchestratorReport);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((b) => b.gate === 'crossLaneEvidenceBinding'));
});

test('orchestrator with NO_GO decision yields NO_GO', () => {
  const input = allGo();
  const orchestratorReport = mockOrchestrator({ decision: 'NO_GO' });
  const result = run(input, orchestratorReport);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((b) => b.gate === 'orchestratorPlanBinding' &&
    b.reason.includes('NO_GO')));
});

// ── BLOCKED decision ─────────────────────────────────────────────

test('unredacted evidence yields BLOCKED', () => {
  const input = allGo();
  input.gates.scannerHistoryBinding.evidence = ['/home/user/secret.key'];
  const orchestratorReport = mockOrchestrator();
  const result = run(input, orchestratorReport);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.decision, 'BLOCKED');
  assert.ok(parsed.blockers.some((b) => b.reason && b.reason.includes('absolute-private-path')));
});

test('raw session dump in evidence yields BLOCKED', () => {
  const input = allGo();
  input.gates.scannerHistoryBinding.evidence = ['assistant <| raw session context here'];
  const orchestratorReport = mockOrchestrator();
  const result = run(input, orchestratorReport);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.decision, 'BLOCKED');
  assert.ok(parsed.blockers.some((b) => b.reason && b.reason.includes('raw-session-dump')));
});

// ── Source-public execution remains NO_GO ────────────────────────

test('source-public execution is NO_GO even in GO decision', () => {
  const input = allGo();
  const orchestratorReport = mockOrchestrator();
  const result = run(input, orchestratorReport);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'GO');
  assert.equal(parsed.sourcePublicExecution, 'NO_GO');
});

test('source-public execution is NO_GO in NO_GO decision', () => {
  const input = allGo({ orchestratorPlanBinding: { status: 'MISSING', evidence: [] } });
  const orchestratorReport = mockOrchestrator();
  const result = run(input, orchestratorReport);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.sourcePublicExecution, 'NO_GO');
});

// ── Orchestrator binding ─────────────────────────────────────────

test('report binds to orchestrator plan id', () => {
  const input = allGo();
  const orchestratorReport = mockOrchestrator();
  const result = run(input, orchestratorReport);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.orchestratorDecision, 'NEEDS_OPERATOR_APPROVAL');
  assert.equal(parsed.orchestratorPlanBinding, 'sha256:abc12345');
});

// ── Idempotency ──────────────────────────────────────────────────

test('identical input produces identical approval packet', () => {
  const input = allGo();
  const orchestratorReport = mockOrchestrator();
  const result1 = run(input, orchestratorReport);
  const result2 = run(input, orchestratorReport);
  assert.equal(result1.status, result2.status);
  const pkt1 = JSON.parse(result1.stdout).approvalPacket;
  const pkt2 = JSON.parse(result2.stdout).approvalPacket;
  assert.equal(pkt1.packetId, pkt2.packetId);
  assert.equal(pkt1.manifestDigest, pkt2.manifestDigest);
  assert.equal(pkt1.summary.totalGates, pkt2.summary.totalGates);
  assert.equal(pkt1.gateMatrix.length, pkt2.gateMatrix.length);
});

// ── Safety: no live actions ──────────────────────────────────────

test('approval packet never contains live action authorization', () => {
  const input = allGo();
  const orchestratorReport = mockOrchestrator();
  const result = run(input, orchestratorReport);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  const pkt = parsed.approvalPacket;
  // The note fields say what they do NOT do — skip those. Check structural fields only.
  const pktCore = JSON.stringify({
    packetId: pkt.packetId,
    summary: pkt.summary,
    orchestratorPlanBinding: pkt.orchestratorPlanBinding,
    gateMatrix: pkt.gateMatrix,
    blockedGateDetails: pkt.blockedGateDetails,
    operatorApprovalRequired: pkt.operatorApprovalRequired,
  });
  assert.doesNotMatch(pktCore, /deploy/);
  assert.doesNotMatch(pktCore, /restart.gateway/i);
  assert.doesNotMatch(pktCore, /terminal.ack/i);
  assert.doesNotMatch(pktCore, /mutate.db/i);
  assert.doesNotMatch(pktCore, /force.push/i);
  assert.ok(pkt.operatorApprovalRequired);
});

// ── Markdown output ──────────────────────────────────────────────

test('markdown format produces final gate report for GO', () => {
  const input = allGo();
  const orchestratorReport = mockOrchestrator();
  const result = runMarkdown(input, orchestratorReport);
  assert.equal(result.status, 0);
  const out = result.stdout;
  assert.ok(out.includes('A2A Nexus final go/no-go gate report'));
  assert.ok(out.includes('GO'));
  assert.ok(out.includes('Final Operator Approval Packet'));
  assert.ok(out.includes('Per-Repo GO/NO-GO Matrix'));
  assert.ok(out.includes('Release Candidate Tagging'));
  assert.ok(out.includes('CI Gate Capsule'));
  assert.ok(out.includes('Gate Status'));
  assert.ok(out.includes('NO_GO'));
});

test('markdown format for NO_GO shows blockers', () => {
  const input = allGo({ aggregatedGateMatrix: { status: 'MISSING', evidence: [] } });
  const orchestratorReport = mockOrchestrator();
  const result = runMarkdown(input, orchestratorReport);
  const out = result.stdout || result.stderr;
  assert.ok(out.includes('NO_GO'));
  assert.ok(out.includes('Blockers'));
});

// ── Null input ───────────────────────────────────────────────────

test('empty gates yields NO_GO', () => {
  const input = { gates: {}, crossLaneEvidence: [] };
  const orchestratorReport = mockOrchestrator();
  const result = run(input, orchestratorReport);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.decision, 'NO_GO');
  assert.ok(parsed.blockers.length > 0);
});

// ── Approval packet safety note ──────────────────────────────────

test('approval packet includes operator-approval-required flag', () => {
  const input = allGo();
  const orchestratorReport = mockOrchestrator();
  const result = run(input, orchestratorReport);
  const parsed = JSON.parse(result.status === 0 ? result.stdout : result.stderr);
  assert.equal(parsed.approvalPacket.operatorApprovalRequired, true);
});

test('approval packet note warns against execution inference', () => {
  const input = allGo();
  const orchestratorReport = mockOrchestrator();
  const result = run(input, orchestratorReport);
  const parsed = JSON.parse(result.status === 0 ? result.stdout : result.stderr);
  assert.ok(parsed.approvalPacket.note.includes('Operator approval is a separate explicit action'));
});
