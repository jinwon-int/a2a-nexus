/**
 * round-result-collector.test.ts — result collector projection tests (issue #929)
 */

import { describe, it } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import {
  collectRoundResults,
  buildRoundManifest,
  renderCompactEvidenceSummary,
  buildRoundCompletePayload,
  type RoundManifest,
  type RoundManifestLane,
  type RoundLaneState,
  type ResultLane,
  type RoundResultCollectorOutput,
} from "./round-result-collector.js";
import type { TaskRecord, TaskStatus, TaskResult } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<TaskRecord> & { id: string }): TaskRecord {
  const defaults: TaskRecord = {
    id: "task-1",
    intent: "propose_patch",
    status: "queued",
    targetNodeId: "default",
    assignedWorkerId: "workerbeta",
    requester: { id: "broker", kind: "service" },
    target: { id: "default", kind: "node" },
    payload: {},
    createdAt: "2026-05-26T10:00:00.000Z",
    updatedAt: "2026-05-26T10:00:00.000Z",
  };
  return { ...defaults, ...overrides };
}

function makeResult(overrides: Partial<TaskResult> & { output?: Record<string, unknown> }): TaskResult {
  return {
    summary: "Task completed successfully",
    ...overrides,
  };
}

const DEFAULT_MANIFEST: RoundManifest = {
  roundLabel: "test-round",
  lanes: [
    { workerId: "workerbeta" },
    { workerId: "workergamma", description: "Round manifest" },
    { workerId: "workeralpha", description: "A2A definitions" },
    { workerId: "workerdelta", description: "Validation" },
  ],
  staleAfterMs: 30 * 60 * 1000,
  timeoutAt: "2026-05-26T23:00:00.000Z",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("collectRoundResults", () => {
  it("classifies all lanes as pending when no tasks exist", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const output = collectRoundResults(DEFAULT_MANIFEST, [], { nowMs });

    equal(output.summary.totalLanes, 4);
    equal(output.summary.pending, 4);
    equal(output.summary.completed, 0);
    equal(output.missingLanes.length, 4);
    equal(output.missingLanes.includes("workerbeta"), true);
    equal(output.missingLanes.includes("workergamma"), true);
    equal(output.missingLanes.includes("workeralpha"), true);
    equal(output.missingLanes.includes("workerdelta"), true);

    for (const lane of output.lanes) {
      equal(lane.laneState, "pending");
      equal(lane.taskIds.length, 0);
    }
  });

  it("classifies a lane as running when task is active", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerbeta-1",
        assignedWorkerId: "workerbeta",
        status: "running",
        updatedAt: "2026-05-26T11:55:00.000Z", // 5 min ago < 30 min stale threshold
      }),
    ];
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });

    const workerbetaLane = output.lanes.find((l) => l.workerId === "workerbeta")!;
    ok(workerbetaLane);
    equal(workerbetaLane.laneState, "running");
    equal(workerbetaLane.latestStatus, "running");
    equal(workerbetaLane.taskIds.length, 1);
    equal(workerbetaLane.taskIds[0], "task-workerbeta-1");
  });

  it("classifies a lane as succeeded with pr evidence", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerbeta-1",
        assignedWorkerId: "workerbeta",
        status: "succeeded",
        updatedAt: "2026-05-26T11:30:00.000Z",
        completedAt: "2026-05-26T11:30:00.000Z",
        result: makeResult({
          output: { prUrl: "https://github.com/example/repo/pull/42" },
        }),
      }),
    ];
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });

    const lane = output.lanes.find((l) => l.workerId === "workerbeta")!;
    equal(lane.laneState, "succeeded");
    equal(lane.outcomeClass, "pr_success");
    equal(lane.prUrl, "https://github.com/example/repo/pull/42");
    equal(lane.evidenceUrls.length, 1);
    ok(lane.completedAt);
  });

  it("classifies a lane as succeeded with done evidence", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerbeta-1",
        assignedWorkerId: "workerbeta",
        status: "succeeded",
        updatedAt: "2026-05-26T11:30:00.000Z",
        completedAt: "2026-05-26T11:30:00.000Z",
        result: makeResult({
          output: { doneCommentUrl: "https://github.com/example/repo/issues/1#issuecomment-123" },
        }),
      }),
    ];
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });

    const lane = output.lanes.find((l) => l.workerId === "workerbeta")!;
    equal(lane.laneState, "succeeded");
    equal(lane.outcomeClass, "no_change_done");
    equal(lane.doneUrl, "https://github.com/example/repo/issues/1#issuecomment-123");
  });

  it("classifies a lane as succeeded without evidence (no output)", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerbeta-1",
        assignedWorkerId: "workerbeta",
        status: "succeeded",
        updatedAt: "2026-05-26T11:30:00.000Z",
        result: makeResult({}),
      }),
    ];
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });

    const lane = output.lanes.find((l) => l.workerId === "workerbeta")!;
    equal(lane.laneState, "succeeded");
    equal(lane.outcomeClass, undefined); // can't classify without evidence
    equal(lane.evidenceUrls.length, 0);
  });

  it("classifies a lane as failed", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerbeta-1",
        assignedWorkerId: "workerbeta",
        status: "failed",
        updatedAt: "2026-05-26T11:30:00.000Z",
        completedAt: "2026-05-26T11:30:00.000Z",
        result: makeResult({
          output: { blockCommentUrl: "https://github.com/example/repo/issues/1#issuecomment-456" },
        }),
      }),
    ];
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });

    const lane = output.lanes.find((l) => l.workerId === "workerbeta")!;
    equal(lane.laneState, "failed");
    equal(lane.outcomeClass, "no_change_block");
    equal(lane.blockUrl, "https://github.com/example/repo/issues/1#issuecomment-456");
  });

  it("classifies a lane as blocked", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerbeta-1",
        assignedWorkerId: "workerbeta",
        status: "blocked",
        updatedAt: "2026-05-26T11:30:00.000Z",
        result: makeResult({
          output: { blockUrl: "https://github.com/example/repo/issues/1#issuecomment-789" },
        }),
      }),
    ];
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });

    const lane = output.lanes.find((l) => l.workerId === "workerbeta")!;
    equal(lane.laneState, "blocked");
    equal(lane.outcomeClass, "no_change_block");
    equal(lane.blockUrl, "https://github.com/example/repo/issues/1#issuecomment-789");
  });

  it("classifies a lane as stale when non-terminal past threshold", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z"); // noon
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerbeta-1",
        assignedWorkerId: "workerbeta",
        status: "running",
        // updated 35 min ago > 30 min stale threshold
        updatedAt: "2026-05-26T11:25:00.000Z",
      }),
    ];
    // Using default staleAfterMs = 30 min
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });

    const lane = output.lanes.find((l) => l.workerId === "workerbeta")!;
    equal(lane.laneState, "stale");
    ok(lane.ageMs! >= 30 * 60 * 1000);
    equal(output.staleLanes.includes("workerbeta"), true);
  });

  it("classifies a lane as running when non-terminal and fresh", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerbeta-1",
        assignedWorkerId: "workerbeta",
        status: "running",
        // updated 5 min ago < 30 min stale threshold
        updatedAt: "2026-05-26T11:55:00.000Z",
      }),
    ];
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });

    const lane = output.lanes.find((l) => l.workerId === "workerbeta")!;
    equal(lane.laneState, "running");
    equal(output.staleLanes.includes("workerbeta"), false);
  });

  it("classifies a lane as timeout when past deadline", () => {
    const nowMs = Date.parse("2026-05-27T01:00:00.000Z"); // next day, past timeoutAt
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerbeta-1",
        assignedWorkerId: "workerbeta",
        status: "running",
        updatedAt: "2026-05-26T23:30:00.000Z",
      }),
    ];
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });

    const lane = output.lanes.find((l) => l.workerId === "workerbeta")!;
    equal(lane.laneState, "timeout");
    equal(output.timeoutLanes.includes("workerbeta"), true);
  });

  it("excludes workers listed in excludedWorkerIds", () => {
    const manifest: RoundManifest = {
      roundLabel: "test-round",
      lanes: [
        { workerId: "workerbeta" },
        { workerId: "excluded-worker" },
      ],
      excludedWorkerIds: ["excluded-worker"],
    };
    const output = collectRoundResults(manifest, [], { nowMs: Date.parse("2026-05-26T12:00:00.000Z") });

    equal(output.summary.totalLanes, 1); // only workerbeta
    equal(output.missingLanes.length, 1);
    equal(output.missingLanes[0], "workerbeta");
  });

  it("handles mixed lane states correctly", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerbeta-1",
        assignedWorkerId: "workerbeta",
        status: "succeeded",
        updatedAt: "2026-05-26T11:30:00.000Z",
        completedAt: "2026-05-26T11:30:00.000Z",
        result: makeResult({
          output: { prUrl: "https://github.com/example/repo/pull/42" },
        }),
      }),
      makeTask({
        id: "task-workergamma-1",
        assignedWorkerId: "workergamma",
        status: "failed",
        updatedAt: "2026-05-26T11:00:00.000Z",
        completedAt: "2026-05-26T11:00:00.000Z",
        result: makeResult({
          output: { blockCommentUrl: "https://github.com/example/repo/issues/1#comment-123" },
        }),
      }),
      makeTask({
        id: "task-workeralpha-1",
        assignedWorkerId: "workeralpha",
        status: "running",
        updatedAt: "2026-05-26T11:55:00.000Z",
      }),
    ];
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });

    equal(output.summary.completed, 1); // workerbeta succeeded
    equal(output.summary.blocked, 1); // workergamma failed → counts as blocked
    equal(output.summary.running, 1); // workeralpha running and fresh
    equal(output.summary.pending, 1); // workerdelta has no tasks

    const workerbeta = output.lanes.find((l) => l.workerId === "workerbeta")!;
    equal(workerbeta.laneState, "succeeded");
    equal(workerbeta.prUrl, "https://github.com/example/repo/pull/42");

    const workergamma = output.lanes.find((l) => l.workerId === "workergamma")!;
    equal(workergamma.laneState, "failed");

    const workeralpha = output.lanes.find((l) => l.workerId === "workeralpha")!;
    equal(workeralpha.laneState, "running");

    const workerdelta = output.lanes.find((l) => l.workerId === "workerdelta")!;
    equal(workerdelta.laneState, "pending");
  });

  it("extracts evidence from multiple task output fields", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerbeta-1",
        assignedWorkerId: "workerbeta",
        status: "succeeded",
        updatedAt: "2026-05-26T11:30:00.000Z",
        result: makeResult({
          output: {
            prUrl: "https://github.com/example/repo/pull/42",
            doneCommentUrl: "https://github.com/example/repo/issues/1#comment-456",
            testSummary: "All 10 tests passed",
            summary: "PR created with fix",
          },
        }),
      }),
    ];
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });

    const lane = output.lanes.find((l) => l.workerId === "workerbeta")!;
    equal(lane.evidenceUrls.length, 2);
    ok(lane.evidenceUrls.some((url) => url.includes("pull/42")));
    ok(lane.evidenceUrls.some((url) => url.includes("comment-456")));
    equal(lane.testSummary, "All 10 tests passed");
    equal(lane.outcomeSummary, "PR created with fix");
  });

  it("preserves multi-task lanes (picks latest)", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerbeta-1",
        assignedWorkerId: "workerbeta",
        status: "queued",
        createdAt: "2026-05-26T10:00:00.000Z",
        updatedAt: "2026-05-26T10:00:00.000Z",
      }),
      makeTask({
        id: "task-workerbeta-2",
        assignedWorkerId: "workerbeta",
        status: "succeeded",
        createdAt: "2026-05-26T10:30:00.000Z",
        updatedAt: "2026-05-26T11:30:00.000Z",
        completedAt: "2026-05-26T11:30:00.000Z",
        result: makeResult({
          output: { prUrl: "https://github.com/example/repo/pull/43" },
        }),
      }),
    ];
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });

    const lane = output.lanes.find((l) => l.workerId === "workerbeta")!;
    // Lane should use the latest task's status (succeeded) and evidence
    equal(lane.laneState, "succeeded");
    equal(lane.prUrl, "https://github.com/example/repo/pull/43");
    equal(lane.taskIds.length, 2);
    // Latest task should be sorted by createdAt desc
    equal(lane.taskIds[0], "task-workerbeta-2");
  });

  it("skips lanes for workers not in manifest", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-unknown-1",
        assignedWorkerId: "extra-worker",
        status: "succeeded",
        updatedAt: "2026-05-26T11:30:00.000Z",
        result: makeResult({
          output: { prUrl: "https://github.com/example/repo/pull/99" },
        }),
      }),
    ];
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });

    // Unknown worker's task should not appear in output lanes
    equal(output.lanes.find((l) => l.workerId === "extra-worker"), undefined);
  });

  it("rejects non-https evidence URLs", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerbeta-1",
        assignedWorkerId: "workerbeta",
        status: "succeeded",
        updatedAt: "2026-05-26T11:30:00.000Z",
        result: makeResult({
          output: {
            prUrl: "http://insecure.example.com/pull/1",
            doneUrl: "ftp://files.example.com/report",
          },
        }),
      }),
    ];
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });

    const lane = output.lanes.find((l) => l.workerId === "workerbeta")!;
    equal(lane.evidenceUrls.length, 0); // Both URLs are not https
    equal(lane.prUrl, undefined);
    equal(lane.doneUrl, undefined);
  });

  it("returns canceled tasks as failed", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerbeta-1",
        assignedWorkerId: "workerbeta",
        status: "canceled",
        updatedAt: "2026-05-26T11:30:00.000Z",
        completedAt: "2026-05-26T11:30:00.000Z",
      }),
    ];
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });

    const lane = output.lanes.find((l) => l.workerId === "workerbeta")!;
    equal(lane.laneState, "failed");
    equal(lane.outcomeClass, "infra_failure");
  });

  it("extracts error summary from task.error", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerbeta-1",
        assignedWorkerId: "workerbeta",
        status: "failed",
        updatedAt: "2026-05-26T11:30:00.000Z",
        completedAt: "2026-05-26T11:30:00.000Z",
        error: { message: "Timeout after 300s", code: "timeout" },
      }),
    ];
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });

    const lane = output.lanes.find((l) => l.workerId === "workerbeta")!;
    equal(lane.errorSummary, "Timeout after 300s");
  });

  it("does not count wrapper-only review success as substantive A2AD evidence", () => {
    const nowMs = Date.parse("2026-06-13T01:30:00.000Z");
    const message = "Review PR #653 and return JSON-like evidence";
    const manifest: RoundManifest = {
      roundLabel: "a2a-pr-review-test",
      lanes: [{ workerId: "workeralpha", expectedOutcome: "review" }],
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workeralpha-wrapper-only",
        intent: "analyze",
        assignedWorkerId: "workeralpha",
        targetNodeId: "workeralpha",
        message,
        status: "succeeded",
        updatedAt: "2026-06-13T01:21:23.197Z",
        completedAt: "2026-06-13T01:21:23.197Z",
        result: makeResult({
          summary: message,
          note: "echo handled task task-workeralpha-wrapper-only",
          output: { taskId: "task-workeralpha-wrapper-only", intent: "analyze", message },
        }),
      }),
    ];

    const output = collectRoundResults(manifest, tasks, { nowMs });
    const lane = output.lanes[0]!;
    equal(lane.laneState, "blocked");
    equal(lane.evidenceClass, "wrapper_only");
    equal(output.summary.completed, 0);
    equal(output.summary.wrapperOnly, 1);
    ok(output.closeoutBundle.body.includes("wrapper-only"));
    ok(output.closeoutBundle.body.includes("not substantive"));
  });

  it("does not count generic analyze handler success as substantive A2AD evidence (#884)", () => {
    const nowMs = Date.parse("2026-06-18T05:20:00.000Z");
    const manifest: RoundManifest = {
      roundLabel: "a2ad-open-issue-test",
      lanes: [{ workerId: "workerbeta", expectedOutcome: "review" }],
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerbeta-generic-analyze",
        intent: "analyze",
        assignedWorkerId: "workerbeta",
        targetNodeId: "workerbeta",
        status: "succeeded",
        updatedAt: "2026-06-18T05:18:00.000Z",
        completedAt: "2026-06-18T05:18:00.000Z",
        result: makeResult({
          summary: "generic analyze task accepted by versioned A2A task handler",
          output: {
            analysisKind: "builtin_structured",
            message: "generic analyze task accepted by versioned A2A task handler",
            payloadKeys: ["sourceBundle", "parentRoundId", "brokerOfRecordId"],
          },
        }),
      }),
    ];

    const output = collectRoundResults(manifest, tasks, { nowMs });
    const lane = output.lanes[0]!;
    equal(lane.laneState, "blocked");
    equal(lane.evidenceClass, "wrapper_only");
    equal(output.summary.completed, 0);
    equal(output.summary.substantiveEvidence, 0);
    equal(output.summary.wrapperOnly, 1);
    ok(output.closeoutBundle.body.includes("wrapper-only"));
  });

  it("classifies analysis bridge EACCES as handler artifact failure", () => {
    const nowMs = Date.parse("2026-06-13T01:30:00.000Z");
    const manifest: RoundManifest = {
      roundLabel: "a2a-pr-review-test",
      lanes: [{ workerId: "workerbeta", expectedOutcome: "review" }],
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerbeta-eacces",
        intent: "analyze",
        assignedWorkerId: "workerbeta",
        targetNodeId: "workerbeta",
        status: "failed",
        updatedAt: "2026-06-13T01:21:07.905Z",
        completedAt: "2026-06-13T01:21:07.905Z",
        error: {
          code: "handler_exit_nonzero",
          message: "handler exited with code 1",
          details: {
            stdout: JSON.stringify({
              error: {
                code: "openclaw_analysis_spawn_failed",
                message: "spawnSync /opt/a2a-broker-worker/scripts/hermes-a2a-analysis-bridge.mjs EACCES",
              },
            }),
          },
        },
      }),
    ];

    const output = collectRoundResults(manifest, tasks, { nowMs });
    const lane = output.lanes[0]!;
    equal(lane.laneState, "failed");
    equal(lane.evidenceClass, "handler_artifact_failure");
    equal(output.summary.handlerArtifactFailures, 1);
    ok(lane.errorSummary?.includes("openclaw_analysis_spawn_failed"));
    ok(lane.errorSummary?.includes("EACCES"));
  });

  it("tracks queued target lanes as queued_unclaimed instead of missing", () => {
    const nowMs = Date.parse("2026-06-13T01:30:00.000Z");
    const manifest: RoundManifest = {
      roundLabel: "a2a-pr-review-test",
      lanes: [{ workerId: "mobilebeta", expectedOutcome: "review" }],
      staleAfterMs: 30 * 60 * 1000,
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-mobilebeta-queued",
        intent: "analyze",
        assignedWorkerId: undefined,
        claimedBy: undefined,
        targetNodeId: "mobilebeta",
        target: { id: "mobilebeta", kind: "node", role: "analyst" },
        status: "queued",
        updatedAt: "2026-06-13T01:22:34.449Z",
      }),
    ];

    const output = collectRoundResults(manifest, tasks, { nowMs });
    const lane = output.lanes[0]!;
    equal(lane.laneState, "running");
    equal(lane.evidenceClass, "queued_unclaimed");
    equal(output.missingLanes.length, 0);
    equal(output.summary.queuedUnclaimed, 1);
    ok(output.closeoutBundle.body.includes("queued/unclaimed"));
  });

  it("counts explicit review analysisStatus done as substantive evidence", () => {
    const nowMs = Date.parse("2026-06-13T01:30:00.000Z");
    const manifest: RoundManifest = {
      roundLabel: "a2a-pr-review-test",
      lanes: [{ workerId: "workerbeta", expectedOutcome: "review" }],
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerbeta-review-done",
        intent: "analyze",
        assignedWorkerId: "workerbeta",
        targetNodeId: "workerbeta",
        status: "succeeded",
        updatedAt: "2026-06-13T01:21:07.905Z",
        completedAt: "2026-06-13T01:21:07.905Z",
        result: makeResult({
          output: {
            analysisStatus: "done",
            verdict: "approve",
            blockerFindings: [],
            nonBlockingFindings: [],
            commandsOrEvidenceUsed: ["gh pr diff 652"],
          },
        }),
      }),
    ];

    const output = collectRoundResults(manifest, tasks, { nowMs });
    const lane = output.lanes[0]!;
    equal(lane.laneState, "succeeded");
    equal(lane.evidenceClass, "substantive");
    equal(output.summary.completed, 1);
    equal(output.summary.substantiveEvidence, 1);
    ok(output.closeoutBundle.body.includes("Ready for finalizer closeout"));
  });

  it("projects parent-round metadata and worker attribution for finalizer evidence lanes", () => {
    const nowMs = Date.parse("2026-06-15T15:40:00.000Z");
    const manifest: RoundManifest = {
      roundLabel: "a2a-nexus-open-issues-continue-20260615T153154Z",
      lanes: [{ workerId: "workerbeta", expectedOutcome: "analysis" }],
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "a2a-nexus-open-issues-continue-20260615T153154Z-workerbeta",
        intent: "analyze",
        assignedWorkerId: "workerbeta",
        targetNodeId: "workerbeta",
        status: "succeeded",
        updatedAt: "2026-06-15T15:35:00.000Z",
        completedAt: "2026-06-15T15:35:00.000Z",
        payload: {
          parentRoundId: "a2a-nexus-open-issues-continue-20260615T153154Z",
          parentRoundOrder: 1,
          parentRoundTotal: 6,
          originBrokerId: "brokeralpha",
          brokerOfRecordId: "brokeralpha",
        },
        result: makeResult({
          output: {
            analysisStatus: "done",
            findings: ["#555 PR1 is the smallest safe slice"],
          },
        }),
      }),
    ];

    const output = collectRoundResults(manifest, tasks, { nowMs });
    const lane = output.lanes[0]!;
    equal(lane.parentRoundId, "a2a-nexus-open-issues-continue-20260615T153154Z");
    equal(lane.parentRoundOrder, 1);
    equal(lane.parentRoundTotal, 6);
    equal(lane.originBrokerId, "brokeralpha");
    equal(lane.brokerOfRecordId, "brokeralpha");
    equal(lane.assignedWorkerId, "workerbeta");
    ok(output.closeoutBundle.body.includes("parent=a2a-nexus-open-issues-continue-20260615T153154Z"));
    ok(output.closeoutBundle.body.includes("order=1/6"));
  });

  it("classifies provider/model analysis failures as handler artifact failures, not substantive evidence", () => {
    const nowMs = Date.parse("2026-06-15T15:40:00.000Z");
    const manifest: RoundManifest = {
      roundLabel: "a2a-provider-mismatch-test",
      lanes: [{ workerId: "workerepsilon", expectedOutcome: "analysis" }],
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerepsilon-model-mismatch",
        intent: "analyze",
        assignedWorkerId: "workerepsilon",
        targetNodeId: "workerepsilon",
        status: "failed",
        updatedAt: "2026-06-15T15:34:23.000Z",
        completedAt: "2026-06-15T15:34:23.000Z",
        error: {
          code: "handler_exit_nonzero",
          message: "handler exited with code 1",
          details: {
            stdout: JSON.stringify({
              error: {
                code: "openclaw_analysis_failed",
                message: "Hermes exited with 1: Error code: 404 - The model minimax-m3 does not exist or your team does not have access to it",
              },
            }),
          },
        },
      }),
    ];

    const output = collectRoundResults(manifest, tasks, { nowMs });
    const lane = output.lanes[0]!;
    equal(lane.laneState, "failed");
    equal(lane.evidenceClass, "handler_artifact_failure");
    equal(output.summary.handlerArtifactFailures, 1);
    equal(output.summary.substantiveEvidence, 0);
    ok(lane.errorSummary?.includes("openclaw_analysis_failed"));
  });

  it("projects issue #767 readiness statuses using finalizer-facing terms", () => {
    const nowMs = Date.parse("2026-06-15T16:10:00.000Z");
    const manifest: RoundManifest = {
      roundLabel: "a2a-readiness-projection-test",
      lanes: [
        { workerId: "missing-worker", expectedOutcome: "analysis" },
        { workerId: "mobile-worker", expectedOutcome: "analysis" },
        { workerId: "claimed-worker", expectedOutcome: "analysis" },
        { workerId: "wrapper-worker", expectedOutcome: "analysis" },
        { workerId: "source-worker", expectedOutcome: "analysis" },
        { workerId: "failed-worker", expectedOutcome: "analysis" },
        { workerId: "substantive-worker", expectedOutcome: "analysis" },
      ],
      staleAfterMs: 30 * 60 * 1000,
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-mobile-queued",
        assignedWorkerId: undefined,
        claimedBy: undefined,
        targetNodeId: "mobile-worker",
        target: { id: "mobile-worker", kind: "node", role: "analyst" },
        status: "queued",
        updatedAt: "2026-06-15T16:09:00.000Z",
      }),
      makeTask({
        id: "task-claimed-running",
        assignedWorkerId: "claimed-worker",
        claimedBy: "claimed-worker",
        targetNodeId: "claimed-worker",
        status: "running",
        updatedAt: "2026-06-15T16:09:00.000Z",
      }),
      makeTask({
        id: "task-wrapper-only",
        intent: "analyze",
        assignedWorkerId: "wrapper-worker",
        targetNodeId: "wrapper-worker",
        message: "Analyze the issue and return findings",
        status: "succeeded",
        updatedAt: "2026-06-15T16:05:00.000Z",
        completedAt: "2026-06-15T16:05:00.000Z",
        result: makeResult({
          summary: "Analyze the issue and return findings",
          note: "echo handled task task-wrapper-only",
          output: { message: "Analyze the issue and return findings" },
        }),
      }),
      makeTask({
        id: "task-source-blocked",
        intent: "analyze",
        assignedWorkerId: "source-worker",
        targetNodeId: "source-worker",
        status: "failed",
        updatedAt: "2026-06-15T16:05:00.000Z",
        completedAt: "2026-06-15T16:05:00.000Z",
        error: {
          code: "handler_exit_nonzero",
          message: "handler exited with code 1",
          details: {
            stdout: JSON.stringify({
              error: {
                code: "openclaw_analysis_failed",
                message: "analysis bridge blocked: source bundle contained 0 files",
              },
            }),
          },
        },
      }),
      makeTask({
        id: "task-handler-failed",
        intent: "analyze",
        assignedWorkerId: "failed-worker",
        targetNodeId: "failed-worker",
        status: "failed",
        updatedAt: "2026-06-15T16:05:00.000Z",
        completedAt: "2026-06-15T16:05:00.000Z",
        error: {
          code: "handler_exit_nonzero",
          message: "handler exited with code 1",
          details: {
            stdout: JSON.stringify({
              error: {
                code: "openclaw_analysis_failed",
                message: "Hermes exited with 1: Error code: 400 - The 'minimax-m3' model is not supported",
              },
            }),
          },
        },
      }),
      makeTask({
        id: "task-substantive",
        intent: "analyze",
        assignedWorkerId: "substantive-worker",
        targetNodeId: "substantive-worker",
        status: "succeeded",
        updatedAt: "2026-06-15T16:05:00.000Z",
        completedAt: "2026-06-15T16:05:00.000Z",
        result: makeResult({
          output: {
            analysisStatus: "done",
            findings: ["#767 readiness projection should use finalizer-facing terms"],
          },
        }),
      }),
    ];

    const output = collectRoundResults(manifest, tasks, { nowMs });
    const byWorker = new Map(output.lanes.map((lane) => [lane.workerId, lane]));
    equal(byWorker.get("missing-worker")?.readinessStatus, "missing");
    equal(byWorker.get("mobile-worker")?.readinessStatus, "queued");
    equal(byWorker.get("claimed-worker")?.readinessStatus, "claimed_running");
    equal(byWorker.get("wrapper-worker")?.readinessStatus, "wrapper_only");
    equal(byWorker.get("source-worker")?.readinessStatus, "source_blocked");
    equal(byWorker.get("failed-worker")?.readinessStatus, "handler_artifact_failed");
    equal(byWorker.get("substantive-worker")?.readinessStatus, "substantive");
    equal(output.summary.readiness.missing, 1);
    equal(output.summary.readiness.queued, 1);
    equal(output.summary.readiness.claimedRunning, 1);
    equal(output.summary.readiness.wrapperOnly, 1);
    equal(output.summary.readiness.sourceBlocked, 1);
    equal(output.summary.readiness.handlerArtifactFailed, 1);
    equal(output.summary.readiness.substantive, 1);
    ok(output.closeoutBundle.body.includes("readiness: missing=1 queued=1 claimed/running=1 wrapper-only=1 source-blocked=1 handler-artifact-failed=1 substantive=1"));
  });

  it("flags missing parent-round metadata in readiness projection", () => {
    const nowMs = Date.parse("2026-06-15T16:10:00.000Z");
    const manifest: RoundManifest = {
      roundLabel: "a2a-round-metadata-test",
      lanes: [{ workerId: "workerbeta", expectedOutcome: "analysis" }],
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerbeta-no-parent-round",
        intent: "analyze",
        assignedWorkerId: "workerbeta",
        targetNodeId: "workerbeta",
        status: "succeeded",
        updatedAt: "2026-06-15T16:05:00.000Z",
        completedAt: "2026-06-15T16:05:00.000Z",
        result: makeResult({ output: { analysisStatus: "done", findings: ["substantive"] } }),
      }),
    ];

    const output = collectRoundResults(manifest, tasks, { nowMs });
    const lane = output.lanes[0]!;
    equal(lane.readinessStatus, "substantive");
    equal(lane.roundMetadataComplete, false);
    equal(output.summary.roundMetadataComplete, 0);
    equal(output.summary.roundMetadataMissing, 1);
    ok(output.closeoutBundle.body.includes("round metadata missing: 1"));
  });

  it("does not let analysisStatus done override source-blocked evidence text", () => {
    const nowMs = Date.parse("2026-06-15T16:10:00.000Z");
    const manifest: RoundManifest = {
      roundLabel: "a2a-source-blocked-success-test",
      lanes: [{ workerId: "workergamma", expectedOutcome: "analysis" }],
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workergamma-empty-source",
        intent: "analyze",
        assignedWorkerId: "workergamma",
        targetNodeId: "workergamma",
        status: "succeeded",
        updatedAt: "2026-06-15T16:05:00.000Z",
        completedAt: "2026-06-15T16:05:00.000Z",
        result: makeResult({
          summary: "analysis bridge done: source bundle had <no source files available>",
          output: {
            analysisStatus: "done",
            analysisSummary: "Source bundle contained 0 files, so no source files were available for real analysis.",
            findings: ["Actual source was unavailable; only open issue metadata could be inspected."],
            recommendations: ["Run a supplemental sourceBundle.files[] retry before finalizer counts this lane."],
          },
        }),
      }),
    ];

    const output = collectRoundResults(manifest, tasks, { nowMs });
    const lane = output.lanes[0]!;
    equal(lane.laneState, "blocked");
    equal(lane.evidenceClass, "source_blocked");
    equal(lane.readinessStatus, "source_blocked");
    equal(output.summary.sourceBlocked, 1);
    equal(output.summary.substantiveEvidence, 0);
  });
});

