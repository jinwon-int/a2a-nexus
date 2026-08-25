import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  reconcileRoundCloseout,
  reconcileRoundCloseoutFromTerminalOutbox,
  terminalRoundKey,
  type RoundWorkerObservation,
} from "./round-closeout-reconcile.js";

const NOW = Date.parse("2026-05-02T09:00:00.000Z");
const FRESH = "2026-05-02T08:55:00.000Z";
const STALE = "2026-05-02T08:00:00.000Z";
const EXPECTED = ["workergamma", "workerepsilon", "workerbeta", "workeralpha", "workerdelta"];
const EXCLUDED = ["workerdelta"];

function obs(overrides: Partial<RoundWorkerObservation> & { workerId: string }): RoundWorkerObservation {
  return {
    status: "running",
    updatedAt: FRESH,
    ...overrides,
  };
}

function reconcile(observations: RoundWorkerObservation[]) {
  return reconcileRoundCloseout(observations, {
    expectedWorkers: EXPECTED,
    excludedWorkers: EXCLUDED,
    nowMs: NOW,
    staleAfterMs: 30 * 60 * 1000,
  });
}

function terminalEvent(
  worker: string,
  status: "succeeded" | "failed" | "canceled" | "blocked",
  overrides: Record<string, unknown> = {},
) {
  const run = typeof overrides.run === "string" ? overrides.run : "a2a-terminal-push-20260504015650";
  return {
    id: `terminal:${worker}:${status}`,
    kind: "task.terminal",
    taskEventId: 1,
    payload: {
      taskId: `task-${worker}`,
      status,
      worker,
      run,
      traceId: "trace-round-315",
      repo: "jinwon-int/a2a-broker",
      issue: 315,
      createdAt: FRESH,
      updatedAt: FRESH,
      completedAt: FRESH,
      ...overrides,
    },
    createdAt: FRESH,
    receipt: { status: "accepted", updatedAt: FRESH },
    attempts: 0,
  } as const;
}

function reportToPayloadSample() {
  return {
    taskId: "task-workergamma",
    status: "succeeded",
    worker: "workergamma",
    repo: "jinwon-int/a2a-broker",
    issue: 315,
    createdAt: FRESH,
    updatedAt: FRESH,
  } as const;
}

