import test from "node:test";
import assert from "node:assert/strict";

import {
  createRemoteNodeHandoffAdapter,
} from "../dist/src/remote-node-handoff-adapter.js";
import {
  resolveRemoteNodeId,
} from "../dist/src/remote-node-resolver.js";
import {
  createA2ASessionsSendHookWithRemoteResolution,
} from "../dist/src/sessions-send-hook.js";

function activeConfig() {
  return {
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: { baseUrl: "https://broker.example" },
        },
      },
    },
  };
}

function inactiveConfig() {
  return {
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: false,
          config: { baseUrl: "https://broker.example" },
        },
      },
    },
  };
}

function buildBrokerTaskRecord(overrides = {}) {
  return {
    id: "task-remote-1",
    intent: "chat",
    status: "queued",
    requester: { id: "hub-session", kind: "session", role: "hub" },
    target: { id: "node-remote", kind: "node" },
    targetNodeId: "node-remote",
    payload: {
      targetSessionKey: "node-remote",
      targetDisplayKey: "node-remote",
      announceTimeoutMs: 30000,
      maxPingPongTurns: 0,
    },
    createdAt: "2026-04-26T00:00:00Z",
    updatedAt: "2026-04-26T00:00:00Z",
    ...overrides,
  };
}

test("resolveRemoteNodeId: bare node-id is treated as remote", () => {
  assert.deepEqual(resolveRemoteNodeId("node-remote"), {
    remote: true,
    nodeId: "node-remote",
    delegatable: true,
  });
});

test("resolveRemoteNodeId: keys with the agent prefix separator stay local", () => {
  assert.deepEqual(resolveRemoteNodeId("agent:main:telegram:hub-session"), {
    remote: false,
  });
});

test("resolveRemoteNodeId: knownLocalAgents overrides bare-name detection", () => {
  assert.deepEqual(
    resolveRemoteNodeId("hub", { knownLocalAgents: ["hub", "ops"] }),
    { remote: false },
  );
  assert.deepEqual(
    resolveRemoteNodeId("node-remote", { knownLocalAgents: new Set(["hub"]) }),
    { remote: true, nodeId: "node-remote", delegatable: true },
  );
});

test("remote node-id with adapter active: broker task preserves targetNodeId", async () => {
  const createTaskCalls = [];
  const hook = createA2ASessionsSendHookWithRemoteResolution(
    activeConfig(),
    undefined,
    {
      createBrokerClient: () => ({
        createTask: async (request) => {
          createTaskCalls.push(request);
          return buildBrokerTaskRecord({
            payload: { ...request.payload, waitRunId: "wait-remote-1" },
          });
        },
      }),
    },
  );

  const result = await hook({
    sessionKey: "node-remote",
    target: { sessionKey: "node-remote", displayKey: "node-remote" },
    message: "delegate this",
    task: {
      intent: "delegate",
      instructions: "delegate this",
      requester: { sessionKey: "hub-session", channel: "telegram" },
      runtime: { waitRunId: "wait-remote-1" },
    },
    rawParams: {},
  });

  assert.equal(result.handled, true);
  assert.equal(result.mode, "delegated");
  assert.deepEqual(result.remote, { nodeId: "node-remote", source: "displayKey" });
  assert.equal(result.dispatch.kind, "a2a-broker");
  assert.equal(result.dispatch.taskId, "task-remote-1");

  assert.equal(createTaskCalls.length, 1);
  const sent = createTaskCalls[0];
  assert.equal(sent.target.id, "node-remote");
  assert.equal(sent.target.kind, "node");
  assert.equal(sent.assignedWorkerId, "node-remote");
  assert.equal(sent.payload.targetSessionKey, "node-remote");
  assert.equal(sent.payload.targetDisplayKey, "node-remote");
});

test("remote node-id without adapter active: returns handled:false with remote metadata", async () => {
  let innerCalled = false;
  const adapter = createRemoteNodeHandoffAdapter(inactiveConfig(), {
    innerHook: async () => {
      innerCalled = true;
      return { handled: false, reason: "should not be reached" };
    },
  });

  const result = await adapter({
    sessionKey: "node-remote",
    target: { sessionKey: "node-remote", displayKey: "node-remote" },
    message: "delegate this",
    task: {
      intent: "delegate",
      instructions: "delegate this",
      requester: { sessionKey: "hub-session", channel: "telegram" },
    },
    rawParams: {},
  });

  assert.equal(innerCalled, false);
  assert.equal(result.handled, false);
  assert.equal(result.reason, "remote node-id requires A2A adapter");
  assert.deepEqual(result.remote, { nodeId: "node-remote", source: "displayKey" });
  assert.equal(result.visibility, "policy_denied");
  assert.equal(result.policy.status, "denied");
});