// ---------------------------------------------------------------------------
// buildRoundManifest
// ---------------------------------------------------------------------------

describe("buildRoundManifest", () => {
  it("builds a manifest from worker IDs", () => {
    const manifest = buildRoundManifest("test-round", ["workerbeta", "workergamma"], {
      descriptions: { workerbeta: "Result collector", workergamma: "Round manifest" },
      expectedOutcomes: { workerbeta: "patch", workergamma: "analysis" },
      parentIssueUrl: "https://github.com/jinwon-int/a2a-broker/issues/927",
      staleAfterMs: 60000,
    });

    equal(manifest.roundLabel, "test-round");
    equal(manifest.lanes.length, 2);
    equal(manifest.lanes[0]!.workerId, "workerbeta");
    equal(manifest.lanes[0]!.description, "Result collector");
    equal(manifest.lanes[0]!.expectedOutcome, "patch");
    equal(manifest.lanes[1]!.workerId, "workergamma");
    equal(manifest.lanes[1]!.description, "Round manifest");
    equal(manifest.lanes[1]!.expectedOutcome, "analysis");
    equal(manifest.parentIssueUrl, "https://github.com/jinwon-int/a2a-broker/issues/927");
    equal(manifest.staleAfterMs, 60000);
    equal(manifest.excludedWorkerIds, undefined);
  });

  it("handles empty worker list", () => {
    const manifest = buildRoundManifest("empty-round", []);
    equal(manifest.lanes.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Closeout bundle
// ---------------------------------------------------------------------------

describe("closeout bundle", () => {
  it("renders all-complete bundle with ✅ emoji", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerbeta-1",
        assignedWorkerId: "workerbeta",
        status: "succeeded",
        updatedAt: "2026-05-26T11:30:00.000Z",
        completedAt: "2026-05-26T11:30:00.000Z",
        result: makeResult({
          output: { prUrl: "https://github.com/example/repo/pull/42" },
        }),
      }),
    ];

    const manifest: RoundManifest = {
      roundLabel: "test-round",
      lanes: [{ workerId: "workerbeta" }],
    };
    const output = collectRoundResults(manifest, tasks, { nowMs });

    ok(output.closeoutBundle.title.includes("ready for review"));
    ok(output.closeoutBundle.body.includes("✅"));
    ok(output.closeoutBundle.body.includes("1/1 lanes completed"));
    ok(output.closeoutBundle.body.includes("Ready for finalizer closeout"));
  });

  it("renders blocked bundle with 🚫 emoji and action items", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerbeta-1",
        assignedWorkerId: "workerbeta",
        status: "blocked",
        updatedAt: "2026-05-26T11:30:00.000Z",
        result: makeResult({
          output: { blockUrl: "https://github.com/example/repo/issues/1" },
        }),
      }),
    ];

    const manifest: RoundManifest = {
      roundLabel: "test-round",
      lanes: [{ workerId: "workerbeta" }],
    };
    const output = collectRoundResults(manifest, tasks, { nowMs });

    ok(output.closeoutBundle.title.includes("needs review"));
    ok(output.closeoutBundle.body.includes("🚫"));
    ok(output.closeoutBundle.body.includes("Blocked lanes (1)"));
    ok(output.closeoutBundle.body.includes("Block evidence"));
  });

  it("renders deadline timeout in bundle", () => {
    const nowMs = Date.parse("2026-05-27T01:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerbeta-1",
        assignedWorkerId: "workerbeta",
        status: "running",
        updatedAt: "2026-05-26T22:00:00.000Z",
      }),
    ];

    const manifest: RoundManifest = {
      roundLabel: "test-round",
      lanes: [{ workerId: "workerbeta" }],
      timeoutAt: "2026-05-26T23:00:00.000Z",
    };
    const output = collectRoundResults(manifest, tasks, { nowMs });

    ok(output.closeoutBundle.body.includes("⏰"));
    ok(output.closeoutBundle.body.includes("Timeout lanes (1)"));
  });

  it("includes safety disclaimer in all bundles", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const output = collectRoundResults(DEFAULT_MANIFEST, [], { nowMs });

    ok(output.closeoutBundle.body.includes("draft-only closeout bundle"));
    ok(output.closeoutBundle.body.includes("No comments, closes, merges, deploys, live sends, ACKs, or DB mutations"));
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("handles empty manifest lanes", () => {
    const manifest: RoundManifest = {
      roundLabel: "empty-round",
      lanes: [],
    };
    const output = collectRoundResults(manifest, [], { nowMs: Date.parse("2026-05-26T12:00:00.000Z") });

    equal(output.summary.totalLanes, 0);
    equal(output.lanes.length, 0);
    equal(output.missingLanes.length, 0);
    equal(output.closeoutBundle.body.includes("0/0 lanes completed"), true);
  });

  it("handles tasks with null/undefined result", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerbeta-1",
        assignedWorkerId: "workerbeta",
        status: "succeeded",
        updatedAt: "2026-05-26T11:30:00.000Z",
        result: undefined as unknown as TaskResult,
      }),
    ];
    // Should not throw
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });
    const lane = output.lanes.find((l) => l.workerId === "workerbeta")!;
    equal(lane.laneState, "succeeded");
    equal(lane.evidenceUrls.length, 0);
  });

  it("handles staleAfterMs = 1 (immediate staleness)", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const manifest: RoundManifest = {
      roundLabel: "test-round",
      lanes: [{ workerId: "workerbeta" }],
      staleAfterMs: 1, // essentially immediate
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerbeta-1",
        assignedWorkerId: "workerbeta",
        status: "running",
        updatedAt: "2026-05-26T11:59:59.000Z", // 1s ago
      }),
    ];
    // staleAfterMs=1 so any age >= 1 ms = stale
    const output = collectRoundResults(manifest, tasks, { nowMs });
    equal(output.lanes[0]!.laneState, "stale");
  });

  it("handles no timeoutAt (no timeout detection)", () => {
    const nowMs = Date.parse("2026-05-27T01:00:00.000Z"); // day after
    const manifest: RoundManifest = {
      roundLabel: "test-round",
      lanes: [{ workerId: "workerbeta" }],
      // no timeoutAt set
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerbeta-1",
        assignedWorkerId: "workerbeta",
        status: "running",
        updatedAt: "2026-05-26T11:30:00.000Z",
      }),
    ];
    const output = collectRoundResults(manifest, tasks, { nowMs });
    // Since no timeoutAt, it should go by staleness first
    // 13.5h stale > 30min default → stale
    equal(output.lanes[0]!.laneState, "stale");
    equal(output.timeoutLanes.length, 0);
  });

  it("outputs valid projection kind and version", () => {
    const output = collectRoundResults(DEFAULT_MANIFEST, [], { nowMs: Date.parse("2026-05-26T12:00:00.000Z") });

    equal(output.kind, "a2a-broker.round-result-collector.projection");
    equal(output.version, 1);
    ok(output.generatedAt);
    ok(output.approvalSensitiveActionsExcluded.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Gate verdict (#629 phase 1)
// ---------------------------------------------------------------------------

describe("gateVerdict", () => {
  it("BLOCKED when all lanes are pending (no tasks)", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const output = collectRoundResults(DEFAULT_MANIFEST, [], { nowMs });
    const gv = output.gateVerdict!;
    equal(gv.verdict, "BLOCKED");
    equal(gv.succeeded, 0);
    equal(gv.failed, 0);
    equal(gv.pending, 4);
    equal(gv.missingLanes.length, 4);
    ok(gv.reason);
    ok(gv.reason!.includes("non-terminal"));
  });

  it("BLOCKED when some lanes are running (not all terminal)", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({ id: "t-workerbeta-1", assignedWorkerId: "workerbeta", status: "succeeded", updatedAt: "2026-05-26T11:30:00.000Z", result: makeResult({ output: { prUrl: "https://github.com/o/r/pull/1" } }) }),
      makeTask({ id: "t-workergamma-1", assignedWorkerId: "workergamma", status: "running", updatedAt: "2026-05-26T11:50:00.000Z" }),
    ];
    const manifest: RoundManifest = { roundLabel: "test", lanes: [{ workerId: "workerbeta" }, { workerId: "workergamma" }] };
    const output = collectRoundResults(manifest, tasks, { nowMs });
    equal(output.gateVerdict!.verdict, "BLOCKED");
    equal(output.gateVerdict!.pending, 1);
    ok(output.gateVerdict!.reason!.includes("non-terminal"));
  });

  it("BLOCKED when succeeded lane lacks evidence URLs", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({ id: "t-workerbeta-1", assignedWorkerId: "workerbeta", status: "succeeded", updatedAt: "2026-05-26T11:30:00.000Z", result: makeResult({}) }),
    ];
    const manifest: RoundManifest = { roundLabel: "test", lanes: [{ workerId: "workerbeta" }] };
    const output = collectRoundResults(manifest, tasks, { nowMs });
    equal(output.gateVerdict!.verdict, "BLOCKED");
    ok(output.gateVerdict!.reason!.includes("evidence URLs"));
  });

  it("FINAL when all lanes terminal with evidence", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({ id: "t-workerbeta-1", assignedWorkerId: "workerbeta", status: "succeeded", updatedAt: "2026-05-26T11:30:00.000Z", completedAt: "2026-05-26T11:30:00.000Z", result: makeResult({ output: { prUrl: "https://github.com/o/r/pull/1" } }) }),
      makeTask({ id: "t-workergamma-1", assignedWorkerId: "workergamma", status: "succeeded", updatedAt: "2026-05-26T11:00:00.000Z", completedAt: "2026-05-26T11:00:00.000Z", result: makeResult({ output: { doneCommentUrl: "https://github.com/o/r/issues/1#issuecomment-1" } }) }),
    ];
    const manifest: RoundManifest = { roundLabel: "test", lanes: [{ workerId: "workerbeta" }, { workerId: "workergamma" }] };
    const output = collectRoundResults(manifest, tasks, { nowMs });
    equal(output.gateVerdict!.verdict, "FINAL");
    equal(output.gateVerdict!.succeeded, 2);
    equal(output.gateVerdict!.pending, 0);
    equal(output.gateVerdict!.evidenceIdsCitedCount, 2);
    ok(output.gateVerdict!.evidenceIdsCited.includes("t-workerbeta-1"));
    ok(output.gateVerdict!.evidenceIdsCited.includes("t-workergamma-1"));
  });

  it("BLOCKED when a terminal lane failed even if another lane succeeded", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({ id: "t-workerbeta-1", assignedWorkerId: "workerbeta", status: "succeeded", updatedAt: "2026-05-26T11:30:00.000Z", result: makeResult({ output: { prUrl: "https://github.com/o/r/pull/1" } }) }),
      makeTask({ id: "t-workeralpha-1", assignedWorkerId: "workeralpha", status: "failed", updatedAt: "2026-05-26T11:00:00.000Z", completedAt: "2026-05-26T11:00:00.000Z", result: makeResult({ output: { blockCommentUrl: "https://github.com/o/r/issues/1#issuecomment-2" } }) }),
    ];
    const manifest: RoundManifest = { roundLabel: "test", lanes: [{ workerId: "workerbeta" }, { workerId: "workeralpha" }] };
    const output = collectRoundResults(manifest, tasks, { nowMs });
    equal(output.gateVerdict!.verdict, "BLOCKED");
    equal(output.gateVerdict!.succeeded, 1);
    equal(output.gateVerdict!.failed, 1);
    equal(output.gateVerdict!.missingLanes.length, 0);
    ok(output.gateVerdict!.reason!.includes("failed"));
  });

  it("BLOCKED when a lane times out", () => {
    const nowMs = Date.parse("2026-05-27T01:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({ id: "t-workerbeta-1", assignedWorkerId: "workerbeta", status: "running", updatedAt: "2026-05-26T11:30:00.000Z" }),
    ];
    const manifest: RoundManifest = { roundLabel: "test", lanes: [{ workerId: "workerbeta" }], timeoutAt: "2026-05-26T23:00:00.000Z" };
    const output = collectRoundResults(manifest, tasks, { nowMs });
    equal(output.gateVerdict!.verdict, "BLOCKED");
    equal(output.gateVerdict!.failed, 1);
    equal(output.gateVerdict!.succeeded, 0);
    ok(output.gateVerdict!.reason!.includes("timed out"));
  });

  it("reports correct expectedTotal from manifest lane count", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const output = collectRoundResults(DEFAULT_MANIFEST, [], { nowMs });
    equal(output.gateVerdict!.expectedTotal, 4);
  });

  // a2a-nexus#970: structured lane lists so reject-feedback requeue / closeout
  // barriers can target lanes without parsing the human-readable `reason`.
  it("exposes failedLanes (worker ids) for failed/blocked/timeout lanes", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({ id: "t-workerbeta-1", assignedWorkerId: "workerbeta", status: "succeeded", updatedAt: "2026-05-26T11:30:00.000Z", result: makeResult({ output: { prUrl: "https://github.com/o/r/pull/1" } }) }),
      makeTask({ id: "t-workeralpha-1", assignedWorkerId: "workeralpha", status: "failed", updatedAt: "2026-05-26T11:00:00.000Z", completedAt: "2026-05-26T11:00:00.000Z", result: makeResult({ output: { blockCommentUrl: "https://github.com/o/r/issues/1#issuecomment-2" } }) }),
    ];
    const manifest: RoundManifest = { roundLabel: "test", lanes: [{ workerId: "workerbeta" }, { workerId: "workeralpha" }] };
    const gv = collectRoundResults(manifest, tasks, { nowMs }).gateVerdict!;
    equal(gv.verdict, "BLOCKED");
    deepEqual(gv.failedLanes, ["workeralpha"]);
    deepEqual(gv.missingEvidenceLanes, []);
  });

  it("exposes missingEvidenceLanes for terminal-success lanes lacking evidence", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({ id: "t-workerbeta-1", assignedWorkerId: "workerbeta", status: "succeeded", updatedAt: "2026-05-26T11:30:00.000Z", result: makeResult({}) }),
    ];
    const manifest: RoundManifest = { roundLabel: "test", lanes: [{ workerId: "workerbeta" }] };
    const gv = collectRoundResults(manifest, tasks, { nowMs }).gateVerdict!;
    equal(gv.verdict, "BLOCKED");
    deepEqual(gv.missingEvidenceLanes, ["workerbeta"]);
    deepEqual(gv.failedLanes, []);
  });

  it("FINAL verdict has empty failedLanes and missingEvidenceLanes", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({ id: "t-workerbeta-1", assignedWorkerId: "workerbeta", status: "succeeded", updatedAt: "2026-05-26T11:30:00.000Z", completedAt: "2026-05-26T11:30:00.000Z", result: makeResult({ output: { prUrl: "https://github.com/o/r/pull/1" } }) }),
    ];
    const manifest: RoundManifest = { roundLabel: "test", lanes: [{ workerId: "workerbeta" }] };
    const gv = collectRoundResults(manifest, tasks, { nowMs }).gateVerdict!;
    equal(gv.verdict, "FINAL");
    deepEqual(gv.failedLanes, []);
    deepEqual(gv.missingEvidenceLanes, []);
  });
});

