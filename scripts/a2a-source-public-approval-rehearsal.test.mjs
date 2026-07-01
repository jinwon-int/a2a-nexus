import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const spec = 'docs/approval-rehearsal/source-public-approval-packet-schema.json';
const script = 'scripts/a2a-source-public-approval-rehearsal.mjs';
const gateIds = [
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

function inputPath(input) {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-approval-rehearsal-'));
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
    gates: Object.fromEntries(
      gateIds.map((id, index) => [
        id,
        {
          status: 'GO',
          evidence: [`a2a-plane#212 (internal tracker, private)#gate-${index + 1}`],
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
  assert.ok(parsed.requiredGates.includes('operatorApproval'));
  assert.ok(parsed.decisionOutputs.includes('GO_CANDIDATE'));
  assert.ok(parsed.decisionOutputs.includes('NO_GO'));
  assert.ok(parsed.decisionOutputs.includes('NEEDS_OPERATOR_APPROVAL'));
});

// ── Decision output: GO_CANDIDATE ─────────────────────────────────

test('all gates GO with operator approval yields GO_CANDIDATE', () => {
  const input = allGo({
    operatorApproval: {
      status: 'GO',
      evidence: ['a2a-plane#212 (internal tracker, private)#explicit-operator-approval'],
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

test('all gates GO except operatorApproval yields NEEDS_OPERATOR_APPROVAL', () => {
  const input = allGo({
    operatorApproval: { status: 'MISSING', evidence: [] },
  });
  const result = run(input);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'NEEDS_OPERATOR_APPROVAL');
  assert.equal(parsed.sourcePublicExecution, 'NO_GO');
});

test('NEEDS_OPERATOR_APPROVAL with operator gate not GO', () => {
  const input = allGo({
    operatorApproval: { status: 'WAITING', evidence: ['https://example.com/waiting'] },
  });
  const result = run(input);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'NEEDS_OPERATOR_APPROVAL');
});

// ── Decision output: NO_GO ────────────────────────────────────────

test('any non-operator gate MISSING yields NO_GO', () => {
  const input = allGo({
    brokerReadiness: { status: 'MISSING', evidence: [] },
    operatorApproval: {
      status: 'GO',
      evidence: ['a2a-plane#212 (internal tracker, private)#approval'],
    },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.decision, 'NO_GO');
});

test('any non-operator gate MISSING without operator yields NO_GO', () => {
  const input = allGo({
    brokerReadiness: { status: 'MISSING', evidence: [] },
    operatorApproval: { status: 'MISSING', evidence: [] },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.decision, 'NO_GO');
});

// ── Approval rehearsal-specific gates ─────────────────────────────

test('approvalPacketIntegrity missing yields NO_GO', () => {
  const input = allGo({
    approvalPacketIntegrity: { status: 'MISSING', evidence: [] },
    operatorApproval: {
      status: 'GO',
      evidence: ['a2a-plane#212 (internal tracker, private)#approval'],
    },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.decision, 'NO_GO');
});

test('rehearsalIdempotencyProof missing yields NO_GO', () => {
  const input = allGo({
    rehearsalIdempotencyProof: { status: 'MISSING', evidence: [] },
    operatorApproval: {
      status: 'GO',
      evidence: ['a2a-plane#212 (internal tracker, private)#approval'],
    },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.decision, 'NO_GO');
});

test('rollbackAbortPath missing yields NO_GO', () => {
  const input = allGo({
    rollbackAbortPath: { status: 'MISSING', evidence: [] },
    operatorApproval: {
      status: 'GO',
      evidence: ['a2a-plane#212 (internal tracker, private)#approval'],
    },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.decision, 'NO_GO');
});

// ── Fail-closed: missing gates ───────────────────────────────────

test('GO_CANDIDATE fails closed when broker readiness is missing', () => {
  const input = allGo({ brokerReadiness: { status: 'MISSING', evidence: [] } });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.decision, 'NO_GO');
  assert.ok(parsed.blockers.some((b) => b.gate === 'brokerReadiness' && b.status === 'MISSING'));
});

test('GO_CANDIDATE fails closed when runner readiness is missing', () => {
  const input = allGo({ runnerReadiness: { status: 'MISSING', evidence: [] } });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((b) => b.gate === 'runnerReadiness'));
});

test('GO_CANDIDATE fails closed when plugin readiness is missing', () => {
  const input = allGo({ pluginReadiness: { status: 'MISSING', evidence: [] } });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((b) => b.gate === 'pluginReadiness'));
});

test('GO_CANDIDATE fails closed when external scanner evidence is missing', () => {
  const input = allGo({ externalScannerEvidence: { status: 'MISSING', evidence: [] } });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((b) => b.gate === 'externalScannerEvidence'));
});

// ── Domain validation with evidence packets ──────────────────────

test('broker readiness GO validates evidence packet health/workers/queue', () => {
  const input = allGo({
    brokerReadiness: {
      status: 'GO',
      evidence: ['a2a-plane#212 (internal tracker, private)#broker'],
      evidencePacket: {
        health: { ok: true },
        expectedWorkers: ['bangtong'],
        onlineWorkerIds: ['bangtong'],
        queue: { queued: 0, claimed: 0, running: 0 },
        stale: 0,
      },
    },
    operatorApproval: {
      status: 'GO',
      evidence: ['a2a-plane#212 (internal tracker, private)#approval-explicit'],
    },
  });
  const result = run(input);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'GO_CANDIDATE');
  assert.ok(!parsed.blockers.some((b) => b.gate === 'brokerReadiness'));
});

test('broker readiness fails on non-zero queue', () => {
  const input = allGo({
    brokerReadiness: {
      status: 'GO',
      evidence: ['a2a-plane#212 (internal tracker, private)#broker'],
      evidencePacket: {
        health: { ok: true },
        expectedWorkers: [],
        onlineWorkerIds: [],
        queue: { queued: 3, claimed: 1, running: 0 },
        stale: 0,
      },
    },
    operatorApproval: {
      status: 'GO',
      evidence: ['a2a-plane#212 (internal tracker, private)#approval-explicit'],
    },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((b) => b.gate === 'brokerReadiness' && b.reason.includes('queued=3')));
});

test('plugin readiness fails when live Telegram is configured', () => {
  const input = allGo({
    pluginReadiness: {
      status: 'GO',
      evidence: ['a2a-plane#212 (internal tracker, private)#plugin'],
      evidencePacket: { liveTelegramConfigured: true },
    },
    operatorApproval: {
      status: 'GO',
      evidence: ['a2a-plane#212 (internal tracker, private)#approval-explicit'],
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
      evidence: ['a2a-plane#212 (internal tracker, private)#runner'],
      evidencePacket: {
        artifactManifest: { ok: true },
        scannerProfile: { ok: true },
        productionDeploy: true,
      },
    },
    operatorApproval: {
      status: 'GO',
      evidence: ['a2a-plane#212 (internal tracker, private)#approval-explicit'],
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
    externalScannerEvidence: { status: 'GO', evidence: [unsafePath] },
    operatorApproval: {
      status: 'GO',
      evidence: ['a2a-plane#212 (internal tracker, private)#approval-explicit'],
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
    terminalEvidence: { status: 'GO', evidence: [dumpLine] },
    operatorApproval: {
      status: 'GO',
      evidence: ['a2a-plane#212 (internal tracker, private)#approval-explicit'],
    },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((b) => b.reason && b.reason.includes('raw-session-dump')));
});

// ── Operator approval separation ─────────────────────────────────

test('GO_CANDIDATE requires operator approval evidence to remain separate from other gates', () => {
  const sharedEvidence = 'a2a-plane#212 (internal tracker, private)#shared-approval';
  const input = allGo({
    externalScannerEvidence: { status: 'GO', evidence: [sharedEvidence] },
    operatorApproval: { status: 'GO', evidence: [sharedEvidence] },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((b) => b.reason && b.reason.includes('must be separate')));
});

test('GO_CANDIDATE fails when operator approval evidence is missing', () => {
  const input = allGo({
    operatorApproval: { status: 'GO', evidence: [] },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((b) => b.gate === 'operatorApproval' && b.reason.includes('missing')));
});

// ── NO_GO is a valid fail-closed outcome ─────────────────────────

test('NO_GO is a valid fail-closed outcome with unresolved gates', () => {
  const input = {
    decision: 'NO_GO',
    gates: {
      brokerReadiness: { status: 'GO', evidence: ['a2a-plane#212 (internal tracker, private)#broker'] },
    },
  };
  const result = run(input);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'NO_GO');
  assert.equal(parsed.sourcePublicExecution, 'NO_GO');
  assert.ok(parsed.blockers.length > 0);
});

// ── Source-public execution remains NO_GO ────────────────────────

test('source-public execution is NO_GO when any gate is missing', () => {
  const input = allGo({
    operatorApproval: { status: 'MISSING', evidence: [] },
  });
  const result = run(input);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.sourcePublicExecution, 'NO_GO');
});

test('source-public execution is NO_GO even in GO_CANDIDATE', () => {
  const input = allGo({
    operatorApproval: {
      status: 'GO',
      evidence: ['a2a-plane#212 (internal tracker, private)#approval-explicit'],
    },
  });
  const result = run(input);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'GO_CANDIDATE');
  assert.equal(parsed.sourcePublicExecution, 'NO_GO');
});

test('source-public execution is explicitly marked NO_GO in spec-only mode', () => {
  const result = spawnSync(process.execPath, [script, '--spec', spec], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.sourcePublicExecution, 'NO_GO');
});

// ── Markdown output ──────────────────────────────────────────────

test('markdown format produces deterministic report for NO_GO', () => {
  const input = {
    decision: 'NO_GO',
    gates: {
      brokerReadiness: { status: 'GO', evidence: ['a2a-plane#212 (internal tracker, private)#broker'] },
      pluginReadiness: { status: 'GO', evidence: ['a2a-plane#212 (internal tracker, private)#plugin'] },
      runnerReadiness: { status: 'GO', evidence: ['a2a-plane#212 (internal tracker, private)#runner'] },
      publicPrivateBoundary: { status: 'GO', evidence: ['a2a-plane#212 (internal tracker, private)#boundary'] },
    },
  };
  const result = runMarkdown(input);
  const out = result.stdout || result.stderr;
  assert.ok(out.includes('A2A Nexus source-public approval rehearsal report'));
  assert.ok(out.includes('NO_GO'));
  assert.ok(out.includes('## Gate status'));
  assert.ok(out.includes('Source-public execution'));
});

test('markdown output for GO_CANDIDATE shows approval packet ready', () => {
  const input = allGo({
    operatorApproval: {
      status: 'GO',
      evidence: ['a2a-plane#212 (internal tracker, private)#operator-approval-explicit'],
    },
  });
  const result = runMarkdown(input);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes('GO_CANDIDATE'));
  assert.ok(result.stdout.includes('approval packet'));
});

test('markdown output for NEEDS_OPERATOR_APPROVAL shows operator sign-off required', () => {
  const input = allGo({
    operatorApproval: { status: 'MISSING', evidence: [] },
  });
  const result = runMarkdown(input);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes('NEEDS_OPERATOR_APPROVAL'));
  assert.ok(result.stdout.includes('operator sign-off required'));
});

// ── Full passes ──────────────────────────────────────────────────

test('all-GO with full separate operator approval passes', () => {
  const input = allGo({
    operatorApproval: {
      status: 'GO',
      evidence: ['a2a-plane#212 (internal tracker, private)#explicit-operator-approval'],
    },
  });
  const result = run(input);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'GO_CANDIDATE');
  assert.equal(parsed.sourcePublicExecution, 'NO_GO');
  assert.equal(parsed.blockers.length, 0);
});

test('all-GO with bundled approval evidence fails separation check', () => {
  const bundledUrl = 'a2a-plane#212 (internal tracker, private)#bundled';
  const input = allGo({
    brokerReadiness: { status: 'GO', evidence: [bundledUrl] },
    operatorApproval: { status: 'GO', evidence: [bundledUrl] },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((b) => b.reason && b.reason.includes('must be separate')));
});

// ── Evidence packet edge cases ───────────────────────────────────

test('null evidence packet is treated as missing', () => {
  const input = {
    decision: 'GO_CANDIDATE',
    gates: {},
  };
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.decision, 'NO_GO');
});

// ── Fixture validation ───────────────────────────────────────────

test('team1-bangtong approval rehearsal fixture yields GO_CANDIDATE', () => {
  const result = spawnSync(process.execPath, [
    script,
    '--spec', spec,
    '--input', 'fixtures/approval-rehearsal/team1-bangtong-approval-rehearsal-evidence.json',
  ], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'GO_CANDIDATE');
  assert.equal(parsed.sourcePublicExecution, 'NO_GO');
  assert.equal(parsed.blockers.length, 0);
});
