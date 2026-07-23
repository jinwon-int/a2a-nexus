import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryA2ABroker } from "./broker.js";
import {
  SqliteBrokerStateStore,
  SqliteWorkerRuntimeRepository,
  emptySnapshot,
  type BrokerSnapshot,
  type BrokerStateStore,
} from "./store.js";
import { registerWorker, createWorkerTask } from "./broker-test-helpers.js";

test("snapshot roundtrip preserves lateEvidenceAfterCancel", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  broker.claimTask(task.id, "worker-a");
  broker.cancelTask(task.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    reason: "no longer needed",
  });
  broker.completeTask(task.id, "worker-a", { summary: "done late" });

  const snapshot = broker.exportSnapshot();
  const broker2 = new InMemoryA2ABroker(undefined, snapshot);

  const loaded = broker2.getTask(task.id);
  assert.ok(loaded);
  assert.equal(loaded!.status, "canceled");
  assert.ok(loaded!.lateEvidenceAfterCancel);
  assert.equal(loaded!.lateEvidenceAfterCancel!.kind, "complete");
  assert.equal(loaded!.lateEvidenceAfterCancel!.result?.summary, "done late");
});

test("late fail after cancel produces late_completion_after_cancel interruption", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  broker.claimTask(task.id, "worker-a");
  broker.cancelTask(task.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    reason: "no longer needed",
  });
  broker.failTask(task.id, "worker-a", { message: "late fail" });

  const diag = broker.getTaskDiagnostics(task.id);
  assert.equal(diag.interruption?.kind, "late_completion_after_cancel");
  assert.equal(diag.interruption?.source, "tombstone");
  assert.ok(diag.brokerHints.lateEvidenceAfterCancel);
  assert.equal(diag.brokerHints.lateEvidenceAfterCancel!.kind, "fail");
  assert.equal(diag.brokerHints.lateEvidenceAfterCancel!.submittedBy, "worker-a");

  const ts = broker.getTombstone(task.id);
  assert.ok(ts);
  assert.equal(ts!.tombstoneReason, "canceled_with_late_completion");
});

test("accepted-task wake planning is durable and duplicate-safe", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    id: "task-wake-1",
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "wake target",
    payload: {
      waitRunId: "wait-1",
      correlationId: "corr-1",
      parentRunId: "parent-1",
    },
  });

  const firstPlan = broker.planAcceptedTaskWake(task.id, {
    targetSessionKey: "agent:worker-a",
    targetNodeId: "worker-a",
    waitRunId: "wait-1",
    correlationId: "corr-1",
    parentRunId: "parent-1",
  });
  assert.equal(firstPlan.shouldDispatch, true);
  assert.equal(firstPlan.replayed, false);
  assert.equal(firstPlan.wake.status, "planned");
  assert.equal(firstPlan.wake.wakeKey, "corr-1:wait-1");
  assert.equal(firstPlan.wake.idempotencyKey, "a2a-wake:corr-1:wait-1");

  const scheduled = broker.recordTaskWakeDecision(task.id, {
    status: "scheduled",
    runtimeRunId: "run-1",
    coalesced: false,
    message: "queued for target wake",
  });
  assert.equal(scheduled.wake?.status, "scheduled");
  assert.equal(scheduled.wake?.runtimeRunId, "run-1");

  const replay = broker.planAcceptedTaskWake(task.id, {
    targetSessionKey: "agent:worker-a",
    targetNodeId: "worker-a",
    waitRunId: "wait-1",
    correlationId: "corr-1",
    parentRunId: "parent-1",
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.shouldDispatch, false);
  assert.equal(replay.wake.status, "scheduled");
  assert.equal(replay.wake.replayCount, 1);

  assert.equal(
    broker.listAuditEvents({ targetId: task.id, action: "task.wake.planned" }).length,
    1,
  );
  assert.equal(
    broker.listAuditEvents({ targetId: task.id, action: "task.wake.scheduled" }).length,
    1,
  );
});

test("accepted-task wake replay after restart preserves pending and decided state", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    id: "task-wake-restart",
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "wake target",
  });
  broker.planAcceptedTaskWake(task.id, {
    targetSessionKey: "agent:worker-a",
    targetNodeId: "worker-a",
    waitRunId: "wait-restart",
    correlationId: "corr-restart",
  });

  const restarted = new InMemoryA2ABroker(undefined, broker.exportSnapshot());
  const replayPlan = restarted.planAcceptedTaskWake(task.id, {
    targetSessionKey: "agent:worker-a",
    targetNodeId: "worker-a",
    waitRunId: "wait-restart",
    correlationId: "corr-restart",
  });
  assert.equal(replayPlan.replayed, true);
  assert.equal(replayPlan.shouldDispatch, true);
  assert.equal(replayPlan.wake.status, "planned");
  assert.equal(replayPlan.wake.replayCount, 1);

  restarted.recordTaskWakeDecision(task.id, {
    status: "skipped",
    code: "wake_disabled",
    message: "Wake-on-Task disabled by default",
  });
  const secondRestart = new InMemoryA2ABroker(undefined, restarted.exportSnapshot());
  const persisted = secondRestart.getTask(task.id);
  assert.equal(persisted?.wake?.status, "skipped");
  assert.equal(persisted?.wake?.code, "wake_disabled");

  const replayAfterDecision = secondRestart.planAcceptedTaskWake(task.id, {
    targetSessionKey: "agent:worker-a",
    targetNodeId: "worker-a",
    waitRunId: "wait-restart",
    correlationId: "corr-restart",
  });
  assert.equal(replayAfterDecision.replayed, true);
  assert.equal(replayAfterDecision.shouldDispatch, false);
  assert.equal(replayAfterDecision.wake.status, "skipped");
});

test("accepted-task wake failure is durable and operator-visible", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    id: "task-wake-failure",
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "wake target",
  });
  broker.planAcceptedTaskWake(task.id, {
    targetSessionKey: "agent:worker-a",
    targetNodeId: "worker-a",
    waitRunId: "wait-fail",
    correlationId: "corr-fail",
  });
  broker.recordTaskWakeDecision(task.id, {
    status: "failed",
    code: "wake_dispatch_failed",
    message: "runtime unavailable",
  });

  const restarted = new InMemoryA2ABroker(undefined, broker.exportSnapshot());
  const persisted = restarted.getTask(task.id);
  assert.equal(persisted?.wake?.status, "failed");
  assert.equal(persisted?.wake?.code, "wake_dispatch_failed");
  assert.equal(persisted?.wake?.message, "runtime unavailable");

  const failures = restarted.listAuditEvents({
    targetId: task.id,
    action: "task.wake.failed",
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0].note ?? "", /runtime unavailable/);
});

test("broker accepts canonical GitHub patch dispatch and stamps taskOrigin", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-canonical");

  const task = broker.createTask({
    intent: "propose_patch",
    taskOrigin: "github",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-github-canonical", kind: "node", role: "analyst" },
    message: "fix issue",
    payload: {
      mode: "github-propose-patch",
      repo: "acme/platform",
      issueNumber: 291,
      issueUrl: "https://github.com/acme/platform/issues/291",
    },
  });

  assert.equal(task.taskOrigin, "github");
  assert.equal(task.payload.mode, "github-propose-patch");
  assert.equal(task.payload.repo, "acme/platform");
  assert.equal(task.payload.issue, "#291");
  assert.equal(task.payload.issueNumber, 291);
  assert.equal(task.payload.issueUrl, "https://github.com/acme/platform/issues/291");
  assert.equal(task.payload.githubDispatchCompatibility, undefined);
});

test("broker derives parent-round metadata for Team GitHub patch dispatches", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-team-round");

  const task = broker.createTask({
    intent: "propose_patch",
    taskOrigin: "github",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-github-team-round", kind: "node", role: "analyst" },
    message: "fix issue",
    payload: {
      mode: "github-propose-patch",
      repo: "acme/platform",
      issueNumber: 291,
      issueUrl: "https://github.com/acme/platform/issues/291",
      parentIssueUrl: "https://github.com/acme/platform/issues/290",
      teamId: "team1",
      lane: 3,
      runId: "a2a-team1-round-20260606T073100Z",
      workModeDecision: {
        mode: "team1",
        idempotencyKey: "a2a-work-mode:team1:github-round",
        finalizerOwner: "brokeralpha",
        generatedAt: "2026-06-07T06:00:00.000Z",
        capacityState: "healthy",
        capacitySnapshotSource: "/workers/capacity",
        capacitySnapshotAt: "2026-06-07T05:59:00.000Z",
        sourceOnlyDecision: true,
        workerDispatchAllowedByThisPacket: false,
      },
    },
  });

  assert.equal(task.taskOrigin, "github");
  assert.equal(task.payload.parentRoundId, "a2a-team1-round-20260606T073100Z");
  assert.equal(task.payload.parentRoundTotal, 4);
  assert.equal(task.payload.parentRoundOrder, 3);
  assert.equal(task.payload.originBrokerId, "hub-a");
  assert.equal(task.payload.runId, "a2a-team1-round-20260606T073100Z");
  assert.equal((task.payload.workModeDecision as Record<string, unknown>)?.finalizerOwner, "brokeralpha");
});

