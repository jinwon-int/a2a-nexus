/**
 * round-manifest-resource-policy.test.ts — Combined validation tests
 * that integrate resource-aware worker policy with round manifest and
 * collector snapshots.
 *
 * This is the Team1 A2A round coordinator wiring lane 4/4 for yukson
 * (issue #937).  It covers:
 *
 *   - GO/NO-GO   — resource-aware worker policy evaluation combined with
 *                  round manifest assignments and collector evidence
 *   - Mobile standby/read-only  — mobile/readOnly workers in manifest
 *   - Missing evidence           — succeeded lane with no evidence URLs
 *   - Stale/timeout              — non-terminal lanes past thresholds
 *   - Fail-closed routing        — closeout bundle contains safety
 *                                  disclaimer; no auto-actions asserted
 *
 * All operations are source-only. No broker dispatch, live send, terminal
 * ACK, DB mutation, deploy, or secret movement is attempted.
 *
 * @see Issue #937 — Team1 A2A round coordinator wiring lane 4/4
 * @see resource-aware-worker-policy.ts  — GO/NO-GO evaluation
 * @see round-manifest.ts                — manifest building/validation
 * @see round-result-collector.ts        — collector classification
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateWorkerOnboarding,
  validateResourceAwareWorkerPolicy,
  type ResourceAwareWorkerPolicy,
  type WorkerOnboardingKind,
} from "./resource-aware-worker-policy.js";

import {
  buildRoundManifest,
  type WorkerRoundAssignment,
  type RoundManifestOptions,
  type RoundManifest,
} from "./round-manifest.js";

import {
  collectRoundResults,
  type RoundManifest as CollectorManifest,
  type RoundResultCollectorOutput,
} from "./round-result-collector.js";

import type { TaskRecord, TaskResult, TaskStatus } from "./types.js";

// ---------------------------------------------------------------------------
// Fixture directory
// ---------------------------------------------------------------------------

const __dirname = new URL(".", import.meta.url).pathname;
const FIXTURE_DIR = join(__dirname, "../../fixtures/round-manifest-resource-policy");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parsed fixture structure. */
interface RoundManifestResourcePolicyFixture {
  kind: string;
  version: number;
  generatedAt: string;
  description: string;
  manifest: {
    roundLabel: string;
    lanes: Array<{
      workerId: string;
      description?: string;
      expectedOutcome?: string;
    }>;
    parentIssueUrl?: string;
    staleAfterMs?: number;
    timeoutAt?: string;
    excludedWorkerIds?: string[];
  };
  workerPolicy?: ResourceAwareWorkerPolicy;
  workerPolicies?: Record<string, ResourceAwareWorkerPolicy>;
  onboardingKind?: WorkerOnboardingKind;
  evaluations?: Record<string, { onboardingKind: WorkerOnboardingKind; decision: string }>;
  evaluation?: {
    decision: string;
    reasons: string[];
  };
  blockedBy?: string[];
  resolution?: string;
  collectorTasks?: Array<{
    id: string;
    assignedWorkerId: string;
    status: TaskStatus;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
    result?: TaskResult;
    error?: { message: string; code?: string };
  }>;
  collectorNow?: string;
  expectedCollectorState?: string;
  expectedOutcomeClass?: string | null;
  expectedEvidenceUrls?: number;
  expectedAgeMs?: number;
  expectedSummary?: {
    totalLanes: number;
    completed: number;
    pending: number;
    running: number;
    stale: number;
    timeout: number;
    blocked: number;
  };
  expectedCloseoutContains?: string[];
  boundaries: Record<string, boolean>;
}

function makeTask(overrides: Record<string, unknown>): TaskRecord {
  const defaults: TaskRecord = {
    id: "task-default",
    intent: "analyze",
    status: "queued",
    targetNodeId: "default",
    assignedWorkerId: "unknown",
    requester: { id: "broker", kind: "service" },
    target: { id: "default", kind: "node" },
    payload: {},
    createdAt: "2026-05-26T10:00:00.000Z",
    updatedAt: "2026-05-26T10:00:00.000Z",
  };
  return { ...defaults, ...overrides } as TaskRecord;
}

function loadAllFixtures(): RoundManifestResourcePolicyFixture[] {
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));
  return files.map((f) => {
    const content = readFileSync(join(FIXTURE_DIR, f), "utf-8");
    return JSON.parse(content) as RoundManifestResourcePolicyFixture;
  });
}