describe("round closeout reconciliation", () => {
  it("is ready when all required workers succeeded with evidence and excluded worker is ignored", () => {
    const report = reconcile([
      obs({ workerId: "workergamma", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/1" } }),
      obs({ workerId: "workerepsilon", status: "succeeded", evidence: { doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/243#issuecomment-1" } }),
      obs({ workerId: "workerbeta", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/2" } }),
      obs({ workerId: "workeralpha", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/3" } }),
      obs({ workerId: "workerdelta", status: "running", updatedAt: STALE }),
    ]);

    assert.equal(report.state, "ready");
    assert.equal(report.counts.required, 4);
    assert.equal(report.counts.completed, 4);
    assert.equal(report.counts.excluded, 1);
    assert.equal(report.workers.find((worker) => worker.workerId === "workerdelta")?.state, "excluded");
  });

  it("prioritizes missing terminal evidence before stuck and blocked states", () => {
    const report = reconcile([
      obs({ workerId: "workergamma", status: "succeeded" }),
      obs({ workerId: "workerepsilon", status: "running", updatedAt: STALE }),
      obs({ workerId: "workerbeta", status: "failed", evidence: { blockCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/243#issuecomment-2" } }),
      obs({ workerId: "workeralpha", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/4" } }),
    ]);

    assert.equal(report.state, "needs-evidence");
    assert.equal(report.counts.missingEvidence, 1);
    assert.equal(report.counts.stuck, 1);
    assert.equal(report.counts.blocked, 1);
    assert.match(report.action, /Recover or post missing evidence/);
    assert.equal(report.workers.find((worker) => worker.workerId === "workergamma")?.state, "missing-evidence");
  });

  it("treats branch-only evidence as recovery evidence only for failed lanes", () => {
    const report = reconcile([
      obs({ workerId: "workergamma", status: "failed", evidence: { branchUrl: "https://github.com/jinwon-int/a2a-broker/tree/a2a-patch-recovered" } }),
      obs({ workerId: "workerepsilon", status: "succeeded", evidence: { branchUrl: "https://github.com/jinwon-int/a2a-broker/tree/a2a-patch-no-pr" } }),
      obs({ workerId: "workerbeta", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/44" } }),
      obs({ workerId: "workeralpha", status: "succeeded", evidence: { doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/243#issuecomment-done" } }),
    ]);

    assert.equal(report.state, "needs-evidence");
    assert.equal(report.counts.blocked, 1);
    assert.equal(report.counts.missingEvidence, 1);
    const failed = report.workers.find((worker) => worker.workerId === "workergamma");
    assert.equal(failed?.state, "blocked");
    assert.equal(failed?.evidenceUrl, "https://github.com/jinwon-int/a2a-broker/tree/a2a-patch-recovered");
    assert.match(failed?.action ?? "", /Inspect recovered branch evidence/);
    const succeeded = report.workers.find((worker) => worker.workerId === "workerepsilon");
    assert.equal(succeeded?.state, "missing-evidence");
    assert.match(succeeded?.reason ?? "", /branch-only evidence is not completion evidence/);
  });

  it("marks fresh active or missing observations as waiting", () => {
    const report = reconcile([
      obs({ workerId: "workergamma", status: "running", updatedAt: FRESH }),
      obs({ workerId: "workerepsilon", status: "claimed", updatedAt: FRESH }),
      obs({ workerId: "workerbeta", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/5" } }),
    ]);

    assert.equal(report.state, "waiting");
    assert.equal(report.counts.waiting, 3);
    assert.equal(report.workers.find((worker) => worker.workerId === "workeralpha")?.reason, "No task observation found for required worker.");
  });

  it("uses the latest observation per worker", () => {
    const report = reconcile([
      obs({ workerId: "workergamma", status: "running", updatedAt: STALE }),
      obs({ workerId: "workergamma", status: "succeeded", updatedAt: FRESH, evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/6" } }),
      obs({ workerId: "workerepsilon", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/7" } }),
      obs({ workerId: "workerbeta", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/8" } }),
      obs({ workerId: "workeralpha", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/9" } }),
    ]);

    assert.equal(report.state, "ready");
    assert.equal(report.workers.find((worker) => worker.workerId === "workergamma")?.state, "completed");
  });

  it("aggregates terminal outbox events into a mixed round closeout without cron", () => {
    const report = reconcileRoundCloseoutFromTerminalOutbox([
      terminalEvent("workergamma", "succeeded", {
        taskDescription: "Patch terminal push projection",
        prUrl: "https://github.com/jinwon-int/a2a-broker/pull/3151",
      }),
      terminalEvent("workerepsilon", "succeeded", {
        taskDescription: "Add operator summary tests",
        doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/315#issuecomment-done",
      }),
      terminalEvent("workerbeta", "blocked", {
        taskDescription: "Validate notifier ACK path",
        blockUrl: "https://github.com/jinwon-int/a2a-broker/issues/315#issuecomment-block",
      }),
      terminalEvent("unrelated", "succeeded", { run: "other-round", prUrl: "https://github.com/jinwon-int/a2a-broker/pull/999" }),
    ], {
      expectedWorkers: ["workergamma", "workerepsilon", "workerbeta", "workeralpha"],
      run: "a2a-terminal-push-20260504015650",
      nowMs: NOW,
      staleAfterMs: 30 * 60 * 1000,
    });

    assert.equal(report.state, "blocked");
    assert.equal(report.counts.completed, 2);
    assert.equal(report.counts.blocked, 1);
    assert.equal(report.counts.waiting, 1);
    assert.deepEqual(report.workerSummaries.map((worker) => `${worker.workerId}:${worker.status}`), [
      "workergamma:completed",
      "workerepsilon:completed",
      "workerbeta:blocked",
      "workeralpha:pending",
    ]);
    assert.equal(report.workerSummaries.find((worker) => worker.workerId === "workerbeta")?.taskDescription, "Validate notifier ACK path");
  });

  it("marks a terminal outbox round ready only when all workers have PR evidence", () => {
    const report = reconcileRoundCloseoutFromTerminalOutbox([
      terminalEvent("workergamma", "succeeded", { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/401", taskDescription: "Fix fan-in" }),
      terminalEvent("workerepsilon", "succeeded", { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/402", taskDescription: "Fix projection" }),
      terminalEvent("workerbeta", "succeeded", { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/403", taskDescription: "Fix summary" }),
    ], {
      expectedWorkers: ["workergamma", "workerepsilon", "workerbeta"],
      traceId: "trace-round-315",
      nowMs: NOW,
    });

    assert.equal(report.state, "ready");
    assert.equal(report.counts.completed, 3);
    assert.equal(report.counts.waiting, 0);
    assert.deepEqual(report.workerSummaries.map((worker) => worker.status), ["completed", "completed", "completed"]);
    assert.equal(terminalRoundKey(reportToPayloadSample()), "issue:jinwon-int/a2a-broker#315");
  });

  it("scopes observations by task id prefix or issue set", () => {
    const report = reconcileRoundCloseout([
      obs({ workerId: "workergamma", taskId: "r1-workergamma", issueNumber: 241, status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/10" } }),
      obs({ workerId: "workerepsilon", taskId: "other-workerepsilon", issueNumber: 243, status: "succeeded", evidence: { doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/243#issuecomment-10" } }),
      obs({ workerId: "workerbeta", taskId: "other-workerbeta", issueNumber: 999, status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/11" } }),
    ], {
      expectedWorkers: ["workergamma", "workerepsilon", "workerbeta"],
      roundLabel: "a2a-hardening-r1",
      taskIdPrefix: "r1-",
      issueNumbers: [243],
      nowMs: NOW,
      staleAfterMs: 30 * 60 * 1000,
    });

    assert.equal(report.roundLabel, "a2a-hardening-r1");
    assert.deepEqual(report.issueNumbers, [243]);
    assert.equal(report.counts.completed, 2);
    assert.equal(report.counts.waiting, 1);
    assert.equal(report.workers.find((worker) => worker.workerId === "workerbeta")?.state, "waiting");
  });
});

describe("broker exit condition classification (issue #471)", () => {
  it("classifies succeeded with prUrl as pr_success", () => {
    const report = reconcile([
      obs({ workerId: "workergamma", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/100" } }),
      obs({ workerId: "workerepsilon", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/101" } }),
      obs({ workerId: "workerbeta", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/102" } }),
      obs({ workerId: "workeralpha", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/103" } }),
    ]);

    assert.equal(report.state, "ready");
    for (const worker of report.workers.filter((w) => w.required)) {
      assert.equal(worker.outcomeClass, "pr_success");
    }
  });

  it("classifies succeeded with doneCommentUrl but no prUrl as no_change_done", () => {
    const report = reconcile([
      obs({ workerId: "workergamma", status: "succeeded", evidence: { doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/471#issuecomment-done" } }),
      obs({ workerId: "workerepsilon", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/200" } }),
      obs({ workerId: "workerbeta", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/201" } }),
      obs({ workerId: "workeralpha", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/202" } }),
    ]);

    assert.equal(report.state, "ready");
    assert.equal(report.workers.find((w) => w.workerId === "workergamma")?.outcomeClass, "no_change_done");
    assert.equal(report.workers.find((w) => w.workerId === "workerepsilon")?.outcomeClass, "pr_success");
  });

  it("classifies failed with blockCommentUrl as no_change_block", () => {
    const report = reconcile([
      obs({ workerId: "workergamma", status: "failed", evidence: { blockCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/471#issuecomment-block" } }),
      obs({ workerId: "workerepsilon", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/300" } }),
      obs({ workerId: "workerbeta", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/301" } }),
      obs({ workerId: "workeralpha", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/302" } }),
    ]);

    assert.equal(report.state, "blocked");
    assert.equal(report.workers.find((w) => w.workerId === "workergamma")?.outcomeClass, "no_change_block");
    assert.equal(report.workers.find((w) => w.workerId === "workergamma")?.state, "blocked");
  });

  it("classifies failed with no evidence as infra_failure", () => {
    const report = reconcile([
      obs({ workerId: "workergamma", status: "failed" }),
      obs({ workerId: "workerepsilon", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/400" } }),
      obs({ workerId: "workerbeta", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/401" } }),
      obs({ workerId: "workeralpha", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/402" } }),
    ]);

    assert.equal(report.state, "needs-evidence");
    assert.equal(report.workers.find((w) => w.workerId === "workergamma")?.outcomeClass, "infra_failure");
    assert.equal(report.workers.find((w) => w.workerId === "workergamma")?.state, "missing-evidence");
  });

  it("classifies canceled with blockCommentUrl as no_change_block", () => {
    const report = reconcile([
      obs({ workerId: "workergamma", status: "canceled", evidence: { blockCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/471#issuecomment-block" } }),
      obs({ workerId: "workerepsilon", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/500" } }),
      obs({ workerId: "workerbeta", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/501" } }),
      obs({ workerId: "workeralpha", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/502" } }),
    ]);

    assert.equal(report.state, "blocked");
    assert.equal(report.workers.find((w) => w.workerId === "workergamma")?.outcomeClass, "no_change_block");
  });

  it("leaves outcomeClass undefined for non-terminal workers", () => {
    const report = reconcile([
      obs({ workerId: "workergamma", status: "running", updatedAt: FRESH }),
      obs({ workerId: "workerepsilon", status: "running", updatedAt: FRESH }),
      obs({ workerId: "workerbeta", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/600" } }),
      obs({ workerId: "workeralpha", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/601" } }),
    ]);

    assert.equal(report.state, "waiting");
    assert.equal(report.workers.find((w) => w.workerId === "workergamma")?.outcomeClass, undefined);
    assert.equal(report.workers.find((w) => w.workerId === "workerbeta")?.outcomeClass, "pr_success");
  });

  it("classifies terminal outbox events with correct exit conditions", () => {
    const report = reconcileRoundCloseoutFromTerminalOutbox([
      terminalEvent("workergamma", "succeeded", {
        prUrl: "https://github.com/jinwon-int/a2a-broker/pull/700",
        taskDescription: "PR success task",
      }),
      terminalEvent("workerepsilon", "succeeded", {
        doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/471#issuecomment-done",
        taskDescription: "No-change done task",
      }),
      terminalEvent("workerbeta", "blocked", {
        blockUrl: "https://github.com/jinwon-int/a2a-broker/issues/471#issuecomment-block",
        taskDescription: "No-change block task",
      }),
      terminalEvent("workeralpha", "failed", {
        taskDescription: "Infra failure task",
      }),
    ], {
      expectedWorkers: ["workergamma", "workerepsilon", "workerbeta", "workeralpha"],
      run: "a2a-terminal-push-20260504015650",
      nowMs: NOW,
      staleAfterMs: 30 * 60 * 1000,
    });

    assert.equal(report.state, "needs-evidence");
    assert.equal(report.workers.find((w) => w.workerId === "workergamma")?.outcomeClass, "pr_success");
    assert.equal(report.workers.find((w) => w.workerId === "workerepsilon")?.outcomeClass, "no_change_done");
    assert.equal(report.workers.find((w) => w.workerId === "workerbeta")?.outcomeClass, "no_change_block");
    assert.equal(report.workers.find((w) => w.workerId === "workeralpha")?.outcomeClass, "infra_failure");
  });
});
