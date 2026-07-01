import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const spec = 'docs/approval-rehearsal/team2-soonwook-source-public-approval-rehearsal-schema.json';
const script = 'scripts/a2a-team2-source-public-approval-rehearsal.mjs';
const requiredGateIds = [
  'approvalPacket',
  'integratedEvidenceBundle',
  'noLiveTerminalBriefRehearsal',
  'replayNoDuplicateProof',
  'rollbackAbortPlan',
  'scannerHistoryReadiness',
  'runtimeBootstrapHygiene',
  'redactedEvidencePolicy',
];

function inputPath(input) {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-approval-rehearsal-'));
  const file = join(dir, 'evidence.json');
  writeFileSync(file, JSON.stringify(input, null, 2));
  return file;
}

function run(input, extraArgs = []) {
  return spawnSync(process.execPath, [script, '--spec', spec, '--input', inputPath(input), ...extraArgs], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

function allRehearsalGates(overrides = {}) {
  const gates = Object.fromEntries(
    requiredGateIds.map((id, index) => [
      id,
      {
        status: 'GO',
        evidence: [`a2a-plane#214 (internal tracker, private)#${id}-${index + 1}`],
        ...overrides[id],
      },
    ]),
  );
  gates.approvalPacket.evidencePacket = {
    packetId: 'approval-rehearsal:a2a-source-public-approval-rehearsal-20260511T014240Z',
    manifestDigest: 'sha256:111122223333444455556666777788889999aaaabbbbccccddddeeeeffff0000',
    deterministic: true,
    approvalExecution: false,
    sourcePublicExecution: false,
    ...overrides.approvalPacket?.evidencePacket,
  };
  gates.integratedEvidenceBundle.evidencePacket = {
    manifestDigest: 'sha256:111122223333444455556666777788889999aaaabbbbccccddddeeeeffff0000',
    components: { broker: true, plugin: true, runner: true, libero: true },
    ...overrides.integratedEvidenceBundle?.evidencePacket,
  };
  gates.noLiveTerminalBriefRehearsal.evidencePacket = {
    mode: 'no-live',
    liveProviderSend: false,
    terminalAck: false,
    productionDbMutation: false,
    ...overrides.noLiveTerminalBriefRehearsal?.evidencePacket,
  };
  gates.replayNoDuplicateProof.evidencePacket = {
    idempotencyKey: 'source-public-approval-rehearsal:20260511T014240Z',
    manifestDigest: 'sha256:111122223333444455556666777788889999aaaabbbbccccddddeeeeffff0000',
    replayAttemptCount: 2,
    duplicateTerminalMarkers: 0,
    duplicateProviderSends: 0,
    manifestMismatchDecision: 'NO_GO',
    ...overrides.replayNoDuplicateProof?.evidencePacket,
  };
  gates.rollbackAbortPlan.evidencePacket = {
    abortPath: 'Stop before approval execution and post Block evidence.',
    rollbackPath: 'Use separately approved manual rollback if a later execution is approved and fails.',
    noExecutionBeforeApproval: true,
    ...overrides.rollbackAbortPlan?.evidencePacket,
  };
  return { gates, ...overrides.root };
}

test('spec-only mode advertises fail-closed rehearsal decisions', () => {
  const result = spawnSync(process.execPath, [script, '--spec', spec], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'NO_GO');
  assert.equal(parsed.sourcePublicExecution, 'NO_GO');
  assert.equal(parsed.approvalExecution, 'NOT_PERFORMED');
  assert.ok(parsed.decisionStates.includes('GO_CANDIDATE'));
  assert.ok(parsed.decisionStates.includes('NEEDS_OPERATOR_APPROVAL'));
  assert.ok(parsed.requiredRehearsalGates.includes('replayNoDuplicateProof'));
});

test('complete rehearsal gates without approval produce NEEDS_OPERATOR_APPROVAL, not execution GO', () => {
  const result = run(allRehearsalGates());
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'NEEDS_OPERATOR_APPROVAL');
  assert.equal(parsed.sourcePublicExecution, 'NO_GO');
  assert.equal(parsed.approvalExecution, 'NOT_PERFORMED');
  assert.equal(parsed.operatorApprovalReady, false);
});

test('separate approval evidence can produce GO_CANDIDATE but still never executes approval', () => {
  const input = allRehearsalGates({
    root: {
      gates: {
        ...allRehearsalGates().gates,
        operatorApproval: {
          status: 'GO',
          evidence: ['a2a-plane#211 (internal tracker, private)#operator-approval-placeholder'],
        },
      },
    },
  });
  const result = run(input);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'GO_CANDIDATE');
  assert.equal(parsed.sourcePublicExecution, 'NO_GO');
  assert.equal(parsed.approvalExecution, 'NOT_PERFORMED');
  assert.equal(parsed.operatorApprovalReady, true);
});

test('missing replay proof fails closed with NO_GO', () => {
  const input = allRehearsalGates({ replayNoDuplicateProof: { status: 'MISSING', evidence: [] } });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.decision, 'NO_GO');
  assert.ok(parsed.blockers.some((blocker) => blocker.gate === 'replayNoDuplicateProof'));
});

test('replay proof rejects duplicate terminal markers and duplicate provider sends', () => {
  const input = allRehearsalGates({
    replayNoDuplicateProof: {
      evidencePacket: {
        replayAttemptCount: 2,
        duplicateTerminalMarkers: 1,
        duplicateProviderSends: 1,
      },
    },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((blocker) => blocker.reason.includes('duplicate terminal markers')));
  assert.ok(parsed.blockers.some((blocker) => blocker.reason.includes('duplicate provider sends')));
});

test('live provider sends and terminal ACKs are rejected in rehearsal', () => {
  const input = allRehearsalGates({
    noLiveTerminalBriefRehearsal: {
      evidencePacket: { liveProviderSend: true, terminalAck: true },
    },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((blocker) => blocker.reason.includes('live provider/Telegram send')));
  assert.ok(parsed.blockers.some((blocker) => blocker.reason.includes('terminal ACK')));
});

test('runtime/bootstrap files fail closed and report exact offending repo-relative paths', () => {
  const input = allRehearsalGates({ root: { offendingPaths: ['AGENTS.md', '.openclaw/workspace-state.json'] } });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.deepEqual(parsed.offendingPaths, ['.openclaw/workspace-state.json', 'AGENTS.md']);
  assert.ok(parsed.blockers.some((blocker) => blocker.path === 'AGENTS.md'));
  assert.ok(parsed.blockers.some((blocker) => blocker.path === '.openclaw/workspace-state.json'));
});

test('markdown output keeps GO_CANDIDATE separate from approval/source-public execution', () => {
  const input = allRehearsalGates({
    root: {
      gates: {
        ...allRehearsalGates().gates,
        operatorApproval: {
          status: 'GO',
          evidence: ['a2a-plane#211 (internal tracker, private)#operator-approval-placeholder'],
        },
      },
    },
  });
  const result = run(input, ['--format', 'markdown']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Decision: GO_CANDIDATE/);
  assert.match(result.stdout, /Source-public execution: NO_GO/);
  assert.match(result.stdout, /Approval execution: NOT_PERFORMED/);
  assert.match(result.stdout, /GO_CANDIDATE is not approval execution/);
});