test("local session key passes through to inner hook unchanged", async () => {
  const innerCalls = [];
  const innerResult = {
    handled: true,
    mode: "delegated",
    dispatch: {
      kind: "a2a-broker",
      taskId: "task-local-1",
      waitRunId: "wait-local-1",
      cancelTarget: undefined,
    },
  };
  const adapter = createRemoteNodeHandoffAdapter(activeConfig(), {
    innerHook: async (event) => {
      innerCalls.push(event);
      return innerResult;
    },
  });

  const event = {
    sessionKey: "agent:main:telegram:hub-session",
    target: {
      sessionKey: "agent:main:telegram:worker-session",
      displayKey: "agent:main:telegram:worker-session",
    },
    message: "delegate this",
    task: {
      intent: "delegate",
      instructions: "delegate this",
      requester: { sessionKey: "hub-session", channel: "telegram" },
      runtime: { waitRunId: "wait-local-1" },
    },
    rawParams: {},
  };
  const result = await adapter(event);

  assert.equal(innerCalls.length, 1);
  assert.equal(innerCalls[0], event);
  assert.equal(result, innerResult);
  assert.equal(result.remote, undefined);
});

test("mixed displayKey remote + sessionKey local: detected via displayKey", async () => {
  const createTaskCalls = [];
  const hook = createA2ASessionsSendHookWithRemoteResolution(
    activeConfig(),
    undefined,
    {
      createBrokerClient: () => ({
        createTask: async (request) => {
          createTaskCalls.push(request);
          return buildBrokerTaskRecord({
            id: "task-mixed-1",
            payload: { ...request.payload, waitRunId: "wait-mixed-1" },
          });
        },
      }),
    },
  );

  const result = await hook({
    sessionKey: "agent:main:telegram:hub-session",
    target: {
      sessionKey: "agent:main:telegram:worker-session",
      displayKey: "node-remote",
    },
    message: "delegate this",
    task: {
      intent: "delegate",
      instructions: "delegate this",
      requester: { sessionKey: "hub-session", channel: "telegram" },
      runtime: { waitRunId: "wait-mixed-1" },
    },
    rawParams: {},
  });

  assert.equal(result.handled, true);
  assert.equal(result.mode, "delegated");
  assert.deepEqual(result.remote, { nodeId: "node-remote", source: "displayKey" });
  assert.equal(createTaskCalls.length, 1);
  const sent = createTaskCalls[0];
  assert.equal(sent.target.id, "node-remote");
  assert.equal(sent.target.kind, "node");
  assert.equal(sent.assignedWorkerId, "node-remote");
  // The local sessionKey is preserved as the broker-side targetSessionKey.
  assert.equal(sent.payload.targetSessionKey, "agent:main:telegram:worker-session");
  assert.equal(sent.payload.targetDisplayKey, "node-remote");
});

test("additive broker metadata tolerance: extra payload fields are preserved", async () => {
  const innerHook = async (event) => ({
    handled: true,
    mode: "delegated",
    dispatch: {
      kind: "a2a-broker",
      taskId: "task-extra-1",
      waitRunId: event.task?.runtime?.waitRunId ?? "wait-extra-1",
      cancelTarget: undefined,
      // Additive fields beyond the minimum dispatch contract should survive.
      brokerMetadata: { tenant: "alpha", retries: 0 },
    },
  });
  const adapter = createRemoteNodeHandoffAdapter(activeConfig(), { innerHook });

  const result = await adapter({
    sessionKey: "node-remote",
    target: { sessionKey: "node-remote", displayKey: "node-remote" },
    message: "delegate this",
    task: {
      intent: "delegate",
      instructions: "delegate this",
      runtime: { waitRunId: "wait-extra-1" },
    },
    // Additional unknown rawParams fields must not be rejected.
    rawParams: { taskId: "task-extra-1", traceparent: "00-abc-def-01" },
  });

  assert.equal(result.handled, true);
  assert.equal(result.mode, "delegated");
  assert.deepEqual(result.remote, { nodeId: "node-remote", source: "displayKey" });
  assert.equal(result.dispatch.taskId, "task-extra-1");
  assert.equal(result.dispatch.waitRunId, "wait-extra-1");
  assert.deepEqual(result.dispatch.brokerMetadata, { tenant: "alpha", retries: 0 });
});

