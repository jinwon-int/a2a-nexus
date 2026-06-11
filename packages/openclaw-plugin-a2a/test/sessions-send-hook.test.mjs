import test from "node:test";
import assert from "node:assert/strict";

import { createA2ASessionsSendHook } from "../dist/src/sessions-send-hook.js";

function createWaitRunsMock() {
  const entries = new Map();
  const waiters = new Map();
  function notify(runId) {
    const list = waiters.get(runId);
    if (!list) {
      return;
    }
    waiters.delete(runId);
    const record = entries.get(runId);
    for (const resolve of list) {
      resolve(record ?? null);
    }
  }
  return {
    create({ runId, startedAt } = {}) {
      const id = runId ?? `wait-${entries.size + 1}`;
      const existing = entries.get(id);
      if (existing) {
        return existing;
      }
      const record = { runId: id, status: "pending", startedAt: startedAt ?? Date.now() };
      entries.set(id, record);
      return record;
    },
    get(runId) {
      return entries.get(runId) ?? null;
    },
    async wait({ runId, timeoutMs }) {
      const record = entries.get(runId);
      if (!record) {
        return null;
      }
      if (record.status !== "pending") {
        return record;
      }
      return await new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        const handle = setTimeout(() => {
          finish({ runId, status: "timeout", startedAt: record.startedAt });
        }, timeoutMs);
        const list = waiters.get(runId) ?? [];
        list.push((value) => {
          clearTimeout(handle);
          finish(value);
        });
        waiters.set(runId, list);
      });
    },
    resolve({ runId, replyText, startedAt, endedAt }) {
      const record = entries.get(runId) ?? { runId, status: "pending" };
      record.status = "ok";
      if (replyText !== undefined) record.replyText = replyText;
      if (startedAt !== undefined) record.startedAt = startedAt;
      record.endedAt = endedAt ?? Date.now();
      entries.set(runId, record);
      notify(runId);
      return record;
    },
    fail({ runId, status, error, replyText, startedAt, endedAt }) {
      const record = entries.get(runId) ?? { runId, status: "pending" };
      record.status = status ?? "error";
      if (error !== undefined) record.error = error;
      if (replyText !== undefined) record.replyText = replyText;
      if (startedAt !== undefined) record.startedAt = startedAt;
      record.endedAt = endedAt ?? Date.now();
      entries.set(runId, record);
      notify(runId);
      return record;
    },
    cancel({ runId, error, replyText, startedAt, endedAt }) {
      const record = entries.get(runId) ?? { runId, status: "pending" };
      record.status = "error";
      record.error = error?.trim() || "cancelled";
      if (replyText !== undefined) record.replyText = replyText;
      if (startedAt !== undefined) record.startedAt = startedAt;
      record.endedAt = endedAt ?? Date.now();
      entries.set(runId, record);
      notify(runId);
      return record;
    },
    clear(runId) {
      return entries.delete(runId);
    },
  };
}

function createCanonicalRuntime() {
  const sendTextCalls = [];
  const waitRuns = createWaitRunsMock();
  const runtime = {
    subagent: {
      run: async () => ({ runId: "subagent-run-1" }),
      waitForRun: async () => ({ status: "ok" }),
      getSessionMessages: async () => ({ messages: [] }),
    },
    agent: {
      waitRuns,
      session: {
        resolveStorePath: () => "/tmp/sessions.json",
        loadSessionStore: () => ({}),
      },
    },
    channel: {
      outbound: {
        loadAdapter: async () => ({
          sendText: async (params) => {
            sendTextCalls.push(params);
            return { ok: true };
          },
        }),
      },
    },
  };
  return { runtime, waitRuns, sendTextCalls };
}