test("broker rejects parent-routed GitHub patch dispatches with incomplete parent-round metadata", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-parent-round-reject");

  assert.throws(
    () => broker.createTask({
      intent: "propose_patch",
      taskOrigin: "github",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-github-parent-round-reject", kind: "node", role: "analyst" },
      message: "fix issue",
      payload: {
        mode: "github-propose-patch",
        repo: "acme/platform",
        issueNumber: 291,
        issueUrl: "https://github.com/acme/platform/issues/291",
        parentIssueUrl: "https://github.com/acme/platform/issues/290",
        runId: "a2a-parent-round-without-lane",
      },
    }),
    /parent-round metadata invalid: parentRoundTotal is required.*parentRoundOrder is required/,
  );
});

test("broker normalizes legacy GitHub dispatch fields with compatibility marker", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-legacy");

  const task = broker.createTask({
    intent: "propose_patch",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-github-legacy", kind: "node", role: "analyst" },
    message: "fix issue",
    payload: {
      githubRepo: "acme/platform",
      githubIssueNumber: 292,
      workMode: "github",
    },
  });

  assert.equal(task.taskOrigin, "github");
  assert.equal(task.payload.mode, "github-propose-patch");
  assert.equal(task.payload.repo, "acme/platform");
  assert.equal(task.payload.issue, "#292");
  assert.equal(task.payload.issueNumber, 292);
  assert.equal(task.payload.issueUrl, "https://github.com/acme/platform/issues/292");
  assert.deepEqual(task.payload.githubDispatchCompatibility, {
    normalizedFromLegacyPayload: true,
    legacyFields: ["githubRepo", "githubIssueNumber", "workMode"],
  });
});

test("broker accepts GitHub read-only validation lanes with issue metadata", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-readonly");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-github-readonly", kind: "node", role: "analyst" },
    message: "libero validation for https://github.com/acme/platform/issues/527",
    payload: {
      mode: "read-only-analysis",
      repo: "acme/platform",
      issueUrl: "https://github.com/acme/platform/issues/527",
      assignmentRole: "libero",
    },
  });

  assert.equal(task.intent, "analyze");
  assert.equal(task.taskOrigin, "github");
  assert.equal(task.payload.mode, "read-only-analysis");
  assert.equal(task.payload.repo, "acme/platform");
  assert.equal(task.payload.issue, "#527");
  assert.equal(task.payload.issueNumber, 527);
  assert.equal(task.payload.issueUrl, "https://github.com/acme/platform/issues/527");
  assert.equal(task.payload.assignmentRole, "libero");
});

test("broker accepts github-verify as a read-only evidence lane", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-verify");

  const task = broker.createTask({
    intent: "verify",
    taskOrigin: "github",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-github-verify", kind: "node", role: "analyst" },
    message: "run no-live validation",
    payload: {
      mode: "github-verify",
      repo: "acme/platform",
      issueNumber: 528,
    },
  });

  assert.equal(task.intent, "verify");
  assert.equal(task.taskOrigin, "github");
  assert.equal(task.payload.mode, "github-verify");
  assert.equal(task.payload.issue, "#528");
  assert.equal(task.payload.issueUrl, "https://github.com/acme/platform/issues/528");
});

test("broker accepts family-wiki-readonly-audit as a read-only evidence lane", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-family-wiki-audit");

  const task = broker.createTask({
    intent: "verify",
    taskOrigin: "github",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-family-wiki-audit", kind: "node", role: "analyst" },
    message: "audit Family Wiki structure without patch evidence",
    payload: {
      mode: "family-wiki-readonly-audit",
      repo: "jinwon-int/seoyoon-family-wiki",
      issueNumber: 894,
    },
  });

  assert.equal(task.intent, "verify");
  assert.equal(task.taskOrigin, "github");
  assert.equal(task.payload.mode, "family-wiki-readonly-audit");
  assert.equal(task.payload.issue, "#894");
  assert.equal(task.payload.issueUrl, "https://github.com/jinwon-int/seoyoon-family-wiki/issues/894");
});

test("broker rejects non-canonical GitHub dispatch with wrong taskOrigin", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-reject");

  assert.throws(
    () => broker.createTask({
      intent: "propose_patch",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-github-reject", kind: "node", role: "analyst" },
      taskOrigin: "api",
      message: "fix issue",
      payload: {
        mode: "github-propose-patch",
        repo: "acme/platform",
        issueNumber: 293,
      },
    }),
    /taskOrigin=github/,
  );
});

test("broker rejects GitHub issue URLs before generic handler fallback", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-url-reject");

  assert.throws(
    () => broker.createTask({
      intent: "chat",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-github-url-reject", kind: "node", role: "analyst" },
      message: "please work https://github.com/acme/platform/issues/294",
      payload: { mode: "terminal-brief-r4-receipt-automation" },
    }),
    /GitHub-looking tasks require canonical intent=propose_patch/,
  );
});

test("broker rejects GitHub-looking generic task before worker fallback", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-generic-reject");

  assert.throws(
    () => broker.createTask({
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-github-generic-reject", kind: "node", role: "analyst" },
      message: "https://github.com/acme/platform/issues/294",
      payload: { mode: "terminal-brief-r4-receipt-automation" },
    }),
    /GitHub-looking tasks require canonical intent=propose_patch/,
  );
});

test("broker rejects ad-hoc legacy GitHub metadata dispatch before worker fallback", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-legacy-generic-reject");

  assert.throws(
    () => broker.createTask({
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-github-legacy-generic-reject", kind: "node", role: "analyst" },
      message: "run terminal brief automation",
      payload: {
        mode: "terminal-brief-r4-receipt-automation",
        githubRepo: "acme/platform",
        githubIssueNumber: 295,
      },
    }),
    /GitHub-looking tasks require canonical intent=propose_patch/,
  );
});

test("broker rejects repo plus issueNumber without canonical github-propose-patch mode", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-shape-reject");

  assert.throws(
    () => broker.createTask({
      intent: "propose_patch",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-github-shape-reject", kind: "node", role: "analyst" },
      message: "fix issue",
      payload: {
        repo: "acme/platform",
        issueNumber: 295,
      },
    }),
    /payload\.mode=github-propose-patch/,
  );
});

test("broker rejects repo plus issueUrl dispatch that is missing canonical GitHub mode", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-mode-reject");

  assert.throws(
    () => broker.createTask({
      intent: "propose_patch",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-github-mode-reject", kind: "node", role: "analyst" },
      taskOrigin: "github",
      message: "fix issue",
      payload: {
        repo: "acme/platform",
        issueUrl: "https://github.com/acme/platform/issues/295",
      },
    }),
    /mode=github-propose-patch/,
  );
});

// --- Cleanup candidate discovery (issue #520) ---

test("discoverCleanupCandidates returns empty plan for clean broker", () => {
  const broker = new InMemoryA2ABroker();
  const plan = broker.discoverCleanupCandidates();
  assert.equal(plan.totalCandidates, 0);
  assert.equal(plan.summary.stale_worker, 0);
  assert.equal(plan.summary.malformed_task, 0);
  assert.equal(plan.summary.terminal_outbox_backlog, 0);
  assert.equal(plan.summary.historical_terminal_task, 0);
  assert.deepEqual(plan.actionabilitySummary, {
    advisory: 0,
    blocked: 0,
    executable: 0,
    cursor_skipped: 0,
    retention_not_due: 0,
  });
  assert.ok(plan.generatedAt);
  assert.ok(plan.riskNotes.length > 0);
  assert.ok(plan.riskNotes.some((n) => n.includes("No cleanup candidates")));
});

test("discoverCleanupCandidates detects stale workers via nowMs aging", () => {
  const broker = new InMemoryA2ABroker();
  // Register worker — lastSeenAt is set to now
  broker.registerWorker({
    nodeId: "stale-w1",
    role: "operator",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
  });

  // Use nowMs far in the future to make the worker appear stale
  const farFutureMs = Date.now() + 600_000; // 10 min later
  const plan = broker.discoverCleanupCandidates({
    staleWorkerAfterMs: 300_000, // 5 min
    nowMs: farFutureMs,
  });

  assert.equal(plan.summary.stale_worker, 1);
  assert.equal(plan.totalCandidates, 1);
  assert.equal(plan.candidates[0].class, "stale_worker");
  assert.equal(plan.candidates[0].entityId, "stale-w1");
  assert.equal(plan.candidates[0].risk, "caution");
  assert.equal(plan.candidates[0].actionability, "advisory");
  assert.equal(plan.actionabilitySummary.advisory, 1);
});

