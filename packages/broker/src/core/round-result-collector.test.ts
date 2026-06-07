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