test("remote detection falls back to sessionKey when displayKey is local-shaped", async () => {
  let received;
  const adapter = createRemoteNodeHandoffAdapter(inactiveConfig(), {
    innerHook: async (event) => {
      received = event;
      return { handled: false };
    },
  });

  const result = await adapter({
    sessionKey: "agent:main:telegram:hub-session",
    target: { sessionKey: "node-remote" },
    message: "ping",
    task: { intent: "delegate", instructions: "ping" },
    rawParams: {},
  });

  assert.equal(received, undefined);
  assert.equal(result.handled, false);
  assert.equal(result.reason, "remote node-id requires A2A adapter");
  assert.deepEqual(result.remote, { nodeId: "node-remote", source: "sessionKey" });
  assert.equal(result.visibility, "policy_denied");
  assert.equal(result.policy.status, "denied");
});

test("post-merge visibility regression: policy outcomes stop before dispatch with stable surfaces", async () => {
  const cases = [
    {
      name: "denied target",
      policy: { deniedTargets: ["node-remote"] },
      expectedStatus: "denied",
      expectedVisibility: "policy_denied",
      rawParams: {},
    },
    {
      name: "approval-required live handoff",
      policy: { allowedTargets: ["node-remote"], requireApprovalForLiveImpact: true },
      expectedStatus: "approval_required",
      expectedVisibility: "approval_required",
      rawParams: { taskInput: { policyContext: { targetEnvironment: "live" } } },
    },
  ];

  for (const item of cases) {
    let innerCalled = false;
    const adapter = createRemoteNodeHandoffAdapter(activeConfig(), {
      visibilityPolicy: item.policy,
      innerHook: async () => {
        innerCalled = true;
        return { handled: true, mode: "direct", result: { name: item.name } };
      },
    });

    const result = await adapter({
      sessionKey: "agent:main:telegram:hub-session",
      target: { sessionKey: "agent:main:telegram:worker-session", displayKey: "node-remote" },
      message: "delegate this",
      task: { intent: "delegate", instructions: "delegate this" },
      rawParams: item.rawParams,
    });

    assert.equal(innerCalled, false, item.name);
    assert.equal(result.handled, false, item.name);
    assert.equal(result.policy.status, item.expectedStatus, item.name);
    assert.equal(result.visibility, item.expectedVisibility, item.name);
    assert.deepEqual(result.remote, { nodeId: "node-remote", source: "displayKey" }, item.name);
  }
});

test("post-merge visibility regression: inactive adapter blocks after policy allows", async () => {
  let innerCalled = false;
  const adapter = createRemoteNodeHandoffAdapter(inactiveConfig(), {
    visibilityPolicy: { allowedTargets: ["node-remote"] },
    innerHook: async () => {
      innerCalled = true;
      return { handled: true, mode: "direct", result: {} };
    },
  });

  const result = await adapter({
    sessionKey: "agent:main:telegram:hub-session",
    target: { sessionKey: "agent:main:telegram:worker-session", displayKey: "node-remote" },
    message: "delegate this",
    task: { intent: "delegate", instructions: "delegate this" },
    rawParams: {},
  });

  assert.equal(innerCalled, false);
  assert.equal(result.handled, false);
  assert.equal(result.reason, "remote node-id requires A2A adapter");
  assert.equal(result.visibility, "policy_denied");
  assert.equal(result.policy.status, "denied");
  assert.deepEqual(result.remote, { nodeId: "node-remote", source: "displayKey" });
});

test("post-merge visibility regression: policy exceptions surface as error without dispatch", async () => {
  let innerCalled = false;
  const rawParams = {};
  Object.defineProperty(rawParams, "taskInput", {
    get() {
      throw new Error("policy context unavailable");
    },
  });

  const adapter = createRemoteNodeHandoffAdapter(activeConfig(), {
    innerHook: async () => {
      innerCalled = true;
      return { handled: true, mode: "direct", result: {} };
    },
  });

  const result = await adapter({
    sessionKey: "agent:main:telegram:hub-session",
    target: { sessionKey: "agent:main:telegram:worker-session", displayKey: "node-remote" },
    message: "delegate this",
    task: { intent: "delegate", instructions: "delegate this" },
    rawParams,
  });

  assert.equal(innerCalled, false);
  assert.equal(result.handled, false);
  assert.equal(result.visibility, "error");
  assert.equal(result.policy.status, "error");
  assert.match(result.reason, /policy context unavailable/);
  assert.deepEqual(result.remote, { nodeId: "node-remote", source: "displayKey" });
});
