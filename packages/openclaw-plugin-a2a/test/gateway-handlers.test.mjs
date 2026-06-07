import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createA2AGatewayBrokerClient,
  createA2AGatewayHandlers,
} from '../dist/src/gateway-handlers.js';
import { validateParams } from '../dist/src/gateway-validators.js';
import { safeSessionKeyLabel } from '../dist/src/plugin-errors.js';

/**
 * Mutable capture so we can test one export without the full handler setup.
 */
import { validateA2ATaskRequestParams } from '../dist/src/gateway-validators.js';

function createBaseConfig() {
  return {
    plugins: {
      entries: {
        'a2a-broker-adapter': {
          enabled: true,
          config: {
            baseUrl: 'https://broker.example',
            requester: { id: 'hub-session', kind: 'session', role: 'hub' },
          },
        },
      },
    },
  };
}

function createBrokerTask(overrides = {}) {
  return {
    id: 'task-1',
    exchangeId: 'ex-1',
    intent: 'chat',
    requester: { id: 'requester-1', kind: 'session', role: 'hub' },
    target: { id: 'target-1', kind: 'session', role: 'analyst' },
    message: 'hello',
    targetNodeId: 'target-1',
    payload: {},
    status: 'queued',
    createdAt: '2026-04-20T00:00:00.000Z',
    updatedAt: '2026-04-20T00:00:00.000Z',
    ...overrides,
  };
}

test('requestTask forwards current runtime fields into broker create payload', async () => {
  let received;
  const brokerClient = createA2AGatewayBrokerClient(createBaseConfig(), {
    createRawBrokerClient: () => ({
      async createTask(payload) {
        received = payload;
        return createBrokerTask({
          id: payload.id ?? 'task-req-1',
          payload: payload.payload ?? {},
          requester: payload.requester,
          target: payload.target,
          targetNodeId: payload.target.id,
        });
      },
    }),
  });

  const result = await brokerClient.requestTask({
    sessionKey: 'session-alpha',
    request: {
      method: 'a2a.task.request',
      taskId: 'task-req-1',
      correlationId: 'corr-1',
      parentRunId: 'run-parent-1',
      requester: { sessionKey: 'session-alpha', displayKey: 'alpha', channel: 'telegram' },
      target: { sessionKey: 'session-beta', displayKey: 'beta', channel: 'telegram' },
      task: {
        intent: 'ask',
        instructions: 'Please investigate.',
      },
      constraints: {
        timeoutSeconds: 45,
        maxPingPongTurns: 2,
      },
      runtime: {
        waitRunId: 'wait-1',
        roundOneReply: 'first reply',
        announceTimeoutMs: 3210,
        maxPingPongTurns: 4,
        cancelTarget: {
          kind: 'session_run',
          sessionKey: 'session-beta',
          runId: 'run-77',
        },
      },
    },
  });

  assert.equal(received.payload.waitRunId, 'wait-1');
  assert.equal(received.payload.roundOneReply, 'first reply');
  assert.equal(received.payload.announceTimeoutMs, 3210);
  assert.equal(received.payload.maxPingPongTurns, 4);
  assert.deepEqual(received.payload.cancelTarget, {
    kind: 'session_run',
    sessionKey: 'session-beta',
    runId: 'run-77',
  });
  assert.equal(result.executionStatus, 'accepted');
  assert.equal(result.deliveryStatus, 'pending');
});

test('cancel handler returns not found when broker has no task', async () => {
  const handlers = createA2AGatewayHandlers(createBaseConfig(), {
    createBrokerClient: () => ({
      async requestTask() {
        throw new Error('not used');
      },
      async updateTask() {
        throw new Error('not used');
      },
      async cancelTask() {
        return undefined;
      },
      async statusTask() {
        throw new Error('not used');
      },
    }),
  });

  let response;
  await handlers.handleA2ATaskCancel({
    params: {
      sessionKey: 'session-alpha',
      cancel: {
        method: 'a2a.task.cancel',
        taskId: 'missing-task',
      },
    },
    respond(ok, result, error) {
      response = { ok, result, error };
    },
  });

  assert.deepEqual(response, {
    ok: false,
    result: undefined,
    error: {
      code: 'NOT_FOUND',
      message: 'a2a task not found: missing-task',
    },
  });
});

