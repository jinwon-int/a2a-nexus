import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createA2AOperatorEventBridge } from "../dist/src/operator-event-bridge.js";
import type { A2ATerminalOutboxEvent } from "../dist/standalone-broker-client.js";

function terminalEvent(id: string): A2ATerminalOutboxEvent {
  return {
    id,
    type: "terminal.brief",
    status: "succeeded",
    createdAt: "2026-05-17T00:05:00.000Z",
    updatedAt: "2026-05-17T00:05:00.000Z",
    attempts: 0,
    payload: {
      status: "succeeded",
      worker: "sogyo",
      completedAt: "2026-05-17T00:05:00.000Z",
      summary: "dedupe regression should notify the operator once",
      parentRoundProgress: 1,
      parentRoundTotal: 1,
    },
    receipt: { status: "accepted", updatedAt: "2026-05-17T00:05:00.000Z" },
    ackAudit: {
      decision: "pending",
      reason: "terminal event accepted; awaiting current-session-visible/operator-visible evidence before ACK",
      updatedAt: "2026-05-17T00:05:00.000Z",
      worker: "sogyo",
      receiptStatus: "accepted",
    },
    ack: null,
    deliveredAt: null,
  } as A2ATerminalOutboxEvent;
}

async function* emptyOperatorStream() {
  // No stream events needed; this regression exercises the terminal-outbox poller.
}

describe("operator event bridge terminal outbox notification dedupe", () => {
  it("suppresses semantically identical Terminal Brief rows when taskId is missing", async () => {
    const first = terminalEvent("terminal:dedupe-regression-a:succeeded:2026-05-17T00%3A05%3A00.000Z");
    const second = terminalEvent("terminal:dedupe-regression-b:succeeded:2026-05-17T00%3A05%3A00.000Z");
    const notifications: unknown[] = [];
    const acked: unknown[] = [];
    let listed = false;

    const bridge = createA2AOperatorEventBridge({
      now: () => Date.parse("2026-05-17T00:00:00.000Z"),
      waitForRetry: async () => {
        throw new Error("stop test loop");
      },
      terminalOutboxCursor: "terminal:previous:succeeded:2026-05-17T00%3A00%3A00.000Z",
      terminalOutboxReconcileUnackedOnStart: false,
      terminalOutboxAllowedIds: ["terminal:dedupe-regression"],
      broker: {
        async *streamOperatorEvents() {
          yield* emptyOperatorStream();
        },
        async listTerminalOutbox() {
          if (listed) {
            return { events: [], cursor: second.id };
          }
          listed = true;
          return { events: [first, second], cursor: second.id };
        },
        async ackTerminalOutbox(params) {
          acked.push(params);
          return {
            ...first,
            ack: { status: "receipt_confirmed", evidence: params.receipt.evidence, updatedAt: params.receipt.acknowledgedAt },
          } as A2ATerminalOutboxEvent;
        },
      },
      notifyOperator: async (envelope) => {
        notifications.push(envelope);
        return {
          ackTerminalEvent: true,
          confirmationSource: "current_session_visible",
          reason: "test receipt",
          receiptId: "telegram:message:dedupe",
        };
      },
    });

    bridge.getState();
    await bridge.waitForIdle();
    bridge.shutdown();

    assert.equal(notifications.length, 1, "duplicate semantic Terminal Brief rows must send one operator notification");
    assert.equal(acked.length, 2, "both outbox rows should be ACKed after the duplicate is suppressed");
  });
});
