// #2606: the spec (JSON-RPC) task projection carries a public-safe checkpoint
// summary; the legacy/REST projection does not change.

import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryA2ABroker } from "../core/broker.js";
import { registerWorker } from "../core/broker-test-helpers.js";
import { createBrokerAgentCard } from "./agent-card.js";
import { executeA2AJsonRpc, projectSpecTask, specCheckpointSummary } from "./json-rpc.js";
import { projectBrokerTask } from "./task-projection.js";

const agentCard = createBrokerAgentCard({ serviceName: "test-broker", publicBaseUrl: "https://broker.test/" });
const REQUESTER = { id: "node-a", kind: "node", role: "analyst" } as const;

function checkpointedTask(decisionType?: string) {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");
  const task = broker.createTask({
    intent: "analyze",
    requester: REQUESTER,
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "read-only analysis",
  });
  broker.claimTask(task.id, "worker-a");
  broker.startTask(task.id, "worker-a");
  broker.checkpointTask(task.id, "worker-a", {
    state: "awaiting_operator",
    checkpointId: "cp-42",
    reason: "SECRET-REASON-TEXT",
    artifactRefs: ["docs/private-note.md"],
    ...(decisionType ? { decisionType } : {}),
  });
  return { broker, task: broker.getTask(task.id)! };
}

function getTask(broker: InMemoryA2ABroker, id: string, responseShape: "spec" | "legacy") {
  const response = executeA2AJsonRpc(
    { jsonrpc: "2.0", id: 1, method: "GetTask", params: { id } },
    { broker, agentCard, requesterIdentity: REQUESTER, enforceRequesterIdentity: true, responseShape },
  );
  assert.ok("result" in response, JSON.stringify(response));
  return response.result as Record<string, unknown>;
}

test("#2606 spec GetTask carries exactly state, checkpointId, decisionType, recordedAt", () => {
  const { broker, task } = checkpointedTask("ambiguous_scope");
  const metadata = getTask(broker, task.id, "spec").metadata as Record<string, unknown>;
  const summary = metadata.checkpoint as Record<string, unknown>;
  assert.deepEqual(Object.keys(summary).sort(), ["checkpointId", "decisionType", "recordedAt", "state"]);
  assert.deepEqual(summary, {
    state: "awaiting_operator",
    checkpointId: "cp-42",
    decisionType: "ambiguous_scope",
    recordedAt: task.checkpoint!.recordedAt,
  });
});

test("#2606 the summary never carries the reason text, artifact refs, or recordedBy", () => {
  for (const decisionType of [undefined, "approval_required", "safety_gate", "ambiguous_scope"]) {
    const { broker, task } = checkpointedTask(decisionType);
    const spec = JSON.stringify(getTask(broker, task.id, "spec").metadata);
    assert.doesNotMatch(spec, /SECRET-REASON-TEXT|private-note|recordedBy/, String(decisionType));
    assert.deepEqual(specCheckpointSummary(task)!.checkpointId, "cp-42");
  }
});

test("#2606 the legacy projection is unchanged and a task without a checkpoint has no summary", () => {
  const { broker, task } = checkpointedTask("approval_required");
  const legacy = getTask(broker, task.id, "legacy") as { task: { metadata: Record<string, unknown> } };
  assert.ok(!("checkpoint" in legacy.task.metadata));
  assert.deepEqual(Object.keys(projectBrokerTask(task).metadata).sort(), Object.keys(legacy.task.metadata).sort());

  const plain = new InMemoryA2ABroker();
  registerWorker(plain, "worker-a");
  const queued = plain.createTask({ intent: "analyze", requester: REQUESTER, target: { id: "worker-a", kind: "node", role: "analyst" }, message: "x" });
  assert.equal(specCheckpointSummary(queued), undefined);
  assert.ok(!("checkpoint" in (projectSpecTask(queued, plain).metadata as Record<string, unknown>)));
});

test("#2606 resolving the checkpoint removes the summary", () => {
  const { broker, task } = checkpointedTask("ambiguous_scope");
  broker.resumeTask(task.id, REQUESTER.id, { actorRole: REQUESTER.role });
  const metadata = getTask(broker, task.id, "spec").metadata as Record<string, unknown>;
  assert.ok(!("checkpoint" in metadata));
});