test("discoverCleanupCandidates marks stale worker with active tasks as high_risk", () => {
  const broker = new InMemoryA2ABroker();
  broker.registerWorker({
    nodeId: "stale-w2",
    role: "operator",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
  });

  // Create an active task assigned to the stale worker
  broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "stale-w2", kind: "node", role: "operator" },
    payload: { work: "active-task" },
  });

  const farFutureMs = Date.now() + 600_000;
  const plan = broker.discoverCleanupCandidates({
    staleWorkerAfterMs: 300_000,
    nowMs: farFutureMs,
  });

  assert.equal(plan.summary.stale_worker, 1);
  assert.equal(plan.candidates[0].risk, "high_risk");
  assert.equal(plan.candidates[0].actionability, "blocked");
  assert.equal(plan.actionabilitySummary.blocked, 1);
  assert.equal(plan.candidates[0].metadata?.hasActiveTasks, true);
});

test("discoverCleanupCandidates detects malformed queued tasks with missing target", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  // Create a task that will be queued
  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: { data: "valid" },
  });
  assert.equal(task.status, "queued");

  // With proper fields, should not be flagged as malformed
  const nowMs = Date.now() + 300_000;
  const plan = broker.discoverCleanupCandidates({
    staleTaskAfterMs: 120_000,
    nowMs,
  });

  assert.equal(plan.summary.malformed_task, 0);
  // Well-formed stale queued tasks are detected as queued_residue (see
  // dedicated queued-residue tests below for comprehensive coverage).
  assert.equal(plan.summary.queued_residue, 1);
});

test("discoverCleanupCandidates detects queued residue for old unclaimed queued tasks", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  // Create a well-formed queued task that remains unclaimed
  const task = broker.createTask({
    intent: "backfill",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: { branch: "feature/cleanup" },
  });
  assert.equal(task.status, "queued");

  // Fast-forward past the stale threshold; set staleWorkerAfterMs high to
  // avoid interference from stale worker detection
  const farFutureMs = Date.now() + 600_000;
  const plan = broker.discoverCleanupCandidates({
    staleWorkerAfterMs: 86_400_000, // 24h — well beyond the window
    staleTaskAfterMs: 120_000,
    nowMs: farFutureMs,
  });

  assert.equal(plan.summary.queued_residue, 1);
  assert.equal(plan.summary.malformed_task, 0);
  assert.equal(plan.totalCandidates, 1);

  const residue = plan.candidates[0];
  assert.equal(residue.class, "queued_residue");
  assert.equal(residue.entityId, task.id);
  assert.equal(residue.risk, "caution");
  assert.equal(residue.actionability, "advisory");
  assert.equal(plan.actionabilitySummary.advisory, 1);
  assert.equal(residue.metadata?.intent, "backfill");
  assert.equal(residue.metadata?.status, "queued");
  assert.ok(residue.reason.includes("queued"));
  assert.ok(residue.id.includes("cleanup:queued-residue:"));
  assert.ok(plan.riskNotes.some((note) => note.includes("Queued residue")));
});

test("discoverCleanupCandidates queued residue is distinct from malformed_task", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  // Well-formed queued task — should be queued residue
  const valid = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: { data: "important" },
  });

  // Malformed queued task: clear targetNodeId and payload to make it malformed
  broker.createTask({
    id: "malformed-distinct",
    intent: "backfill",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: { temp: "placeholder" },
  });
  const malformedTaskRaw = broker.getTask("malformed-distinct")!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (malformedTaskRaw as any).targetNodeId = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (malformedTaskRaw as any).payload = {};
  malformedTaskRaw.updatedAt = new Date(Date.now() - 600_000).toISOString();

  const farFutureMs = Date.now() + 600_000;
  const plan = broker.discoverCleanupCandidates({
    staleWorkerAfterMs: 86_400_000, // 24h — avoid stale-worker interference
    staleTaskAfterMs: 120_000,
    nowMs: farFutureMs,
  });

  // Both classes should be present and distinct
  assert.equal(plan.summary.malformed_task, 1);
  assert.equal(plan.summary.queued_residue, 1);
  assert.equal(plan.totalCandidates, 2);

  const malformedItem = plan.candidates.find((c) => c.class === "malformed_task");
  assert.ok(malformedItem);
  assert.equal(malformedItem.metadata?.taskId, "malformed-distinct");
  assert.ok(malformedItem.reason.includes("malformed"));
  assert.ok(malformedItem.reason.includes("missing targetNodeId"));

  const residueItem = plan.candidates.find((c) => c.class === "queued_residue");
  assert.ok(residueItem);
  assert.equal(residueItem.entityId, valid.id);
  assert.ok(residueItem.reason.includes("without being claimed"));
  assert.ok(!residueItem.reason.includes("malformed"));

  // Risk notes for both classes present
  assert.ok(plan.riskNotes.some((note) => note.includes("Malformed queued tasks")));
  assert.ok(plan.riskNotes.some((note) => note.includes("Queued residue")));
});

test("discoverCleanupCandidates no queued residue for recent queued tasks", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: { data: "fresh" },
  });

  // No time travel — task is still recent
  const plan = broker.discoverCleanupCandidates();
  assert.equal(plan.summary.queued_residue, 0);
});

test("discoverCleanupCandidates queued residue risk note includes count", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: { data: "a" },
  });
  broker.createTask({
    intent: "backfill",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: { data: "b" },
  });

  const farFutureMs = Date.now() + 600_000;
  const plan = broker.discoverCleanupCandidates({
    staleWorkerAfterMs: 86_400_000, // 24h — avoid stale-worker interference
    staleTaskAfterMs: 120_000,
    nowMs: farFutureMs,
  });

  assert.equal(plan.summary.queued_residue, 2);
  assert.ok(plan.riskNotes.some((note) => note === "Queued residue detected (2): well-formed queued tasks that remain unclaimed. Verify worker capacity and routing before manual intervention."));
});

test("discoverCleanupCandidates detects terminal outbox backlog", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: {},
  });
  broker.claimTask(task.id, "w1");
  broker.completeTask(task.id, "w1", { summary: "done" });

  const plan = broker.discoverCleanupCandidates({
    terminalOutboxBacklogAfterMs: 0, // immediate
  });

  // The outbox should have an unacknowledged event for the terminal task
  assert.ok(plan.summary.terminal_outbox_backlog >= 1);
  const backlogItem = plan.candidates.find(
    (c) => c.class === "terminal_outbox_backlog",
  );
  assert.ok(backlogItem);
  assert.equal(backlogItem.metadata?.taskId, task.id);
  assert.equal(backlogItem.actionability, "blocked");
  assert.equal(backlogItem.metadata?.cursorState, "unknown");
});

test("discoverCleanupCandidates excludes acknowledged outbox events", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: {},
  });
  broker.claimTask(task.id, "w1");
  broker.completeTask(task.id, "w1", { summary: "done" });

  // Mark all outbox events as acknowledged
  const outbox = broker.getTerminalTaskEventOutbox();
  const events = outbox.snapshot();
  for (const event of events) {
    outbox.acknowledge(event.id, {
      evidence: "operator_visible",
      acknowledgedAt: new Date().toISOString(),
    });
  }

  const plan = broker.discoverCleanupCandidates({
    terminalOutboxBacklogAfterMs: 0,
  });

  assert.equal(plan.summary.terminal_outbox_backlog, 0);
});

test("discoverCleanupCandidates detects historical terminal tasks", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: {},
  });
  broker.claimTask(task.id, "w1");
  broker.completeTask(task.id, "w1", { summary: "done" });

  const farFutureMs = Date.now() + 86_400_000 + 1000; // ~24h + 1s later
  const plan = broker.discoverCleanupCandidates({
    historicalTerminalAfterMs: 86_400_000,
    nowMs: farFutureMs,
  });

  assert.ok(plan.summary.historical_terminal_task >= 1);
  const histItem = plan.candidates.find(
    (c) => c.class === "historical_terminal_task",
  );
  assert.ok(histItem);
  assert.equal(histItem.entityId, task.id);
  assert.equal(histItem.metadata?.status, "succeeded");
  assert.equal(histItem.actionability, "retention_not_due");
  assert.equal(plan.actionabilitySummary.retention_not_due, 1);
});

test("discoverCleanupCandidates sorts by risk (high_risk first)", () => {
  const broker = new InMemoryA2ABroker();

  // Create a stale worker with active tasks (high_risk)
  broker.registerWorker({
    nodeId: "stale-hi",
    role: "operator",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
  });
  broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "stale-hi", kind: "node", role: "operator" },
    payload: {},
  });

  // Create another stale worker without tasks (caution)
  broker.registerWorker({
    nodeId: "stale-lo",
    role: "analyst",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
  });

  const farFutureMs = Date.now() + 600_000;
  const plan = broker.discoverCleanupCandidates({
    staleWorkerAfterMs: 300_000,
    nowMs: farFutureMs,
  });

  assert.ok(plan.candidates.length >= 2);
  // high_risk should be first
  assert.equal(plan.candidates[0].risk, "high_risk");
  assert.equal(plan.candidates[0].entityId, "stale-hi");
});

