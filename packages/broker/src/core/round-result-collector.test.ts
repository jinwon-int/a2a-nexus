/**
 * round-result-collector.test.ts — result collector projection tests (issue #929)
 */

import { describe, it } from "node:test";
import { equal, ok } from "node:assert/strict";
import {
  collectRoundResults,
  buildRoundManifest,
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
    assignedWorkerId: "sogyo",
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
    { workerId: "sogyo" },
    { workerId: "bangtong", description: "Round manifest" },
    { workerId: "nosuk", description: "A2A definitions" },
    { workerId: "yukson", description: "Validation" },
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
    equal(output.missingLanes.includes("sogyo"), true);
    equal(output.missingLanes.includes("bangtong"), true);
    equal(output.missingLanes.includes("nosuk"), true);
    equal(output.missingLanes.includes("yukson"), true);

    for (const lane of output.lanes) {
      equal(lane.laneState, "pending");
      equal(lane.taskIds.length, 0);
    }
  });

  it("classifies a lane as running when task is active", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-sogyo-1",
        assignedWorkerId: "sogyo",
        status: "running",
        updatedAt: "2026-05-26T11:55:00.000Z", // 5 min ago < 30 min stale threshold
      }),
    ];
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });

    const sogyoLane = output.lanes.find((l) => l.workerId === "sogyo")!;
    ok(sogyoLane);
    equal(sogyoLane.laneState, "running");
    equal(sogyoLane.latestStatus, "running");
    equal(sogyoLane.taskIds.length, 1);
    equal(sogyoLane.taskIds[0], "task-sogyo-1");
  });

  it("classifies a lane as succeeded with pr evidence", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-sogyo-1",
        assignedWorkerId: "sogyo",
        status: "succeeded",
        updatedAt: "2026-05-26T11:30:00.000Z",
        completedAt: "2026-05-26T11:30:00.000Z",
        result: makeResult({
          output: { prUrl: "https://github.com/example/repo/pull/42" },
        }),
      }),
    ];
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });

    const lane = output.lanes.find((l) => l.workerId === "sogyo")!;
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
        id: "task-sogyo-1",
        assignedWorkerId: "sogyo",
        status: "succeeded",
        updatedAt: "2026-05-26T11:30:00.000Z",
        completedAt: "2026-05-26T11:30:00.000Z",
        result: makeResult({
          output: { doneCommentUrl: "https://github.com/example/repo/issues/1#issuecomment-123" },
        }),
      }),
    ];
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });

    const lane = output.lanes.find((l) => l.workerId === "sogyo")!;
    equal(lane.laneState, "succeeded");
    equal(lane.outcomeClass, "no_change_done");
    equal(lane.doneUrl, "https://github.com/example/repo/issues/1#issuecomment-123");
  });

  it("classifies a lane as succeeded without evidence (no output)", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-sogyo-1",
        assignedWorkerId: "sogyo",
        status: "succeeded",
        updatedAt: "2026-05-26T11:30:00.000Z",
        result: makeResult({}),
      }),
    ];
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });

    const lane = output.lanes.find((l) => l.workerId === "sogyo")!;
    equal(lane.laneState, "succeeded");
    equal(lane.outcomeClass, undefined); // can't classify without evidence
    equal(lane.evidenceUrls.length, 0);
  });

  it("classifies a lane as failed", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-sogyo-1",
        assignedWorkerId: "sogyo",
        status: "failed",
        updatedAt: "2026-05-26T11:30:00.000Z",
        completedAt: "2026-05-26T11:30:00.000Z",
        result: makeResult({
          output: { blockCommentUrl: "https://github.com/example/repo/issues/1#issuecomment-456" },
        }),
      }),
    ];
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });

    const lane = output.lanes.find((l) => l.workerId === "sogyo")!;
    equal(lane.laneState, "failed");
    equal(lane.outcomeClass, "no_change_block");
    equal(lane.blockUrl, "https://github.com/example/repo/issues/1#issuecomment-456");
  });

  it("classifies a lane as blocked", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-sogyo-1",
        assignedWorkerId: "sogyo",
        status: "blocked",
        updatedAt: "2026-05-26T11:30:00.000Z",
        result: makeResult({
          output: { blockUrl: "https://github.com/example/repo/issues/1#issuecomment-789" },
        }),
      }),
    ];
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });

    const lane = output.lanes.find((l) => l.workerId === "sogyo")!;
    equal(lane.laneState, "blocked");
    equal(lane.outcomeClass, "no_change_block");
    equal(lane.blockUrl, "https://github.com/example/repo/issues/1#issuecomment-789");
  });

  it("classifies a lane as stale when non-terminal past threshold", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z"); // noon
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-sogyo-1",
        assignedWorkerId: "sogyo",
        status: "running",
        // updated 35 min ago > 30 min stale threshold
        updatedAt: "2026-05-26T11:25:00.000Z",
      }),
    ];
    // Using default staleAfterMs = 30 min
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });

    const lane = output.lanes.find((l) => l.workerId === "sogyo")!;
    equal(lane.laneState, "stale");
    ok(lane.ageMs! >= 30 * 60 * 1000);
    equal(output.staleLanes.includes("sogyo"), true);
  });

  it("classifies a lane as running when non-terminal and fresh", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-sogyo-1",
        assignedWorkerId: "sogyo",
        status: "running",
        // updated 5 min ago < 30 min stale threshold
        updatedAt: "2026-05-26T11:55:00.000Z",
      }),
    ];
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });

    const lane = output.lanes.find((l) => l.workerId === "sogyo")!;
    equal(lane.laneState, "running");
    equal(output.staleLanes.includes("sogyo"), false);
  });

  it("classifies a lane as timeout when past deadline", () => {
    const nowMs = Date.parse("2026-05-27T01:00:00.000Z"); // next day, past timeoutAt
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-sogyo-1",
        assignedWorkerId: "sogyo",
        status: "running",
        updatedAt: "2026-05-26T23:30:00.000Z",
      }),
    ];
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });

    const lane = output.lanes.find((l) => l.workerId === "sogyo")!;
    equal(lane.laneState, "timeout");
    equal(output.timeoutLanes.includes("sogyo"), true);
  });

  it("excludes workers listed in excludedWorkerIds", () => {
    const manifest: RoundManifest = {
      roundLabel: "test-round",
      lanes: [
        { workerId: "sogyo" },
        { workerId: "excluded-worker" },
      ],
      excludedWorkerIds: ["excluded-worker"],
    };
    const output = collectRoundResults(manifest, [], { nowMs: Date.parse("2026-05-26T12:00:00.000Z") });

    equal(output.summary.totalLanes, 1); // only sogyo
    equal(output.missingLanes.length, 1);
    equal(output.missingLanes[0], "sogyo");
  });

  it("handles mixed lane states correctly", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-sogyo-1",
        assignedWorkerId: "sogyo",
        status: "succeeded",
        updatedAt: "2026-05-26T11:30:00.000Z",
        completedAt: "2026-05-26T11:30:00.000Z",
        result: makeResult({
          output: { prUrl: "https://github.com/example/repo/pull/42" },
        }),
      }),
      makeTask({
        id: "task-bangtong-1",
        assignedWorkerId: "bangtong",
        status: "failed",
        updatedAt: "2026-05-26T11:00:00.000Z",
        completedAt: "2026-05-26T11:00:00.000Z",
        result: makeResult({
          output: { blockCommentUrl: "https://github.com/example/repo/issues/1#comment-123" },
        }),
      }),
      makeTask({
        id: "task-nosuk-1",
        assignedWorkerId: "nosuk",
        status: "running",
        updatedAt: "2026-05-26T11:55:00.000Z",
      }),
    ];
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });

    equal(output.summary.completed, 1); // sogyo succeeded
    equal(output.summary.blocked, 1); // bangtong failed → counts as blocked
    equal(output.summary.running, 1); // nosuk running and fresh
    equal(output.summary.pending, 1); // yukson has no tasks

    const sogyo = output.lanes.find((l) => l.workerId === "sogyo")!;
    equal(sogyo.laneState, "succeeded");
    equal(sogyo.prUrl, "https://github.com/example/repo/pull/42");

    const bangtong = output.lanes.find((l) => l.workerId === "bangtong")!;
    equal(bangtong.laneState, "failed");

    const nosuk = output.lanes.find((l) => l.workerId === "nosuk")!;
    equal(nosuk.laneState, "running");

    const yukson = output.lanes.find((l) => l.workerId === "yukson")!;
    equal(yukson.laneState, "pending");
  });

  it("extracts evidence from multiple task output fields", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-sogyo-1",
        assignedWorkerId: "sogyo",
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

    const lane = output.lanes.find((l) => l.workerId === "sogyo")!;
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
        id: "task-sogyo-1",
        assignedWorkerId: "sogyo",
        status: "queued",
        createdAt: "2026-05-26T10:00:00.000Z",
        updatedAt: "2026-05-26T10:00:00.000Z",
      }),
      makeTask({
        id: "task-sogyo-2",
        assignedWorkerId: "sogyo",
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

    const lane = output.lanes.find((l) => l.workerId === "sogyo")!;
    // Lane should use the latest task's status (succeeded) and evidence
    equal(lane.laneState, "succeeded");
    equal(lane.prUrl, "https://github.com/example/repo/pull/43");
    equal(lane.taskIds.length, 2);
    // Latest task should be sorted by createdAt desc
    equal(lane.taskIds[0], "task-sogyo-2");
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
        id: "task-sogyo-1",
        assignedWorkerId: "sogyo",
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

    const lane = output.lanes.find((l) => l.workerId === "sogyo")!;
    equal(lane.evidenceUrls.length, 0); // Both URLs are not https
    equal(lane.prUrl, undefined);
    equal(lane.doneUrl, undefined);
  });

  it("returns canceled tasks as failed", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-sogyo-1",
        assignedWorkerId: "sogyo",
        status: "canceled",
        updatedAt: "2026-05-26T11:30:00.000Z",
        completedAt: "2026-05-26T11:30:00.000Z",
      }),
    ];
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });

    const lane = output.lanes.find((l) => l.workerId === "sogyo")!;
    equal(lane.laneState, "failed");
    equal(lane.outcomeClass, "infra_failure");
  });

  it("extracts error summary from task.error", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-sogyo-1",
        assignedWorkerId: "sogyo",
        status: "failed",
        updatedAt: "2026-05-26T11:30:00.000Z",
        completedAt: "2026-05-26T11:30:00.000Z",
        error: { message: "Timeout after 300s", code: "timeout" },
      }),
    ];
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });

    const lane = output.lanes.find((l) => l.workerId === "sogyo")!;
    equal(lane.errorSummary, "Timeout after 300s");
  });

  it("does not count wrapper-only review success as substantive A2AD evidence", () => {
    const nowMs = Date.parse("2026-06-13T01:30:00.000Z");
    const message = "Review PR #653 and return JSON-like evidence";
    const manifest: RoundManifest = {
      roundLabel: "a2a-pr-review-test",
      lanes: [{ workerId: "nosuk", expectedOutcome: "review" }],
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-nosuk-wrapper-only",
        intent: "analyze",
        assignedWorkerId: "nosuk",
        targetNodeId: "nosuk",
        message,
        status: "succeeded",
        updatedAt: "2026-06-13T01:21:23.197Z",
        completedAt: "2026-06-13T01:21:23.197Z",
        result: makeResult({
          summary: message,
          note: "echo handled task task-nosuk-wrapper-only",
          output: { taskId: "task-nosuk-wrapper-only", intent: "analyze", message },
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
      lanes: [{ workerId: "sogyo", expectedOutcome: "review" }],
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-sogyo-generic-analyze",
        intent: "analyze",
        assignedWorkerId: "sogyo",
        targetNodeId: "sogyo",
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
      lanes: [{ workerId: "sogyo", expectedOutcome: "review" }],
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-sogyo-eacces",
        intent: "analyze",
        assignedWorkerId: "sogyo",
        targetNodeId: "sogyo",
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
      lanes: [{ workerId: "daegyo", expectedOutcome: "review" }],
      staleAfterMs: 30 * 60 * 1000,
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-daegyo-queued",
        intent: "analyze",
        assignedWorkerId: undefined,
        claimedBy: undefined,
        targetNodeId: "daegyo",
        target: { id: "daegyo", kind: "node", role: "analyst" },
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
      lanes: [{ workerId: "sogyo", expectedOutcome: "review" }],
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-sogyo-review-done",
        intent: "analyze",
        assignedWorkerId: "sogyo",
        targetNodeId: "sogyo",
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
      lanes: [{ workerId: "sogyo", expectedOutcome: "analysis" }],
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "a2a-nexus-open-issues-continue-20260615T153154Z-sogyo",
        intent: "analyze",
        assignedWorkerId: "sogyo",
        targetNodeId: "sogyo",
        status: "succeeded",
        updatedAt: "2026-06-15T15:35:00.000Z",
        completedAt: "2026-06-15T15:35:00.000Z",
        payload: {
          parentRoundId: "a2a-nexus-open-issues-continue-20260615T153154Z",
          parentRoundOrder: 1,
          parentRoundTotal: 6,
          originBrokerId: "seoseo",
          brokerOfRecordId: "seoseo",
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
    equal(lane.originBrokerId, "seoseo");
    equal(lane.brokerOfRecordId, "seoseo");
    equal(lane.assignedWorkerId, "sogyo");
    ok(output.closeoutBundle.body.includes("parent=a2a-nexus-open-issues-continue-20260615T153154Z"));
    ok(output.closeoutBundle.body.includes("order=1/6"));
  });

  it("classifies provider/model analysis failures as handler artifact failures, not substantive evidence", () => {
    const nowMs = Date.parse("2026-06-15T15:40:00.000Z");
    const manifest: RoundManifest = {
      roundLabel: "a2a-provider-mismatch-test",
      lanes: [{ workerId: "dungae", expectedOutcome: "analysis" }],
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-dungae-model-mismatch",
        intent: "analyze",
        assignedWorkerId: "dungae",
        targetNodeId: "dungae",
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
      lanes: [{ workerId: "sogyo", expectedOutcome: "analysis" }],
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-sogyo-no-parent-round",
        intent: "analyze",
        assignedWorkerId: "sogyo",
        targetNodeId: "sogyo",
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
      lanes: [{ workerId: "bangtong", expectedOutcome: "analysis" }],
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-bangtong-empty-source",
        intent: "analyze",
        assignedWorkerId: "bangtong",
        targetNodeId: "bangtong",
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
    const manifest = buildRoundManifest("test-round", ["sogyo", "bangtong"], {
      descriptions: { sogyo: "Result collector", bangtong: "Round manifest" },
      expectedOutcomes: { sogyo: "patch", bangtong: "analysis" },
      parentIssueUrl: "https://github.com/jinwon-int/a2a-broker/issues/927",
      staleAfterMs: 60000,
    });

    equal(manifest.roundLabel, "test-round");
    equal(manifest.lanes.length, 2);
    equal(manifest.lanes[0]!.workerId, "sogyo");
    equal(manifest.lanes[0]!.description, "Result collector");
    equal(manifest.lanes[0]!.expectedOutcome, "patch");
    equal(manifest.lanes[1]!.workerId, "bangtong");
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
  it("projects a compact operator evidence summary with finalizer decision and non-actions (#920)", () => {
    const nowMs = Date.parse("2026-06-19T02:00:00.000Z");
    const manifest: RoundManifest = {
      roundLabel: "a2ad-evidence-quality-test",
      parentIssueUrl: "https://github.com/jinwon-int/a2a-nexus/issues/920",
      lanes: [
        { workerId: "nosuk", expectedOutcome: "analysis" },
        { workerId: "bangtong", expectedOutcome: "analysis" },
        { workerId: "echo", expectedOutcome: "analysis" },
        { workerId: "failed", expectedOutcome: "analysis" },
        { workerId: "timeout", expectedOutcome: "analysis" },
        { workerId: "queued", expectedOutcome: "analysis" },
        { workerId: "original", expectedOutcome: "analysis", supersededBySupplementTaskId: "task-supplement" },
      ],
      timeoutAt: "2026-06-19T01:59:00.000Z",
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-nosuk",
        assignedWorkerId: "nosuk",
        status: "succeeded",
        updatedAt: "2026-06-19T01:50:00.000Z",
        completedAt: "2026-06-19T01:50:00.000Z",
        payload: { parentRoundId: "round-920", parentRoundOrder: 1, parentRoundTotal: 7, brokerOfRecordId: "seoseo" },
        result: makeResult({ output: { analysisStatus: "done", findings: ["substantive"], doneCommentUrl: "https://github.com/jinwon-int/a2a-nexus/issues/920#issuecomment-1" } }),
      }),
      makeTask({
        id: "task-bangtong-source-blocked",
        assignedWorkerId: "bangtong",
        status: "failed",
        updatedAt: "2026-06-19T01:51:00.000Z",
        completedAt: "2026-06-19T01:51:00.000Z",
        error: { code: "handler_exit_nonzero", message: "handler exited", details: { stdout: "analysis bridge blocked: source bundle contained 0 files" } },
      }),
      makeTask({
        id: "task-echo-wrapper",
        assignedWorkerId: "echo",
        status: "succeeded",
        updatedAt: "2026-06-19T01:52:00.000Z",
        completedAt: "2026-06-19T01:52:00.000Z",
        message: "Analyze issue #920",
        result: makeResult({ summary: "Analyze issue #920", note: "echo handled task task-echo-wrapper", output: { message: "Analyze issue #920" } }),
      }),
      makeTask({
        id: "task-failed",
        assignedWorkerId: "failed",
        status: "failed",
        updatedAt: "2026-06-19T01:53:00.000Z",
        completedAt: "2026-06-19T01:53:00.000Z",
        error: { code: "github_executor_not_configured", message: "github executor not configured" },
      }),
      makeTask({ id: "task-timeout", assignedWorkerId: "timeout", status: "running", updatedAt: "2026-06-19T01:40:00.000Z" }),
      makeTask({ id: "task-queued", assignedWorkerId: undefined, claimedBy: undefined, targetNodeId: "queued", target: { id: "queued", kind: "node" }, status: "queued", updatedAt: "2026-06-19T01:58:30.000Z" }),
      makeTask({ id: "task-original", assignedWorkerId: "original", status: "running", updatedAt: "2026-06-19T01:55:00.000Z" }),
    ];

    const output = collectRoundResults(manifest, tasks, { nowMs });
    const byWorker = new Map(output.evidenceSummary.lanes.map((lane) => [lane.workerId, lane]));

    equal(byWorker.get("nosuk")?.category, "substantive");
    equal(byWorker.get("bangtong")?.category, "source-blocked");
    equal(byWorker.get("echo")?.category, "wrapper-only");
    equal(byWorker.get("failed")?.category, "failed");
    equal(byWorker.get("timeout")?.category, "timeout");
    equal(byWorker.get("queued")?.category, "queued/stuck");
    equal(byWorker.get("original")?.category, "superseded-by-supplement");
    equal(byWorker.get("nosuk")?.taskIds[0], "task-nosuk");
    equal(byWorker.get("nosuk")?.evidenceRefs[0], "https://github.com/jinwon-int/a2a-nexus/issues/920#issuecomment-1");
    equal(byWorker.get("nosuk")?.workerAttribution.assignedWorkerId, "nosuk");
    equal(output.evidenceSummary.finalizerDecision.verdict, "BLOCKED");
    ok(output.evidenceSummary.nonActions.includes("No Telegram/provider send"));
    equal(output.operatorNotificationPayload.kind, "a2ad.round.evidence_summary.v1");
    equal(output.operatorNotificationPayload.roundLabel, "a2ad-evidence-quality-test");
    equal(output.operatorNotificationPayload.finalizerDecision.verdict, "BLOCKED");
    equal(output.operatorNotificationPayload.lanes.some((lane) => "rawTranscript" in lane), false);
    ok(output.closeoutBundle.body.includes("### Compact evidence summary"));
    ok(output.closeoutBundle.body.includes("superseded-by-supplement"));
  });

  it("renders all-complete bundle with ✅ emoji", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-sogyo-1",
        assignedWorkerId: "sogyo",
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
      lanes: [{ workerId: "sogyo" }],
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
        id: "task-sogyo-1",
        assignedWorkerId: "sogyo",
        status: "blocked",
        updatedAt: "2026-05-26T11:30:00.000Z",
        result: makeResult({
          output: { blockUrl: "https://github.com/example/repo/issues/1" },
        }),
      }),
    ];

    const manifest: RoundManifest = {
      roundLabel: "test-round",
      lanes: [{ workerId: "sogyo" }],
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
        id: "task-sogyo-1",
        assignedWorkerId: "sogyo",
        status: "running",
        updatedAt: "2026-05-26T22:00:00.000Z",
      }),
    ];

    const manifest: RoundManifest = {
      roundLabel: "test-round",
      lanes: [{ workerId: "sogyo" }],
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
        id: "task-sogyo-1",
        assignedWorkerId: "sogyo",
        status: "succeeded",
        updatedAt: "2026-05-26T11:30:00.000Z",
        result: undefined as unknown as TaskResult,
      }),
    ];
    // Should not throw
    const output = collectRoundResults(DEFAULT_MANIFEST, tasks, { nowMs });
    const lane = output.lanes.find((l) => l.workerId === "sogyo")!;
    equal(lane.laneState, "succeeded");
    equal(lane.evidenceUrls.length, 0);
  });

  it("handles staleAfterMs = 1 (immediate staleness)", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const manifest: RoundManifest = {
      roundLabel: "test-round",
      lanes: [{ workerId: "sogyo" }],
      staleAfterMs: 1, // essentially immediate
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-sogyo-1",
        assignedWorkerId: "sogyo",
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
      lanes: [{ workerId: "sogyo" }],
      // no timeoutAt set
    };
    const tasks: TaskRecord[] = [
      makeTask({
        id: "task-sogyo-1",
        assignedWorkerId: "sogyo",
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
      makeTask({ id: "t-sogyo-1", assignedWorkerId: "sogyo", status: "succeeded", updatedAt: "2026-05-26T11:30:00.000Z", result: makeResult({ output: { prUrl: "https://github.com/o/r/pull/1" } }) }),
      makeTask({ id: "t-bangtong-1", assignedWorkerId: "bangtong", status: "running", updatedAt: "2026-05-26T11:50:00.000Z" }),
    ];
    const manifest: RoundManifest = { roundLabel: "test", lanes: [{ workerId: "sogyo" }, { workerId: "bangtong" }] };
    const output = collectRoundResults(manifest, tasks, { nowMs });
    equal(output.gateVerdict!.verdict, "BLOCKED");
    equal(output.gateVerdict!.pending, 1);
    ok(output.gateVerdict!.reason!.includes("non-terminal"));
  });

  it("BLOCKED when succeeded lane lacks evidence URLs", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({ id: "t-sogyo-1", assignedWorkerId: "sogyo", status: "succeeded", updatedAt: "2026-05-26T11:30:00.000Z", result: makeResult({}) }),
    ];
    const manifest: RoundManifest = { roundLabel: "test", lanes: [{ workerId: "sogyo" }] };
    const output = collectRoundResults(manifest, tasks, { nowMs });
    equal(output.gateVerdict!.verdict, "BLOCKED");
    ok(output.gateVerdict!.reason!.includes("evidence URLs"));
  });

  it("FINAL when all lanes terminal with evidence", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({ id: "t-sogyo-1", assignedWorkerId: "sogyo", status: "succeeded", updatedAt: "2026-05-26T11:30:00.000Z", completedAt: "2026-05-26T11:30:00.000Z", result: makeResult({ output: { prUrl: "https://github.com/o/r/pull/1" } }) }),
      makeTask({ id: "t-bangtong-1", assignedWorkerId: "bangtong", status: "succeeded", updatedAt: "2026-05-26T11:00:00.000Z", completedAt: "2026-05-26T11:00:00.000Z", result: makeResult({ output: { doneCommentUrl: "https://github.com/o/r/issues/1#issuecomment-1" } }) }),
    ];
    const manifest: RoundManifest = { roundLabel: "test", lanes: [{ workerId: "sogyo" }, { workerId: "bangtong" }] };
    const output = collectRoundResults(manifest, tasks, { nowMs });
    equal(output.gateVerdict!.verdict, "FINAL");
    equal(output.gateVerdict!.succeeded, 2);
    equal(output.gateVerdict!.pending, 0);
    equal(output.gateVerdict!.evidenceIdsCitedCount, 2);
    ok(output.gateVerdict!.evidenceIdsCited.includes("t-sogyo-1"));
    ok(output.gateVerdict!.evidenceIdsCited.includes("t-bangtong-1"));
  });

  it("BLOCKED when a terminal lane failed even if another lane succeeded", () => {
    const nowMs = Date.parse("2026-05-26T12:00:00.000Z");
    const tasks: TaskRecord[] = [
      makeTask({ id: "t-sogyo-1", assignedWorkerId: "sogyo", status: "succeeded", updatedAt: "2026-05-26T11:30:00.000Z", result: makeResult({ output: { prUrl: "https://github.com/o/r/pull/1" } }) }),
      makeTask({ id: "t-nosuk-1", assignedWorkerId: "nosuk", status: "failed", updatedAt: "2026-05-26T11:00:00.000Z", completedAt: "2026-05-26T11:00:00.000Z", result: makeResult({ output: { blockCommentUrl: "https://github.com/o/r/issues/1#issuecomment-2" } }) }),
    ];
    const manifest: RoundManifest = { roundLabel: "test", lanes: [{ workerId: "sogyo" }, { workerId: "nosuk" }] };
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
      makeTask({ id: "t-sogyo-1", assignedWorkerId: "sogyo", status: "running", updatedAt: "2026-05-26T11:30:00.000Z" }),
    ];
    const manifest: RoundManifest = { roundLabel: "test", lanes: [{ workerId: "sogyo" }], timeoutAt: "2026-05-26T23:00:00.000Z" };
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
});