test('approval gateway methods forward operator decisions and surface approval metadata', async () => {
  const blockedTask = createBrokerTask({
    id: 'task-approval',
    status: 'blocked',
    policyContext: { requiresApproval: true, liveImpact: true, targetEnvironment: 'live' },
  });
  let approveRequest;
  let rejectRequest;
  const brokerClient = createA2AGatewayBrokerClient(createBaseConfig(), {
    createRawBrokerClient: () => ({
      async getTask(taskId) {
        return taskId === blockedTask.id ? blockedTask : undefined;
      },
      async approveTask(taskId, request) {
        approveRequest = { taskId, request };
        return createBrokerTask({
          ...blockedTask,
          status: 'queued',
          approval: {
            approvalId: request.approvalId,
            approvedAt: '2026-04-20T00:01:00.000Z',
            approvedBy: request.actor.id,
            actorRole: request.actor.role,
            requesterRole: 'hub',
            reason: request.reason,
          },
          approvalOutcome: {
            status: 'approved',
            approvalId: request.approvalId,
            decidedAt: '2026-04-20T00:01:00.000Z',
            decidedBy: request.actor.id,
            actorRole: request.actor.role,
            requesterRole: 'hub',
            reason: request.reason,
          },
        });
      },
      async rejectTaskApproval(taskId, request) {
        rejectRequest = { taskId, request };
        return createBrokerTask({
          ...blockedTask,
          status: 'canceled',
          approvalOutcome: {
            status: request.status,
            approvalId: request.approvalId,
            decidedAt: '2026-04-20T00:02:00.000Z',
            decidedBy: request.actor.id,
            actorRole: request.actor.role,
            requesterRole: 'hub',
            reason: request.reason,
          },
        });
      },
    }),
  });

  const approved = await brokerClient.approveTask({
    sessionKey: 'session-alpha',
    approval: {
      method: 'a2a.task.approve',
      taskId: 'task-approval',
      approvalId: 'approval-30',
      reason: 'operator reviewed exact live-impact announce',
    },
  });

  assert.equal(approveRequest.taskId, 'task-approval');
  assert.equal(approveRequest.request.actor.id, 'hub-session');
  assert.equal(approveRequest.request.approvalId, 'approval-30');
  assert.equal(approved.method, 'a2a.task.approve');
  assert.equal(approved.executionStatus, 'accepted');
  assert.equal(approved.metadata.approval.approvalId, 'approval-30');
  assert.equal(approved.metadata.approvalOutcome.status, 'approved');

  const rejected = await brokerClient.rejectApproval({
    sessionKey: 'session-alpha',
    approval: {
      method: 'a2a.task.reject_approval',
      taskId: 'task-approval',
      approvalId: 'rejection-30',
      status: 'rejected',
      reason: 'operator declined live-impact announce',
    },
  });

  assert.equal(rejectRequest.taskId, 'task-approval');
  assert.equal(rejectRequest.request.actor.id, 'hub-session');
  assert.equal(rejectRequest.request.status, 'rejected');
  assert.equal(rejected.method, 'a2a.task.reject_approval');
  assert.equal(rejected.executionStatus, 'cancelled');
  assert.equal(rejected.metadata.approvalOutcome.approvalId, 'rejection-30');
  assert.equal(rejected.metadata.approvalOutcome.status, 'rejected');
});