test("discoverCleanupCandidates returns riskNotes matching summary", () => {
  const broker = new InMemoryA2ABroker();

  broker.registerWorker({
    nodeId: "stale-notes",
    role: "operator",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
  });

  const farFutureMs = Date.now() + 600_000;
  const plan = broker.discoverCleanupCandidates({
    staleWorkerAfterMs: 300_000,
    nowMs: farFutureMs,
  });

  assert.ok(plan.riskNotes.some((note) => note.includes("Stale workers")));
});

test("discoverCleanupCandidates is read-only (no state mutation)", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: {},
  });

  const beforeSnapshot = broker.exportSnapshot();

  broker.discoverCleanupCandidates();
  broker.discoverCleanupCandidates({ staleWorkerAfterMs: 1000, nowMs: Date.now() + 99_999 });

  const afterSnapshot = broker.exportSnapshot();
  assert.equal(afterSnapshot.tasks.length, beforeSnapshot.tasks.length);
  assert.equal(afterSnapshot.workers.length, beforeSnapshot.workers.length);
  assert.equal(broker.getTask(task.id)!.status, task.status);
});

test("discoverCleanupCandidates respects custom thresholds", () => {
  const broker = new InMemoryA2ABroker();

  broker.registerWorker({
    nodeId: "custom-w",
    role: "operator",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
  });

  const farFutureMs = Date.now() + 120_000; // 2 min later

  // Default threshold (5 min) should NOT find it stale
  const planDefault = broker.discoverCleanupCandidates({ nowMs: farFutureMs });
  assert.equal(planDefault.summary.stale_worker, 0);

  // Custom threshold (1 min) should find it stale
  const planCustom = broker.discoverCleanupCandidates({
    staleWorkerAfterMs: 60_000,
    nowMs: farFutureMs,
  });
  assert.equal(planCustom.summary.stale_worker, 1);
});

test("discoverCleanupCandidates detects orphaned_claim for claimed task on stale worker", () => {
  const broker = new InMemoryA2ABroker();

  broker.registerWorker({
    nodeId: "orphan-worker",
    role: "operator",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
  });

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "orphan-worker", kind: "node", role: "operator" },
    payload: {},
  });
  broker.claimTask(task.id, "orphan-worker");
  assert.equal(broker.getTask(task.id)!.status, "claimed");

  // Fast-forward time to make the worker stale
  const farFutureMs = Date.now() + 600_000;
  const plan = broker.discoverCleanupCandidates({
    staleWorkerAfterMs: 300_000,
    nowMs: farFutureMs,
  });

  assert.equal(plan.summary.orphaned_claim, 1);
  const orphanItem = plan.candidates.find((c) => c.class === "orphaned_claim");
  assert.ok(orphanItem);
  assert.equal(orphanItem.entityId, task.id);
  assert.equal(orphanItem.metadata?.status, "claimed");
  assert.equal(orphanItem.metadata?.staleWorkerId, "orphan-worker");
  assert.equal(orphanItem.risk, "caution");
  assert.ok(orphanItem.reason.includes("orphan-worker"));
});

test("discoverCleanupCandidates detects orphaned_claim for running task on stale worker (high_risk)", () => {
  const broker = new InMemoryA2ABroker();

  broker.registerWorker({
    nodeId: "orphan-runner",
    role: "operator",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
  });

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "orphan-runner", kind: "node", role: "operator" },
    payload: {},
  });
  broker.claimTask(task.id, "orphan-runner");
  // The broker goes claimed->running on start with a heartbeat
  broker.startTask(task.id, "orphan-runner");
  assert.equal(broker.getTask(task.id)!.status, "running");

  const farFutureMs = Date.now() + 600_000;
  const plan = broker.discoverCleanupCandidates({
    staleWorkerAfterMs: 300_000,
    nowMs: farFutureMs,
  });

  assert.equal(plan.summary.orphaned_claim, 1);
  const orphanItem = plan.candidates.find((c) => c.class === "orphaned_claim");
  assert.ok(orphanItem);
  assert.equal(orphanItem.entityId, task.id);
  assert.equal(orphanItem.metadata?.status, "running");
  assert.equal(orphanItem.metadata?.staleWorkerId, "orphan-runner");
  // Running task on stale worker is high risk (potential data loss)
  assert.equal(orphanItem.risk, "high_risk");
});

test("discoverCleanupCandidates does not flag orphaned_claim when worker is healthy", () => {
  const broker = new InMemoryA2ABroker();

  broker.registerWorker({
    nodeId: "healthy-w",
    role: "operator",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
  });

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "healthy-w", kind: "node", role: "operator" },
    payload: {},
  });
  broker.claimTask(task.id, "healthy-w");

  // No time travel — worker is still fresh
  const plan = broker.discoverCleanupCandidates();
  assert.equal(plan.summary.orphaned_claim, 0);
});

test("discoverCleanupCandidates does not flag orphaned_claim for queued tasks", () => {
  const broker = new InMemoryA2ABroker();

  broker.registerWorker({
    nodeId: "queued-worker",
    role: "operator",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
  });

  broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "queued-worker", kind: "node", role: "operator" },
    payload: {},
  });

  const farFutureMs = Date.now() + 600_000;
  const plan = broker.discoverCleanupCandidates({
    staleWorkerAfterMs: 300_000,
    nowMs: farFutureMs,
  });

  // Worker is stale, but queued tasks are not orphaned claims
  assert.equal(plan.summary.stale_worker, 1);
  assert.equal(plan.summary.orphaned_claim, 0);
});

test("discoverCleanupCandidates orphaned_claim risk notes are present when detected", () => {
  const broker = new InMemoryA2ABroker();

  broker.registerWorker({
    nodeId: "risk-worker",
    role: "operator",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
  });

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "risk-worker", kind: "node", role: "operator" },
    payload: {},
  });
  broker.claimTask(task.id, "risk-worker");

  const farFutureMs = Date.now() + 600_000;
  const plan = broker.discoverCleanupCandidates({
    staleWorkerAfterMs: 300_000,
    nowMs: farFutureMs,
  });

  assert.equal(plan.summary.orphaned_claim, 1);
  assert.ok(plan.riskNotes.some((note) => note.includes("Orphaned claims")));
});

test("discoverCleanupCandidates stable ids are deterministic", () => {
  const broker = new InMemoryA2ABroker();

  broker.registerWorker({
    nodeId: "stable-w",
    role: "operator",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
  });

  const farFutureMs = Date.now() + 600_000;
  const plan1 = broker.discoverCleanupCandidates({ staleWorkerAfterMs: 300_000, nowMs: farFutureMs });
  const plan2 = broker.discoverCleanupCandidates({ staleWorkerAfterMs: 300_000, nowMs: farFutureMs });

  assert.equal(plan1.candidates.length, plan2.candidates.length);
  assert.equal(plan1.candidates[0].id, plan2.candidates[0].id);
  assert.equal(plan1.candidates[0].id, "cleanup:stale-worker:stable-w");
});

test("discoverCleanupCandidates finds candidates not eligible for retention pruning (actionability gap)", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  // Stale worker with active tasks — discovered as candidate but blocks pruning
  broker.registerWorker({
    nodeId: "stale-active",
    role: "operator",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
  });
  const activeTask = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "stale-active", kind: "node", role: "operator" },
    payload: {},
  });
  broker.claimTask(activeTask.id, "stale-active");

  // Queued residue — non-terminal, not retention-prunable
  broker.createTask({
    intent: "backfill",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: { data: "residue" },
  });

  // Terminal task — completed but not past historical threshold (within 24h)
  const recentTerminal = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: {},
  });
  broker.claimTask(recentTerminal.id, "w1");
  broker.completeTask(recentTerminal.id, "w1", { summary: "done" });

  const farFutureMs = Date.now() + 600_000;
  const plan = broker.discoverCleanupCandidates({
    staleWorkerAfterMs: 300_000,
    staleTaskAfterMs: 120_000,
    nowMs: farFutureMs,
  });

  // Discovery finds multiple candidate classes
  assert.ok(plan.totalCandidates > 0, "should discover candidates");

  // stale_worker with active tasks — NOT prunable via retention
  const staleActive = plan.candidates.find((c) => c.class === "stale_worker" && c.metadata?.hasActiveTasks === true);
  assert.ok(staleActive, "should find stale worker with active tasks");
  assert.equal(staleActive!.risk, "high_risk");

  // queued_residue — NOT prunable via retention (non-terminal)
  const residue = plan.candidates.find((c) => c.class === "queued_residue");
  assert.ok(residue, "should find queued residue");

  // Recent terminal task should NOT show as historical_terminal_task (within threshold)
  const hist = plan.candidates.find((c) => c.class === "historical_terminal_task");
  assert.equal(hist, undefined, "recent terminal task should not be historical yet");

  // stale_worker (idle, no tasks) — NOT present because no idle stale worker exists
  const staleIdle = plan.candidates.filter(
    (c) => c.class === "stale_worker" && c.metadata?.hasActiveTasks !== true,
  );
  // Both workers have active claims; no idle stale workers
  assert.equal(staleIdle.length, 0, "all stale workers have active tasks");

  // Risk notes reflect non-prunable categories
  assert.ok(plan.riskNotes.some((n) => n.includes("Stale workers")));
  assert.ok(plan.riskNotes.some((n) => n.includes("Queued residue")));

  // Verify the actionability gap: discovered candidates > 0 but none are
  // eligible for automated retention pruning (queued_residue and stale_worker
  // with active tasks are discovery-only categories)
  const prunableClasses = new Set(["historical_terminal_task"]);
  const prunableCandidates = plan.candidates.filter((c) => prunableClasses.has(c.class));
  assert.equal(
    prunableCandidates.length,
    0,
    "no candidates prunable via retention alone — all require manual operator intervention",
  );
});