// ---------------------------------------------------------------------------
// #920: Evidence quality and operator closeout UX — compact report / classification
// ---------------------------------------------------------------------------

describe("#920 evidence quality and closeout UX", () => {
  it("classifies succeeded analysis tasks as substantive evidence", () => {
    const nowMs = Date.parse("2026-06-19T12:00:00.000Z");
    const manifest: RoundManifest = {
      roundLabel: "a2ad-nexus-roadmap-supp-20260619-915-brokeralpha-operator-ux-workergamma",
      lanes: [
        { workerId: "workergamma", description: "Supplement UX lane", expectedOutcome: "analysis" },
      ],
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workergamma-920",
        intent: "analyze",
        assignedWorkerId: "workergamma",
        targetNodeId: "workergamma",
        status: "succeeded",
        updatedAt: "2026-06-19T11:55:00.000Z",
        completedAt: "2026-06-19T11:55:00.000Z",
        result: makeResult({
          output: {
            analysisStatus: "done",
            findings: ["Evidence quality dashboard is needed for operator closeout"],
            blockerFindings: [],
          },
        }),
      }),
    ];

    const output = collectRoundResults(manifest, tasks, { nowMs });
    const lane = output.lanes[0]!;
    equal(lane.evidenceClass, "substantive");
    equal(lane.laneState, "succeeded");
    equal(output.summary.substantiveEvidence, 1);
  });

  it("classifies supplement lane with source-blocked output as source_blocked, not substantive", () => {
    const nowMs = Date.parse("2026-06-19T12:00:00.000Z");
    const manifest: RoundManifest = {
      roundLabel: "a2ad-supplement-source-budget-test",
      lanes: [
        { workerId: "workeralpha", description: "Source budget supplement", expectedOutcome: "analysis" },
      ],
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workeralpha-supplement",
        intent: "analyze",
        assignedWorkerId: "workeralpha",
        targetNodeId: "workeralpha",
        status: "failed",
        updatedAt: "2026-06-19T11:50:00.000Z",
        completedAt: "2026-06-19T11:50:00.000Z",
        error: {
          code: "handler_exit_nonzero",
          message: "handler exited with code 1",
          details: {
            stdout: JSON.stringify({
              error: {
                code: "openclaw_analysis_failed",
                message: "No mapped repository for assignment: source bundle had 0 files",
              },
            }),
          },
        },
      }),
    ];

    const output = collectRoundResults(manifest, tasks, { nowMs });
    const lane = output.lanes[0]!;
    // A failure with source_blocked patterns should be source_blocked
    equal(lane.evidenceClass, "source_blocked");
    equal(output.summary.sourceBlocked, 1);
    equal(output.summary.substantiveEvidence, 0);
  });

  it("includes evidenceClass column in closeout body table for each lane", () => {
    const nowMs = Date.parse("2026-06-19T12:00:00.000Z");
    const manifest: RoundManifest = {
      roundLabel: "a2ad-evidence-class-column-test",
      lanes: [
        { workerId: "workerbeta", expectedOutcome: "analysis" },
        { workerId: "workergamma", expectedOutcome: "analysis" },
      ],
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerbeta-substantive",
        assignedWorkerId: "workerbeta",
        status: "succeeded",
        updatedAt: "2026-06-19T11:30:00.000Z",
        completedAt: "2026-06-19T11:30:00.000Z",
        result: makeResult({
          output: {
            analysisStatus: "done",
            findings: ["Substantive finding"],
          },
        }),
      }),
      makeTask({
        id: "task-workergamma-wrapper",
        intent: "analyze",
        assignedWorkerId: "workergamma",
        message: "Analyze and return evidence",
        status: "succeeded",
        updatedAt: "2026-06-19T11:00:00.000Z",
        completedAt: "2026-06-19T11:00:00.000Z",
        result: makeResult({
          summary: "Analyze and return evidence",
          note: "echo handled task task-workergamma-wrapper",
          output: { message: "Analyze and return evidence" },
        }),
      }),
    ];

    const output = collectRoundResults(manifest, tasks, { nowMs });
    const body = output.closeoutBundle.body;
    // Table header should have an evidence class column
    ok(body.includes("Evidence"), "Closeout body should have an evidence column reference");
    ok(body.includes("substantive"), "Substantive lane's evidenceClass should appear in closeout body");
    ok(output.closeoutBundle.body.includes("wrapper_only"), "Wrapper-only lane evidenceClass should appear");
  });

  it("preserves dissent from failed lanes in closeout body", () => {
    const nowMs = Date.parse("2026-06-19T12:00:00.000Z");
    const manifest: RoundManifest = {
      roundLabel: "a2ad-dissent-preservation-test",
      parentIssueUrl: "https://github.com/jinwon-int/a2a-nexus/issues/920",
      lanes: [
        { workerId: "workerbeta", expectedOutcome: "patch" },
        { workerId: "workeralpha", expectedOutcome: "analysis" },
      ],
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerbeta-pr",
        assignedWorkerId: "workerbeta",
        status: "succeeded",
        updatedAt: "2026-06-19T11:30:00.000Z",
        completedAt: "2026-06-19T11:30:00.000Z",
        result: makeResult({
          output: {
            prUrl: "https://github.com/example/repo/pull/920",
          },
        }),
      }),
      makeTask({
        id: "task-workeralpha-dissent",
        assignedWorkerId: "workeralpha",
        status: "failed",
        updatedAt: "2026-06-19T11:20:00.000Z",
        completedAt: "2026-06-19T11:20:00.000Z",
        error: {
          code: "handler_exit_nonzero",
          message: "Unsafe: propose_patch would perform live deploy",
          details: { summary: "Dissent: this patch requires live provider sends which are not approved" },
        },
      }),
    ];

    const output = collectRoundResults(manifest, tasks, { nowMs });
    const body = output.closeoutBundle.body;
    ok(body.includes("Dissent") || body.includes("dissent") || body.includes("workeralpha"), "Dissent should be preserved in closeout body");
    ok(body.includes("Unsafe") || body.includes("live deploy"), "Dissent error message should appear");
  });

  it("links child issues from evidence URLs in closeout body", () => {
    const nowMs = Date.parse("2026-06-19T12:00:00.000Z");
    const manifest: RoundManifest = {
      roundLabel: "a2ad-child-issue-links-test",
      parentIssueUrl: "https://github.com/jinwon-int/a2a-nexus/issues/920",
      lanes: [
        { workerId: "workergamma", expectedOutcome: "analysis" },
      ],
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workergamma-child",
        assignedWorkerId: "workergamma",
        status: "succeeded",
        updatedAt: "2026-06-19T11:30:00.000Z",
        completedAt: "2026-06-19T11:30:00.000Z",
        result: makeResult({
          output: {
            prUrl: "https://github.com/jinwon-int/a2a-nexus/pull/922",
            analysisStatus: "done",
            findings: ["Linked PR addresses evidence quality"],
          },
        }),
      }),
    ];

    const output = collectRoundResults(manifest, tasks, { nowMs });
    const body = output.closeoutBundle.body;
    ok(body.includes("pull/922") || body.includes("PR"), "Child issue PR link should appear in closeout body");
    ok(body.includes("920"), "Parent issue reference should appear");
  });

  it("projects BLOCKED verdict lanes into a source-only reject-feedback requeue action plan", () => {
    const nowMs = Date.parse("2026-06-21T12:00:00.000Z");
    const manifest: RoundManifest = {
      roundLabel: "a2ad-requeue-action-plan-test",
      lanes: [
        { workerId: "workeralpha", expectedOutcome: "analysis" },
        { workerId: "workerbeta", expectedOutcome: "analysis" },
        { workerId: "workergamma", expectedOutcome: "analysis" },
      ],
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workeralpha-substantive",
        assignedWorkerId: "workeralpha",
        status: "succeeded",
        updatedAt: "2026-06-21T11:30:00.000Z",
        completedAt: "2026-06-21T11:30:00.000Z",
        result: makeResult({
          output: {
            analysisStatus: "done",
            findings: ["Substantive finding"],
            doneCommentUrl: "https://github.com/jinwon-int/a2a-nexus/issues/970#issuecomment-1",
          },
        }),
      }),
      makeTask({
        id: "task-workerbeta-wrapper",
        intent: "analyze",
        assignedWorkerId: "workerbeta",
        message: "Analyze #970",
        status: "succeeded",
        updatedAt: "2026-06-21T11:20:00.000Z",
        completedAt: "2026-06-21T11:20:00.000Z",
        result: makeResult({
          summary: "Analyze #970",
          note: "echo handled task task-workerbeta-wrapper",
          output: { message: "Analyze #970" },
        }),
      }),
      makeTask({
        id: "task-workergamma-failed",
        assignedWorkerId: "workergamma",
        status: "failed",
        updatedAt: "2026-06-21T11:10:00.000Z",
        completedAt: "2026-06-21T11:10:00.000Z",
        error: { code: "handler_exit_nonzero", message: "Hermes analysis bridge returned invalid JSON" },
      }),
    ];

    const output = collectRoundResults(manifest, tasks, { nowMs });

    equal(output.gateVerdict?.verdict, "BLOCKED");
    equal(output.verdictActionPlan.kind, "reject_feedback_requeue");
    equal(output.verdictActionPlan.sourceOnly, true);
    equal(output.verdictActionPlan.requiresExternalDispatcher, true);
    deepEqual(output.verdictActionPlan.lanes.map((lane) => lane.workerId), ["workerbeta", "workergamma"]);
    deepEqual(output.verdictActionPlan.lanes.map((lane) => lane.taskId), ["task-workerbeta-wrapper", "task-workergamma-failed"]);
    ok(output.verdictActionPlan.lanes[0]!.rejectionReason.includes("wrapper_only"));
    ok(output.verdictActionPlan.lanes[0]!.priorAttemptEvidenceRef.includes("task-workerbeta-wrapper"));
    ok(output.verdictActionPlan.lanes[1]!.rejectionReason.includes("terminal_failed"));
    ok(output.closeoutBundle.body.includes("Reject-feedback requeue plan"));
  });

  it("projects FINAL verdicts as finalizer-review actions without requeue lanes", () => {
    const nowMs = Date.parse("2026-06-21T12:00:00.000Z");
    const manifest: RoundManifest = {
      roundLabel: "a2ad-final-action-plan-test",
      lanes: [{ workerId: "workeralpha", expectedOutcome: "analysis" }],
    };
    const output = collectRoundResults(manifest, [
      makeTask({
        id: "task-workeralpha-substantive",
        assignedWorkerId: "workeralpha",
        status: "succeeded",
        updatedAt: "2026-06-21T11:30:00.000Z",
        completedAt: "2026-06-21T11:30:00.000Z",
        result: makeResult({
          output: {
            analysisStatus: "done",
            findings: ["Substantive finding"],
            doneCommentUrl: "https://github.com/jinwon-int/a2a-nexus/issues/970#issuecomment-2",
          },
        }),
      }),
    ], { nowMs });

    equal(output.gateVerdict?.verdict, "FINAL");
    equal(output.verdictActionPlan.kind, "finalizer_review");
    deepEqual(output.verdictActionPlan.lanes, []);
  });

  it("treats oracle mismatches as hard-block evidence and requeue feedback", () => {
    const nowMs = Date.parse("2026-06-21T12:00:00.000Z");
    const manifest: RoundManifest = {
      roundLabel: "a2ad-oracle-mismatch-test",
      lanes: [{ workerId: "workeralpha", expectedOutcome: "analysis" }],
    };
    const output = collectRoundResults(manifest, [
      makeTask({
        id: "task-workeralpha-oracle-mismatch",
        assignedWorkerId: "workeralpha",
        status: "succeeded",
        updatedAt: "2026-06-21T11:30:00.000Z",
        completedAt: "2026-06-21T11:30:00.000Z",
        result: makeResult({
          output: {
            analysisStatus: "done",
            findings: ["PR #974 is merged"],
            oracleVerdicts: [{
              sourceKind: "github",
              evidenceRef: "https://github.com/jinwon-int/a2a-nexus/pull/974",
              match: false,
              actualValue: false,
              detail: "github.merged mismatch: claimed=true actual=false",
            }],
            blockFlags: ["factual_error"],
          },
        }),
      }),
    ], { nowMs });

    equal(output.gateVerdict?.verdict, "BLOCKED");
    equal(output.lanes[0]!.laneState, "blocked");
    equal(output.lanes[0]!.evidenceClass, "oracle_mismatch");
    equal(output.lanes[0]!.readinessStatus, "oracle_mismatch");
    equal(output.summary.oracleMismatches, 1);
    equal(output.verdictActionPlan.kind, "reject_feedback_requeue");
    ok(output.verdictActionPlan.lanes[0]!.rejectionReason.includes("oracle_mismatch"));
  });
});

