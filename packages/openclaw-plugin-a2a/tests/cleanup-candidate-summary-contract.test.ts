/**
 * Tests for cleanup-candidate-summary-contract.ts
 *
 * Issue:  jinwon-int/openclaw-plugin-a2a#401
 * Parent: jinwon-int/a2a-broker#898
 *
 * Exercises the operator-facing cleanup-candidate summary contract.
 *
 * Safety invariants verified:
 * - dryRunImpliesMutation is always false
 * - dryRun is always true
 * - Unacked outbox backlog is SEPARATE from ACK/replay-eligible
 * - Warnings are always compact (single-line)
 * - Stale worker/residue counts are bounded at MAX_DISPLAY (100)
 * - Missing required fields fail closed with explicit field names
 * - Projection types are accepted and fields derived from them
 *
 * All operations are pure projections — no live provider send,
 * no terminal ACK, no DB mutation, no Gateway restart.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  A2A_CLEANUP_CANDIDATE_SUMMARY_SCHEMA,
  buildCleanupCandidateSummary,
  type CleanupCandidateSummaryContract,
} from "../dist/src/cleanup-candidate-summary-contract.js";
import {
  type CleanupCandidateDiscoveryProjection,
  type CleanupDryRunPlanProjection,
  type CleanupCandidateProjection,
  type CleanupPlanStep,
} from "../dist/src/cleanup-dry-run-projection.js";

// ── Fixture builders ───────────────────────────────────────────────

function buildCandidate(
  overrides: Partial<CleanupCandidateProjection> = {},
): CleanupCandidateProjection {
  return {
    candidateId: "candidate-1",
    label: "stale-terminal-outbox-row",
    reason: "Terminal outbox row older than 7 days with confirmed operator receipt",
    riskClass: "safe",
    source: "broker-primary",
    ageSeconds: 604800,
    requiresOperatorApproval: false,
    backupNotes: "Row is confirmed terminal; safe to prune after backup.",
    ...overrides,
  };
}

function buildStep(overrides: Partial<CleanupPlanStep> = {}): CleanupPlanStep {
  return {
    stepId: "step-1",
    description: "Cleanup 1 safe-risk candidate(s): stale-terminal-outbox-row",
    candidateIds: ["candidate-1"],
    riskClass: "safe",
    operatorGated: false,
    blocked: false,
    blockReason: undefined,
    rollbackNotes: "Restore from backup if any side effects observed.",
    ...overrides,
  };
}

function buildDiscoveryProjection(
  overrides: Partial<CleanupCandidateDiscoveryProjection> = {},
): CleanupCandidateDiscoveryProjection {
  const countsByRisk = overrides.countsByRisk ?? {
    safe: 1, low: 1, medium: 1, high: 1, blocked: 1,
  };
  const total =
    Object.values(countsByRisk).reduce((a: number, b: number) => a + b, 0);

  return {
    schema: "a2a.cleanup.candidate-discovery.v1",
    runId: "cleanup-run-401",
    producedAt: Date.now(),
    totalCandidates: total,
    countsByRisk,
    candidates: [buildCandidate({ riskClass: "safe" })],
    dryRun: true,
    ...overrides,
  };
}

function buildPlanProjection(
  overrides: Partial<CleanupDryRunPlanProjection> = {},
): CleanupDryRunPlanProjection {
  return {
    schema: "a2a.cleanup.dry-run-plan.v1",
    runId: "cleanup-run-401",
    producedAt: Date.now(),
    summary: "1 candidate(s) across 3 step(s). 2 step(s) require operator approval. 1 step(s) are blocked. Dry-run only — no mutation has occurred.",
    totalSteps: 3,
    operatorGatedSteps: 2,
    blockedSteps: 1,
    steps: [
      buildStep({ riskClass: "safe", operatorGated: false, blocked: false }),
      buildStep({ riskClass: "medium", stepId: "step-2", candidateIds: ["candidate-2"], operatorGated: true, blocked: false }),
      buildStep({ riskClass: "blocked", stepId: "step-3", candidateIds: ["candidate-3"], operatorGated: true, blocked: true, blockReason: "May still be valid home-broker records." }),
    ],
    backupRequired: true,
    backupCheckpointNotes: "Ensure full broker DB backup before cleanup execution.",
    approvalTokenRequired: true,
    rollbackRunbook: "See docs/recovery-guide.md",
    dryRun: true,
    ...overrides,
  };
}

function rawInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: "cleanup-run-401",
    totalCandidates: 5,
    totalSteps: 3,
    operatorGatedSteps: 2,
    blockedSteps: 1,
    countsByRisk: { safe: 1, low: 1, medium: 1, high: 1, blocked: 1 },
    unackedOutboxCount: 3,
    ackReplayEligibleCount: 1,
    legacyAckCount: 0,
    staleWorkerCount: 2,
    orphanedResidueCount: 1,
    unlinkedTaskCount: 0,
    cleanupActionType: "prune",
    approvalMode: "explicit",
    ...overrides,
  };
}

function build(overrides: Record<string, unknown> = {}): CleanupCandidateSummaryContract {
  return buildCleanupCandidateSummary(rawInput(overrides) as Parameters<typeof buildCleanupCandidateSummary>[0]);
}

// ── Schema identifier ──────────────────────────────────────────────

describe("A2A_CLEANUP_CANDIDATE_SUMMARY_SCHEMA", () => {
  it("is a stable schema identifier", () => {
    assert.equal(
      A2A_CLEANUP_CANDIDATE_SUMMARY_SCHEMA,
      "a2a.cleanup.candidate-summary.v1",
    );
  });
});

// ── Hard safety invariants ─────────────────────────────────────────

describe("hard safety invariants", () => {
  it("dryRun is always true", () => {
    const contract = build();
    assert.equal(contract.dryRun, true);
  });

  it("dryRunImpliesMutation is always false", () => {
    const contract = build();
    assert.equal(contract.dryRunImpliesMutation, false);
  });

  it("summary starts with DRY-RUN when candidates exist", () => {
    const contract = build({ totalCandidates: 1 });
    assert.ok(contract.summary.startsWith("DRY-RUN"), `summary should start with DRY-RUN: "${contract.summary}"`);
  });

  it("summary does not start with DRY-RUN when no candidates", () => {
    const contract = build({ totalCandidates: 0 });
    assert.ok(contract.summary.startsWith("No cleanup candidates"), `summary: "${contract.summary}"`);
  });

  it("summary includes 'Dry-run only — no mutation has occurred'", () => {
    const contract = build();
    assert.ok(
      contract.summary.includes("Dry-run only — no mutation has occurred"),
      `summary must end with the mutation safeguard: "${contract.summary}"`,
    );
  });

  it("schema is always the stable identifier", () => {
    const contract = build();
    assert.equal(contract.schema, "a2a.cleanup.candidate-summary.v1");
  });

  it("producedAt is a positive number (epoch ms)", () => {
    const contract = build();
    assert.ok(contract.producedAt > 0, "producedAt must be a positive number");
    assert.ok(Number.isFinite(contract.producedAt), "producedAt must be finite");
  });
});

// ── Projection-based input resolution ──────────────────────────────

describe("projection-based input resolution", () => {
  it("derives fields from discovery projection when raw fields missing", () => {
    const discovery = buildDiscoveryProjection();
    const plan = buildPlanProjection();
    const contract = buildCleanupCandidateSummary({
      discovery,
      plan,
      cleanupActionType: "prune",
      approvalMode: "explicit",
      unackedOutboxCount: 3,
      ackReplayEligibleCount: 1,
      staleWorkerCount: 2,
      orphanedResidueCount: 1,
      unlinkedTaskCount: 0,
    });
    assert.equal(contract.overview.totalCandidates, discovery.totalCandidates);
    assert.equal(contract.overview.countsByRisk.safe, discovery.countsByRisk.safe);
    assert.equal(contract.overview.totalSteps, plan.totalSteps);
    assert.equal(contract.runId, discovery.runId);
  });

  it("derives runId from discovery when not provided directly", () => {
    const discovery = buildDiscoveryProjection({ runId: "discovery-run-1" });
    const contract = buildCleanupCandidateSummary({
      discovery,
      cleanupActionType: "prune",
      approvalMode: "explicit",
      unackedOutboxCount: 1,
      ackReplayEligibleCount: 0,
      staleWorkerCount: 0,
      orphanedResidueCount: 0,
      unlinkedTaskCount: 0,
    });
    assert.equal(contract.runId, "discovery-run-1");
  });

  it("raw fields override discovery-derived fields", () => {
    const discovery = buildDiscoveryProjection({ totalCandidates: 20 });
    const plan = buildPlanProjection();
    const contract = buildCleanupCandidateSummary({
      discovery,
      plan,
      totalCandidates: 99,
      cleanupActionType: "prune",
      approvalMode: "explicit",
      unackedOutboxCount: 1,
      ackReplayEligibleCount: 0,
      staleWorkerCount: 0,
      orphanedResidueCount: 0,
      unlinkedTaskCount: 0,
    });
    // Raw field takes precedence over discovery projection
    assert.equal(contract.overview.totalCandidates, 99);
  });

  it("derives step fields from plan projection when raw fields missing", () => {
    const plan = buildPlanProjection();
    const contract = buildCleanupCandidateSummary({
      plan,
      totalCandidates: 5,
      countsByRisk: { safe: 1, low: 1, medium: 1, high: 1, blocked: 1 },
      cleanupActionType: "prune",
      approvalMode: "explicit",
      unackedOutboxCount: 1,
      ackReplayEligibleCount: 0,
      staleWorkerCount: 0,
      orphanedResidueCount: 0,
      unlinkedTaskCount: 0,
    });
    assert.equal(contract.overview.totalSteps, plan.totalSteps);
    assert.equal(contract.overview.operatorGatedSteps, plan.operatorGatedSteps);
    assert.equal(contract.overview.blockedSteps, plan.blockedSteps);
  });

  it("raw step fields override plan-derived fields", () => {
    const plan = buildPlanProjection({ totalSteps: 5, operatorGatedSteps: 3 });
    const contract = buildCleanupCandidateSummary({
      plan,
      totalSteps: 10,
      operatorGatedSteps: 8,
      blockedSteps: 0,
      totalCandidates: 5,
      countsByRisk: { safe: 1, low: 1, medium: 1, high: 1, blocked: 1 },
      cleanupActionType: "prune",
      approvalMode: "explicit",
      unackedOutboxCount: 1,
      ackReplayEligibleCount: 0,
      staleWorkerCount: 0,
      orphanedResidueCount: 0,
      unlinkedTaskCount: 0,
    });
    assert.equal(contract.overview.totalSteps, 10);
    assert.equal(contract.overview.operatorGatedSteps, 8);
  });

  it("blocked-candidates warning uses plan steps", () => {
    const plan = buildPlanProjection();
    const contract = buildCleanupCandidateSummary({
      plan,
      totalCandidates: 5,
      countsByRisk: { safe: 1, low: 1, medium: 1, high: 1, blocked: 1 },
      cleanupActionType: "prune",
      approvalMode: "explicit",
      unackedOutboxCount: 1,
      ackReplayEligibleCount: 0,
      staleWorkerCount: 0,
      orphanedResidueCount: 0,
      unlinkedTaskCount: 0,
    });
    const bcWarnings = contract.warnings.filter((w) => w.category === "blocked-candidates");
    assert.ok(bcWarnings.length > 0, "should warn about blocked candidates when plan has blocked steps");
  });

  it("no blocked-candidates warning when plan has no blocked steps", () => {
    const plan = buildPlanProjection({ blockedSteps: 0, steps: [buildStep({ blocked: false })] });
    const contract = buildCleanupCandidateSummary({
      plan,
      totalCandidates: 1,
      countsByRisk: { safe: 1, low: 0, medium: 0, high: 0, blocked: 0 },
      cleanupActionType: "prune",
      approvalMode: "explicit",
      unackedOutboxCount: 1,
      ackReplayEligibleCount: 0,
      staleWorkerCount: 0,
      orphanedResidueCount: 0,
      unlinkedTaskCount: 0,
    });
    const bcWarnings = contract.warnings.filter((w) => w.category === "blocked-candidates");
    assert.equal(bcWarnings.length, 0, "should not warn when no blocked steps");
  });

  it("accepts both discovery and plan projections together", () => {
    const discovery = buildDiscoveryProjection();
    const plan = buildPlanProjection();
    const contract = buildCleanupCandidateSummary({
      discovery,
      plan,
      cleanupActionType: "prune",
      approvalMode: "explicit",
      unackedOutboxCount: 3,
      ackReplayEligibleCount: 1,
      staleWorkerCount: 2,
      orphanedResidueCount: 1,
      unlinkedTaskCount: 0,
    });
    assert.equal(contract.overview.totalCandidates, discovery.totalCandidates);
    assert.equal(contract.overview.totalSteps, plan.totalSteps);
    assert.equal(contract.overview.operatorGatedSteps, plan.operatorGatedSteps);
    assert.equal(contract.overview.blockedSteps, plan.blockedSteps);
  });

  it("countsByRisk type uses CleanupRiskClass keys", () => {
    const contract = build();
    const keys = Object.keys(contract.overview.countsByRisk);
    const knownKeys = ["safe", "low", "medium", "high", "blocked"];
    assert.deepEqual(keys.sort(), knownKeys.sort());
  });
});

// ── Fail-closed validation ─────────────────────────────────────────

describe("fail-closed validation", () => {
  it("returns valid=true when all required fields are present", () => {
    const contract = build();
    assert.equal(contract.validation.valid, true);
    assert.deepEqual(contract.validation.missingFields, []);
  });

  it("fails closed when runId is missing", () => {
    const contract = build({ runId: undefined });
    assert.equal(contract.validation.valid, false);
    assert.ok(contract.validation.missingFields.includes("runId"));
    assert.ok(contract.summary.startsWith("FAIL CLOSED"));
  });

  it("fails closed when totalCandidates is missing", () => {
    const contract = build({ totalCandidates: undefined });
    assert.equal(contract.validation.valid, false);
    assert.ok(contract.validation.missingFields.includes("totalCandidates"));
    assert.ok(contract.summary.startsWith("FAIL CLOSED"));
  });

  it("fails closed when totalSteps is missing", () => {
    const contract = build({ totalSteps: undefined });
    assert.equal(contract.validation.valid, false);
    assert.ok(contract.validation.missingFields.includes("totalSteps"));
  });

  it("fails closed when operatorGatedSteps is missing", () => {
    const contract = build({ operatorGatedSteps: undefined });
    assert.equal(contract.validation.valid, false);
    assert.ok(contract.validation.missingFields.includes("operatorGatedSteps"));
  });

  it("fails closed when blockedSteps is missing", () => {
    const contract = build({ blockedSteps: undefined });
    assert.equal(contract.validation.valid, false);
    assert.ok(contract.validation.missingFields.includes("blockedSteps"));
  });

  it("fails closed when countsByRisk is missing", () => {
    const contract = build({ countsByRisk: undefined });
    assert.equal(contract.validation.valid, false);
    assert.ok(contract.validation.missingFields.includes("countsByRisk"));
  });

  it("fails closed when unackedOutboxCount is missing", () => {
    const contract = build({ unackedOutboxCount: undefined });
    assert.equal(contract.validation.valid, false);
    assert.ok(contract.validation.missingFields.includes("unackedOutboxCount"));
  });

  it("fails closed when ackReplayEligibleCount is missing", () => {
    const contract = build({ ackReplayEligibleCount: undefined });
    assert.equal(contract.validation.valid, false);
    assert.ok(contract.validation.missingFields.includes("ackReplayEligibleCount"));
  });

  it("fails closed when staleWorkerCount is missing", () => {
    const contract = build({ staleWorkerCount: undefined });
    assert.equal(contract.validation.valid, false);
    assert.ok(contract.validation.missingFields.includes("staleWorkerCount"));
  });

  it("fails closed when orphanedResidueCount is missing", () => {
    const contract = build({ orphanedResidueCount: undefined });
    assert.equal(contract.validation.valid, false);
    assert.ok(contract.validation.missingFields.includes("orphanedResidueCount"));
  });

  it("fails closed when unlinkedTaskCount is missing", () => {
    const contract = build({ unlinkedTaskCount: undefined });
    assert.equal(contract.validation.valid, false);
    assert.ok(contract.validation.missingFields.includes("unlinkedTaskCount"));
  });

  it("fails closed when multiple fields are missing at once", () => {
    const contract = build({
      runId: undefined,
      totalCandidates: undefined,
      totalSteps: undefined,
    });
    assert.equal(contract.validation.valid, false);
    assert.ok(contract.validation.missingFields.includes("runId"));
    assert.ok(contract.validation.missingFields.includes("totalCandidates"));
    assert.ok(contract.validation.missingFields.includes("totalSteps"));
    assert.equal(contract.validation.missingFields.length, 3);
  });

  it("fail-closed contract lists all missing fields in failClosedMessage", () => {
    const contract = build({
      runId: undefined,
      staleWorkerCount: undefined,
    });
    assert.ok(contract.validation.failClosedMessage!.includes("runId"));
    assert.ok(contract.validation.failClosedMessage!.includes("staleWorkerCount"));
    assert.ok(contract.validation.failClosedMessage!.includes("FAIL CLOSED"));
  });

  it("fail-closed contract has zeroed overview counts", () => {
    const contract = build({ runId: undefined });
    assert.equal(contract.overview.totalCandidates, 0);
    assert.equal(contract.overview.totalSteps, 0);
    assert.equal(contract.overview.operatorGatedSteps, 0);
    assert.equal(contract.overview.blockedSteps, 0);
  });

  it("fail-closed contract has a validation warning", () => {
    const contract = build({ runId: undefined });
    const validationWarnings = contract.warnings.filter((w) => w.category === "validation");
    assert.ok(validationWarnings.length >= 1);
    assert.equal(validationWarnings[0].severity, "error");
  });

  it("fail-closed contract uses 'unknown' as runId when runId is missing", () => {
    const contract = build({ runId: undefined });
    assert.equal(contract.runId, "unknown");
  });

  it("fail-closed contract has zeroed stale counts", () => {
    const contract = build({ staleWorkerCount: undefined });
    assert.equal(contract.staleCounts.staleWorkers.count, 0);
    assert.equal(contract.staleCounts.orphanedResidues.count, 0);
    assert.equal(contract.staleCounts.unlinkedTasks.count, 0);
  });

  it("fail-closed contract has zeroed outbox backlog", () => {
    const contract = build({ unackedOutboxCount: undefined });
    assert.equal(contract.outboxBacklog.unackedCount, 0);
    assert.equal(contract.outboxBacklog.ackReplayEligibleCount, 0);
  });
});

// ── Terminal outbox backlog separation ─────────────────────────────

describe("terminal outbox backlog separation", () => {
  it("keeps unackedCount separate from ackReplayEligibleCount", () => {
    const contract = build({
      unackedOutboxCount: 5,
      ackReplayEligibleCount: 2,
    });
    assert.equal(contract.outboxBacklog.unackedCount, 5);
    assert.equal(contract.outboxBacklog.ackReplayEligibleCount, 2);
    assert.ok(
      contract.outboxBacklog.note.includes("SEPARATE"),
      "outbox backlog note must mention SEPARATE",
    );
  });

  it("ackReplayEligibleCount can be zero while unackedCount is non-zero", () => {
    const contract = build({
      unackedOutboxCount: 3,
      ackReplayEligibleCount: 0,
    });
    assert.equal(contract.outboxBacklog.unackedCount, 3);
    assert.equal(contract.outboxBacklog.ackReplayEligibleCount, 0);
  });

  it("unackedCount can be zero while ackReplayEligibleCount is non-zero", () => {
    const contract = build({
      unackedOutboxCount: 0,
      ackReplayEligibleCount: 4,
    });
    assert.equal(contract.outboxBacklog.unackedCount, 0);
    assert.equal(contract.outboxBacklog.ackReplayEligibleCount, 4);
  });

  it("legacyAckCount is a separate safety counter", () => {
    const contract = build({ legacyAckCount: 2 });
    assert.equal(contract.outboxBacklog.legacyAckCount, 2);
  });

  it("legacyAckCount defaults to 0 when not provided", () => {
    const contract = build({ legacyAckCount: undefined });
    assert.equal(contract.outboxBacklog.legacyAckCount, 0);
  });

  it("summary includes separate unacked and ack/replay counts", () => {
    const contract = build({
      unackedOutboxCount: 7,
      ackReplayEligibleCount: 3,
    });
    assert.ok(
      contract.summary.includes("Unacked outbox backlog: 7 (separate from ACK/replay: 3)"),
      `summary: "${contract.summary}"`,
    );
  });
});

// ── Bounded stale worker and residue counts ────────────────────────

describe("bounded stale worker / residue counts", () => {
  it("staleWorkers is bounded at MAX_DISPLAY (100)", () => {
    const contract = build({ staleWorkerCount: 150 });
    assert.equal(contract.staleCounts.staleWorkers.count, 100);
    assert.equal(contract.staleCounts.staleWorkers.overflow, true);
    assert.equal(contract.staleCounts.staleWorkers.bounded, true);
  });

  it("orphanedResidues is bounded at MAX_DISPLAY (100)", () => {
    const contract = build({ orphanedResidueCount: 200 });
    assert.equal(contract.staleCounts.orphanedResidues.count, 100);
    assert.equal(contract.staleCounts.orphanedResidues.overflow, true);
  });

  it("unlinkedTasks is bounded at MAX_DISPLAY (100)", () => {
    const contract = build({ unlinkedTaskCount: 300 });
    assert.equal(contract.staleCounts.unlinkedTasks.count, 100);
    assert.equal(contract.staleCounts.unlinkedTasks.overflow, true);
  });

  it("counts under the limit show overflow=false", () => {
    const contract = build({
      staleWorkerCount: 5,
      orphanedResidueCount: 3,
      unlinkedTaskCount: 0,
    });
    assert.equal(contract.staleCounts.staleWorkers.count, 5);
    assert.equal(contract.staleCounts.staleWorkers.overflow, false);
    assert.equal(contract.staleCounts.orphanedResidues.count, 3);
    assert.equal(contract.staleCounts.orphanedResidues.overflow, false);
    assert.equal(contract.staleCounts.unlinkedTasks.count, 0);
    assert.equal(contract.staleCounts.unlinkedTasks.overflow, false);
  });

  it("exactly at limit shows count=maxDisplay and overflow=false", () => {
    const contract = build({ staleWorkerCount: 100 });
    assert.equal(contract.staleCounts.staleWorkers.count, 100);
    assert.equal(contract.staleCounts.staleWorkers.overflow, false);
  });

  it("overflow warning is emitted when stale worker count exceeds limit", () => {
    const contract = build({ staleWorkerCount: 150 });
    const overflowWarnings = contract.warnings.filter((w) => w.category === "stale-workers");
    assert.ok(overflowWarnings.length > 0, "must warn about stale worker overflow");
    assert.ok(overflowWarnings[0].message.includes("overflow"));
  });

  it("overflow warning is emitted when orphaned residue count exceeds limit", () => {
    const contract = build({ orphanedResidueCount: 120 });
    const overflowWarnings = contract.warnings.filter((w) => w.category === "orphaned-residues");
    assert.ok(overflowWarnings.length > 0, "must warn about orphaned residue overflow");
  });

  it("no overflow warning when counts are within limit", () => {
    const contract = build({
      staleWorkerCount: 50,
      orphanedResidueCount: 30,
    });
    const overflowWarnings = contract.warnings.filter(
      (w) => w.category === "stale-workers" || w.category === "orphaned-residues",
    );
    assert.equal(overflowWarnings.length, 0, "should not warn when within limit");
  });

  it("all bounded counts have maxDisplay=100", () => {
    const contract = build();
    assert.equal(contract.staleCounts.staleWorkers.maxDisplay, 100);
    assert.equal(contract.staleCounts.orphanedResidues.maxDisplay, 100);
    assert.equal(contract.staleCounts.unlinkedTasks.maxDisplay, 100);
  });

  it("summary includes bounded stale/residue counts when non-zero", () => {
    const contract = build({
      staleWorkerCount: 5,
      orphanedResidueCount: 3,
      unlinkedTaskCount: 2,
    });
    assert.ok(contract.summary.includes("5 worker(s)"));
    assert.ok(contract.summary.includes("3 residue(s)"));
    assert.ok(contract.summary.includes("2 unlinked task(s)"));
  });

  it("summary says 'No stale/residue records' when all zero", () => {
    const contract = build({
      staleWorkerCount: 0,
      orphanedResidueCount: 0,
      unlinkedTaskCount: 0,
    });
    assert.ok(contract.summary.includes("No stale/residue records"));
  });
});

// ── Compact hot-table warnings ─────────────────────────────────────

describe("compact hot-table warnings", () => {
  it("all warnings have category, message, and severity", () => {
    const contract = build({
      queueDepth: 100,
      auditPressureRatio: 0.95,
      receiptGapCount: 5,
    });
    for (const w of contract.warnings) {
      assert.ok(typeof w.category === "string" && w.category.length > 0, `category must be non-empty: ${w.category}`);
      assert.ok(typeof w.message === "string" && w.message.length > 0, `message must be non-empty: ${w.message}`);
      assert.ok(["info", "warn", "error"].includes(w.severity), `severity must be one of info/warn/error: ${w.severity}`);
    }
  });

  it("warnings are compact (single-line, no newlines)", () => {
    const contract = build({
      queueDepth: 100,
      auditPressureRatio: 0.95,
    });
    for (const w of contract.warnings) {
      assert.ok(!w.message.includes("\n"), `message must be single-line: "${w.message}"`);
      assert.ok(w.message.length < 200, `message should be compact: "${w.message}" (${w.message.length} chars)`);
    }
  });

  it("emits error severity for queue depth >= 100", () => {
    const contract = build({ queueDepth: 150 });
    const qdWarnings = contract.warnings.filter((w) => w.category === "queue-depth");
    assert.ok(qdWarnings.length > 0);
    assert.equal(qdWarnings[0].severity, "error");
  });

  it("emits warn severity for queue depth 50-99", () => {
    const contract = build({ queueDepth: 75 });
    const qdWarnings = contract.warnings.filter((w) => w.category === "queue-depth");
    assert.ok(qdWarnings.length > 0);
    assert.equal(qdWarnings[0].severity, "warn");
  });

  it("emits info severity for queue depth 20-49", () => {
    const contract = build({ queueDepth: 30 });
    const qdWarnings = contract.warnings.filter((w) => w.category === "queue-depth");
    assert.ok(qdWarnings.length > 0);
    assert.equal(qdWarnings[0].severity, "info");
  });

  it("no queue-depth warning when queue depth < 20", () => {
    const contract = build({ queueDepth: 5 });
    const qdWarnings = contract.warnings.filter((w) => w.category === "queue-depth");
    assert.equal(qdWarnings.length, 0);
  });

  it("emits error severity for audit pressure >= 0.95", () => {
    const contract = build({ auditPressureRatio: 0.98 });
    const apWarnings = contract.warnings.filter((w) => w.category === "audit-pressure");
    assert.ok(apWarnings.length > 0);
    assert.equal(apWarnings[0].severity, "error");
  });

  it("emits warn severity for audit pressure 0.9-0.94", () => {
    const contract = build({ auditPressureRatio: 0.92 });
    const apWarnings = contract.warnings.filter((w) => w.category === "audit-pressure");
    assert.ok(apWarnings.length > 0);
    assert.equal(apWarnings[0].severity, "warn");
  });

  it("emits info severity for audit pressure 0.75-0.89", () => {
    const contract = build({ auditPressureRatio: 0.80 });
    const apWarnings = contract.warnings.filter((w) => w.category === "audit-pressure");
    assert.ok(apWarnings.length > 0);
    assert.equal(apWarnings[0].severity, "info");
  });

  it("no audit-pressure warning when pressure < 0.75", () => {
    const contract = build({ auditPressureRatio: 0.50 });
    const apWarnings = contract.warnings.filter((w) => w.category === "audit-pressure");
    assert.equal(apWarnings.length, 0);
  });

  it("emits error for receipt gaps > 10", () => {
    const contract = build({ receiptGapCount: 15 });
    const rgWarnings = contract.warnings.filter((w) => w.category === "receipt-gaps");
    assert.ok(rgWarnings.length > 0);
    assert.equal(rgWarnings[0].severity, "error");
  });

  it("emits warn for receipt gaps 1-10", () => {
    const contract = build({ receiptGapCount: 3 });
    const rgWarnings = contract.warnings.filter((w) => w.category === "receipt-gaps");
    assert.ok(rgWarnings.length > 0);
    assert.equal(rgWarnings[0].severity, "warn");
  });

  it("no receipt-gap warning when no gaps", () => {
    const contract = build({ receiptGapCount: 0 });
    const rgWarnings = contract.warnings.filter((w) => w.category === "receipt-gaps");
    assert.equal(rgWarnings.length, 0);
  });

  it("no approval-mode warning is emitted — approval mode is not warning-only or default-to-auto", () => {
    const contract = build();
    const amWarnings = contract.warnings.filter((w) => w.category === "approval-mode");
    assert.equal(amWarnings.length, 0, "approval mode must NOT produce a warning; it is validated fail-closed at input");
  });

  it("approvalMode appears in the contract as a field, not as a warning", () => {
    const contract = build();
    assert.equal(contract.approvalMode, "explicit");
  });

  it("cleanupActionType appears in the contract", () => {
    const contract = build();
    assert.equal(contract.cleanupActionType, "prune");
  });

  it("warnings are deduplicated by category+message", () => {
    const contract = build({
      queueDepth: 100,
      auditPressureRatio: 0.95,
      receiptGapCount: 12,
    });
    const seen = new Set<string>();
    for (const w of contract.warnings) {
      const key = `${w.category}:${w.message}`;
      assert.ok(!seen.has(key), `duplicate warning: ${key}`);
      seen.add(key);
    }
  });

  it("blocked candidate warning from plan references home-broker records", () => {
    const plan = buildPlanProjection();
    const contract = buildCleanupCandidateSummary({
      plan,
      totalCandidates: 5,
      countsByRisk: { safe: 1, low: 1, medium: 1, high: 1, blocked: 1 },
      cleanupActionType: "prune",
      approvalMode: "explicit",
      unackedOutboxCount: 1,
      ackReplayEligibleCount: 0,
      staleWorkerCount: 0,
      orphanedResidueCount: 0,
      unlinkedTaskCount: 0,
    });
    const bcWarnings = contract.warnings.filter((w) => w.category === "blocked-candidates");
    assert.ok(bcWarnings.length > 0);
    assert.ok(
      bcWarnings[0].message.includes("valid home-broker"),
      "blocked-candidates warning must mention home-broker validity",
    );
  });
});

// ── Cleanup action type and approval mode fail-closed ─────────────

describe("cleanupActionType and approvalMode fail-closed (#412 refinement)", () => {
  it("missing cleanupActionType fails closed", () => {
    const contract = build({ cleanupActionType: undefined });
    assert.equal(contract.validation.valid, false);
    assert.ok(contract.validation.missingFields.includes("cleanupActionType"));
    assert.ok(contract.summary.startsWith("FAIL CLOSED"));
  });

  it("invalid cleanupActionType fails closed", () => {
    const contract = build({ cleanupActionType: "invalid-type" });
    assert.equal(contract.validation.valid, false);
    assert.ok(
      contract.validation.failClosedMessage!.includes("Invalid cleanupActionType"),
      `must mention invalid type: "${contract.validation.failClosedMessage}"`,
    );
    assert.ok(contract.summary.startsWith("FAIL CLOSED"));
  });

  it("valid cleanupActionType values are accepted", () => {
    for (const validType of ["prune", "archive", "reconcile", "notify", "review"]) {
      const contract = build({ cleanupActionType: validType });
      assert.equal(contract.validation.valid, true, `cleanupActionType "${validType}" must be valid`);
      assert.equal(contract.cleanupActionType, validType);
    }
  });

  it("missing approvalMode fails closed", () => {
    const contract = build({ approvalMode: undefined });
    assert.equal(contract.validation.valid, false);
    assert.ok(contract.validation.missingFields.includes("approvalMode"));
    assert.ok(contract.summary.startsWith("FAIL CLOSED"));
  });

  it("invalid approvalMode fails closed", () => {
    const contract = build({ approvalMode: "auto" });
    assert.equal(contract.validation.valid, false);
    assert.ok(
      contract.validation.failClosedMessage!.includes("Invalid approvalMode"),
      `must mention invalid mode: "${contract.validation.failClosedMessage}"`,
    );
    assert.ok(contract.summary.startsWith("FAIL CLOSED"));
  });

  it("approvalMode 'auto' fails closed (no default-to-auto)", () => {
    const contract = build({ approvalMode: "auto" });
    assert.equal(contract.validation.valid, false);
    assert.ok(
      contract.validation.failClosedMessage!.includes("Invalid approvalMode"),
      "auto mode must be rejected as invalid",
    );
  });

  it("valid approvalMode values are accepted", () => {
    for (const validMode of ["explicit", "confirmed", "manual"]) {
      const contract = build({ approvalMode: validMode });
      assert.equal(contract.validation.valid, true, `approvalMode "${validMode}" must be valid`);
      assert.equal(contract.approvalMode, validMode);
    }
  });

  it("fail-closed contract for invalid cleanupActionType has zeroed overview", () => {
    const contract = build({ cleanupActionType: "nope" });
    assert.equal(contract.overview.totalCandidates, 0);
    assert.equal(contract.overview.totalSteps, 0);
  });

  it("fail-closed contract for invalid approvalMode has a validation warning", () => {
    const contract = build({ approvalMode: "warning-only" });
    const validationWarnings = contract.warnings.filter((w) => w.category === "validation");
    assert.ok(validationWarnings.length >= 1);
    assert.equal(validationWarnings[0].severity, "error");
  });
});

// ── Overview ────────────────────────────────────────────────────────

describe("overview", () => {
  it("reflects input counts correctly", () => {
    const contract = build();
    assert.equal(contract.overview.totalCandidates, 5);
    assert.equal(contract.overview.totalSteps, 3);
    assert.equal(contract.overview.operatorGatedSteps, 2);
    assert.equal(contract.overview.blockedSteps, 1);
  });

  it("countsByRisk sanitizes to known keys", () => {
    const contract = build({
      countsByRisk: { safe: 1, low: 2, medium: 3, high: 4, blocked: 5, unknown: 99 },
    });
    assert.equal(contract.overview.countsByRisk.safe, 1);
    assert.equal(contract.overview.countsByRisk.low, 2);
    assert.equal(contract.overview.countsByRisk.medium, 3);
    assert.equal(contract.overview.countsByRisk.high, 4);
    assert.equal(contract.overview.countsByRisk.blocked, 5);
    // "unknown" should not appear (not a known risk key)
    assert.equal(Object.keys(contract.overview.countsByRisk).length, 5);
  });

  it("countsByRisk defaults missing keys to 0", () => {
    const contract = build({
      countsByRisk: { safe: 1 },
    });
    assert.equal(contract.overview.countsByRisk.safe, 1);
    assert.equal(contract.overview.countsByRisk.low, 0);
    assert.equal(contract.overview.countsByRisk.medium, 0);
    assert.equal(contract.overview.countsByRisk.high, 0);
    assert.equal(contract.overview.countsByRisk.blocked, 0);
  });

  it("countsByRisk only contains CleanupRiskClass keys", () => {
    const contract = build();
    const knownKeys: string[] = ["safe", "low", "medium", "high", "blocked"];
    for (const key of Object.keys(contract.overview.countsByRisk)) {
      assert.ok(knownKeys.includes(key), `unexpected key: ${key}`);
    }
  });
});

// ── Edge cases ──────────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles zero candidates gracefully", () => {
    const contract = build({
      totalCandidates: 0,
      totalSteps: 0,
      staleWorkerCount: 0,
      orphanedResidueCount: 0,
      unlinkedTaskCount: 0,
    });
    assert.equal(contract.overview.totalCandidates, 0);
    assert.equal(contract.overview.totalSteps, 0);
    assert.ok(contract.summary.startsWith("No cleanup candidates."));
    assert.ok(contract.summary.includes("No stale/residue records"));
  });

  it("handles all-zero optional fields", () => {
    const contract = build({
      unackedOutboxCount: 0,
      ackReplayEligibleCount: 0,
      legacyAckCount: 0,
      staleWorkerCount: 0,
      orphanedResidueCount: 0,
      unlinkedTaskCount: 0,
      queueDepth: 0,
      receiptGapCount: 0,
    });
    assert.equal(contract.validation.valid, true);
    assert.equal(contract.staleCounts.staleWorkers.count, 0);
    assert.equal(contract.staleCounts.staleWorkers.overflow, false);
  });

  it("treats countsByRisk with non-number values as 0", () => {
    const contract = build({
      countsByRisk: { safe: "abc" as unknown as number, low: null as unknown as number, medium: 3 },
    });
    assert.equal(contract.overview.countsByRisk.safe, 0);
    assert.equal(contract.overview.countsByRisk.low, 0);
    assert.equal(contract.overview.countsByRisk.medium, 3);
  });
});

// ── Summary line ────────────────────────────────────────────────────

describe("summary line", () => {
  it("includes candidate count, steps, operator-gated, and blocked", () => {
    const contract = build({
      totalCandidates: 10,
      totalSteps: 4,
      operatorGatedSteps: 3,
      blockedSteps: 1,
    });
    assert.ok(contract.summary.includes("10 candidate(s)"));
    assert.ok(contract.summary.includes("4 step(s)"));
    assert.ok(contract.summary.includes("3 operator-gated"));
    assert.ok(contract.summary.includes("1 blocked"));
  });
});