test("discoverCleanupCandidates risk notes correctly categorize actionable and non-actionable classes", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  // Register a worker that will be stale but has NO active tasks — actionable (safe to prune with opt-in)
  broker.registerWorker({
    nodeId: "idle-worker",
    role: "operator",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
  });

  // Create queued residue that ages past threshold
  broker.createTask({
    id: "old-residue",
    intent: "backfill",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: { data: "stale" },
  });

  // Create a malformed task (missing targetNodeId) that ages past threshold
  broker.createTask({
    id: "old-malformed",
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: { temp: "x" },
  });
  const malformedRaw = broker.getTask("old-malformed")!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (malformedRaw as any).targetNodeId = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (malformedRaw as any).payload = {};
  malformedRaw.updatedAt = new Date(Date.now() - 600_000).toISOString();

  const farFutureMs = Date.now() + 600_000;
  const plan = broker.discoverCleanupCandidates({
    staleWorkerAfterMs: 300_000,
    staleTaskAfterMs: 120_000,
    nowMs: farFutureMs,
  });

  // Should find at least some candidates
  assert.ok(plan.riskNotes.length > 0, "should have risk notes");

  // Verify each candidate has a valid risk classification matching the actionability doc
  assert.ok(plan.candidates.length > 0, "should find candidates");
  assert.ok(
    plan.candidates.every((c) => ["high_risk", "caution", "safe"].includes(c.risk)),
    "all candidates should have valid risk classification",
  );

  // Risk notes should exist for discovered classes
  if (plan.summary.stale_worker > 0) {
    assert.ok(
      plan.riskNotes.some((n) => n.includes("Stale workers")),
      "stale worker risk note present",
    );
  }
  if (plan.summary.queued_residue > 0) {
    assert.ok(
      plan.riskNotes.some((n) => n.includes("Queued residue")),
      "queued residue risk note present",
    );
  }
  if (plan.summary.malformed_task > 0) {
    assert.ok(
      plan.riskNotes.some((n) => n.includes("Malformed queued tasks")),
      "malformed task risk note present",
    );
  }

  // Verify that stale_worker (no tasks) is "caution" — actionable with opt-in
  const idleStale = plan.candidates.find(
    (c) => c.class === "stale_worker" && c.metadata?.hasActiveTasks === false,
  );
  if (idleStale) {
    assert.equal(idleStale.risk, "caution", "idle stale worker should be caution risk");
  }

  // queued_residue is "caution" — requires manual intervention, not automated pruning
  const residue = plan.candidates.find((c) => c.class === "queued_residue");
  if (residue) {
    assert.equal(residue.risk, "caution", "queued residue should be caution risk");
  }

  // malformed_task is "caution" — requires manual inspection
  const malformed = plan.candidates.find((c) => c.class === "malformed_task");
  if (malformed) {
    assert.equal(malformed.risk, "caution", "malformed task should be caution risk");
  }
});

// ---------------------------------------------------------------------------
// Mobile worker health in broker-facing status
// ---------------------------------------------------------------------------

test("getWorkerCapacitySummary includes workerMode and mobileHealth for mobile workers", () => {
  const broker = new InMemoryA2ABroker();
  const nowMs = Date.now();

  // Register a persistent worker (control)
  broker.registerWorker({
    nodeId: "persistent-w1",
    role: "analyst",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["test"], environments: ["research"] },
  });

  // Register a mobile worker with recent heartbeat
  broker.registerWorker({
    nodeId: "mobilealpha",
    role: "analyst",
    workerMode: "mobile",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["hermes-no-live"], environments: ["research"] },
    metadata: { runtime: "hermes-agent", transport: "http-poll" },
  });

  // Recent heartbeat (within mobile 30s window)
  broker.heartbeatWorker("mobilealpha", { capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["hermes-no-live"], environments: ["research"] } });

  const summary = broker.getWorkerCapacitySummary({ nowMs });

  // Persistent worker: no mobileHealth, no workerMode
  const persistentItem = summary.items.find((i) => i.nodeId === "persistent-w1");
  assert.ok(persistentItem);
  assert.equal(persistentItem.workerMode, undefined);
  assert.equal(persistentItem.mobileHealth, undefined);

  // Mobile worker (online): has workerMode and mobileHealth
  const mobileItem = summary.items.find((i) => i.nodeId === "mobilealpha");
  assert.ok(mobileItem);
  assert.equal(mobileItem.workerMode, "mobile");
  assert.equal(mobileItem.mobileHealth, "health_ok");
});

test("getWorkerCapacitySummary exposes runtimeFlavor and gatewayRequired for poll-only workers", () => {
  const broker = new InMemoryA2ABroker();

  broker.registerWorker({
    nodeId: "workerbeta-poll-only",
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: true,
      canPromoteLive: false,
      workspaceIds: ["team1"],
      environments: ["research"],
      runtimeFlavor: "openclaw-poll-handler",
      gatewayRequired: false,
    },
    metadata: {
      workerProfile: "openclaw-poll-only",
      executionPlane: "broker-poll-http-handler",
    },
  });

  const summary = broker.getWorkerCapacitySummary();
  const item = summary.items.find((i) => i.nodeId === "workerbeta-poll-only");
  assert.ok(item);
  assert.equal(item.runtimeFlavor, "openclaw-poll-handler");
  assert.equal(item.gatewayRequired, false);
});

test("getWorkerCapacitySummary classifies mobile worker as stale beyond mobile threshold", () => {
  const broker = new InMemoryA2ABroker();

  // Register a mobile worker at time zero
  broker.registerWorker({
    nodeId: "mobilebeta",
    role: "analyst",
    workerMode: "mobile",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["hermes-no-live"], environments: ["research"] },
    metadata: { runtime: "hermes-agent", transport: "http-poll" },
  });

  // Advance time to 35s after registration — past mobile 30s window, within 90s extended window
  // The broker "now" is set to lastSeenAt + 35_000 ms
  const worker = broker.getWorker("mobilebeta");
  assert.ok(worker);
  const workerSeenMs = Date.parse(worker.lastSeenAt);
  const nowMs = workerSeenMs + 35_000;

  const summary = broker.getWorkerCapacitySummary({ nowMs });

  const mobilebeta = summary.items.find((i) => i.nodeId === "mobilebeta");
  assert.ok(mobilebeta);
  assert.equal(mobilebeta.workerMode, "mobile");
  // Mobile past 30s => stale, but not yet disconnected (within 90s)
  assert.equal(mobilebeta.mobileHealth, "stale");
  // Brokers' generic status reflects mobile-aware threshold
  assert.equal(mobilebeta.status, "stale");
});

test("getWorkerCapacitySummary classifies mobile worker as disconnected past extended threshold", () => {
  const broker = new InMemoryA2ABroker();

  broker.registerWorker({
    nodeId: "mobilebeta-disconnected",
    role: "analyst",
    workerMode: "mobile",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["hermes-no-live"], environments: ["research"] },
    metadata: { runtime: "hermes-agent", transport: "http-poll" },
  });

  const worker = broker.getWorker("mobilebeta-disconnected");
  assert.ok(worker);
  const workerSeenMs = Date.parse(worker.lastSeenAt);
  // 100s — well beyond both 30s mobile and 90s extended threshold
  const nowMs = workerSeenMs + 100_000;

  const summary = broker.getWorkerCapacitySummary({ nowMs });

  const mobilebeta = summary.items.find((i) => i.nodeId === "mobilebeta-disconnected");
  assert.ok(mobilebeta);
  assert.equal(mobilebeta.workerMode, "mobile");
  assert.equal(mobilebeta.mobileHealth, "disconnected");
  assert.equal(mobilebeta.status, "stale");
});

