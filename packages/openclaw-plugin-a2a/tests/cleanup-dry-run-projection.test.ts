/**
 * Tests for cleanup-dry-run-projection.ts
 *
 * Issue:  jinwon-int/plugin-a2a#278
 * Parent: jinwon-int/a2a-broker#519
 *
 * Exercises the cleanup dry-run projection with canary/receipt gates.
 * All tests are pure projections — no live send, no DB mutation,
 * no terminal ACK, no deploy/restart.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  projectCleanupDryRunPlan,
  resolveCleanupReceiptGate,
  isCleanupReceiptTerminal,
  projectCleanupGateStatus,
  projectCleanupAuditEntry,
  buildCleanupRollbackSummary,
  type CleanupCandidateDiscoveryProjection,
  type CleanupCandidateProjection,
  type CleanupRiskClass,
  type CleanupReceiptStatus,
  type CleanupDryRunPlanProjection,
} from "../dist/src/cleanup-dry-run-projection.js";

// ── Fixture builders ─────────────────────────────────────────────────

function buildSafeCandidate(overrides: Partial<CleanupCandidateProjection> = {}): CleanupCandidateProjection {
  return {
    candidateId: "candidate-safe-1",
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

function buildLowCandidate(overrides: Partial<CleanupCandidateProjection> = {}): CleanupCandidateProjection {
  return {
    candidateId: "candidate-low-1",
    label: "stale-session-entry",
    reason: "Session entry with no active worker for 30 days",
    riskClass: "low",
    source: "broker-primary",
    ageSeconds: 2592000,
    requiresOperatorApproval: true,
    backupNotes: "Verify no pending handoff before removal.",
    ...overrides,
  };
}

function buildMediumCandidate(overrides: Partial<CleanupCandidateProjection> = {}): CleanupCandidateProjection {
  return {
    candidateId: "candidate-medium-1",
    label: "orphaned-task-record",
    reason: "Task record with no parent session and no worker assignment",
    riskClass: "medium",
    source: "broker-primary",
    ageSeconds: 1209600,
    requiresOperatorApproval: true,
    backupNotes: "Confirm task is not referenced by any active workflow.",
    ...overrides,
  };
}

function buildHighCandidate(overrides: Partial<CleanupCandidateProjection> = {}): CleanupCandidateProjection {
  return {
    candidateId: "candidate-high-1",
    label: "stale-worker-row",
    reason: "Worker row with last heartbeat > 14 days ago — may still be valid home-broker record",
    riskClass: "high",
    source: "broker-primary",
    ageSeconds: 1209600,
    requiresOperatorApproval: true,
    backupNotes: "FAIL CLOSED: This worker row may still be valid. Operator must confirm decommission before pruning.",
    ...overrides,
  };
}

function buildBlockedCandidate(overrides: Partial<CleanupCandidateProjection> = {}): CleanupCandidateProjection {
  return {
    candidateId: "candidate-blocked-1",
    label: "active-worker-stale-home",
    reason: "Worker row absent from home broker but peer reports active task — possible network partition artifact",
    riskClass: "blocked",
    source: "broker-primary",
    ageSeconds: 86400,
    requiresOperatorApproval: true,
    backupNotes: "DO NOT PRUNE. This worker may still be valid. Requires manual investigation.",
    ...overrides,
  };
}

function buildDiscovery(opts: {
  candidates?: CleanupCandidateProjection[];
  runId?: string;
  now?: number;
} = {}): CleanupCandidateDiscoveryProjection {
  const now = opts.now ?? 1715000000000;
  return {
    schema: "a2a.cleanup.candidate-discovery.v1",
    runId: opts.runId ?? `discovery-${now}`,
    producedAt: now,
    totalCandidates: (opts.candidates ?? []).length,
    countsByRisk: computeCountsByRisk(opts.candidates ?? []),
    candidates: opts.candidates ?? [],
    dryRun: true,
  };
}

function computeCountsByRisk(
  candidates: CleanupCandidateProjection[],
): Record<CleanupRiskClass, number> {
  const counts: Record<CleanupRiskClass, number> = {
    safe: 0,
    low: 0,
    medium: 0,
    high: 0,
    blocked: 0,
  };
  for (const c of candidates) {
    counts[c.riskClass] += 1;
  }
  return counts;
}

// ── Tests: Candidate discovery ──────────────────────────────────────

describe("cleanup-dry-run-projection (#278)", () => {
  describe("candidate discovery projection", () => {
    it("produces a discovery projection with correct counts", () => {
      const discovery = buildDiscovery({
        candidates: [
          buildSafeCandidate(),
          buildLowCandidate(),
          buildMediumCandidate(),
          buildHighCandidate(),
          buildBlockedCandidate(),
        ],
      });

      assert.equal(discovery.schema, "a2a.cleanup.candidate-discovery.v1");
      assert.equal(discovery.totalCandidates, 5);
      assert.equal(discovery.countsByRisk.safe, 1);
      assert.equal(discovery.countsByRisk.low, 1);
      assert.equal(discovery.countsByRisk.medium, 1);
      assert.equal(discovery.countsByRisk.high, 1);
      assert.equal(discovery.countsByRisk.blocked, 1);
      assert.equal(discovery.dryRun, true);
    });

    it("produces a discovery projection with no candidates", () => {
      const discovery = buildDiscovery({ candidates: [] });
      assert.equal(discovery.totalCandidates, 0);
      assert.equal(discovery.candidates.length, 0);
    });
  });

  // ── Tests: Dry-run plan projection ──────────────────────────────

  describe("dry-run plan projection", () => {
    it("produces a plan with operator-gated steps for non-safe candidates", () => {
      const discovery = buildDiscovery({
        candidates: [
          buildSafeCandidate(),
          buildLowCandidate(),
          buildHighCandidate(),
        ],
      });

      const plan = projectCleanupDryRunPlan({ discovery });

      assert.equal(plan.schema, "a2a.cleanup.dry-run-plan.v1");
      assert.equal(plan.dryRun, true);
      assert.equal(plan.backupRequired, true);
      assert.equal(plan.approvalTokenRequired, true);
      assert.ok(plan.totalSteps >= 1, "plan must have at least one step");
      assert.ok(plan.operatorGatedSteps >= 1, "at least one step must be operator-gated");
      assert.ok(plan.summary.includes("Dry-run only"), "summary must note dry-run");
      assert.ok(
        plan.summary.includes("no mutation has occurred"),
        "summary must assert no mutation",
      );
    });

    it("operator-gates all non-safe candidates", () => {
      const discovery = buildDiscovery({
        candidates: [
          buildSafeCandidate(),
          buildLowCandidate(),
          buildMediumCandidate(),
        ],
      });

      const plan = projectCleanupDryRunPlan({ discovery });

      for (const step of plan.steps) {
        if (step.riskClass === "safe") {
          assert.equal(step.operatorGated, false, "safe steps must not be operator-gated");
        } else {
          assert.equal(step.operatorGated, true, "non-safe steps must be operator-gated");
        }
      }
    });

    it("blocks blocked-risk candidates", () => {
      const discovery = buildDiscovery({
        candidates: [buildBlockedCandidate()],
      });

      const plan = projectCleanupDryRunPlan({ discovery });

      const blockedSteps = plan.steps.filter((s) => s.riskClass === "blocked");
      assert.ok(blockedSteps.length > 0, "blocked candidates must produce steps");
      for (const step of blockedSteps) {
        assert.equal(step.blocked, true);
        assert.ok(step.blockReason, "blocked steps must have a reason");
        assert.ok(
          step.blockReason!.includes("valid home-broker"),
          "block reason must reference home-broker validity",
        );
      }
    });

    it("filters candidates by maxRisk", () => {
      const discovery = buildDiscovery({
        candidates: [
          buildSafeCandidate(),
          buildLowCandidate(),
          buildMediumCandidate(),
          buildHighCandidate(),
          buildBlockedCandidate(),
        ],
      });

      const planLow = projectCleanupDryRunPlan({ discovery, maxRisk: "low" });
      const eligibleLow = planLow.steps.reduce((sum, s) => sum + s.candidateIds.length, 0);
      assert.ok(eligibleLow <= 2, "maxRisk=low must exclude medium+ candidates");

      const planMedium = projectCleanupDryRunPlan({ discovery, maxRisk: "medium" });
      const eligibleMedium = planMedium.steps.reduce((sum, s) => sum + s.candidateIds.length, 0);
      assert.ok(eligibleMedium <= 3, "maxRisk=medium must exclude high+blocked candidates");
    });

    it("excludes candidates by id", () => {
      const discovery = buildDiscovery({
        candidates: [
          buildSafeCandidate({ candidateId: "keep-me" }),
          buildSafeCandidate({ candidateId: "exclude-me" }),
        ],
      });

      const plan = projectCleanupDryRunPlan({
        discovery,
        excludeCandidateIds: ["exclude-me"],
      });

      const allIds = plan.steps.flatMap((s) => s.candidateIds);
      assert.ok(allIds.includes("keep-me"), "non-excluded id must be present");
      assert.ok(!allIds.includes("exclude-me"), "excluded id must be absent");
    });

    it("produces empty plan when all candidates are excluded", () => {
      const discovery = buildDiscovery({
        candidates: [buildSafeCandidate()],
      });

      const plan = projectCleanupDryRunPlan({
        discovery,
        excludeCandidateIds: ["candidate-safe-1"],
      });

      assert.equal(plan.totalSteps, 0);
      assert.equal(plan.steps.length, 0);
      assert.ok(plan.summary.includes("No cleanup candidates"));
    });

    it("includes rollback runbook in the plan", () => {
      const discovery = buildDiscovery({
        candidates: [buildHighCandidate()],
      });

      const plan = projectCleanupDryRunPlan({ discovery });
      assert.ok(plan.rollbackRunbook.length > 0, "plan must include a rollback runbook");
      assert.ok(
        plan.rollbackRunbook.includes("Restore from"),
        "runbook must mention restore",
      );
    });
  });

  // ── Tests: Receipt gate ─────────────────────────────────────────

  describe("cleanup receipt gate", () => {
    it("rejects provider_accepted_send as non-terminal", () => {
      assert.equal(isCleanupReceiptTerminal("provider_accepted_send"), false);
    });

    it("rejects notification_delivered as non-terminal", () => {
      assert.equal(isCleanupReceiptTerminal("notification_delivered"), false);
    });

    it("accepts operator_acknowledged as terminal", () => {
      assert.equal(isCleanupReceiptTerminal("operator_acknowledged"), true);
    });

    it("accepts operator_approved as terminal", () => {
      assert.equal(isCleanupReceiptTerminal("operator_approved"), true);
    });

    it("resolveCleanupReceiptGate rejects provider_accepted_send", () => {
      const verdict = resolveCleanupReceiptGate("provider_accepted_send");
      assert.equal(verdict.satisfied, false);
      assert.equal(verdict.receiptStatus, "provider_accepted_send");
      assert.ok(
        verdict.reason.includes("NOT terminal ACK"),
        "verdict must explicitly state accepted-send is not terminal ACK",
      );
    });

    it("resolveCleanupReceiptGate rejects notification_delivered", () => {
      const verdict = resolveCleanupReceiptGate("notification_delivered");
      assert.equal(verdict.satisfied, false);
      assert.equal(verdict.receiptStatus, "notification_delivered");
      assert.ok(
        verdict.reason.includes("does NOT imply cleanup completion"),
        "verdict must state notification does not imply cleanup",
      );
    });

    it("resolveCleanupReceiptGate accepts operator_acknowledged", () => {
      const verdict = resolveCleanupReceiptGate("operator_acknowledged");
      assert.equal(verdict.satisfied, true);
      assert.equal(verdict.receiptStatus, "operator_acknowledged");
    });

    it("resolveCleanupReceiptGate accepts operator_approved", () => {
      const verdict = resolveCleanupReceiptGate("operator_approved");
      assert.equal(verdict.satisfied, true);
      assert.equal(verdict.receiptStatus, "operator_approved");
    });
  });

  // ── Tests: Gate status projection ──────────────────────────────

  describe("gate status projection", () => {
    it("asserts acceptedSendIsNotTerminalAck is always true", () => {
      const discovery = buildDiscovery({ candidates: [buildSafeCandidate()] });
      const plan = projectCleanupDryRunPlan({ discovery });

      for (const status of [
        "provider_accepted_send",
        "notification_delivered",
        "operator_acknowledged",
        "operator_approved",
      ] as CleanupReceiptStatus[]) {
        const gate = projectCleanupGateStatus(discovery, plan, status);
        assert.equal(
          gate.acceptedSendIsNotTerminalAck,
          true,
          `acceptedSendIsNotTerminalAck must be true for status "${status}"`,
        );
      }
    });

    it("asserts notificationImpliesCleanup is always false", () => {
      const discovery = buildDiscovery({ candidates: [buildSafeCandidate()] });
      const plan = projectCleanupDryRunPlan({ discovery });

      for (const status of [
        "provider_accepted_send",
        "notification_delivered",
        "operator_acknowledged",
        "operator_approved",
      ] as CleanupReceiptStatus[]) {
        const gate = projectCleanupGateStatus(discovery, plan, status);
        assert.equal(
          gate.notificationImpliesCleanup,
          false,
          `notificationImpliesCleanup must be false for status "${status}"`,
        );
      }
    });

    it("safeForCleanup is false when backup is not confirmed", () => {
      const discovery = buildDiscovery({ candidates: [buildSafeCandidate()] });
      const plan = projectCleanupDryRunPlan({ discovery });

      const gate = projectCleanupGateStatus(discovery, plan, "operator_approved", {
        backupConfirmed: false,
      });

      assert.equal(gate.safeForCleanup, false);
      assert.ok(
        gate.warnings.some((w) => w.includes("Backup/checkpoint NOT confirmed")),
        "must warn about missing backup",
      );
    });

    it("safeForCleanup is false when receipt gate is not satisfied", () => {
      const discovery = buildDiscovery({ candidates: [buildSafeCandidate()] });
      const plan = projectCleanupDryRunPlan({ discovery });

      const gate = projectCleanupGateStatus(discovery, plan, "provider_accepted_send", {
        backupConfirmed: true,
      });

      assert.equal(gate.safeForCleanup, false);
      assert.ok(
        gate.warnings.some((w) => w.includes("NOT terminal ACK")),
        "must warn about non-terminal ACK",
      );
    });

    it("safeForCleanup is true when all gates are satisfied", () => {
      const discovery = buildDiscovery({ candidates: [buildSafeCandidate()] });
      const plan = projectCleanupDryRunPlan({ discovery });

      const gate = projectCleanupGateStatus(discovery, plan, "operator_approved", {
        backupConfirmed: true,
        operatorApproved: true,
        approvalTokenValid: true,
      });

      assert.equal(gate.safeForCleanup, true);
    });

    it("warns about blocked candidates", () => {
      const discovery = buildDiscovery({ candidates: [buildBlockedCandidate()] });
      const plan = projectCleanupDryRunPlan({ discovery });

      const gate = projectCleanupGateStatus(discovery, plan, "operator_acknowledged");

      assert.ok(
        gate.warnings.some((w) => w.includes("blocked") || w.includes("valid home-broker")),
        "must warn about blocked candidates",
      );
    });

    it("warns when there are no candidates", () => {
      const discovery = buildDiscovery({ candidates: [] });
      const plan = projectCleanupDryRunPlan({ discovery });

      const gate = projectCleanupGateStatus(discovery, plan, "operator_approved");

      assert.ok(
        gate.warnings.some((w) => w.includes("No cleanup candidates")),
        "must warn when no candidates exist",
      );
    });

    it("dryRun is always true in gate status", () => {
      const discovery = buildDiscovery({ candidates: [buildSafeCandidate()] });
      const plan = projectCleanupDryRunPlan({ discovery });

      for (const status of [
        "provider_accepted_send",
        "notification_delivered",
        "operator_acknowledged",
        "operator_approved",
      ] as CleanupReceiptStatus[]) {
        const gate = projectCleanupGateStatus(discovery, plan, status);
        assert.equal(gate.dryRun, true);
      }
    });

    it("derives operatorAcknowledged from receipt status", () => {
      const discovery = buildDiscovery({ candidates: [buildSafeCandidate()] });
      const plan = projectCleanupDryRunPlan({ discovery });

      const gateNotAck = projectCleanupGateStatus(discovery, plan, "provider_accepted_send");
      assert.equal(gateNotAck.operatorAcknowledged, false);

      const gateAck = projectCleanupGateStatus(discovery, plan, "operator_acknowledged");
      assert.equal(gateAck.operatorAcknowledged, true);
    });
  });

  // ── Tests: Audit entry projection ──────────────────────────────

  describe("audit entry projection", () => {
    it("produces projected audit entries", () => {
      const entry = projectCleanupAuditEntry(
        "dry-run-plan-generated",
        ["candidate-1", "candidate-2"],
        "projected",
        "Plan generated during dry-run — no mutation performed.",
      );

      assert.equal(entry.projected, true);
      assert.equal(entry.action, "dry-run-plan-generated");
      assert.deepEqual(entry.candidateIds, ["candidate-1", "candidate-2"]);
      assert.equal(entry.result, "projected");
    });

    it("marks blocked results correctly", () => {
      const entry = projectCleanupAuditEntry(
        "blocked-candidate-filtered",
        ["candidate-blocked-1"],
        "blocked",
        "Candidate is blocked — may be valid home-broker record.",
      );

      assert.equal(entry.result, "blocked");
      assert.equal(entry.projected, true);
    });

    it("marks requires_approval results correctly", () => {
      const entry = projectCleanupAuditEntry(
        "operator-gated-step-pending",
        ["candidate-high-1"],
        "requires_approval",
        "Step requires operator approval before mutation.",
      );

      assert.equal(entry.result, "requires_approval");
      assert.equal(entry.projected, true);
    });
  });

  // ── Tests: Rollback summary ────────────────────────────────────

  describe("rollback summary", () => {
    it("identifies critical steps", () => {
      const discovery = buildDiscovery({
        candidates: [buildSafeCandidate(), buildHighCandidate(), buildBlockedCandidate()],
      });
      const plan = projectCleanupDryRunPlan({ discovery });

      const summary = buildCleanupRollbackSummary(plan);

      assert.ok(summary.criticalSteps.length > 0, "must identify critical steps");
      assert.ok(summary.runbook.includes("Restore from"), "runbook must mention restore");
      assert.equal(summary.projectedOnly, true);
      assert.ok(summary.affectedCandidates > 0, "must count affected candidates");
    });

    it("returns zero critical steps for safe-only plans", () => {
      const discovery = buildDiscovery({
        candidates: [buildSafeCandidate()],
      });
      const plan = projectCleanupDryRunPlan({ discovery });

      const summary = buildCleanupRollbackSummary(plan);
      assert.equal(summary.criticalSteps.length, 0);
    });
  });

  // ── Tests: Hard safety invariants ──────────────────────────────

  describe("hard safety invariants", () => {
    it("every plan step includes rollback notes", () => {
      const discovery = buildDiscovery({
        candidates: [
          buildSafeCandidate(),
          buildLowCandidate(),
          buildMediumCandidate(),
          buildHighCandidate(),
          buildBlockedCandidate(),
        ],
      });
      const plan = projectCleanupDryRunPlan({ discovery });

      for (const step of plan.steps) {
        assert.ok(step.rollbackNotes.length > 0, `step ${step.stepId} must have rollback notes`);
      }
    });

    it("backupRequired is always true", () => {
      const discovery = buildDiscovery({ candidates: [buildSafeCandidate()] });
      const plan = projectCleanupDryRunPlan({ discovery });
      assert.equal(plan.backupRequired, true);
    });

    it("approvalTokenRequired is always true", () => {
      const discovery = buildDiscovery({ candidates: [] });
      const plan = projectCleanupDryRunPlan({ discovery });
      assert.equal(plan.approvalTokenRequired, true);
    });

    it("dryRun is always true in all projections", () => {
      const discovery = buildDiscovery({ candidates: [buildSafeCandidate()] });
      const plan = projectCleanupDryRunPlan({ discovery });

      assert.equal(discovery.dryRun, true);
      assert.equal(plan.dryRun, true);

      const gate = projectCleanupGateStatus(discovery, plan, "operator_approved");
      assert.equal(gate.dryRun, true);
    });

    it("fails closed for stale worker rows: blocked candidates never become unblocked automatically", () => {
      const discovery = buildDiscovery({
        candidates: [buildBlockedCandidate()],
      });

      const plan = projectCleanupDryRunPlan({ discovery });

      const blockedSteps = plan.steps.filter((s) => s.riskClass === "blocked");
      for (const step of blockedSteps) {
        assert.equal(step.blocked, true);
        assert.equal(step.operatorGated, true);
        assert.ok(step.blockReason, "block reason must exist");
        assert.ok(
          step.blockReason!.toLowerCase().includes("valid"),
          "must note the row may still be valid",
        );
      }
    });

    it("accepted-send never satisfies the receipt gate", () => {
      // This is the core safety property: provider_accepted_send
      // must never be treated as terminal ACK, and no cleanup
      // mutation path can proceed on that basis.

      const discovery = buildDiscovery({ candidates: [buildSafeCandidate()] });
      const plan = projectCleanupDryRunPlan({ discovery });

      // Even with backup confirmed, provider_accepted_send is not enough
      const gate = projectCleanupGateStatus(discovery, plan, "provider_accepted_send", {
        backupConfirmed: true,
      });

      assert.equal(gate.safeForCleanup, false);
      assert.equal(gate.receiptGate.satisfied, false);
      assert.equal(gate.acceptedSendIsNotTerminalAck, true);

      // The receipt gate itself rejects it
      const verdict = resolveCleanupReceiptGate("provider_accepted_send");
      assert.equal(verdict.satisfied, false);
    });

    it("notification delivery never implies cleanup completion", () => {
      const discovery = buildDiscovery({ candidates: [buildSafeCandidate()] });
      const plan = projectCleanupDryRunPlan({ discovery });

      const gate = projectCleanupGateStatus(discovery, plan, "notification_delivered", {
        backupConfirmed: true,
      });

      assert.equal(gate.safeForCleanup, false);
      assert.equal(gate.receiptGate.satisfied, false);
      assert.equal(gate.notificationImpliesCleanup, false);
      assert.equal(gate.operatorAcknowledged, false);
    });
  });
});
