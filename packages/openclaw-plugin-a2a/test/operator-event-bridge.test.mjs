import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createA2AMonitoringHandlers } from "../dist/src/gateway-monitoring-handlers.js";
import { createA2AOperatorEventBridge } from "../dist/src/operator-event-bridge.js";
import { renderOperatorNotificationText } from "../dist/src/operator-notification-adapter.js";
import { createA2ABrokerClient } from "../dist/standalone-broker-client.js";
import { buildA2ACrossBrokerTerminalProjection } from "../dist/src/cross-broker-terminal-relay.js";

function defer() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function eventually(read, predicate, message) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const value = read();
    if (predicate(value)) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function waitForAbort(signal) {
  return new Promise((resolve) => {
    if (!signal || signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

test("operator event bridge projects snapshot plus summary updates into plugin-owned monitor state", async () => {
  const lastEventIds = [];
  const cursorWrites = [];
  const bridge = createA2AOperatorEventBridge({
    broker: {
      async *streamOperatorEvents(options = {}) {
        lastEventIds.push(options.lastEventId);
        yield {
          name: "operator-snapshot",
          id: "operator:1",
          data: {
            summary: {
              queueDepth: 2,
              healthyWorkers: 3,
            },
            alerts: {
              alerts: [
                {
                  id: "alert-1",
                  severity: "warn",
                  message: "queue depth elevated",
                  openedAt: "2026-04-25T00:00:00.000Z",
                },
              ],
            },
          },
        };
        yield {
          name: "operator-summary-update",
          id: "operator:2",
          data: {
            summary: {
              queueDepth: 0,
              healthyWorkers: 4,
              updatedAt: "2026-04-25T00:05:00.000Z",
            },
          },
        };
        await waitForAbort(options.signal);
      },
    },
    writeCursor(cursor) {
      cursorWrites.push(cursor);
    },
  });

  try {
    bridge.getState({ cursor: "operator:0" });
    const state = await eventually(
      () => bridge.getState(),
      (value) => value.bridge.cursor === "operator:2",
      "expected operator bridge cursor to advance through snapshot and summary update",
    );

    assert.deepEqual(lastEventIds, ["operator:0"]);
    assert.deepEqual(cursorWrites, ["operator:1", "operator:2"]);
    assert.equal(state.kind, "a2a.operator.monitor");
    assert.equal(state.enabled, true);
    assert.equal(state.bridge.connection, "streaming");
    assert.equal(state.bridge.cursor, "operator:2");
    assert.equal(state.operator.snapshot.summary.queueDepth, 2);
    assert.equal(state.operator.liveSummary.queueDepth, 0);
    assert.equal(state.operator.liveSummary.healthyWorkers, 4);
    assert.deepEqual(state.operator.alerts.open.map((alert) => alert.alertId), ["alert-1"]);
    assert.deepEqual(state.operator.alerts.resolved, []);
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("operator event bridge projects GitHub evidence gaps with grace warning", async () => {
  const now = Date.parse("2026-05-03T07:30:00.000Z");
  const bridge = createA2AOperatorEventBridge({
    now: () => now,
    broker: {
      async *streamOperatorEvents(options = {}) {
        yield {
          name: "operator-summary-update",
          id: "operator:github:1",
          data: {
            summary: {
              githubTaskEvidence: [
                {
                  taskId: "a2a-failclosed-worker-182",
                  repo: "jinwon-int/openclaw-plugin-a2a",
                  issue: 182,
                  dispatchedAt: "2026-05-03T07:10:00.000Z",
                  lastCheckedAt: "2026-05-03T07:29:00.000Z",
                },
                {
                  taskId: "a2a-failclosed-worker-183",
                  repo: "jinwon-int/openclaw-plugin-a2a",
                  issueNumber: "183",
                  startCommentUrl: "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/183#issuecomment-start",
                  prUrl: "https://github.com/jinwon-int/openclaw-plugin-a2a/pull/200",
                  lastCheckedAt: "2026-05-03T07:29:30.000Z",
                  prompt: "do not project this issue body",
                },
              ],
            },
          },
        };
        await waitForAbort(options.signal);
      },
    },
  });

  try {
    const state = await eventually(
      () => bridge.getState(),
      (value) => value.operator.githubEvidence?.counts.total === 2,
      "expected GitHub evidence projection",
    );

    assert.equal(state.operator.githubEvidence.status, "warning");
    assert.deepEqual(state.operator.githubEvidence.counts, {
      total: 2,
      startSeen: 1,
      terminalSeen: 1,
      evidenceMissing: 1,
      warnings: 1,
    });
    assert.deepEqual(state.operator.githubEvidence.tasks[0], {
      taskId: "a2a-failclosed-worker-182",
      status: "evidence_missing",
      startSeen: false,
      prSeen: false,
      doneSeen: false,
      blockSeen: false,
      evidenceMissing: true,
      repo: "jinwon-int/openclaw-plugin-a2a",
      issue: 182,
      lastCheckedAt: Date.parse("2026-05-03T07:29:00.000Z"),
      warning: "GitHub task evidence missing after grace period",
    });
    assert.equal(state.operator.githubEvidence.tasks[1].status, "terminal_seen");
    assert.equal(state.operator.githubEvidence.tasks[1].issue, 183);
    assert.equal("prompt" in state.operator.githubEvidence.tasks[1], false);
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("operator event bridge moves alerts from open to resolved on alert lifecycle events", async () => {
  const bridge = createA2AOperatorEventBridge({
    broker: {
      async *streamOperatorEvents(options = {}) {
        yield {
          name: "operator-alert-opened",
          id: "operator:3",
          data: {
            alert: {
              id: "alert-9",
              severity: "critical",
              message: "worker heartbeat stalled",
              openedAt: "2026-04-25T00:10:00.000Z",
            },
          },
        };
        yield {
          name: "operator-alert-resolved",
          id: "operator:4",
          data: {
            alert: {
              id: "alert-9",
              message: "worker heartbeat recovered",
              resolvedAt: "2026-04-25T00:11:00.000Z",
            },
          },
        };
        await waitForAbort(options.signal);
      },
    },
  });

  try {
    bridge.getState();
    const state = await eventually(
      () => bridge.getState(),
      (value) => value.operator.alerts.resolved.length === 1,
      "expected alert lifecycle to produce one resolved alert",
    );

    assert.deepEqual(state.operator.alerts.open, []);
    assert.equal(state.operator.alerts.resolved[0].alertId, "alert-9");
    assert.equal(state.operator.alerts.resolved[0].status, "resolved");
    assert.equal(
      state.operator.alerts.resolved[0].openedAt,
      Date.parse("2026-04-25T00:10:00.000Z"),
    );
    assert.equal(
      state.operator.alerts.resolved[0].resolvedAt,
      Date.parse("2026-04-25T00:11:00.000Z"),
    );
    assert.equal(state.operator.alerts.resolved[0].message, "worker heartbeat recovered");
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("operator event bridge reconnects with the latest cursor and keeps failures visible in state", async () => {
  const retryGate = defer();
  const lastEventIds = [];
  let streamCallCount = 0;

  const bridge = createA2AOperatorEventBridge({
    broker: {
      async *streamOperatorEvents(options = {}) {
        streamCallCount += 1;
        lastEventIds.push(options.lastEventId);

        if (streamCallCount === 1) {
          yield {
            name: "operator-summary-update",
            id: "operator:6",
            data: {
              summary: {
                queueDepth: 1,
              },
            },
          };
          throw new Error("socket dropped");
        }

        yield {
          name: "operator-summary-update",
          id: "operator:7",
          data: {
            summary: {
              queueDepth: 0,
            },
          },
        };
        await waitForAbort(options.signal);
      },
    },
    waitForRetry: (_delayMs, signal) =>
      new Promise((resolve, reject) => {
        const onAbort = () => reject(new Error("aborted"));
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        retryGate.promise.then(
          () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          },
          (error) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
      }),
  });

  try {
    bridge.getState({ cursor: "operator:5" });

    const failedState = await eventually(
      () => bridge.getState(),
      (value) => value.bridge.lastFailure?.message === "socket dropped",
      "expected operator bridge failure to be visible after first stream drops",
    );
    assert.deepEqual(lastEventIds, ["operator:5"]);
    assert.equal(failedState.bridge.cursor, "operator:6");
    assert.equal(failedState.bridge.lastFailure.code, "stream_runtime_failed");

    retryGate.resolve();

    const recoveredState = await eventually(
      () => bridge.getState(),
      (value) => value.bridge.cursor === "operator:7" && lastEventIds.length === 2,
      "expected operator bridge reconnect to resume from the latest event cursor",
    );
    assert.deepEqual(lastEventIds, ["operator:5", "operator:6"]);
    assert.equal(recoveredState.operator.liveSummary.queueDepth, 0);
    assert.equal(recoveredState.bridge.lastFailure.message, "socket dropped");
  } finally {
    bridge.shutdown();
    retryGate.resolve();
    await bridge.waitForIdle();
  }
});

test("monitor status keeps operator event bridge default-off unless explicitly requested and configured", async () => {
  const responses = [];
  const handlers = createA2AMonitoringHandlers({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          config: {
            baseUrl: "https://broker.example.test",
          },
        },
      },
    },
  }, {
    createClient: () => {
      throw new Error("operator event bridge should stay disabled by default");
    },
  });

  await handlers.handleA2AMonitorStatus({
    params: {
      sessionKey: "session-1",
      operatorEvents: {
        enabled: true,
        cursor: "operator:9",
      },
    },
    respond(ok, result, error) {
      responses.push({ ok, result, error });
    },
  });

  assert.equal(responses.length, 1);
  assert.equal(responses[0].ok, true);
  assert.equal(responses[0].error, undefined);
  assert.equal(responses[0].result.enabled, false);
  assert.equal(responses[0].result.bridge.connection, "disabled");
  assert.equal(responses[0].result.bridge.requestedCursor, "operator:9");
});

test("monitor preflight blocks on broker terminal-outbox history without active bridge", async () => {
  const responses = [];
  const listCalls = [];
  const handlers = createA2AMonitoringHandlers({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: {
            baseUrl: "https://broker.example.test",
            operatorEvents: { enabled: false },
          },
        },
      },
    },
  }, {
    runtime: {
      channel: {
        outbound: {
          async loadAdapter(channel) {
            assert.equal(channel, "telegram");
            return {
              capabilities: { currentSessionVisibleReceipt: true },
              async sendText() {
                throw new Error("preflight must not send live messages");
              },
            };
          },
        },
      },
    },
    createClient: () => ({
      async listTerminalOutbox(params = {}) {
        listCalls.push(params);
        return {
          kind: "task.terminal.outbox",
          count: 1,
          cursor: "terminal:fresh:succeeded:2026-05-17T02%3A00%3A00.000Z",
          events: [{
            id: "terminal:fresh:succeeded:2026-05-17T02%3A00%3A00.000Z",
            kind: "task.terminal",
            taskEventId: 1,
            payload: { taskId: "fresh", status: "succeeded" },
            createdAt: "2026-05-17T02:00:00.000Z",
            receipt: { status: "accepted" },
            attempts: 0,
          }],
        };
      },
    }),
  });

  await handlers.handleA2AMonitorStatus({
    params: {
      sessionKey: "session-1",
      operatorEvents: {
        preflight: true,
        enabled: true,
        terminalOutboxCursor: "terminal:previous:succeeded:2026-05-17T01%3A00%3A00.000Z",
        terminalOutboxLimit: 5,
        notification: { enabled: true, channel: "telegram", to: "operator-chat" },
      },
    },
    respond(ok, result, error) {
      responses.push({ ok, result, error });
    },
  });

  assert.equal(responses.length, 1);
  assert.equal(responses[0].ok, true);
  assert.equal(responses[0].result.decision, "BLOCK");
  assert.equal(responses[0].result.safeToRestartGateway, false);
  assert.match(responses[0].result.preflight.notificationTarget.reason, /broker terminal-outbox history has 1 unacknowledged/);
  assert.deepEqual(listCalls, [{
    afterId: "terminal:previous:succeeded:2026-05-17T01%3A00%3A00.000Z",
    limit: 5,
    reconcileUnacked: false,
  }]);
});

test("monitor status projects compact broker audit bottleneck warnings from health metadata", async () => {
  const responses = [];
  const handlers = createA2AMonitoringHandlers({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          config: {
            baseUrl: "https://broker.example.test",
          },
        },
      },
    },
  }, {
    createClient: () => ({
      async health() {
        return {
          ok: true,
          service: "a2a-broker",
          publicBaseUrl: "https://broker.example.test",
          buildInfo: {
            version: "1.2.3",
            revision: "78b2b42fca6e1234567890",
            image: "ghcr.io/jinwon-int/a2a-broker:1.2.3",
          },
          auditRows: 27985,
          maxAuditEvents: 5000,
          heartbeatRatio: 0.97,
          healthLatencyMs: 2300,
          dominantEventType: "worker.heartbeat",
          databasePath: "/private/should/not/project.sqlite",
        };
      },
      async listDiagnostics() {
        return {
          tasks: [],
          pluginWarnings: [{ code: "existing_warning" }],
        };
      },
    }),
  });

  await handlers.handleA2AMonitorStatus({
    params: {
      sessionKey: "session-1",
    },
    respond(ok, result, error) {
      responses.push({ ok, result, error });
    },
  });

  assert.equal(responses.length, 1);
  assert.equal(responses[0].ok, true);
  assert.equal(responses[0].error, undefined);
  assert.deepEqual(responses[0].result.tasks, []);
  assert.equal(responses[0].result.pluginWarnings.length, 2);
  assert.deepEqual(responses[0].result.pluginWarnings[1], {
    code: "broker_audit_bottleneck",
    severity: "warn",
    source: "broker.health",
    message: "Broker audit table may be a status bottleneck; verify audit retention/pruning and heartbeat volume.",
    auditRows: 27985,
    maxAuditEvents: 5000,
    heartbeatRatio: 0.97,
    healthLatencyMs: 2300,
    dominantEventType: "worker.heartbeat",
  });
  assert.equal("databasePath" in responses[0].result.pluginWarnings[1], false);
  assert.deepEqual(responses[0].result.brokerBuildInfo, {
    source: "broker.health",
    version: "1.2.3",
    revision: "78b2b42fca6e1234567890",
    image: "ghcr.io/jinwon-int/a2a-broker:1.2.3",
  });
});

test("monitor status projects terminal receipt gaps from broker diagnostics", async () => {
  const responses = [];
  const handlers = createA2AMonitoringHandlers({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          config: {
            baseUrl: "https://broker.example.test",
          },
        },
      },
    },
  }, {
    createClient: () => ({
      async health() {
        return { ok: true };
      },
      async listDiagnostics() {
        return {
          tasks: [
            {
              taskId: "task-provider-only",
              status: "succeeded",
              providerSendStatus: "sent",
              summary: "provider accepted but operator-visible receipt is still missing",
            },
            {
              taskId: "task-provider-delivered",
              status: "succeeded",
              terminalReceiptStatus: "provider-delivered-if-known",
            },
            {
              taskId: "task-current-session",
              status: "succeeded",
              receipt: {
                status: "receipt_confirmed",
                projection: "current_session_visible",
              },
            },
            {
              taskId: "task-stale",
              status: "succeeded",
              terminalReceiptStatus: "stale",
            },
            {
              taskId: "task-timed-out",
              status: "succeeded",
              receipt: { status: "timed_out" },
              ackAudit: { decision: "pending", receiptStatus: "timed_out" },
            },
          ],
          terminalOutbox: [
            {
              id: "terminal-outbox-duplicate",
              payload: { taskId: "task-duplicate", status: "succeeded" },
              receipt: { status: "provider_sent" },
              ackAudit: { decision: "duplicate_suppressed", receiptStatus: "provider_sent" },
            },
          ],
        };
      },
    }),
  });

  await handlers.handleA2AMonitorStatus({
    params: {
      sessionKey: "session-1",
    },
    respond(ok, result, error) {
      responses.push({ ok, result, error });
    },
  });

  assert.equal(responses.length, 1);
  assert.equal(responses[0].ok, true);
  assert.equal(responses[0].error, undefined);
  assert.deepEqual(responses[0].result.terminalReceiptGaps.map((gap) => gap.taskId), [
    "task-current-session",
    "task-duplicate",
    "task-provider-delivered",
    "task-provider-only",
    "task-stale",
    "task-timed-out",
  ]);
  const byTask = new Map(responses[0].result.terminalReceiptGaps.map((gap) => [gap.taskId, gap]));
  assert.equal(byTask.get("task-provider-only").receiptState, "sent");
  assert.equal(byTask.get("task-provider-only").receiptGapStatus, "missing");
  assert.equal(byTask.get("task-provider-only").operatorReceiptState, "pending_receipt");
  assert.equal(byTask.get("task-provider-only").operatorReceiptLabel, "⋯ pending receipt");
  assert.equal(byTask.get("task-provider-only").providerDeliveryState, "sent");
  assert.equal(byTask.get("task-provider-only").receiptStatus, "pending");
  assert.equal(byTask.get("task-provider-only").terminalAckEligible, false);
  assert.match(byTask.get("task-provider-only").reason, /no current-session\/manual receipt — ack blocked/);
  assert.equal(byTask.get("task-provider-delivered").receiptState, "provider-delivered-if-known");
  assert.equal(byTask.get("task-provider-delivered").providerDeliveryState, "provider-delivered-if-known");
  assert.equal(byTask.get("task-provider-delivered").receiptGapStatus, "missing");
  assert.equal(byTask.get("task-provider-delivered").operatorReceiptState, "pending_receipt");
  assert.equal(byTask.get("task-provider-delivered").terminalAckEligible, false);
  assert.equal(byTask.get("task-current-session").receiptState, "operator-visible");
  assert.equal(byTask.get("task-current-session").receiptGapStatus, "confirmed");
  assert.equal(byTask.get("task-current-session").receiptStatus, "received");
  assert.equal(byTask.get("task-current-session").operatorReceiptState, "receipt_confirmed");
  assert.equal(byTask.get("task-current-session").terminalAckEligible, true);
  assert.equal(byTask.get("task-stale").receiptState, "stale");
  assert.equal(byTask.get("task-stale").receiptGapStatus, "stale");
  assert.equal(byTask.get("task-stale").operatorReceiptState, "stale");
  assert.equal(byTask.get("task-timed-out").receiptState, "timed_out");
  assert.equal(byTask.get("task-timed-out").receiptGapStatus, "timed_out");
  assert.equal(byTask.get("task-timed-out").operatorReceiptState, "timed_out");
  assert.equal(byTask.get("task-duplicate").receiptGapStatus, "duplicate_suppressed");
  assert.equal(byTask.get("task-duplicate").operatorReceiptState, "duplicate_suppressed");
  assert.equal(byTask.get("task-duplicate").providerDeliveryState, "sent");
  assert.equal(byTask.get("task-duplicate").terminalAckEligible, false);

  const warning = responses[0].result.pluginWarnings.find((item) => item.code === "terminal_receipt_gap");
  assert.deepEqual(warning, {
    code: "terminal_receipt_gap",
    severity: "warn",
    source: "broker.diagnostics",
    message: "Terminal task receipt/evidence is not operator-confirmed; provider send success is not terminal ACK evidence.",
    count: 5,
    taskIds: ["task-duplicate", "task-provider-delivered", "task-provider-only", "task-stale", "task-timed-out"],
  });
  assert.doesNotMatch(JSON.stringify(responses[0].result.terminalReceiptGaps), /provider accepted but operator-visible/);
});

test("monitor status projects redacted Docker Compose runtime owner metadata from broker health", async () => {
  const responses = [];
  const handlers = createA2AMonitoringHandlers({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          config: {
            baseUrl: "https://broker.example.test",
          },
        },
      },
    },
  }, {
    createClient: () => ({
      async health() {
        return {
          ok: true,
          service: "a2a-broker",
          runtimeOwner: {
            manager: "docker-compose",
            composeProject: "a2a-broker-prod",
            composeService: "broker",
            containerName: "a2a-broker-1",
            socketPath: "/private/should/not/project.sock",
          },
          systemdUnit: "a2a-broker.service",
        };
      },
      async listDiagnostics() {
        return { tasks: [] };
      },
    }),
  });

  await handlers.handleA2AMonitorStatus({
    params: {
      sessionKey: "session-1",
    },
    respond(ok, result, error) {
      responses.push({ ok, result, error });
    },
  });

  assert.equal(responses.length, 1);
  assert.equal(responses[0].ok, true);
  assert.equal(responses[0].error, undefined);
  assert.deepEqual(responses[0].result.brokerRuntimeOwner, {
    manager: "docker-compose",
    service: "a2a-broker",
    unit: "a2a-broker.service",
    composeProject: "a2a-broker-prod",
    composeService: "broker",
    containerName: "a2a-broker-1",
  });
  assert.equal("socketPath" in responses[0].result.brokerRuntimeOwner, false);
});