test("getDashboard includes workerMode and mobileHealth for mobile workers", () => {
  const broker = new InMemoryA2ABroker();

  broker.registerWorker({
    nodeId: "persistent-w2",
    role: "analyst",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["test"], environments: ["research"] },
  });

  broker.registerWorker({
    nodeId: "mobilealpha-dash",
    role: "analyst",
    workerMode: "mobile",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["hermes-no-live"], environments: ["research"] },
    metadata: { runtime: "hermes-agent", transport: "http-poll" },
  });
  broker.heartbeatWorker("mobilealpha-dash", { capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["hermes-no-live"], environments: ["research"] } });

  const dashboard = broker.getDashboard({ nowMs: Date.now(), offlineAfterMs: 90_000 });

  // Persistent worker: no mobile fields
  const persistentNode = dashboard.workers.byNode.find((w) => w.nodeId === "persistent-w2");
  assert.ok(persistentNode);
  assert.equal(persistentNode.workerMode, undefined);
  assert.equal(persistentNode.mobileHealth, undefined);

  // Mobile worker (online)
  const mobileNode = dashboard.workers.byNode.find((w) => w.nodeId === "mobilealpha-dash");
  assert.ok(mobileNode);
  assert.equal(mobileNode.workerMode, "mobile");
  assert.equal(mobileNode.mobileHealth, "health_ok");
  assert.equal(mobileNode.status, "online");
});

test("getDashboard fleet worker counts use mobile-aware stale thresholds", () => {
  const broker = new InMemoryA2ABroker();

  // Register one persistent and one mobile worker
  broker.registerWorker({
    nodeId: "persistent-a",
    role: "analyst",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["test"], environments: ["research"] },
  });
  broker.registerWorker({
    nodeId: "mobilealpha-fleet",
    role: "analyst",
    workerMode: "mobile",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["hermes-no-live"], environments: ["research"] },
    metadata: { runtime: "hermes-agent", transport: "http-poll" },
  });

  const persistentWorker = broker.getWorker("persistent-a");
  const mobileWorker = broker.getWorker("mobilealpha-fleet");
  assert.ok(persistentWorker);
  assert.ok(mobileWorker);

  const persistentSeenMs = Date.parse(persistentWorker.lastSeenAt);
  const mobileSeenMs = Date.parse(mobileWorker.lastSeenAt);

  // Advance time to 45s after registration:
  //   - persistent worker still within 90s window => online
  //   - mobile worker past its 30s window but within 90s extended => stale
  const nowMs = Math.max(persistentSeenMs, mobileSeenMs) + 45_000;

  const dashboard = broker.getDashboard({ nowMs, offlineAfterMs: 90_000 });

  // Fleet totals reflect mode-aware staleness
  assert.equal(dashboard.workers.total, 2);
  assert.equal(dashboard.workers.online, 1, "persistent still online at 45s");
  assert.equal(dashboard.workers.stale, 1, "mobile stale at 45s");

  const persistentNode = dashboard.workers.byNode.find((w) => w.nodeId === "persistent-a");
  const mobileNode = dashboard.workers.byNode.find((w) => w.nodeId === "mobilealpha-fleet");
  assert.ok(persistentNode);
  assert.ok(mobileNode);

  assert.equal(persistentNode.status, "online");
  assert.equal(persistentNode.workerMode, undefined);
  assert.equal(persistentNode.mobileHealth, undefined);

  assert.equal(mobileNode.status, "stale");
  assert.equal(mobileNode.workerMode, "mobile");
  assert.equal(mobileNode.mobileHealth, "stale");
});

test("computeWorkerMobileHealth returns undefined for persistent workers", () => {
  const broker = new InMemoryA2ABroker();
  broker.registerWorker({
    nodeId: "persistent-b",
    role: "analyst",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["test"], environments: ["research"] },
  });

  const summary = broker.getWorkerCapacitySummary();
  const item = summary.items.find((i) => i.nodeId === "persistent-b");
  assert.ok(item);
  assert.equal(item.workerMode, undefined);
  assert.equal(item.mobileHealth, undefined);
});

test("getWorkerCapacitySummary mobile fields present for mobile workers, absent for persistent", () => {
  const broker = new InMemoryA2ABroker();

  // Register a mix of mobile and persistent workers
  broker.registerWorker({
    nodeId: "mobilealpha-mix",
    role: "analyst",
    workerMode: "mobile",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["hermes-no-live"], environments: ["research"] },
    metadata: { runtime: "hermes-agent", transport: "http-poll" },
  });
  broker.registerWorker({
    nodeId: "mobilebeta-mix",
    role: "analyst",
    workerMode: "mobile",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["hermes-no-live"], environments: ["research"] },
    metadata: { runtime: "hermes-agent", transport: "http-poll" },
  });
  broker.registerWorker({
    nodeId: "persistent-c",
    role: "analyst",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["test"], environments: ["research"] },
  });
  broker.registerWorker({
    nodeId: "persistent-d",
    role: "analyst",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["test"], environments: ["research"] },
  });

  // Heartbeat mobilealpha so it's fresh; mobilebeta stays at registration time
  broker.heartbeatWorker("mobilealpha-mix", { capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["hermes-no-live"], environments: ["research"] } });

  // Query at the current time — all workers should be online since
  // registration and heartbeat are all within the 90s persistent window
  const summary = broker.getWorkerCapacitySummary();
  assert.equal(summary.totals.workers, 4);

  // Mobile items carry workerMode and mobileHealth
  const mobilealpha = summary.items.find((i) => i.nodeId === "mobilealpha-mix");
  const mobilebeta = summary.items.find((i) => i.nodeId === "mobilebeta-mix");
  assert.ok(mobilealpha);
  assert.ok(mobilebeta);
  assert.equal(mobilealpha.workerMode, "mobile");
  assert.ok(mobilealpha.mobileHealth); // could be "health_ok" or "stale" depending on timing
  assert.equal(mobilebeta.workerMode, "mobile");
  assert.ok(mobilebeta.mobileHealth);

  // Persistent items have neither field
  assert.equal(summary.items.find((i) => i.nodeId === "persistent-c")?.workerMode, undefined);
  assert.equal(summary.items.find((i) => i.nodeId === "persistent-c")?.mobileHealth, undefined);
  assert.equal(summary.items.find((i) => i.nodeId === "persistent-d")?.workerMode, undefined);
  assert.equal(summary.items.find((i) => i.nodeId === "persistent-d")?.mobileHealth, undefined);
});

test("Hermes native worker submits redacted done evidence via completeTask", () => {
  const broker = new InMemoryA2ABroker();

  broker.registerWorker({
    nodeId: "hermes-evidence-tester",
    role: "analyst",
    workerMode: "mobile",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: true,
      canPromoteLive: false,
      workspaceIds: ["hermes-no-live"],
      environments: ["research"],
      runtimeFlavor: "termux-hermes",
      gatewayRequired: false,
    },
    metadata: { runtime: "hermes-agent", transport: "http-poll" },
  });

  const task = broker.createTask({
    id: "hermes-evidence-task",
    requester: { id: "hub-requester", kind: "service", role: "hub" },
    target: { id: "hermes-evidence-tester", kind: "node", role: "analyst" },
    assignedWorkerId: "hermes-evidence-tester",
    intent: "analyze",
    message: "Hermes worker evidence contract test",
    payload: { source: "hermes-evidence-contract-test" },
    taskOrigin: "api",
  });
  assert.equal(task.status, "queued");

  broker.claimTask(task.id, "hermes-evidence-tester");
  broker.startTask(task.id, "hermes-evidence-tester");

  const result = broker.completeTask(task.id, "hermes-evidence-tester", {
    summary: "Hermes worker produced redacted terminal evidence",
    output: { referenceWorker: "hermes-agent", openClawRequired: false, operatorNote: "source-only; no provider ids" },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.result?.summary, "Hermes worker produced redacted terminal evidence");
  assert.deepEqual(result.result?.output, { referenceWorker: "hermes-agent", openClawRequired: false, operatorNote: "source-only; no provider ids" });
  assert.equal(result.assignedWorkerId, "hermes-evidence-tester");
});