// ---------------------------------------------------------------------------
// #920: Compact evidence summary report rendering
// ---------------------------------------------------------------------------

describe("A2AD evidence summary report (#920)", () => {
  it("renders a compact one-line-per-lane summary with classification", () => {
    const nowMs = Date.parse("2026-06-19T12:00:00.000Z");
    const manifest: RoundManifest = {
      roundLabel: "a2ad-summary-test",
      parentIssueUrl: "https://github.com/jinwon-int/a2a-nexus/issues/920",
      lanes: [
        { workerId: "workergamma", description: "UX supplement", expectedOutcome: "analysis" },
        { workerId: "workeralpha", description: "Reliability lane", expectedOutcome: "analysis" },
      ],
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workergamma-substantive",
        assignedWorkerId: "workergamma",
        status: "succeeded",
        updatedAt: "2026-06-19T11:55:00.000Z",
        completedAt: "2026-06-19T11:55:00.000Z",
        result: makeResult({
          output: {
            analysisStatus: "done",
            findings: ["Evidence quality dashboard"],
            prUrl: "https://github.com/jinwon-int/a2a-nexus/pull/922",
          },
        }),
      }),
      makeTask({
        id: "task-workeralpha-timeout",
        assignedWorkerId: "workeralpha",
        status: "running",
        updatedAt: "2026-06-19T10:00:00.000Z",
      }),
    ];

    const output = collectRoundResults(manifest, tasks, { nowMs });
    const summary = renderCompactEvidenceSummary(output, { parentIssueUrl: "https://github.com/jinwon-int/a2a-nexus/issues/920" });

    ok(summary.includes("workergamma"), "Summary should include workergamma worker");
    ok(summary.includes("substantive"), "Substantive classification should appear");
    ok(summary.includes("pull/922"), "Evidence PR URL should appear");
  });

  it("renders summary with all lane classifications including wrapper-only and source-blocked", () => {
    const nowMs = Date.parse("2026-06-19T12:00:00.000Z");
    const manifest: RoundManifest = {
      roundLabel: "a2ad-classification-coverage-test",
      lanes: [
        { workerId: "workergamma", expectedOutcome: "analysis" },
        { workerId: "workeralpha", expectedOutcome: "analysis" },
        { workerId: "workerbeta", expectedOutcome: "analysis" },
      ],
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workergamma-substantive",
        assignedWorkerId: "workergamma",
        status: "succeeded",
        updatedAt: "2026-06-19T11:55:00.000Z",
        completedAt: "2026-06-19T11:55:00.000Z",
        result: makeResult({
          output: { analysisStatus: "done", findings: ["Findings"], prUrl: "https://github.com/example/repo/pull/1" },
        }),
      }),
      makeTask({
        id: "task-workeralpha-source-blocked",
        assignedWorkerId: "workeralpha",
        status: "failed",
        updatedAt: "2026-06-19T11:50:00.000Z",
        completedAt: "2026-06-19T11:50:00.000Z",
        error: {
          code: "handler_exit_nonzero",
          message: "handler exited with code 1",
          details: {
            stdout: JSON.stringify({
              error: { code: "openclaw_analysis_failed", message: "No mapped repository: source bundle had 0 files" },
            }),
          },
        },
      }),
      makeTask({
        id: "task-workerbeta-wrapper",
        intent: "analyze",
        assignedWorkerId: "workerbeta",
        message: "Analyze",
        status: "succeeded",
        updatedAt: "2026-06-19T11:00:00.000Z",
        completedAt: "2026-06-19T11:00:00.000Z",
        result: makeResult({
          summary: "Analyze",
          note: "echo handled task task-workerbeta-wrapper",
          output: { message: "Analyze" },
        }),
      }),
    ];

    const output = collectRoundResults(manifest, tasks, { nowMs });
    const summary = renderCompactEvidenceSummary(output);

    ok(summary.includes("substantive"), "Substantive classification");
    ok(summary.includes("source_blocked") || summary.includes("source-blocked") || summary.includes("source blocked"), "Source-blocked classification");
    ok(summary.includes("wrapper_only") || summary.includes("wrapper-only"), "Wrapper-only classification");
  });

  it("includes non-actions disclaimer in the summary", () => {
    const nowMs = Date.parse("2026-06-19T12:00:00.000Z");
    const manifest: RoundManifest = {
      roundLabel: "a2ad-non-actions-test",
      lanes: [{ workerId: "workergamma", expectedOutcome: "analysis" }],
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workergamma",
        assignedWorkerId: "workergamma",
        status: "succeeded",
        updatedAt: "2026-06-19T11:55:00.000Z",
        completedAt: "2026-06-19T11:55:00.000Z",
        result: makeResult({
          output: { analysisStatus: "done", findings: ["Test"], prUrl: "https://github.com/example/repo/pull/1" },
        }),
      }),
    ];

    const output = collectRoundResults(manifest, tasks, { nowMs });
    const summary = renderCompactEvidenceSummary(output);
    ok(summary.includes("no deploy") || summary.includes("No deploy") || summary.includes("non-action"), "Non-actions disclaimer should appear");
  });
});

