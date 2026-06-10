/**
 * Broker pressure and queue hygiene operator status projections.
 *
 * Issue:  jinwon-int/plugin-a2a#318
 * Parent: jinwon-int/a2a-broker#636
 * Worker: sogyo
 *
 * Verifies that handleA2AMonitorStatus with operatorEvents returns a
 * synthesized operatorStatus projection combining broker pressure
 * (queue depth, audit pressure, worker health) and queue hygiene
 * (stale tasks, timed-out tasks, unacknowledged outbox, receipt gaps).
 *
 * Safety invariants enforced:
 *  - providerSendNotAckEvidence is always true
 *  - safeOperations.liveSend, terminalOutboxAck, gatewayRestart,
 *    productionDeploy, providerSend are all false
 *  - No live send, no terminal ACK, no Gateway restart
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  projectBrokerPressureOperatorStatus,
  projectQueueHygieneOperatorStatus,
  projectA2AOperatorStatus,
  projectTerminalReceiptGapsFromBridge,
} from "../dist/src/gateway-monitoring-handlers.js";
import type { A2AOperatorEventBridgeState } from "../dist/src/operator-event-bridge.js";

// ── Helpers ────────────────────────────────────────────────────────

function bridgeStateFixture(
  overrides: Partial<A2AOperatorEventBridgeState> = {},
): A2AOperatorEventBridgeState {
  return {
    kind: "a2a.operator.monitor",
    enabled: true,
    bridge: {
      connection: "streaming",
      note: "test fixture",
      cursor: "operator:10",
      connectedAt: 1710000000000,
      ...(((overrides.bridge as Record<string, unknown>) ?? {}) as Record<string, unknown>),
    },
    operator: {
      snapshot: {},
      liveSummary: {},
      workerProgress: {
        status: "unknown",
        counts: { total: 0, live: 0, stale: 0, unknown: 0, activeTasks: 0 },
        workers: [],
      },
      githubEvidence: {
        status: "ok",
        counts: { total: 0, startSeen: 0, terminalSeen: 0, evidenceMissing: 0, warnings: 0 },
        tasks: [],
      },
      safetyStatus: {
        mode: "release-dryrun/no-live",
        status: "ready",
        blockers: [],
        safeOperations: {
          liveSend: false,
          terminalOutboxAck: false,
          gatewayRestart: false,
          productionDeploy: false,
        },
        receiptGate: {
          ackRequires: ["current_session_visible", "manual_operator_receipt"],
          providerGatewaySendSuccess: "not_ack_evidence",
          terminalAckEligible: false,
        },
      },
      alerts: {
        open: [],
        resolved: [],
      },
      ...(overrides.operator ? overrides.operator : {}),
    },
  };
}

// ── Tests: broker pressure ─────────────────────────────────────────

describe("projectBrokerPressureOperatorStatus", () => {
  it("returns normal pressure when queue depth is zero and workers are healthy", () => {
    const state = bridgeStateFixture();
    const result = projectBrokerPressureOperatorStatus(state);
    assert.equal(result.status, "normal");
    assert.equal(result.pressure.queueDepth, 0);
    assert.equal(result.pressure.staleWorkerCount, 0);
    assert.ok(Array.isArray(result.messages));
  });

  it("detects elevated pressure from queue depth > 0", () => {
    const state = bridgeStateFixture({
      operator: {
        snapshot: {
          summary: { queueDepth: 5 },
        },
      },
    });
    const result = projectBrokerPressureOperatorStatus(state);
    assert.equal(result.status, "elevated");
    assert.equal(result.pressure.queueDepth, 5);
    assert.ok(result.messages.some((m) => m.includes("queue depth")));
  });

  it("detects elevated pressure from stale workers", () => {
    const state = bridgeStateFixture({
      operator: {
        workerProgress: {
          status: "stale",
          counts: { total: 4, live: 1, stale: 3, unknown: 0, activeTasks: 2 },
          workers: [],
        },
      },
    });
    const result = projectBrokerPressureOperatorStatus(state);
    assert.equal(result.status, "elevated");
    assert.equal(result.pressure.staleWorkerCount, 3);
    assert.equal(result.pressure.totalWorkerCount, 4);
  });

  it("includes audit pressure ratio when health data is provided", () => {
    const state = bridgeStateFixture();
    const health = {
      auditRows: 800,
      maxAuditEvents: 1000,
      healthLatencyMs: 200,
    };
    const result = projectBrokerPressureOperatorStatus(state, health);
    assert.equal(typeof result.pressure.auditPressureRatio, "number");
    assert.equal(result.pressure.auditPressureRatio, 0.8);
    assert.equal(result.pressure.healthLatencyMs, 200);
  });

  it("stays normal when audit pressure is within limits", () => {
    const state = bridgeStateFixture();
    const health = {
      auditRows: 100,
      maxAuditEvents: 1000,
    };
    const result = projectBrokerPressureOperatorStatus(state, health);
    // Queue depth 0 and no stale workers -> normal
    assert.equal(result.status, "normal");
  });

  it("elevates when audit table is at 90%+ capacity", () => {
    const state = bridgeStateFixture();
    const health = {
      auditRows: 950,
      maxAuditEvents: 1000,
    };
    const result = projectBrokerPressureOperatorStatus(state, health);
    assert.equal(result.status, "elevated");
    assert.equal(result.pressure.auditPressureRatio, 0.95);
  });

  it("provider send/message-id remains non-ACK evidence", () => {
    // The pressure projection must not contain any terminal ACK
    // eligibility signals. This is a structural safety invariant.
    const state = bridgeStateFixture();
    const result = projectBrokerPressureOperatorStatus(state);
    // No terminalAckEligible field should exist in pressure types
    assert.equal("terminalAckEligible" in result.pressure, false);
    // Provider send is not treated as evidence
    assert.equal("providerGatewaySendSuccess" in result.pressure, false);
  });
});

// ── Tests: queue hygiene ──────────────────────────────────────────

describe("projectQueueHygieneOperatorStatus", () => {
  it("returns clean when no stale, timed-out, or unacknowledged signals", () => {
    const state = bridgeStateFixture();
    const result = projectQueueHygieneOperatorStatus(state);
    assert.equal(result.status, "clean");
    assert.equal(result.hygiene.staleTaskCount, 0);
    assert.equal(result.hygiene.timedOutTaskCount, 0);
    assert.equal(result.hygiene.unacknowledgedOutboxCount, 0);
    assert.equal(result.hygiene.receiptGapCount, 0);
  });

  it("detects stale hygiene from live summary stale tasks", () => {
    const state = bridgeStateFixture({
      operator: {
        liveSummary: {
          staleTasks: 3,
          timedOutTasks: 0,
        },
      },
    });
    const result = projectQueueHygieneOperatorStatus(state);
    assert.equal(result.status, "stale");
    assert.equal(result.hygiene.staleTaskCount, 3);
    assert.equal(result.hygiene.timedOutTaskCount, 0);
  });

  it("detects stale hygiene from timed-out tasks", () => {
    const state = bridgeStateFixture({
      operator: {
        liveSummary: {
          staleTasks: 0,
          timedOutTasks: 2,
        },
      },
    });
    const result = projectQueueHygieneOperatorStatus(state);
    assert.equal(result.status, "stale");
    assert.equal(result.hygiene.staleTaskCount, 0);
    assert.equal(result.hygiene.timedOutTaskCount, 2);
  });

  it("detects blocked hygiene when stale count > 5", () => {
    const state = bridgeStateFixture({
      operator: {
        liveSummary: {
          staleTasks: 7,
        },
      },
    });
    const result = projectQueueHygieneOperatorStatus(state);
    assert.equal(result.status, "blocked");
    assert.equal(result.hygiene.staleTaskCount, 7);
  });

  it("detects blocked hygiene when timed-out count > 5", () => {
    const state = bridgeStateFixture({
      operator: {
        liveSummary: {
          timedOutTasks: 8,
        },
      },
    });
    const result = projectQueueHygieneOperatorStatus(state);
    assert.equal(result.status, "blocked");
    assert.equal(result.hygiene.timedOutTaskCount, 8);
  });

  it("counts receipt gaps from explicit gap projections", () => {
    const state = bridgeStateFixture({
      operator: {
        terminalReceipts: [
          {
            taskId: "task-1",
            receiptStatus: "pending",
            receiptGapStatus: "missing",
            operatorReceiptState: "pending_receipt",
            operatorReceiptLabel: "⋯ pending receipt",
            terminalAckEligible: false,
            reason: "no receipt",
          },
          {
            taskId: "task-2",
            receiptStatus: "received",
            receiptGapStatus: "confirmed",
            operatorReceiptState: "receipt_confirmed",
            operatorReceiptLabel: "✓ confirmed",
            terminalAckEligible: true,
            reason: "confirmed",
          },
        ],
      },
    });
    // The function reads from bridge state terminalReceipts when
    // no explicit term inal rece ipt gaps array is passed
    const result = projectQueueHygieneOperatorStatus(state);
    assert.equal(result.hygiene.receiptGapCount, 1);
    assert.match(result.messages[0], /receipt gap/);
  });

  it("includes GitHub evidence missing in stale count", () => {
    const state = bridgeStateFixture({
      operator: {
        githubEvidence: {
          status: "warning",
          counts: { total: 3, startSeen: 1, terminalSeen: 1, evidenceMissing: 2, warnings: 1 },
          tasks: [],
        },
      },
    });
    const result = projectQueueHygieneOperatorStatus(state);
    assert.ok(result.hygiene.staleTaskCount >= 2);
    assert.match(result.messages[0], /missing GitHub evidence/);
  });

  it("provider send success is not terminal ACK evidence (safety invariant)", () => {
    const state = bridgeStateFixture();
    const result = projectQueueHygieneOperatorStatus(state);
    // Hygiene projection must not encode terminal ack eligibility
    assert.equal(result.hygiene.unacknowledgedOutboxCount, 0);
    // No terminalAckEligible field
    assert.equal("terminalAckEligible" in result.hygiene, false);
  });
});

// ── Tests: combined operator status ─────────────────────────────────

describe("projectA2AOperatorStatus", () => {
  it("produces a valid combined operator status projection", () => {
    const state = bridgeStateFixture();
    const result = projectA2AOperatorStatus(state);
    assert.equal(result.mode, "operator-status-dryrun/no-live");
    assert.equal(result.providerSendNotAckEvidence, true);
    assert.deepEqual(result.safeOperations, {
      liveSend: false,
      terminalOutboxAck: false,
      gatewayRestart: false,
      productionDeploy: false,
      providerSend: false,
    });
  });

  it("projects broker pressure within combined status", () => {
    const state = bridgeStateFixture({
      operator: {
        snapshot: { summary: { queueDepth: 3 } },
      },
    });
    const result = projectA2AOperatorStatus(state);
    assert.equal(result.brokerPressure.status, "elevated");
    assert.equal(result.brokerPressure.pressure.queueDepth, 3);
  });

  it("projects queue hygiene within combined status", () => {
    const state = bridgeStateFixture({
      operator: {
        liveSummary: { staleTasks: 2 },
      },
    });
    const result = projectA2AOperatorStatus(state);
    assert.equal(result.queueHygiene.status, "stale");
  });

  it("no-live safety invariant: all operations false", () => {
    const state = bridgeStateFixture();
    const result = projectA2AOperatorStatus(state);
    const ops = result.safeOperations;
    assert.equal(ops.liveSend, false);
    assert.equal(ops.terminalOutboxAck, false);
    assert.equal(ops.gatewayRestart, false);
    assert.equal(ops.productionDeploy, false);
    assert.equal(ops.providerSend, false);
  });

  it("providerSendNotAckEvidence invariant is structurally enforced", () => {
    const state = bridgeStateFixture();
    const result = projectA2AOperatorStatus(state);
    // Structural invariant: the projection type has providerSendNotAckEvidence
    assert.equal(result.providerSendNotAckEvidence, true);
    // No terminal-receipt fields leak into safeOperations
    assert.equal("terminalAckEligible" in result.safeOperations, false);
  });
});

// ── Tests: extended contract receipt gaps ──────────────────────────

describe("projectTerminalReceiptGapsFromBridge", () => {
  it("returns empty array when no receipt gaps exist", () => {
    const state = bridgeStateFixture();
    const gaps = projectTerminalReceiptGapsFromBridge(state);
    assert.deepEqual(gaps, []);
  });

  it("projects receipt gaps from bridge state terminal receipts", () => {
    const state = bridgeStateFixture({
      operator: {
        terminalReceipts: [
          {
            taskId: "gap-task-1",
            receiptStatus: "pending",
            receiptGapStatus: "missing" as const,
            operatorReceiptState: "pending_receipt" as const,
            operatorReceiptLabel: "⋯ pending receipt",
            terminalAckEligible: false,
            reason: "no current-session/manual receipt",
          },
        ],
      },
    });
    const gaps = projectTerminalReceiptGapsFromBridge(state);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].taskId, "gap-task-1");
    assert.equal(gaps[0].terminalAckEligible, false);
  });

  it("skips confirmed receipts and does not report them as gaps", () => {
    const state = bridgeStateFixture({
      operator: {
        terminalReceipts: [
          {
            taskId: "confirmed-task",
            receiptStatus: "received",
            receiptGapStatus: "confirmed",
            operatorReceiptState: "receipt_confirmed",
            operatorReceiptLabel: "✓ confirmed",
            terminalAckEligible: true,
            reason: "confirmed",
          },
        ],
      },
    });
    const gaps = projectTerminalReceiptGapsFromBridge(state);
    assert.equal(gaps.length, 0, "confirmed receipts must not be projected as gaps");
  });
});
