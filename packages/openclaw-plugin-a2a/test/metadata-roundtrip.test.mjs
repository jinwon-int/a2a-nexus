import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBrokerCreateTaskRequestFromOpenClaw } from '../dist/standalone-broker-client.js';
import { buildGatewayTaskStatus, createA2AGatewayBrokerClient } from '../dist/src/gateway-handlers.js';

test('buildBrokerCreateTaskRequestFromOpenClaw preserves drilldown case context', () => {
  const request = buildBrokerCreateTaskRequestFromOpenClaw({
    taskId: 'task-1',
    waitRunId: 'wait-1',
    correlationId: 'corr-1',
    parentRunId: 'run-parent-1',
    requesterSessionKey: 'session:requester',
    requesterDisplayKey: 'worker-beta',
    requesterChannel: 'telegram',
    targetSessionKey: 'session:target',
    targetDisplayKey: 'worker-gamma',
    targetChannel: 'discord',
    originalMessage: 'inspect this case',
    taskInput: {
      caseContext: {
        exchangeId: 'exchange-123',
        proposalId: 'proposal-9',
        artifactIds: ['artifact-1', 'artifact-2'],
        evidenceRefs: ['evidence-a', 'evidence-b'],
        policyContext: {
          liveImpact: true,
          requiresApproval: true,
          targetEnvironment: 'live',
        },
      },
    },
    expectedOutput: {
      format: 'json',
      schemaName: 'CaseInspectorPayload',
    },
    announceTimeoutMs: 30_000,
    maxPingPongTurns: 2,
  });

  assert.equal(request.exchangeId, 'exchange-123');
  assert.equal(request.proposalId, 'proposal-9');
  assert.deepEqual(request.artifactIds, ['artifact-1', 'artifact-2']);
  assert.deepEqual(request.policyContext, {
    liveImpact: true,
    requiresApproval: true,
    targetEnvironment: 'live',
  });
  assert.equal(request.payload.requesterDisplayKey, 'worker-beta');
  assert.equal(request.payload.targetChannel, 'discord');
  assert.deepEqual(request.payload.expectedOutput, {
    format: 'json',
    schemaName: 'CaseInspectorPayload',
  });
  assert.deepEqual(request.payload.evidenceRefs, ['evidence-a', 'evidence-b']);
});

test('createA2AGatewayBrokerClient surfaces preserved metadata on status read-back', async () => {
  const brokerTask = {
    id: 'task-1',
    status: 'running',
    intent: 'chat',
    requester: { id: 'session:requester', kind: 'session', role: 'hub' },
    target: { id: 'session:target', kind: 'session' },
    targetNodeId: 'session:target',
    payload: {
      requesterSessionKey: 'session:requester',
      requesterDisplayKey: 'worker-beta',
      requesterChannel: 'telegram',
      targetSessionKey: 'session:target',
      targetDisplayKey: 'worker-gamma',
      targetChannel: 'discord',
      correlationId: 'corr-1',
      parentRunId: 'run-parent-1',
      taskInput: { exchangeId: 'exchange-123', proposalId: 'proposal-9' },
      expectedOutput: { format: 'json', schemaName: 'CaseInspectorPayload' },
      evidenceRefs: ['evidence-a'],
    },
    exchangeId: 'exchange-123',
    proposalId: 'proposal-9',
    policyContext: {
      liveImpact: true,
      requiresApproval: true,
      targetEnvironment: 'live',
    },
    message: 'inspect this case',
    createdAt: '2026-04-19T04:00:00.000Z',
    updatedAt: '2026-04-19T04:01:00.000Z',
  };

  const client = createA2AGatewayBrokerClient(
    {},
    {
      createRawBrokerClient: () => ({
        createTask: async () => brokerTask,
        getTask: async () => brokerTask,
        claimTask: async () => brokerTask,
        startTask: async () => brokerTask,
        completeTask: async () => brokerTask,
        failTask: async () => brokerTask,
        cancelTask: async () => ({ ...brokerTask, status: 'canceled' }),
      }),
    },
  );

  const status = await client.statusTask({ sessionKey: 'session:requester', taskId: 'task-1' });

  assert.equal(status.requester.displayKey, 'worker-beta');
  assert.equal(status.requester.channel, 'telegram');
  assert.equal(status.target.displayKey, 'worker-gamma');
  assert.equal(status.target.channel, 'discord');
  assert.equal(status.correlationId, 'corr-1');
  assert.equal(status.parentRunId, 'run-parent-1');
  assert.deepEqual(status.metadata, {
    exchangeId: 'exchange-123',
    proposalId: 'proposal-9',
    policyContext: {
      liveImpact: true,
      requiresApproval: true,
      targetEnvironment: 'live',
    },
    evidenceRefs: ['evidence-a'],
    expectedOutput: { format: 'json', schemaName: 'CaseInspectorPayload' },
    taskInput: { exchangeId: 'exchange-123', proposalId: 'proposal-9' },
  });
});