function buildCollectorManifest(
  fix: RoundManifestResourcePolicyFixture,
): CollectorManifest {
  return {
    roundLabel: fix.manifest.roundLabel,
    parentIssueUrl: fix.manifest.parentIssueUrl,
    lanes: fix.manifest.lanes.map((lane) => ({
      workerId: lane.workerId,
      description: lane.description,
      expectedOutcome: lane.expectedOutcome as "patch" | "evidence-only" | "analysis" | "review" | undefined,
    })),
    staleAfterMs: fix.manifest.staleAfterMs,
    timeoutAt: fix.manifest.timeoutAt,
    excludedWorkerIds: fix.manifest.excludedWorkerIds,
  };
}

function buildCollectorTasks(
  fix: RoundManifestResourcePolicyFixture,
): TaskRecord[] {
  if (!fix.collectorTasks) return [];
  return fix.collectorTasks.map((t) => makeTask(t));
}

function getCollectorNow(fix: RoundManifestResourcePolicyFixture): number {
  if (fix.collectorNow) return Date.parse(fix.collectorNow);
  return Date.parse(fix.generatedAt);
}

// ---------------------------------------------------------------------------
// Combined validation tests
// ---------------------------------------------------------------------------

describe("round-manifest-resource-policy combined validation", () => {
  // ── 1. GO/NO-GO: Daegyo-style worker ─────────────────────────────────
  describe("GO/NO-GO evaluation with round manifest", () => {
    it("GO: Daegyo-style gateway worker — policy valid and collector succeeded", () => {
      const fixture = JSON.parse(
        readFileSync(join(FIXTURE_DIR, "daegyo-go.json"), "utf-8"),
      ) as RoundManifestResourcePolicyFixture;

      // 1a. Evaluate resource-aware worker policy
      const evaluation = evaluateWorkerOnboarding(
        fixture.onboardingKind!,
        fixture.workerPolicy!,
      );
      assert.equal(evaluation.decision, "go", "GO decision expected for valid Daegyo policy");
      assert.ok(evaluation.reasons.some((r) => r.includes("passed")));
      assert.ok(evaluation.validation.ok);

      // 1b. Build round manifest from fixture lanes
      const workerAssignments: WorkerRoundAssignment[] = fixture.manifest.lanes.map((lane) => ({
        workerId: lane.workerId,
        taskDescription: lane.description,
        resourcePolicy: {
          maxConcurrency: fixture.workerPolicy!.maxConcurrent,
          allowedTaskTypes: fixture.workerPolicy!.allowedTaskTypes,
          noLive: fixture.workerPolicy!.noLiveSend,
          noMutation: fixture.workerPolicy!.noMutation,
          mobileStandby: fixture.workerPolicy!.mobileLowPower,
        },
      }));
      const manifestOptions: RoundManifestOptions = {
        parentRepo: "jinwon-int/a2a-broker",
        parentIssueNumber: 937,
        teamId: "team1",
        runId: "a2a-team1-round-coordinator-wiring-20260526T233544KST",
        roundLabel: fixture.manifest.roundLabel,
        expectedWorkers: workerAssignments,
        generatedAt: fixture.generatedAt,
      };
      const roundManifest = buildRoundManifest(manifestOptions);
      assert.ok(roundManifest.manifestId);
      assert.equal(roundManifest.expectedWorkers.length, 1);

      // Verify resource policy was preserved in the manifest
      const worker = roundManifest.expectedWorkers[0]!;
      assert.ok(worker.resourcePolicy);
      assert.equal(worker.resourcePolicy?.noLive, fixture.workerPolicy!.noLiveSend);
      assert.equal(
        worker.resourcePolicy?.mobileStandby,
        fixture.workerPolicy!.mobileLowPower,
      );

      // 1c. Run collector with task snapshots
      const collectorManifest = buildCollectorManifest(fixture);
      const tasks = buildCollectorTasks(fixture);
      const nowMs = getCollectorNow(fixture);
      const output = collectRoundResults(collectorManifest, tasks, { nowMs });

      // 1d. Verify collector classification
      const lane = output.lanes.find((l) => l.workerId === "yukson")!;
      assert.ok(lane, "yukson lane should exist");
      assert.equal(lane.laneState, "succeeded");
      assert.equal(lane.outcomeClass, "pr_success");
      assert.ok(lane.prUrl?.includes("jinwon-int/a2a-broker/pull/937"));
      assert.equal(lane.evidenceUrls.length, 1);
      assert.equal(output.summary.totalLanes, 1);
      assert.equal(output.summary.completed, 1);
    });

    it("NO-GO: Hermes worker with contradictory policy — evaluation returns no-go", () => {
      const fixture = JSON.parse(
        readFileSync(join(FIXTURE_DIR, "hermes-readonly-no-go.json"), "utf-8"),
      ) as RoundManifestResourcePolicyFixture;

      // 1a. Evaluate resource policy — should be NO-GO
      const evaluation = evaluateWorkerOnboarding(
        fixture.onboardingKind!,
        fixture.workerPolicy!,
      );
      assert.equal(evaluation.decision, "no-go");
      assert.ok(evaluation.reasons.some((r) => r.includes("readOnly=true")));
      assert.ok(evaluation.reasons.some((r) => r.includes("noMutation")));
      assert.ok(!evaluation.validation.ok);

      // 1b. Manifest can still be built (validation is not at manifest level)
      const workerAssignments: WorkerRoundAssignment[] = fixture.manifest.lanes.map((lane) => ({
        workerId: lane.workerId,
        taskDescription: lane.description,
        resourcePolicy: {
          allowedTaskTypes: fixture.workerPolicy!.allowedTaskTypes,
          noLive: fixture.workerPolicy!.noLiveSend,
          noMutation: fixture.workerPolicy!.noMutation,
          mobileStandby: fixture.workerPolicy!.mobileLowPower,
        },
      }));
      const roundManifest = buildRoundManifest({
        parentRepo: "jinwon-int/a2a-broker",
        parentIssueNumber: 937,
        teamId: "team1",
        runId: "a2a-team1-round-coordinator-wiring-20260526T233544KST",
        roundLabel: fixture.manifest.roundLabel,
        expectedWorkers: workerAssignments,
        generatedAt: fixture.generatedAt,
      });
      assert.ok(roundManifest.manifestId);

      // 1c. Collector snapshot — task was blocked
      const collectorManifest = buildCollectorManifest(fixture);
      const tasks = buildCollectorTasks(fixture);
      const nowMs = getCollectorNow(fixture);
      const output = collectRoundResults(collectorManifest, tasks, { nowMs });

      const lane = output.lanes.find((l) => l.workerId === "yukson")!;
      assert.ok(lane);
      assert.equal(lane.laneState, "blocked");
      assert.equal(lane.outcomeClass, "no_change_block");
      assert.ok(lane.blockUrl?.includes("issuecomment-2"));
    });
  });

  // ── 2. Mobile standby/read-only ────────────────────────────────────
  describe("mobile standby/read-only workers", () => {
    it("Mobile standby readOnly worker succeeds with done evidence", () => {
      const fixture = JSON.parse(
        readFileSync(join(FIXTURE_DIR, "mobile-standby-succeeded.json"), "utf-8"),
      ) as RoundManifestResourcePolicyFixture;

      // Evaluate the mobile policy
      const evaluation = evaluateWorkerOnboarding(
        fixture.onboardingKind!,
        fixture.workerPolicy!,
      );
      assert.equal(evaluation.decision, "go");
      assert.ok(evaluation.validation.ok);
      assert.equal(evaluation.policy.mobileLowPower, true);
      assert.equal(evaluation.policy.readOnly, true);
      assert.equal(evaluation.policy.noLiveSend, true);
      assert.equal(evaluation.policy.noMutation, true);

      // Build manifest with mobile resource policy
      const worker: WorkerRoundAssignment = {
        workerId: "yukson",
        taskDescription: "Mobile standby validation",
        resourcePolicy: {
          maxConcurrency: 1,
          allowedTaskTypes: fixture.workerPolicy!.allowedTaskTypes,
          noLive: fixture.workerPolicy!.noLiveSend,
          noMutation: fixture.workerPolicy!.noMutation,
          mobileStandby: fixture.workerPolicy!.mobileLowPower,
        },
      };
      const roundManifest = buildRoundManifest({
        parentRepo: "jinwon-int/a2a-broker",
        parentIssueNumber: 937,
        teamId: "team1",
        runId: "a2a-team1-round-coordinator-wiring-20260526T233544KST",
        roundLabel: fixture.manifest.roundLabel,
        expectedWorkers: [worker],
        generatedAt: fixture.generatedAt,
      });
      const projected = roundManifest.expectedWorkers[0]!;
      assert.equal(projected.resourcePolicy?.mobileStandby, true);
      assert.equal(projected.resourcePolicy?.noLive, true);
      assert.equal(projected.resourcePolicy?.noMutation, true);

      // Collector snapshot
      const collectorManifest = buildCollectorManifest(fixture);
      const tasks = buildCollectorTasks(fixture);
      const nowMs = getCollectorNow(fixture);
      const output = collectRoundResults(collectorManifest, tasks, { nowMs });

      const lane = output.lanes.find((l) => l.workerId === "yukson")!;
      assert.ok(lane);
      assert.equal(lane.laneState, "succeeded");
      assert.equal(lane.outcomeClass, "no_change_done");
      assert.ok(lane.doneUrl?.includes("issuecomment-1"));
    });
  });

  // ── 3. Missing evidence ────────────────────────────────────────────
  describe("missing evidence detection", () => {
    it("succeeded lane with no evidence URLs surfaces zero evidence", () => {
      const fixture = JSON.parse(
        readFileSync(join(FIXTURE_DIR, "missing-evidence.json"), "utf-8"),
      ) as RoundManifestResourcePolicyFixture;

      const collectorManifest = buildCollectorManifest(fixture);
      const tasks = buildCollectorTasks(fixture);
      const nowMs = getCollectorNow(fixture);
      const output = collectRoundResults(collectorManifest, tasks, { nowMs });

      const lane = output.lanes.find((l) => l.workerId === "yukson")!;
      assert.ok(lane);
      assert.equal(lane.laneState, "succeeded");
      assert.equal(lane.evidenceUrls.length, 0);
      assert.equal(lane.prUrl, undefined);
      assert.equal(lane.doneUrl, undefined);
      assert.equal(lane.blockUrl, undefined);
      assert.equal(output.summary.evidenceUrls, 0);
      assert.equal(lane.outcomeClass, undefined);
    });
  });

  // ── 4. Stale/timeout ──────────────────────────────────────────────
  describe("stale/timeout classification", () => {
    it("classifies mobile worker as stale when past stale threshold", () => {
      const fixture = JSON.parse(
        readFileSync(join(FIXTURE_DIR, "stale-mobile-worker.json"), "utf-8"),
      ) as RoundManifestResourcePolicyFixture;

      const collectorManifest = buildCollectorManifest(fixture);
      const tasks = buildCollectorTasks(fixture);
      const nowMs = getCollectorNow(fixture);
      const output = collectRoundResults(collectorManifest, tasks, { nowMs });

      const lane = output.lanes.find((l) => l.workerId === "yukson")!;
      assert.ok(lane);
      assert.equal(lane.laneState, "stale");
      assert.ok(lane.ageMs! >= 30 * 60 * 1000);
      assert.equal(output.staleLanes.length, 1);
      assert.ok(output.staleLanes.includes("yukson"));
      assert.ok(output.closeoutBundle.body.includes("⚠️"));
    });

    it("classifies worker as timeout past round deadline", () => {
      const fixture = JSON.parse(
        readFileSync(join(FIXTURE_DIR, "timeout-worker.json"), "utf-8"),
      ) as RoundManifestResourcePolicyFixture;

      const collectorManifest = buildCollectorManifest(fixture);
      const tasks = buildCollectorTasks(fixture);
      const nowMs = getCollectorNow(fixture);
      const output = collectRoundResults(collectorManifest, tasks, { nowMs });

      const lane = output.lanes.find((l) => l.workerId === "yukson")!;
      assert.ok(lane);
      assert.equal(lane.laneState, "timeout");
      assert.equal(output.timeoutLanes.length, 1);
      assert.ok(output.timeoutLanes.includes("yukson"));
      assert.ok(output.closeoutBundle.body.includes("⏰"));
    });
  });

  // ── 5. Fail-closed routing evidence ───────────────────────────────
  describe("fail-closed routing evidence", () => {
    it("closeout bundle contains safety disclaimer and no auto-action assertions", () => {
      const fixture = JSON.parse(
        readFileSync(join(FIXTURE_DIR, "fail-closed-evidence.json"), "utf-8"),
      ) as RoundManifestResourcePolicyFixture;

      // Evaluate all workers' policies
      for (const [workerId, policy] of Object.entries(fixture.workerPolicies!)) {
        const evalInfo = fixture.evaluations![workerId];
        const evaluation = evaluateWorkerOnboarding(evalInfo.onboardingKind, policy);
        assert.equal(evaluation.decision, evalInfo.decision,
          `Worker ${workerId} should have decision ${evalInfo.decision}`);
      }

      const collectorManifest = buildCollectorManifest(fixture);
      const tasks = buildCollectorTasks(fixture);
      const nowMs = getCollectorNow(fixture);
      const output = collectRoundResults(collectorManifest, tasks, { nowMs });

      // Verify summary
      assert.equal(output.summary.totalLanes, fixture.expectedSummary!.totalLanes);
      assert.equal(output.summary.completed, fixture.expectedSummary!.completed);
      assert.equal(output.summary.pending, fixture.expectedSummary!.pending);
      assert.equal(output.summary.stale, fixture.expectedSummary!.stale);

      // Verify output fields
      assert.equal(output.kind, "a2a-broker.round-result-collector.projection");
      assert.equal(output.version, 1);
      assert.ok(output.approvalSensitiveActionsExcluded.length > 0);

      // Verify closeout bundle contains fail-closed language
      const body = output.closeoutBundle.body;
      for (const expected of fixture.expectedCloseoutContains!) {
        assert.ok(body.includes(expected),
          `Closeout bundle should contain: "${expected}"`);
      }

      // Verify title includes "needs review" because stale+missing lanes exist
      assert.ok(output.closeoutBundle.title.includes("needs review"));

      // Verify lane states
      const laneYukson = output.lanes.find((l) => l.workerId === "yukson")!;
      assert.equal(laneYukson.laneState, "succeeded");
      assert.ok(laneYukson.prUrl?.includes("jinwon-int/a2a-broker/pull/937"));

      const laneSogyo = output.lanes.find((l) => l.workerId === "sogyo")!;
      assert.equal(laneSogyo.laneState, "pending");
      assert.equal(laneSogyo.evidenceUrls.length, 0);

      const laneNosuk = output.lanes.find((l) => l.workerId === "nosuk")!;
      assert.equal(laneNosuk.laneState, "stale");

      // Verify missing/stale/timeout/blocked arrays
      assert.ok(output.missingLanes.includes("sogyo"));
      assert.ok(output.staleLanes.includes("nosuk"));
      assert.equal(output.timeoutLanes.length, 0);
      assert.equal(output.blockedLanes.length, 0);
    });
  });
});