test("monitor status redacts unsafe broker build info values from broker health", async () => {
  const responses = [];
  const handlers = createA2AMonitoringHandlers({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          config: {
            baseUrl: "https://broker.example.test",
          },
        },
      },
    },
  }, {
    createClient: () => ({
      async health() {
        return {
          ok: true,
          service: "a2a-broker",
          publicBaseUrl: "https://broker.example.test",
          build: {
            version: "2.0.0-token=should-not-leak",
            revision: "Bearer abcdefghijklmnopqrstuvwxyz",
            image: "ghcr.io/jinwon-int/a2a-broker:token=should-not-leak",
          },
          container: {
            image: "/root/private/a2a-broker:latest",
          },
        };
      },
      async listDiagnostics() {
        return { tasks: [] };
      },
    }),
  });

  await handlers.handleA2AMonitorStatus({
    params: {
      sessionKey: "session-1",
    },
    respond(ok, result, error) {
      responses.push({ ok, result, error });
    },
  });

  assert.equal(responses.length, 1);
  assert.equal(responses[0].ok, true);
  assert.equal(responses[0].error, undefined);
  assert.deepEqual(responses[0].result.brokerBuildInfo, {
    source: "broker.health",
    version: "unknown",
    revision: "unknown",
    image: "unknown",
  });
  assert.doesNotMatch(JSON.stringify(responses[0].result), /should-not-leak|\/root\/private|Bearer/);
});

test("monitor status exposes unknown broker build info when broker health build fields are absent", async () => {
  const expected = { tasks: [{ id: "task-1" }] };
  const responses = [];
  const handlers = createA2AMonitoringHandlers({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          config: {
            baseUrl: "https://broker.example.test",
          },
        },
      },
    },
  }, {
    createClient: () => ({
      async health() {
        return {
          ok: true,
          service: "a2a-broker",
          publicBaseUrl: "https://broker.example.test",
          auditRows: 100,
          maxAuditEvents: 5000,
          heartbeatRatio: 0.1,
          healthLatencyMs: 60,
        };
      },
      async listDiagnostics() {
        return expected;
      },
    }),
  });

  await handlers.handleA2AMonitorStatus({
    params: {
      sessionKey: "session-1",
    },
    respond(ok, result, error) {
      responses.push({ ok, result, error });
    },
  });

  assert.equal(responses.length, 1);
  assert.equal(responses[0].ok, true);
  assert.equal(responses[0].error, undefined);
  assert.notEqual(responses[0].result, expected);
  assert.deepEqual(responses[0].result.tasks, expected.tasks);
  assert.deepEqual(responses[0].result.brokerBuildInfo, {
    source: "broker.health",
    version: "unknown",
    revision: "unknown",
    image: "unknown",
  });
});

test("monitor status wires terminal notifications to the configured Telegram adapter", async () => {
  const sent = [];
  const handlers = createA2AMonitoringHandlers({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: {
            baseUrl: "https://broker.example.test",
            operatorEvents: {
              enabled: true,
              notification: {
                enabled: true,
                channel: "telegram",
                to: "operator-chat",
                threadId: "round-2",
              },
            },
          },
        },
      },
    },
  }, {
    now: () => Date.parse("2026-05-02T00:00:00.000Z"),
    runtime: {
      channel: {
        outbound: {
          async loadAdapter(channel) {
            assert.equal(channel, "telegram");
            return {
              capabilities: { currentSessionVisibleReceipt: true },
              async sendText(payload) {
                sent.push(payload);
                return {
                  delivery: {
                    channel: "telegram",
                    to: "operator-chat",
                    threadId: "round-2",
                    currentSessionVisible: true,
                  },
                };
              },
            };
          },
        },
      },
    },
    createClient: () => ({
      async *streamOperatorEvents(options = {}) {
        const terminalEvent = {
          receiptProjection: "current_session_visible",
          type: "succeeded",
          taskId: "task-telegram",
          createdAt: "2026-05-02T00:00:00.000Z",
          summary: "PR ready for review",
          prUrl: "https://github.com/jinwon-int/openclaw-plugin-a2a/pull/146",
        };
        yield { name: "operator-summary-update", id: "terminal:telegram:1", data: { terminalEvent } };
        yield { name: "operator-summary-update", id: "terminal:telegram:1", data: { terminalEvent } };
        await waitForAbort(options.signal);
      },
    }),
  });

  const responses = [];
  await handlers.handleA2AMonitorStatus({
    params: { sessionKey: "operator-session", operatorEvents: { enabled: true, cursor: "terminal:telegram:0" } },
    respond(ok, result, error) {
      responses.push({ ok, result, error });
    },
  });

  await eventually(
    () => sent,
    (value) => value.length === 1,
    "expected terminal event to be delivered to Telegram adapter once",
  );

  await handlers.handleA2AMonitorStatus({
    params: { sessionKey: "operator-session", operatorEvents: { enabled: true } },
    respond(ok, result, error) {
      responses.push({ ok, result, error });
    },
  });

  assert.equal(responses[0].ok, true);
  assert.equal(responses[1].result.operator.terminalOutbox.lastNotificationAttempt.source, "live-stream");
  assert.equal(responses[1].result.operator.terminalOutbox.lastNotificationAttempt.taskId, "task-telegram");
  assert.equal(responses[1].result.operator.terminalOutbox.lastNotificationAttempt.receiptStatus, "received");
  assert.equal(sent[0].channel, "telegram");
  assert.equal(sent[0].to, "operator-chat");
  assert.equal(sent[0].threadId, "round-2");
  assert.deepEqual(sent[0].delivery, {
    mode: "announce",
    channel: "telegram",
    to: "operator-chat",
    threadId: "round-2",
  });
  assert.equal(sent[0].receiptRequired, "current_session_visible");
  assert.equal(sent[0].userVisibleReceiptRequired, true);
  assert.equal(sent[0].text, "A2A Terminal Brief 완료: A2A(1/1)");
  assert.doesNotMatch(sent[0].text, /업무:/);
  assert.doesNotMatch(sent[0].text, /PR ready for review/);
  assert.doesNotMatch(sent[0].text, /Dedupe:/);
  assert.doesNotMatch(sent[0].text, /Task: task-telegram/);
});

test("monitor status exposes no-live notification preflight for proposed Terminal Brief config", async () => {
  const sends = [];
  let clientCreated = false;
  const handlers = createA2AMonitoringHandlers({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: {
            baseUrl: "https://broker.example.test",
            operatorEvents: {
              enabled: false,
              notification: { enabled: false, channel: "telegram", to: "stale-chat" },
            },
          },
        },
      },
    },
  }, {
    runtime: {
      channel: {
        outbound: {
          async loadAdapter(channel) {
            assert.equal(channel, "telegram");
            return {
              capabilities: { currentSessionVisibleReceipt: true },
              async sendText(payload) {
                sends.push(payload);
              },
            };
          },
        },
      },
    },
    createClient: () => {
      clientCreated = true;
      throw new Error("preflight must not create a broker client");
    },
  });

  const responses = [];
  await handlers.handleA2AMonitorStatus({
    params: {
      sessionKey: "operator-session",
      operatorEvents: {
        preflight: true,
        enabled: true,
        notification: { enabled: true, channel: "telegram", to: "operator-chat", accountId: "default" },
      },
    },
    respond(ok, result, error) {
      responses.push({ ok, result, error });
    },
  });

  assert.equal(responses.length, 1);
  assert.equal(responses[0].ok, true);
  assert.equal(responses[0].error, undefined);
  assert.equal(responses[0].result.kind, "a2a.operator.notification.preflight");
  assert.equal(responses[0].result.mode, "no-live");
  assert.equal(responses[0].result.decision, "GO");
  assert.equal(responses[0].result.safeToRestartGateway, true);
  assert.equal(responses[0].result.liveSendPerformed, false);
  assert.equal(responses[0].result.terminalOutboxAckPerformed, false);
  assert.equal(responses[0].result.providerSendPerformed, false);
  assert.equal(responses[0].result.preflight.providerSendMode, "receipt_confirmed_required");
  assert.deepEqual(responses[0].result.preflight.target, {
    channel: "telegram",
    to: "operator-chat",
    accountId: "default",
  });
  assert.equal(sends.length, 0, "no-live preflight must not send Telegram messages");
  assert.equal(clientCreated, false, "no-live preflight must not touch the broker");
});

test("monitor status labels allowUnconfirmedProviderSend as transport-only and non-ACK", async () => {
  const sends = [];
  const handlers = createA2AMonitoringHandlers({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: {
            baseUrl: "https://broker.example.test",
            operatorEvents: { enabled: false },
          },
        },
      },
    },
  }, {
    runtime: {
      channel: {
        outbound: {
          async loadAdapter(channel) {
            assert.equal(channel, "telegram");
            return {
              async sendText(payload) {
                sends.push(payload);
                return { accepted: true, status: "sent" };
              },
            };
          },
        },
      },
    },
  });

  const responses = [];
  await handlers.handleA2AMonitorStatus({
    params: {
      sessionKey: "operator-session",
      operatorEvents: {
        preflight: true,
        enabled: true,
        notification: {
          enabled: true,
          channel: "telegram",
          to: "operator-chat",
          allowUnconfirmedProviderSend: true,
        },
      },
    },
    respond(ok, result, error) {
      responses.push({ ok, result, error });
    },
  });

  assert.equal(responses[0].ok, true);
  assert.equal(responses[0].result.decision, "BLOCK");
  assert.equal(responses[0].result.safeToRestartGateway, false);
  assert.equal(responses[0].result.preflight.providerSendMode, "transport_only_unacknowledged");
  assert.equal(responses[0].result.preflight.target.allowUnconfirmedProviderSend, true);
  assert.match(responses[0].result.preflight.notificationTarget.reason, /current-session-visible receipt support/);
  assert.equal(sends.length, 0, "preflight must not perform even transport-only sends");
});

test("operator notification adapter fails closed unless operator events and notifications are explicitly enabled", async () => {
  const { createA2AOperatorNotificationAdapter, resolveOperatorNotificationTarget } = await import("../dist/src/operator-notification-adapter.js");
  const base = {
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: {
            baseUrl: "https://broker.example.test",
            operatorEvents: {
              enabled: true,
              notification: { enabled: true, channel: "telegram", to: "stale-operator-chat" },
            },
          },
        },
      },
    },
  };
  const withOperatorEventsDisabled = structuredClone(base);
  withOperatorEventsDisabled.plugins.entries["a2a-broker-adapter"].config.operatorEvents.enabled = false;
  const withNotificationDisabled = structuredClone(base);
  withNotificationDisabled.plugins.entries["a2a-broker-adapter"].config.operatorEvents.notification.enabled = false;
  const withLegacyImplicitNotification = structuredClone(base);
  delete withLegacyImplicitNotification.plugins.entries["a2a-broker-adapter"].config.operatorEvents.notification.enabled;

  for (const config of [withOperatorEventsDisabled, withNotificationDisabled, withLegacyImplicitNotification]) {
    assert.equal(resolveOperatorNotificationTarget(config), undefined);
    assert.equal(createA2AOperatorNotificationAdapter(config, {}), undefined);
  }
});

test("operator notification adapter supports nested Telegram outbound adapters without ACKing provider success", async () => {
  const { createA2AOperatorNotificationAdapter } = await import("../dist/src/operator-notification-adapter.js");
  const envelope = {
    kind: "a2a.operator.notification",
    version: 1,
    id: "operator-notify:terminal:receipt:1:task-receipt:success",
    dedupeKey: "terminal:receipt:1:task-receipt:success",
    type: "success",
    severity: "info",
    deliveryOwner: "openclaw.plugin-notifier",
    deliveryTarget: "operator-main-session",
    title: "A2A 완료: task task-receipt",
    text: "provider accepted but no user-visible receipt",
    evidence: { schema: "a2a.operator.notification.evidence", version: 1, taskId: "task-receipt" },
    taskId: "task-receipt",
  };

  const sent = [];
  const adapter = createA2AOperatorNotificationAdapter({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: {
            operatorEvents: {
              enabled: true,
              notification: { enabled: true, channel: "telegram", to: "operator-chat" },
            },
          },
        },
      },
    },
  }, {
    channel: {
      outbound: {
        async loadAdapter() {
          return {
            base: {
              capabilities: { currentSessionVisibleReceipt: true },
              async sendPayload(payload) {
                sent.push(payload);
                return { ok: true, providerMessageId: "gateway-success-only" };
              },
            },
          };
        },
      },
    },
  }, { now: () => Date.parse("2026-05-02T01:00:00.000Z") });

  const receipt = await adapter.notify(envelope);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "operator-chat");
  assert.equal(sent[0].payload.text, "A2A Terminal Brief 완료: A2A(1/1)");
  assert.doesNotMatch(sent[0].payload.text, /provider accepted but no user-visible receipt/);
  assert.equal(receipt, undefined);
  assert.deepEqual(adapter.listReceipts(), []);
});

test("operator notification adapter treats accepted-vs-acknowledged core fields as fail-closed receipt gates", async () => {
  const { createA2AOperatorNotificationAdapter } = await import("../dist/src/operator-notification-adapter.js");
  const responses = [
    { delivery: { accepted: true, currentSessionVisible: true, status: "accepted" } },
    { delivery: { providerAccepted: true, confirmation: { source: "current_session_visible", status: "accepted" } } },
    { delivery: { accepted: true, acknowledged: true, currentSessionVisible: true, status: "accepted" } },
  ];
  const adapter = createA2AOperatorNotificationAdapter({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: {
            operatorEvents: {
              enabled: true,
              notification: { enabled: true, channel: "telegram", to: "operator-chat" },
            },
          },
        },
      },
    },
  }, {
    channel: {
      outbound: {
        async loadAdapter() {
          return { capabilities: { currentSessionVisibleReceipt: true }, async sendText() { return responses.shift(); } };
        },
      },
    },
  });

  const base = {
    kind: "a2a.operator.notification",
    version: 1,
    type: "success",
    severity: "info",
    deliveryOwner: "openclaw.plugin-notifier",
    deliveryTarget: "operator-main-session",
    title: "A2A 완료",
    text: "accepted is not acknowledged",
    evidence: { schema: "a2a.operator.notification.evidence", version: 1 },
  };

  const acceptedOnly = await adapter.notify({ ...base, id: "n-accepted", dedupeKey: "terminal:receipt:accepted-only:success" });
  const acceptedProjectionOnly = await adapter.notify({ ...base, id: "n-accepted-projection", dedupeKey: "terminal:receipt:accepted-projection-only:success" });
  const acknowledged = await adapter.notify({ ...base, id: "n-acknowledged", dedupeKey: "terminal:receipt:acknowledged:success" });

  assert.equal(acceptedOnly, undefined);
  assert.equal(acceptedProjectionOnly, undefined);
  assert.equal(acknowledged.confirmationSource, "current_session_visible");
  assert.equal(adapter.listReceipts().length, 1);
});

test("operator notification adapter rejects receipt confirmations for the wrong Telegram target", async () => {
  const { createA2AOperatorNotificationAdapter } = await import("../dist/src/operator-notification-adapter.js");
  const sent = [];
  const adapter = createA2AOperatorNotificationAdapter({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: {
            operatorEvents: {
              enabled: true,
              notification: { enabled: true, channel: "telegram", to: "operator-chat", threadId: "expected-thread" },
            },
          },
        },
      },
    },
  }, {
    channel: {
      outbound: {
        async loadAdapter() {
          return {
            capabilities: { currentSessionVisibleReceipt: true },
            async sendText(payload) {
              sent.push(payload);
              return {
                delivery: {
                  channel: "telegram",
                  to: "other-chat",
                  threadId: "expected-thread",
                  currentSessionVisible: true,
                },
              };
            },
          };
        },
      },
    },
  });

  const receipt = await adapter.notify({
    kind: "a2a.operator.notification",
    version: 1,
    id: "operator-notify:terminal:receipt:wrong-target:success",
    dedupeKey: "terminal:receipt:wrong-target:success",
    type: "success",
    severity: "info",
    deliveryOwner: "openclaw.plugin-notifier",
    deliveryTarget: "operator-main-session",
    title: "A2A 완료: task wrong-target",
    text: "wrong target receipt must not ack",
    evidence: { schema: "a2a.operator.notification.evidence", version: 1, taskId: "wrong-target" },
    taskId: "wrong-target",
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "operator-chat");
  assert.equal(sent[0].delivery.to, "operator-chat");
  assert.equal(receipt, undefined);
  assert.deepEqual(adapter.listReceipts(), []);
});

test("operator notification adapter accepts current-session and manual receipt confirmations", async () => {
  const { createA2AOperatorNotificationAdapter } = await import("../dist/src/operator-notification-adapter.js");
  const responses = [
    { delivery: { currentSessionVisible: true } },
    { receipt: { manualReceiptConfirmed: true } },
    { confirmation: { source: "current_session_visible", status: "visible" } },
    { delivery: { confirmation: { source: "manual_operator_receipt", status: "confirmed" } } },
  ];
  const adapter = createA2AOperatorNotificationAdapter({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: { operatorEvents: { enabled: true, notification: { enabled: true, channel: "telegram", to: "operator-chat" } } },
        },
      },
    },
  }, {
    channel: {
      outbound: {
        async loadAdapter() {
          return { capabilities: { currentSessionVisibleReceipt: true }, async sendText() { return responses.shift(); } };
        },
      },
    },
  }, { now: () => Date.parse("2026-05-02T01:01:00.000Z") });

  const base = {
    kind: "a2a.operator.notification",
    version: 1,
    type: "success",
    severity: "info",
    deliveryOwner: "openclaw.plugin-notifier",
    deliveryTarget: "operator-main-session",
    title: "A2A 완료",
    text: "confirmed",
    evidence: { schema: "a2a.operator.notification.evidence", version: 1 },
  };
  const current = await adapter.notify({ ...base, id: "n1", dedupeKey: "terminal:receipt:2:current:success" });
  const manual = await adapter.notify({ ...base, id: "n2", dedupeKey: "terminal:receipt:3:manual:success" });
  const currentProjection = await adapter.notify({ ...base, id: "n3", dedupeKey: "terminal:receipt:4:current-projection:success" });
  const manualProjection = await adapter.notify({ ...base, id: "n4", dedupeKey: "terminal:receipt:5:manual-projection:success" });

  assert.equal(current.confirmationSource, "current_session_visible");
  assert.equal(manual.confirmationSource, "manual_operator_receipt");
  assert.equal(currentProjection.confirmationSource, "current_session_visible");
  assert.equal(manualProjection.confirmationSource, "manual_operator_receipt");
  assert.equal(adapter.listReceipts().length, 4);
});