test("sessions_send hook routes through canonical wait-run runtime in direct mode", async () => {
  const { runtime } = createCanonicalRuntime();
  let directWake;
  const hook = createA2ASessionsSendHook(
    {
      plugins: {
        entries: {
          "a2a-broker-adapter": {
            enabled: true,
            config: { baseUrl: "https://broker.example" },
          },
        },
      },
    },
    runtime,
    {
      createBrokerClient: () => ({
        createTask: async () => ({
          id: "task-200",
          intent: "chat",
          status: "queued",
          requester: { id: "hub-session", kind: "session", role: "hub" },
          target: { id: "worker-node", kind: "node" },
          targetNodeId: "worker-node",
          payload: { waitRunId: "wait-200" },
          createdAt: "2026-04-19T00:00:00Z",
          updatedAt: "2026-04-19T00:00:00Z",
        }),
        getTask: async () => ({
          id: "task-200",
          intent: "chat",
          status: "succeeded",
          requester: { id: "hub-session", kind: "session", role: "hub" },
          target: { id: "worker-node", kind: "node" },
          targetNodeId: "worker-node",
          payload: { waitRunId: "wait-200" },
          result: { summary: "delegated reply" },
          createdAt: "2026-04-19T00:00:00Z",
          updatedAt: "2026-04-19T00:00:01Z",
        }),
        streamTaskEvents: async function* () {
          yield {
            name: "task-status-update",
            data: {
              id: "task-200",
              kind: "task",
              status: { state: "completed", final: true },
              reason: "succeeded",
              final: true,
            },
          };
        },
        cancelTask: async () => ({}),
      }),
      wake: {
        onResult: (params) => {
          directWake = params;
        },
      },
    },
  );

  const result = await hook({
    sessionKey: "worker-session",
    target: { sessionKey: "worker-session", displayKey: "worker-node" },
    message: "delegate this",
    task: {
      intent: "delegate",
      instructions: "delegate this",
      constraints: { timeoutSeconds: 1 },
      requester: { sessionKey: "hub-session", channel: "telegram" },
      runtime: {
        waitRunId: "wait-200",
      },
    },
    rawParams: {},
  });

  assert.deepEqual(result, {
    handled: true,
    mode: "direct",
    result: {
      runId: "wait-200",
      status: "ok",
      reply: "delegated reply",
      sessionKey: "worker-node",
      delivery: { status: "pending", mode: "announce" },
    },
  });
  assert.equal(directWake.result.status, "skipped");
  assert.equal(directWake.result.plan.code, "wake_disabled");
  assert.equal(directWake.envelope.taskId, "task-200");
  assert.equal(directWake.envelope.waitRunId, "wait-200");
  assert.deepEqual(directWake.envelope.target, {
    sessionKey: "worker-session",
    displayKey: "worker-node",
  });
});

test("sessions_send hook keeps delegated dispatch fallback when canonical seam is absent", async () => {
  const createTaskCalls = [];
  const hook = createA2ASessionsSendHook(
    {
      plugins: {
        entries: {
          "a2a-broker-adapter": {
            enabled: true,
            config: { baseUrl: "https://broker.example" },
          },
        },
      },
    },
    undefined,
    {
      createBrokerClient: () => ({
        createTask: async (request) => {
          createTaskCalls.push(request);
          return {
            id: "task-123",
            intent: "chat",
            status: "queued",
            requester: { id: "hub-session", kind: "session", role: "hub" },
            target: { id: "worker-node", kind: "node" },
            targetNodeId: "worker-node",
            payload: request.payload,
            createdAt: "2026-04-19T00:00:00Z",
            updatedAt: "2026-04-19T00:00:00Z",
          };
        },
      }),
    },
  );

  const result = await hook({
    sessionKey: "worker-session",
    target: { sessionKey: "worker-session", displayKey: "worker-node" },
    message: "delegate this",
    task: {
      intent: "delegate",
      instructions: "delegate this",
      requester: { sessionKey: "hub-session", channel: "telegram" },
      runtime: {
        waitRunId: "wait-123",
        announceTimeoutMs: 45_000,
        maxPingPongTurns: 2,
        cancelTarget: { kind: "session_run", sessionKey: "hub-session", runId: "run-7" },
      },
      correlationId: "corr-123",
      parentRunId: "parent-123",
    },
    rawParams: { taskId: "task-seed-123" },
  });

  assert.deepEqual(result, {
    handled: true,
    mode: "delegated",
    dispatch: {
      kind: "a2a-broker",
      taskId: "task-123",
      waitRunId: "wait-123",
      cancelTarget: { kind: "session_run", sessionKey: "hub-session", runId: "run-7" },
    },
  });

  assert.equal(createTaskCalls.length, 1);
  assert.equal(createTaskCalls[0].id, "task-seed-123");
  assert.equal(createTaskCalls[0].payload.waitRunId, "wait-123");
  assert.equal(createTaskCalls[0].payload.correlationId, "corr-123");
});