// ---------------------------------------------------------------------------
// #920: Notification payload shape
// ---------------------------------------------------------------------------

describe("roundCompletePayload (#920)", () => {
  it("produces a compact payload without raw secrets or full transcripts", () => {
    const nowMs = Date.parse("2026-06-19T12:00:00.000Z");
    const manifest: RoundManifest = {
      roundLabel: "a2ad-notification-test",
      parentIssueUrl: "https://github.com/jinwon-int/a2a-nexus/issues/920",
      lanes: [{ workerId: "workergamma", expectedOutcome: "analysis" }],
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workergamma-notif",
        assignedWorkerId: "workergamma",
        status: "succeeded",
        updatedAt: "2026-06-19T11:55:00.000Z",
        completedAt: "2026-06-19T11:55:00.000Z",
        result: makeResult({
          output: {
            analysisStatus: "done",
            findings: ["Evidence quality analysis"],
            prUrl: "https://github.com/jinwon-int/a2a-nexus/pull/922",
          },
        }),
      }),
    ];

    const output = collectRoundResults(manifest, tasks, { nowMs });
    const payload = buildRoundCompletePayload(output);

    equal(typeof payload, "object");
    ok(payload.roundLabel);
    ok(payload.verdict);
    ok(Array.isArray(payload.lanes));
    equal(payload.lanes.length, 1);
    equal(payload.lanes[0]!.evidenceClass, "substantive");
    // Must NOT include raw task output/error details
    ok(!JSON.stringify(payload).includes("analysisStatus"), "Should not include raw task output");
    ok(!JSON.stringify(payload).includes("findings"), "Should not include raw task findings");
    ok(Boolean(payload.parentIssueUrl));
  });

  it("includes verdict, classification, and evidence URLs per lane", () => {
    const nowMs = Date.parse("2026-06-19T12:00:00.000Z");
    const manifest: RoundManifest = {
      roundLabel: "a2ad-notification-full-test",
      lanes: [
        { workerId: "workerbeta", expectedOutcome: "patch" },
        { workerId: "workergamma", expectedOutcome: "analysis" },
      ],
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workerbeta-pr",
        assignedWorkerId: "workerbeta",
        status: "succeeded",
        updatedAt: "2026-06-19T11:30:00.000Z",
        completedAt: "2026-06-19T11:30:00.000Z",
        result: makeResult({
          output: {
            prUrl: "https://github.com/example/repo/pull/1",
          },
        }),
      }),
      makeTask({
        id: "task-workergamma-blocked",
        assignedWorkerId: "workergamma",
        status: "blocked",
        updatedAt: "2026-06-19T11:00:00.000Z",
        result: makeResult({
          output: { blockUrl: "https://github.com/example/repo/issues/1" },
        }),
      }),
    ];

    const output = collectRoundResults(manifest, tasks, { nowMs });
    const payload = buildRoundCompletePayload(output);

    equal(payload.verdict, "BLOCKED");
    ok(payload.lanes.find((l: { workerId: string }) => l.workerId === "workerbeta"));
    ok(payload.lanes.find((l: { workerId: string }) => l.workerId === "workergamma"));
    const workergammaLane = payload.lanes.find((l: { workerId: string }) => l.workerId === "workergamma")!;
    ok(workergammaLane.evidenceUrls?.length > 0 || workergammaLane.blockUrl, "Blocked lane should have evidence URL");
  });
});

