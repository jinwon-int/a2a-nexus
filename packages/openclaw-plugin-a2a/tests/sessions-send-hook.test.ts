import assert from "node:assert/strict";
import { describe, it } from "node:test";
import plugin from "../dist/index.js";
import { createA2ASessionsSendHook } from "../dist/src/sessions-send-hook.js";

type WaitRunStatus = "pending" | "ok" | "error" | "timeout";
type WaitRunRecord = {
  runId: string;
  status: WaitRunStatus;
  error?: string;
  replyText?: string;
  startedAt?: number;
  endedAt?: number;
};

function createWaitRunsMock(options: { timeoutWaits?: boolean } = {}) {
  const entries = new Map<string, WaitRunRecord>();
  const waiters = new Map<string, Array<(record: WaitRunRecord | null) => void>>();

  function notify(runId: string) {
    const list = waiters.get(runId);
    if (!list) {
      return;
    }
    waiters.delete(runId);
    const record = entries.get(runId) ?? null;
    for (const resolve of list) {
      resolve(record);
    }
  }

  return {
    create({ runId, startedAt }: { runId?: string; startedAt?: number } = {}) {
      const id = runId ?? `wait-${entries.size + 1}`;
      const existing = entries.get(id);
      if (existing) {
        return existing;
      }
      const record: WaitRunRecord = {
        runId: id,
        status: "pending",
        startedAt: startedAt ?? Date.now(),
      };
      entries.set(id, record);
      return record;
    },
    get(runId: string) {
      return entries.get(runId) ?? null;
    },
    async wait({ runId }: { runId: string; timeoutMs: number }) {
      const record = entries.get(runId);
      if (!record) {
        return null;
      }
      if (options.timeoutWaits) {
        return { runId, status: "timeout", startedAt: record.startedAt } satisfies WaitRunRecord;
      }
      if (record.status !== "pending") {
        return record;
      }
      return await new Promise<WaitRunRecord | null>((resolve) => {
        const list = waiters.get(runId) ?? [];
        list.push(resolve);
        waiters.set(runId, list);
      });
    },
    resolve({ runId, replyText, startedAt, endedAt }: { runId: string; replyText?: string; startedAt?: number; endedAt?: number }) {
      const record = entries.get(runId) ?? { runId, status: "pending" as const };
      const next: WaitRunRecord = {
        ...record,
        status: "ok",
        ...(replyText !== undefined ? { replyText } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
        endedAt: endedAt ?? Date.now(),
      };
      entries.set(runId, next);
      notify(runId);
      return next;
    },
    fail({ runId, status, error, replyText, startedAt, endedAt }: { runId: string; status?: "error" | "timeout"; error?: string; replyText?: string; startedAt?: number; endedAt?: number }) {
      const record = entries.get(runId) ?? { runId, status: "pending" as const };
      const next: WaitRunRecord = {
        ...record,
        status: status ?? "error",
        ...(error !== undefined ? { error } : {}),
        ...(replyText !== undefined ? { replyText } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
        endedAt: endedAt ?? Date.now(),
      };
      entries.set(runId, next);
      notify(runId);
      return next;
    },
    cancel({ runId, error, replyText, startedAt, endedAt }: { runId: string; error?: string; replyText?: string; startedAt?: number; endedAt?: number }) {
      return this.fail({
        runId,
        status: "error",
        error: error?.trim() || "cancelled",
        replyText,
        startedAt,
        endedAt,
      });
    },
    clear(runId: string) {
      return entries.delete(runId);
    },
  };
}

function createRuntimeMock(options: { timeoutWaits?: boolean } = {}) {
  const sendTextCalls: Array<Record<string, unknown>> = [];
  const waitRuns = createWaitRunsMock(options);
  const runtime = {
    subagent: {
      run: async () => ({ runId: "subagent-run-1" }),
      waitForRun: async () => ({ status: "ok" as const }),
      getSessionMessages: async () => ({ messages: [] }),
      getSession: async () => ({ messages: [] }),
      deleteSession: async () => {},
    },
    agent: {
      waitRuns,
      session: {
        resolveStorePath: () => "/tmp/sessions.json",
        loadSessionStore: () => ({
          "worker-session": {
            deliveryContext: {
              channel: "discord",
              to: "group:worker",
            },
          },
        }),
      },
    },
    channel: {
      outbound: {
        loadAdapter: async () => ({
          sendText: async (params: Record<string, unknown>) => {
            sendTextCalls.push(params);
            return { ok: true };
          },
        }),
      },
    },
  };
  return { runtime: runtime as never, sendTextCalls, waitRuns };
}

describe("sessions_send hook registration", () => {
  it("does not register sessions_send unless the host advertises that typed hook", () => {
    const hookNames: string[] = [];
    const { runtime } = createRuntimeMock();
    plugin.register({
      config: {},
      runtime,
      on: (hookName: string) => {
        if (hookName === "sessions_send") hookNames.push(hookName);
      },
      registerConfigMigration: () => {},
      registerGatewayMethod: () => {},
    } as never);
    assert.deepEqual(hookNames, []);
  });

  it("registers the plugin-owned sessions_send hook when explicitly supported", () => {
    const hookNames: string[] = [];
    const { runtime } = createRuntimeMock();
    plugin.register({
      config: {},
      runtime,
      supportsTypedHook: (hookName: string) => hookName === "sessions_send",
      on: (hookName: string) => {
        if (hookName === "sessions_send") hookNames.push(hookName);
      },
      registerConfigMigration: () => {},
      registerGatewayMethod: () => {},
    } as never);
    assert.deepEqual(hookNames, ["sessions_send"]);
  });
});

describe("createA2ASessionsSendHook", () => {
  it("declines when the adapter is inactive", async () => {
    const hook = createA2ASessionsSendHook({});
    const result = await hook({
      sessionKey: "worker-session",
      target: { sessionKey: "worker-session", displayKey: "worker-session" },
      message: "ping",
      task: { intent: "delegate", instructions: "ping" },
      rawParams: {},
    });
    assert.deepEqual(result, { handled: false, reason: "a2a broker adapter inactive" });
  });

  it("keeps delegated dispatch fallback when no runtime is provided", async () => {
    const createTaskCalls: Array<Record<string, unknown>> = [];
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
          createTask: async (request: Record<string, unknown>) => {
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
        }) as never,
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
    const request = createTaskCalls[0];
    assert.equal(request.id, "task-seed-123");
    assert.equal((request.payload as Record<string, unknown>).waitRunId, "wait-123");
    assert.equal((request.payload as Record<string, unknown>).correlationId, "corr-123");
    assert.equal((request.payload as Record<string, unknown>).parentRunId, "parent-123");
  });

  it("wires opt-in Wake-on-Task through the runtime adapter after broker acceptance", async () => {
    const wakeCalls: Array<Record<string, unknown>> = [];
    const hook = createA2ASessionsSendHook(
      {
        plugins: {
          entries: {
            "a2a-broker-adapter": {
              enabled: true,
              config: { baseUrl: "https://broker.example", wakeOnTask: { enabled: true } },
            },
          },
        },
      },
      undefined,
      {
        createBrokerClient: () => ({
          createTask: async (request: Record<string, unknown>) => ({
            id: "task-wake-1",
            intent: "chat",
            status: "queued",
            requester: { id: "hub-session", kind: "session", role: "hub" },
            target: { id: "worker-node", kind: "node" },
            targetNodeId: "worker-node",
            payload: request.payload,
            createdAt: "2026-04-19T00:00:00Z",
            updatedAt: "2026-04-19T00:00:00Z",
          }),
        }) as never,
        wakeRuntime: {
          dispatchWake: async (params: Record<string, unknown>) => {
            wakeCalls.push(params);
            return { accepted: true, runtimeRunId: "wake-run-1", queuedAtMs: 1234 };
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
        requester: { sessionKey: "hub-session", channel: "telegram" },
        runtime: { waitRunId: "wait-wake-1" },
        correlationId: "corr-wake-1",
      },
      rawParams: {},
    });

    assert.equal(wakeCalls.length, 1);
    assert.equal(result.handled, true);
    assert.equal(result.mode, "delegated");
    assert.equal(result.dispatch.wake?.status, "scheduled");
    assert.equal(result.dispatch.wake?.runtimeRunId, "wake-run-1");
    assert.equal(result.dispatch.wake?.taskId, "task-wake-1");
  });

  it("no-duplicate-send gate blocks replayed sends with Wake-on-Task (hardened)", async () => {
    let wakeCalls = 0;
    let createCalls = 0;
    const hook = createA2ASessionsSendHook(
      {
        plugins: {
          entries: {
            "a2a-broker-adapter": {
              enabled: true,
              config: { baseUrl: "https://broker.example", wakeOnTask: { enabled: true } },
            },
          },
        },
      },
      undefined,
      {
        createBrokerClient: () => ({
          createTask: async (request: Record<string, unknown>) => {
            createCalls += 1;
            return {
              id: `task-wake-dup-${createCalls}`,
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
        }) as never,
        wakeRuntime: {
          dispatchWake: async () => {
            wakeCalls += 1;
            return { accepted: true, runtimeRunId: `wake-run-${wakeCalls}` };
          },
        },
      },
    );
    const event = {
      sessionKey: "worker-session",
      target: { sessionKey: "worker-session", displayKey: "worker-node" },
      message: "delegate this",
      task: {
        intent: "delegate",
        instructions: "delegate this",
        runtime: { waitRunId: "wait-dup" },
        correlationId: "corr-dup",
      },
      rawParams: {},
    };

    const first = await hook(event);
    const second = await hook(event);

    // First send succeeds normally with wake scheduled
    assert.equal(wakeCalls, 1);
    assert.equal(createCalls, 1);
    assert.equal(first.handled, true);
    assert.equal(first.mode, "delegated");
    assert.equal(first.dispatch.wake?.status, "scheduled");

    // Second send blocked entirely by no-duplicate-send gate
    assert.equal(second.handled, false);
    assert.equal(second.reason, "duplicate send suppressed by no-duplicate-send gate");
    assert.equal(wakeCalls, 1);
    assert.equal(createCalls, 1);
  });

  it("no-duplicate-send gate can be disabled via config", async () => {
    let createCalls = 0;
    const hook = createA2ASessionsSendHook(
      {
        plugins: {
          entries: {
            "a2a-broker-adapter": {
              enabled: true,
              config: {
                baseUrl: "https://broker.example",
                wakeOnTask: { enabled: true },
                noDuplicateSend: { enabled: false },
              },
            },
          },
        },
      },
      undefined,
      {
        createBrokerClient: () => ({
          createTask: async (request: Record<string, unknown>) => {
            createCalls += 1;
            return {
              id: `task-dup-disabled-${createCalls}`,
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
        }) as never,
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
      },
      rawParams: {},
    };

    const first = await hook(event);
    const second = await hook(event);

    // Gate disabled: both go through, wake suppressed on replay
    assert.equal(createCalls, 2);
    assert.equal(first.handled, true);
    assert.equal(second.handled, true);
  });

  it("runs the extracted delegated runtime in direct mode", async () => {
    const { runtime } = createRuntimeMock();
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
          cancelTask: async () => ({}) as never,
        }) as never,
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
          cancelTarget: { kind: "session_run", sessionKey: "hub-session", runId: "run-9" },
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
  });

  it("keeps wait-run dispatch stable when broker payload omits or malforms optional metadata", async () => {
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
          createTask: async (request: Record<string, unknown>) => ({
            id: "task-456",
            intent: "chat",
            status: "queued",
            requester: { id: "hub-session", kind: "session", role: "hub" },
            target: { id: "worker-node", kind: "node" },
            targetNodeId: "worker-node",
            payload: {
              ...(request.payload as Record<string, unknown>),
              waitRunId: " ",
              cancelTarget: { kind: "session_run", runId: "run-without-session" },
            },
            createdAt: "2026-04-19T00:00:00Z",
            updatedAt: "2026-04-19T00:00:00Z",
          }),
        }) as never,
      },
    );

    const result = await hook({
      sessionKey: "worker-session",
      target: { sessionKey: "worker-session", displayKey: "worker-node" },
      message: "delegate this",
      task: {
        intent: "delegate",
        instructions: "delegate this",
        runtime: {
          waitRunId: "wait-fallback",
          cancelTarget: { kind: "session_run", sessionKey: "hub-session", runId: "run-8" },
        },
      },
      rawParams: {},
    });

    assert.deepEqual(result, {
      handled: true,
      mode: "delegated",
      dispatch: {
        kind: "a2a-broker",
        taskId: "task-456",
        waitRunId: "wait-fallback",
        cancelTarget: { kind: "session_run", sessionKey: "hub-session", runId: "run-8" },
      },
    });
  });

  it("returns timeout when the wait-run watchdog elapses", async () => {
    const { runtime } = createRuntimeMock({ timeoutWaits: true });
    let cancelCalls = 0;
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
            id: "task-timeout",
            intent: "chat",
            status: "queued",
            requester: { id: "hub-session", kind: "session", role: "hub" },
            target: { id: "worker-node", kind: "node" },
            targetNodeId: "worker-node",
            payload: { waitRunId: "wait-timeout" },
            createdAt: "2026-04-19T00:00:00Z",
            updatedAt: "2026-04-19T00:00:00Z",
          }),
          getTask: async () => ({
            id: "task-timeout",
            intent: "chat",
            status: "queued",
            requester: { id: "hub-session", kind: "session", role: "hub" },
            target: { id: "worker-node", kind: "node" },
            targetNodeId: "worker-node",
            payload: { waitRunId: "wait-timeout" },
            createdAt: "2026-04-19T00:00:00Z",
            updatedAt: "2026-04-19T00:00:00Z",
          }),
          streamTaskEvents: async function* (_taskId: string, opts?: { signal?: AbortSignal }) {
            await new Promise<void>((resolve) => {
              opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          },
          cancelTask: async () => {
            cancelCalls += 1;
            return {} as never;
          },
        }) as never,
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
      },
      rawParams: {},
    });

    assert.deepEqual(result, {
      handled: true,
      mode: "direct",
      result: {
        runId: "wait-timeout",
        status: "timeout",
        error: "delegated task timed out after 30000ms",
        sessionKey: "worker-node",
      },
    });
    assert.equal(cancelCalls, 1);
  });
});
