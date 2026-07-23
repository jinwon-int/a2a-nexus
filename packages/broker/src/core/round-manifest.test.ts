/**
 * Round Manifest tests (issue #928).
 *
 * Covers: schema/type compliance, deterministic id/checksum, worker/deadline/
 * evidence field handling, validation, read projection, and markdown rendering.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ROUND_MANIFEST_KIND,
  ROUND_MANIFEST_VERSION,
  buildRoundManifest,
  computeManifestChecksum,
  validateRoundManifestOptions,
  validateWorkerAssignment,
  renderRoundManifestMarkdown,
  projectRoundManifest,
  ROUND_EVIDENCE_TYPE_LABELS,
  ROUND_MANIFEST_MAX_WORKERS,
  DEFAULT_ROUND_STALE_AFTER_MS,
  DEFAULT_ROUND_TIMEOUT_AFTER_MS,
  type RoundManifest,
  type RoundManifestOptions,
  type WorkerRoundAssignment,
} from "./round-manifest.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = "2026-05-26T20:11:40.000Z";
const NOW_MS = Date.parse(NOW);

const BASE_WORKERS: WorkerRoundAssignment[] = [
  { workerId: "workergamma", lane: 1, taskDescription: "Round manifest foundation" },
  { workerId: "workerepsilon", lane: 2, taskDescription: "Result collector projection" },
  { workerId: "workerbeta", lane: 3, taskDescription: "Deadline/stale detection" },
  { workerId: "workeralpha", lane: 4, taskDescription: "Closeout bundle generation" },
];

const BASE_OPTIONS: RoundManifestOptions = {
  parentRepo: "jinwon-int/a2a-broker",
  parentIssueNumber: 927,
  teamId: "team1",
  runId: "a2a-round-20260526T201140KST",
  roundLabel: "a2a-hardening-r1",
  expectedWorkers: BASE_WORKERS,
  generatedAt: NOW,
};

function buildBaseManifest(): RoundManifest {
  return buildRoundManifest(BASE_OPTIONS);
}

// ---------------------------------------------------------------------------
// Schema/type compliance
// ---------------------------------------------------------------------------

describe("RoundManifest schema", () => {
  it("has the correct kind and version", () => {
    const manifest = buildBaseManifest();
    assert.equal(manifest.kind, ROUND_MANIFEST_KIND);
    assert.equal(manifest.version, ROUND_MANIFEST_VERSION);
    assert.equal(manifest.kind, "a2a-broker.round-manifest");
    assert.equal(manifest.version, 1);
  });

  it("reflects the input fields", () => {
    const manifest = buildBaseManifest();
    assert.equal(manifest.roundLabel, "a2a-hardening-r1");
    assert.equal(manifest.parentIssue.repo, "jinwon-int/a2a-broker");
    assert.equal(manifest.parentIssue.issueNumber, 927);
    assert.equal(manifest.parentIssue.issueUrl, "https://github.com/jinwon-int/a2a-broker/issues/927");
    assert.equal(manifest.teamId, "team1");
    assert.equal(manifest.runId, "a2a-round-20260526T201140KST");
    assert.equal(manifest.generatedAt, NOW);
  });

  it("has the expected workers in lane order", () => {
    const manifest = buildBaseManifest();
    assert.equal(manifest.expectedWorkers.length, 4);
    assert.equal(manifest.expectedWorkers[0].workerId, "workergamma");
    assert.equal(manifest.expectedWorkers[0].lane, 1);
    assert.equal(manifest.expectedWorkers[1].workerId, "workerepsilon");
    assert.equal(manifest.expectedWorkers[1].lane, 2);
    assert.equal(manifest.expectedWorkers[2].workerId, "workerbeta");
    assert.equal(manifest.expectedWorkers[2].lane, 3);
    assert.equal(manifest.expectedWorkers[3].workerId, "workeralpha");
    assert.equal(manifest.expectedWorkers[3].lane, 4);
  });

  it("defaults closeoutPolicy to fail-closed (no automatic actions)", () => {
    const manifest = buildBaseManifest();
    assert.equal(manifest.closeoutPolicy.automaticCloseout, false);
    assert.equal(manifest.closeoutPolicy.automaticFinalizer, false);
    assert.equal(manifest.closeoutPolicy.requireAllWorkersComplete, true);
    assert.equal(manifest.closeoutPolicy.timeoutOnDeadlineExceeded, false);
  });

  it("accepts worker resource policy fields", () => {
    const workerWithPolicy: WorkerRoundAssignment = {
      workerId: "mobilebeta",
      lane: 5,
      resourcePolicy: {
        maxConcurrency: 2,
        allowedTaskTypes: ["propose_patch", "analyze"],
        noLive: true,
        noMutation: true,
        mobileStandby: true,
      },
    };
    const manifest = buildRoundManifest({
      ...BASE_OPTIONS,
      expectedWorkers: [...BASE_WORKERS, workerWithPolicy],
    });
    const mobilebeta = manifest.expectedWorkers.find((w) => w.workerId === "mobilebeta")!;
    assert.equal(mobilebeta.resourcePolicy?.maxConcurrency, 2);
    assert.deepEqual(mobilebeta.resourcePolicy?.allowedTaskTypes, ["propose_patch", "analyze"]);
    assert.equal(mobilebeta.resourcePolicy?.noLive, true);
    assert.equal(mobilebeta.resourcePolicy?.mobileStandby, true);
  });
});

// ---------------------------------------------------------------------------
// Deterministic id and checksum
// ---------------------------------------------------------------------------

describe("deterministic id and checksum", () => {
  it("produces identical manifestId for identical inputs", () => {
    const a = buildBaseManifest();
    const b = buildBaseManifest();
    assert.equal(a.manifestId, b.manifestId);
    assert.equal(a.manifestChecksum, b.manifestChecksum);
  });

  it("produces different manifestId when runId changes", () => {
    const a = buildBaseManifest();
    const b = buildRoundManifest({ ...BASE_OPTIONS, runId: "a2a-round-20260527T000000Z" });
    assert.notEqual(a.manifestId, b.manifestId);
  });

  it("produces different manifestId when teamId changes", () => {
    const a = buildBaseManifest();
    const b = buildRoundManifest({ ...BASE_OPTIONS, teamId: "team2" });
    assert.notEqual(a.manifestId, b.manifestId);
  });

  it("produces different manifestId when expectedWorkers change", () => {
    const a = buildBaseManifest();
    const b = buildRoundManifest({
      ...BASE_OPTIONS,
      expectedWorkers: [{ workerId: "workergamma", lane: 1 }],
    });
    assert.notEqual(a.manifestId, b.manifestId);
  });

  it("produces same manifestChecksum when metadata is unchanged", () => {
    const a = buildBaseManifest();
    const b = buildBaseManifest();
    assert.equal(a.manifestChecksum, b.manifestChecksum);
  });

  it("checksum is 32 hex characters", () => {
    const manifest = buildBaseManifest();
    assert.match(manifest.manifestChecksum, /^[0-9a-f]{32}$/);
    assert.match(manifest.manifestId, /^[0-9a-f]{32}$/);
  });

  it("manifestId differs from manifestChecksum", () => {
    const manifest = buildBaseManifest();
    assert.notEqual(manifest.manifestId, manifest.manifestChecksum);
  });

  it("computeManifestChecksum is deterministic", () => {
    const body = { kind: "a2a-broker.round-manifest", version: 1, teamId: "team1" };
    const a = computeManifestChecksum(body);
    const b = computeManifestChecksum(body);
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{32}$/);
  });
});

// ---------------------------------------------------------------------------
// Worker assignment validation
// ---------------------------------------------------------------------------

describe("worker assignment validation", () => {
  it("passes for a valid worker", () => {
    const issues = validateWorkerAssignment({ workerId: "workergamma", lane: 1 }, 0);
    assert.deepEqual(issues, []);
  });

  it("rejects empty workerId", () => {
    const issues = validateWorkerAssignment({ workerId: "" }, 0);
    assert(issues.length > 0);
    assert(issues[0].includes("workerId"));
  });

  it("rejects whitespace workerId", () => {
    const issues = validateWorkerAssignment({ workerId: "   " }, 0);
    assert(issues.length > 0);
  });

  it("rejects non-integer lane", () => {
    const issues = validateWorkerAssignment(
      { workerId: "workergamma", lane: 0 as unknown as number },
      0,
    );
    assert(issues.length > 0);
    assert(issues[0].includes("lane"));
  });

  it("rejects past deadline when nowMs is given", () => {
    const issues = validateWorkerAssignment(
      { workerId: "workergamma", deadlineAt: "2020-01-01T00:00:00.000Z" },
      0,
      NOW_MS,
    );
    assert(issues.length > 0);
    assert(issues[0].includes("deadlineAt"));
    assert(issues[0].includes("past"));
  });

  it("accepts future deadline", () => {
    const issues = validateWorkerAssignment(
      { workerId: "workergamma", deadlineAt: "2026-06-01T00:00:00.000Z" },
      0,
      NOW_MS,
    );
    assert.deepEqual(issues, []);
  });

  it("rejects invalid evidence type", () => {
    const issues = validateWorkerAssignment(
      {
        workerId: "workergamma",
        evidencePolicy: { requiredTypes: ["invalid_type" as "pr"] },
      },
      0,
    );
    assert(issues.length > 0);
    assert(issues[0].includes("invalid_type"));
  });

  it("rejects evidencePolicy with empty requiredTypes", () => {
    const issues = validateWorkerAssignment(
      {
        workerId: "workergamma",
        evidencePolicy: { requiredTypes: [] },
      },
      0,
    );
    assert(issues.length > 0);
    assert(issues[0].includes("requiredTypes"));
  });

  it("rejects minimumRequired outside 1–5 range", () => {
    const issues = validateWorkerAssignment(
      {
        workerId: "workergamma",
        evidencePolicy: { requiredTypes: ["pr"], minimumRequired: 6 },
      },
      0,
    );
    assert(issues.length > 0);
    assert(issues[0].includes("minimumRequired"));
  });
});

// ---------------------------------------------------------------------------
// Round manifest options validation
// ---------------------------------------------------------------------------

describe("round manifest options validation", () => {
  it("passes for valid base options", () => {
    const issues = validateRoundManifestOptions(BASE_OPTIONS);
    assert.deepEqual(issues, []);
  });

  it("rejects missing parentRepo", () => {
    const issues = validateRoundManifestOptions({ ...BASE_OPTIONS, parentRepo: "" });
    assert(issues.some((i) => i.includes("parentRepo")));
  });

  it("rejects malformed parentRepo (no slash)", () => {
    const issues = validateRoundManifestOptions({ ...BASE_OPTIONS, parentRepo: "justname" });
    assert(issues.some((i) => i.includes("parentRepo")));
  });

  it("rejects non-integer parentIssueNumber", () => {
    const issues = validateRoundManifestOptions({
      ...BASE_OPTIONS,
      parentIssueNumber: -1,
    });
    assert(issues.some((i) => i.includes("parentIssueNumber")));
  });

  it("rejects missing teamId", () => {
    const issues = validateRoundManifestOptions({ ...BASE_OPTIONS, teamId: "" });
    assert(issues.some((i) => i.includes("teamId")));
  });

  it("rejects missing runId", () => {
    const issues = validateRoundManifestOptions({ ...BASE_OPTIONS, runId: "" });
    assert(issues.some((i) => i.includes("runId")));
  });

  it("rejects empty expectedWorkers", () => {
    const issues = validateRoundManifestOptions({ ...BASE_OPTIONS, expectedWorkers: [] });
    assert(issues.some((i) => i.includes("expectedWorkers")));
  });

  it("rejects too many workers (above MAX)", () => {
    const manyWorkers: WorkerRoundAssignment[] = [];
    for (let i = 1; i <= ROUND_MANIFEST_MAX_WORKERS + 1; i++) {
      manyWorkers.push({ workerId: `w${i}`, lane: i });
    }
    const issues = validateRoundManifestOptions({ ...BASE_OPTIONS, expectedWorkers: manyWorkers });
    assert(issues.some((i) => i.includes("expectedWorkers")));
  });

  it("rejects closeoutPolicy with auto actions but no approvalRef", () => {
    const issues = validateRoundManifestOptions({
      ...BASE_OPTIONS,
      closeoutPolicy: { automaticCloseout: true, automaticFinalizer: false },
    });
    assert(issues.some((i) => i.includes("approvalRef")));
  });

  it("accepts closeoutPolicy with auto actions and approvalRef", () => {
    const issues = validateRoundManifestOptions({
      ...BASE_OPTIONS,
      closeoutPolicy: {
        automaticCloseout: true,
        automaticFinalizer: false,
        approvalRef: "https://github.com/jinwon-int/a2a-broker/issues/928#issuecomment-1",
      },
    });
    assert.deepEqual(issues, []);
  });

  it("rejects invalid deadline timestamp", () => {
    const issues = validateRoundManifestOptions({
      ...BASE_OPTIONS,
      deadlineConfig: { roundDeadlineAt: "not-a-timestamp" },
    });
    assert(issues.some((i) => i.includes("roundDeadlineAt")));
  });
});

// ---------------------------------------------------------------------------
// buildRoundManifest throws on validation failure
// ---------------------------------------------------------------------------

describe("buildRoundManifest validation guard", () => {
  it("throws on invalid options", () => {
    assert.throws(
      () => buildRoundManifest({ ...BASE_OPTIONS, parentRepo: "" }),
      /Round manifest validation failed/,
    );
  });

  it("does not throw on valid options", () => {
    assert.doesNotThrow(() => buildBaseManifest());
  });
});

// ---------------------------------------------------------------------------
// Evidence types
// ---------------------------------------------------------------------------

describe("evidence type labels", () => {
  it("covers all required evidence types", () => {
    assert.equal(ROUND_EVIDENCE_TYPE_LABELS.pr, "Pull request (code/doc changes)");
    assert.equal(ROUND_EVIDENCE_TYPE_LABELS.done, "Done comment (evidence-only)");
    assert.equal(ROUND_EVIDENCE_TYPE_LABELS.block, "Block comment (cannot proceed)");
    assert.equal(ROUND_EVIDENCE_TYPE_LABELS.branch, "Branch URL (partial evidence)");
    assert.equal(ROUND_EVIDENCE_TYPE_LABELS.skip, "Skipped (not dispatched or excluded)");
  });
});

// ---------------------------------------------------------------------------
// Per-worker evidence policy
// ---------------------------------------------------------------------------

describe("per-worker evidence policy", () => {
  it("worker evidence policy overrides default", () => {
    const worker: WorkerRoundAssignment = {
      workerId: "workergamma",
      lane: 1,
      evidencePolicy: { requiredTypes: ["pr"], minimumRequired: 1 },
    };
    const manifest = buildRoundManifest({
      ...BASE_OPTIONS,
      expectedWorkers: [worker],
      defaultEvidencePolicy: { requiredTypes: ["done", "block"] },
    });
    const w = manifest.expectedWorkers[0];
    assert.deepEqual(w.evidencePolicy?.requiredTypes, ["pr"]);
    assert.deepEqual(w.evidencePolicy?.minimumRequired, 1);
  });

  it("worker without explicit policy falls back to default", () => {
    const worker: WorkerRoundAssignment = { workerId: "workergamma", lane: 1 };
    const manifest = buildRoundManifest({
      ...BASE_OPTIONS,
      expectedWorkers: [worker],
      defaultEvidencePolicy: { requiredTypes: ["done"] },
    });
    // The manifest stores the per-worker policy as-is; the fallback happens
    // at read time via getEffectiveEvidencePolicy in the projection helper.
    assert.equal(manifest.expectedWorkers[0].evidencePolicy, undefined);
  });
});

// ---------------------------------------------------------------------------
// Deadline configuration
// ---------------------------------------------------------------------------

describe("deadline configuration", () => {
  it("stores round-level deadline and defaults", () => {
    const manifest = buildRoundManifest({
      ...BASE_OPTIONS,
      deadlineConfig: {
        roundDeadlineAt: "2026-05-27T20:11:40.000Z",
      },
    });
    assert.equal(manifest.deadlineConfig?.roundDeadlineAt, "2026-05-27T20:11:40.000Z");
    // staleAfterMs and timeoutAfterMs are optional; defaults are applied by collector
    assert.equal(manifest.deadlineConfig?.staleAfterMs, undefined);
    assert.equal(manifest.deadlineConfig?.timeoutAfterMs, undefined);
  });

  it("stores explicit stale/timeout thresholds", () => {
    const manifest = buildRoundManifest({
      ...BASE_OPTIONS,
      deadlineConfig: {
        staleAfterMs: DEFAULT_ROUND_STALE_AFTER_MS,
        timeoutAfterMs: DEFAULT_ROUND_TIMEOUT_AFTER_MS,
      },
    });
    assert.equal(manifest.deadlineConfig?.staleAfterMs, DEFAULT_ROUND_STALE_AFTER_MS);
    assert.equal(manifest.deadlineConfig?.timeoutAfterMs, DEFAULT_ROUND_TIMEOUT_AFTER_MS);
  });

  it("per-worker deadlineAt overrides round-level", () => {
    const worker: WorkerRoundAssignment = {
      workerId: "workergamma",
      lane: 1,
      deadlineAt: "2026-05-27T20:11:40.000Z",
    };
    const manifest = buildRoundManifest({
      ...BASE_OPTIONS,
      expectedWorkers: [worker],
      deadlineConfig: { roundDeadlineAt: "2026-05-30T00:00:00.000Z" },
    });
    assert.equal(manifest.expectedWorkers[0].deadlineAt, "2026-05-27T20:11:40.000Z");
    assert.equal(manifest.deadlineConfig?.roundDeadlineAt, "2026-05-30T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Read projection
// ---------------------------------------------------------------------------

describe("read projection (projectRoundManifest)", () => {
  it("projects expected worker ids", () => {
    const manifest = buildBaseManifest();
    const projection = projectRoundManifest(manifest);
    assert.deepEqual(projection.expectedWorkerIds, ["workergamma", "workerepsilon", "workerbeta", "workeralpha"]);
  });

  it("resolves required evidence types for each worker", () => {
    const manifest = buildBaseManifest();
    const projection = projectRoundManifest(manifest);
    for (const assignment of projection.workerAssignments) {
      assert(assignment.requiredEvidenceTypes.includes("pr"));
      assert(assignment.requiredEvidenceTypes.includes("done"));
      assert(assignment.requiredEvidenceTypes.includes("block"));
    }
  });

  it("carries per-worker deadline when present", () => {
    const workers: WorkerRoundAssignment[] = [
      { workerId: "workergamma", lane: 1, deadlineAt: "2026-05-27T20:11:40.000Z" },
    ];
    const manifest = buildRoundManifest({ ...BASE_OPTIONS, expectedWorkers: workers });
    const projection = projectRoundManifest(manifest);
    assert.equal(projection.workerAssignments[0].deadlineAt, "2026-05-27T20:11:40.000Z");
  });

  it("projects closeout policy", () => {
    const manifest = buildBaseManifest();
    const projection = projectRoundManifest(manifest);
    assert.equal(projection.closeoutPolicy.automaticCloseout, false);
    assert.equal(projection.closeoutPolicy.automaticFinalizer, false);
  });

  it("projects resource policy from worker", () => {
    const workers: WorkerRoundAssignment[] = [
      {
        workerId: "mobilebeta",
        lane: 1,
        resourcePolicy: { noLive: true, mobileStandby: true },
      },
    ];
    const manifest = buildRoundManifest({ ...BASE_OPTIONS, expectedWorkers: workers });
    const projection = projectRoundManifest(manifest);
    assert.equal(projection.workerAssignments[0].resourcePolicy?.noLive, true);
    assert.equal(projection.workerAssignments[0].resourcePolicy?.mobileStandby, true);
  });

  it("produces a plain-object safe for JSON serialisation", () => {
    const manifest = buildBaseManifest();
    const projection = projectRoundManifest(manifest);
    const json = JSON.stringify(projection);
    const parsed = JSON.parse(json);
    assert.deepEqual(parsed.expectedWorkerIds, projection.expectedWorkerIds);
    assert.equal(parsed.runId, "a2a-round-20260526T201140KST");
  });
});

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

describe("markdown rendering", () => {
  it("renders without throwing", () => {
    const manifest = buildBaseManifest();
    assert.doesNotThrow(() => renderRoundManifestMarkdown(manifest));
  });

  it("includes the round label in the heading", () => {
    const manifest = buildBaseManifest();
    const md = renderRoundManifestMarkdown(manifest);
    assert(md.includes("a2a-hardening-r1"));
    assert(md.includes("Round Manifest"));
  });

  it("includes expected worker table header", () => {
    const md = renderRoundManifestMarkdown(buildBaseManifest());
    assert(md.includes("| Lane | Worker |"));
    assert(md.includes("workergamma"));
    assert(md.includes("workerepsilon"));
    assert(md.includes("workerbeta"));
    assert(md.includes("workeralpha"));
  });

  it("includes closeout policy section", () => {
    const md = renderRoundManifestMarkdown(buildBaseManifest());
    assert(md.includes("Automatic closeout"));
    assert(md.includes("disabled"));
  });

  it("includes deadline config when present", () => {
    const manifest = buildRoundManifest({
      ...BASE_OPTIONS,
      deadlineConfig: { roundDeadlineAt: "2026-05-27T20:11:40.000Z" },
    });
    const md = renderRoundManifestMarkdown(manifest);
    assert(md.includes("Deadline Config"));
    assert(md.includes("2026-05-27T20:11:40.000Z"));
  });

  it("includes manifest id and checksum in footer", () => {
    const manifest = buildBaseManifest();
    const md = renderRoundManifestMarkdown(manifest);
    assert(md.includes(manifest.manifestId));
    assert(md.includes(manifest.manifestChecksum));
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("works with a single worker", () => {
    const manifest = buildRoundManifest({
      ...BASE_OPTIONS,
      expectedWorkers: [{ workerId: "workergamma", lane: 1 }],
    });
    assert.equal(manifest.expectedWorkers.length, 1);
    assert.match(manifest.manifestId, /^[0-9a-f]{32}$/);
  });

  it("works with maximum workers", () => {
    const manyWorkers: WorkerRoundAssignment[] = [];
    for (let i = 1; i <= ROUND_MANIFEST_MAX_WORKERS; i++) {
      manyWorkers.push({ workerId: `w${i}`, lane: i });
    }
    const manifest = buildRoundManifest({
      ...BASE_OPTIONS,
      expectedWorkers: manyWorkers,
    });
    assert.equal(manifest.expectedWorkers.length, ROUND_MANIFEST_MAX_WORKERS);
  });

  it("accepts optional metadata", () => {
    const manifest = buildRoundManifest({
      ...BASE_OPTIONS,
      metadata: { environment: "staging", source: "a2a-team1-round-coordinator" },
    });
    assert.equal(manifest.metadata?.environment, "staging");
    assert.equal(manifest.metadata?.source, "a2a-team1-round-coordinator");
  });

  it("accepts resourcePolicy at round level", () => {
    const manifest = buildRoundManifest({
      ...BASE_OPTIONS,
      resourcePolicy: { maxConcurrency: 4, noLive: true },
    });
    assert.equal(manifest.resourcePolicy?.maxConcurrency, 4);
    assert.equal(manifest.resourcePolicy?.noLive, true);
  });

  it("workers with metadata round-trip through JSON", () => {
    const workers: WorkerRoundAssignment[] = [
      {
        workerId: "workergamma",
        lane: 1,
        metadata: { displayName: "Bang Tong", role: "thesis" },
      },
    ];
    const manifest = buildRoundManifest({ ...BASE_OPTIONS, expectedWorkers: workers });
    const json = JSON.stringify(manifest);
    const parsed = JSON.parse(json) as RoundManifest;
    assert.equal(parsed.expectedWorkers[0].metadata?.displayName, "Bang Tong");
    assert.equal(parsed.expectedWorkers[0].metadata?.role, "thesis");
  });

  it("throws when buildRoundManifest receives empty workers", () => {
    assert.throws(
      () => buildRoundManifest({ ...BASE_OPTIONS, expectedWorkers: [] }),
      /Round manifest validation failed/,
    );
  });
});
