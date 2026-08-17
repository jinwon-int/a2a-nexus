// #1815 item 5: negative-verdict evidence preservation. When an
// acceptance-review lane fails its verdict gate (review_verdict_failed), the
// SUBMITTED result must survive on the task record so operators read the
// BLOCK findings without re-dispatching the same source to a diagnostic lane.
// The gate semantics are unchanged: the task still fails with the same error;
// only the evidence is no longer destroyed.
import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryA2ABroker } from "./broker.js";
import { extractReviewVerdict } from "../worker-review.js";
import type { TaskRecord } from "./types.js";

const AUTHOR = "author-node";
const REVIEWER = "worker-reviewer";

function reviewTask(broker: InMemoryA2ABroker, overrides: Record<string, unknown> = {}): TaskRecord {
  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: REVIEWER, kind: "node", role: "analyst" },
    payload: {
      review: { required: true, authorWorkerId: AUTHOR },
      ...overrides,
    },
  });
  broker.claimTask(task.id, REVIEWER);
  broker.startTask(task.id, REVIEWER);
  return broker.getTask(task.id) ?? task;
}

function failResult(verdict: "fail" | "pass", nodeId = "reviewer-x"): Record<string, unknown> {
  return {
    summary: "BLOCK: 정답 유일성 실패 — 문항 2의 보기 C도 정답이 될 수 있다",
    output: { findings: [{ severity: "critical", item: "RN-CASE-2", note: "duplicate key" }] },
    validations: [
      { kind: "review", nodeId, verdict, note: "정답 유일성 위반" },
    ],
  };
}

function setupWorker(broker: InMemoryA2ABroker): void {
  broker.registerWorker({
    nodeId: REVIEWER,
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["ws1"],
      environments: ["research"],
    },
    metadata: {},
  });
}

test("failTask with the held result preserves negativeVerdictEvidence on review_verdict_failed", () => {
  const broker = new InMemoryA2ABroker();
  setupWorker(broker);
  const task = reviewTask(broker);
  const held = failResult("fail");

  broker.failTask(task.id, REVIEWER, { code: "review_verdict_failed", message: 'task review verdict is "fail" (requires "pass")' }, {
    negativeVerdictResult: held as never,
  });

  const failed = broker.getTask(task.id)!;
  assert.equal(failed.status, "failed", "gate unchanged: the task still fails");
  assert.equal(failed.error?.code, "review_verdict_failed");
  const evidence = failed.negativeVerdictEvidence!;
  assert.ok(evidence, "evidence preserved");
  assert.equal(evidence.reviewerNodeId, "reviewer-x");
  assert.equal(evidence.verdict, "fail");
  assert.match(evidence.result.summary ?? "", /BLOCK/);
  assert.equal(evidence.result.validations?.[0]?.kind, "review");
  assert.ok(evidence.recordedAt);
});

test("completeTask with a fail verdict throws AND preserves the submitted result", () => {
  const broker = new InMemoryA2ABroker();
  setupWorker(broker);
  const task = reviewTask(broker);

  assert.throws(
    () => broker.completeTask(task.id, REVIEWER, failResult("fail") as never),
    (error: unknown) => (error as { code?: string }).code === "review_verdict_failed",
  );

  const record = broker.getTask(task.id)!;
  // The task is NOT failed yet (the worker still owns the transition), but the
  // evidence is already durable — a later failTask cannot destroy it.
  assert.equal(record.negativeVerdictEvidence?.verdict, "fail");
  assert.equal(record.negativeVerdictEvidence?.reviewerNodeId, "reviewer-x");
  assert.match(record.negativeVerdictEvidence?.result.summary ?? "", /BLOCK/);
  assert.ok(
    broker.listAuditEvents().some((event) => event.action === "task.negative_verdict_preserved" && event.targetId === task.id),
    "digest-free preservation audit recorded",
  );
});

test("evidence is NOT attached when the failure is not the verdict gate or no verdict exists", () => {
  const broker = new InMemoryA2ABroker();
  setupWorker(broker);
  const task = reviewTask(broker);

  // Different error code with a result attached — must not store evidence.
  broker.failTask(task.id, REVIEWER, { code: "worker_crashed", message: "boom" }, {
    negativeVerdictResult: failResult("fail") as never,
  });
  assert.equal(broker.getTask(task.id)?.negativeVerdictEvidence, undefined);

  // Verdict-gate error but the held result carries no review validation.
  const task2 = reviewTask(broker, {});
  const another = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: REVIEWER, kind: "node", role: "analyst" },
    payload: { review: { required: true, authorWorkerId: AUTHOR } },
  });
  broker.claimTask(another.id, REVIEWER);
  broker.startTask(another.id, REVIEWER);
  broker.failTask(another.id, REVIEWER, { code: "review_verdict_failed", message: "gate" }, {
    negativeVerdictResult: { summary: "no review payload" } as never,
  });
  assert.equal(broker.getTask(another.id)?.negativeVerdictEvidence, undefined);
  void task2;
});

test("negativeVerdictEvidence survives snapshot save/load (task schema passthrough)", () => {
  const broker = new InMemoryA2ABroker();
  setupWorker(broker);
  const task = reviewTask(broker);
  broker.failTask(task.id, REVIEWER, { code: "review_verdict_failed", message: "gate" }, {
    negativeVerdictResult: failResult("fail") as never,
  });
  const snapshot = broker.exportSnapshot();
  assert.ok(snapshot.tasks.some((record) => record.negativeVerdictEvidence?.verdict === "fail"));

  const revived = new InMemoryA2ABroker({ save: () => {} } as never, snapshot);
  const revivedTask = revived.getTask(task.id)!;
  assert.equal(revivedTask.negativeVerdictEvidence?.verdict, "fail");
  assert.equal(revivedTask.negativeVerdictEvidence?.result.validations?.[0]?.nodeId, "reviewer-x");
});

test("extractReviewVerdict returns the reviewer and verdict only for review-shaped evidence", () => {
  assert.deepEqual(extractReviewVerdict(failResult("fail") as never), { reviewerNodeId: "reviewer-x", verdict: "fail" });
  assert.equal(extractReviewVerdict({ summary: "x" } as never), undefined);
  assert.equal(extractReviewVerdict(undefined), undefined);
  assert.equal(
    extractReviewVerdict({ validations: [{ kind: "smoke", nodeId: "n", verdict: "pass" }] } as never),
    undefined,
  );
});

test("a pass verdict still succeeds with no evidence field", () => {
  const broker = new InMemoryA2ABroker();
  setupWorker(broker);
  const task = reviewTask(broker);
  broker.completeTask(task.id, REVIEWER, failResult("pass") as never);
  const record = broker.getTask(task.id)!;
  assert.equal(record.status, "succeeded");
  assert.equal(record.negativeVerdictEvidence, undefined);
});
