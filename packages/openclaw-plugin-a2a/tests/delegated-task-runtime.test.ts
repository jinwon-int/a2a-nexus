import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDelegatedTaskRuntime } from "../dist/src/delegated-task-runtime.js";

type WaitRunStatus = "pending" | "ok" | "error" | "timeout";
type WaitRunRecord = {
  runId: string;
  status: WaitRunStatus;
  error?: string;
  replyText?: string;
  startedAt?: number;
  endedAt?: number;
};

function createWaitRunsMock() {
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

function createRuntimeHarness() {
  const subagentRunCalls: Array<Record<string, unknown>> = [];
  const sendTextCalls: Array<Record<string, unknown>> = [];
  const waitRuns = createWaitRunsMock();
  let subagentRunCount = 0;
  const repliesBySession = new Map<string, string[]>([
    ["hub-session", ["pong-1"]],
    ["worker-session", ["pong-2", "announce now"]],
  ]);
  const runtime = {
    subagent: {
      run: async (params: Record<string, unknown>) => {
        subagentRunCalls.push(params);
        subagentRunCount += 1;
        return { runId: `run-${subagentRunCount}` };
      },
      waitForRun: async () => ({ status: "ok" as const }),
      getSessionMessages: async ({ sessionKey }: { sessionKey: string }) => ({
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: repliesBySession.get(sessionKey)?.shift() ?? "",
              },
            ],
          },
        ],
      }),
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
              threadId: "99",
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
  return { runtime: runtime as never, subagentRunCalls, sendTextCalls, waitRuns };
}

