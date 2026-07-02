import assert from "node:assert/strict";
import { test } from "node:test";
import { runReceiptGateCanaryMatrix } from "./receipt-gate-canary.js";
import {
  analyzeBrokerTerminalReceiptSnapshot,
  compareBrokerTerminalReceiptParity,
  renderBrokerTerminalReceiptParityMarkdown,
} from "./broker-terminal-receipt-parity.js";

function outbox(events: unknown[]) {
  return {
    kind: "task.terminal.outbox",
    count: events.length,
    cursor: events.at(-1) && typeof events.at(-1) === "object" ? "cursor" : null,
    events,
  };
}

test("broker terminal receipt parity accepts provider-sent rows only as unacked receipt gaps", () => {
  const brokeralpha = analyzeBrokerTerminalReceiptSnapshot("brokeralpha", outbox([
    {
      id: "terminal:brokeralpha:1",
      receipt: { status: "provider_sent", updatedAt: "2026-05-11T00:00:00.000Z" },
      payload: { worker: "workerepsilon", doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/493#issuecomment-brokeralpha" },
    },
  ]));
  const brokerbeta = analyzeBrokerTerminalReceiptSnapshot("brokerbeta", outbox([
    {
      id: "terminal:brokerbeta:1",
      ack: { status: "receipt_confirmed", evidence: "operator_visible" },
      receipt: { status: "operator_visible", evidence: "operator_visible", updatedAt: "2026-05-11T00:00:01.000Z" },
      payload: { worker: "workerepsilon", doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/493#issuecomment-brokerbeta" },
    },
  ]));

  assert.equal(brokeralpha.blockers.length, 0);
  assert.equal(brokeralpha.buckets.send_accepted_no_receipt, 1);
  assert.equal(brokerbeta.blockers.length, 0);
  assert.equal(brokerbeta.buckets.receipt_confirmed, 1);

  const report = compareBrokerTerminalReceiptParity({
    brokeralpha,
    brokerbeta,
    receiptGateCanary: runReceiptGateCanaryMatrix({ generatedAt: "2026-05-11T00:00:00.000Z" }),
  });

  assert.equal(report.ok, true);
  assert.match(renderBrokerTerminalReceiptParityMarkdown(report), /providerCalled=false/);
  assert.match(report.fixProposals.join("\n"), /rerun terminal_outbox_preflight/);
});

test("broker terminal receipt parity blocks receipt-confirmed rows without receipt evidence", () => {
  const brokeralpha = analyzeBrokerTerminalReceiptSnapshot("brokeralpha", outbox([]));
  const brokerbeta = analyzeBrokerTerminalReceiptSnapshot("brokerbeta", outbox([
    {
      id: "terminal:brokerbeta:bad-ack",
      ack: { status: "receipt_confirmed", evidence: "provider_sent" },
      receipt: { status: "provider_sent", evidence: "provider_sent" },
      payload: { doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/493#issuecomment-provider-sent" },
    },
  ]));

  const report = compareBrokerTerminalReceiptParity({
    brokeralpha,
    brokerbeta,
    receiptGateCanary: runReceiptGateCanaryMatrix({ generatedAt: "2026-05-11T00:00:00.000Z" }),
  });

  assert.equal(brokerbeta.blockers.length, 1);
  assert.equal(report.ok, false);
  assert.match(report.fixProposals.join("\n"), /receipt_confirmed ACK requires/);
});

test("broker terminal receipt parity blocks non-http evidence on unacked terminal rows", () => {
  const summary = analyzeBrokerTerminalReceiptSnapshot("brokeralpha", outbox([
    {
      id: "terminal:unsafe",
      receipt: { status: "accepted" },
      payload: { doneUrl: "file:///tmp/private.log" },
    },
  ]));

  assert.equal(summary.unsafeEvidenceUrlCount, 1);
  assert.match(summary.blockers.join("\n"), /evidence URL must be http\(s\)/);
});
