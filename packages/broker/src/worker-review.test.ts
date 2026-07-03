import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { InMemoryA2ABroker } from "./core/broker.js";
import { emptySnapshot, type BrokerStateStore } from "./core/store.js";
import { createBrokerServer } from "./server.js";
import { validateTaskCompletionEvidence } from "./worker.js";
import { normalizeTaskResult } from "./core/broker-task-record-normalizers.js";
import type { TaskRecord } from "./core/types.js";

const EDGE_SECRET = "review-test-edge-secret";

function taskWith(payload: Record<string, unknown>, assignedWorkerId = "author-a"): TaskRecord {
  return {
    id: "task-review-1",
    intent: "analyze",
    status: "running",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: assignedWorkerId, kind: "node", role: "analyst" },
    targetNodeId: assignedWorkerId,
    assignedWorkerId,
    claimedBy: assignedWorkerId,
    payload,
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
  } as unknown as TaskRecord;
}

function registerAuthorWorker(broker: InMemoryA2ABroker): void {
  broker.registerWorker({
    nodeId: "author-a",
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
    },
  });
}

function createBrokerTask(payload: Record<string, unknown>) {
  const broker = new InMemoryA2ABroker();
  registerAuthorWorker(broker);
  const task = broker.createTask({
    intent: "analyze",
    message: "review-required task",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "author-a", kind: "node", role: "analyst" },
    assignedWorkerId: "author-a",
    payload,
  });
  broker.claimTask(task.id, "author-a");
  broker.startTask(task.id, "author-a");
  return { broker, task };
}

function createInMemoryStateStore(): BrokerStateStore {
  let snapshot = emptySnapshot();
  return {
    load: () => snapshot,
    save: (next) => {
      snapshot = structuredClone(next);
    },
  };
}

async function startReviewServer() {
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: createInMemoryStateStore(),
    edgeSecret: EDGE_SECRET,
    staleReaperEnabled: false,
  });
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  const address = runtime.server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind test server");
  return {
    runtime,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      runtime.server.close();
      await once(runtime.server, "close");
    },
  };
}

test("review evidence: missing verdict rejects opt-in review.required tasks", () => {
  const error = validateTaskCompletionEvidence(taskWith({ review: { required: true } }), { summary: "done" });
  assert.equal(error?.code, "review_evidence_missing");
});

test("review evidence: reviewer must be independent from author worker", () => {
  const error = validateTaskCompletionEvidence(taskWith({ review: { required: true } }), {
    validation: { nodeId: "author-a", kind: "review", verdict: "pass", note: "looks good" },
  });
  assert.equal(error?.code, "review_not_independent");
});

test("review evidence: failed verdict rejects completion", () => {
  const error = validateTaskCompletionEvidence(taskWith({ review: { required: true } }), {
    validation: { nodeId: "reviewer-b", kind: "review", verdict: "fail", note: "scope mismatch" },
  });
  assert.equal(error?.code, "review_verdict_failed");
});

test("review evidence: validation kind must be review", () => {
  const error = validateTaskCompletionEvidence(taskWith({ review: { required: true } }), {
    validation: { nodeId: "reviewer-b", kind: "smoke", verdict: "pass", note: "wrong validation kind" },
  });
  assert.equal(error?.code, "review_evidence_missing");
});

test("review evidence: independent pass satisfies opt-in gate", () => {
  const error = validateTaskCompletionEvidence(taskWith({ review: { required: true } }), {
    validation: { nodeId: "reviewer-b", kind: "review", verdict: "pass", note: "diff matches spec" },
  });
  assert.equal(error, null);
});

test("review evidence: validations array selects the review item (#1249)", () => {
  const error = validateTaskCompletionEvidence(taskWith({ review: { required: true } }), {
    validations: [
      { kind: "smoke", verdict: "pass", metrics: { acceptance: true }, note: "acceptance passed" },
      { nodeId: "reviewer-b", kind: "review", verdict: "pass", note: "diff matches spec" },
    ],
  });
  assert.equal(error, null);
});

