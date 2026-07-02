/**
 * Requester-visible no-live A2A status conformance fixture.
 *
 * Issue:  jinwon-int/plugin-a2a#457
 * Parent: a2a-plane#506 (internal tracker, private)
 *
 * This ties together the requester-visible surfaces that were previously
 * covered by separate focused tests: broker protocol/build diagnostics,
 * Hermes worker capacity metadata, operator no-live status, terminal receipt
 * gaps, and cross-broker evidence-only vs operator-visible outbox behavior.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  createA2AMonitoringHandlers,
  projectA2AOperatorStatus,
  type A2ABrokerAdapterPluginRuntimeConfig,
} from "../dist/src/gateway-monitoring-handlers.js";
import { buildGatewayTaskStatus } from "../dist/src/gateway-handlers.js";
import { createA2AOperatorEventBridge } from "../dist/src/operator-event-bridge.js";

type JsonRecord = Record<string, unknown>;

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/requester-visible-a2a-status-conformance.json", import.meta.url), "utf8"),
) as JsonRecord;

function activeConfig(): A2ABrokerAdapterPluginRuntimeConfig {
  return {
    plugins: {
      allow: ["a2a-broker-adapter"],
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: {
            baseUrl: "https://broker.example.test",
          },
        },
      },
    },
  };
}

function eventually<T>(
  read: () => T,
  predicate: (value: T) => boolean,
  message: string,
): Promise<T> {
  const deadline = Date.now() + 1_000;
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = read();
      if (predicate(value)) {
        resolve(value);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(message));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

function waitForAbort(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!signal || signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

describe("requester-visible A2A status conformance", () => {
  it("projects broker protocol, build info, no-live readiness, and receipt gaps in one monitor response", async () => {
    const responses: Array<{ ok: boolean; result?: unknown; error?: unknown }> = [];
    const handlers = createA2AMonitoringHandlers(activeConfig(), {
      createClient: () => ({
        async health() {
          return fixture.health;
        },
        async listDiagnostics() {
          return fixture.diagnostics;
        },
      }),
    });

    await handlers.handleA2AMonitorStatus({
      params: { sessionKey: "telegram:jinon" },
      respond(ok, result, error) {
        responses.push({ ok, result, error });
      },
    });

    assert.equal(responses.length, 1);
    assert.equal(responses[0].ok, true);
    assert.equal(responses[0].error, undefined);
    const result = responses[0].result as JsonRecord;

    const profile = result.brokerProtocolProfile as JsonRecord;
    assert.equal(profile.protocolVersion, "1.0");
    assert.deepEqual(profile.capabilities, { streaming: true, pushNotifications: false });
    assert.deepEqual(profile.transportHints, { rest: "unsupported", grpc: "unsupported", push: "unsupported" });
    assert.notEqual(result.brokerBuildInfo, undefined);

    const gaps = result.terminalReceiptGaps as JsonRecord[];
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].taskId, "task-provider-accepted");
    assert.equal(gaps[0].receiptGapStatus, "missing");
    assert.equal(gaps[0].terminalAckEligible, false);

    const noLive = result.noLiveRehearsal as JsonRecord;
    assert.equal(noLive.status, "ready");
    assert.deepEqual(noLive.safeOperations, {
      liveSend: false,
      terminalOutboxAck: false,
      gatewayRestart: false,
      productionDeploy: false,
      providerSend: false,
    });
    assert.equal((noLive.receiptStates as JsonRecord[])[0].terminalAckEligible, false);
    assert.equal("noLiveRehearsalManifest" in result, false);

    const liveReadiness = result.liveReadiness as JsonRecord;
    assert.equal(liveReadiness.status, "ready");
    assert.deepEqual(liveReadiness.safeOperations, {
      liveSend: false,
      terminalOutboxAck: false,
      gatewayRestart: false,
      productionDeploy: false,
      providerSend: false,
    });
  });

  it("keeps diagnostics useful when broker health is unreachable and protocol profile is unavailable", async () => {
    const responses: Array<{ ok: boolean; result?: unknown; error?: unknown }> = [];
    const handlers = createA2AMonitoringHandlers(activeConfig(), {
      createClient: () => ({
        async health() {
          throw new Error("broker unavailable");
        },
        async listDiagnostics() {
          return fixture.diagnostics;
        },
      }),
    });

    await handlers.handleA2AMonitorStatus({
      params: { sessionKey: "telegram:jinon" },
      respond(ok, result, error) {
        responses.push({ ok, result, error });
      },
    });

    assert.equal(responses.length, 1);
    assert.equal(responses[0].ok, true);
    const result = responses[0].result as JsonRecord;
    assert.equal("brokerProtocolProfile" in result, false);
    assert.notEqual(result.noLiveRehearsal, undefined);
    assert.notEqual(result.terminalReceiptGaps, undefined);
  });

  it("surfaces sanitized Hermes capacity metadata without labeling default workers as Hermes", () => {
    const hermesStatus = buildGatewayTaskStatus(fixture.hermesTask as never);
    const hermesMetadata = hermesStatus.metadata as JsonRecord;
    const hermesCapacity = hermesMetadata.workerCapacity as JsonRecord;
    assert.equal(hermesCapacity.status, "healthy");
    assert.equal(hermesCapacity.runtimeFlavor, "termux-hermes");
    assert.equal(hermesCapacity.gatewayRequired, false);
    assert.equal(hermesMetadata.workerCapacityLine, "termux-hermes worker profile: healthy (gateway-optional)");
    assert.equal(hermesCapacity.note, "load: low");

    const defaultStatus = buildGatewayTaskStatus(fixture.defaultWorkerTask as never);
    const defaultMetadata = defaultStatus.metadata as JsonRecord;
    const defaultCapacity = defaultMetadata.workerCapacity as JsonRecord;
    assert.equal(defaultCapacity.status, "healthy");
    assert.equal("runtimeFlavor" in defaultCapacity, false);
    assert.equal(defaultMetadata.workerCapacityLine, "worker profile: healthy");
    assert.doesNotMatch(String(defaultMetadata.workerCapacityLine), /termux-hermes/);
  });

  it("projects operator status as no-live and treats provider send as non-ACK evidence", () => {
    const state = {
      kind: "a2a.operator.monitor",
      enabled: true,
      bridge: {
        connection: "polling",
        cursor: "terminal:fixture",
      },
      operator: {
        snapshot: { summary: { queueDepth: 0 } },
        liveSummary: { staleTasks: 0, timedOutTasks: 0, pending: 0, claimedRunning: 0 },
        terminalOutbox: {
          lastPoll: { pendingUnacknowledged: 0, reconciledUnacked: 0 },
          pendingUnacknowledged: [],
        },
        terminalReceipts: [
          {
            taskId: "task-provider-accepted",
            receiptStatus: "pending",
            receiptGapStatus: "missing",
            operatorReceiptState: "pending_receipt",
            operatorReceiptLabel: "⋯ pending receipt",
            terminalAckEligible: false,
            reason: "provider send only",
          },
        ],
      },
    };

    const result = projectA2AOperatorStatus(state as never, fixture.health);
    assert.equal(result.mode, "operator-status-dryrun/no-live");
    assert.equal(result.providerSendNotAckEvidence, true);
    assert.deepEqual(result.safeOperations, {
      liveSend: false,
      terminalOutboxAck: false,
      gatewayRestart: false,
      productionDeploy: false,
      providerSend: false,
    });
    assert.equal(result.queueHygiene.hygiene.receiptGapCount, 1);
  });

  it("skips cross-broker evidence-only rows and ACKs only the paired operator-visible row", async () => {
    const outbox = fixture.crossBrokerOutbox as JsonRecord;
    const projectionEvent = outbox.projectionEvent as JsonRecord;
    const operatorEvent = outbox.operatorEvent as JsonRecord;
    const sent: JsonRecord[] = [];
    const acks: JsonRecord[] = [];
    const bridge = createA2AOperatorEventBridge({
      now: () => Date.parse("2026-06-07T05:00:00.000Z"),
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
        async ackTerminalOutbox(params: JsonRecord) {
          acks.push(params);
          return { ...operatorEvent, ack: { status: "receipt_confirmed", ...params.receipt as JsonRecord } };
        },
      },
      handoffBrokerId: "brokerAlpha",
      notifyOperator(envelope: JsonRecord) {
        sent.push(envelope);
        return { ackTerminalEvent: true, confirmationSource: "current_session_visible" };
      },
    });

    try {
      bridge.getState({ cursor: "terminal:before-cross-broker-pair-fixture" });
      await eventually(() => sent.length, (value) => value === 1, "expected only the operator-facing row to notify");
      assert.equal(sent[0].taskId, "child-1");
      assert.equal((sent[0].evidence as JsonRecord).summary, "operator-facing parent broker row");
      await eventually(() => acks.length, (value) => value === 1, "expected only the operator-facing row to ACK");
      assert.equal(acks[0].id, operatorEvent.id);
      assert.equal((acks[0].receipt as JsonRecord).evidence, "operator_visible");
      await eventually(
        () => bridge.getState().operator.terminalOutbox.pendingUnacknowledged?.length ?? 0,
        (value) => value === 0,
        "expected acknowledged cross-broker rows to clear",
      );
      const state = bridge.getState();
      assert.equal(state.operator.terminalOutbox.cursor, operatorEvent.id);
      assert.equal(state.operator.terminalOutbox.pendingUnacknowledged?.length ?? 0, 0);
    } finally {
      bridge.shutdown();
      await bridge.waitForIdle();
    }
  });
});
