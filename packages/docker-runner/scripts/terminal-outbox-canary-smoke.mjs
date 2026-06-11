#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildTerminalAckDecision,
  buildTerminalEvidenceEvent,
  parseRunnerOutput,
} from "../dist/integration.js";

const fixturePath = resolve(
  process.cwd(),
  process.argv[2] ?? "examples/terminal-outbox-canary-nosuk-20260511.json",
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

assert.equal(fixture.run, "terminal-brief-activation-20260511T080211Z");
assert.equal(fixture.worker, "nosuk");
assert.equal(fixture.canaryContract.noLiveProviderSend, true);
assert.equal(
  fixture.canaryContract.providerSendSuccessIsReceiptEvidence,
  false,
);
assert.equal(fixture.canaryContract.terminalOutboxAckPerformed, false);

const artifacts = [];
const seenTerminalOutboxIds = new Set();

for (const entry of fixture.cases) {
  const event = buildTerminalEvidenceEvent(
    parseRunnerOutput(JSON.stringify(entry.runnerOutput)),
    entry.handlerTask,
    fixture.worker,
    fixture.emittedAt,
  );

  const ackDecision = buildTerminalAckDecision(event, entry.receipt);
  if (entry.providerSendSuccessOnly) {
    // Provider send success alone is never receipt evidence: the receipt must
    // not be operator-visible and the decision must refuse to acknowledge,
    // independent of what the fixture's `expected` block says.
    assert.equal(
      entry.receipt.operatorVisible,
      false,
      `${entry.name}: provider-send-success-only receipt must not be operator-visible`,
    );
    assert.equal(
      ackDecision.acknowledged,
      false,
      `${entry.name}: provider send success alone must never acknowledge`,
    );
  }

  // Validate evidence kind and status
  assert.equal(event.evidenceKind, entry.expected.evidenceKind, entry.name);
  assert.equal(event.status, entry.expected.status, entry.name);

  // Validate terminal-outbox ack decision
  assert.equal(
    ackDecision.acknowledged,
    entry.expected.acknowledged,
    `${entry.name}: ack mismatch`,
  );
  assert.equal(
    ackDecision.cursorComplete,
    entry.expected.cursorComplete,
    `${entry.name}: cursor mismatch`,
  );

  // Every case carries a non-empty, unique terminal outbox id.
  assert.ok(
    typeof entry.terminalOutboxId === "string" && entry.terminalOutboxId.length > 0,
    `${entry.name}: missing terminalOutboxId`,
  );
  assert.ok(
    !seenTerminalOutboxIds.has(entry.terminalOutboxId),
    `${entry.name}: duplicate terminalOutboxId ${entry.terminalOutboxId}`,
  );
  seenTerminalOutboxIds.add(entry.terminalOutboxId);

  // Serialize and check for leaks
  const serialized = JSON.stringify({ event, ackDecision });
  for (const forbidden of fixture.mustNotContain ?? []) {
    assert.ok(
      !serialized.includes(forbidden),
      `${entry.name} leaked forbidden value: ${forbidden}`,
    );
  }

  artifacts.push({
    name: entry.name,
    taskId: event.taskId,
    terminalOutboxId: entry.terminalOutboxId,
    evidenceKind: event.evidenceKind,
    status: event.status,
    acknowledged: ackDecision.acknowledged,
    cursorComplete: ackDecision.cursorComplete,
  });
}

// Smoke must include both provider-send-only rejection AND receipt-confirmed ack
assert.ok(
  artifacts.some((a) => a.acknowledged === false),
  "must include a provider-send-only blocked ACK case",
);
assert.ok(
  artifacts.some((a) => a.acknowledged === true),
  "must include a receipt-confirmed ACK case",
);

assert.equal(fixture.canaryContract.terminalOutboxAckPerformed, false);

const result = {
  ok: true,
  fixture: fixturePath,
  run: fixture.run,
  worker: fixture.worker,
  issue: fixture.issue,
  terminalOutboxAckPerformed: false,
  artifacts,
};

console.log(JSON.stringify(result, null, 2));