test("review evidence: validations array without review item rejects review.required (#1249)", () => {
  const error = validateTaskCompletionEvidence(taskWith({ review: { required: true } }), {
    validations: [{ kind: "smoke", verdict: "pass", metrics: { acceptance: true }, note: "acceptance passed" }],
  });
  assert.equal(error?.code, "review_evidence_missing");
  assert.match(error?.message ?? "", /result\.validations.*review/);
});

test("completion evidence: combined acceptance and review accepts separate validations (#1249)", () => {
  const error = validateTaskCompletionEvidence(taskWith({ acceptance: { command: [process.execPath, "-e", "process.exit(0)"] }, review: { required: true } }), {
    validations: [
      { kind: "smoke", verdict: "pass", metrics: { acceptance: true }, note: "acceptance passed" },
      { nodeId: "reviewer-b", kind: "review", verdict: "pass", note: "diff matches spec" },
    ],
  });
  assert.equal(error, null);
});

test("completion evidence: combined acceptance and review rejects review-only validations (#1249)", () => {
  const error = validateTaskCompletionEvidence(taskWith({ acceptance: { command: [process.execPath, "-e", "process.exit(0)"] }, review: { required: true } }), {
    validations: [{ nodeId: "reviewer-b", kind: "review", verdict: "pass", note: "review only" }],
  });
  assert.equal(error?.code, "acceptance_evidence_missing");
});

test("task result normalizer preserves validations array artifact evidence (#1249)", () => {
  const normalized = normalizeTaskResult({
    validations: [
      { kind: "smoke", verdict: "pass", artifactIds: ["artifact-a", "artifact-a"], metrics: { acceptance: true } },
      { nodeId: "reviewer-b", kind: "review", verdict: "pass", artifactIds: ["artifact-b"], note: "review passed" },
    ],
  });
  assert.deepEqual(normalized.validations?.map((validation) => validation.artifactIds), [["artifact-a"], ["artifact-b"]]);
});

test("review evidence: unspecified review remains a no-op", () => {
  const error = validateTaskCompletionEvidence(taskWith({}), { summary: "done" });
  assert.equal(error, null);
});

test("broker completeTask rejects review.required missing evidence before succeeded transition", () => {
  const { broker, task } = createBrokerTask({ review: { required: true } });
  assert.throws(
    () => broker.completeTask(task.id, "author-a", { summary: "done without review" }),
    (error) => typeof error === "object" && error !== null && "code" in error && error.code === "review_evidence_missing",
  );
  assert.equal(broker.getTask(task.id)?.status, "running");
});

test("broker completeTask accepts independent passing review evidence", () => {
  const { broker, task } = createBrokerTask({ review: { required: true } });
  const completed = broker.completeTask(task.id, "author-a", {
    summary: "done with review",
    validation: { nodeId: "reviewer-b", kind: "review", verdict: "pass", note: "diff matches spec" },
  });
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.result?.validation?.nodeId, "reviewer-b");
});

test("server complete route rejects review.required missing evidence", async () => {
  const server = await startReviewServer();
  try {
    const { task } = createBrokerTask({ review: { required: true } });
    server.runtime.broker.registerWorker({
      nodeId: "author-a",
      role: "analyst",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ["test"],
        environments: ["research"],
      },
    });
    const serverTask = server.runtime.broker.createTask({
      id: task.id,
      intent: "analyze",
      message: "review-required HTTP task",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "author-a", kind: "node", role: "analyst" },
      assignedWorkerId: "author-a",
      payload: { review: { required: true } },
    });
    server.runtime.broker.claimTask(serverTask.id, "author-a");
    server.runtime.broker.startTask(serverTask.id, "author-a");

    const response = await fetch(`${server.baseUrl}/tasks/${serverTask.id}/complete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-edge-secret": EDGE_SECRET,
        "x-a2a-requester-id": "author-a",
        "x-a2a-requester-role": "analyst",
      },
      body: JSON.stringify({ workerId: "author-a", result: { summary: "done without review" } }),
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.error?.code, "review_evidence_missing");
    assert.equal(server.runtime.broker.getTask(serverTask.id)?.status, "running");
  } finally {
    await server.close();
  }
});