test("Hermes native worker submits redacted blocked evidence via failTask", () => {
  const broker = new InMemoryA2ABroker();

  broker.registerWorker({
    nodeId: "hermes-blocked-tester",
    role: "analyst",
    workerMode: "mobile",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["hermes-no-live"],
      environments: ["research"],
      runtimeFlavor: "termux-hermes",
      gatewayRequired: false,
    },
  });

  const task = broker.createTask({
    id: "hermes-blocked-evidence-task",
    requester: { id: "hub-requester", kind: "service", role: "hub" },
    target: { id: "hermes-blocked-tester", kind: "node", role: "analyst" },
    assignedWorkerId: "hermes-blocked-tester",
    intent: "analyze",
    message: "Hermes worker blocked evidence test",
    payload: { source: "hermes-blocked-evidence-test" },
    taskOrigin: "api",
  });
  assert.equal(task.status, "queued");

  broker.claimTask(task.id, "hermes-blocked-tester");
  broker.startTask(task.id, "hermes-blocked-tester");

  const result = broker.failTask(task.id, "hermes-blocked-tester", {
    code: "blocked",
    message: "Preflight no-live gate rejected live promotion attempt",
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "blocked");
  assert.equal(result.error?.message, "Preflight no-live gate rejected live promotion attempt");
});

test("Hermes mobile worker transitions through health_ok, stale, disconnected", () => {
  const broker = new InMemoryA2ABroker();

  broker.registerWorker({
    nodeId: "hermes-health-tester",
    role: "analyst",
    workerMode: "mobile",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["hermes-no-live"],
      environments: ["research"],
      runtimeFlavor: "termux-hermes",
      gatewayRequired: false,
    },
  });

  const nowMs = Date.now();
  let summary = broker.getWorkerCapacitySummary({ nowMs });
  const worker = summary.items.find((i) => i.nodeId === "hermes-health-tester");
  assert.ok(worker);
  assert.equal(worker.status, "online");
  assert.equal(worker.workerMode, "mobile");
  assert.equal(worker.mobileHealth, "health_ok");

  const staleNowMs = nowMs + 45_000;
  summary = broker.getWorkerCapacitySummary({ nowMs: staleNowMs });
  const staleWorker = summary.items.find((i) => i.nodeId === "hermes-health-tester");
  assert.ok(staleWorker);
  assert.equal(staleWorker.status, "stale");
  assert.equal(staleWorker.mobileHealth, "stale");

  const disconnectedNowMs = nowMs + 100_000;
  summary = broker.getWorkerCapacitySummary({ nowMs: disconnectedNowMs });
  const disconnectedWorker = summary.items.find((i) => i.nodeId === "hermes-health-tester");
  assert.ok(disconnectedWorker);
  assert.equal(disconnectedWorker.status, "stale");
  assert.equal(disconnectedWorker.mobileHealth, "disconnected");
});

test("Hermes worker registration preserves runtimeFlavor and gatewayRequired in read model", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-hermes-read-model-"));
  const sqliteStore = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const noopStore: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: () => undefined,
  };

  try {
    const broker = new InMemoryA2ABroker(noopStore, noopStore.load(), {
      workerRepository: new SqliteWorkerRuntimeRepository(sqliteStore),
    });

    broker.registerWorker({
      nodeId: "hermes-read-model",
      role: "analyst",
      displayName: "Hermes Read Model Tester",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: true,
        canPromoteLive: false,
        workspaceIds: ["hermes-no-live"],
        environments: ["research"],
        runtimeFlavor: "termux-hermes",
        gatewayRequired: false,
      },
      workerMode: "mobile",
      metadata: { runtime: "hermes-agent", transport: "http-poll" },
    });

    const hot = sqliteStore.readHotWorkers({ nodeId: "hermes-read-model" });
    assert.equal(hot.length, 1);
    assert.equal(hot[0]?.capabilities.runtimeFlavor, "termux-hermes");
    assert.equal(hot[0]?.capabilities.gatewayRequired, false);
    assert.equal(hot[0]?.workerMode, "mobile");

    const worker = broker.getWorker("hermes-read-model");
    assert.ok(worker);
    assert.equal(worker.capabilities.runtimeFlavor, "termux-hermes");
    assert.equal(worker.capabilities.gatewayRequired, false);
    assert.equal(worker.workerMode, "mobile");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Exchange/proposal state-machine regressions (a2a-nexus#573 items 4, 5)
// ───────────────────────────────────────────────────────────────────────────

test("a plain thread reply does not requeue a running exchange (item 4)", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "broker-a" });
  registerWorker(broker, "worker-a");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "start",
    intent: "chat",
  });

  broker.addExchangeMessage(exchange.id, {
    actor: { id: "worker-a", kind: "node", role: "analyst" },
    message: "accepting",
    decision: "accepted",
  });
  const running = broker.getExchange(exchange.id)!;
  assert.equal(running.status, "running");
  const taskId = running.activeTaskId;
  assert.ok(taskId, "accepted decision should create a task");

  // A plain chat reply with no decision and no explicit target/worker must not
  // flip the running exchange back to queued or spawn a second task.
  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "just a reply",
  });
  const after = broker.getExchange(exchange.id)!;
  assert.equal(after.status, "running", "plain reply must not requeue a running exchange");
  assert.equal(after.activeTaskId, taskId, "plain reply must not spawn a new task");
});

test("a plain thread reply on a fresh exchange does not spawn a task (item 4)", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "broker-a" });
  registerWorker(broker, "worker-a");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "start",
    intent: "chat",
  });
  assert.equal(broker.getExchange(exchange.id)?.activeTaskId, undefined);

  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "just chatting",
  });
  assert.equal(
    broker.getExchange(exchange.id)?.activeTaskId,
    undefined,
    "a decision-less reply with no explicit routing must not create a task",
  );
});

test("a thread message with an explicit target still assigns a task (item 4)", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "broker-a" });
  registerWorker(broker, "worker-a");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "start",
    intent: "chat",
  });

  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "please take this",
    targetNodeId: "worker-a",
  });
  assert.ok(
    broker.getExchange(exchange.id)?.activeTaskId,
    "an explicit routing target must still assign a task",
  );
});

test("submitValidationResult does not rewind an approved proposal (item 5)", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "broker-a" });

  const proposal = broker.createProposal({
    source: { id: "research-a", kind: "node", role: "researcher" },
    target: { id: "live-a", kind: "node", role: "live-trader" },
    kind: "patch",
    summary: "state machine regression",
    workspace: { nodeId: "live-a", workspaceId: "repo" },
    patchText: "diff --git a/file b/file",
  });

  broker.submitValidationResult(proposal.id, { nodeId: "live-a", kind: "smoke", verdict: "pass" });
  broker.approveProposal(proposal.id, { actor: { id: "live-a", kind: "node", role: "live-trader" } });
  assert.equal(broker.getProposal(proposal.id)?.status, "approved");

  // A stale validation (e.g. a validate_change task completing late) must not
  // rewind the proposal to "validated" and reopen a second approve/apply cycle.
  broker.submitValidationResult(proposal.id, { nodeId: "live-a", kind: "smoke", verdict: "pass" });
  assert.equal(
    broker.getProposal(proposal.id)?.status,
    "approved",
    "a late validation must not rewind an approved proposal",
  );
});

// ───────────────────────────────────────────────────────────────────────────
// Persistence/terminal-state consistency regressions (a2a-nexus#573 items 15, 16)
// ───────────────────────────────────────────────────────────────────────────

test("failTask persists the tombstone in the same snapshot as the failed task (item 15)", () => {
  const snapshots: BrokerSnapshot[] = [];
  const store = {
    load: () => emptySnapshot(),
    save: (snapshot: BrokerSnapshot) => snapshots.push(structuredClone(snapshot)),
  };
  const broker = new InMemoryA2ABroker(store, store.load());
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    id: "fail-tombstone-order",
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "x",
  });
  broker.claimTask(task.id, "worker-a");
  snapshots.length = 0;

  broker.failTask(task.id, "worker-a", { code: "boom", message: "m" });

  // The persistState() inside failTask must already include the tombstone, not
  // just the failed task — otherwise a crash before the next persist loses it.
  const last = snapshots.at(-1);
  assert.ok(last, "failTask should have persisted at least once");
  assert.equal(last!.tasks.find((t) => t.id === task.id)?.status, "failed");
  assert.ok(
    last!.tombstones?.some((tomb) => tomb.taskId === task.id),
    "the tombstone must be in the same snapshot as the failed task",
  );
});

test("cancelTask persists the tombstone in the same snapshot as the canceled task (item 15)", () => {
  const snapshots: BrokerSnapshot[] = [];
  const store = {
    load: () => emptySnapshot(),
    save: (snapshot: BrokerSnapshot) => snapshots.push(structuredClone(snapshot)),
  };
  const broker = new InMemoryA2ABroker(store, store.load());
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    id: "cancel-tombstone-order",
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "x",
  });
  snapshots.length = 0;

  broker.cancelTask(task.id, { actor: { id: "hub-a", kind: "node", role: "hub" }, reason: "no longer needed" });

  const last = snapshots.at(-1);
  assert.ok(last, "cancelTask should have persisted at least once");
  assert.equal(last!.tasks.find((t) => t.id === task.id)?.status, "canceled");
  assert.ok(
    last!.tombstones?.some((tomb) => tomb.taskId === task.id),
    "the tombstone must be in the same snapshot as the canceled task",
  );
});