test('status projection surfaces sanitized GitHub merge-gate metadata', () => {
  const baseTask = {
    id: 'task-merge-gate',
    status: 'running',
    intent: 'chat',
    requester: { id: 'session:requester', kind: 'session' },
    target: { id: 'session:target', kind: 'session' },
    targetNodeId: 'session:target',
    payload: {},
    message: 'check PR merge gate',
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:01:00.000Z',
  };

  const reviewRequired = buildGatewayTaskStatus({
    ...baseTask,
    payload: {
      taskInput: {
        mergeGate: {
          mergeStateStatus: 'BLOCKED',
          reviewDecision: 'REVIEW_REQUIRED',
          requiredReviewCount: 1,
          requireLastPushApproval: true,
          blockedBy: ['required_review', 'last_pusher_approval'],
          token: 'ghp_should_not_leak',
          raw: { secret: 'api-response' },
        },
      },
    },
  });
  assert.deepEqual(reviewRequired.metadata.githubMergeGate, {
    state: 'review_required',
    mergeStateStatus: 'BLOCKED',
    reviewDecision: 'REVIEW_REQUIRED',
    requiredReviewCount: 1,
    requireLastPushApproval: true,
    blockedBy: ['required_review', 'last_pusher_approval'],
  });
  assert.equal('token' in reviewRequired.metadata.githubMergeGate, false);
  assert.equal('raw' in reviewRequired.metadata.githubMergeGate, false);

  const conflict = buildGatewayTaskStatus({
    ...baseTask,
    result: {
      output: {
        github: {
          mergeGate: {
            mergeStateStatus: 'DIRTY',
            reviewDecision: 'APPROVED',
            hasConflicts: true,
          },
        },
      },
    },
  });
  assert.equal(conflict.metadata.githubMergeGate.state, 'conflict');
  assert.equal(conflict.metadata.githubMergeGate.hasConflicts, true);

  const clean = buildGatewayTaskStatus({
    ...baseTask,
    result: {
      output: {
        githubMergeGate: {
          mergeStateStatus: 'CLEAN',
          reviewDecision: 'APPROVED',
          requiredReviewCount: 0,
          requireLastPushApproval: false,
        },
      },
    },
  });
  assert.deepEqual(clean.metadata.githubMergeGate, {
    state: 'clean',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    requiredReviewCount: 0,
    requireLastPushApproval: false,
  });
});


test('status projection keeps taskInput metadata compact while preserving evidence links', () => {
  const status = buildGatewayTaskStatus({
    id: 'task-compact-status',
    status: 'running',
    intent: 'chat',
    requester: { id: 'session:requester', kind: 'session' },
    target: { id: 'session:target', kind: 'session' },
    targetNodeId: 'session:target',
    payload: {
      taskInput: {
        exchangeId: 'exchange-compact',
        proposalId: 'proposal-compact',
        runnerPreset: 'docker-runner',
        repository: 'jinwon-int/openclaw-plugin-a2a',
        commitSha: 'abc123',
        round: '2026-05-01',
        prUrl: 'https://github.com/jinwon-int/openclaw-plugin-a2a/pull/129',
        doneUrl: 'https://github.com/jinwon-int/openclaw-plugin-a2a/issues/129#issuecomment-1',
        blockUrl: 'https://github.com/jinwon-int/openclaw-plugin-a2a/issues/129#issuecomment-2',
        artifactUrl: 'https://github.com/jinwon-int/openclaw-plugin-a2a/actions/runs/1',
        artifactIds: ['artifact-1'],
        token: 'ghp_should_not_leak',
        rawBrokerResponse: { token: 'ghp_nested', payload: 'x'.repeat(8_000) },
        rawLog: 'secret log '.repeat(1_000),
        privatePath: '/home/alice/.ssh/id_rsa',
      },
    },
    message: 'compact projection check',
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:01:00.000Z',
  });

  assert.deepEqual(status.metadata.taskInput, {
    exchangeId: 'exchange-compact',
    proposalId: 'proposal-compact',
    runnerPreset: 'docker-runner',
    repository: 'jinwon-int/openclaw-plugin-a2a',
    commitSha: 'abc123',
    round: '2026-05-01',
    prUrl: 'https://github.com/jinwon-int/openclaw-plugin-a2a/pull/129',
    artifactUrl: 'https://github.com/jinwon-int/openclaw-plugin-a2a/actions/runs/1',
    doneUrl: 'https://github.com/jinwon-int/openclaw-plugin-a2a/issues/129#issuecomment-1',
    blockUrl: 'https://github.com/jinwon-int/openclaw-plugin-a2a/issues/129#issuecomment-2',
    artifactIds: ['artifact-1'],
  });

  const serialized = JSON.stringify(status.metadata);
  assert.equal(serialized.includes('ghp_should_not_leak'), false);
  assert.equal(serialized.includes('rawBrokerResponse'), false);
  assert.equal(serialized.includes('rawLog'), false);
  assert.equal(serialized.includes('/home/alice'), false);
  assert.ok(serialized.length < 1_500, 'metadata should stay compact, got ' + serialized.length + ' bytes');
});
