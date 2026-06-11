/**
 * Source-public execution orchestrator tests (#263).
 *
 * Parent: jinwon-int/a2a-plane#218
 * Run:    a2a-source-public-execution-orchestrator-20260511T023207Z
 *
 * Exercises the source-public execution orchestrator in dry-run/simulate mode
 * without any live execution, visibility changes, or provider sends. Every
 * test must produce simulation artifacts, never real execution.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSourcePublicExecutionPlan,
  simulateSourcePublicExecution,
  validateExecutionPlan,
  projectExecutionStatus,
} from "../dist/src/source-public-execution-orchestrator.js";
import type {
  SourcePublicExecutionPlan,
  ExecutionStatusLevel,
} from "../dist/src/source-public-execution-orchestrator.js";
import type {
  SourcePublicApprovalPacket,
  SourcePublicApprovalRehearsalReport,
} from "../dist/src/source-public-approval-rehearsal.js";
import type { A2ABrokerAdapterPluginRuntimeConfig } from "../dist/config.js";

// ── Config fixtures ────────────────────────────────────────────────

function configActive(): A2ABrokerAdapterPluginRuntimeConfig {
  return {
    plugins: {
      allow: ["a2a-broker-adapter"],
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: {
            baseUrl: "https://broker.internal.example.com",
            requester: {
              id: "operator-main",
              kind: "session",
              role: "hub",
            },
          },
        },
      },
    },
  };
}

function configDisabled(): A2ABrokerAdapterPluginRuntimeConfig {
  return {
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: false,
          config: {},
        },
      },
    },
  };
}

// ── Approval packet fixtures ───────────────────────────────────────

function goCandidatePacket(overrides?: Partial<SourcePublicApprovalPacket>): SourcePublicApprovalPacket {
  return {
    schema: "a2a.source-public.approval-packet.rehearsal.v1",
    dedupeKey: "source-public-approval-packet:jinwon-int/plugin-a2a:test-run:GO_CANDIDATE:1700000000",
    repo: "jinwon-int/plugin-a2a",
    runId: "test-run-go-candidate",
    producedAt: 1700000000,
    currentVisibility: "private",
    targetVisibility: "public",
    approvalPayload: {
      operation: "change_repo_visibility",
      from: "private",
      to: "public",
      requiredGates: [
        "repo_exists", "repo_access", "not_already_public", "no_active_incidents",
        "operator_configured", "plugin_active", "approval_packet_valid",
        "no_secrets_in_branch", "no_runtime_context_in_branch",
        "ci_passing", "review_required", "operator_acknowledgment",
      ],
      passedGates: [
        "repo_exists", "repo_access", "not_already_public", "no_active_incidents",
        "operator_configured", "plugin_active", "approval_packet_valid",
        "no_secrets_in_branch", "no_runtime_context_in_branch",
        "ci_passing", "review_required", "operator_acknowledgment",
      ],
      failedGates: [],
    },
    isRehearsal: true,
    liveExecution: false,
    visibilityChange: false,
    ...overrides,
  };
}

function needsApprovalPacket(): SourcePublicApprovalPacket {
  return {
    schema: "a2a.source-public.approval-packet.rehearsal.v1",
    dedupeKey: "source-public-approval-packet:jinwon-int/plugin-a2a:test-run:NEEDS_OPERATOR_APPROVAL:1700000001",
    repo: "jinwon-int/plugin-a2a",
    runId: "test-run-needs-approval",
    producedAt: 1700000001,
    currentVisibility: "private",
    targetVisibility: "public",
    approvalPayload: {
      operation: "change_repo_visibility",
      from: "private",
      to: "public",
      requiredGates: [
        "repo_exists", "repo_access", "not_already_public", "no_active_incidents",
        "operator_configured", "plugin_active", "approval_packet_valid",
        "no_secrets_in_branch", "no_runtime_context_in_branch",
        "ci_passing", "review_required", "operator_acknowledgment",
      ],
      passedGates: [
        "repo_exists", "repo_access", "not_already_public", "no_active_incidents",
        "operator_configured", "plugin_active", "approval_packet_valid",
        "no_secrets_in_branch", "no_runtime_context_in_branch",
      ],
      failedGates: ["ci_passing", "review_required", "operator_acknowledgment"],
    },
    isRehearsal: true,
    liveExecution: false,
    visibilityChange: false,
  };
}

function noGoPacket(): SourcePublicApprovalPacket {
  return {
    schema: "a2a.source-public.approval-packet.rehearsal.v1",
    dedupeKey: "source-public-approval-packet:jinwon-int/plugin-a2a:test-run:NO_GO:1700000002",
    repo: "jinwon-int/plugin-a2a",
    runId: "test-run-no-go",
    producedAt: 1700000002,
    currentVisibility: "private",
    targetVisibility: "public",
    approvalPayload: {
      operation: "change_repo_visibility",
      from: "private",
      to: "public",
      requiredGates: [
        "repo_exists", "repo_access", "not_already_public", "no_active_incidents",
        "operator_configured", "plugin_active", "approval_packet_valid",
        "no_secrets_in_branch", "no_runtime_context_in_branch",
        "ci_passing", "review_required", "operator_acknowledgment",
      ],
      passedGates: [
        "repo_access", "not_already_public", "no_active_incidents",
        "operator_configured", "plugin_active", "approval_packet_valid",
      ],
      failedGates: [
        "repo_exists", "no_secrets_in_branch", "no_runtime_context_in_branch",
        "ci_passing", "review_required", "operator_acknowledgment",
      ],
    },
    isRehearsal: true,
    liveExecution: false,
    visibilityChange: false,
  };
}

// ── Rehearsal report fixture (wrapping a packet) ───────────────────

function rehearsalReport(packet: SourcePublicApprovalPacket): SourcePublicApprovalRehearsalReport {
  return {
    schema: "a2a.source-public.rehearsal-report.v1",
    version: 1,
    runId: packet.runId,
    decision: packet.approvalPayload.failedGates.length === 0
      ? "GO_CANDIDATE"
      : packet.approvalPayload.failedGates.includes("repo_exists")
        ? "NO_GO"
        : "NEEDS_OPERATOR_APPROVAL",
    producedAt: packet.producedAt,
    approvalPacket: packet,
    evidenceBundle: {
      schema: "a2a.source-public.evidence-bundle.rehearsal.v1",
      runId: packet.runId,
      approvalPacket: packet,
      evidenceUrls: {
        issue: "https://github.com/jinwon-int/plugin-a2a/issues/263",
        startComment: "https://github.com/jinwon-int/plugin-a2a/issues/263#issuecomment-1",
      },
      gates: [],
      decision: packet.approvalPayload.failedGates.length === 0 ? "GO_CANDIDATE" : "NEEDS_OPERATOR_APPROVAL",
      decisionRationale: "test rehearsal report",
    },
    terminalBrief: {
      schema: "a2a.source-public.terminal-brief.rehearsal.v1",
      line: "test terminal brief line",
      markers: {
        isRehearsal: true,
        isTerminalAck: false,
        isApproval: false,
        isLiveProviderSend: false,
        isProductionDeploy: false,
      },
      evidenceBundleDedupeKey: packet.dedupeKey,
      abortPath: "test abort path",
    },
    abortAvailable: true,
    rollbackPath: "test rollback path",
    safetyInvariants: {
      liveExecution: false,
      visibilityChange: false,
      isRehearsal: true,
      noApprovalExecution: true,
      noReleasePublication: true,
      noProviderSend: true,
      noTerminalAck: true,
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("source-public execution orchestrator (#263)", () => {
  // ── Plan construction ──────────────────────────────────────────

  describe("buildSourcePublicExecutionPlan", () => {
    it("produces a valid execution plan from a GO_CANDIDATE approval packet", () => {
      const packet = goCandidatePacket();
      const config = configActive();
      const plan = buildSourcePublicExecutionPlan(
        { approvalPacket: packet },
        config,
        { runId: "test-exec-go-001" },
      );

      // Structural invariants
      assert.equal(plan.schema, "a2a.source-public.execution-plan.simulate.v1");
      assert.equal(plan.version, 1);
      assert.equal(plan.runId, "test-exec-go-001");
      assert.equal(plan.mode, "dry_run");
      assert.equal(plan.decision, "GO_CANDIDATE");
      assert.ok(plan.producedAt > 0);

      // Safety invariants
      assert.equal(plan.safetyInvariants.liveExecution, false);
      assert.equal(plan.safetyInvariants.visibilityChange, false);
      assert.equal(plan.safetyInvariants.isSimulation, true);
      assert.equal(plan.safetyInvariants.noApprovalExecution, true);
      assert.equal(plan.safetyInvariants.noReleasePublication, true);
      assert.equal(plan.safetyInvariants.noProviderSend, true);
      assert.equal(plan.safetyInvariants.noTerminalAck, true);
      assert.equal(plan.safetyInvariants.noDeploy, true);
      assert.equal(plan.safetyInvariants.noDbMutation, true);
      assert.equal(plan.safetyInvariants.operatorGated, true);

      // Steps
      assert.ok(plan.steps.length >= 10, `expected >=10 steps, got ${plan.steps.length}`);

      // First step should be operator review
      assert.equal(plan.steps[0].kind, "operator_review");
      assert.equal(plan.steps[0].operatorGated, true);

      // Execution step must be sim-only
      const execStep = plan.steps.find((s) => s.kind === "execute_approval");
      assert.ok(execStep, "should have execute_approval step");
      assert.equal(execStep!.simulateOnly, true);

      // Visibility change step must be sim-only
      const visStep = plan.steps.find((s) => s.kind === "visibility_change");
      assert.ok(visStep, "should have visibility_change step");
      assert.equal(visStep!.simulateOnly, true);

      // Preflight
      assert.ok(plan.preflight.checks.length > 0);
      assert.ok(plan.preflight.passed);

      // Binding
      assert.ok(plan.binding.scannerArtifacts.manifestDigest.startsWith("sha256:"));
      assert.equal(plan.binding.scannerArtifacts.evidenceSource, `source-public-approval-packet:${packet.runId}`);

      // Idempotency
      assert.ok(plan.idempotency.dedupeKey.includes(packet.repo));
      assert.ok(plan.idempotency.dedupeKey.includes(packet.dedupeKey));
      assert.equal(plan.idempotency.registered, false);
      assert.equal(plan.idempotency.replayDetected, false);
      assert.ok(plan.idempotency.nonce.length > 0);

      // Runbook
      assert.equal(plan.runbook.abortAvailable, true);
      assert.ok(plan.runbook.globalAbortPath.length > 0);
      assert.equal(Object.keys(plan.runbook.partialRollbacks).length, plan.steps.length);
    });

    it("produces a NEEDS_OPERATOR_APPROVAL plan from a packet with waivable failures", () => {
      const packet = needsApprovalPacket();
      const config = configActive();
      const plan = buildSourcePublicExecutionPlan(
        { approvalPacket: packet },
        config,
        { runId: "test-exec-needs-001" },
      );

      assert.equal(plan.decision, "NEEDS_OPERATOR_APPROVAL");
      assert.ok(plan.decisionRationale.includes("NEEDS_OPERATOR_APPROVAL"));
      assert.ok(plan.projectedOutcome.requiresOperatorAcknowledgment);
    });

    it("produces a NO_GO plan from a packet with hard-blocker failures", () => {
      const packet = noGoPacket();
      const config = configActive();
      const plan = buildSourcePublicExecutionPlan(
        { approvalPacket: packet },
        config,
        { runId: "test-exec-nogo-001" },
      );

      assert.equal(plan.decision, "NO_GO");
      assert.ok(plan.decisionRationale.includes("NO_GO"));
      assert.equal(plan.preflight.passed, false);

      // First step should still be operator review
      assert.equal(plan.steps[0].kind, "operator_review");

      // Second step should be the abort step for NO_GO
      const abortStep = plan.steps.find((s) => s.kind === "abort");
      assert.ok(abortStep, "NO_GO plan should have an abort step");

      // All non-review steps should be blocked
      const blockedSteps = plan.steps.filter((s) =>
        (s.description ?? "").startsWith("[BLOCKED by NO_GO]"),
      );
      assert.ok(blockedSteps.length > 0, "should have blocked steps");
    });

    it("accepts a full rehearsal report as input", () => {
      const packet = goCandidatePacket();
      const report = rehearsalReport(packet);
      const config = configActive();
      const plan = buildSourcePublicExecutionPlan(
        { approvalPacket: report },
        config,
        { runId: "test-exec-from-report-001" },
      );

      assert.equal(plan.decision, "GO_CANDIDATE");
      assert.equal(plan.sourcePacket.dedupeKey, packet.dedupeKey);
    });

    it("binds evidence URLs when provided", () => {
      const packet = goCandidatePacket();
      const config = configActive();
      const evidenceUrls = {
        issue: "https://github.com/jinwon-int/plugin-a2a/issues/263",
        pullRequest: "https://github.com/jinwon-int/plugin-a2a/pull/264",
        startComment: "https://github.com/jinwon-int/plugin-a2a/issues/263#issuecomment-1",
        doneComment: "https://github.com/jinwon-int/plugin-a2a/issues/263#issuecomment-done",
        blockComment: "https://github.com/jinwon-int/plugin-a2a/issues/263#issuecomment-block",
      };

      const plan = buildSourcePublicExecutionPlan(
        { approvalPacket: packet, evidenceUrls },
        config,
        { runId: "test-exec-bind-001" },
      );

      assert.equal(plan.binding.issueUrl, evidenceUrls.issue);
      assert.equal(plan.binding.prUrl, evidenceUrls.pullRequest);
      assert.equal(plan.binding.startCommentUrl, evidenceUrls.startComment);
      assert.equal(plan.binding.doneCommentUrl, evidenceUrls.doneComment);
      assert.equal(plan.binding.blockCommentUrl, evidenceUrls.blockComment);
    });
  });

  // ── Simulate mode ──────────────────────────────────────────────

  describe("simulateSourcePublicExecution", () => {
    it("forces simulate mode", () => {
      const packet = goCandidatePacket();
      const config = configActive();
      const plan = simulateSourcePublicExecution(
        { approvalPacket: packet },
        config,
        { runId: "test-sim-001" },
      );

      assert.equal(plan.mode, "simulate");
      assert.equal(plan.safetyInvariants.liveExecution, false);
    });
  });

  // ── Plan validation ────────────────────────────────────────────

  describe("validateExecutionPlan", () => {
    it("validates a well-formed plan", () => {
      const packet = goCandidatePacket();
      const config = configActive();
      const plan = buildSourcePublicExecutionPlan(
        { approvalPacket: packet },
        config,
        { runId: "test-validate-001" },
      );

      const result = validateExecutionPlan(plan);
      assert.equal(result.valid, true);
    });

    it("rejects a plan with missing runId", () => {
      const packet = goCandidatePacket();
      const config = configActive();
      const plan = buildSourcePublicExecutionPlan(
        { approvalPacket: packet },
        config,
        { runId: "test-validate-002" },
      );

      // Corrupt the plan
      const badPlan = { ...plan, runId: "" };
      const result = validateExecutionPlan(badPlan as SourcePublicExecutionPlan);
      assert.equal(result.valid, false);
      assert.ok(Array.isArray((result as { valid: false; errors: string[] }).errors));
    });

    it("rejects a plan with safety invariant violations", () => {
      const packet = goCandidatePacket();
      const config = configActive();
      const plan = buildSourcePublicExecutionPlan(
        { approvalPacket: packet },
        config,
        { runId: "test-validate-003" },
      );

      // Corrupt safety invariants
      const badPlan = {
        ...plan,
        safetyInvariants: { ...plan.safetyInvariants, liveExecution: true as const },
      };
      const result = validateExecutionPlan(badPlan as SourcePublicExecutionPlan);
      assert.equal(result.valid, false);
    });
  });

  // ── Status projection ──────────────────────────────────────────

  describe("projectExecutionStatus", () => {
    it("projects ready status for GO_CANDIDATE plan", () => {
      const packet = goCandidatePacket();
      const config = configActive();
      const plan = buildSourcePublicExecutionPlan(
        { approvalPacket: packet },
        config,
        { runId: "test-status-001" },
      );

      const projection = projectExecutionStatus(plan);
      assert.equal(projection.schema, "a2a.source-public.execution-status.projection.v1");
      assert.equal(projection.decision, "GO_CANDIDATE");
      assert.equal(projection.status, "ready");
      assert.equal(projection.preflightPassed, true);
      assert.ok(projection.operatorGatedStepCount > 0);
      assert.ok(projection.totalStepCount > 0);
      assert.equal(projection.safetyInvariants.liveExecution, false);
      assert.ok(projection.summary.includes("Ready"));
    });

    it("projects awaiting_operator status for NEEDS_OPERATOR_APPROVAL", () => {
      const packet = needsApprovalPacket();
      const config = configActive();
      const plan = buildSourcePublicExecutionPlan(
        { approvalPacket: packet },
        config,
        { runId: "test-status-002" },
      );

      const projection = projectExecutionStatus(plan);
      assert.equal(projection.status, "awaiting_operator");
      assert.equal(projection.decision, "NEEDS_OPERATOR_APPROVAL");
    });

    it("projects blocked status for NO_GO plan", () => {
      const packet = noGoPacket();
      const config = configActive();
      const plan = buildSourcePublicExecutionPlan(
        { approvalPacket: packet },
        config,
        { runId: "test-status-003" },
      );

      const projection = projectExecutionStatus(plan);
      assert.equal(projection.status, "blocked");
      assert.equal(projection.decision, "NO_GO");
      assert.equal(projection.preflightPassed, false);
    });

    it("includes scanner/history binding URLs in projection", () => {
      const packet = goCandidatePacket();
      const config = configActive();
      const evidenceUrls = {
        issue: "https://github.com/jinwon-int/plugin-a2a/issues/263",
        startComment: "https://github.com/jinwon-int/plugin-a2a/issues/263#issuecomment-1",
      };

      const plan = buildSourcePublicExecutionPlan(
        { approvalPacket: packet, evidenceUrls },
        config,
        { runId: "test-status-bind-001" },
      );

      const projection = projectExecutionStatus(plan);
      assert.equal(projection.binding.issueUrl, evidenceUrls.issue);
      assert.equal(projection.binding.startCommentUrl, evidenceUrls.startComment);
    });
  });

  // ── Idempotency / replay protection ────────────────────────────

  describe("idempotency and replay protection", () => {
    it("produces deterministic dedupe keys for the same packet", () => {
      const packet = goCandidatePacket();
      const config = configActive();

      const plan1 = buildSourcePublicExecutionPlan(
        { approvalPacket: packet },
        config,
        { runId: "test-idem-001", now: () => 1700000000 },
      );
      const plan2 = buildSourcePublicExecutionPlan(
        { approvalPacket: packet },
        config,
        { runId: "test-idem-001", now: () => 1700000000 },
      );

      assert.equal(plan1.idempotency.dedupeKey, plan2.idempotency.dedupeKey);
      assert.equal(plan1.idempotency.nonce, plan2.idempotency.nonce);
    });

    it("produces different dedupe keys for different packets", () => {
      const packet1 = goCandidatePacket();
      const packet2 = goCandidatePacket({
        dedupeKey: "different-packet-key",
      });
      const config = configActive();

      const plan1 = buildSourcePublicExecutionPlan(
        { approvalPacket: packet1 },
        config,
        { runId: "test-idem-002" },
      );
      const plan2 = buildSourcePublicExecutionPlan(
        { approvalPacket: packet2 },
        config,
        { runId: "test-idem-002" },
      );

      assert.notEqual(plan1.idempotency.dedupeKey, plan2.idempotency.dedupeKey);
    });

    it("never registers the dedupe key (always false in this round)", () => {
      const packet = goCandidatePacket();
      const config = configActive();
      const plan = buildSourcePublicExecutionPlan(
        { approvalPacket: packet },
        config,
        { runId: "test-idem-003" },
      );

      assert.equal(plan.idempotency.registered, false);
      assert.equal(plan.idempotency.replayDetected, false);
    });
  });

  // ── Rollback / abort runbook ───────────────────────────────────

  describe("rollback and abort runbook", () => {
    it("has abort available for all steps", () => {
      const packet = goCandidatePacket();
      const config = configActive();
      const plan = buildSourcePublicExecutionPlan(
        { approvalPacket: packet },
        config,
        { runId: "test-runbook-001" },
      );

      assert.equal(plan.runbook.abortAvailable, true);
      assert.ok(plan.runbook.globalAbortPath.length > 0);

      for (const step of plan.steps) {
        const rollback = plan.runbook.partialRollbacks[step.order];
        assert.ok(rollback, `step ${step.order} should have a rollback path`);
        assert.ok(rollback.length > 0);
      }
    });

    it("every step has both rollback and abort actions", () => {
      const packet = goCandidatePacket();
      const config = configActive();
      const plan = buildSourcePublicExecutionPlan(
        { approvalPacket: packet },
        config,
        { runId: "test-runbook-002" },
      );

      for (const step of plan.steps) {
        assert.ok(step.rollbackAction.length > 0, `step ${step.order} (${step.kind}) missing rollbackAction`);
        assert.ok(step.abortAction.length > 0, `step ${step.order} (${step.kind}) missing abortAction`);
      }
    });
  });

  // ── Safety invariants ──────────────────────────────────────────

  describe("safety invariants", () => {
    it("never allows liveExecution in any plan", () => {
      const modes = ["dry_run" as const, "simulate" as const];
      for (const mode of modes) {
        const packet = goCandidatePacket();
        const config = configActive();
        const plan = buildSourcePublicExecutionPlan(
          { approvalPacket: packet, mode },
          config,
        );

        assert.equal(plan.safetyInvariants.liveExecution, false);
        assert.equal(plan.safetyInvariants.visibilityChange, false);
        assert.equal(plan.safetyInvariants.noApprovalExecution, true);
        assert.equal(plan.safetyInvariants.noProviderSend, true);
        assert.equal(plan.safetyInvariants.noTerminalAck, true);
        assert.equal(plan.safetyInvariants.noDeploy, true);
        assert.equal(plan.safetyInvariants.noDbMutation, true);
      }
    });

    it("execute_approval and visibility_change steps are always simulateOnly", () => {
      const packet = goCandidatePacket();
      const config = configActive();
      const plan = buildSourcePublicExecutionPlan(
        { approvalPacket: packet },
        config,
      );

      const execSteps = plan.steps.filter((s) =>
        s.kind === "execute_approval" || s.kind === "visibility_change",
      );
      for (const step of execSteps) {
        assert.equal(step.simulateOnly, true, `step ${step.kind} must be simulateOnly`);
      }
    });
  });

  // ── Preflight failure semantics ────────────────────────────────

  describe("preflight failure semantics", () => {
    it("fails preflight when plugin is disabled", () => {
      const packet = goCandidatePacket();
      const config = configDisabled();
      const plan = buildSourcePublicExecutionPlan(
        { approvalPacket: packet },
        config,
        { runId: "test-prefail-001" },
      );

      const pluginCheck = plan.preflight.checks.find((c) => c.check === "plugin_active");
      assert.ok(pluginCheck);
      assert.equal(pluginCheck.passed, false);
      assert.equal(plan.preflight.passed, false);
    });

    it("fails preflight when repo is already public", () => {
      const packet = goCandidatePacket({
        currentVisibility: "public",
        approvalPayload: {
          operation: "change_repo_visibility",
          from: "public",
          to: "public",
          requiredGates: [],
          passedGates: [],
          failedGates: [],
        },
      });
      const config = configActive();
      const plan = buildSourcePublicExecutionPlan(
        { approvalPacket: packet },
        config,
        { runId: "test-prefail-002" },
      );

      const repoCheck = plan.preflight.checks.find((c) => c.check === "repo_not_already_public");
      assert.ok(repoCheck);
      assert.equal(repoCheck.passed, false);
      assert.equal(plan.preflight.passed, false);
    });

    it("includes remediation hints for failures", () => {
      const packet = goCandidatePacket({
        currentVisibility: "public",
        approvalPayload: {
          operation: "change_repo_visibility",
          from: "public",
          to: "public",
          requiredGates: [],
          passedGates: [],
          failedGates: [],
        },
      });
      const config = configActive();
      const plan = buildSourcePublicExecutionPlan(
        { approvalPacket: packet },
        config,
        { runId: "test-prefail-003" },
      );

      const repoCheck = plan.preflight.checks.find((c) => c.check === "repo_not_already_public");
      assert.ok(repoCheck?.remediation, "should have remediation hint");
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles missing evidence URLs gracefully", () => {
      const packet = goCandidatePacket();
      const config = configActive();
      const plan = buildSourcePublicExecutionPlan(
        { approvalPacket: packet },
        config,
        { runId: "test-edge-001" },
      );

      assert.equal(plan.binding.issueUrl, undefined);
      assert.equal(plan.binding.prUrl, undefined);
      assert.ok(plan.binding.scannerArtifacts.manifestDigest.length > 0);
    });

    it("operator-gated steps are present and explicit", () => {
      const packet = goCandidatePacket();
      const config = configActive();
      const plan = buildSourcePublicExecutionPlan(
        { approvalPacket: packet },
        config,
      );

      const gatedSteps = plan.steps.filter((s) => s.operatorGated);
      assert.ok(gatedSteps.length >= 3, `expected >=3 operator-gated steps, got ${gatedSteps.length}`);

      // Verify key operator-gated steps exist
      const gatedKinds = new Set(gatedSteps.map((s) => s.kind));
      assert.ok(gatedKinds.has("operator_review"), "operator_review should be operator-gated");
      assert.ok(gatedKinds.has("execute_approval"), "execute_approval should be operator-gated");
      assert.ok(gatedKinds.has("preflight_check") || gatedKinds.has("terminal_acknowledge"),
        "preflight or terminal should be operator-gated");
    });

    it("projected outcome reflects SIMULATED ONLY for visibility changes", () => {
      const packet = goCandidatePacket();
      const config = configActive();
      const plan = buildSourcePublicExecutionPlan(
        { approvalPacket: packet },
        config,
      );

      assert.ok(
        plan.projectedOutcome.projectedVisibilityChanges.some((s) => s.includes("SIMULATED ONLY")),
      );
    });
  });
});

// ── Re-export nothing (test file) ──────────────────────────────────


describe("NO_GO plan integrity (a2a-nexus#575 items 11-12)", () => {
  it("reindexes every step uniquely so the rollback runbook keeps all rows", () => {
    const plan = buildSourcePublicExecutionPlan(
      { approvalPacket: noGoPacket() },
      configActive(),
      { runId: "test-exec-nogo-orders-001" },
    );
    assert.equal(plan.decision, "NO_GO");

    // Pre-fix the abort step kept order 0 ([0, 0, 2, 3, ...]); the runbook
    // keys rows by step.order, so the abort step overwrote the operator-
    // review step's rollback path and key 1 was missing.
    const orders = plan.steps.map((s) => s.order);
    assert.deepEqual(
      orders,
      plan.steps.map((_, i) => i),
      "step orders must be unique and sequential",
    );
    for (const step of plan.steps) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(plan.runbook.partialRollbacks, step.order),
        `runbook must have a rollback row for step ${step.order}`,
      );
    }
    assert.equal(
      Object.keys(plan.runbook.partialRollbacks).length,
      plan.steps.length,
      "one runbook row per step",
    );
  });

  it("labels audit digests sha256 only when they actually are SHA-256", () => {
    const plan = buildSourcePublicExecutionPlan(
      { approvalPacket: goCandidatePacket() },
      configActive(),
      { runId: "test-exec-digest-001" },
    );
    // Pre-fix this was a 64-bit FNV-1a hash (16 hex chars) labeled sha256:.
    assert.match(plan.binding.scannerArtifacts.manifestDigest, /^sha256:[0-9a-f]{64}$/);
    assert.match(plan.idempotency.nonce, /^sha256:[0-9a-f]{64}$/);
  });
});