test('approval gateway lifecycle updates status visibility for approve and reject paths', async () => {
  const makeBlockedTask = (id) =>
    createBrokerTask({
      id,
      status: 'blocked',
      payload: {
        requesterSessionKey: 'session-alpha',
        targetSessionKey: 'session-beta',
        targetDisplayKey: 'beta',
      },
      policyContext: { requiresApproval: true, liveImpact: true, targetEnvironment: 'live' },
    });
  const tasks = new Map([
    ['task-approve', makeBlockedTask('task-approve')],
    ['task-reject', makeBlockedTask('task-reject')],
  ]);
  const brokerClient = createA2AGatewayBrokerClient(createBaseConfig(), {
    createRawBrokerClient: () => ({
      async getTask(taskId) {
        return tasks.get(taskId);
      },
      async approveTask(taskId, request) {
        const current = tasks.get(taskId);
        const next = createBrokerTask({
          ...current,
          status: 'queued',
          approval: {
            approvalId: request.approvalId,
            approvedAt: '2026-04-20T00:03:00.000Z',
            approvedBy: request.actor.id,
            actorRole: request.actor.role,
            requesterRole: current.requester.role,
            reason: request.reason,
          },
          approvalOutcome: {
            status: 'approved',
            approvalId: request.approvalId,
            decidedAt: '2026-04-20T00:03:00.000Z',
            decidedBy: request.actor.id,
            actorRole: request.actor.role,
            requesterRole: current.requester.role,
            reason: request.reason,
          },
        });
        tasks.set(taskId, next);
        return next;
      },
      async rejectTaskApproval(taskId, request) {
        const current = tasks.get(taskId);
        const next = createBrokerTask({
          ...current,
          status: 'canceled',
          approvalOutcome: {
            status: request.status,
            approvalId: request.approvalId,
            decidedAt: '2026-04-20T00:04:00.000Z',
            decidedBy: request.actor.id,
            actorRole: request.actor.role,
            requesterRole: current.requester.role,
            reason: request.reason,
          },
        });
        tasks.set(taskId, next);
        return next;
      },
    }),
  });

  const beforeApprove = await brokerClient.statusTask({
    sessionKey: 'session-alpha',
    taskId: 'task-approve',
  });
  assert.equal(beforeApprove.executionStatus, 'accepted');
  assert.equal(beforeApprove.deliveryStatus, 'pending');
  assert.equal(beforeApprove.metadata.policyContext.requiresApproval, true);

  await brokerClient.approveTask({
    sessionKey: 'session-alpha',
    approval: {
      method: 'a2a.task.approve',
      taskId: 'task-approve',
      approvalId: 'approval-r31',
      reason: 'release approved by operator',
    },
  });

  const afterApprove = await brokerClient.statusTask({
    sessionKey: 'session-alpha',
    taskId: 'task-approve',
  });
  assert.equal(afterApprove.executionStatus, 'accepted');
  assert.equal(afterApprove.deliveryStatus, 'pending');
  assert.equal(afterApprove.metadata.approval.approvalId, 'approval-r31');
  assert.equal(afterApprove.metadata.approvalOutcome.status, 'approved');
  assert.equal(afterApprove.metadata.approvalOutcome.decidedBy, 'hub-session');

  await brokerClient.rejectApproval({
    sessionKey: 'session-alpha',
    approval: {
      method: 'a2a.task.reject_approval',
      taskId: 'task-reject',
      approvalId: 'rejection-r31',
      status: 'rejected',
      reason: 'live-impact announce declined',
    },
  });

  const afterReject = await brokerClient.statusTask({
    sessionKey: 'session-alpha',
    taskId: 'task-reject',
  });
  assert.equal(afterReject.executionStatus, 'cancelled');
  assert.equal(afterReject.deliveryStatus, 'skipped');
  assert.equal(afterReject.metadata.approval, undefined);
  assert.equal(afterReject.metadata.approvalOutcome.approvalId, 'rejection-r31');
  assert.equal(afterReject.metadata.approvalOutcome.status, 'rejected');
  assert.equal(afterReject.metadata.approvalOutcome.decidedBy, 'hub-session');
});

test('approval handlers return not found when broker has no task', async () => {
  const handlers = createA2AGatewayHandlers(createBaseConfig(), {
    createBrokerClient: () => ({
      async requestTask() {
        throw new Error('not used');
      },
      async updateTask() {
        throw new Error('not used');
      },
      async cancelTask() {
        throw new Error('not used');
      },
      async approveTask() {
        return undefined;
      },
      async rejectApproval() {
        return undefined;
      },
      async statusTask() {
        throw new Error('not used');
      },
    }),
  });

  let approveResponse;
  await handlers.handleA2ATaskApprove({
    params: {
      sessionKey: 'session-alpha',
      approval: {
        method: 'a2a.task.approve',
        taskId: 'missing-task',
      },
    },
    respond(ok, result, error) {
      approveResponse = { ok, result, error };
    },
  });

  assert.deepEqual(approveResponse, {
    ok: false,
    result: undefined,
    error: {
      code: 'NOT_FOUND',
      message: 'a2a task not found: missing-task',
    },
  });

  let rejectResponse;
  await handlers.handleA2ATaskRejectApproval({
    params: {
      sessionKey: 'session-alpha',
      approval: {
        method: 'a2a.task.reject_approval',
        taskId: 'missing-task',
        status: 'expired',
      },
    },
    respond(ok, result, error) {
      rejectResponse = { ok, result, error };
    },
  });

  assert.deepEqual(rejectResponse, {
    ok: false,
    result: undefined,
    error: {
      code: 'NOT_FOUND',
      message: 'a2a task not found: missing-task',
    },
  });
});

