import assert from "node:assert/strict";
import test from "node:test";

import { createBrokerAgentCard } from "../../a2a/agent-card.js";
import { mapA2AJsTaskStateToBrokerEvidence, mapAgentCardToWorkerRegistration } from "./standard-sdk-adapter.js";

test("a2a-js adapter maps public agent cards to safe worker registrations", () => {
  const card = createBrokerAgentCard({ serviceName: "External SDK Worker", publicBaseUrl: "http://127.0.0.1:8787", supportsStreaming: true });
  const worker = mapAgentCardToWorkerRegistration(card);
  assert.equal(worker.nodeId, "a2a-js-external-sdk-worker");
  assert.equal(worker.role, "analyst");
  assert.equal(worker.runtimeFlavor, "a2a-js");
  assert.equal(worker.capabilities.canStream, true);
  assert.equal(worker.metadata.sdk, "a2aproject/a2a-js");
});

test("a2a-js adapter maps task states without bypassing terminal evidence gates", () => {
  assert.deepEqual(mapA2AJsTaskStateToBrokerEvidence("completed"), { outcome: "done", terminal: true, reason: "a2a-js task completed" });
  assert.equal(mapA2AJsTaskStateToBrokerEvidence("working").terminal, false);
  assert.equal(mapA2AJsTaskStateToBrokerEvidence("input-required").outcome, "blocked");
  assert.equal(mapA2AJsTaskStateToBrokerEvidence("unknown").outcome, "blocked");
});