test("sessions_send wake envelope is produced only after broker task acceptance", async () => {
  const order = [];
  let seen;
  const hook = createA2ASessionsSendHook(
    {
      plugins: {
        entries: {
          "a2a-broker-adapter": {
            enabled: true,
            config: { baseUrl: "https://broker.example" },
          },
        },
      },
    },
    undefined,
    {
      createBrokerClient: () => ({
        createTask: async () => {
          order.push("createTask:start");
          await Promise.resolve();
          order.push("createTask:accepted");
          return {
            id: "task-accepted",
            intent: "chat",
            status: "claimed",
            requester: { id: "broker-requester-node", kind: "node", role: "hub" },
            target: { id: "broker-target-node", kind: "node" },
            targetNodeId: "broker-target-node",
            payload: {
              waitRunId: "broker-wait",
              correlationId: "broker-corr",
              parentRunId: "broker-parent",
              requesterSessionKey: "broker-requester-session",
              requesterDisplayKey: "broker-requester-node",
              requesterChannel: "telegram",
              targetSessionKey: "broker-target-session",
              targetDisplayKey: "broker-target-node",
              targetChannel: "telegram",
            },
            createdAt: "2026-04-25T00:00:00Z",
            updatedAt: "2026-04-25T00:00:00Z",
          };
        },
      }),
      wake: {
        nowMs: 111,
        onResult: (params) => {
          order.push("wake:onResult");
          seen = params;
        },
      },
    },
  );

  const result = await hook({
    sessionKey: "fallback-target-session",
    target: { sessionKey: "fallback-target-session", displayKey: "fallback-target-node" },
    message: "delegate this",
    task: {
      intent: "delegate",
      instructions: "delegate this",
      requester: { sessionKey: "fallback-requester-session", channel: "signal" },
      runtime: { waitRunId: "fallback-wait" },
      correlationId: "fallback-corr",
      parentRunId: "fallback-parent",
    },
    rawParams: {},
  });

  assert.deepEqual(order, ["createTask:start", "createTask:accepted", "wake:onResult"]);
  assert.deepEqual(result, {
    handled: true,
    mode: "delegated",
    dispatch: {
      kind: "a2a-broker",
      taskId: "task-accepted",
      waitRunId: "broker-wait",
      cancelTarget: undefined,
    },
  });
  assert.equal(seen.result.status, "skipped");
  assert.equal(seen.result.plan.code, "wake_disabled");
  assert.deepEqual(seen.envelope, {
    taskId: "task-accepted",
    waitRunId: "broker-wait",
    correlationId: "broker-corr",
    parentRunId: "broker-parent",
    brokerStatus: "claimed",
    acceptedAtMs: Date.parse("2026-04-25T00:00:00Z"),
    requester: {
      sessionKey: "broker-requester-session",
      displayKey: "broker-requester-node",
      channel: "telegram",
    },
    target: {
      sessionKey: "broker-target-session",
      displayKey: "broker-target-node",
      channel: "telegram",
    },
  });
});