test('status handler projects receipt status separate from delivery status', async () => {
  // Task that completed with delivery confirmation evidence
  const deliveredTask = createBrokerTask({
    id: 'task-delivered',
    status: 'succeeded',
    payload: {
      correlationId: 'corr-delivered',
      requesterSessionKey: 'session-alpha',
      targetSessionKey: 'session-beta',
      evidenceRefs: ['delivery-confirmed-check'],
    },
    result: { summary: 'completed' },
  });
  // Task that completed without delivery confirmation
  const completedTask = createBrokerTask({
    id: 'task-completed',
    status: 'succeeded',
    payload: {
      requesterSessionKey: 'session-alpha',
      targetSessionKey: 'session-beta',
    },
    result: { summary: 'done' },
  });
  // Active task with stale session evidence
  const staleTask = createBrokerTask({
    id: 'task-stale',
    status: 'claimed',
    payload: {
      requesterSessionKey: 'session-alpha',
      targetSessionKey: 'session-beta',
      evidenceRefs: ['stale-session-evidence'],
    },
  });

  const tasks = new Map([
    ['task-delivered', deliveredTask],
    ['task-completed', completedTask],
    ['task-stale', staleTask],
  ]);

  const handlers = createA2AGatewayHandlers(createBaseConfig(), {
    createBrokerClient: (config) =>
      createA2AGatewayBrokerClient(config, {
        createRawBrokerClient: () => ({
          async getTask(taskId) {
            return tasks.get(taskId);
          },
        }),
      }),
  });

  // Operator-visible receipt
  let response;
  await handlers.handleA2ATaskStatus({
    params: { sessionKey: 'session-alpha', taskId: 'task-delivered' },
    respond(ok, result) {
      response = { ok, result };
    },
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.receiptStatus, 'operator_visible');
  assert.equal(response.result.deliveryStatus, 'skipped');

  // Provider-delivered (no operator confirmation)
  await handlers.handleA2ATaskStatus({
    params: { sessionKey: 'session-alpha', taskId: 'task-completed' },
    respond(ok, result) {
      response = { ok, result };
    },
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.receiptStatus, 'provider_delivered_if_known');

  // Stale session on active task
  await handlers.handleA2ATaskStatus({
    params: { sessionKey: 'session-alpha', taskId: 'task-stale' },
    respond(ok, result) {
      response = { ok, result };
    },
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.receiptStatus, 'stale');
  assert.equal(response.result.executionStatus, 'accepted');
});

test('status handler maps timeout and cancel states through the plugin contract', async () => {
  const timeoutTask = createBrokerTask({
    id: 'task-timeout',
    status: 'failed',
    error: { code: 'timed_out', message: 'broker timeout' },
    payload: {
      correlationId: 'corr-timeout',
      parentRunId: 'parent-timeout',
      requesterSessionKey: 'session-alpha',
      requesterChannel: 'telegram',
      targetSessionKey: 'session-beta',
      targetDisplayKey: 'beta',
    },
  });
  const canceledTask = createBrokerTask({
    id: 'task-cancel',
    status: 'canceled',
    payload: {
      requesterSessionKey: 'session-alpha',
      targetSessionKey: 'session-beta',
    },
  });

  const tasks = new Map([
    ['task-timeout', timeoutTask],
    ['task-cancel', canceledTask],
  ]);

  const handlers = createA2AGatewayHandlers(createBaseConfig(), {
    createBrokerClient: (config) =>
      createA2AGatewayBrokerClient(config, {
        createRawBrokerClient: () => ({
          async getTask(taskId) {
            return tasks.get(taskId);
          },
        }),
      }),
  });

  let timeoutResponse;
  await handlers.handleA2ATaskStatus({
    params: { sessionKey: 'session-alpha', taskId: 'task-timeout' },
    respond(ok, result, error) {
      timeoutResponse = { ok, result, error };
    },
  });

  assert.equal(timeoutResponse.ok, true);
  assert.equal(timeoutResponse.result.executionStatus, 'timed_out');
  assert.equal(timeoutResponse.result.deliveryStatus, 'skipped');
  assert.deepEqual(timeoutResponse.result.error, {
    code: 'timed_out',
    message: 'broker timeout',
  });

  let cancelResponse;
  await handlers.handleA2ATaskStatus({
    params: { sessionKey: 'session-alpha', taskId: 'task-cancel' },
    respond(ok, result, error) {
      cancelResponse = { ok, result, error };
    },
  });

  assert.equal(cancelResponse.ok, true);
  assert.equal(cancelResponse.result.executionStatus, 'cancelled');
  assert.equal(cancelResponse.result.deliveryStatus, 'skipped');
  assert.equal(cancelResponse.result.taskId, 'task-cancel');
});

// ── safeSessionKeyLabel unit tests ──────────────────────────────

test('safeSessionKeyLabel returns <missing> for undefined / null', () => {
  assert.equal(safeSessionKeyLabel(undefined), '<missing>');
  assert.equal(safeSessionKeyLabel(null), '<missing>');
});

test('safeSessionKeyLabel returns <empty> for empty / whitespace strings', () => {
  assert.equal(safeSessionKeyLabel(''), '<empty>');
  assert.equal(safeSessionKeyLabel('   '), '<empty>');
});

test('safeSessionKeyLabel returns <present> for valid non-empty strings', () => {
  assert.equal(safeSessionKeyLabel('session-alpha'), '<present>');
  assert.equal(safeSessionKeyLabel('any-secret-key'), '<present>');
  assert.equal(safeSessionKeyLabel(123), '<present>');
});

// ── validateParams sessionKey redaction tests ───────────────────

test('validateParams redacts missing sessionKey as <missing>', () => {
  const result = validateParams(
    { instructions: 'hello' },  // no sessionKey at all
    validateA2ATaskRequestParams,
    'a2a.task.request',
  );
  assert.equal(result.valid, false);
  assert.ok(result.error.message.includes('<missing>'),
    `expected <missing> in error, got: ${result.error.message}`);
  // Raw value markers must not appear in error
  assert.ok(!result.error.message.includes('undefined'),
    `raw "undefined" leaked: ${result.error.message}`);
});

test('validateParams redacts empty sessionKey as <empty>', () => {
  const result = validateParams(
    { sessionKey: '', request: { method: 'a2a.task.request', target: { sessionKey: 't', displayKey: 't' }, task: { intent: 'ask', instructions: 'hello' } } },
    validateA2ATaskRequestParams,
    'a2a.task.request',
  );
  assert.equal(result.valid, false);
  assert.ok(result.error.message.includes('<empty>'),
    `expected <empty> in error, got: ${result.error.message}`);
  // The raw empty string must not cause "" to appear literally
  assert.ok(!result.error.message.includes('""'),
    `raw empty-string "" leaked: ${result.error.message}`);
});

test('validateParams never includes raw sessionKey value in error message', () => {
  // Pass a valid sessionKey alongside intentionally bad params so AJV
  // generates errors that do *not* involve sessionKey itself.
  const SENSITIVE_VALUE = 'super-secret-session-key-abc123';
  const result = validateParams(
    {
      sessionKey: SENSITIVE_VALUE,
      request: {
        method: 'a2a.task.request',
        target: { sessionKey: SENSITIVE_VALUE, displayKey: 't' },
        task: { intent: 'ask', instructions: '' },  // empty instructions → fails
      },
    },
    validateA2ATaskRequestParams,
    'a2a.task.request',
  );
  assert.equal(result.valid, false);
  assert.ok(!result.error.message.includes(SENSITIVE_VALUE),
    `raw sessionKey value leaked into error message: ${result.error.message}`);
  assert.ok(!result.error.message.includes('super-secret'),
    `sessionKey substring leaked: ${result.error.message}`);
});

test('validateParams redacts nested target.sessionKey correctly', () => {
  // Provide a valid top-level sessionKey but an empty nested sessionKey in target
  const result = validateParams(
    {
      sessionKey: 'valid-session',
      request: {
        method: 'a2a.task.request',
        target: { sessionKey: '', displayKey: '' },  // both empty
        task: { intent: 'ask', instructions: 'hello' },
      },
    },
    validateA2ATaskRequestParams,
    'a2a.task.request',
  );
  assert.equal(result.valid, false);
  assert.ok(result.error.message.includes('<empty>'),
    `expected <empty> for nested sessionKey, got: ${result.error.message}`);
});