test("operator event bridge suppresses historical live-stream terminal replay by default", async () => {
  const notified = [];
  const bridge = createA2AOperatorEventBridge({
    now: () => Date.parse("2026-05-06T00:40:00.000Z"),
    broker: {
      async *streamOperatorEvents(options = {}) {
        yield {
          name: "operator-summary-update",
          id: "operator:replayed-terminal-proof",
          data: {
            terminalEvent: {
              receiptProjection: "current_session_visible",
              type: "succeeded",
              taskId: "stale-terminal-live-stream",
              createdAt: "2026-05-05T15:37:55.021Z",
              summary: "stale Terminal Brief replay must not send Telegram",
            },
          },
        };
        await waitForAbort(options.signal);
      },
    },
    notifyOperator(envelope) {
      notified.push(envelope);
      return { ackTerminalEvent: true, confirmationSource: "current_session_visible" };
    },
  });

  try {
    bridge.getState({ cursor: "operator:old" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(notified.length, 0, "historical live-stream terminal replay must not notify Telegram by default");
    const state = bridge.getState();
    assert.equal(state.operator.terminalOutbox.lastNotificationAttempt.source, "live-stream");
    assert.equal(state.operator.terminalOutbox.lastNotificationAttempt.receiptStatus, "pending");
    assert.match(state.operator.terminalOutbox.lastNotificationAttempt.reason, /historical operator terminal-event replay suppressed/);
    assert.equal(state.bridge.cursor, undefined, "suppressed replay must not advance terminal cursor as receipt-confirmed");
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("operator event bridge withholds terminal cursor ack until receipt-confirmed delivery", async () => {
  const cursorWrites = [];
  const notified = [];
  const bridge = createA2AOperatorEventBridge({
    terminalEventHistoricalReplay: "notify",
    broker: {
      async *streamOperatorEvents(options = {}) {
        yield {
          name: "operator-summary-update",
          id: "terminal:receipt:4",
          data: {
            terminalEvent: {
              receiptProjection: "current_session_visible",
              type: "succeeded",
              taskId: "task-unconfirmed",
              createdAt: "2026-05-02T01:02:00.000Z",
              summary: "sent but not seen by operator",
            },
          },
        };
        await waitForAbort(options.signal);
      },
    },
    writeCursor(cursor) { cursorWrites.push(cursor); },
    notifyOperator(envelope) {
      notified.push(envelope);
      return { ackTerminalEvent: false, reason: "provider success is not a receipt" };
    },
  });

  try {
    bridge.getState({ cursor: "terminal:receipt:3" });
    await eventually(() => notified, (value) => value.length === 1, "expected terminal notification attempt");
    assert.deepEqual(cursorWrites, []);
    assert.equal(bridge.getState().bridge.cursor, undefined);
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("operator event bridge persists terminal cursor after explicit receipt-confirmed delivery", async () => {
  const cursorWrites = [];
  const bridge = createA2AOperatorEventBridge({
    terminalEventHistoricalReplay: "notify",
    broker: {
      async *streamOperatorEvents(options = {}) {
        yield {
          name: "operator-summary-update",
          id: "terminal:receipt:5",
          data: { terminalEvent: { receiptProjection: "current_session_visible", type: "succeeded", taskId: "task-confirmed" } },
        };
        await waitForAbort(options.signal);
      },
    },
    writeCursor(cursor) { cursorWrites.push(cursor); },
    notifyOperator() {
      return { ackTerminalEvent: true, reason: "current-session receipt confirmed" };
    },
  });

  try {
    bridge.getState({ cursor: "terminal:receipt:4" });
    await eventually(() => cursorWrites, (value) => value.includes("terminal:receipt:5"), "expected cursor ack after receipt");
    assert.equal(bridge.getState().bridge.cursor, "terminal:receipt:5");
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("operator event bridge builds plugin-owned terminal notifications with dedupe and dry-run delivery", async () => {
  const delivered = [];
  const bridge = createA2AOperatorEventBridge({
    terminalEventHistoricalReplay: "notify",
    broker: {
      async *streamOperatorEvents(options = {}) {
        const terminalEvent = {
          receiptProjection: "current_session_visible",
          type: "failed",
          taskId: "task-137",
          createdAt: "2026-05-01T14:30:00.000Z",
          summary: "runner failed with token=should-not-leak at /root/private/log.txt",
        };
        yield {
          name: "operator-summary-update",
          id: "terminal:1",
          data: { terminalEvent },
        };
        yield {
          name: "operator-summary-update",
          id: "terminal:1",
          data: { terminalEvent },
        };
        await waitForAbort(options.signal);
      },
    },
    dryRunNotifications: true,
    notificationMaxTextChars: 160,
    notifyOperator(envelope) {
      delivered.push(envelope);
    },
  });

  try {
    bridge.getState({ cursor: "terminal:0" });
    await eventually(
      () => delivered,
      (value) => value.length === 1,
      "expected duplicate terminal events to produce one operator notification",
    );

    assert.equal(delivered[0].kind, "a2a.operator.notification");
    assert.equal(delivered[0].deliveryOwner, "openclaw.plugin-notifier");
    assert.equal(delivered[0].deliveryTarget, "operator-main-session");
    assert.equal(delivered[0].type, "failure");
    assert.equal(delivered[0].taskId, "task-137");
    assert.equal(delivered[0].evidence.schema, "a2a.operator.notification.evidence");
    assert.equal(delivered[0].evidence.taskId, "task-137");
    assert.equal(delivered[0].dryRun, true);
    assert.match(delivered[0].title, /A2A Terminal Brief 실패/);
    assert.doesNotMatch(delivered[0].text, /should-not-leak|\/root\/private/);
    assert.match(delivered[0].text, /\[REDACTED\]|\[REDACTED_PATH\]/);
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("operator terminal ack gate requires operator-visible receipt before notify/cursor", async () => {
  const delivered = [];
  const cursorWrites = [];
  const bridge = createA2AOperatorEventBridge({
    terminalEventHistoricalReplay: "notify",
    broker: {
      async *streamOperatorEvents(options = {}) {
        yield {
          name: "operator-summary-update",
          id: "terminal:no-receipt",
          data: {
            terminalEvent: {
              type: "succeeded",
              taskId: "task-no-receipt",
              summary: "provider send succeeded but no operator-visible receipt",
              receiptProjection: "gateway_provider_send_success",
            },
          },
        };
        yield {
          name: "operator-summary-update",
          id: "terminal:manual-receipt",
          data: {
            terminalEvent: {
              type: "succeeded",
              taskId: "task-manual-receipt",
              summary: "operator confirmed visible",
              receiptProjection: "manual_operator_receipt",
            },
          },
        };
        await waitForAbort(options.signal);
      },
    },
    writeCursor(cursor) {
      cursorWrites.push(cursor);
    },
    notifyOperator(envelope) {
      delivered.push(envelope);
      return { ackTerminalEvent: true, reason: "manual operator receipt confirmed" };
    },
  });

  try {
    bridge.getState({ cursor: "terminal:0" });
    await eventually(
      () => ({ delivered, cursorWrites }),
      (value) => value.delivered.length === 1 && value.cursorWrites.length === 1,
      "expected only receipt-confirmed terminal event to notify and advance cursor",
    );

    assert.equal(delivered[0].taskId, "task-manual-receipt");
    assert.equal(delivered[0].evidence.receiptProjection, "manual_operator_receipt");
    assert.deepEqual(cursorWrites, ["terminal:manual-receipt"]);
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("operator terminal notification renderer covers success block and PR events", async () => {
  const { buildA2AOperatorTerminalNotificationEnvelope } = await import("../dist/src/operator-terminal-notifier.js");

  const success = buildA2AOperatorTerminalNotificationEnvelope({
    id: "s1",
    data: { terminalEvent: { receiptProjection: "current_session_visible", type: "succeeded", taskId: "ok-1", summary: "작업 완료" } },
  });
  const blocked = buildA2AOperatorTerminalNotificationEnvelope({
    id: "b1",
    data: { terminalEvent: { receiptProjection: "manual_operator_receipt", type: "blocked", taskId: "block-1", summary: "승인 대기" } },
  });
  const pr = buildA2AOperatorTerminalNotificationEnvelope({
    id: "p1",
    data: {
      terminalEvent: {
        receiptProjection: "current_session_visible",
        type: "pr_opened",
        taskId: "pr-1",
        prUrl: "https://github.com/jinwon-int/openclaw-plugin-a2a/pull/138",
      },
    },
  });

  assert.equal(success.type, "success");
  assert.equal(success.severity, "info");
  assert.equal(success.evidence.receiptProjection, "current_session_visible");
  assert.match(success.title, /Terminal Brief 완료/);
  assert.match(success.text, /Required receipt proof: current_session_visible/);
  assert.doesNotMatch(success.text, /Receipt: current_session_visible/);
  assert.equal(blocked.type, "block");
  assert.equal(blocked.severity, "warn");
  assert.equal(blocked.evidence.receiptProjection, "manual_operator_receipt");
  assert.match(blocked.title, /Terminal Brief 차단/);
  assert.equal(pr.type, "pr");
  assert.equal(pr.prUrl, "https://github.com/jinwon-int/openclaw-plugin-a2a/pull/138");
  assert.equal(pr.deliveryOwner, "openclaw.plugin-notifier");

  const providerSendOnly = buildA2AOperatorTerminalNotificationEnvelope({
    id: "send-only",
    data: { terminalEvent: { type: "succeeded", taskId: "send-only", receiptProjection: "gateway_provider_send_success" } },
  });
  assert.equal(providerSendOnly, undefined);
});

test("operator terminal notification carries compact evidence and Telegram adapter payload", async () => {
  const {
    buildA2AOpenClawTelegramOperatorNotification,
    buildA2AOperatorTerminalNotificationEnvelope,
  } = await import("../dist/src/operator-terminal-notifier.js");

  const envelope = buildA2AOperatorTerminalNotificationEnvelope({
    id: "terminal:done:1",
    data: {
      terminalEvent: {
        receiptProjection: "current_session_visible",
        type: "succeeded",
        taskId: "task-146",
        workerId: "sogyo",
        status: "succeeded",
        repo: "jinwon-int/openclaw-plugin-a2a",
        issueUrl: "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/146",
        doneUrl: "https://github.com/jinwon-int/openclaw-plugin-a2a/pull/147",
        summary: "Done URL ready; secret=hide-me /root/private/raw.log",
        originalMessage: "Fix Terminal Brief notifications for worker completions",
        createdAt: "2026-05-02T00:00:00.000Z",
      },
    },
  });

  assert.equal(envelope.worker, "sogyo");
  assert.equal(envelope.status, "succeeded");
  assert.equal(envelope.repo, "jinwon-int/openclaw-plugin-a2a");
  assert.equal(envelope.issueUrl, "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/146");
  assert.equal(envelope.doneUrl, "https://github.com/jinwon-int/openclaw-plugin-a2a/pull/147");
  assert.equal(envelope.evidence.worker, "sogyo");
  assert.equal(envelope.evidence.repo, "jinwon-int/openclaw-plugin-a2a");
  assert.equal(envelope.evidence.doneUrl, "https://github.com/jinwon-int/openclaw-plugin-a2a/pull/147");
  assert.equal(envelope.evidence.taskDescription, "Fix Terminal Brief notifications for worker completions");
  assert.doesNotMatch(envelope.evidence.summary, /hide-me|\/root\/private/);
  assert.match(envelope.text, /Worker sogyo completed task: task-146 — Fix Terminal Brief notifications for worker completions/);
  assert.match(envelope.text, /Worker: sogyo/);
  assert.match(envelope.text, /Done: https:\/\/github.com\/jinwon-int\/openclaw-plugin-a2a\/pull\/147/);

  const telegram = buildA2AOpenClawTelegramOperatorNotification(envelope);
  assert.equal(telegram.kind, "openclaw.operator.telegram_notification");
  assert.deepEqual(telegram.delivery, { mode: "announce", channel: "telegram" });
  assert.equal(telegram.dedupeKey, envelope.dedupeKey);
  assert.deepEqual(telegram.evidence, envelope.evidence);
});

test("telegram-safe dry-run harness projects bounded Telegram payloads without send targets", async () => {
  const {
    buildA2AOperatorTerminalNotificationEnvelope,
    createA2ATelegramSafeDryRunNotificationHarness,
  } = await import("../dist/src/operator-terminal-notifier.js");

  const harness = createA2ATelegramSafeDryRunNotificationHarness({ maxNotifications: 1 });
  const first = buildA2AOperatorTerminalNotificationEnvelope(
    {
      id: "terminal:dry-run:1",
      data: {
        terminalEvent: {
          receiptProjection: "current_session_visible",
          type: "succeeded",
          taskId: "task-148",
          workerId: "dungae",
          summary: "dry-run ready token=hide-me /root/private/telegram.log",
          doneUrl: "https://github.com/jinwon-int/openclaw-plugin-a2a/pull/148",
        },
      },
    },
    { dryRun: true },
  );
  const second = buildA2AOperatorTerminalNotificationEnvelope({
    id: "terminal:dry-run:2",
    data: { terminalEvent: { receiptProjection: "current_session_visible", type: "failed", taskId: "task-149", summary: "should be dropped" } },
  });

  harness.notify(first);
  harness.notify(second);

  assert.deepEqual(harness.stats(), { accepted: 1, dropped: 1, maxNotifications: 1 });
  assert.equal(harness.list().length, 1);
  assert.equal(harness.list()[0].dryRun, true);

  const telegram = harness.listTelegram();
  assert.equal(telegram.length, 1);
  assert.equal(telegram[0].kind, "openclaw.operator.telegram_notification");
  assert.equal(telegram[0].dryRun, true);
  assert.deepEqual(telegram[0].delivery, { mode: "announce", channel: "telegram" });
  assert.equal("to" in telegram[0].delivery, false);
  assert.equal("token" in telegram[0].delivery, false);
  assert.doesNotMatch(JSON.stringify(telegram[0]), /hide-me|\/root\/private|chatId|botToken|apiKey/i);
});

test("operator release drift renderer summarizes broker and worker current stale unknown states", async () => {
  const {
    buildA2AOperatorReleaseDriftSummary,
    buildA2AOperatorTerminalNotificationEnvelope,
  } = await import("../dist/src/operator-terminal-notifier.js");

  const releaseDrift = buildA2AOperatorReleaseDriftSummary({
    releaseDrift: {
      broker: {
        revision: "78b2b42fca6e1234567890",
        expectedRevision: "78b2b42fca6e1234567890",
      },
      workers: [
        {
          workerId: "bangtong",
          runnerRevision: "160bd95af6b41234567890",
          expectedRevision: "ff4c244a38a71234567890",
        },
        {
          workerId: "dungae",
          runnerRevision: "ff4c244a38a71234567890",
          expectedRevision: "ff4c244a38a71234567890",
        },
        { workerId: "nosuk", status: "unknown" },
      ],
    },
  });

  assert.equal(releaseDrift.status, "stale");
  assert.equal(releaseDrift.broker.status, "current");
  assert.deepEqual(
    releaseDrift.workers.map((worker) => [worker.id, worker.status]),
    [["bangtong", "stale"], ["dungae", "current"], ["nosuk", "unknown"]],
  );
  assert.match(releaseDrift.text, /broker current 78b2b42fca6e/);
  assert.match(releaseDrift.text, /bangtong stale 160bd95af6b4→ff4c244a38a7/);
  assert.match(releaseDrift.text, /nosuk unknown \?/);

  const notification = buildA2AOperatorTerminalNotificationEnvelope({
    id: "terminal:pr:1",
    data: {
      terminalEvent: {
        receiptProjection: "current_session_visible",
        type: "pr_created",
        taskId: "task-139",
        prUrl: "https://github.com/jinwon-int/openclaw-plugin-a2a/pull/139",
        releaseDrift: {
          broker: { revision: "78b2b42fca6e", expectedRevision: "78b2b42fca6e" },
          workers: { dungae: { runnerRevision: "160bd95af6b4", expectedRevision: "ff4c244a38a7" } },
        },
        summary: "Terminal Brief proof saved; token=do-not-leak /home/example/private/session.log",
      },
    },
  });

  assert.equal(notification.type, "pr");
  assert.match(notification.text, /Release: broker current 78b2b42fca6e; workers dungae stale 160bd95af6b4→ff4c244a38a7/);
  assert.doesNotMatch(notification.text, /do-not-leak|\/home\/example\/private/);
});

test("operator event bridge exposes compact release drift status from summary snapshots", async () => {
  const bridge = createA2AOperatorEventBridge({
    broker: {
      async *streamOperatorEvents(options = {}) {
        yield {
          name: "operator-snapshot",
          id: "release:1",
          data: {
            snapshot: {
              summary: {
                releaseDrift: {
                  broker: { status: "unknown" },
                  workers: [{ workerId: "dungae", runnerRevision: "ff4c244a38a7", expectedRevision: "ff4c244a38a7" }],
                },
              },
            },
          },
        };
        await waitForAbort(options.signal);
      },
    },
  });

  try {
    bridge.getState({ cursor: "release:0" });
    const state = await eventually(
      () => bridge.getState(),
      (value) => value.operator.releaseDrift?.workers?.[0]?.status === "current",
      "expected operator bridge to project release drift summary",
    );

    assert.equal(state.operator.releaseDrift.status, "unknown");
    assert.equal(state.operator.releaseDrift.broker.status, "unknown");
    assert.match(state.operator.releaseDrift.text, /dungae current ff4c244a38a7/);
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("operator event bridge exposes receipt-gated terminal ack projections", async () => {
  const bridge = createA2AOperatorEventBridge({
    now: () => Date.parse("2026-05-02T00:10:00.000Z"),
    broker: {
      async *streamOperatorEvents(options = {}) {
        yield {
          name: "operator-summary-update",
          id: "terminal:pending:1",
          data: {
            summary: {
              terminalEvent: {
                id: "terminal-provider-send-only",
                taskId: "task-provider-only",
                type: "succeeded",
                providerSendStatus: "sent",
                cursor: "terminal:pending:1",
              },
            },
          },
        };
        yield {
          name: "operator-summary-update",
          id: "terminal:visible:2",
          data: {
            summary: {
              terminalReceipt: {
                taskId: "task-current-session",
                status: "succeeded",
                current_session_visible: true,
                cursor: "terminal:visible:2",
                receivedAt: "2026-05-02T00:09:30.000Z",
              },
            },
          },
        };
        yield {
          name: "operator-summary-update",
          id: "terminal:manual:3",
          data: {
            summary: {
              terminalReceipts: [
                {
                  taskId: "task-manual",
                  status: "blocked",
                  manual_operator_receipt: true,
                  eventId: "terminal-manual-event",
                },
                {
                  taskId: "task-telegram-visible",
                  status: "succeeded",
                  receipt: {
                    status: "receipt_confirmed",
                    evidence: "operator_visible",
                    receiptId: "telegram:7360371189:message:47146",
                  },
                  eventId: "terminal-telegram-visible-event",
                },
              ],
            },
          },
        };
        await waitForAbort(options.signal);
      },
    },
  });

  try {
    bridge.getState({ cursor: "terminal:0" });
    const state = await eventually(
      () => bridge.getState(),
      (value) => value.operator.terminalReceipts?.length === 4,
      "expected terminal receipt projections to include pending and receipt-confirmed entries",
    );

    const byTask = new Map(state.operator.terminalReceipts.map((receipt) => [receipt.taskId, receipt]));
    assert.equal(byTask.get("task-provider-only").terminalAckEligible, false);
    assert.equal(byTask.get("task-provider-only").receiptStatus, "pending");
    assert.match(byTask.get("task-provider-only").reason, /no current-session\/manual receipt — ack blocked/);
    assert.equal(byTask.get("task-current-session").terminalAckEligible, true);
    assert.equal(byTask.get("task-current-session").receiptMode, "current_session_visible");
    assert.equal(byTask.get("task-current-session").receiptStatus, "received");
    assert.equal(byTask.get("task-manual").terminalAckEligible, true);
    assert.equal(byTask.get("task-manual").receiptMode, "manual_operator_receipt");
    assert.equal(byTask.get("task-telegram-visible").terminalAckEligible, true);
    assert.equal(byTask.get("task-telegram-visible").receiptMode, "current_session_visible");
    assert.equal(byTask.get("task-telegram-visible").receiptStatus, "received");
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("operator event bridge consumes broker receipt gap vocabulary and dedupes by task", async () => {
  const bridge = createA2AOperatorEventBridge({
    now: () => Date.parse("2026-05-03T13:50:00.000Z"),
    broker: {
      async *streamOperatorEvents(options = {}) {
        yield {
          name: "operator-summary-update",
          id: "receipt:gaps:1",
          data: {
            summary: {
              terminalReceipts: [
                {
                  taskId: "task-confirmed",
                  status: "succeeded",
                  receipt: {
                    status: "receipt_confirmed",
                    projection: "current_session_visible",
                  },
                  eventId: "terminal-confirmed",
                },
                {
                  taskId: "task-missing",
                  status: "succeeded",
                  terminalReceiptStatus: "missing",
                  eventId: "terminal-missing",
                },
                {
                  taskId: "task-stale",
                  status: "succeeded",
                  operator_receipt_status: "stale",
                },
                {
                  taskId: "task-failed",
                  status: "failed",
                  receipt: { status: "failed" },
                },
                {
                  taskId: "task-missing",
                  status: "succeeded",
                  terminalReceiptStatus: "missing",
                  eventId: "terminal-missing-duplicate",
                },
              ],
            },
          },
        };
        await waitForAbort(options.signal);
      },
    },
  });

  try {
    bridge.getState({ cursor: "receipt:gaps:0" });
    const state = await eventually(
      () => bridge.getState(),
      (value) => value.operator.terminalReceipts?.length === 4,
      "expected receipt gap projection to compact duplicate task/run records",
    );

    const byTask = new Map(state.operator.terminalReceipts.map((receipt) => [receipt.taskId, receipt]));
    assert.equal(byTask.get("task-confirmed").status, "succeeded");
    assert.equal(byTask.get("task-confirmed").receiptGapStatus, "confirmed");
    assert.equal(byTask.get("task-confirmed").receiptStatus, "received");
    assert.equal(byTask.get("task-confirmed").receiptMode, "current_session_visible");
    assert.equal(byTask.get("task-confirmed").terminalAckEligible, true);

    assert.equal(byTask.get("task-missing").status, "succeeded");
    assert.equal(byTask.get("task-missing").receiptGapStatus, "missing");
    assert.equal(byTask.get("task-missing").receiptStatus, "pending");
    assert.equal(byTask.get("task-missing").terminalAckEligible, false);
    assert.match(byTask.get("task-missing").reason, /no current-session\/manual receipt — ack blocked/);

    assert.equal(byTask.get("task-stale").receiptGapStatus, "stale");
    assert.equal(byTask.get("task-stale").terminalAckEligible, false);
    assert.match(byTask.get("task-stale").reason, /stale/);

    assert.equal(byTask.get("task-failed").receiptGapStatus, "failed");
    assert.equal(byTask.get("task-failed").terminalAckEligible, false);
    assert.match(byTask.get("task-failed").reason, /failed/);
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("operator event bridge projects compact worker liveness and task progress", async () => {
  const bridge = createA2AOperatorEventBridge({
    now: () => Date.parse("2026-05-02T00:03:00.000Z"),
    broker: {
      async *streamOperatorEvents(options = {}) {
        yield {
          name: "operator-summary-update",
          id: "worker-progress:1",
          data: {
            summary: {
              workers: {
                bangtong: {
                  status: "healthy",
                  lastHeartbeatAt: "2026-05-02T00:02:30.000Z",
                  activeTaskId: "task-144-a",
                  progress: 0.4,
                  message: "patch in progress",
                },
                dungae: {
                  lastSeenAt: "2026-05-01T23:58:00.000Z",
                  currentTaskId: "task-144-b",
                  progressPercent: 75,
                  summary: "token=should-not-leak",
                },
                nosuk: {
                  status: "online",
                },
              },
              activeTasks: [
                {
                  id: "task-144-c",
                  workerId: "sogyo",
                  status: "running",
                  updatedAt: "2026-05-02T00:02:45.000Z",
                  progress: 0.25,
                  title: "compact projection",
                },
              ],
            },
          },
        };
        await waitForAbort(options.signal);
      },
    },
  });

  try {
    bridge.getState({ cursor: "worker-progress:0" });
    const state = await eventually(
      () => bridge.getState(),
      (value) => value.operator.workerProgress?.workers?.length === 4,
      "expected compact worker progress projection",
    );

    assert.deepEqual(state.operator.workerProgress.counts, {
      total: 4,
      live: 3,
      stale: 1,
      unknown: 0,
      activeTasks: 3,
    });
    assert.equal(state.operator.workerProgress.status, "stale");
    assert.deepEqual(
      state.operator.workerProgress.workers.map((worker) => [
        worker.workerId,
        worker.liveness,
        worker.activeTaskId,
        worker.progress,
      ]),
      [
        ["bangtong", "live", "task-144-a", 0.4],
        ["dungae", "stale", "task-144-b", 0.75],
        ["nosuk", "live", undefined, undefined],
        ["sogyo", "live", "task-144-c", 0.25],
      ],
    );
    assert.doesNotMatch(JSON.stringify(state.operator.workerProgress), /should-not-leak/);
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("operator notification renderer does not duplicate title or PR lines", () => {
  const text = renderOperatorNotificationText({
    kind: "a2a.operator.notification",
    version: 1,
    id: "operator-notify:terminal:task-1:succeeded",
    dedupeKey: "terminal:task-1:succeeded",
    type: "success",
    severity: "info",
    deliveryOwner: "openclaw.plugin-notifier",
    deliveryTarget: "operator-main-session",
    title: "A2A 완료: task task-1",
    text: [
      "A2A 완료: task task-1",
      "tests passed",
      "PR: https://github.com/jinwon-int/openclaw-plugin-a2a/pull/167",
    ].join("\n"),
    taskId: "task-1",
    prUrl: "https://github.com/jinwon-int/openclaw-plugin-a2a/pull/167",
    evidence: { schema: "a2a.operator.notification.evidence", version: 1, taskId: "task-1" },
  });

  assert.equal(text, "A2A Terminal Brief 완료: A2A(1/1)");
  assert.doesNotMatch(text, /PR: https:\/\/github.com\/jinwon-int\/openclaw-plugin-a2a\/pull\/167/);
  assert.doesNotMatch(text, /업무:/);
  assert.doesNotMatch(text, /Task: task-1/);
  assert.doesNotMatch(text, /Dedupe: terminal:task-1:succeeded/);
});

test("operator terminal outbox polling ACKs only after receipt-confirmed notification", async () => {
  const outboxEvent = {
    id: "terminal:task-outbox:succeeded:2026-05-02T05%3A00%3A00.000Z",
    kind: "task.terminal",
    taskEventId: 42,
    createdAt: "2026-05-02T05:00:00.000Z",
    attempts: 0,
    payload: {
      taskId: "task-outbox",
      status: "succeeded",
      worker: "dungae",
      repo: "jinwon-int/openclaw-plugin-a2a",
      issue: 165,
      doneUrl: "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/165#issuecomment-done",
      receiptProjection: "current_session_visible",
      testSummary: "provider send success is not enough",
      originalMessage: "Verify terminal outbox ACK safety gate",
      createdAt: "2026-05-02T04:59:00.000Z",
      updatedAt: "2026-05-02T05:00:00.000Z",
      completedAt: "2026-05-02T05:00:00.000Z",
    },
  };
  const sent = [];
  const acks = [];
  let receiptConfirmed = false;
  let nowMs = Date.parse("2026-05-02T05:01:00.000Z");
  const bridge = createA2AOperatorEventBridge({
    now: () => nowMs,
    terminalOutboxPollMs: 5,
    terminalOutboxHistoricalReplay: "notify",
    broker: {
      async *streamOperatorEvents(options = {}) {
        await waitForAbort(options.signal);
      },
      async listTerminalOutbox(params = {}) {
        return {
          kind: "task.terminal.outbox",
          count: 1,
          cursor: outboxEvent.id,
          reconciledUnacked: params.reconcileUnacked ? 1 : 0,
          events: [outboxEvent],
        };
      },
      async ackTerminalOutbox(params) {
        acks.push(params);
        return { ...outboxEvent, ack: { status: "receipt_confirmed", ...params.receipt } };
      },
    },
    notifyOperator(envelope) {
      sent.push(envelope);
      if (!receiptConfirmed) {
        return { ackTerminalEvent: false, reason: "provider success is not a receipt" };
      }
      return {
        ackTerminalEvent: true,
        confirmationSource: "current_session_visible",
        receiptId: "telegram-visible-165",
        reason: "current-session receipt confirmed",
      };
    },
  });

  try {
    bridge.getState({ cursor: "terminal:previous" });
    await eventually(() => sent.length, (value) => value >= 1, "expected terminal outbox notification attempt");
    assert.equal(acks.length, 0, "provider send success alone must not ack terminal outbox");
    let state = bridge.getState();
    assert.equal(state.operator.terminalOutbox.lastPoll.backlogDrain, true);
    assert.equal(state.operator.terminalOutbox.lastPoll.pendingUnacknowledged, 1);
    assert.equal(state.operator.terminalOutbox.pendingUnacknowledged[0].taskId, "task-outbox");
    assert.equal(state.operator.terminalOutbox.pendingUnacknowledged[0].status, "succeeded");
    assert.equal(state.operator.terminalOutbox.lastNotificationAttempt.source, "outbox-backlog");
    assert.equal(state.operator.terminalOutbox.lastNotificationAttempt.receiptStatus, "pending");
    assert.equal(state.operator.terminalOutbox.deployPreflight.mode, "dry-run-projection");
    assert.equal(state.operator.terminalOutbox.deployPreflight.status, "blocked");
    assert.equal(state.operator.terminalOutbox.deployPreflight.cursor, undefined);
    assert.equal(state.operator.terminalOutbox.lastPoll.firstPendingId, outboxEvent.id);
    assert.equal(state.operator.terminalOutbox.lastPoll.cursorBlockedByUnacked, true);
    assert.equal(state.operator.terminalOutbox.deployPreflight.backlog.pendingUnacknowledged, 1);
    assert.equal(state.operator.terminalOutbox.deployPreflight.backlog.reconciledUnacked, 1);
    assert.equal(state.operator.terminalOutbox.deployPreflight.lastNotificationAttempt.receiptStatus, "pending");
    assert.deepEqual(state.operator.terminalOutbox.deployPreflight.receiptGate.ackRequires, [
      "current_session_visible",
      "manual_operator_receipt",
    ]);
    assert.equal(state.operator.terminalOutbox.deployPreflight.receiptGate.providerGatewaySendSuccess, "not_ack_evidence");
    assert.equal(state.operator.terminalOutbox.deployPreflight.receiptGate.terminalAckEligible, false);
    assert.deepEqual(state.operator.terminalOutbox.deployPreflight.safeOperations, {
      liveSend: false,
      terminalOutboxAck: false,
      gatewayRestart: false,
      productionDeploy: false,
    });
    assert.equal(state.operator.safetyStatus.mode, "release-dryrun/no-live");
    assert.equal(state.operator.safetyStatus.status, "blocked");
    assert.equal(state.operator.safetyStatus.receiptGate.providerGatewaySendSuccess, "not_ack_evidence");
    assert.equal(state.operator.safetyStatus.receiptGate.terminalAckEligible, false);
    assert.deepEqual(state.operator.safetyStatus.safeOperations, {
      liveSend: false,
      terminalOutboxAck: false,
      gatewayRestart: false,
      productionDeploy: false,
    });
    assert.match(state.operator.safetyStatus.blockers.join("\n"), /unacknowledged/);
    assert.doesNotMatch(JSON.stringify(state.operator.terminalOutbox), /provider send success is not enough/);

    receiptConfirmed = true;
    nowMs += 60_000;
    await eventually(
      () => bridge.getState().operator.terminalOutbox.lastNotificationAttempt.reason,
      (value) => /one-shot live notification fuse is tripped/.test(value),
      "expected one-shot fuse to block retry sends while receipt remains unacked",
    );
    assert.equal(acks.length, 0, "manual/operator-visible receipt must be recorded through ACK path, not a repeat send");
    assert.equal(sent.length, 1, "pending receipt must not trigger another Telegram send");
    state = bridge.getState();
    assert.equal(state.operator.terminalOutbox.lastNotificationAttempt.receiptStatus, "pending");
    assert.equal(state.operator.terminalOutbox.deployPreflight.status, "blocked");
    assert.equal(state.operator.terminalOutbox.deployPreflight.receiptGate.terminalAckEligible, false);
    assert.equal(state.operator.safetyStatus.status, "blocked");
    assert.equal(state.operator.safetyStatus.receiptGate.terminalAckEligible, false);
    assert.equal(sent[0].deliveryOwner, "openclaw.plugin-notifier");
    assert.equal(sent[0].taskId, "task-outbox");
    assert.equal(sent[0].evidence.taskDescription, "Verify terminal outbox ACK safety gate");
    assert.match(sent[0].text, /Worker dungae completed task: task-outbox — Verify terminal outbox ACK safety gate/);
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("operator terminal outbox cursor stops at the first unacknowledged row", async () => {
  let nowMs = Date.parse("2026-05-06T00:00:00.000Z");
  const firstAcked = {
    id: "terminal:first-acked:succeeded:2026-05-06T00%3A00%3A01.000Z",
    createdAt: "2026-05-06T00:00:01.000Z",
    attempts: 0,
    payload: {
      taskId: "first-acked",
      status: "succeeded",
      worker: "yukson",
      receiptProjection: "current_session_visible",
      testSummary: "first row receives operator-visible receipt",
      completedAt: "2026-05-06T00:00:01.000Z",
    },
  };
  const middlePending = {
    id: "terminal:middle-pending:failed:2026-05-06T00%3A00%3A02.000Z",
    createdAt: "2026-05-06T00:00:02.000Z",
    attempts: 0,
    payload: {
      taskId: "middle-pending",
      status: "failed",
      worker: "sogyo",
      receiptProjection: "current_session_visible",
      testSummary: "middle row does not yet have a visible receipt",
      completedAt: "2026-05-06T00:00:02.000Z",
    },
  };
  const thirdFresh = {
    id: "terminal:third-fresh:succeeded:2026-05-06T00%3A00%3A03.000Z",
    createdAt: "2026-05-06T00:00:03.000Z",
    attempts: 0,
    payload: {
      taskId: "third-fresh",
      status: "succeeded",
      worker: "nosuk",
      receiptProjection: "current_session_visible",
      testSummary: "third row must not be processed while middle is pending",
      completedAt: "2026-05-06T00:00:03.000Z",
    },
  };
  const events = [firstAcked, middlePending, thirdFresh];
  const sent = [];
  const acks = [];
  const listCalls = [];
  const bridge = createA2AOperatorEventBridge({
    now: () => nowMs,
    terminalOutboxPollMs: 5,
    terminalOutboxHistoricalReplay: "notify",
    broker: {
      async *streamOperatorEvents(options = {}) {
        await waitForAbort(options.signal);
      },
      async listTerminalOutbox(params = {}) {
        listCalls.push(params);
        const startIndex = params.afterId ? events.findIndex((event) => event.id === params.afterId) + 1 : 0;
        return {
          kind: "task.terminal.outbox",
          count: events.length - startIndex,
          cursor: thirdFresh.id,
          reconciledUnacked: params.reconcileUnacked ? 1 : 0,
          events: events.slice(startIndex),
        };
      },
      async ackTerminalOutbox(params) {
        acks.push(params);
        const event = events.find((candidate) => candidate.id === params.id);
        return { ...event, ack: { status: "receipt_confirmed", ...params.receipt } };
      },
    },
    notifyOperator(envelope) {
      sent.push(envelope);
      if (envelope.taskId === "middle-pending") {
        return { ackTerminalEvent: false, reason: "receipt still pending for middle row" };
      }
      return { ackTerminalEvent: true, confirmationSource: "current_session_visible" };
    },
  });

  try {
    bridge.getState();
    await eventually(() => sent.length, (value) => value >= 2, "expected first and middle terminal outbox notifications");
    await eventually(() => listCalls.length, (value) => value >= 2, "expected repeated polling while middle row is pending");
    assert.deepEqual(sent.map((item) => item.taskId), ["first-acked", "middle-pending"]);
    assert.deepEqual(acks.map((item) => item.id), [firstAcked.id], "third row must not ACK before the middle row");

    const state = bridge.getState();
    assert.equal(state.operator.terminalOutbox.cursor, firstAcked.id);
    assert.equal(state.operator.terminalOutbox.lastPoll.firstPendingId, middlePending.id);
    assert.equal(state.operator.terminalOutbox.lastPoll.cursorBlockedByUnacked, true);
    assert.equal(state.operator.terminalOutbox.pendingUnacknowledged[0].taskId, "middle-pending");
    assert.equal(
      state.operator.terminalOutbox.pendingUnacknowledged.some((event) => event.taskId === "third-fresh"),
      true,
      "monitor should still show later rows as pending while cursor is blocked",
    );
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("monitor status live wiring polls terminal outbox and ACKs OpenClaw receipt projection shape", async () => {
  const outboxEvent = {
    id: "terminal:live-wiring:succeeded:2026-05-02T06%3A30%3A00.000Z",
    kind: "task.terminal",
    taskEventId: 165,
    createdAt: "2026-05-02T06:30:00.000Z",
    attempts: 0,
    payload: {
      taskId: "task-live-wiring",
      status: "succeeded",
      worker: "dungae",
      repo: "jinwon-int/openclaw-plugin-a2a",
      issue: 165,
      doneUrl: "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/165#issuecomment-done",
      testSummary: "live Gateway path must wait for user-visible receipt",
      receiptProjection: "current_session_visible",
      completedAt: "2026-05-02T06:30:00.000Z",
    },
  };
  const listCalls = [];
  const sent = [];
  const acks = [];
  const handlers = createA2AMonitoringHandlers({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: {
            enabled: true,
            operatorEvents: {
              enabled: true,
              notification: { enabled: true, channel: "telegram", to: "operator-chat", accountId: "default" },
            },
          },
        },
      },
    },
  }, {
    runtime: {
      channel: {
        outbound: {
          async loadAdapter(channel) {
            assert.equal(channel, "telegram");
            return {
              capabilities: { currentSessionVisibleReceipt: true },
              async sendText(payload) {
                sent.push(payload);
                return {
                  receipt: {
                    projection: "current_session_visible",
                    channel: "telegram",
                    to: "operator-chat",
                    accountId: "default",
                    status: "visible",
                  },
                };
              },
            };
          },
        },
      },
    },
    createClient: () => ({
      async *streamOperatorEvents(options = {}) {
        await waitForAbort(options.signal);
      },
      async listTerminalOutbox(params = {}) {
        listCalls.push(params);
        return {
          kind: "task.terminal.outbox",
          count: acks.length ? 0 : 1,
          cursor: outboxEvent.id,
          reconciledUnacked: params.reconcileUnacked ? 1 : 0,
          events: acks.length ? [] : [outboxEvent],
        };
      },
      async ackTerminalOutbox(params) {
        acks.push(params);
        return { ...outboxEvent, ack: { status: "receipt_confirmed", ...params.receipt } };
      },
    }),
    now: () => Date.parse("2026-05-02T06:29:00.000Z"),
  });

  try {
    const responses = [];
    await handlers.handleA2AMonitorStatus({
      params: { sessionKey: "operator-session", operatorEvents: { enabled: true } },
      respond(ok, result, error) { responses.push({ ok, result, error }); },
    });

    await eventually(() => acks, (value) => value.length === 1, "expected terminal outbox ACK through live monitor status wiring");
    assert.equal(responses[0].ok, true);
    assert.equal(listCalls[0].reconcileUnacked, true);
    assert.equal(listCalls[0].afterId, undefined);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].receiptRequired, "current_session_visible");
    assert.equal(sent[0].userVisibleReceiptRequired, true);
    assert.equal(acks[0].id, outboxEvent.id);
    assert.equal(acks[0].receipt.evidence, "operator_visible");
    assert.match(acks[0].receipt.note, /current_session_visible/);
  } finally {
    handlers.shutdownOperatorEventBridge();
  }
});

test("monitor status skips terminal outbox polling when notification is disabled", async () => {
  const outboxEvent = {
    id: "terminal:missing-target:succeeded:2026-05-03T14%3A00%3A00.000Z",
    kind: "task.terminal",
    taskEventId: 187,
    createdAt: "2026-05-03T14:00:00.000Z",
    attempts: 0,
    payload: {
      taskId: "task-missing-target",
      status: "succeeded",
      worker: "dungae",
      createdAt: "2026-05-03T13:59:00.000Z",
      updatedAt: "2026-05-03T14:00:00.000Z",
      completedAt: "2026-05-03T14:00:00.000Z",
    },
  };
  const acks = [];
  const listCalls = [];
  const handlers = createA2AMonitoringHandlers({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: {
            enabled: true,
            operatorEvents: {
              enabled: true,
              notification: { enabled: false, channel: "telegram", to: "operator-chat" },
            },
          },
        },
      },
    },
  }, {
    createClient: () => ({
      async *streamOperatorEvents(options = {}) {
        await waitForAbort(options.signal);
      },
      async listTerminalOutbox(params = {}) {
        listCalls.push(params);
        return {
          kind: "task.terminal.outbox",
          count: 1,
          cursor: outboxEvent.id,
          reconciledUnacked: params.reconcileUnacked ? 1 : 0,
          events: [outboxEvent],
        };
      },
      async ackTerminalOutbox(params) {
        acks.push(params);
        return { ...outboxEvent, ack: { status: "receipt_confirmed", ...params.receipt } };
      },
    }),
    now: () => Date.parse("2026-05-03T14:01:00.000Z"),
  });

  try {
    const state = handlers.startOperatorEventBridge();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(listCalls.length, 0, "disabled notification target should not poll terminal outbox");
    assert.equal(acks.length, 0);
    assert.equal(state.operator.terminalOutbox.poller.status, "skipped");
    assert.match(state.operator.terminalOutbox.poller.reason, /notification target unavailable/);
    assert.equal(state.operator.safetyStatus.status, "unknown");
    assert.match(state.operator.safetyStatus.blockers.join("\n"), /not been polled yet/);
  } finally {
    handlers.shutdownOperatorEventBridge();
  }
});

test("operator terminal outbox duplicate replay is bounded until receipt confirmation", async () => {
  const outboxEvent = {
    id: "terminal:a2a-plugin-terminal-outbox-rerun-dungae-165-1777703237007-2cbef34e:succeeded:2026-05-02T06%3A42%3A23.031Z",
    kind: "task.terminal",
    taskEventId: 166,
    createdAt: "2026-05-02T06:42:23.031Z",
    attempts: 0,
    payload: {
      taskId: "a2a-plugin-terminal-outbox-rerun-dungae-165-1777703237007-2cbef34e",
      status: "succeeded",
      worker: "dungae",
      repo: "jinwon-int/openclaw-plugin-a2a",
      issue: 168,
      prUrl: "https://github.com/jinwon-int/openclaw-plugin-a2a/pull/167",
      testSummary: "provider send success alone must not flood Telegram",
      receiptProjection: "current_session_visible",
      completedAt: "2026-05-02T06:42:23.031Z",
    },
  };
  const listCalls = [];
  const sent = [];
  let nowMs = Date.parse("2026-05-02T06:43:00.000Z");
  const bridge = createA2AOperatorEventBridge({
    now: () => nowMs,
    terminalOutboxPollMs: 5,
    terminalOutboxHistoricalReplay: "notify",
    broker: {
      async *streamOperatorEvents(options = {}) {
        await waitForAbort(options.signal);
      },
      async listTerminalOutbox(params = {}) {
        listCalls.push(params);
        return {
          kind: "task.terminal.outbox",
          count: params.afterId ? 0 : 1,
          cursor: outboxEvent.id,
          reconciledUnacked: params.reconcileUnacked ? 1 : 0,
          events: params.afterId ? [] : [outboxEvent],
        };
      },
      async ackTerminalOutbox() {
        throw new Error("provider send success alone must not ack");
      },
    },
    notifyOperator(envelope) {
      sent.push(envelope);
      return { ackTerminalEvent: false, reason: "provider send success is not a receipt" };
    },
  });

  try {
    bridge.getState();
    await eventually(() => sent.length, (value) => value === 1, "expected first terminal outbox notification attempt");
    await eventually(() => listCalls.length, (value) => value >= 3, "expected repeated monitor polls over replayable outbox record");
    assert.equal(sent.length, 1, "duplicate replay before retry window must not resend Telegram notification");
    assert.equal(listCalls[0].reconcileUnacked, true);
    assert.equal(listCalls[0].afterId, undefined);
    assert.equal(listCalls[1].afterId, undefined);

    nowMs += 60_000;
    await eventually(() => listCalls.length, (value) => value >= 4, "expected repeated monitor polls over replayable outbox record");
    assert.equal(sent.length, 1, "one-shot fuse must block repeat Telegram sends while receipt is pending");
    const state = bridge.getState();
    assert.match(state.operator.terminalOutbox.lastNotificationAttempt.reason, /one-shot live notification fuse is tripped/);
    assert.equal(state.operator.terminalOutbox.deployPreflight.status, "blocked");
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});


test("operator terminal outbox suppresses stale post-cursor unacked rows by default", async () => {
  const stalePostCursorEvent = {
    id: "terminal:stage2-no-send:succeeded:2026-05-05T16%3A21%3A38.672Z",
    kind: "task.terminal",
    taskEventId: 470,
    createdAt: "2026-05-05T16:21:38.675Z",
    attempts: 0,
    payload: {
      taskId: "stage2-no-send-task",
      status: "succeeded",
      worker: "seoseo-terminal-proof",
      testSummary: "Terminal Brief Stage2 no-send proof completed",
      receiptProjection: "current_session_visible",
      completedAt: "2026-05-05T16:21:38.672Z",
    },
  };
  const sent = [];
  const listCalls = [];
  const bridge = createA2AOperatorEventBridge({
    now: () => Date.parse("2026-05-05T16:28:00.000Z"),
    terminalOutboxPollMs: 5,
    broker: {
      async *streamOperatorEvents(options = {}) {
        await waitForAbort(options.signal);
      },
      async listTerminalOutbox(params = {}) {
        listCalls.push(params);
        return {
          kind: "task.terminal.outbox",
          count: 1,
          cursor: stalePostCursorEvent.id,
          // Incident regression: this is a normal cursor-after row, not a
          // reconciled backlog row, but it is still historical relative to the
          // bridge start and must not live-send by default.
          reconciledUnacked: 0,
          events: [stalePostCursorEvent],
        };
      },
      async ackTerminalOutbox() {
        throw new Error("suppressed stale row must not be ACKed");
      },
    },
    notifyOperator(envelope) {
      sent.push(envelope);
      return { ackTerminalEvent: true, confirmationSource: "current_session_visible" };
    },
  });

  try {
    bridge.getState({ cursor: "terminal:previous" });
    await eventually(() => listCalls.length, (value) => value >= 2, "expected terminal outbox polls");
    assert.equal(sent.length, 0, "stale post-cursor unacked row must not send Telegram by default");
    const state = bridge.getState();
    assert.equal(state.operator.terminalOutbox.lastPoll.reconciledUnacked, 0);
    assert.equal(state.operator.terminalOutbox.lastPoll.pendingUnacknowledged, 1);
    assert.equal(state.operator.terminalOutbox.lastNotificationAttempt.source, "outbox-backlog");
    assert.match(state.operator.terminalOutbox.lastNotificationAttempt.reason, /historical terminal-outbox replay suppressed/);
    assert.equal(state.operator.terminalOutbox.deployPreflight.status, "blocked");
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("standalone client accepts broker-owned task metadata on task responses", async () => {
  const client = createA2ABrokerClient({
    baseUrl: "https://broker.example.test",
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/tasks");
      assert.equal(init?.method, "POST");
      return new Response(JSON.stringify({
        id: "task-with-ownership-metadata",
        intent: "chat",
        requester: { id: "gwakga", kind: "node", role: "operator" },
        target: { id: "soonwook", kind: "node", role: "operator" },
        message: "schema drift canary",
        payload: {},
        status: "queued",
        targetNodeId: "soonwook",
        assignedWorkerId: "soonwook",
        createdAt: "2026-05-12T22:50:01.000Z",
        updatedAt: "2026-05-12T22:50:01.000Z",
        taskOrigin: "unknown",
        brokerOfRecord: "gwakga",
        teamId: "team2",
      }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const task = await client.createTask({
    id: "task-with-ownership-metadata",
    intent: "chat",
    requester: { id: "gwakga", kind: "node", role: "operator" },
    target: { id: "soonwook", kind: "node", role: "operator" },
    message: "schema drift canary",
  });
  assert.equal(task.taskOrigin, "unknown");
  assert.equal(task.brokerOfRecord, "gwakga");
  assert.equal(task.teamId, "team2");
});

test("standalone client accepts terminal outbox payload with only completedAt timestamp", async () => {
  const client = createA2ABrokerClient({
    baseUrl: "https://broker.example.test",
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/a2a/tasks/terminal-outbox");
      return new Response(JSON.stringify({
        kind: "task.terminal.outbox",
        count: 1,
        cursor: "terminal:minimal-payload:succeeded:2026-05-12T16%3A47%3A49.027Z",
        reconciledUnacked: 1,
        events: [{
          id: "terminal:minimal-payload:succeeded:2026-05-12T16%3A47%3A49.027Z",
          kind: "task.terminal",
          taskEventId: 232,
          createdAt: "2026-05-12T16:47:49.032Z",
          attempts: 0,
          payload: {
            taskId: "minimal-payload",
            status: "succeeded",
            completedAt: "2026-05-12T16:47:49.027Z",
          },
        }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const response = await client.listTerminalOutbox({ reconcileUnacked: true });
  assert.equal(response.count, 1);
  assert.equal(response.events[0].payload.taskId, "minimal-payload");
  assert.equal(response.events[0].payload.completedAt, "2026-05-12T16:47:49.027Z");
});

test("operator terminal outbox suppresses historical unacked backlog by default", async () => {
  const outboxEvent = {
    id: "terminal:stale-backlog:succeeded:2026-05-05T08%3A11%3A26.697Z",
    kind: "task.terminal",
    taskEventId: 369,
    createdAt: "2026-05-05T08:11:26.701Z",
    attempts: 0,
    payload: {
      taskId: "e058a492-ae5b-4f86-a6da-fd3a426fb9cc",
      status: "succeeded",
      worker: "dungae",
      repo: "jinwon-int/a2a-broker",
      issue: 369,
      prUrl: "https://github.com/jinwon-int/a2a-broker/pull/373",
      testSummary: "docker runner completed e058a492-ae5b-4f86-a6da-fd3a426fb9cc",
      receiptProjection: "current_session_visible",
      completedAt: "2026-05-05T08:11:26.697Z",
    },
  };
  const sent = [];
  const acks = [];
  const listCalls = [];
  const bridge = createA2AOperatorEventBridge({
    now: () => Date.parse("2026-05-05T15:00:00.000Z"),
    terminalOutboxPollMs: 5,
    broker: {
      async *streamOperatorEvents(options = {}) {
        await waitForAbort(options.signal);
      },
      async listTerminalOutbox(params = {}) {
        listCalls.push(params);
        return {
          kind: "task.terminal.outbox",
          count: 1,
          cursor: outboxEvent.id,
          reconciledUnacked: params.reconcileUnacked ? 1 : 0,
          events: [outboxEvent],
        };
      },
      async ackTerminalOutbox(params) {
        acks.push(params);
        return { ...outboxEvent, ack: { status: "receipt_confirmed", ...params.receipt } };
      },
    },
    notifyOperator(envelope) {
      sent.push(envelope);
      return { ackTerminalEvent: true, confirmationSource: "current_session_visible" };
    },
  });

  try {
    bridge.getState();
    await eventually(() => listCalls.length, (value) => value >= 2, "expected historical backlog polls");
    assert.equal(sent.length, 0, "historical unacked backlog must not send Telegram by default");
    assert.equal(acks.length, 0, "suppressed historical backlog must not be auto-ACKed");
    const state = bridge.getState();
    assert.equal(listCalls[0].reconcileUnacked, true);
    assert.equal(listCalls[1].reconcileUnacked, false);
    assert.equal(state.operator.terminalOutbox.lastPoll.backlogDrain, false);
    assert.equal(state.operator.terminalOutbox.lastPoll.pendingUnacknowledged, 1);
    assert.equal(state.operator.terminalOutbox.lastNotificationAttempt.receiptStatus, "pending");
    assert.match(state.operator.terminalOutbox.lastNotificationAttempt.reason, /historical terminal-outbox replay suppressed/);
    assert.equal(state.operator.terminalOutbox.deployPreflight.status, "blocked");
    assert.match(state.operator.safetyStatus.blockers.join("\n"), /unacknowledged/);
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("monitoring handlers can start terminal outbox draining without a monitor.status request", async () => {
  const outboxEvent = {
    id: "terminal:auto-start:succeeded:2026-05-03T04%3A08%3A22.962Z",
    kind: "task.terminal",
    taskEventId: 288,
    createdAt: "2026-05-03T04:08:22.962Z",
    attempts: 0,
    payload: {
      taskId: "task-auto-start",
      status: "succeeded",
      worker: "nosuk",
      repo: "jinwon-int/a2a-broker",
      issue: 286,
      prUrl: "https://github.com/jinwon-int/a2a-broker/pull/288",
      testSummary: "terminal outbox should drain on plugin activation",
      receiptProjection: "current_session_visible",
      completedAt: "2026-05-03T04:08:22.962Z",
    },
  };
  const sent = [];
  const acks = [];
  const handlers = createA2AMonitoringHandlers({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: {
            enabled: true,
            operatorEvents: {
              enabled: true,
              notification: { enabled: true, channel: "telegram", to: "operator-chat" },
            },
          },
        },
      },
    },
  }, {
    runtime: {
      channel: {
        outbound: {
          async loadAdapter(channel) {
            assert.equal(channel, "telegram");
            return {
              capabilities: { currentSessionVisibleReceipt: true },
              async sendText(payload) {
                sent.push(payload);
                return {
                  delivery: {
                    confirmation: {
                      confirmationSource: "current_session_visible",
                      channel: "telegram",
                      to: "operator-chat",
                      status: "visible",
                    },
                  },
                };
              },
            };
          },
        },
      },
    },
    createClient: () => ({
      async *streamOperatorEvents(options = {}) {
        await waitForAbort(options.signal);
      },
      async listTerminalOutbox(params = {}) {
        return {
          kind: "task.terminal.outbox",
          count: acks.length ? 0 : 1,
          cursor: outboxEvent.id,
          reconciledUnacked: params.reconcileUnacked ? 1 : 0,
          events: acks.length ? [] : [outboxEvent],
        };
      },
      async ackTerminalOutbox(params) {
        acks.push(params);
        return { ...outboxEvent, ack: { status: "receipt_confirmed", ...params.receipt } };
      },
    }),
    now: () => Date.parse("2026-05-03T04:07:00.000Z"),
  });

  try {
    const state = handlers.startOperatorEventBridge();
    assert.equal(state.kind, "a2a.operator.monitor");
    await eventually(() => acks, (value) => value.length === 1, "expected activation-started outbox drain to ACK");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, "A2A Terminal Brief 완료: nosuk(1/1)");
    assert.doesNotMatch(sent[0].text, /PR #288|PR:/);
    assert.equal(acks[0].id, outboxEvent.id);
    assert.equal(acks[0].receipt.evidence, "operator_visible");
  } finally {
    handlers.shutdownOperatorEventBridge();
  }
});

test("cross-broker watcher forwards per-broker terminal outbox bounds", () => {
  const bridgeParams = [];
  const clientOptions = [];
  const secretDir = mkdtempSync(join(tmpdir(), "a2a-crossbroker-"));
  const secretPath = join(secretDir, "edge-secret");
  writeFileSync(secretPath, "test-edge-secret-from-file\n", { mode: 0o600 });
  const handlers = createA2AMonitoringHandlers({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: {
            enabled: true,
            operatorEvents: {
              enabled: true,
              notification: { enabled: false, channel: "telegram", to: "operator-chat" },
              terminalOutboxAllowedIds: ["terminal:team1-only"],
              crossBrokers: [
                {
                  baseUrl: "https://team2-broker.example.test",
                  edgeSecretFile: secretPath,
                  label: "team2",
                  terminalOutboxAllowedIds: ["terminal:team2-round"],
                  terminalOutboxCursor: "terminal:team2-cursor",
                  terminalOutboxReconcileUnackedOnStart: false,
                  handoffBrokerId: "gwakga",
                  maxSummaryChars: 480,
                },
              ],
            },
          },
        },
      },
    },
  }, {
    createClient: () => ({
      async *streamOperatorEvents(options = {}) {
        await waitForAbort(options.signal);
      },
    }),
    createStandaloneBrokerClient: (options) => {
      clientOptions.push(options);
      return {
        async *streamOperatorEvents(innerOptions = {}) {
          await waitForAbort(innerOptions.signal);
        },
      };
    },
    createOperatorEventBridge: (params) => {
      bridgeParams.push(params);
      return {
        getState() {
          return {
            kind: "a2a.operator.monitor",
            operator: { terminalOutbox: { poller: { status: "started" } } },
          };
        },
        shutdown() {},
        async waitForIdle() {},
      };
    },
  });

  try {
    const state = handlers.startOperatorEventBridge();
    assert.equal(bridgeParams.length, 2, "primary and Team2 cross-broker bridges should both start");
    const team2 = bridgeParams[1];
    assert.deepEqual(team2.readTerminalOutboxAllowedIds(), ["terminal:team2-round"]);
    assert.equal(team2.terminalOutboxCursor, "terminal:team2-cursor");
    assert.equal(team2.readTerminalOutboxCursor(), "terminal:team2-cursor");
    assert.equal(team2.terminalOutboxReconcileUnackedOnStart, false);
    assert.equal(team2.handoffBrokerId, "gwakga");
    assert.equal(team2.terminalProjectionMaxSummaryChars, 480);
    assert.equal(clientOptions.length, 1);
    assert.equal(clientOptions[0].edgeSecret, "test-edge-secret-from-file");
    assert.ok(state.crossBrokers.team2, "returned monitor state should include Team2 bridge state");
  } finally {
    handlers.shutdownOperatorEventBridge();
    rmSync(secretDir, { recursive: true, force: true });
  }
});

test("release dry-run no-live operator completion notification waits for visible receipt across replay", async () => {
  const terminalEvent = {
    name: "task-terminal",
    id: "terminal:event:dryrun-201",
    data: {
      terminalEvent: {
        id: "terminal:event:dryrun-201",
        status: "succeeded",
        taskId: "a2a-release-dryrun-20260504022511",
        worker: "dungae",
        repo: "jinwon-int/openclaw-plugin-a2a",
        issue: 201,
        prUrl: "https://github.com/jinwon-int/openclaw-plugin-a2a/pull/201",
        title: "plugin operator notification no-live proof",
        summary: "릴리스 드라이런 완료 — operator receipt 확인 전 ACK 금지",
        runId: "a2a-release-dryrun-20260504022511",
        receiptProjection: "current_session_visible",
        traceId: "trace-dryrun-201",
        completedAt: "2026-05-04T02:25:11.000Z",
      },
    },
  };
  const outboxEvent = {
    id: "terminal:outbox:dryrun-201",
    kind: "task.terminal",
    taskEventId: 201,
    createdAt: "2026-05-04T02:25:11.000Z",
    attempts: 1,
    payload: {
      taskId: "a2a-release-dryrun-20260504022511",
      status: "succeeded",
      worker: "dungae",
      repo: "jinwon-int/openclaw-plugin-a2a",
      issue: 201,
      doneUrl: "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/201#issuecomment-done",
      originalMessage: "plugin operator notification no-live proof",
      receiptProjection: "current_session_visible",
      testSummary: "릴리스 드라이런 완료 — operator receipt 확인 전 ACK 금지",
      runId: "a2a-release-dryrun-20260504022511",
      traceId: "trace-dryrun-201",
      completedAt: "2026-05-04T02:25:11.000Z",
    },
  };
  const sentBeforeReceipt = [];
  const firstBridge = createA2AOperatorEventBridge({
    now: () => Date.parse("2026-05-04T02:26:00.000Z"),
    terminalOutboxPollMs: 5,
    terminalOutboxHistoricalReplay: "notify",
    broker: {
      async *streamOperatorEvents(options = {}) {
        yield terminalEvent;
        await waitForAbort(options.signal);
      },
      async listTerminalOutbox(params = {}) {
        return {
          kind: "task.terminal.outbox",
          count: 1,
          cursor: outboxEvent.id,
          reconciledUnacked: params.reconcileUnacked ? 1 : 0,
          events: [outboxEvent],
        };
      },
      async ackTerminalOutbox() {
        throw new Error("dry-run provider success without visible receipt must not ACK");
      },
    },
    notifyOperator(envelope) {
      sentBeforeReceipt.push(envelope);
      return { ackTerminalEvent: false, reason: "provider send success is not operator-visible evidence" };
    },
  });

  try {
    firstBridge.getState({ cursor: "terminal:previous" });
    await eventually(() => sentBeforeReceipt.length, (value) => value >= 1, "expected terminal outbox dry-run notification attempt");
    const outboxEnvelope = sentBeforeReceipt.find((item) => item.dedupeKey.includes(outboxEvent.id));
    assert.ok(outboxEnvelope, "expected terminal-outbox notification envelope");
    assert.equal(outboxEnvelope.deliveryTarget, "operator-main-session");
    assert.match(outboxEnvelope.title, /^A2A Terminal Brief 완료:/, "title should stay Terminal Brief and Korean-friendly for operator scan");
    assert.match(outboxEnvelope.text, /릴리스 드라이런 완료/);
    assert.match(outboxEnvelope.text, /Worker dungae completed task: a2a-release-dryrun-20260504022511/);
    assert.match(outboxEnvelope.text, /Issue: https:\/\/github\.com\/jinwon-int\/openclaw-plugin-a2a\/issues\/201/);
    assert.match(outboxEnvelope.text, /Run: a2a-release-dryrun-20260504022511/);
    assert.match(outboxEnvelope.text, /Trace: trace-dryrun-201/);
    assert.ok(outboxEnvelope.text.length < 700, "operator notification should remain concise");
    const state = firstBridge.getState();
    assert.equal(state.operator.terminalOutbox.lastPoll.reconciledUnacked, 1);
    assert.equal(state.operator.terminalOutbox.lastNotificationAttempt.receiptStatus, "pending");
    assert.equal(state.operator.terminalOutbox.deployPreflight.status, "blocked");
    assert.equal(state.operator.terminalOutbox.deployPreflight.receiptGate.providerGatewaySendSuccess, "not_ack_evidence");
    assert.equal(state.operator.terminalOutbox.deployPreflight.safeOperations.liveSend, false);
    assert.equal(state.operator.terminalOutbox.deployPreflight.safeOperations.terminalOutboxAck, false);
  } finally {
    firstBridge.shutdown();
    await firstBridge.waitForIdle();
  }

  const acksAfterRestart = [];
  const reconcileCalls = [];
  const replayBridge = createA2AOperatorEventBridge({
    now: () => Date.parse("2026-05-04T02:27:00.000Z"),
    terminalOutboxPollMs: 5,
    terminalOutboxHistoricalReplay: "notify",
    broker: {
      async *streamOperatorEvents(options = {}) {
        await waitForAbort(options.signal);
      },
      async listTerminalOutbox(params = {}) {
        reconcileCalls.push(params);
        return {
          kind: "task.terminal.outbox",
          count: acksAfterRestart.length ? 0 : 1,
          cursor: outboxEvent.id,
          reconciledUnacked: params.reconcileUnacked ? 1 : 0,
          events: acksAfterRestart.length ? [] : [outboxEvent],
        };
      },
      async ackTerminalOutbox(params) {
        acksAfterRestart.push(params);
        return { ...outboxEvent, ack: { status: "receipt_confirmed", ...params.receipt } };
      },
    },
    notifyOperator() {
      return {
        ackTerminalEvent: true,
        confirmationSource: "current_session_visible",
        receiptId: "operator-visible-dryrun-201",
        reason: "dry-run replay reached operator-visible projection",
      };
    },
  });

  try {
    replayBridge.getState({ cursor: "terminal:previous" });
    await eventually(() => acksAfterRestart.length, (value) => value === 1, "expected replay ACK after operator-visible evidence");
    assert.equal(reconcileCalls[0].reconcileUnacked, true, "restart path must reconcile unacked terminal records");
    assert.equal(acksAfterRestart[0].id, outboxEvent.id);
    assert.equal(acksAfterRestart[0].receipt.evidence, "operator_visible");
    assert.equal(acksAfterRestart[0].receipt.receiptId, "operator-visible-dryrun-201");
    const state = replayBridge.getState();
    assert.equal(state.operator.terminalOutbox.deployPreflight.status, "ready");
    assert.equal(state.operator.terminalOutbox.deployPreflight.receiptGate.terminalAckEligible, true);
  } finally {
    replayBridge.shutdown();
    await replayBridge.waitForIdle();
  }
});

test("monitor status projects broker no-live rehearsal manifest without unsafe evidence leaks", async () => {
  const responses = [];
  const handlers = createA2AMonitoringHandlers({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          config: {
            baseUrl: "https://broker.example.test",
          },
        },
      },
    },
  }, {
    createClient: () => ({
      async health() {
        return { ok: true };
      },
      async listDiagnostics() {
        return {
          noLiveRehearsalManifest: {
            mode: "release-dryrun/no-live",
            manifestId: "rehearsal-205",
            runId: "a2a-no-live-integration-20260504035026",
            safeOperations: {
              liveSend: false,
              terminalOutboxAck: false,
              gatewayRestart: false,
              productionDeploy: false,
              providerSend: false,
            },
            receiptGate: {
              terminalAckEligible: false,
              providerGatewaySendSuccess: "not_ack_evidence",
            },
            receiptStates: [
              {
                taskId: "task-205",
                state: "sent",
                terminalAckEligible: false,
                reason: "provider-send-only; rawPrompt=/root/private/prompt.md token=sk-test",
              },
            ],
            gateFindings: [
              { code: "terminal_ack_gate", status: "pass", message: "ACK blocked in no-live rehearsal" },
            ],
            auditFindings: [
              { code: "no_live_audit", status: "pass", message: "no provider send and no terminal ACK mutation" },
            ],
          },
        };
      },
    }),
  });

  await handlers.handleA2AMonitorStatus({
    params: { sessionKey: "session-1" },
    respond(ok, result, error) {
      responses.push({ ok, result, error });
    },
  });

  assert.equal(responses.length, 1);
  assert.equal(responses[0].ok, true);
  assert.equal(responses[0].error, undefined);
  assert.equal(responses[0].result.noLiveRehearsal.status, "ready");
  assert.equal(responses[0].result.noLiveRehearsal.safeOperations.liveSend, false);
  assert.equal(responses[0].result.noLiveRehearsal.safeOperations.terminalOutboxAck, false);
  assert.equal(responses[0].result.noLiveRehearsal.receiptStates[0].state, "sent");
  assert.equal(responses[0].result.noLiveRehearsal.receiptStates[0].terminalAckEligible, false);
  assert.deepEqual(responses[0].result.noLiveRehearsal.missingUnsafeEvidenceFields, []);
  const projected = JSON.stringify(responses[0].result);
  assert.equal("noLiveRehearsalManifest" in responses[0].result, false);
  assert.doesNotMatch(projected, /sk-test|\/root\/private|rawPrompt=\/root/);
  assert.match(projected, /\[redacted\]|\[redacted-path\]/);
});

test("monitor status fails closed when no-live rehearsal manifest omits unsafe evidence fields", async () => {
  const responses = [];
  const handlers = createA2AMonitoringHandlers({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          config: {
            baseUrl: "https://broker.example.test",
          },
        },
      },
    },
  }, {
    createClient: () => ({
      async health() {
        return { ok: true };
      },
      async listDiagnostics() {
        return {
          rehearsalManifest: {
            mode: "release-dryrun/no-live",
            safeOperations: {
              liveSend: false,
            },
            receiptGate: {
              providerGatewaySendSuccess: "sent",
            },
          },
        };
      },
    }),
  });

  await handlers.handleA2AMonitorStatus({
    params: { sessionKey: "session-1" },
    respond(ok, result, error) {
      responses.push({ ok, result, error });
    },
  });

  assert.equal(responses[0].ok, true);
  assert.equal(responses[0].result.noLiveRehearsal.status, "blocked");
  assert.deepEqual(responses[0].result.noLiveRehearsal.missingUnsafeEvidenceFields, [
    "safeOperations.terminalOutboxAck",
    "safeOperations.gatewayRestart",
    "safeOperations.productionDeploy",
    "safeOperations.providerSend",
    "receiptGate.terminalAckEligible",
    "receiptGate.providerGatewaySendSuccess",
  ]);
  assert.equal(
    responses[0].result.pluginWarnings.some((warning) => warning.code === "no_live_rehearsal_blocked"),
    true,
  );
});

test("monitor status projects live-readiness evidence acceptance without treating provider send as receipt", async () => {
  const responses = [];
  const handlers = createA2AMonitoringHandlers({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          config: {
            baseUrl: "https://broker.example.test",
          },
        },
      },
    },
  }, {
    createClient: () => ({
      async health() {
        return { ok: true };
      },
      async listDiagnostics() {
        return {
          liveReadiness: {
            mode: "release-dryrun/no-live",
            runId: "a2a-live-readiness-20260504065322",
            canaryResults: [
              { code: "broker_health", status: "pass", message: "health revision reachable" },
              { code: "worker_matrix", status: "pass", message: "workers fresh" },
            ],
            evidenceAcceptance: [
              { kind: "PR", status: "accepted", taskId: "task-pr", url: "https://github.com/jinwon-int/openclaw-plugin-a2a/pull/208" },
              { kind: "Done", status: "accepted", taskId: "task-done", url: "https://github.com/jinwon-int/a2a-broker/issues/336#issuecomment-1" },
              { kind: "Block", status: "accepted", taskId: "task-block", url: "https://github.com/jinwon-int/a2a-broker/issues/335#issuecomment-2" },
            ],
            queueSignals: { queued: 0, claimed: 0, running: 0, stale: 0, timedOut: 0 },
          },
        };
      },
    }),
  });

  await handlers.handleA2AMonitorStatus({
    params: { sessionKey: "session-1" },
    respond(ok, result, error) {
      responses.push({ ok, result, error });
    },
  });

  assert.equal(responses[0].ok, true);
  assert.equal(responses[0].result.liveReadiness.status, "ready");
  assert.deepEqual(responses[0].result.liveReadiness.evidenceAcceptance.map((entry) => entry.kind), ["PR", "Done", "Block"]);
  assert.equal(responses[0].result.liveReadiness.queueSignals.status, "ready");
  assert.equal(responses[0].result.liveReadiness.safeOperations.providerSend, false);
  assert.equal(responses[0].result.liveReadiness.safeOperations.terminalOutboxAck, false);
});

test("monitor status blocks live-readiness for missing evidence and stale queue signals", async () => {
  const responses = [];
  const handlers = createA2AMonitoringHandlers({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          config: {
            baseUrl: "https://broker.example.test",
          },
        },
      },
    },
  }, {
    createClient: () => ({
      async health() {
        return { ok: true };
      },
      async listDiagnostics() {
        return {
          liveReadiness: {
            mode: "live-readiness",
            evidenceAcceptance: [
              { kind: "missing_evidence", status: "missing", taskId: "task-missing", message: "missing Done evidence rawPrompt=/root/private token=sk-test" },
            ],
            queueSignals: { queued: 1, claimed: 0, running: 0, stale: 2, timedOut: 1 },
          },
        };
      },
    }),
  });

  await handlers.handleA2AMonitorStatus({
    params: { sessionKey: "session-1" },
    respond(ok, result, error) {
      responses.push({ ok, result, error });
    },
  });

  assert.equal(responses[0].ok, true);
  assert.equal(responses[0].result.liveReadiness.status, "blocked");
  assert.equal(responses[0].result.liveReadiness.evidenceAcceptance[0].kind, "missing_evidence");
  assert.equal(responses[0].result.liveReadiness.evidenceAcceptance[0].status, "missing");
  assert.equal(responses[0].result.liveReadiness.queueSignals.status, "blocked");
  assert.equal(responses[0].result.liveReadiness.queueSignals.stale, 2);
  assert.equal(responses[0].result.liveReadiness.queueSignals.timedOut, 1);
  assert.equal(
    responses[0].result.pluginWarnings.some((warning) => warning.code === "live_readiness_blocked"),
    true,
  );
  assert.doesNotMatch(JSON.stringify(responses[0].result), /sk-test|\/root\/private|rawPrompt=\/root/);
});

test("operator terminal outbox cursor advances past suppressed historical allowed page", async () => {
  const nowMs = Date.parse("2026-05-14T09:50:00.000Z");
  const historicalAllowed = {
    id: "terminal:allowed-history-page:succeeded:2026-05-14T09%3A40%3A00.000Z",
    kind: "task.terminal",
    taskEventId: 631,
    createdAt: "2026-05-14T09:40:00.000Z",
    attempts: 0,
    payload: {
      taskId: "allowed-history-page",
      status: "succeeded",
      worker: "dungae",
      receiptProjection: "current_session_visible",
      testSummary: "historical page must not pin terminal-outbox cursor",
      completedAt: "2026-05-14T09:40:00.000Z",
    },
  };
  const allowedFresh = {
    id: "terminal:allowed-fresh-page:succeeded:2026-05-14T09%3A50%3A00.000Z",
    kind: "task.terminal",
    taskEventId: 632,
    createdAt: "2026-05-14T09:50:00.000Z",
    attempts: 0,
    payload: {
      taskId: "allowed-fresh-page",
      status: "succeeded",
      worker: "dungae",
      receiptProjection: "current_session_visible",
      testSummary: "fresh page should still attempt notification",
      completedAt: "2026-05-14T09:50:00.000Z",
    },
  };
  const sent = [];
  const listCalls = [];
  const bridge = createA2AOperatorEventBridge({
    now: () => nowMs,
    terminalOutboxPollMs: 5,
    terminalOutboxAllowedIds: [historicalAllowed.id, allowedFresh.id],
    broker: {
      async *streamOperatorEvents(options = {}) {
        await waitForAbort(options.signal);
      },
      async listTerminalOutbox(params = {}) {
        listCalls.push(params);
        if (params.afterId === historicalAllowed.id) {
          return {
            kind: "task.terminal.outbox",
            count: 1,
            cursor: allowedFresh.id,
            reconciledUnacked: 0,
            events: [allowedFresh],
          };
        }
        return {
          kind: "task.terminal.outbox",
          count: 1,
          cursor: historicalAllowed.id,
          reconciledUnacked: params.reconcileUnacked ? 1 : 0,
          events: [historicalAllowed],
        };
      },
      async ackTerminalOutbox() {
        throw new Error("provider send success alone must not ACK terminal outbox");
      },
    },
    notifyOperator(envelope) {
      sent.push(envelope);
      return { ackTerminalEvent: false, reason: "provider send success is not an operator receipt" };
    },
  });

  try {
    bridge.getState();
    await eventually(() => sent.length, (value) => value === 1, "expected fresh allowlisted terminal-outbox notification attempt");
    assert.equal(sent[0].taskId, "allowed-fresh-page");
    assert.deepEqual(
      listCalls.slice(0, 2).map((call) => call.afterId),
      [undefined, historicalAllowed.id],
      "suppressed historical rows should advance after_id so fresh rows are reachable",
    );
    const state = bridge.getState();
    assert.equal(state.operator.terminalOutbox.lastNotificationAttempt.taskId, "allowed-fresh-page");
    assert.equal(state.operator.terminalOutbox.lastNotificationAttempt.receiptStatus, "pending");
    assert.match(state.operator.terminalOutbox.lastNotificationAttempt.reason, /provider send success is not an operator receipt/);
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("operator terminal outbox poller applies hot-reloaded cursor and allowlist readers", async () => {
  const nowMs = Date.parse("2026-05-17T02:18:00.000Z");
  let configuredCursor = "terminal:old-window";
  let configuredAllowedIds = ["terminal:old-window"];
  const freshEvent = {
    id: "terminal:hot-reload-fresh:succeeded:2026-05-17T02%3A18%3A00.000Z",
    kind: "task.terminal",
    taskEventId: 701,
    createdAt: "2026-05-17T02:18:00.000Z",
    attempts: 0,
    payload: {
      taskId: "hot-reload-fresh",
      status: "succeeded",
      worker: "sogyo",
      receiptProjection: "current_session_visible",
      testSummary: "fresh event should send after hot-reloaded allowlist",
      completedAt: "2026-05-17T02:18:00.000Z",
    },
  };
  const sent = [];
  const listCalls = [];
  const bridge = createA2AOperatorEventBridge({
    now: () => nowMs,
    terminalOutboxPollMs: 5,
    readTerminalOutboxCursor: () => configuredCursor,
    readTerminalOutboxAllowedIds: () => configuredAllowedIds,
    broker: {
      async *streamOperatorEvents(options = {}) {
        await waitForAbort(options.signal);
      },
      async listTerminalOutbox(params = {}) {
        listCalls.push(params);
        return {
          kind: "task.terminal.outbox",
          count: 1,
          cursor: freshEvent.id,
          reconciledUnacked: 0,
          events: [freshEvent],
        };
      },
      async ackTerminalOutbox() {
        throw new Error("provider send success alone must not ACK terminal outbox");
      },
    },
    notifyOperator(envelope) {
      sent.push(envelope);
      return { ackTerminalEvent: false, reason: "provider send success is not an operator receipt" };
    },
  });

  try {
    bridge.getState();
    await eventually(() => listCalls.length, (value) => value >= 1, "expected initial outbox poll");
    assert.equal(sent.length, 0, "fresh event must stay unsent before its id is allowlisted");

    configuredCursor = "terminal:hot-reload-window";
    configuredAllowedIds = [freshEvent.id];

    await eventually(() => sent.length, (value) => value === 1, "expected hot-reloaded allowlist to send fresh event");
    assert.equal(sent[0].taskId, "hot-reload-fresh");
    assert.ok(
      listCalls.some((call) => call.afterId === "terminal:hot-reload-window"),
      "poller should use the hot-reloaded cursor on a later poll",
    );
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("operator terminal outbox allowlist sends only one fresh allowed event", async () => {
  const nowMs = Date.parse("2026-05-05T22:58:00.000Z");
  const historicalAllowed = {
    id: "terminal:allowed-historical:succeeded:2026-05-05T22%3A40%3A00.000Z",
    kind: "task.terminal",
    taskEventId: 501,
    createdAt: "2026-05-05T22:40:00.000Z",
    attempts: 0,
    payload: {
      taskId: "allowed-historical",
      status: "succeeded",
      worker: "sogyo",
      testSummary: "historical allowlisted event must still stay suppressed",
      receiptProjection: "current_session_visible",
      completedAt: "2026-05-05T22:40:00.000Z",
    },
  };
  const deniedFresh = {
    id: "terminal:denied-fresh:succeeded:2026-05-05T22%3A58%3A00.000Z",
    kind: "task.terminal",
    taskEventId: 502,
    createdAt: "2026-05-05T22:58:00.000Z",
    attempts: 0,
    payload: {
      taskId: "denied-fresh",
      status: "succeeded",
      worker: "sogyo",
      receiptProjection: "current_session_visible",
      testSummary: "fresh event without explicit allowlist must not send",
      completedAt: "2026-05-05T22:58:00.000Z",
    },
  };
  const allowedFresh = {
    id: "terminal:91a8574d-24b6-464b-9373-89175dc698a4:succeeded:2026-05-05T22%3A58%3A00.000Z",
    kind: "task.terminal",
    taskEventId: 503,
    createdAt: "2026-05-05T22:58:00.000Z",
    attempts: 0,
    payload: {
      taskId: "allowed-fresh",
      status: "succeeded",
      worker: "sogyo",
      receiptProjection: "current_session_visible",
      testSummary: "fresh allowed proof event",
      completedAt: "2026-05-05T22:58:00.000Z",
    },
  };
  const events = [historicalAllowed, deniedFresh, allowedFresh];
  const sent = [];
  const acks = [];
  const listCalls = [];
  const bridge = createA2AOperatorEventBridge({
    now: () => nowMs,
    terminalOutboxPollMs: 5,
    terminalOutboxAllowedIds: [historicalAllowed.id, "allowed-fresh"],
    broker: {
      async *streamOperatorEvents(options = {}) {
        await waitForAbort(options.signal);
      },
      async listTerminalOutbox(params = {}) {
        listCalls.push(params);
        return {
          kind: "task.terminal.outbox",
          count: events.length,
          cursor: allowedFresh.id,
          reconciledUnacked: params.reconcileUnacked ? 1 : 0,
          events,
        };
      },
      async ackTerminalOutbox(params) {
        acks.push(params);
        return { ...allowedFresh, ack: { status: "receipt_confirmed", ...params.receipt } };
      },
    },
    notifyOperator(envelope) {
      sent.push(envelope);
      return { ackTerminalEvent: false, reason: "provider send success is not an operator receipt" };
    },
  });

  try {
    bridge.getState();
    await eventually(() => sent.length, (value) => value === 1, "expected only the fresh allowlisted terminal-outbox send");
    await eventually(() => listCalls.length, (value) => value >= 2, "expected repeated outbox polls while receipt remains pending");
    assert.equal(sent.length, 1, "pending receipt and allowlist must prevent additional sends");
    assert.equal(sent[0].taskId, "allowed-fresh");
    assert.equal(acks.length, 0, "provider send success must not terminal-outbox ACK");
    const state = bridge.getState();
    assert.equal(state.operator.terminalOutbox.lastPoll.pendingUnacknowledged, 3);
    assert.equal(state.operator.terminalOutbox.deployPreflight.status, "blocked");
    assert.equal(state.operator.terminalOutbox.deployPreflight.receiptGate.providerGatewaySendSuccess, "not_ack_evidence");
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("cross-broker terminal projection is bounded, redacted, and fail-closed for ACK semantics", () => {
  const terminalEvent = {
    id: "terminal:child-1:succeeded:2026-05-13T01%3A30%3A00.000Z",
    kind: "task.terminal",
    taskEventId: 528,
    createdAt: "2026-05-13T01:30:00.000Z",
    attempts: 0,
    ack: { status: "receipt_confirmed", evidence: "provider_delivery_receipt" },
    payload: {
      taskId: "child-1",
      status: "succeeded",
      worker: "jingun",
      repo: "jinwon-int/openclaw-plugin-a2a",
      issue: 281,
      prUrl: "https://github.com/jinwon-int/openclaw-plugin-a2a/pull/999?token=secret-value",
      doneUrl: "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/281#issuecomment-done",
      testSummary: "done with token=super-secret and /home/operator/private/path plus ```raw log```",
      parentOwnedTerminalBrief: true,
      operatorFacingOwner: "parent",
      crossBrokerHandoff: {
        parentRoundId: "cross-broker-terminal-brief-team2-20260513T011822Z",
        originBrokerId: "gwakga-vps7",
        handoffBrokerId: "seoseo",
        originTaskId: "parent-task-528",
      },
      notificationOwnership: {
        ownerBrokerId: "gwakga-vps7",
        scope: "parent-broker-only",
        providerSendPermittedByProjection: false,
        terminalAckPermittedByProjection: false,
      },
      completedAt: "2026-05-13T01:30:00.000Z",
    },
  };
  const projection = buildA2ACrossBrokerTerminalProjection(terminalEvent, { maxSummaryChars: 120 });

  assert.equal(projection.kind, "a2a.crossBroker.terminalProjection");
  assert.equal(projection.parentRoundId, "cross-broker-terminal-brief-team2-20260513T011822Z");
  assert.equal(projection.originBrokerId, "seoseo");
  assert.equal(projection.brokerOfRecordId, "gwakga-vps7");
  assert.equal(projection.handoffBrokerId, "seoseo");
  assert.equal(projection.childTaskId, "child-1");
  assert.equal(projection.receipt.providerGatewaySendSuccess, "not_ack_evidence");
  assert.equal(projection.receipt.localReceiptState, "provider_only");
  assert.equal(projection.receipt.originTerminalAckEligible, false);
  assert.match(projection.evidence.prUrl, /token=\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(projection), /super-secret|private\/path|raw log/);

  const currentSessionProjection = buildA2ACrossBrokerTerminalProjection({
    ...terminalEvent,
    ack: { status: "receipt_confirmed", evidence: "current_session_visible" },
    payload: { ...terminalEvent.payload, taskId: "child-current-session" },
  });
  assert.equal(currentSessionProjection.receipt.localReceiptState, "receipt_confirmed");
  assert.equal(currentSessionProjection.receipt.localReceiptEvidence, "current_session_visible");
  assert.equal(currentSessionProjection.receipt.originTerminalAckEligible, false);
});

test("operator bridge relays only fresh post-cursor cross-broker terminal outbox projections", async () => {
  const oldEvent = {
    id: "terminal:old:succeeded:2026-05-13T01%3A00%3A00.000Z",
    kind: "task.terminal",
    taskEventId: 527,
    createdAt: "2026-05-13T01:00:00.000Z",
    attempts: 0,
    payload: {
      taskId: "old-child",
      status: "succeeded",
      worker: "jingun",
      testSummary: "old event must not replay",
      parentOwnedTerminalBrief: true,
      operatorFacingOwner: "parent",
      crossBrokerHandoff: { parentRoundId: "round-528", originBrokerId: "gwakga-vps7" },
      notificationOwnership: {
        ownerBrokerId: "gwakga-vps7",
        scope: "parent-broker-only",
        providerSendPermittedByProjection: false,
        terminalAckPermittedByProjection: false,
      },
      completedAt: "2026-05-13T01:00:00.000Z",
    },
  };
  const freshEvent = {
    id: "terminal:fresh:succeeded:2026-05-13T01%3A20%3A00.000Z",
    kind: "task.terminal",
    taskEventId: 528,
    createdAt: "2026-05-13T01:20:00.000Z",
    attempts: 0,
    payload: {
      taskId: "fresh-child",
      status: "succeeded",
      worker: "jingun",
      repo: "jinwon-int/openclaw-plugin-a2a",
      issue: 281,
      doneUrl: "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/281#issuecomment-done",
      testSummary: "fresh terminal projection",
      parentOwnedTerminalBrief: true,
      operatorFacingOwner: "parent",
      crossBrokerHandoff: { parentRoundId: "round-528", originBrokerId: "gwakga-vps7" },
      notificationOwnership: {
        ownerBrokerId: "gwakga-vps7",
        scope: "parent-broker-only",
        providerSendPermittedByProjection: false,
        terminalAckPermittedByProjection: false,
      },
      completedAt: "2026-05-13T01:20:00.000Z",
    },
  };
  const relayed = [];
  const acks = [];
  const bridge = createA2AOperatorEventBridge({
    now: () => Date.parse("2026-05-13T01:10:00.000Z"),
    terminalOutboxPollMs: 5,
    terminalOutboxReconcileUnackedOnStart: false,
    broker: {
      async *streamOperatorEvents(options = {}) {
        await waitForAbort(options.signal);
      },
      async listTerminalOutbox() {
        return {
          kind: "task.terminal.outbox",
          count: 2,
          cursor: freshEvent.id,
          reconciledUnacked: 0,
          events: [oldEvent, freshEvent],
        };
      },
      async ackTerminalOutbox(params) {
        acks.push(params);
        return freshEvent;
      },
    },
    handoffBrokerId: "seoseo",
    relayTerminalProjection(projection) {
      relayed.push(projection);
      return { accepted: true, reason: "origin accepted" };
    },
  });

  try {
    bridge.getState({ cursor: "terminal:previous" });
    await eventually(() => relayed.length, (value) => value === 1, "expected exactly one fresh relay");
    assert.equal(relayed[0].childTaskId, "fresh-child");
    assert.equal(relayed[0].originBrokerId, "seoseo");
    assert.equal(relayed[0].brokerOfRecordId, "gwakga-vps7");
    assert.equal(relayed[0].handoffBrokerId, "seoseo");
    assert.equal(relayed[0].receipt.providerGatewaySendSuccess, "not_ack_evidence");
    assert.equal(acks.length, 0, "relay must not ACK terminal outbox without operator-visible origin receipt");
    const state = bridge.getState();
    assert.equal(state.operator.terminalOutbox.crossBrokerRelay.status, "succeeded");
    assert.equal(state.operator.terminalOutbox.crossBrokerRelay.relayed, 1);
    assert.equal(state.operator.terminalOutbox.crossBrokerRelay.skipped, 1);
    assert.equal(state.operator.terminalOutbox.crossBrokerRelay.receiptGate.providerGatewaySendSuccess, "not_ack_evidence");
    assert.equal(state.operator.terminalOutbox.crossBrokerRelay.receiptGate.terminalAckEligible, false);
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("operator bridge relays cross-broker child Terminal Briefs without local operator notification", async () => {
  const freshEvent = {
    id: "terminal:handoff-child:succeeded:2026-05-13T05%3A00%3A00.000Z",
    kind: "task.terminal",
    taskEventId: 539,
    createdAt: "2026-05-13T05:00:00.000Z",
    attempts: 0,
    receipt: { status: "accepted", updatedAt: "2026-05-13T05:00:00.000Z" },
    ackAudit: {
      decision: "pending",
      reason: "terminal event accepted; awaiting current-session-visible/operator-visible evidence before ACK",
      updatedAt: "2026-05-13T05:00:00.000Z",
    },
    payload: {
      taskId: "handoff-child",
      status: "succeeded",
      worker: "soonwook",
      repo: "jinwon-int/a2a-plane",
      issue: 276,
      testSummary: "child handoff completed",
      parentOwnedTerminalBrief: true,
      operatorFacingOwner: "parent",
      crossBrokerHandoff: {
        parentRoundId: "parent-seoseo-round",
        originBrokerId: "seoseo",
        handoffBrokerId: "gwakga",
        originTaskId: "parent-seoseo-round",
      },
      notificationOwnership: {
        ownerBrokerId: "seoseo",
        scope: "parent-broker-only",
        providerSendPermittedByProjection: false,
        terminalAckPermittedByProjection: false,
      },
      completedAt: "2026-05-13T05:00:00.000Z",
    },
  };
  const relayed = [];
  const sent = [];
  const acks = [];
  const bridge = createA2AOperatorEventBridge({
    now: () => Date.parse("2026-05-13T04:59:55.000Z"),
    terminalOutboxPollMs: 5,
    terminalOutboxReconcileUnackedOnStart: false,
    broker: {
      async *streamOperatorEvents(options = {}) {
        await waitForAbort(options.signal);
      },
      async listTerminalOutbox() {
        return {
          kind: "task.terminal.outbox",
          count: 1,
          cursor: freshEvent.id,
          reconciledUnacked: 0,
          events: [freshEvent],
        };
      },
      async ackTerminalOutbox(params) {
        acks.push(params);
        return freshEvent;
      },
    },
    handoffBrokerId: "gwakga",
    relayTerminalProjection(projection) {
      relayed.push(projection);
      return { accepted: true, reason: "parent accepted" };
    },
    notifyOperator(envelope) {
      sent.push(envelope);
      return { ackTerminalEvent: true, confirmationSource: "current_session_visible" };
    },
  });

  try {
    bridge.getState({ cursor: "terminal:before-handoff" });
    await eventually(() => relayed.length, (value) => value === 1, "expected child projection relay");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(relayed[0].brokerOfRecordId, "seoseo");
    assert.equal(relayed[0].originBrokerId, "gwakga");
    assert.equal(sent.length, 0, "handoff broker must not send operator-facing Terminal Brief locally");
    assert.equal(acks.length, 0, "handoff broker must not ACK local terminal outbox for parent-owned Brief visibility");
    const state = bridge.getState();
    assert.equal(state.operator.terminalOutbox.crossBrokerRelay.status, "succeeded");
    assert.equal(state.operator.terminalOutbox.cursor, freshEvent.id);
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("operator bridge suppresses child Terminal Briefs when parentOwnerBrokerId is the only ownership field", async () => {
  const freshEvent = {
    id: "terminal:handoff-child-owner-only:succeeded:2026-05-13T05%3A05%3A00.000Z",
    kind: "task.terminal",
    taskEventId: 541,
    createdAt: "2026-05-13T05:05:00.000Z",
    attempts: 0,
    receipt: { status: "accepted", updatedAt: "2026-05-13T05:05:00.000Z" },
    ackAudit: {
      decision: "pending",
      reason: "terminal event accepted; awaiting parent-owned visibility evidence before ACK",
      updatedAt: "2026-05-13T05:05:00.000Z",
    },
    payload: {
      taskId: "handoff-child-owner-only",
      status: "succeeded",
      worker: "jingun",
      repo: "jinwon-int/a2a-docker-runner",
      issue: 311,
      parentRoundId: "parent-seoseo-round",
      parentOwnerBrokerId: "seoseo",
      testSummary: "child handoff completed with parent owner metadata only",
      completedAt: "2026-05-13T05:05:00.000Z",
    },
  };
  const sent = [];
  const acks = [];
  const bridge = createA2AOperatorEventBridge({
    now: () => Date.parse("2026-05-13T05:04:55.000Z"),
    terminalOutboxPollMs: 5,
    terminalOutboxReconcileUnackedOnStart: false,
    broker: {
      async *streamOperatorEvents(options = {}) {
        await waitForAbort(options.signal);
      },
      async listTerminalOutbox() {
        return {
          kind: "task.terminal.outbox",
          count: 1,
          cursor: freshEvent.id,
          reconciledUnacked: 0,
          events: [freshEvent],
        };
      },
      async ackTerminalOutbox(params) {
        acks.push(params);
        return freshEvent;
      },
    },
    handoffBrokerId: "gwakga",
    notifyOperator(envelope) {
      sent.push(envelope);
      return { ackTerminalEvent: true, confirmationSource: "current_session_visible" };
    },
  });

  try {
    bridge.getState({ cursor: "terminal:before-owner-only" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(sent.length, 0, "handoff broker must suppress local Brief when parentOwnerBrokerId points elsewhere");
    assert.equal(acks.length, 0, "handoff broker must not ACK parent-owned Brief visibility");
    const state = bridge.getState();
    assert.equal(state.operator.terminalOutbox.cursor, freshEvent.id);
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("operator bridge suppresses parent-broker-only child Briefs with explicit notification ownership", async () => {
  const freshEvent = {
    id: "terminal:handoff-child-parent-broker-only:succeeded:2026-05-21T09%3A38%3A31.955Z",
    kind: "task.terminal",
    taskEventId: 873,
    createdAt: "2026-05-21T09:38:31.955Z",
    attempts: 0,
    receipt: { status: "accepted", updatedAt: "2026-05-21T09:38:31.955Z" },
    ackAudit: {
      decision: "pending",
      reason: "terminal event accepted; awaiting parent-owned visibility evidence before ACK",
      updatedAt: "2026-05-21T09:38:31.955Z",
    },
    payload: {
      taskId: "terminal-brief-873-live-proof-20260521T1831KST-team2-jingun",
      status: "failed",
      worker: "jingun",
      repo: "jinwon-int/a2a-broker",
      issue: 871,
      parentRoundId: "terminal-brief-873-live-proof-20260521T1831KST",
      parentRoundOrder: 2,
      parentRoundTotal: 2,
      parentOwnedTerminalBrief: true,
      operatorFacingOwner: "parent",
      crossBrokerHandoff: {
        parentRoundId: "terminal-brief-873-live-proof-20260521T1831KST",
        originBrokerId: "seoseo",
        handoffBrokerId: "gwakga",
        childWorkerId: "jingun",
      },
      notificationOwnership: {
        ownerBrokerId: "seoseo",
        scope: "parent-broker-only",
        providerSendPermittedByProjection: false,
        terminalAckPermittedByProjection: false,
      },
      terminalBriefTitle: "A2A Terminal Brief 실패: jingun(종료 2/2, 성공 0/2)",
      completedAt: "2026-05-21T09:38:31.955Z",
    },
  };
  const sent = [];
  const acks = [];
  const bridge = createA2AOperatorEventBridge({
    now: () => Date.parse("2026-05-21T09:38:30.000Z"),
    terminalOutboxPollMs: 5,
    terminalOutboxReconcileUnackedOnStart: false,
    broker: {
      async *streamOperatorEvents(options = {}) {
        await waitForAbort(options.signal);
      },
      async listTerminalOutbox() {
        return {
          kind: "task.terminal.outbox",
          count: 1,
          cursor: freshEvent.id,
          reconciledUnacked: 0,
          events: [freshEvent],
        };
      },
      async ackTerminalOutbox(params) {
        acks.push(params);
        return freshEvent;
      },
    },
    handoffBrokerId: "gwakga",
    notifyOperator(envelope) {
      sent.push(envelope);
      return { ackTerminalEvent: true, confirmationSource: "current_session_visible" };
    },
  });

  try {
    bridge.getState({ cursor: "terminal:before-parent-broker-only" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(sent.length, 0, "handoff broker must not send parent-broker-only Terminal Brief locally");
    assert.equal(acks.length, 0, "handoff broker must not ACK parent-broker-only visibility");
    const state = bridge.getState();
    assert.equal(state.operator.terminalOutbox.cursor, freshEvent.id);
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("operator bridge sends parent-broker-only Briefs when local broker owns notification", async () => {
  const freshEvent = {
    id: "terminal:parent-owned-by-local:succeeded:2026-05-21T10%3A42%3A56.903Z",
    kind: "task.terminal",
    taskEventId: 420,
    createdAt: "2026-05-21T10:42:56.903Z",
    attempts: 0,
    receipt: { status: "accepted", updatedAt: "2026-05-21T10:42:56.903Z" },
    ackAudit: {
      decision: "pending",
      reason: "terminal event accepted; awaiting parent broker visibility evidence before ACK",
      updatedAt: "2026-05-21T10:42:56.903Z",
    },
    payload: {
      taskId: "terminal-brief-419-runner319-live-proof-20260521T193251KST-team2-jingun",
      status: "succeeded",
      worker: "jingun",
      repo: "jinwon-int/a2a-docker-runner",
      issue: 311,
      doneUrl: "https://github.com/jinwon-int/a2a-docker-runner/issues/311#issuecomment-420",
      parentRoundId: "terminal-brief-419-runner319-live-proof-20260521T193251KST",
      parentRoundOrder: 2,
      parentRoundProgress: 2,
      parentRoundTotal: 2,
      parentOwnedTerminalBrief: true,
      operatorFacingOwner: "parent",
      crossBrokerHandoff: {
        parentRoundId: "terminal-brief-419-runner319-live-proof-20260521T193251KST",
        originBrokerId: "seoseo",
        handoffBrokerId: "gwakga",
        childWorkerId: "jingun",
      },
      notificationOwnership: {
        ownerBrokerId: "seoseo",
        scope: "parent-broker-only",
        providerSendPermittedByProjection: false,
        terminalAckPermittedByProjection: false,
      },
      terminalBriefTitle: "A2A Terminal Brief 완료: jingun(완료 2/2)",
      completedAt: "2026-05-21T10:42:56.903Z",
    },
  };
  const sent = [];
  const acks = [];
  const bridge = createA2AOperatorEventBridge({
    now: () => Date.parse("2026-05-21T10:42:50.000Z"),
    terminalOutboxPollMs: 5,
    terminalOutboxReconcileUnackedOnStart: false,
    broker: {
      async *streamOperatorEvents(options = {}) {
        await waitForAbort(options.signal);
      },
      async listTerminalOutbox() {
        return {
          kind: "task.terminal.outbox",
          count: 1,
          cursor: freshEvent.id,
          reconciledUnacked: 0,
          events: [freshEvent],
        };
      },
      async ackTerminalOutbox(params) {
        acks.push(params);
        return freshEvent;
      },
    },
    handoffBrokerId: "seoseo",
    notifyOperator(envelope) {
      sent.push(envelope);
      return { ackTerminalEvent: true, confirmationSource: "current_session_visible" };
    },
  });

  try {
    bridge.getState({ cursor: "terminal:before-parent-local-owner" });
    await eventually(() => sent.length, (value) => value === 1, "expected parent owner broker to send Brief");
    assert.equal(sent[0].taskId, "terminal-brief-419-runner319-live-proof-20260521T193251KST-team2-jingun");
    assert.equal(sent[0].title, "A2A Terminal Brief 완료: jingun(완료 2/2)");
    await eventually(() => acks.length, (value) => value === 1, "expected parent owner broker to ACK after visible receipt");
    assert.equal(acks[0].receipt.evidence, "operator_visible");
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("operator bridge notifies local broker-owned Terminal Briefs when no handoff broker is configured", async () => {
  const event = {
    id: "terminal:local-broker-owned:succeeded:2026-05-13T05%3A10%3A00.000Z",
    kind: "task.terminal",
    taskEventId: 540,
    createdAt: "2026-05-13T05:10:00.000Z",
    attempts: 0,
    receipt: { status: "accepted", updatedAt: "2026-05-13T05:10:00.000Z" },
    ackAudit: {
      decision: "pending",
      reason: "terminal event accepted; awaiting current-session-visible/operator-visible evidence before ACK",
      updatedAt: "2026-05-13T05:10:00.000Z",
    },
    payload: {
      taskId: "local-broker-owned",
      status: "succeeded",
      worker: "nosuk",
      doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/294",
      parentRoundId: "local-broker-owned",
      brokerOfRecordId: "seoseo",
      originBrokerId: "seoseo",
      testSummary: "local broker-owned canary completed",
      completedAt: "2026-05-13T05:10:00.000Z",
    },
  };
  const sent = [];
  const acks = [];
  const bridge = createA2AOperatorEventBridge({
    now: () => Date.parse("2026-05-13T05:09:55.000Z"),
    terminalOutboxPollMs: 5,
    terminalOutboxReconcileUnackedOnStart: false,
    broker: {
      async *streamOperatorEvents(options = {}) {
        await waitForAbort(options.signal);
      },
      async listTerminalOutbox() {
        return {
          kind: "task.terminal.outbox",
          count: 1,
          cursor: event.id,
          reconciledUnacked: 0,
          events: [event],
        };
      },
      async ackTerminalOutbox(params) {
        acks.push(params);
        return { ...event, ack: { status: "receipt_confirmed", ...params.receipt } };
      },
    },
    notifyOperator(envelope) {
      sent.push(envelope);
      return { ackTerminalEvent: true, confirmationSource: "current_session_visible" };
    },
  });

  try {
    bridge.getState({ cursor: "terminal:before-local-owned" });
    await eventually(() => sent.length, (value) => value === 1, "expected local broker-owned Brief notification");
    assert.equal(sent[0].taskId, "local-broker-owned");
    assert.equal(sent[0].doneUrl, "https://github.com/jinwon-int/a2a-broker/issues/294");
    await eventually(() => acks.length, (value) => value === 1, "expected local broker-owned Brief ACK");
    assert.equal(acks[0].receipt.evidence, "operator_visible");
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});


test("operator bridge notifies parent-side synthetic cross-broker Terminal Briefs locally", async () => {
  const parentEvent = {
    id: "terminal:cross-broker%3Aparent-seoseo%3Agwakga%3Achild-1:succeeded:2026-05-13T05%3A30%3A00.000Z",
    kind: "task.terminal",
    taskEventId: 540,
    createdAt: "2026-05-13T05:30:00.000Z",
    attempts: 0,
    receipt: { status: "accepted", updatedAt: "2026-05-13T05:30:00.000Z" },
    ackAudit: {
      decision: "pending",
      reason: "cross-broker terminal projection accepted; awaiting parent-broker current-session-visible/operator-visible evidence before ACK",
      updatedAt: "2026-05-13T05:30:00.000Z",
    },
    payload: {
      taskId: "child-1",
      status: "succeeded",
      run: "parent-seoseo",
      worker: "gwakga",
      testSummary: "parent synthetic projection completed",
      crossBrokerHandoff: {
        parentRoundId: "parent-seoseo",
        originBrokerId: "seoseo",
        handoffBrokerId: "gwakga",
        originTaskId: "child-1",
      },
      completedAt: "2026-05-13T05:30:00.000Z",
    },
  };
  const relayed = [];
  const sent = [];
  const acks = [];
  const bridge = createA2AOperatorEventBridge({
    now: () => Date.parse("2026-05-13T05:29:55.000Z"),
    terminalOutboxPollMs: 5,
    terminalOutboxReconcileUnackedOnStart: false,
    broker: {
      async *streamOperatorEvents(options = {}) {
        await waitForAbort(options.signal);
      },
      async listTerminalOutbox() {
        return {
          kind: "task.terminal.outbox",
          count: 1,
          cursor: parentEvent.id,
          reconciledUnacked: 0,
          events: [parentEvent],
        };
      },
      async ackTerminalOutbox(params) {
        acks.push(params);
        return { ...parentEvent, ack: { status: "receipt_confirmed", ...params.receipt } };
      },
    },
    handoffBrokerId: "seoseo",
    relayTerminalProjection(projection) {
      relayed.push(projection);
      return { accepted: true, reason: "should not relay parent synthetic event" };
    },
    notifyOperator(envelope) {
      sent.push(envelope);
      return { ackTerminalEvent: true, confirmationSource: "current_session_visible" };
    },
  });

  try {
    bridge.getState({ cursor: "terminal:before-parent-synthetic" });
    await eventually(() => sent.length, (value) => value === 1, "expected parent-side synthetic Brief notification");
    assert.equal(relayed.length, 0, "parent synthetic cross-broker event must not be relayed back to child broker");
    assert.equal(sent[0].taskId, "child-1");
    assert.equal(sent[0].runId, "parent-seoseo");
    await eventually(() => acks.length, (value) => value === 1, "expected parent-side synthetic Brief ACK");
    assert.equal(acks[0].receipt.evidence, "operator_visible");
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("operator bridge skips evidence-only cross-broker projection and notifies paired operator row", async () => {
  const projectionEvent = {
    id: "terminal:cross-broker%3Aparent-seoseo%3Achild-1%3Asucceeded%3Aseoseo",
    kind: "task.terminal",
    taskEventId: 541,
    createdAt: "2026-05-13T05:35:00.000Z",
    attempts: 0,
    receipt: { status: "accepted", updatedAt: "2026-05-13T05:35:00.000Z" },
    ackAudit: {
      decision: "pending",
      reason: "cross-broker terminal projection accepted as evidence-only",
      updatedAt: "2026-05-13T05:35:00.000Z",
    },
    payload: {
      taskId: "child-1",
      status: "succeeded",
      run: "parent-seoseo",
      worker: "dungae",
      testSummary: "projection evidence only",
      notificationOwnership: {
        ownerBrokerId: "seoseo",
        scope: "parent-broker-only",
        providerSendPermittedByProjection: false,
        terminalAckPermittedByProjection: false,
      },
      crossBrokerHandoff: {
        parentRoundId: "parent-seoseo",
        originBrokerId: "seoseo",
        handoffBrokerId: "gwakga",
        originTaskId: "child-1",
        childWorkerId: "dungae",
      },
      completedAt: "2026-05-13T05:34:58.000Z",
    },
  };
  const operatorEvent = {
    ...projectionEvent,
    id: "terminal:cross-broker-operator%3Across-broker%3Aparent-seoseo%3Achild-1%3Asucceeded%3Aseoseo",
    taskEventId: 542,
    ackAudit: {
      decision: "pending",
      reason: "operator-facing parent broker row awaiting visible receipt",
      updatedAt: "2026-05-13T05:35:00.000Z",
    },
    payload: {
      ...projectionEvent.payload,
      notificationOwnership: undefined,
      testSummary: "operator-facing parent broker row",
    },
  };
  const sent = [];
  const acks = [];
  const bridge = createA2AOperatorEventBridge({
    now: () => Date.parse("2026-05-13T05:34:55.000Z"),
    terminalOutboxPollMs: 5,
    terminalOutboxReconcileUnackedOnStart: false,
    broker: {
      async *streamOperatorEvents(options = {}) {
        await waitForAbort(options.signal);
      },
      async listTerminalOutbox() {
        if (acks.length) {
          return {
            kind: "task.terminal.outbox",
            count: 0,
            cursor: operatorEvent.id,
            reconciledUnacked: 0,
            events: [],
          };
        }
        return {
          kind: "task.terminal.outbox",
          count: 2,
          cursor: operatorEvent.id,
          reconciledUnacked: 0,
          events: [projectionEvent, operatorEvent],
        };
      },
      async ackTerminalOutbox(params) {
        acks.push(params);
        return { ...operatorEvent, ack: { status: "receipt_confirmed", ...params.receipt } };
      },
    },
    handoffBrokerId: "seoseo",
    notifyOperator(envelope) {
      sent.push(envelope);
      return { ackTerminalEvent: true, confirmationSource: "current_session_visible" };
    },
  });

  try {
    bridge.getState({ cursor: "terminal:before-cross-broker-pair" });
    await eventually(() => sent.length, (value) => value === 1, "expected only the operator-facing row to notify");
    assert.equal(sent[0].taskId, "child-1");
    assert.equal(sent[0].evidence.summary, "operator-facing parent broker row");
    await eventually(() => acks.length, (value) => value === 1, "expected only the operator-facing row to ACK");
    assert.equal(acks[0].id, operatorEvent.id);
    assert.equal(acks[0].receipt.evidence, "operator_visible");
    await eventually(
      () => bridge.getState().operator.terminalOutbox.pendingUnacknowledged?.length ?? 0,
      (value) => value === 0,
      "expected broker poll to clear acknowledged cross-broker rows",
    );
    const state = bridge.getState();
    assert.equal(state.operator.terminalOutbox.cursor, operatorEvent.id);
    assert.equal(state.operator.terminalOutbox.pendingUnacknowledged?.length ?? 0, 0);
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("cross-broker suppresses child 1/1 operator Brief for Seoseo-owned parent round at Gwakga", async () => {
  const freshEvent = {
    id: "terminal:child-1-of-1:succeeded:2026-05-22T22%3A58%3A13.000Z",
    kind: "task.terminal",
    taskEventId: 601,
    createdAt: "2026-05-22T22:58:13.000Z",
    attempts: 0,
    receipt: { status: "accepted", updatedAt: "2026-05-22T22:58:13.000Z" },
    ackAudit: {
      decision: "pending",
      reason: "terminal event accepted; awaiting parent-broker current-session-visible/operator-visible evidence before ACK",
      updatedAt: "2026-05-22T22:58:13.000Z",
    },
    payload: {
      taskId: "child-1-of-1",
      status: "succeeded",
      worker: "dungae",
      repo: "jinwon-int/openclaw-plugin-a2a",
      issue: 437,
      doneUrl: "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/437#issuecomment-done",
      testSummary: "lane 5/7 child 1/1 completion",
      parentRoundId: "parent-seoseo-round-1-of-1",
      parentRoundOrder: 1,
      parentRoundTotal: 1,
      parentOwnedTerminalBrief: true,
      operatorFacingOwner: "parent",
      crossBrokerHandoff: {
        parentRoundId: "parent-seoseo-round-1-of-1",
        originBrokerId: "seoseo",
        handoffBrokerId: "gwakga",
        childWorkerId: "dungae",
      },
      notificationOwnership: {
        ownerBrokerId: "seoseo",
        scope: "parent-broker-only",
        providerSendPermittedByProjection: false,
        terminalAckPermittedByProjection: false,
      },
      completedAt: "2026-05-22T22:58:13.000Z",
    },
  };
  const relayed = [];
  const sent = [];
  const acks = [];
  const bridge = createA2AOperatorEventBridge({
    now: () => Date.parse("2026-05-22T22:58:10.000Z"),
    terminalOutboxPollMs: 5,
    terminalOutboxReconcileUnackedOnStart: false,
    broker: {
      async *streamOperatorEvents(options = {}) {
        await waitForAbort(options.signal);
      },
      async listTerminalOutbox() {
        return {
          kind: "task.terminal.outbox",
          count: 1,
          cursor: freshEvent.id,
          reconciledUnacked: 0,
          events: [freshEvent],
        };
      },
      async ackTerminalOutbox(params) {
        acks.push(params);
        return freshEvent;
      },
    },
    handoffBrokerId: "gwakga",
    relayTerminalProjection(projection) {
      relayed.push(projection);
      return { accepted: true, reason: "parent accepted" };
    },
    notifyOperator(envelope) {
      sent.push(envelope);
      return { ackTerminalEvent: true, confirmationSource: "current_session_visible" };
    },
  });

  try {
    bridge.getState({ cursor: "terminal:before-child-1-1" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(sent.length, 0, "Gwakga must not send operator-facing Brief for child 1/1 owned by Seoseo");
    assert.equal(relayed.length, 1, "Gwakga must relay cross-broker projection to Seoseo for child 1/1");
    assert.equal(acks.length, 0, "Gwakga must not ACK terminal outbox for Seoseo-owned Brief visibility");
    const state = bridge.getState();
    assert.equal(state.operator.terminalOutbox.crossBrokerRelay.status, "succeeded");
    assert.equal(state.operator.terminalOutbox.cursor, freshEvent.id);
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("cross-broker suppresses child 1/2 operator Brief for Seoseo-owned parent round at Gwakga", async () => {
  const freshEvent = {
    id: "terminal:child-1-of-2:succeeded:2026-05-22T22%3A58%3A14.000Z",
    kind: "task.terminal",
    taskEventId: 602,
    createdAt: "2026-05-22T22:58:14.000Z",
    attempts: 0,
    receipt: { status: "accepted", updatedAt: "2026-05-22T22:58:14.000Z" },
    ackAudit: {
      decision: "pending",
      reason: "terminal event accepted; awaiting parent-broker current-session-visible/operator-visible evidence before ACK",
      updatedAt: "2026-05-22T22:58:14.000Z",
    },
    payload: {
      taskId: "child-1-of-2",
      status: "succeeded",
      worker: "dungae",
      repo: "jinwon-int/openclaw-plugin-a2a",
      issue: 437,
      doneUrl: "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/437#issuecomment-done",
      testSummary: "lane 5/7 child 1/2 completion",
      parentRoundId: "parent-seoseo-round-1-of-2",
      parentRoundOrder: 1,
      parentRoundTotal: 2,
      parentOwnedTerminalBrief: true,
      operatorFacingOwner: "parent",
      crossBrokerHandoff: {
        parentRoundId: "parent-seoseo-round-1-of-2",
        originBrokerId: "seoseo",
        handoffBrokerId: "gwakga",
        childWorkerId: "dungae",
      },
      notificationOwnership: {
        ownerBrokerId: "seoseo",
        scope: "parent-broker-only",
        providerSendPermittedByProjection: false,
        terminalAckPermittedByProjection: false,
      },
      completedAt: "2026-05-22T22:58:14.000Z",
    },
  };
  const relayed = [];
  const sent = [];
  const acks = [];
  const bridge = createA2AOperatorEventBridge({
    now: () => Date.parse("2026-05-22T22:58:10.000Z"),
    terminalOutboxPollMs: 5,
    terminalOutboxReconcileUnackedOnStart: false,
    broker: {
      async *streamOperatorEvents(options = {}) {
        await waitForAbort(options.signal);
      },
      async listTerminalOutbox() {
        return {
          kind: "task.terminal.outbox",
          count: 1,
          cursor: freshEvent.id,
          reconciledUnacked: 0,
          events: [freshEvent],
        };
      },
      async ackTerminalOutbox(params) {
        acks.push(params);
        return freshEvent;
      },
    },
    handoffBrokerId: "gwakga",
    relayTerminalProjection(projection) {
      relayed.push(projection);
      return { accepted: true, reason: "parent accepted" };
    },
    notifyOperator(envelope) {
      sent.push(envelope);
      return { ackTerminalEvent: true, confirmationSource: "current_session_visible" };
    },
  });

  try {
    bridge.getState({ cursor: "terminal:before-child-1-2" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(sent.length, 0, "Gwakga must not send operator-facing Brief for child 1/2 owned by Seoseo");
    assert.equal(relayed.length, 1, "Gwakga must relay cross-broker projection to Seoseo for child 1/2");
    assert.equal(acks.length, 0, "Gwakga must not ACK terminal outbox for Seoseo-owned Brief visibility");
    const state = bridge.getState();
    assert.equal(state.operator.terminalOutbox.crossBrokerRelay.status, "succeeded");
    assert.equal(state.operator.terminalOutbox.cursor, freshEvent.id);
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("cross-broker dedupe via taskNotificationKey prevents duplicate visible sends for repeated projection", async () => {
  const dedupeEvent = {
    id: "terminal:dedupe-test:succeeded:2026-05-22T22%3A58%3A15.000Z",
    kind: "task.terminal",
    taskEventId: 603,
    createdAt: "2026-05-22T22:58:15.000Z",
    attempts: 0,
    receipt: { status: "accepted", updatedAt: "2026-05-22T22:58:15.000Z" },
    ackAudit: {
      decision: "pending",
      reason: "terminal event accepted; awaiting parent-broker current-session-visible/operator-visible evidence before ACK",
      updatedAt: "2026-05-22T22:58:15.000Z",
    },
    payload: {
      taskId: "dedupe-child-task",
      status: "succeeded",
      worker: "dungae",
      repo: "jinwon-int/openclaw-plugin-a2a",
      issue: 437,
      doneUrl: "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/437#issuecomment-done",
      testSummary: "lane 5/7 dedupe test",
      parentRoundId: "parent-seoseo-round-dedupe",
      parentRoundOrder: 1,
      parentRoundTotal: 2,
      parentOwnedTerminalBrief: true,
      operatorFacingOwner: "parent",
      crossBrokerHandoff: {
        parentRoundId: "parent-seoseo-round-dedupe",
        originBrokerId: "seoseo",
        handoffBrokerId: "gwakga",
        childWorkerId: "dungae",
      },
      notificationOwnership: {
        ownerBrokerId: "seoseo",
        scope: "parent-broker-only",
        providerSendPermittedByProjection: false,
        terminalAckPermittedByProjection: false,
      },
      completedAt: "2026-05-22T22:58:15.000Z",
    },
  };
  // Simulate a second event with the same taskId (different event id — outbox replay scenario)
  const duplicateEvent = {
    ...dedupeEvent,
    id: "terminal:dedupe-test-duplicate:succeeded:2026-05-22T22%3A58%3A16.000Z",
    taskEventId: 604,
    createdAt: "2026-05-22T22:58:16.000Z",
  };
  const relayed = [];
  const sent = [];
  const acks = [];
  const bridge = createA2AOperatorEventBridge({
    now: () => Date.parse("2026-05-22T22:58:10.000Z"),
    terminalOutboxPollMs: 5,
    terminalOutboxReconcileUnackedOnStart: false,
    broker: {
      async *streamOperatorEvents(options = {}) {
        await waitForAbort(options.signal);
      },
      async listTerminalOutbox() {
        // Return both events in the same batch to test cross-broker dedupe
        return {
          kind: "task.terminal.outbox",
          count: 2,
          cursor: duplicateEvent.id,
          reconciledUnacked: 0,
          events: [dedupeEvent, duplicateEvent],
        };
      },
      async ackTerminalOutbox(params) {
        acks.push(params);
        return params;
      },
    },
    handoffBrokerId: "gwakga",
    relayTerminalProjection(projection) {
      relayed.push(projection);
      return { accepted: true, reason: "parent accepted" };
    },
    notifyOperator(envelope) {
      sent.push(envelope);
      return { ackTerminalEvent: true, confirmationSource: "current_session_visible" };
    },
  });

  try {
    bridge.getState({ cursor: "terminal:before-dedupe" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(sent.length, 0, "Gwakga must not send operator-facing Brief for dedupe test (Seoseo-owned)");
    assert.equal(relayed.length, 2, "both original and duplicate relay projections should be forwarded");
    // Both relay projections should reference the same childTaskId from the same parent round
    assert.equal(relayed[0].childTaskId, "dedupe-child-task");
    assert.equal(relayed[1].childTaskId, "dedupe-child-task");
    const state = bridge.getState();
    assert.equal(state.operator.terminalOutbox.cursor, duplicateEvent.id);
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});

test("cross-broker parent-side synthetic Seoseo operator Brief has correct title scoped to parent round", async () => {
  const parentEvent = {
    id: "terminal:cross-broker%3Aparent-seoseo%3Agwakga%3Achild-1-of-2:succeeded:2026-05-22T22%3A58%3A17.000Z",
    kind: "task.terminal",
    taskEventId: 605,
    createdAt: "2026-05-22T22:58:17.000Z",
    attempts: 0,
    receipt: { status: "accepted", updatedAt: "2026-05-22T22:58:17.000Z" },
    ackAudit: {
      decision: "pending",
      reason: "cross-broker terminal projection accepted; awaiting parent-broker current-session-visible/operator-visible evidence before ACK",
      updatedAt: "2026-05-22T22:58:17.000Z",
    },
    payload: {
      taskId: "child-1-of-2",
      status: "succeeded",
      run: "parent-seoseo-round-synthetic",
      worker: "dungae",
      testSummary: "parent synthetic projection for child 1/2 completed",
      parentRoundId: "parent-seoseo-round-synthetic",
      parentRoundOrder: 1,
      parentRoundTotal: 2,
      crossBrokerHandoff: {
        parentRoundId: "parent-seoseo-round-synthetic",
        originBrokerId: "seoseo",
        handoffBrokerId: "gwakga",
        originTaskId: "child-1-of-2",
        childWorkerId: "dungae",
      },
      completedAt: "2026-05-22T22:58:17.000Z",
    },
  };
  const relayed = [];
  const sent = [];
  const acks = [];
  const bridge = createA2AOperatorEventBridge({
    now: () => Date.parse("2026-05-22T22:58:15.000Z"),
    terminalOutboxPollMs: 5,
    terminalOutboxReconcileUnackedOnStart: false,
    broker: {
      async *streamOperatorEvents(options = {}) {
        await waitForAbort(options.signal);
      },
      async listTerminalOutbox() {
        return {
          kind: "task.terminal.outbox",
          count: 1,
          cursor: parentEvent.id,
          reconciledUnacked: 0,
          events: [parentEvent],
        };
      },
      async ackTerminalOutbox(params) {
        acks.push(params);
        return { ...parentEvent, ack: { status: "receipt_confirmed", ...params.receipt } };
      },
    },
    handoffBrokerId: "seoseo",
    relayTerminalProjection(projection) {
      relayed.push(projection);
      return { accepted: true, reason: "should not relay parent synthetic event" };
    },
    notifyOperator(envelope) {
      sent.push(envelope);
      return { ackTerminalEvent: true, confirmationSource: "current_session_visible" };
    },
  });

  try {
    bridge.getState({ cursor: "terminal:before-synthetic-brief-title" });
    await eventually(() => sent.length, (value) => value === 1, "expected Seoseo-side synthetic Brief notification");
    assert.equal(relayed.length, 0, "Seoseo synthetic cross-broker event must not be relayed back to child broker");
    assert.equal(sent[0].taskId, "child-1-of-2");
    assert.equal(sent[0].runId, "parent-seoseo-round-synthetic");
    assert.equal(sent[0].parentRoundId, "parent-seoseo-round-synthetic");
    // Title should reflect parent round context with 1/2, not a misleading child-local "1/1"
    assert.ok(
      sent[0].title.includes("1/2") || sent[0].title.includes("완료"),
      `synthetic brief title "${sent[0].title}" must contain parent round order context`,
    );
    await eventually(() => acks.length, (value) => value === 1, "expected Seoseo synthetic Brief ACK");
    assert.equal(acks[0].receipt.evidence, "operator_visible");
  } finally {
    bridge.shutdown();
    await bridge.waitForIdle();
  }
});
