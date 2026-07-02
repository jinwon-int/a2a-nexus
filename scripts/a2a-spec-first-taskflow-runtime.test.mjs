import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const spec = 'docs/taskflow/a2a-spec-first-runtime-schema.json';
const script = 'scripts/a2a-spec-first-taskflow-runtime.mjs';
const fixture = 'fixtures/contract/a2a-spec-first-taskflow-runtime-dryrun.json';

function inputPath(input) {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-taskflow-runtime-'));
  const file = join(dir, 'packet.json');
  writeFileSync(file, JSON.stringify(input, null, 2));
  return file;
}

function validPacket(overrides = {}) {
  const base = {
    protocol: 'a2a-spec-first',
    runtimeAutomationEnabled: false,
    controllerId: 'a2a-plane/spec-first-taskflow-bridge',
    goal: 'A2A spec-first: Terminal Brief parent-origin routing runtime dry-run',
    source: {
      issueUrl: 'https://github.com/jinwon-int/a2a-broker/issues/634',
      specPath: 'docs/specs/a2a-terminal-brief-parent-origin-routing/spec.md',
      planPath: 'docs/specs/a2a-terminal-brief-parent-origin-routing/plan.md',
      tasksPath: 'docs/specs/a2a-terminal-brief-parent-origin-routing/tasks.md',
    },
    classification: {
      size: 'large',
      reason: 'cross-repo Terminal Brief routing contract',
    },
    ownership: {
      brokerOfRecord: 'brokerBeta',
      finalizer: 'brokerBeta',
      humanApprovalOwner: 'operator',
    },
    affectedRepos: ['a2a-plane', 'a2a-broker', 'openclaw-plugin-a2a'],
    approvalBoundaries: {
      deploy: 'not-approved',
      restart: 'not-approved',
      liveCanary: 'not-approved',
      providerSend: 'not-approved',
      dbMutation: 'blocked',
      terminalAckReplay: 'blocked',
      releaseTag: 'not-approved',
      secretMovement: 'blocked',
      forcePushHistoryRewrite: 'blocked',
    },
    lanes: [
      {
        id: 'plane-contract-lane',
        repo: 'a2a-plane',
        task: 'Validate contract fixture and TaskFlow state projection.',
        expectedEvidence: ['contract fixture diff', 'release-gate result'],
      },
      {
        id: 'broker-routing-lane',
        repo: 'a2a-broker',
        task: 'Review parent-origin routing helper and metadata preservation.',
        expectedEvidence: ['unit test result', 'PR link'],
      },
      {
        id: 'plugin-relay-lane',
        repo: 'openclaw-plugin-a2a',
        task: 'Validate relay success duplicate suppression and local fallback.',
        expectedEvidence: ['operator-event bridge test result', 'PR link'],
      },
    ],
    evidence: { prs: [], tests: [], ci: [], wiki: [], blockers: [] },
    closeout: { decision: null, summary: null, closedBy: null, closedAt: null },
  };
  return { ...base, ...overrides };
}