test("sessions_send no-duplicate-send gate blocks replayed sends (hardened)", async () => {
  const createTaskCalls = [];
  const hook = createA2ASessionsSendHook(
    {
      plugins: {
        entries: {
          "a2a-broker-adapter": {
            enabled: true,
            config: { baseUrl: "https://broker.example" },
          },
        },
      },
    },
    undefined,
    {
      createBrokerClient: () => ({
        createTask: async (request) => {
          createTaskCalls.push(request);
          return {
            id: `task-${createTaskCalls.length}`,
            intent: "chat",
            status: "queued",
            requester: { id: "hub-session", kind: "session", role: "hub" },
            target: { id: "worker-node", kind: "node" },
            targetNodeId: "worker-node",
            payload: request.payload,
            createdAt: "2026-04-19T00:00:00Z",
            updatedAt: "2026-04-19T00:00:00Z",
          };
        },
      }),
    },
  );

  const event = {
    sessionKey: "worker-session",
    target: { sessionKey: "worker-session", displayKey: "worker-node" },
    message: "delegate this",
    task: {
      intent: "delegate",
      instructions: "delegate this",
      correlationId: "corr-901",
      requester: { sessionKey: "hub-session", channel: "telegram" },
    },
    rawParams: {},
  };

  // First send — should succeed normally
  const first = await hook(event);
  assert.equal(first.handled, true);
  assert.equal(first.mode, "delegated");
  assert.equal(createTaskCalls.length, 1);

  // Second send with same fingerprint — blocked by no-duplicate-send gate
  const second = await hook(event);
  assert.equal(second.handled, false);
  assert.equal(second.reason, "duplicate send suppressed by no-duplicate-send gate");
  // No additional broker task created
  assert.equal(createTaskCalls.length, 1);

  // Different message — should succeed normally
  const third = await hook({ ...event, message: "delegate something else" });
  assert.equal(third.handled, true);
  assert.equal(createTaskCalls.length, 2);
});

test("sessions_send no-duplicate-send gate can be disabled via config", async () => {
  const createTaskCalls = [];
  const hook = createA2ASessionsSendHook(
    {
      plugins: {
        entries: {
          "a2a-broker-adapter": {
            enabled: true,
            config: {
              baseUrl: "https://broker.example",
              noDuplicateSend: { enabled: false },
            },
          },
        },
      },
    },
    undefined,
    {
      createBrokerClient: () => ({
        createTask: async (request) => {
          createTaskCalls.push(request);
          return {
            id: `task-${createTaskCalls.length}`,
            intent: "chat",
            status: "queued",
            requester: { id: "hub-session", kind: "session", role: "hub" },
            target: { id: "worker-node", kind: "node" },
            targetNodeId: "worker-node",
            payload: request.payload,
            createdAt: "2026-04-19T00:00:00Z",
            updatedAt: "2026-04-19T00:00:00Z",
          };
        },
      }),
    },
  );

  const event = {
    sessionKey: "worker-session",
    target: { sessionKey: "worker-session", displayKey: "worker-node" },
    message: "delegate this",
    task: {
      intent: "delegate",
      instructions: "delegate this",
      correlationId: "corr-legacy",
      requester: { sessionKey: "hub-session", channel: "telegram" },
    },
    rawParams: {},
  };

  // First send
  const first = await hook(event);
  assert.equal(first.handled, true);
  assert.equal(first.mode, "delegated");
  assert.equal(createTaskCalls.length, 1);

  // Second send — gate disabled, broker task still created, wake suppressed
  const second = await hook(event);
  assert.equal(second.handled, true);
  assert.equal(second.mode, "delegated");
  assert.equal(createTaskCalls.length, 2);
});