describe("createDelegatedTaskRuntime", () => {
  it("fans session-run cancel into broker cancel", async () => {
    const { runtime } = createRuntimeHarness();
    let cancelHandler:
      | ((target: { kind: "session_run"; sessionKey: string; runId: string }) => Promise<{ status: string; reason?: string }>)
      | undefined;
    let cancelCalls = 0;
    const delegatedRuntime = createDelegatedTaskRuntime(
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
        randomId: () => "fixed-id",
        registerCancelHandler: (_target, handler) => {
          cancelHandler = handler;
          return () => {};
        },
        createBrokerClient: () => ({
          createTask: async () => ({
            id: "task-cancel",
            intent: "chat",
            status: "queued",
            requester: { id: "hub-session", kind: "session", role: "hub" },
            target: { id: "worker-session", kind: "session" },
            targetNodeId: "worker-session",
            payload: { waitRunId: "wait-cancel" },
            createdAt: "2026-04-19T00:00:00Z",
            updatedAt: "2026-04-19T00:00:00Z",
          }),
          getTask: async () => ({
            id: "task-cancel",
            intent: "chat",
            status: "queued",
            requester: { id: "hub-session", kind: "session", role: "hub" },
            target: { id: "worker-session", kind: "session" },
            targetNodeId: "worker-session",
            payload: { waitRunId: "wait-cancel" },
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

    const accepted = await delegatedRuntime.run({
      sessionKey: "worker-session",
      target: { sessionKey: "worker-session", displayKey: "worker-session" },
      message: "delegate this",
      task: {
        intent: "delegate",
        instructions: "delegate this",
        constraints: { timeoutSeconds: 0 },
        runtime: {
          waitRunId: "wait-cancel",
          cancelTarget: { kind: "session_run", sessionKey: "hub-session", runId: "run-9" },
        },
      },
      rawParams: { timeoutSeconds: 0 },
    });

    assert.deepEqual(accepted, {
      handled: true,
      mode: "direct",
      result: {
        runId: "wait-cancel",
        status: "accepted",
        sessionKey: "worker-session",
        delivery: { status: "pending", mode: "announce" },
      },
    });
    assert.ok(cancelHandler);
    const cancelResult = await cancelHandler!({ kind: "session_run", sessionKey: "hub-session", runId: "run-9" });
    assert.equal(cancelResult.status, "cancelled");
    assert.equal(cancelCalls, 1);
  });

  it("runs ping-pong and sends the announce message after broker success", async () => {
    const { runtime, subagentRunCalls, sendTextCalls } = createRuntimeHarness();
    const delegatedRuntime = createDelegatedTaskRuntime(
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
        randomId: () => "fixed-id",
        createBrokerClient: () => ({
          createTask: async () => ({
            id: "task-success",
            intent: "chat",
            status: "queued",
            requester: { id: "hub-session", kind: "session", role: "hub" },
            target: { id: "worker-session", kind: "session" },
            targetNodeId: "worker-session",
            payload: { waitRunId: "wait-success" },
            createdAt: "2026-04-19T00:00:00Z",
            updatedAt: "2026-04-19T00:00:00Z",
          }),
          getTask: async () => ({
            id: "task-success",
            intent: "chat",
            status: "succeeded",
            requester: { id: "hub-session", kind: "session", role: "hub" },
            target: { id: "worker-session", kind: "session" },
            targetNodeId: "worker-session",
            payload: { waitRunId: "wait-success" },
            result: { summary: "worker result" },
            createdAt: "2026-04-19T00:00:00Z",
            updatedAt: "2026-04-19T00:00:01Z",
          }),
          streamTaskEvents: async function* () {
            yield {
              name: "task-status-update",
              data: {
                id: "task-success",
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

    const result = await delegatedRuntime.run({
      sessionKey: "worker-session",
      target: { sessionKey: "worker-session", displayKey: "worker-session" },
      message: "delegate this",
      task: {
        intent: "delegate",
        instructions: "delegate this",
        constraints: { timeoutSeconds: 1, maxPingPongTurns: 2 },
        requester: { sessionKey: "hub-session", channel: "discord" },
      },
      rawParams: {},
    });

    assert.deepEqual(result, {
      handled: true,
      mode: "direct",
      result: {
        runId: "wait-success",
        status: "ok",
        reply: "worker result",
        sessionKey: "worker-session",
        delivery: { status: "pending", mode: "announce" },
      },
    });
    await delegatedRuntime.waitForIdle();

    assert.equal(subagentRunCalls.length, 3);
    assert.equal(sendTextCalls.length, 1);
    assert.equal(sendTextCalls[0].text, "announce now");
    assert.equal(sendTextCalls[0].to, "group:worker");
  });

  it("finalizes broker tasks directly from compact terminal SSE payloads", async () => {
    const { runtime } = createRuntimeHarness();
    let getTaskCalls = 0;
    const delegatedRuntime = createDelegatedTaskRuntime(
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
        randomId: () => "fixed-id",
        createBrokerClient: () => ({
          createTask: async () => ({
            id: "task-push",
            intent: "chat",
            status: "queued",
            requester: { id: "hub-session", kind: "session", role: "hub" },
            target: { id: "worker-session", kind: "session" },
            targetNodeId: "worker-session",
            payload: { waitRunId: "wait-push" },
            createdAt: "2026-04-19T00:00:00Z",
            updatedAt: "2026-04-19T00:00:00Z",
          }),
          getTask: async () => {
            getTaskCalls += 1;
            return {
              id: "task-push",
              intent: "chat",
              status: "running",
              requester: { id: "hub-session", kind: "session", role: "hub" },
              target: { id: "worker-session", kind: "session" },
              targetNodeId: "worker-session",
              payload: { waitRunId: "wait-push" },
              createdAt: "2026-04-19T00:00:00Z",
              updatedAt: "2026-04-19T00:00:01Z",
            };
          },
          streamTaskEvents: async function* () {
            yield {
              name: "task-status-update",
              id: "terminal:task-push:1",
              data: {
                reason: "succeeded",
                final: true,
                task: {
                  id: "task-push",
                  kind: "task",
                  status: {
                    state: "completed",
                    timestamp: "2026-04-19T00:00:02Z",
                    message: {
                      role: "agent",
                      parts: [{ text: "Done: worker result" }],
                    },
                  },
                  metadata: {
                    worker: "worker-session",
                    repo: "jinwon-int/plugin-a2a",
                    issue: 132,
                    doneUrl: "https://broker.example/done/task-push",
                    testSummary: "npm test: pass",
                    terminalAckProjection: "current_session_visible",
                    rawLog: "must not be copied into operator payload",
                  },
                  artifacts: [],
                },
              },
            };
          },
          cancelTask: async () => ({}) as never,
        }) as never,
      },
    );

    const result = await delegatedRuntime.run({
      sessionKey: "worker-session",
      target: { sessionKey: "worker-session", displayKey: "worker-session" },
      message: "delegate this",
      task: {
        intent: "delegate",
        instructions: "delegate this",
        constraints: { timeoutSeconds: 1, maxPingPongTurns: 0 },
        runtime: { waitRunId: "wait-push" },
      },
      rawParams: {},
    });

    assert.deepEqual(result, {
      handled: true,
      mode: "direct",
      result: {
        runId: "wait-push",
        status: "ok",
        reply: "Done: worker result",
        sessionKey: "worker-session",
        delivery: { status: "pending", mode: "announce" },
      },
    });
    await delegatedRuntime.waitForIdle();
    assert.equal(getTaskCalls, 1);
  });

  it("returns an actionable empty-state report for successful terminal SSE with no body", async () => {
    const { runtime } = createRuntimeHarness();
    const delegatedRuntime = createDelegatedTaskRuntime(
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
        randomId: () => "fixed-id",
        createBrokerClient: () => ({
          createTask: async () => ({
            id: "task-empty-report",
            intent: "chat",
            status: "queued",
            requester: { id: "hub-session", kind: "session", role: "hub" },
            target: { id: "worker-session", kind: "session" },
            targetNodeId: "worker-session",
            payload: { waitRunId: "wait-empty-report" },
            createdAt: "2026-04-19T00:00:00Z",
            updatedAt: "2026-04-19T00:00:00Z",
          }),
          getTask: async () => ({
            id: "task-empty-report",
            intent: "chat",
            status: "running",
            requester: { id: "hub-session", kind: "session", role: "hub" },
            target: { id: "worker-session", kind: "session" },
            targetNodeId: "worker-session",
            payload: { waitRunId: "wait-empty-report" },
            createdAt: "2026-04-19T00:00:00Z",
            updatedAt: "2026-04-19T00:00:01Z",
          }),
          streamTaskEvents: async function* () {
            yield {
              name: "task-status-update",
              id: "terminal:task-empty-report:1",
              data: {
                reason: "succeeded",
                final: true,
                task: {
                  id: "task-empty-report",
                  kind: "task",
                  status: {
                    state: "completed",
                    timestamp: "2026-04-19T00:00:02Z",
                  },
                  metadata: {
                    repo: "jinwon-int/plugin-a2a",
                    issue: 191,
                    prUrl: "https://github.com/jinwon-int/plugin-a2a/pull/190",
                    terminalAckProjection: "current_session_visible",
                  },
                  artifacts: [],
                },
              },
            };
          },
          cancelTask: async () => ({}) as never,
        }) as never,
      },
    );

    const result = await delegatedRuntime.run({
      sessionKey: "worker-session",
      target: { sessionKey: "worker-session", displayKey: "worker-session" },
      message: "delegate this",
      task: {
        intent: "delegate",
        instructions: "delegate this",
        constraints: { timeoutSeconds: 1, maxPingPongTurns: 0 },
        runtime: { waitRunId: "wait-empty-report" },
      },
      rawParams: {},
    });

    assert.equal(result.handled, true);
    assert.equal(result.mode, "direct");
    assert.equal(result.result.status, "ok");
    assert.match(String(result.result.reply), /no result\/report body was provided/);
    assert.match(String(result.result.reply), /PR: https:\/\/github\.com\/jinwon-int\/plugin-a2a\/pull\/190/);
    await delegatedRuntime.waitForIdle();
  });

  it("accepts manual operator receipt as terminal SSE ack evidence", async () => {
    const { runtime } = createRuntimeHarness();
    let getTaskCalls = 0;
    const delegatedRuntime = createDelegatedTaskRuntime(
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
        randomId: () => "fixed-id",
        createBrokerClient: () => ({
          createTask: async () => ({
            id: "task-manual-receipt",
            intent: "chat",
            status: "queued",
            requester: { id: "hub-session", kind: "session", role: "hub" },
            target: { id: "worker-session", kind: "session" },
            targetNodeId: "worker-session",
            payload: { waitRunId: "wait-manual-receipt" },
            createdAt: "2026-04-19T00:00:00Z",
            updatedAt: "2026-04-19T00:00:00Z",
          }),
          getTask: async () => {
            getTaskCalls += 1;
            return {
              id: "task-manual-receipt",
              intent: "chat",
              status: "running",
              requester: { id: "hub-session", kind: "session", role: "hub" },
              target: { id: "worker-session", kind: "session" },
              targetNodeId: "worker-session",
              payload: { waitRunId: "wait-manual-receipt" },
              createdAt: "2026-04-19T00:00:00Z",
              updatedAt: "2026-04-19T00:00:01Z",
            };
          },
          streamTaskEvents: async function* () {
            yield {
              name: "task-status-update",
              id: "terminal:task-manual-receipt:1",
              data: {
                reason: "succeeded",
                final: true,
                task: {
                  id: "task-manual-receipt",
                  kind: "task",
                  status: {
                    state: "completed",
                    timestamp: "2026-04-19T00:00:02Z",
                    message: {
                      role: "agent",
                      parts: [{ text: "Done with operator receipt" }],
                    },
                  },
                  metadata: {
                    receipt: { projection: "manual_operator_receipt" },
                    summary: "Done with operator receipt",
                  },
                  artifacts: [],
                },
              },
            };
          },
          cancelTask: async () => ({}) as never,
        }) as never,
      },
    );

    const result = await delegatedRuntime.run({
      sessionKey: "worker-session",
      target: { sessionKey: "worker-session", displayKey: "worker-session" },
      message: "delegate this",
      task: {
        intent: "delegate",
        instructions: "delegate this",
        constraints: { timeoutSeconds: 1, maxPingPongTurns: 0 },
        runtime: { waitRunId: "wait-manual-receipt" },
      },
      rawParams: {},
    });

    assert.equal(result.handled, true);
    assert.equal(result.mode, "direct");
    assert.equal(result.result.status, "ok");
    assert.equal(result.result.reply, "Done with operator receipt");
    await delegatedRuntime.waitForIdle();
    assert.equal(getTaskCalls, 1);
  });

  it("does not treat provider send success alone as terminal SSE ack evidence", async () => {
    const { runtime } = createRuntimeHarness();
    const delegatedRuntime = createDelegatedTaskRuntime(
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
        randomId: () => "fixed-id",
        createBrokerClient: () => ({
          createTask: async () => ({
            id: "task-provider-send-only",
            intent: "chat",
            status: "queued",
            requester: { id: "hub-session", kind: "session", role: "hub" },
            target: { id: "worker-session", kind: "session" },
            targetNodeId: "worker-session",
            payload: { waitRunId: "wait-provider-send-only" },
            createdAt: "2026-04-19T00:00:00Z",
            updatedAt: "2026-04-19T00:00:00Z",
          }),
          getTask: async () => ({
            id: "task-provider-send-only",
            intent: "chat",
            status: "running",
            requester: { id: "hub-session", kind: "session", role: "hub" },
            target: { id: "worker-session", kind: "session" },
            targetNodeId: "worker-session",
            payload: { waitRunId: "wait-provider-send-only" },
            createdAt: "2026-04-19T00:00:00Z",
            updatedAt: "2026-04-19T00:00:01Z",
          }),
          streamTaskEvents: async function* () {
            yield {
              name: "task-status-update",
              id: "terminal:task-provider-send-only:1",
              data: {
                reason: "succeeded",
                final: true,
                task: {
                  id: "task-provider-send-only",
                  kind: "task",
                  status: {
                    state: "completed",
                    timestamp: "2026-04-19T00:00:02Z",
                    message: {
                      role: "agent",
                      parts: [{ text: "provider send returned ok" }],
                    },
                  },
                  metadata: {
                    terminalAckProjection: "provider_send_success",
                    summary: "provider send returned ok",
                  },
                  artifacts: [],
                },
              },
            };
          },
          cancelTask: async () => ({}) as never,
        }) as never,
      },
    );

    const result = await delegatedRuntime.run({
      sessionKey: "worker-session",
      target: { sessionKey: "worker-session", displayKey: "worker-session" },
      message: "delegate this",
      task: {
        intent: "delegate",
        instructions: "delegate this",
        constraints: { timeoutSeconds: 1, maxPingPongTurns: 0 },
        runtime: { waitRunId: "wait-provider-send-only" },
      },
      rawParams: {},
    });

    assert.equal(result.handled, true);
    assert.equal(result.mode, "direct");
    assert.equal(result.result.status, "error");
    assert.equal(result.result.error, "broker task running");
  });

  it("blocks external announce for live-impact tasks until human approval", async () => {
    const { runtime, subagentRunCalls, sendTextCalls } = createRuntimeHarness();
    const delegatedRuntime = createDelegatedTaskRuntime(
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
        randomId: () => "fixed-id",
        createBrokerClient: () => ({
          createTask: async () => ({
            id: "task-live-impact",
            intent: "chat",
            status: "queued",
            requester: { id: "hub-session", kind: "session", role: "hub" },
            target: { id: "worker-session", kind: "session" },
            targetNodeId: "worker-session",
            payload: { waitRunId: "wait-live-impact" },
            policyContext: {
              requiresApproval: true,
              liveImpact: true,
              targetEnvironment: "live",
            },
            createdAt: "2026-04-19T00:00:00Z",
            updatedAt: "2026-04-19T00:00:00Z",
          }),
          getTask: async () => ({
            id: "task-live-impact",
            intent: "chat",
            status: "succeeded",
            requester: { id: "hub-session", kind: "session", role: "hub" },
            target: { id: "worker-session", kind: "session" },
            targetNodeId: "worker-session",
            payload: { waitRunId: "wait-live-impact" },
            result: { summary: "ready to announce" },
            policyContext: {
              requiresApproval: true,
              liveImpact: true,
              targetEnvironment: "live",
            },
            createdAt: "2026-04-19T00:00:00Z",
            updatedAt: "2026-04-19T00:00:01Z",
          }),
          streamTaskEvents: async function* () {
            yield {
              name: "task-status-update",
              data: {
                id: "task-live-impact",
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

    const result = await delegatedRuntime.run({
      sessionKey: "worker-session",
      target: { sessionKey: "worker-session", displayKey: "worker-session" },
      message: "delegate this",
      task: {
        intent: "delegate",
        instructions: "announce after approval",
        constraints: { timeoutSeconds: 1, maxPingPongTurns: 2 },
        requester: { sessionKey: "hub-session", channel: "discord" },
      },
      rawParams: {},
    });

    assert.deepEqual(result, {
      handled: true,
      mode: "direct",
      result: {
        runId: "wait-live-impact",
        status: "ok",
        reply: "ready to announce",
        sessionKey: "worker-session",
        delivery: {
          status: "blocked",
          mode: "human_approval_required",
          deliveryId: "announce:task-live-impact:wait-live-impact",
          taskId: "task-live-impact",
          reason: "live-impact task requires explicit human approval before external announce",
          policyContext: {
            requiresApproval: true,
            liveImpact: true,
            targetEnvironment: "live",
          },
        },
      },
    });
    await delegatedRuntime.waitForIdle();

    assert.equal(subagentRunCalls.length, 0);
    assert.equal(sendTextCalls.length, 0);
  });

  it("resumes a blocked announce from broker approval metadata after completion", async () => {
    const { runtime, subagentRunCalls, sendTextCalls } = createRuntimeHarness();
    const delegatedRuntime = createDelegatedTaskRuntime(
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
        randomId: () => "fixed-id",
        createBrokerClient: () => ({
          createTask: async () => ({
            id: "task-live-approved",
            intent: "chat",
            status: "blocked",
            requester: { id: "hub-session", kind: "session", role: "hub" },
            target: { id: "worker-session", kind: "session" },
            targetNodeId: "worker-session",
            payload: { waitRunId: "wait-live-approved" },
            policyContext: {
              requiresApproval: true,
              liveImpact: true,
              targetEnvironment: "live",
            },
            createdAt: "2026-04-19T00:00:00Z",
            updatedAt: "2026-04-19T00:00:00Z",
          }),
          getTask: async () => ({
            id: "task-live-approved",
            intent: "chat",
            status: "succeeded",
            requester: { id: "hub-session", kind: "session", role: "hub" },
            target: { id: "worker-session", kind: "session" },
            targetNodeId: "worker-session",
            payload: { waitRunId: "wait-live-approved" },
            result: { summary: "ready to announce" },
            policyContext: {
              requiresApproval: true,
              liveImpact: true,
              targetEnvironment: "live",
            },
            approval: {
              approvalId: "chg-28",
              approvedAt: "2026-04-19T00:00:01Z",
              approvedBy: "operator-session",
              actorRole: "operator",
              requesterRole: "hub",
              reason: "broker approved live-impact handoff",
            },
            createdAt: "2026-04-19T00:00:00Z",
            updatedAt: "2026-04-19T00:00:02Z",
          }),
          streamTaskEvents: async function* () {
            yield {
              name: "task-status-update",
              data: {
                id: "task-live-approved",
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

    const result = await delegatedRuntime.run({
      sessionKey: "worker-session",
      target: { sessionKey: "worker-session", displayKey: "worker-session" },
      message: "delegate this",
      task: {
        intent: "delegate",
        instructions: "announce after broker approval",
        constraints: { timeoutSeconds: 1, maxPingPongTurns: 2 },
        requester: { sessionKey: "hub-session", channel: "discord" },
      },
      rawParams: {},
    });

    assert.equal(result.handled, true);
    assert.equal(result.mode, "direct");
    assert.equal(result.result.status, "ok");
    await delegatedRuntime.waitForIdle();

    assert.equal(sendTextCalls.length, 1);
    assert.equal(sendTextCalls[0].text, "announce now");
    assert.equal(subagentRunCalls.length, 3);
    const delivered = delegatedRuntime.getBlockedAnnounceDelivery(
      "announce:task-live-approved:wait-live-approved",
    );
    assert.equal(delivered?.status, "delivered");
    assert.equal(delivered?.approvalId, "chg-28");
    assert.deepEqual(
      delivered?.audit.map((entry) => entry.type),
      ["blocked", "approved", "delivered"],
    );
  });

  it("records broker approval rejection without resuming a blocked announce", async () => {
    const { runtime, subagentRunCalls, sendTextCalls } = createRuntimeHarness();
    const delegatedRuntime = createDelegatedTaskRuntime(
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
        randomId: () => "fixed-id",
        createBrokerClient: () => ({
          createTask: async () => ({
            id: "task-live-rejected",
            intent: "chat",
            status: "blocked",
            requester: { id: "hub-session", kind: "session", role: "hub" },
            target: { id: "worker-session", kind: "session" },
            targetNodeId: "worker-session",
            payload: { waitRunId: "wait-live-rejected" },
            policyContext: {
              requiresApproval: true,
              liveImpact: true,
              targetEnvironment: "live",
            },
            createdAt: "2026-04-19T00:00:00Z",
            updatedAt: "2026-04-19T00:00:00Z",
          }),
          getTask: async () => ({
            id: "task-live-rejected",
            intent: "chat",
            status: "canceled",
            requester: { id: "hub-session", kind: "session", role: "hub" },
            target: { id: "worker-session", kind: "session" },
            targetNodeId: "worker-session",
            payload: { waitRunId: "wait-live-rejected" },
            policyContext: {
              requiresApproval: true,
              liveImpact: true,
              targetEnvironment: "live",
            },
            approvalOutcome: {
              status: "rejected",
              approvalId: "chg-rejected-1",
              decidedAt: "2026-04-19T00:00:01Z",
              decidedBy: "operator-session",
              actorRole: "operator",
              requesterRole: "hub",
              reason: "broker rejected exact live-impact handoff",
            },
            createdAt: "2026-04-19T00:00:00Z",
            updatedAt: "2026-04-19T00:00:02Z",
          }),
          streamTaskEvents: async function* () {
            yield {
              name: "task-status-update",
              data: {
                id: "task-live-rejected",
                kind: "task",
                status: { state: "cancelled", final: true },
                reason: "canceled",
                final: true,
              },
            };
          },
          cancelTask: async () => ({}) as never,
        }) as never,
      },
    );

    const result = await delegatedRuntime.run({
      sessionKey: "worker-session",
      target: { sessionKey: "worker-session", displayKey: "worker-session" },
      message: "delegate this",
      task: {
        intent: "delegate",
        instructions: "announce only if approved",
        constraints: { timeoutSeconds: 1, maxPingPongTurns: 2 },
        requester: { sessionKey: "hub-session", channel: "discord" },
      },
      rawParams: {},
    });

    assert.equal(result.handled, true);
    assert.equal(result.mode, "direct");
    assert.equal(result.result.status, "cancelled");
    assert.equal(result.result.error, "broker rejected exact live-impact handoff");
    await delegatedRuntime.waitForIdle();

    assert.equal(sendTextCalls.length, 0);
    assert.equal(subagentRunCalls.length, 0);
    const rejected = delegatedRuntime.getBlockedAnnounceDelivery(
      "announce:task-live-rejected:wait-live-rejected",
    );
    assert.equal(rejected?.status, "rejected");
    assert.equal(rejected?.approvalId, "chg-rejected-1");
    assert.equal(rejected?.rejectionReason, "broker rejected exact live-impact handoff");
    assert.deepEqual(
      rejected?.audit.map((entry) => entry.type),
      ["blocked", "approval_rejected"],
    );
  });

  it("resumes a blocked announce exactly once after an explicit approval signal", async () => {
    const { runtime, subagentRunCalls, sendTextCalls } = createRuntimeHarness();
    const delegatedRuntime = createDelegatedTaskRuntime(
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
        randomId: () => "fixed-id",
        createBrokerClient: () => ({
          createTask: async () => ({
            id: "task-live-resume",
            intent: "chat",
            status: "queued",
            requester: { id: "hub-session", kind: "session", role: "hub" },
            target: { id: "worker-session", kind: "session" },
            targetNodeId: "worker-session",
            payload: { waitRunId: "wait-live-resume" },
            policyContext: {
              requiresApproval: true,
              liveImpact: true,
              targetEnvironment: "live",
            },
            createdAt: "2026-04-19T00:00:00Z",
            updatedAt: "2026-04-19T00:00:00Z",
          }),
          getTask: async () => ({
            id: "task-live-resume",
            intent: "chat",
            status: "succeeded",
            requester: { id: "hub-session", kind: "session", role: "hub" },
            target: { id: "worker-session", kind: "session" },
            targetNodeId: "worker-session",
            payload: { waitRunId: "wait-live-resume" },
            result: { summary: "ready to announce" },
            policyContext: {
              requiresApproval: true,
              liveImpact: true,
              targetEnvironment: "live",
            },
            createdAt: "2026-04-19T00:00:00Z",
            updatedAt: "2026-04-19T00:00:01Z",
          }),
          streamTaskEvents: async function* () {
            yield {
              name: "task-status-update",
              data: {
                id: "task-live-resume",
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

    const result = await delegatedRuntime.run({
      sessionKey: "worker-session",
      target: { sessionKey: "worker-session", displayKey: "worker-session" },
      message: "delegate this",
      task: {
        intent: "delegate",
        instructions: "announce after approval",
        constraints: { timeoutSeconds: 1, maxPingPongTurns: 2 },
        requester: { sessionKey: "hub-session", channel: "discord" },
      },
      rawParams: {},
    });

    assert.equal(result.handled, true);
    assert.equal(result.mode, "direct");
    assert.equal(result.result.status, "ok");
    await delegatedRuntime.waitForIdle();

    const [blocked] = delegatedRuntime.getBlockedAnnounceDeliveries();
    assert.equal(blocked.deliveryId, "announce:task-live-resume:wait-live-resume");
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.audit.at(0)?.type, "blocked");
    assert.equal(subagentRunCalls.length, 0);
    assert.equal(sendTextCalls.length, 0);

    const resumed = await delegatedRuntime.resumeBlockedDelivery({
      deliveryId: blocked.deliveryId,
      approved: true,
      approvalId: "approval-1",
      approvedBy: "operator-session",
    });

    assert.equal(resumed.status, "delivered");
    assert.equal(sendTextCalls.length, 1);
    assert.equal(sendTextCalls[0].text, "announce now");
    assert.equal(sendTextCalls[0].to, "group:worker");
    assert.equal(subagentRunCalls.length, 3);

    const duplicate = await delegatedRuntime.resumeBlockedDelivery({
      deliveryId: blocked.deliveryId,
      approved: true,
      approvalId: "approval-1",
      approvedBy: "operator-session",
    });

    assert.equal(duplicate.status, "duplicate");
    assert.equal(sendTextCalls.length, 1);
    const delivered = delegatedRuntime.getBlockedAnnounceDelivery(blocked.deliveryId);
    assert.equal(delivered?.status, "delivered");
    assert.deepEqual(
      delivered?.audit.map((entry) => entry.type),
      ["blocked", "approved", "delivered", "duplicate_approval"],
    );
  });

});