function run(input, args = []) {
  return spawnSync(process.execPath, [script, '--spec', spec, '--input', inputPath(input), ...args], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
}

function runFixture(args = []) {
  return spawnSync(process.execPath, [script, '--spec', spec, '--input', fixture, ...args], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
}

test('spec-only mode is fail-closed and dry-run only', () => {
  const result = spawnSync(process.execPath, [script, '--spec', spec], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'NO_GO');
  assert.equal(parsed.sourcePublicExecution, 'NO_GO');
  assert.equal(parsed.taskFlowRuntime, 'DRY_RUN_ONLY');
  assert.equal(parsed.runtimeAutomationEnabled, false);
  assert.ok(parsed.lifecycleStates.includes('awaiting_approval'));
  assert.ok(parsed.approvalSensitiveActions.includes('terminalAckReplay'));
});

test('unsupported execute mode fails closed', () => {
  const result = spawnSync(process.execPath, [script, '--spec', spec, '--mode', 'execute'], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.decision, 'NO_GO');
  assert.equal(parsed.sourcePublicExecution, 'NO_GO');
});

test('valid fixture creates dry-run managed flow draft', () => {
  const result = runFixture();
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'TASKFLOW_DRY_RUN_READY');
  assert.equal(parsed.sourcePublicExecution, 'NO_GO');
  assert.equal(parsed.runtimeAutomationEnabled, false);
  assert.equal(parsed.flowDraft.controllerId, 'a2a-plane/spec-first-taskflow-bridge');
  assert.equal(parsed.flowDraft.currentStep, 'tasks_ready');
  assert.equal(parsed.flowDraft.stateJson.runtime.managedFlowDraftOnly, true);
  assert.equal(parsed.flowDraft.closeout.exactlyOneFinalizer, true);
  assert.ok(parsed.flowDraft.childTasks.length >= 3);
  assert.ok(parsed.flowDraft.childTasks.every((task) => task.dryRunSafe === true));
  assert.ok(parsed.flowDraft.childTasks.every((task) => task.mutatesRuntime === false));
  assert.ok(parsed.flowDraft.managedMutations.includes('createManaged'));
  assert.ok(parsed.flowDraft.managedMutations.includes('runTask'));
});

test('approval request becomes waitJson and never executes sensitive action', () => {
  const result = run(
    validPacket({
      approvalRequest: {
        kind: 'operator_approval',
        approvalType: 'liveCanary',
        requestedScope: 'one bounded parent-seeded Terminal Brief canary',
        blockedActions: ['liveCanary', 'providerSend', 'terminalAckReplay'],
      },
    }),
  );
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'NEEDS_OPERATOR_APPROVAL');
  assert.equal(parsed.sourcePublicExecution, 'NO_GO');
  assert.equal(parsed.flowDraft.currentStep, 'awaiting_approval');
  assert.equal(parsed.flowDraft.waitJson.kind, 'operator_approval');
  assert.deepEqual(parsed.flowDraft.waitJson.blockedActions, ['liveCanary', 'providerSend', 'terminalAckReplay']);
  assert.equal(parsed.safety.noLiveCanary, true);
  assert.equal(parsed.safety.noProviderSend, true);
  assert.equal(parsed.safety.noTerminalAckReplay, true);
});

test('runtimeAutomationEnabled true is blocked', () => {
  const result = run(validPacket({ runtimeAutomationEnabled: true }));
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.decision, 'NO_GO');
  assert.ok(parsed.blockers.some((blocker) => blocker.gate === 'runtimeAutomation'));
});

test('approval-sensitive boundary cannot be marked approved in dry-run state', () => {
  const input = validPacket({
    approvalBoundaries: {
      ...validPacket().approvalBoundaries,
      deploy: 'approved-once',
    },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((blocker) => blocker.gate === 'approvalBoundaries' && blocker.reason.includes('deploy')));
});

test('lane that executes or mutates runtime is blocked', () => {
  const input = validPacket({
    lanes: [
      {
        id: 'unsafe-deploy-lane',
        repo: 'a2a-plane',
        task: 'Deploy the runtime',
        expectedEvidence: ['deployment log'],
        executes: true,
        actionKind: 'deploy',
      },
    ],
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((blocker) => blocker.gate === 'lanes.0' && blocker.status === 'BLOCKED'));
});

test('missing lanes fails closed', () => {
  const result = run(validPacket({ lanes: [] }));
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((blocker) => blocker.gate === 'lanes'));
});

test('unsafe state strings are blocked', () => {
  const unsafeTokenShape = ['TOKEN=', 'ghp_', 'abcdefghijklmnopqrstuvwxyz123456'].join('');
  const input = validPacket({
    evidence: {
      prs: [],
      tests: [unsafeTokenShape],
      ci: [],
      wiki: [],
      blockers: [],
    },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((blocker) => blocker.gate === 'redactedState'));
});

test('markdown output preserves dry-run and blocker summary', () => {
  const result = runFixture(['--format', 'markdown']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Decision: TASKFLOW_DRY_RUN_READY/);
  assert.match(result.stdout, /TaskFlow runtime: DRY_RUN_ONLY/);
  assert.match(result.stdout, /Runtime automation enabled: false/);
  assert.match(result.stdout, /Child lanes:/);
});