test("sessions_send dupe gate treats different correlationIds as distinct sends", async () => {
  const createTaskCalls = [];
  const hook = createA2ASessionsSendHook(
    {
      plugins: {
        entries: {
          "a2a-broker-adapter": {
            enabled: true,
            config: { baseUrl: "https://broker.example" },
          },
        },
      },
    },
    undefined,
    {
      createBrokerClient: () => ({
        createTask: async (request) => {
          createTaskCalls.push(request);
          return {
            id: `task-${createTaskCalls.length}`,
            intent: "chat",
            status: "queued",
            requester: { id: "hub-session", kind: "session", role: "hub" },
            target: { id: "worker-node", kind: "node" },
            targetNodeId: "worker-node",
            payload: request.payload,
            createdAt: "2026-04-19T00:00:00Z",
            updatedAt: "2026-04-19T00:00:00Z",
          };
        },
      }),
    },
  );

  await hook({
    sessionKey: "worker-session",
    target: { sessionKey: "worker-session", displayKey: "worker-node" },
    message: "delegate this",
    task: {
      intent: "delegate",
      instructions: "delegate this",
      correlationId: "corr-aaa",
    },
    rawParams: {},
  });

  await hook({
    sessionKey: "worker-session",
    target: { sessionKey: "worker-session", displayKey: "worker-node" },
    message: "delegate this",
    task: {
      intent: "delegate",
      instructions: "delegate this",
      correlationId: "corr-bbb", // Different correlation
    },
    rawParams: {},
  });

  assert.equal(createTaskCalls.length, 2);
});

test("sessions_send wake envelope is not produced when broker acceptance fails", async () => {
  let wakeCalled = false;
  const hook = createA2ASessionsSendHook(
    {
      plugins: {
        entries: {
          "a2a-broker-adapter": {
            enabled: true,
            config: { baseUrl: "https://broker.example" },
          },
        },
      },
    },
    undefined,
    {
      createBrokerClient: () => ({
        createTask: async () => {
          throw new Error("broker down");
        },
      }),
      wake: {
        onResult: () => {
          wakeCalled = true;
        },
      },
    },
  );

  await assert.rejects(
    hook({
      sessionKey: "worker-session",
      target: { sessionKey: "worker-session", displayKey: "worker-node" },
      message: "delegate this",
      task: { intent: "delegate", instructions: "delegate this" },
      rawParams: {},
    }),
    /broker down/,
  );
  assert.equal(wakeCalled, false);
});

test("no-duplicate-send fingerprint distinguishes field layouts that previously collided (a2a-nexus#575 item 1)", async () => {
  const createTaskCalls = [];
  const hook = createA2ASessionsSendHook(
    {
      plugins: {
        entries: {
          "a2a-broker-adapter": {
            enabled: true,
            config: { baseUrl: "https://broker.example" },
          },
        },
      },
    },
    undefined,
    {
      createBrokerClient: () => ({
        createTask: async (request) => {
          createTaskCalls.push(request);
          return {
            id: `task-${createTaskCalls.length}`,
            intent: "chat",
            status: "queued",
            requester: { id: "hub-session", kind: "session", role: "hub" },
            target: { id: "worker-node", kind: "node" },
            targetNodeId: "worker-node",
            payload: request.payload,
            createdAt: "2026-04-19T00:00:00Z",
            updatedAt: "2026-04-19T00:00:00Z",
          };
        },
      }),
    },
  );

  // Pre-fix, .filter(Boolean) collapsed empty fingerprint slots, so these two
  // distinct sends both hashed "k|i|m": the first has no correlationId
  // ([key, intent, msg] = k|i|m) and the second has no message
  // ([corr, key, intent] = k|i|m). The second send was suppressed as a
  // duplicate of the first.
  const first = await hook({
    sessionKey: "k",
    target: { sessionKey: "k", displayKey: "worker-node" },
    message: "m",
    task: {
      intent: "i",
      instructions: "do the first thing",
      requester: { sessionKey: "hub-session", channel: "telegram" },
    },
    rawParams: {},
  });
  assert.equal(first.handled, true);
  assert.equal(createTaskCalls.length, 1);

  const second = await hook({
    sessionKey: "i",
    target: { sessionKey: "i", displayKey: "worker-node" },
    task: {
      intent: "m",
      instructions: "do the second thing",
      correlationId: "k",
      requester: { sessionKey: "hub-session", channel: "telegram" },
    },
    rawParams: {},
  });
  assert.equal(
    second.handled,
    true,
    "a send with a different field layout must not be suppressed as a duplicate",
  );
  assert.equal(createTaskCalls.length, 2);
});