// ---------------------------------------------------------------------------
// #920 / #922: SourceBundle prompt-budget regression test
// ---------------------------------------------------------------------------

describe("sourceBundle prompt-budget regression (#920/#922)", () => {
  // This test verifies that when a task has a large README / current-state
  // document, role-specific source files are not starved. The regression
  // occurs when the prompt budget for source files is exhausted by a single
  // large file, leaving no room for targeted source files.
  //
  // Since the collector doesn't directly control sourceBundle construction,
  // we test at the evidence level: substantive worker output that references
  // role-specific files (e.g. packages/broker/src/http/rounds.ts) must not be
  // downgraded just because the source bundle also contained a large README.

  it("does not starve role-specific source evidence when large README is present", () => {
    const nowMs = Date.parse("2026-06-19T12:00:00.000Z");
    const manifest: RoundManifest = {
      roundLabel: "a2ad-source-budget-test",
      lanes: [
        { workerId: "workergamma", expectedOutcome: "analysis" },
      ],
    };
    // Simulate a task that produced substantive findings targeting a specific file
    // despite having a large source bundle
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-workergamma-source-budget",
        intent: "analyze",
        assignedWorkerId: "workergamma",
        targetNodeId: "workergamma",
        status: "succeeded",
        updatedAt: "2026-06-19T11:55:00.000Z",
        completedAt: "2026-06-19T11:55:00.000Z",
        result: makeResult({
          summary: "Analysis completed after reviewing 12k tokens source bundle",
          output: {
            analysisStatus: "done",
            analysisSummary: "Reviewed packages/broker/src/http/rounds.ts (the specific file) and README.md (12K tokens)",
            findings: [
              "Round evidence quality is missing from the closeout bundle shape",
              "Found 2 relevant sections in packages/broker/src/http/rounds.ts",
            ],
            recommendations: ["Add evidenceClass column to closeout table"],
          },
        }),
      }),
    ];

    const output = collectRoundResults(manifest, tasks, { nowMs });
    const lane = output.lanes[0]!;

    // The analysis should be classified as substantive even though source was large
    equal(lane.evidenceClass, "substantive");
    equal(lane.laneState, "succeeded");
    ok(lane.outcomeSummary || lane.outcomeClass, "Should have outcome evidence");

    // Additionally, the closeout body should reference the evidence
    ok(output.closeoutBundle.body.includes("substantive"), "Closeout should reflect substantive evidence");
  });
});