// ---------------------------------------------------------------------------
// Fixture integrity checks
// ---------------------------------------------------------------------------

describe("fixture integrity", () => {
  it("all fixture files are valid JSON", () => {
    const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));
    assert.ok(files.length > 0, "should have at least one fixture");
    for (const file of files) {
      const content = readFileSync(join(FIXTURE_DIR, file), "utf-8");
      const parsed = JSON.parse(content) as Record<string, unknown>;
      assert.equal(parsed.kind, "a2a-broker.round-manifest-resource-policy.fixture");
      assert.equal(parsed.version, 1);
      assert.ok(parsed.boundaries);
    }
  });

  it("all fixtures declare sourceOnly = true boundaries", () => {
    const fixtures = loadAllFixtures();
    for (const f of fixtures) {
      assert.equal(
        f.boundaries.sourceOnly,
        true,
        `Fixture "${f.description}" must declare sourceOnly=true boundaries`,
      );
      assert.equal(
        f.boundaries.liveHostProbe,
        false,
        `Fixture "${f.description}" must not probe live host`,
      );
      assert.equal(
        f.boundaries.brokerDispatch,
        false,
        "Must not dispatch broker work",
      );
      assert.equal(
        f.boundaries.providerSend,
        false,
        "Must not send provider messages",
      );
      assert.equal(
        f.boundaries.terminalAckOrReplay,
        false,
        "Must not ACK/replay terminal messages",
      );
      assert.equal(
        f.boundaries.dbMutation,
        false,
        "Must not mutate DB",
      );
    }
  });

  it("can load all fixtures without error", () => {
    const fixtures = loadAllFixtures();
    assert.ok(fixtures.length >= 7, "should have at least 7 fixture files");
  });

  it("each fixture has a unique description", () => {
    const fixtures = loadAllFixtures();
    const descriptions = fixtures.map((f) => f.description);
    const unique = new Set(descriptions);
    assert.equal(unique.size, descriptions.length, "descriptions should be unique");
  });
});

