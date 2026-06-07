import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createA2AOperatorEventBridge } from "../dist/src/operator-event-bridge.js";
import type { A2ATerminalOutboxEvent } from "../dist/standalone-broker-client.js";

function terminalEvent(): A2ATerminalOutboxEvent {
  return {
    id: "terminal:relay-success-canary:succeeded:2026-05-14T10%3A44%3A49.752Z",
    type: "terminal.brief",
    status: "succeeded",
    createdAt: "2026-05-14T10:44:49.757Z",
    updatedAt: "2026-05-14T10:44:49.757Z",
    attempts: 0,
    payload: {
      taskId: "relay-success-canary",
      status: "succeeded",
      worker: "soonwook",
      completedAt: "2026-05-14T10:44:49.752Z",
      summary: "relay success should suppress duplicate child local operator notification",
      parentRoundId: "terminal-brief-r19-parent-seeded-seoseo-20260514",
      originBrokerId: "gwakga",
      brokerOfRecordId: "seoseo",
      parentRoundOrder: 1,
      parentRoundTotal: 1,
      parentOwnedTerminalBrief: true,
      operatorFacingOwner: "parent",
      notificationOwnership: {
        ownerBrokerId: "seoseo",
        scope: "parent-broker-only",
        providerSendPermittedByProjection: false,
        terminalAckPermittedByProjection: false,
      },
      crossBrokerHandoff: {
        parentRoundId: "terminal-brief-r19-parent-seeded-seoseo-20260514",
        originBrokerId: "seoseo",
        handoffBrokerId: "gwakga",
        originTaskId: "relay-success-canary",
        childWorkerId: "soonwook",
      },
    },
    receipt: { status: "accepted", updatedAt: "2026-05-14T10:44:49.757Z" },
    ackAudit: {
      decision: "pending",
      reason: "terminal event accepted; awaiting current-session-visible/operator-visible/provider-delivery evidence before ACK",
      updatedAt: "2026-05-14T10:44:49.757Z",
      taskId: "relay-success-canary",
      worker: "soonwook",
      receiptStatus: "accepted",
    },
    ack: null,
    deliveredAt: null,
  } as A2ATerminalOutboxEvent;
}

async function* emptyOperatorStream() {
  // No stream events needed; this regression exercises the terminal-outbox poller.
}

describe("operator event bridge terminal outbox cross-broker relay success", () => {
  it("suppresses duplicate child-local operator notification after successful parent relay", async () => {
    const event = terminalEvent();
    const notifications: unknown[] = [];
    const acked: unknown[] = [];
    const projections: Record<string, unknown>[] = [];
    let listed = false;

    const bridge = createA2AOperatorEventBridge({
      now: () => Date.parse("2026-05-14T10:44:00.000Z"),
      waitForRetry: async () => {
        throw new Error("stop test loop");
      },
      terminalOutboxCursor: "terminal:previous:succeeded:2026-05-14T10%3A40%3A00.000Z",
      terminalOutboxReconcileUnackedOnStart: false,
      terminalOutboxAllowedIds: ["terminal:relay-success-canary"],
      broker: {
        async *streamOperatorEvents() {
          yield* emptyOperatorStream();
        },
        async listTerminalOutbox() {
          if (listed) {
            return { events: [], cursor: event.id };
          }
          listed = true;
          return { events: [event], cursor: event.id };
        },
        async ackTerminalOutbox(params) {
          acked.push(params);
          return { ...event, ack: { status: "receipt_confirmed", evidence: params.receipt.evidence, updatedAt: params.receipt.acknowledgedAt } } as A2ATerminalOutboxEvent;
        },
      },
      relayTerminalProjection: async (projection) => {
        projections.push(projection);
        return { decision: "accepted", reason: "parent broker accepted projection" };
      },
      handoffBrokerId: "gwakga",
      notifyOperator: async (envelope) => {
        notifications.push(envelope);
        return {
          ackTerminalEvent: true,
          confirmationSource: "current_session_visible",
          reason: "test receipt",
          receiptId: "telegram:message:should-not-send",
        };
      },
    });

    bridge.getState();
    await bridge.waitForIdle();
    const state = bridge.getState();
    bridge.shutdown();

    assert.equal(projections.length, 1, "relay success must emit one parent projection");
    assert.equal(projections[0]?.parentRoundId, "terminal-brief-r19-parent-seeded-seoseo-20260514");
    assert.equal(projections[0]?.originBrokerId, "gwakga", "child/handoff broker remains explicit");
    assert.equal(projections[0]?.brokerOfRecordId, "seoseo");
    assert.equal(projections[0]?.parentOriginBrokerId, "seoseo");
    assert.equal(projections[0]?.parentBrokerId, "seoseo");
    assert.equal(notifications.length, 0, "successful relay must suppress duplicate child-local notification");
    assert.equal(acked.length, 0, "child broker must not ACK a parent-owned Terminal Brief after relay success");
    assert.equal(state.operator.terminalOutbox?.crossBrokerRelay?.status, "succeeded");
    assert.equal(state.operator.terminalOutbox?.lastEvent?.attempts, 0);
  });
});
