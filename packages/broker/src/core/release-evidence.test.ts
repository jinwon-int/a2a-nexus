import test from "node:test";
import assert from "node:assert/strict";

import { buildReleaseEvidenceExport, renderReleaseEvidenceMarkdown } from "./release-evidence.js";
import type { TaskRecord, TaskStatus } from "./types.js";

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    intent: "propose_patch",
    requester: { id: "operator", kind: "user", role: "operator" },
    target: { id: "workerepsilon", kind: "node", role: "analyst" },
    targetNodeId: "workerepsilon",
    assignedWorkerId: "workerepsilon",
    payload: { issue: 479, issueUrl: "https://github.com/jinwon-int/a2a-broker/issues/479" },
    status: "queued",
    createdAt: "2026-05-10T13:30:00.000Z",
    updatedAt: "2026-05-10T13:31:00.000Z",
    taskOrigin: "github",
    ...overrides,
  };
}

function terminal(id: string, status: TaskStatus, output: Record<string, unknown>): TaskRecord {
  return task({
    id,
    status,
    claimedBy: "workerepsilon",
    completedAt: "2026-05-10T13:35:00.000Z",
    updatedAt: "2026-05-10T13:35:00.000Z",
    result: { output },
  });
}

test("release evidence export summarizes PR, Done, Block, and missing terminal evidence", () => {
  const report = buildReleaseEvidenceExport([
    terminal("task-pr", "succeeded", { github: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/501" } }),
    terminal("task-done", "succeeded", { doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413329" }),
    terminal("task-block", "failed", { github: { blockCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413330" } }),
    task({ id: "task-active", status: "running" }),
    task({ id: "task-missing", status: "failed", error: { message: "runner exited" } }),
  ], {
    generatedAt: "2026-05-10T13:40:00.000Z",
    repo: "jinwon-int/a2a-broker",
    issue: "#479",
    parentIssue: "a2a-plane#197 (internal tracker, private)",
    runId: "a2a-source-dryrun-orchestrator-20260510T133022Z",
  });

  assert.equal(report.kind, "broker.release-evidence.export");
  assert.equal(report.mode, "dry-run/read-only");
  assert.equal(report.readOnly, true);
  assert.equal(report.gates.liveActionAllowed, false);
  assert.equal(report.gates.mutationAllowed, false);
  assert.equal(report.gates.ok, false, "missing terminal evidence should block closeout");
  assert.deepEqual(report.taskSummary, {
    total: 5,
    active: 1,
    terminal: 4,
    byStatus: {
      blocked: 0,
      queued: 0,
      claimed: 0,
      running: 1,
      succeeded: 2,
      failed: 2,
      canceled: 0,
    },
  });
  assert.equal(report.evidenceSummary.pr, 1);
  assert.equal(report.evidenceSummary.done, 1);
  assert.equal(report.evidenceSummary.block, 1);
  assert.equal(report.evidenceSummary.missing, 1);
  assert.deepEqual(report.links.pullRequests, ["https://github.com/jinwon-int/a2a-broker/pull/501"]);
  assert.deepEqual(report.links.doneComments, ["https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413329"]);
  assert.deepEqual(report.links.blockComments, ["https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413330"]);

  const markdown = renderReleaseEvidenceMarkdown(report);
  assert.match(markdown, /^Block: broker read-only release evidence export/);
  assert.match(markdown, /liveActionAllowed=false mutationAllowed=false/);
});

test("release evidence export redacts unsafe local paths and secret-like values", () => {
  const report = buildReleaseEvidenceExport([
    terminal("/work/repo/token-task", "succeeded", {
      github: {
        prUrl: "file:///work/repo/private-token.log",
        doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413329",
        branchUrl: "https://github.com/jinwon-int/a2a-broker/tree/BROKER_EDGE_SECRET=oops",
      },
    }),
  ], { runId: "safe-run" });

  assert.equal(report.items[0]?.taskId, "<redacted>");
  assert.equal(report.items[0]?.evidenceKind, "done");
  assert.equal(report.items[0]?.prUrl, undefined);
  assert.equal(report.items[0]?.branchUrl, undefined);

  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /\/work\/repo|private-token|BROKER_EDGE_SECRET|oops/i);
});

test("release evidence export blocks when observed no-live safety flags are set", () => {
  const report = buildReleaseEvidenceExport([
    terminal("task-done", "succeeded", { doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413329" }),
  ], { observedActions: { providerCalled: true } });

  assert.equal(report.gates.ok, false);
  assert.equal(report.gates.observedActions.providerCalled, true);
});

test("release evidence export blocks when auto-close activation is observed", () => {
  const report = buildReleaseEvidenceExport([
    terminal("task-done", "succeeded", { doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413329" }),
  ], { observedActions: { autoCloseActivated: true } });

  assert.equal(report.gates.ok, false, "auto-close activation should block the closeout gate");
  assert.equal(report.gates.observedActions.autoCloseActivated, true);
  assert.ok(report.gates.prohibitedActions.includes("auto_close_activation"), "auto_close_activation must be in the prohibited actions list");

  const markdown = renderReleaseEvidenceMarkdown(report);
  assert.match(markdown, /liveActionAllowed=false mutationAllowed=false/);
});

test("release evidence export clean when autoCloseActivated is false", () => {
  const report = buildReleaseEvidenceExport([
    terminal("task-done", "succeeded", { doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413329" }),
  ], { observedActions: { autoCloseActivated: false } });

  assert.equal(report.gates.ok, true, "false autoCloseActivated should not block");
  assert.equal(report.gates.observedActions.autoCloseActivated, false);
});

test("release evidence export redacts OpenClaw runtime/bootstrap paths in task ids and output", () => {
  const report = buildReleaseEvidenceExport([
    terminal("AGENTS.md", "succeeded", {
      doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413329",
      github: {
        branchUrl: "https://github.com/jinwon-int/a2a-broker/tree/SOUL.md",
        prUrl: "https://github.com/jinwon-int/a2a-broker/pull/TOOLS.md",
      },
    }),
  ]);

  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /AGENTS\.md|SOUL\.md|TOOLS\.md|HEARTBEAT\.md|IDENTITY\.md|\.openclaw/i);
});

test("release evidence export surfaces errorCode from infrastructure runner failures", () => {
  const report = buildReleaseEvidenceExport([
    terminal("task-docker-timeout", "failed", {
      repo: "jinwon-int/a2a-broker",
      issue: "#830",
      blockCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/830#issuecomment-4497695887",
    }),
    terminal("task-docker-evidence-missing", "failed", {}),
    terminal("task-docker-no-diff", "failed", {
      repo: "jinwon-int/a2a-broker",
      prUrl: "https://github.com/jinwon-int/a2a-broker/pull/502",
    }),
  ].map((t) => ({
    ...t,
    error: { code: t.id === "task-docker-timeout" ? "docker_runner_timeout" : t.id === "task-docker-evidence-missing" ? "docker_runner_evidence_missing" : "docker_runner_no_diff", message: "infrastructure runner failure" },
  })), { runId: "test-run" });

  assert.equal(report.items.length, 3);

  const item1 = report.items.find((i) => i.taskId === "task-docker-timeout");
  assert.ok(item1);
  assert.equal(item1.errorCode, "docker_runner_timeout");
  assert.equal(item1.evidenceKind, "block");

  const item2 = report.items.find((i) => i.taskId === "task-docker-evidence-missing");
  assert.ok(item2);
  assert.equal(item2.errorCode, "docker_runner_evidence_missing");
  assert.equal(item2.evidenceKind, "missing");

  const item3 = report.items.find((i) => i.taskId === "task-docker-no-diff");
  assert.ok(item3);
  assert.equal(item3.errorCode, "docker_runner_no_diff");
  assert.equal(item3.evidenceKind, "pr");

  const markdown = renderReleaseEvidenceMarkdown(report);
  assert.match(markdown, /\(docker_runner_timeout\)/);
  assert.match(markdown, /\(docker_runner_evidence_missing\)/);
  assert.match(markdown, /\(docker_runner_no_diff\)/);

  // Ensure the errorCode values do not contain path-like or secret patterns
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /\/work\/|private_key|ghp_|gho_/i);
});

test("release evidence export redacts unsafe error codes", () => {
  const report = buildReleaseEvidenceExport([
    terminal("task-leaky", "failed", {}),
  ].map((t) => ({
    ...t,
    error: { code: "/work/repo/token-leak", message: "leak" },
  })));

  const item = report.items[0];
  assert.equal(item.errorCode, undefined, "should not surface path-like error codes");
});

test("release evidence export includes terminal outbox health when diagnostics are provided", () => {
  const healthyDiag = {
    total: 10,
    acked: 10,
    unacked: 0,
    unackedRatio: 0,
    oldestUnackedAgeMs: null,
    oldestUnackedCreatedAt: null,
    ackEligibleUnacked: 0,
    warnings: [],
  };

  const report = buildReleaseEvidenceExport([
    terminal("task-done", "succeeded", { doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413329" }),
  ], {
    runId: "test-run",
    terminalOutboxDiagnostics: healthyDiag,
  });

  assert.ok(report.terminalOutbox, "terminalOutbox should be present");
  assert.equal(report.terminalOutbox.health, "none");
  assert.equal(report.terminalOutbox.stabilityGatePass, true);
  assert.equal(report.terminalOutbox.signals.length, 0);
  assert.equal(report.terminalOutbox.snapshot.total, 10);
  assert.equal(report.terminalOutbox.snapshot.acked, 10);
  assert.equal(report.terminalOutbox.snapshot.unacked, 0);
  assert.equal(report.terminalOutbox.snapshot.unackedRatio, 0);
  assert.equal(report.terminalOutbox.snapshot.oldestUnackedAgeMs, null);

  const markdown = renderReleaseEvidenceMarkdown(report);
  assert.match(markdown, /Terminal outbox health/);
  assert.match(markdown, /Risk level: none/);
  assert.match(markdown, /Stability gate: pass/);
});

test("release evidence export flags terminal outbox backlog warning", () => {
  const backlogDiag = {
    total: 100,
    acked: 30,
    unacked: 70,
    unackedRatio: 0.7,
    oldestUnackedAgeMs: 8 * 24 * 60 * 60 * 1000, // 8 days
    oldestUnackedCreatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    ackEligibleUnacked: 70,
    warnings: ["high unacked ratio"],
  };

  const report = buildReleaseEvidenceExport([
    terminal("task-done", "succeeded", { doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413329" }),
  ], {
    runId: "test-run",
    terminalOutboxDiagnostics: backlogDiag,
  });

  assert.ok(report.terminalOutbox, "terminalOutbox should be present");
  assert.notEqual(report.terminalOutbox.health, "none");
  assert.ok(report.terminalOutbox.signals.length > 0, "should have backlog signals");
  assert.equal(report.terminalOutbox.stabilityGatePass, false);
  assert.equal(report.terminalOutbox.snapshot.total, 100);
  assert.equal(report.terminalOutbox.snapshot.unacked, 70);
  assert.equal(report.terminalOutbox.snapshot.unackedRatio, 0.7);
  assert.ok(report.terminalOutbox.snapshot.oldestUnackedAgeMs !== null);

  const markdown = renderReleaseEvidenceMarkdown(report);
  assert.match(markdown, /Terminal outbox health/);
  assert.match(markdown, /\[warning\]|\[critical\]/i);
  assert.match(markdown, /Stability gate: fail/);
});

test("release evidence export omits terminalOutbox when diagnostics are absent", () => {
  const report = buildReleaseEvidenceExport([
    terminal("task-done", "succeeded", { doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413329" }),
  ], { runId: "test-run" });

  assert.equal(report.terminalOutbox, undefined, "terminalOutbox should be absent when diagnostics are not provided");
});

test("release evidence export includes scanner evidence block when entries are provided", () => {
  const report = buildReleaseEvidenceExport([
    terminal("task-done", "succeeded", { doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413329" }),
  ], {
    runId: "test-run",
    scannerEntries: [
      { kind: "secret_scan", description: "Check for exposed secrets in fixtures and docs", verdict: "pass", sourceRef: "scripts/public-readiness-scan.mjs" },
      { kind: "history_check", description: "Verify no forced pushes or history rewrites in ref log", verdict: "pass" },
      { kind: "path_safety", description: "Confirm no OpenClaw runtime/bootstrap paths in repo", verdict: "pass", sourceRef: "fixtures/path-safety.json" },
    ],
  });

  assert.ok(report.scannerEvidence, "scannerEvidence should be present");
  assert.equal(report.scannerEvidence.gate, "pass");
  assert.equal(report.scannerEvidence.entries.length, 3);
  assert.equal(report.scannerEvidence.entries[0].kind, "secret_scan");
  assert.equal(report.scannerEvidence.entries[0].verdict, "pass");

  const markdown = renderReleaseEvidenceMarkdown(report);
  assert.match(markdown, /Scanner evidence/);
  assert.match(markdown, /secret_scan/);
  assert.match(markdown, /history_check/);
  assert.match(markdown, /✅/);
  assert.match(markdown, /Scan gate: pass/);
});

test("release evidence export scanner evidence gate is fail when any entry fails", () => {
  const report = buildReleaseEvidenceExport([
    terminal("task-done", "succeeded", { doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413329" }),
  ], {
    runId: "test-run",
    scannerEntries: [
      { kind: "secret_scan", description: "Check secrets", verdict: "pass" },
      { kind: "history_check", description: "Check history", verdict: "fail", detail: "Found unexpected force-push in ref log" },
    ],
  });

  assert.ok(report.scannerEvidence);
  assert.equal(report.scannerEvidence.gate, "fail");
  assert.equal(report.scannerEvidence.entries.length, 2);

  const markdown = renderReleaseEvidenceMarkdown(report);
  assert.match(markdown, /❌/);
  assert.match(markdown, /BLOCKED/);
  assert.match(markdown, /Found unexpected force-push/);
});

test("release evidence export omits scannerEvidence when entries are absent", () => {
  const report = buildReleaseEvidenceExport([
    terminal("task-done", "succeeded", { doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413329" }),
  ], { runId: "test-run" });

  assert.equal(report.scannerEvidence, undefined, "scannerEvidence should be absent when entries are not provided");
});

test("release evidence export scanner evidence avoids secret-like values in kind/description", () => {
  const report = buildReleaseEvidenceExport([
    terminal("task-done", "succeeded", { doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413329" }),
  ], {
    runId: "test-run",
    scannerEntries: [
      { kind: "secret_scan", description: "safe description", verdict: "pass" },
    ],
  });

  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /AGENTS\.md|SOUL\.md|TOOLS\.md|\.openclaw|ghp_/i);
});

test("release evidence export accepts optional backlog thresholds", () => {
  const backlogDiag = {
    total: 50,
    acked: 40,
    unacked: 10,
    unackedRatio: 0.2,
    oldestUnackedAgeMs: null,
    oldestUnackedCreatedAt: null,
    ackEligibleUnacked: 10,
    warnings: [],
  };

  // Low unacked count (10) normally passes. With a stricter warning threshold of 5,
  // it should generate a signal.
  const report = buildReleaseEvidenceExport([
    terminal("task-done", "succeeded", { doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413329" }),
  ], {
    runId: "test-run",
    terminalOutboxDiagnostics: backlogDiag,
    terminalOutboxBacklogThresholds: { maxUnackedCountWarning: 5 },
  });

  assert.ok(report.terminalOutbox);
  assert.equal(report.terminalOutbox.snapshot.unacked, 10);
  const hasUnackedSignal = report.terminalOutbox.signals.some((s) => s.kind === "unacked_accumulation");
  assert.ok(hasUnackedSignal, "should flag unacked_accumulation with custom threshold");
});
