import test from 'node:test';
import assert from 'node:assert/strict';

import { createA2AGatewayBrokerClient } from '../dist/src/gateway-handlers.js';

function makeBrokerTask(overrides = {}) {
  return {
    id: 'task-1',
    status: 'queued',
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
    },
    message: 'inspect this case',
    createdAt: '2026-04-19T04:00:00.000Z',
    updatedAt: '2026-04-19T04:01:00.000Z',
    ...overrides,
  };
}

test('requestTask forwards plugin-owned runtime boundary fields to broker createTask', async () => {
  let createTaskRequest;
  const brokerTask = makeBrokerTask({
    status: 'queued',
    payload: {
      requesterSessionKey: 'session:requester',
      requesterDisplayKey: 'worker-beta',
      targetSessionKey: 'session:target',
      targetDisplayKey: 'worker-gamma',
      waitRunId: 'wait-1',
      correlationId: 'corr-1',
      parentRunId: 'run-parent-1',
      cancelTarget: {
        kind: 'session_run',
        sessionKey: 'session:target',
        runId: 'run-9',
      },
    },
  });

  const client = createA2AGatewayBrokerClient(
    {
      requester: { id: 'session:requester', kind: 'session', role: 'hub' },
    },
    {
      createRawBrokerClient: () => ({
        createTask: async (request) => {
          createTaskRequest = request;
          return brokerTask;
        },
        getTask: async () => brokerTask,
        claimTask: async () => brokerTask,
        startTask: async () => brokerTask,
        completeTask: async () => brokerTask,
        failTask: async () => brokerTask,
        cancelTask: async () => ({ ...brokerTask, status: 'canceled' }),
      }),
    },
  );

  await client.requestTask({
    sessionKey: 'session:requester',
    request: {
      method: 'a2a.task.request',
      taskId: 'task-1',
      correlationId: 'corr-1',
      parentRunId: 'run-parent-1',
      requester: {
        sessionKey: 'session:requester',
        displayKey: 'worker-beta',
        channel: 'telegram',
      },
      target: {
        sessionKey: 'session:target',
        displayKey: 'worker-gamma',
        channel: 'discord',
      },
      task: {
        intent: 'delegate',
        instructions: 'inspect this case',
        input: { exchangeId: 'exchange-123' },
      },
      constraints: {
        timeoutSeconds: 45,
        maxPingPongTurns: 3,
      },
      runtime: {
        waitRunId: 'wait-1',
        roundOneReply: 'on it',
        announceTimeoutMs: 12000,
        maxPingPongTurns: 2,
        cancelTarget: {
          kind: 'session_run',
          sessionKey: 'session:target',
          runId: 'run-9',
        },
      },
    },
  });

  assert.equal(createTaskRequest.id, 'task-1');
  assert.equal(createTaskRequest.payload.waitRunId, 'wait-1');
  assert.equal(createTaskRequest.payload.roundOneReply, 'on it');
  assert.deepEqual(createTaskRequest.payload.cancelTarget, {
    kind: 'session_run',
    sessionKey: 'session:target',
    runId: 'run-9',
  });
  assert.equal(createTaskRequest.payload.requesterChannel, 'telegram');
  assert.equal(createTaskRequest.payload.targetChannel, 'discord');
});

test('updateTask drives broker claim, start, and complete from plugin execution status writes', async () => {
  const calls = [];
  const queuedTask = makeBrokerTask();
  const claimedTask = makeBrokerTask({
    status: 'claimed',
    claimedBy: 'session:requester',
    claimedAt: '2026-04-19T04:01:30.000Z',
  });
  const runningTask = makeBrokerTask({
    status: 'running',
    claimedBy: 'session:requester',
    claimedAt: '2026-04-19T04:01:30.000Z',
    updatedAt: '2026-04-19T04:02:00.000Z',
  });
  const completedTask = makeBrokerTask({
    status: 'succeeded',
    claimedBy: 'session:requester',
    claimedAt: '2026-04-19T04:01:30.000Z',
    updatedAt: '2026-04-19T04:03:00.000Z',
    result: {
      summary: 'done',
      output: { applied: true },
    },
  });

  const client = createA2AGatewayBrokerClient(
    {
      requester: { id: 'session:requester', kind: 'session', role: 'hub' },
    },
    {
      createRawBrokerClient: () => ({
        createTask: async () => queuedTask,
        getTask: async () => queuedTask,
        claimTask: async (taskId, request) => {
          calls.push(['claimTask', taskId, request]);
          return claimedTask;
        },
        startTask: async (taskId, request) => {
          calls.push(['startTask', taskId, request]);
          return runningTask;
        },
        completeTask: async (taskId, request) => {
          calls.push(['completeTask', taskId, request]);
          return completedTask;
        },
        failTask: async () => {
          throw new Error('failTask should not be called');
        },
        cancelTask: async () => ({ ...queuedTask, status: 'canceled' }),
      }),
    },
  );

  const result = await client.updateTask({
    sessionKey: 'session:requester',
    update: {
      method: 'a2a.task.update',
      taskId: 'task-1',
      executionStatus: 'completed',
      summary: 'done',
      output: { applied: true },
    },
  });

  assert.deepEqual(
    calls.map(([name]) => name),
    ['claimTask', 'startTask', 'completeTask'],
  );
  assert.deepEqual(calls[2][2], {
    workerId: 'session:requester',
    result: {
      summary: 'done',
      output: { applied: true },
    },
  });
  assert.equal(result.executionStatus, 'completed');
  assert.equal(result.summary, 'done');
  assert.deepEqual(result.output, {
    applied: true,
    status: 'succeeded',
  });
});

