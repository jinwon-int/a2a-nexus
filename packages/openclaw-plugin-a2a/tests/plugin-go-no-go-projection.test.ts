/**
 * Plugin final go/no-go projection tests (#265).
 *
 * Parent: jinwon-int/plugin-a2a#263
 * Run:    a2a-plugin-final-go-no-go-projection-20260511T053000Z
 *
 * Exercises the plugin go/no-go projection across all plugin health states
 * (disabled, not-activated, active) and execution plan decisions (GO_CANDIDATE,
 * NEEDS_OPERATOR_APPROVAL, NO_GO). Every test is a projection — nothing executes.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  projectPluginGoNoGo,
} from "../dist/src/plugin-go-no-go-projection.js";
import type {
  PluginGoNoGoProjection,
  PluginGoNoGo,
  PluginGoNoGoReasonCategory,
} from "../dist/src/plugin-go-no-go-projection.js";
import {
  buildSourcePublicExecutionPlan,
  projectExecutionStatus,
} from "../dist/src/source-public-execution-orchestrator.js";
import type {
  SourcePublicExecutionPlan,
} from "../dist/src/source-public-execution-orchestrator.js";
import type {
  SourcePublicApprovalPacket,
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
            operatorEvents: {
              enabled: true,
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

function configNotActivated(): A2ABrokerAdapterPluginRuntimeConfig {
  return {
    plugins: {
      // No allow list entry, no enabled:true — not activated
      entries: {
        "a2a-broker-adapter": {
          config: {
            baseUrl: "https://broker.internal.example.com",
          },
        },
      },
    },
  };
}

function configNoBaseUrl(): A2ABrokerAdapterPluginRuntimeConfig {
  return {
    plugins: {
      allow: ["a2a-broker-adapter"],
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: {
            operatorEvents: {
              enabled: true,
            },
          },
        },
      },
    },
  };
}

function configNoOperatorEvents(): A2ABrokerAdapterPluginRuntimeConfig {
  return {
    plugins: {
      allow: ["a2a-broker-adapter"],
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: {
            baseUrl: "https://broker.internal.example.com",
          },
        },
      },
    },
  };
}

// ── Packet fixtures ────────────────────────────────────────────────

function goCandidatePacket(): SourcePublicApprovalPacket {
  return {
    schema: "a2a.source-public.approval-packet.rehearsal.v1",
    dedupeKey: "source-public-approval-packet:jinwon-int/plugin-a2a:go-candidate:1710000000",
    repo: "jinwon-int/plugin-a2a",
    runId: "test-run-go-candidate",
    producedAt: 1710000000,
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
  };
}

function noGoPacket(): SourcePublicApprovalPacket {
  return {
    ...goCandidatePacket(),
    dedupeKey: "source-public-approval-packet:jinwon-int/plugin-a2a:no-go:1710000001",
    runId: "test-run-no-go",
    producedAt: 1710000001,
    approvalPayload: {
      operation: "change_repo_visibility",
      from: "private",
      to: "public",
      requiredGates: [
        "repo_exists", "repo_access", "not_already_public", "no_active_incidents",
        "operator_configured", "plugin_active", "approval_packet_valid",
        "no_secrets_in_branch", "no_runtime_context_in_branch",
      ],
      passedGates: ["repo_exists", "repo_access"],
      failedGates: ["not_already_public"],
    },
  };
}

function needsApprovalPacket(): SourcePublicApprovalPacket {
  return {
    ...goCandidatePacket(),
    dedupeKey: "source-public-approval-packet:jinwon-int/plugin-a2a:needs-approval:1710000002",
    runId: "test-run-needs-approval",
    producedAt: 1710000002,
    approvalPayload: {
      operation: "change_repo_visibility",
      from: "private",
      to: "public",
      requiredGates: [
        "repo_exists", "repo_access", "no_active_incidents",
        "operator_configured", "plugin_active", "approval_packet_valid",
        "no_secrets_in_branch", "no_runtime_context_in_branch",
        "ci_passing", "review_required", "operator_acknowledgment",
      ],
      passedGates: [
        "repo_exists", "repo_access", "no_active_incidents",
        "operator_configured", "plugin_active", "approval_packet_valid",
        "no_secrets_in_branch", "no_runtime_context_in_branch",
        "ci_passing", "review_required",
      ],
      failedGates: ["operator_acknowledgment"],
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────

function buildPlan(
  packet: SourcePublicApprovalPacket,
  overrides?: {
    decision?: "GO_CANDIDATE" | "NO_GO" | "NEEDS_OPERATOR_APPROVAL";
    decisionRationale?: string;
  },
): SourcePublicExecutionPlan {
  const plan = buildSourcePublicExecutionPlan(
    { approvalPacket: packet, mode: "dry_run" },
    configActive(),
    { runId: packet.runId, now: () => 1710000000 },
  );
  // Override decision if needed by post-processing
  if (overrides) {
    const mutated = structuredClone(plan) as SourcePublicExecutionPlan & {
      decision: string;
      decisionRationale: string;
    };
    if (overrides.decision) mutated.decision = overrides.decision as string;
    if (overrides.decisionRationale) mutated.decisionRationale = overrides.decisionRationale;
    return mutated as SourcePublicExecutionPlan;
  }
  return plan;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("projectPluginGoNoGo", () => {
  // ── Plugin health gating ──────────────────────────────────────

  describe("plugin health gating", () => {
    it("returns NO_GO when plugin is disabled", () => {
      const result = projectPluginGoNoGo(
        {},
        configDisabled(),
        { runId: "test-disabled" },
      );

      assert.equal(result.goNoGo, "NO_GO");
      assert.equal(result.reasonCategory, "plugin_disabled");
      assert.equal(result.pluginHealth.enabled, false);
      assert.ok(result.requiredActions.some((a) => a.blocking));
      assert.ok(result.title.includes("NO_GO"));
      assert.ok(result.title.includes("Blocked"));
    });

    it("returns NO_GO when plugin is not explicitly activated", () => {
      const result = projectPluginGoNoGo(
        {},
        configNotActivated(),
        { runId: "test-not-activated" },
      );

      assert.equal(result.goNoGo, "NO_GO");
      assert.equal(result.reasonCategory, "plugin_not_activated");
      assert.equal(result.pluginHealth.explicitlyActivated, false);
      assert.ok(result.requiredActions.some((a) => a.action.includes("Explicitly")));
    });

    it("returns CONDITIONAL_GO with warning when no baseUrl configured", () => {
      const result = projectPluginGoNoGo(
        {},
        configNoBaseUrl(),
        { runId: "test-no-baseurl" },
      );

      // Without an execution plan, conditional go
      assert.equal(result.goNoGo, "CONDITIONAL_GO");
      assert.equal(result.pluginHealth.brokerConfigured, false);
      assert.ok(result.warnings.some((w) => w.includes("baseUrl")));
    });

    it("returns warning when operator events are disabled", () => {
      const plan = buildPlan(goCandidatePacket());

      const result = projectPluginGoNoGo(
        { executionPlan: plan },
        configNoOperatorEvents(),
        { runId: "test-no-oe" },
      );

      assert.ok(result.warnings.some((w) => w.includes("Operator events")));
    });
  });

  // ── Execution plan integration ────────────────────────────────

  describe("execution plan integration", () => {
    it("returns CONDITIONAL_GO when no execution plan provided", () => {
      const result = projectPluginGoNoGo(
        {},
        configActive(),
        { runId: "test-no-plan" },
      );

      assert.equal(result.goNoGo, "CONDITIONAL_GO");
      assert.equal(result.reasonCategory, "operator_gates_pending");
      assert.ok(result.rationale.includes("No execution plan"));
      assert.ok(result.requiredActions.some((a) => a.action.includes("Run")));
    });

    it("returns GO for a GO_CANDIDATE plan with active plugin", () => {
      const plan = buildPlan(goCandidatePacket());

      const result = projectPluginGoNoGo(
        { executionPlan: plan },
        configActive(),
        { runId: "test-go-candidate" },
      );

      assert.equal(result.goNoGo, "GO");
      assert.equal(result.reasonCategory, "execution_plan_ready");
      assert.ok(result.title.includes("GO"));
      assert.equal(result.pluginHealth.enabled, true);
      assert.equal(result.pluginHealth.operatorEventsEnabled, true);
    });

    it("returns NO_GO for a NO_GO plan", () => {
      const plan = buildPlan(noGoPacket(), {
        decision: "NO_GO",
        decisionRationale: "Repository is already public",
      });

      const result = projectPluginGoNoGo(
        { executionPlan: plan },
        configActive(),
        { runId: "test-no-go-plan" },
      );

      assert.equal(result.goNoGo, "NO_GO");
      assert.ok(result.rationale.includes("already public"));
      assert.ok(result.title.includes("NO_GO"));
    });

    it("returns CONDITIONAL_GO for NEEDS_OPERATOR_APPROVAL plan", () => {
      const plan = buildPlan(needsApprovalPacket());

      const result = projectPluginGoNoGo(
        { executionPlan: plan },
        configActive(),
        { runId: "test-needs-approval" },
      );

      assert.equal(result.goNoGo, "CONDITIONAL_GO");
      assert.equal(result.reasonCategory, "operator_gates_pending");
      assert.ok(result.rationale.includes("NEEDS_OPERATOR_APPROVAL"));
      assert.ok(result.title.includes("CONDITIONAL GO"));
      assert.ok(result.requiredActions.length > 0);
    });

    it("returns NO_GO when preflight has failures", () => {
      const plan = buildPlan(goCandidatePacket());

      // Artificially inject preflight failures
      const planWithFailedPreflight = {
        ...plan,
        preflight: {
          passed: false,
          checks: [
            {
              check: "secret_scan",
              passed: false,
              required: true,
              message: "Secrets found in branch",
              remediation: "Remove secrets before proceeding",
            },
          ],
          failures: ["Secrets found in branch"],
        },
      } as SourcePublicExecutionPlan;

      const result = projectPluginGoNoGo(
        { executionPlan: planWithFailedPreflight },
        configActive(),
        { runId: "test-preflight-fails" },
      );

      assert.equal(result.goNoGo, "NO_GO");
      assert.equal(result.reasonCategory, "preflight_failed");
      assert.ok(result.requiredActions.some((a) => a.action.includes("Remove secrets")));
    });
  });

  // ── Execution status fallback ─────────────────────────────────

  describe("execution status fallback", () => {
    it("reports GO when status projection says ready", () => {
      const plan = buildPlan(goCandidatePacket());
      const status = projectExecutionStatus(plan, { runId: "status-ready" });

      const result = projectPluginGoNoGo(
        { executionStatus: status },
        configActive(),
        { runId: "test-status-ready" },
      );

      assert.equal(result.goNoGo, "GO");
      assert.ok(result.title.includes("GO"));
    });

    it("reports NO_GO when status projection says blocked", () => {
      const plan = buildPlan(noGoPacket(), {
        decision: "NO_GO",
        decisionRationale: "Hard blocker: repo already public",
      });
      const status = projectExecutionStatus(plan, { runId: "status-blocked" });

      const result = projectPluginGoNoGo(
        { executionStatus: status },
        configActive(),
        { runId: "test-status-blocked" },
      );

      assert.equal(result.goNoGo, "NO_GO");
    });

    it("reports CONDITIONAL_GO when status projection says awaiting_operator", () => {
      const plan = buildPlan(needsApprovalPacket());
      const status = projectExecutionStatus(plan, { runId: "status-awaiting" });

      const result = projectPluginGoNoGo(
        { executionStatus: status },
        configActive(),
        { runId: "test-status-awaiting" },
      );

      assert.equal(result.goNoGo, "CONDITIONAL_GO");
    });
  });

  // ── Safety invariants ─────────────────────────────────────────

  describe("safety invariants", () => {
    it("confirms all safety invariants for a valid plan", () => {
      const plan = buildPlan(goCandidatePacket());

      const result = projectPluginGoNoGo(
        { executionPlan: plan },
        configActive(),
        { runId: "test-safety" },
      );

      assert.equal(result.safetyConfirmation.confirmed, true);
      assert.equal(result.safetyConfirmation.projectionIsSafe, true);
      assert.ok(result.safetyConfirmation.invariants.some((i) => i.includes("No live execution")));
      assert.ok(result.safetyConfirmation.invariants.some((i) => i.includes("No approval")));
      assert.ok(result.safetyConfirmation.invariants.some((i) => i.includes("No provider send")));
    });

    it("confirms safety invariants even without a plan", () => {
      const result = projectPluginGoNoGo(
        {},
        configActive(),
        { runId: "test-safety-noplan" },
      );

      assert.equal(result.safetyConfirmation.confirmed, true);
      assert.equal(result.safetyConfirmation.projectionIsSafe, true);
    });
  });

  // ── Projection metadata ───────────────────────────────────────

  describe("projection metadata", () => {
    it("includes schema and runId in every projection", () => {
      const result = projectPluginGoNoGo(
        {},
        configActive(),
        { runId: "test-schema" },
      );

      assert.equal(result.schema, "a2a.plugin.go-no-go.projection.v1");
      assert.equal(result.runId, "test-schema");
      assert.ok(typeof result.producedAt === "number");
      assert.ok(result.producedAt > 0);
    });

    it("passes through metadata", () => {
      const metadata = { issueNumber: 265, parent: "a2a-plane#218" };

      const result = projectPluginGoNoGo(
        { metadata },
        configActive(),
        { runId: "test-metadata" },
      );

      assert.equal(result.metadata.issueNumber, 265);
      assert.equal(result.metadata.parent, "a2a-plane#218");
    });
  });

  // ── Title and summary ─────────────────────────────────────────

  describe("title and summary", () => {
    it("includes repo name in GO title when plan is provided", () => {
      const plan = buildPlan(goCandidatePacket());

      const result = projectPluginGoNoGo(
        { executionPlan: plan },
        configActive(),
        { runId: "test-title" },
      );

      assert.ok(result.title.includes("jinwon-int/plugin-a2a"));
    });

    it("includes step counts in GO summary", () => {
      const plan = buildPlan(goCandidatePacket());

      const result = projectPluginGoNoGo(
        { executionPlan: plan },
        configActive(),
        { runId: "test-summary" },
      );

      assert.ok(result.summary.includes("No visibility change"));
      assert.ok(result.summary.includes("dry-run projection"));
    });
  });
});