test("a declined exchange ends with status failed, not queued (item 16)", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "broker-a" });
  registerWorker(broker, "worker-a");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "start",
    intent: "chat",
  });
  broker.addExchangeMessage(exchange.id, {
    actor: { id: "worker-a", kind: "node", role: "analyst" },
    message: "accepting",
    decision: "accepted",
  });
  assert.equal(broker.getExchange(exchange.id)?.status, "running");

  broker.addExchangeMessage(exchange.id, {
    actor: { id: "worker-a", kind: "node", role: "analyst" },
    message: "declining",
    decision: "declined",
  });

  assert.equal(
    broker.getExchange(exchange.id)?.status,
    "failed",
    "a declined exchange must terminate as failed",
  );
});

test("broker retention prunes task event buffers and seqs for pruned tasks", async () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    retention: {
      terminalRetentionMs: 0,
      maxTerminalTasks: 0,
    },
  });
  registerWorker(broker, "worker-buffer-prune");
  const task = createWorkerTask(broker, "task-buffer-prune", "worker-buffer-prune");

  // An active subscriber makes emitTaskUpdate start buffering replay events.
  const unsubscribe = broker.subscribeToTask(task.id, () => {});
  broker.claimTask(task.id, "worker-buffer-prune");
  broker.startTask(task.id, "worker-buffer-prune");
  broker.completeTask(task.id, "worker-buffer-prune", { summary: "done" });
  unsubscribe();

  assert.equal(
    broker.getCompactDiagnostics().tasks.bufferedEventStreams,
    1,
    "terminal task should still hold a replay buffer before retention runs",
  );
  assert.ok(broker.replayTaskEvents(task.id, 0).length > 0);

  // The retention cutoff is `now - retentionMs`; a task completed in the very
  // same millisecond as the retention pass is still "within" zero retention,
  // so let the clock tick before triggering it.
  await new Promise((resolve) => setTimeout(resolve, 5));

  // Any persisted mutation triggers a full-retention persistState pass.
  registerWorker(broker, "worker-buffer-prune-2");

  assert.equal(
    broker.getCompactDiagnostics().tasks.bufferedEventStreams,
    0,
    "retention must prune event buffers of pruned tasks",
  );
  assert.deepEqual(broker.replayTaskEvents(task.id, 0), []);
});

// ---------------------------------------------------------------------------
// Checkpoint lifecycle gate (a2a-nexus#617 review; contracts/a2a/checkpoint-interrupt.md)
// ---------------------------------------------------------------------------

test("an active checkpoint blocks terminal worker mutations until resume or cancel", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-ckgate");
  const task = createWorkerTask(broker, "ckgate-1", "worker-ckgate");
  broker.claimTask(task.id, "worker-ckgate");
  broker.startTask(task.id, "worker-ckgate");
  broker.checkpointTask(task.id, "worker-ckgate", { state: "awaiting_operator", reason: "need operator input" });

  // Terminal mutations are gated while the checkpoint is active.
  assert.throws(() => broker.completeTask(task.id, "worker-ckgate", { summary: "done" }), /checkpoint is active/);
  assert.throws(() => broker.failTask(task.id, "worker-ckgate", { code: "x", message: "boom" }), /checkpoint is active/);
  assert.equal(broker.getTask(task.id)?.status, "running", "gate must not mutate the task");

  // Resume reopens the terminal path.
  broker.resumeTask(task.id, "worker-ckgate");
  const done = broker.completeTask(task.id, "worker-ckgate", { summary: "done" });
  assert.equal(done.status, "succeeded");
  assert.equal(done.checkpoint, undefined, "no stale checkpoint metadata on a terminal task");
});

test("cancel clears an active checkpoint instead of leaving stale metadata", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-ckcancel");
  const task = createWorkerTask(broker, "ckcancel-1", "worker-ckcancel");
  broker.claimTask(task.id, "worker-ckcancel");
  broker.checkpointTask(task.id, "worker-ckcancel", { state: "paused" });
  const canceled = broker.cancelTask(task.id, { actor: { id: "hub-a", kind: "node", role: "hub" }, reason: "operator cancel" });
  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.checkpoint, undefined, "cancel is a sanctioned checkpoint exit; metadata must be cleared");
});

test("the stale reaper does not requeue checkpointed tasks; checkpoint expiry cancels instead", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { checkpointTimeoutMs: 60_000 });
  registerWorker(broker, "worker-ckreap");
  const task = createWorkerTask(broker, "ckreap-1", "worker-ckreap");
  broker.claimTask(task.id, "worker-ckreap");
  broker.startTask(task.id, "worker-ckreap");
  broker.checkpointTask(task.id, "worker-ckreap", { state: "awaiting_operator", reason: "waiting on operator" });

  // Far past the stale threshold but inside the checkpoint timeout: the task
  // is deliberately suspended, not stale — no requeue, projection unchanged.
  const requeued = broker.requeueStaleTasks(0, { nowMs: Date.now() + 30_000 });
  assert.equal(requeued.length, 0, "checkpointed tasks are excluded from stale requeue");
  const still = broker.getTask(task.id);
  assert.equal(still?.status, "running");
  assert.equal(still?.checkpoint?.state, "awaiting_operator");

  // Past the checkpoint timeout: contract §2.3 — transition to cancelled.
  broker.requeueStaleTasks(0, { nowMs: Date.now() + 61_000 });
  const expired = broker.getTask(task.id);
  assert.equal(expired?.status, "canceled", "expired checkpoint must cancel the task");
  assert.equal(expired?.checkpoint, undefined, "no stale checkpoint metadata after expiry");
  assert.match(expired?.cancellation?.reason ?? "", /expired/);
});

test("checkpoint inputs are bounded and decision-typed before becoming operator-visible state", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-ckbounds");
  const task = createWorkerTask(broker, "ckbounds-1", "worker-ckbounds");
  broker.claimTask(task.id, "worker-ckbounds");

  assert.throws(
    () => broker.checkpointTask(task.id, "worker-ckbounds", { state: "awaiting_operator", reason: "x".repeat(501) }),
    /500/,
    "overlong reason rejected",
  );
  assert.throws(
    () => broker.checkpointTask(task.id, "worker-ckbounds", { state: "awaiting_operator", reason: "bad\u0007bell" }),
    /control characters/,
    "control characters rejected",
  );
  assert.throws(
    () => broker.checkpointTask(task.id, "worker-ckbounds", { state: "awaiting_operator", checkpointId: "bad id with spaces!" }),
    /checkpointId/,
    "checkpointId charset bounded",
  );
  assert.throws(
    () => broker.checkpointTask(task.id, "worker-ckbounds", { state: "awaiting_operator", decisionType: "nuke_everything" }),
    /decisionType/,
    "unknown decision type rejected (contract v0 freeze)",
  );
  assert.throws(
    () => broker.checkpointTask(task.id, "worker-ckbounds", { state: "paused", decisionType: "safety_gate" }),
    /only applies/,
    "decisionType is interrupt-only",
  );
  assert.throws(
    () => broker.checkpointTask(task.id, "worker-ckbounds", { state: "paused", artifactRefs: Array.from({ length: 33 }, (_, i) => `a/${i}`) }),
    /32/,
    "artifactRefs count bounded",
  );

  const interrupted = broker.checkpointTask(task.id, "worker-ckbounds", {
    state: "awaiting_operator",
    decisionType: "safety_gate",
    artifactRefs: ["contracts/a2a/checkpoint-interrupt.md"],
    reason: "operator must confirm",
  });
  assert.equal(interrupted.checkpoint?.decisionType, "safety_gate");
  assert.deepEqual(interrupted.checkpoint?.artifactRefs, ["contracts/a2a/checkpoint-interrupt.md"]);

  // Default decision type for an unannotated interrupt is approval_required.
  broker.resumeTask(task.id, "worker-ckbounds");
  const defaulted = broker.checkpointTask(task.id, "worker-ckbounds", { state: "awaiting_operator" });
  assert.equal(defaulted.checkpoint?.decisionType, "approval_required");
});

test("checkpoint and resume emit dedicated task event reasons", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-ckevents");
  const task = createWorkerTask(broker, "ckevents-1", "worker-ckevents");
  broker.claimTask(task.id, "worker-ckevents");
  const reasons: string[] = [];
  const unsubscribe = broker.subscribeToTask(task.id, (update) => {
    reasons.push(update.reason);
  });
  broker.checkpointTask(task.id, "worker-ckevents", { state: "paused" });
  broker.resumeTask(task.id, "worker-ckevents");
  unsubscribe();
  assert.ok(reasons.includes("checkpointed"), `expected checkpointed in ${reasons.join(",")}`);
  assert.ok(reasons.includes("resumed"), `expected resumed in ${reasons.join(",")}`);
});