test('cancelTask maps plugin cancel requests to broker cancel fan-out payload', async () => {
  const calls = [];
  const brokerTask = makeBrokerTask({ status: 'running' });

  const client = createA2AGatewayBrokerClient(
    {
      requester: { id: 'session:requester', kind: 'session', role: 'hub' },
    },
    {
      createRawBrokerClient: () => ({
        createTask: async () => brokerTask,
        getTask: async () => brokerTask,
        claimTask: async () => brokerTask,
        startTask: async () => brokerTask,
        completeTask: async () => brokerTask,
        failTask: async () => brokerTask,
        cancelTask: async (taskId, request) => {
          calls.push(['cancelTask', taskId, request]);
          return { ...brokerTask, status: 'canceled', updatedAt: '2026-04-19T04:05:00.000Z' };
        },
      }),
    },
  );

  const result = await client.cancelTask({
    sessionKey: 'session:requester',
    cancel: {
      method: 'a2a.task.cancel',
      taskId: 'task-1',
      reason: 'operator requested stop',
      cancelTarget: {
        kind: 'session_run',
        sessionKey: 'session:target',
        runId: 'run-9',
      },
    },
  });

  assert.deepEqual(calls, [
    [
      'cancelTask',
      'task-1',
      {
        actor: { id: 'session:requester', kind: 'session', role: 'hub' },
        reason: 'operator requested stop',
      },
    ],
  ]);
  assert.equal(result.abortStatus, 'aborted');
  assert.equal(result.executionStatus, 'cancelled');
});

test('statusTask projects broker timeout failure into plugin monitoring-friendly fields', async () => {
  const brokerTask = makeBrokerTask({
    status: 'failed',
    claimedAt: '2026-04-19T04:01:30.000Z',
    updatedAt: '2026-04-19T04:06:00.000Z',
    error: {
      code: 'timed_out',
      message: 'worker heartbeat expired',
    },
    payload: {
      requesterSessionKey: 'session:requester',
      requesterDisplayKey: 'worker-beta',
      requesterChannel: 'telegram',
      targetSessionKey: 'session:target',
      targetDisplayKey: 'worker-gamma',
      targetChannel: 'discord',
      correlationId: 'corr-1',
      parentRunId: 'run-parent-1',
      expectedOutput: { format: 'json', schemaName: 'CaseInspectorPayload' },
      evidenceRefs: ['evidence-a', 'evidence-b'],
      taskInput: { exchangeId: 'exchange-123' },
    },
    exchangeId: 'exchange-123',
    proposalId: 'proposal-9',
    policyContext: {
      liveImpact: true,
      requiresApproval: true,
      targetEnvironment: 'live',
    },
  });

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

  assert.equal(status.executionStatus, 'timed_out');
  assert.equal(status.deliveryStatus, 'skipped');
  assert.equal(status.error.code, 'timed_out');
  assert.equal(status.error.message, 'worker heartbeat expired');
  assert.equal(status.requester.channel, 'telegram');
  assert.equal(status.target.channel, 'discord');
  assert.deepEqual(status.metadata, {
    exchangeId: 'exchange-123',
    proposalId: 'proposal-9',
    policyContext: {
      liveImpact: true,
      requiresApproval: true,
      targetEnvironment: 'live',
    },
    evidenceRefs: ['evidence-a', 'evidence-b'],
    expectedOutput: { format: 'json', schemaName: 'CaseInspectorPayload' },
    taskInput: { exchangeId: 'exchange-123' },
  });
  assert.equal(typeof status.startedAt, 'number');
  assert.equal(typeof status.updatedAt, 'number');
  assert.equal(status.hasHeartbeat, false);
});

test('statusTask keeps queued broker tasks as accepted with pending delivery', async () => {
  const brokerTask = makeBrokerTask({
    status: 'queued',
    updatedAt: '2026-04-19T04:01:00.000Z',
  });

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

  assert.equal(status.executionStatus, 'accepted');
  assert.equal(status.deliveryStatus, 'pending');
  assert.equal(status.summary, undefined);
  assert.equal(status.output, undefined);
  assert.equal(status.error, undefined);
});