// ---------------------------------------------------------------------------
// Combined worker manifest builder test
// ---------------------------------------------------------------------------

describe("combined integration: resource policy → manifest → collector", () => {
  it("builds a complete pipeline: evaluate → manifest → collector", () => {
    // Step 1: Define a resource-aware worker policy
    const policy: ResourceAwareWorkerPolicy = {
      allowedTaskTypes: ["propose_patch", "analyze"],
      noLiveSend: false,
      noMutation: false,
      gatewayRequired: true,
      mobileLowPower: false,
      standby: false,
      readOnly: false,
      maxConcurrent: 3,
    };

    // Step 2: Evaluate GO/NO-GO
    const evaluation = evaluateWorkerOnboarding("standard-gateway", policy);
    assert.equal(evaluation.decision, "go");
    assert.ok(evaluation.validation.ok);

    // Step 3: Build round manifest with the evaluated worker
    const worker: WorkerRoundAssignment = {
      workerId: "yukson",
      lane: 1,
      taskDescription: "Combined pipeline validation",
      evidencePolicy: { requiredTypes: ["pr"], minimumRequired: 1 },
      resourcePolicy: {
        maxConcurrency: policy.maxConcurrent,
        allowedTaskTypes: policy.allowedTaskTypes,
        noLive: policy.noLiveSend,
        noMutation: policy.noMutation,
      },
    };

    const manifest = buildRoundManifest({
      parentRepo: "jinwon-int/a2a-broker",
      parentIssueNumber: 937,
      teamId: "team1",
      runId: "a2a-team1-round-coordinator-wiring-20260526T233544KST",
      roundLabel: "a2a-team1-round-coordinator-wiring-collector-test",
      expectedWorkers: [worker],
      closeoutPolicy: {
        automaticCloseout: false,
        automaticFinalizer: false,
        requireAllWorkersComplete: true,
      },
      generatedAt: "2026-05-26T20:11:40.000Z",
    });

    assert.ok(manifest.manifestId);
    assert.equal(manifest.expectedWorkers.length, 1);
    assert.equal(manifest.closeoutPolicy.automaticCloseout, false);
    assert.equal(manifest.closeoutPolicy.automaticFinalizer, false);

    // Step 4: Create collector manifest and run
    const collectorManifest: CollectorManifest = {
      roundLabel: manifest.roundLabel ?? "test",
      lanes: manifest.expectedWorkers.map((w) => ({
        workerId: w.workerId,
        description: w.taskDescription,
      })),
    };

    const tasks: TaskRecord[] = [
      {
        id: "task-combined-1",
        intent: "propose_patch",
        status: "succeeded",
        targetNodeId: "default",
        assignedWorkerId: "yukson",
        requester: { id: "broker", kind: "service" },
        target: { id: "default", kind: "node" },
        payload: {},
        createdAt: "2026-05-26T19:00:00.000Z",
        updatedAt: "2026-05-26T20:00:00.000Z",
        completedAt: "2026-05-26T20:00:00.000Z",
        result: {
          summary: "PR created with combined validation",
          output: {
            prUrl: "https://github.com/jinwon-int/a2a-broker/pull/937",
            testSummary: "All 38 combined tests pass",
          },
        },
      },
    ];

    const output = collectRoundResults(collectorManifest, tasks, {
      nowMs: Date.parse("2026-05-26T20:11:40.000Z"),
    });

    // Step 5: Verify collector output
    assert.equal(output.summary.completed, 1);
    assert.equal(output.summary.totalLanes, 1);
    assert.equal(output.lanes[0]!.laneState, "succeeded");
    assert.equal(output.lanes[0]!.outcomeClass, "pr_success");
    assert.ok(output.lanes[0]!.prUrl?.includes("pull/937"));
    assert.equal(output.lanes[0]!.testSummary, "All 38 combined tests pass");

    // Verify fail-closed routing evidence in closeout bundle
    assert.ok(output.closeoutBundle.body.includes("draft-only closeout bundle"));
    assert.ok(output.closeoutBundle.body.includes("No comments, closes, merges"));
    assert.ok(output.approvalSensitiveActionsExcluded.length > 0);

    // Verify manifest resource policy round-trips through projection
    assert.equal(manifest.expectedWorkers[0]!.resourcePolicy?.maxConcurrency, 3);
    assert.deepEqual(manifest.expectedWorkers[0]!.resourcePolicy?.allowedTaskTypes, [
      "propose_patch",
      "analyze",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Policy validation contradictions in manifest context
// ---------------------------------------------------------------------------

describe("policy contradictions surfaced in manifest context", () => {
  it("rejects contradicting readOnly + noMutation=false in evaluation", () => {
    const policy: ResourceAwareWorkerPolicy = {
      allowedTaskTypes: ["analyze"],
      noLiveSend: false,
      noMutation: false,
      gatewayRequired: false,
      mobileLowPower: false,
      standby: false,
      readOnly: true, // requires noMutation=true and noLiveSend=true
    };

    const validation = validateResourceAwareWorkerPolicy(policy);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((e) => e.includes("requires noMutation=true")));
    assert.ok(validation.errors.some((e) => e.includes("requires noLiveSend=true")));

    // NO-GO for any onboarding kind
    const ev = evaluateWorkerOnboarding("generic-terms", policy);
    assert.equal(ev.decision, "no-go");
  });

  it("rejects noMutation with apply_local_change task type", () => {
    const policy: ResourceAwareWorkerPolicy = {
      allowedTaskTypes: ["apply_local_change", "analyze"],
      noLiveSend: true,
      noMutation: true, // contradicts apply_local_change
      gatewayRequired: false,
      mobileLowPower: false,
      standby: false,
      readOnly: false,
    };

    const validation = validateResourceAwareWorkerPolicy(policy);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((e) => e.includes("noMutation=true") && e.includes("apply_local_change")));
  });

  it("rejects gatewayRequired + mobileLowPower contradiction", () => {
    const policy: ResourceAwareWorkerPolicy = {
      allowedTaskTypes: ["analyze"],
      noLiveSend: true,
      noMutation: true,
      gatewayRequired: true,
      mobileLowPower: true, // contradiction with gatewayRequired
      standby: false,
      readOnly: true,
    };

    const validation = validateResourceAwareWorkerPolicy(policy);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((e) => e.includes("contradictory")));
  });

  it("rejects mobileLowPower with high maxConcurrent", () => {
    const policy: ResourceAwareWorkerPolicy = {
      allowedTaskTypes: ["analyze"],
      noLiveSend: true,
      noMutation: true,
      gatewayRequired: false,
      mobileLowPower: true,
      standby: false,
      readOnly: true,
      maxConcurrent: 5, // > 2, contradiction with mobileLowPower
    };

    const validation = validateResourceAwareWorkerPolicy(policy);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((e) => e.includes("maxConcurrent to 2")));
  });

  it("rejects standby with positive maxConcurrent", () => {
    const policy: ResourceAwareWorkerPolicy = {
      allowedTaskTypes: ["analyze"],
      noLiveSend: true,
      noMutation: true,
      gatewayRequired: false,
      mobileLowPower: false,
      standby: true,
      readOnly: false,
      maxConcurrent: 3,
    };

    const validation = validateResourceAwareWorkerPolicy(policy);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((e) => e.includes("standby")));
  });
});

// ---------------------------------------------------------------------------
// End-to-end dry run suppression
// ---------------------------------------------------------------------------

describe("fail-closed dry-run safety", () => {
  it("collector output lists approval-sensitive excluded actions", () => {
    const output = collectRoundResults(
      { roundLabel: "safety-test", lanes: [] },
      [],
      { nowMs: Date.parse("2026-05-26T20:00:00.000Z") },
    );

    const excluded = output.approvalSensitiveActionsExcluded;
    assert.ok(excluded.some((a) => a.toLowerCase().includes("merge")));
    assert.ok(excluded.some((a) => a.toLowerCase().includes("live")));
    assert.ok(excluded.some((a) => a.toLowerCase().includes("ack")));
    assert.ok(excluded.some((a) => a.toLowerCase().includes("restart")));
    assert.ok(excluded.some((a) => a.toLowerCase().includes("mutation")));
    assert.ok(excluded.some((a) => a.toLowerCase().includes("replay")));
    assert.ok(excluded.some((a) => a.toLowerCase().includes("publish")));
    assert.ok(excluded.some((a) => a.toLowerCase().includes("secret")));
  });
});
