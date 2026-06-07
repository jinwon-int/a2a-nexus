import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createA2AOperatorEventBridge } from "../dist/src/operator-event-bridge.js";
import type { A2ATerminalOutboxEvent } from "../dist/standalone-broker-client.js";

function terminalEvent(): A2ATerminalOutboxEvent {
  return {
    id: "terminal:relay-failure-canary:succeeded:2026-05-14T10%3A34%3A49.752Z",
    type: "terminal.brief",
    status: "succeeded",
    createdAt: "2026-05-14T10:34:49.757Z",
    updatedAt: "2026-05-14T10:34:49.757Z",
    attempts: 0,
    payload: {
      taskId: "relay-failure-canary",
      status: "succeeded",
      worker: "soonwook",
      completedAt: "2026-05-14T10:34:49.752Z",
      summary: "relay failure should still allow local operator notification",
      parentRoundId: "terminal-brief-r16-live-canary-20260514",
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
        parentRoundId: "terminal-brief-r16-live-canary-20260514",
        originBrokerId: "seoseo",
        handoffBrokerId: "gwakga",
        originTaskId: "relay-failure-canary",
        childWorkerId: "soonwook",
      },
    },
    receipt: { status: "accepted", updatedAt: "2026-05-14T10:34:49.757Z" },
    ackAudit: {
      decision: "pending",
      reason: "terminal event accepted; awaiting current-session-visible/operator-visible/provider-delivery evidence before ACK",
      updatedAt: "2026-05-14T10:34:49.757Z",
      taskId: "relay-failure-canary",
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

describe("operator event bridge terminal outbox cross-broker relay failure", () => {
  it("keeps parent-owned handoff rows local-suppressed when cross-broker relay fails", async () => {
    const event = terminalEvent();
    const notifications: unknown[] = [];
    const acked: unknown[] = [];
    let listed = false;

    const bridge = createA2AOperatorEventBridge({
      now: () => Date.parse("2026-05-14T10:34:00.000Z"),
      waitForRetry: async () => {
        throw new Error("stop test loop");
      },
      terminalOutboxCursor: "terminal:previous:succeeded:2026-05-14T10%3A30%3A00.000Z",
      terminalOutboxReconcileUnackedOnStart: false,
      terminalOutboxAllowedIds: ["terminal:relay-failure-canary"],
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
      relayTerminalProjection: async () => {
        throw new Error("origin broker rejected projection");
      },
      handoffBrokerId: "gwakga",
      notifyOperator: async (envelope) => {
        notifications.push(envelope);
        return {
          ackTerminalEvent: true,
          confirmationSource: "current_session_visible",
          reason: "test receipt",
          receiptId: "telegram:message:canary",
        };
      },
    });

    bridge.getState();
    await bridge.waitForIdle();
    const state = bridge.getState();
    bridge.shutdown();

    assert.equal(notifications.length, 0, "parent-owned relay failure must not fall back to child-local notification");
    assert.equal(acked.length, 0, "child broker must not ACK parent-owned Terminal Brief rows");
    assert.equal(state.operator.terminalOutbox?.crossBrokerRelay?.status, "failed");
    assert.equal(state.operator.terminalOutbox?.lastEvent?.attempts, 0);
  });
});
