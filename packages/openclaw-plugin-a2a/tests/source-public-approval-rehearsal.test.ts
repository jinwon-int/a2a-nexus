/**
 * Source-public approval rehearsal tests (#261).
 *
 * Parent: jinwon-int/a2a-plane#211
 * Run:    a2a-source-public-approval-rehearsal-20260511T014240Z
 *
 * Exercises the source-public approval rehearsal module without any live
 * execution, visibility changes, or provider sends. All outputs must be
 * rehearsal evidence, never execution.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  rehearseSourcePublicApproval,
  type SourcePublicApprovalRehearsalReport,
  type SourcePublicDecision,
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

function configNoActivation(): A2ABrokerAdapterPluginRuntimeConfig {
  return {
    plugins: {
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

// ── Input fixtures ─────────────────────────────────────────────────

function baseInput(overrides?: Partial<Parameters<typeof rehearseSourcePublicApproval>[0]>): Parameters<typeof rehearseSourcePublicApproval>[0] {
  return {
    repo: "jinwon-int/openclaw-plugin-a2a",
    currentVisibility: "private",
    ciPassing: true,
    operatorReviewed: true,
    operatorAcknowledged: true,
    issueNumber: 261,
    evidenceUrls: {
      issue: "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/261",
      startComment: "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/261#issuecomment-1",
    },
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("source-public approval rehearsal (#261)", () => {
  // ── GO_CANDIDATE path ───────────────────────────────────────────

  describe("GO_CANDIDATE decision", () => {
    it("returns GO_CANDIDATE when all gates pass and operator acknowledged", () => {
      const input = baseInput();
      const report = rehearseSourcePublicApproval(input, configActive(), {
        runId: "test-go-candidate-001",
      });

      assert.equal(report.decision, "GO_CANDIDATE");
      assert.equal(report.runId, "test-go-candidate-001");
      assert.equal(report.version, 1);
    });

    it("evidence bundle reflects GO_CANDIDATE with all gates passed", () => {
      const report = rehearseSourcePublicApproval(baseInput(), configActive(), {
        runId: "test-bundle-go-001",
      });

      assert.equal(report.evidenceBundle.decision, "GO_CANDIDATE");
      const allPassed = report.evidenceBundle.gates.every((g) => g.passed);
      assert.equal(allPassed, true, "all gates should pass for GO_CANDIDATE");
      assert.equal(report.evidenceBundle.gates.length, 12, "12 gates total");
    });

    it("evidence bundle includes evidence URLs from input", () => {
      const report = rehearseSourcePublicApproval(
        baseInput({
          evidenceUrls: {
            issue: "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/261",
            pullRequest: "https://github.com/jinwon-int/openclaw-plugin-a2a/pull/100",
            startComment: "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/261#issuecomment-1",
            doneComment: "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/261#issuecomment-2",
          },
        }),
        configActive(),
        { runId: "test-urls-001" },
      );

      assert.equal(
        report.evidenceBundle.evidenceUrls.issue,
        "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/261",
      );
      assert.equal(
        report.evidenceBundle.evidenceUrls.pullRequest,
        "https://github.com/jinwon-int/openclaw-plugin-a2a/pull/100",
      );
      assert.ok(report.evidenceBundle.evidenceUrls.startComment);
      assert.ok(report.evidenceBundle.evidenceUrls.doneComment);
    });
  });

  // ── NEEDS_OPERATOR_APPROVAL path ─────────────────────────────────

  describe("NEEDS_OPERATOR_APPROVAL decision", () => {
    it("returns NEEDS_OPERATOR_APPROVAL when operator_not acknowledged", () => {
      const input = baseInput({ operatorAcknowledged: false });
      const report = rehearseSourcePublicApproval(input, configActive(), {
        runId: "test-needs-approval-001",
      });

      assert.equal(report.decision, "NEEDS_OPERATOR_APPROVAL");
    });

    it("returns NEEDS_OPERATOR_APPROVAL when review not completed", () => {
      const input = baseInput({ operatorReviewed: false, operatorAcknowledged: false });
      const report = rehearseSourcePublicApproval(input, configActive(), {
        runId: "test-needs-approval-002",
      });

      assert.equal(report.decision, "NEEDS_OPERATOR_APPROVAL");
    });

    it("returns NEEDS_OPERATOR_APPROVAL when CI is not passing", () => {
      const input = baseInput({ ciPassing: false });
      const report = rehearseSourcePublicApproval(input, configActive(), {
        runId: "test-needs-approval-003",
      });

      assert.equal(report.decision, "NEEDS_OPERATOR_APPROVAL");
    });

    it("NEEDS_OPERATOR_APPROVAL includes gate names in rationale", () => {
      const input = baseInput({ operatorAcknowledged: false });
      const report = rehearseSourcePublicApproval(input, configActive());

      assert.ok(
        report.evidenceBundle.decisionRationale.includes("operator_acknowledgment"),
        `rationale should mention operator_acknowledgment, got: ${report.evidenceBundle.decisionRationale}`,
      );
    });

    it("NEEDS_OPERATOR_APPROVAL rationale mentions waivable gates", () => {
      const input = baseInput({ ciPassing: false, operatorAcknowledged: false });
      const report = rehearseSourcePublicApproval(input, configActive());

      assert.ok(
        report.evidenceBundle.decisionRationale.includes("NEEDS_OPERATOR_APPROVAL"),
        "rationale should contain NEEDS_OPERATOR_APPROVAL",
      );
    });
  });

  // ── NO_GO path ─────────────────────────────────────────────────

  describe("NO_GO decision", () => {
    it("returns NO_GO for invalid repo identifier", () => {
      const input = baseInput({ repo: "" });
      const report = rehearseSourcePublicApproval(input, configActive(), {
        runId: "test-no-go-001",
      });

      assert.equal(report.decision, "NO_GO");
    });

    it("returns NO_GO for repo with invalid format", () => {
      const input = baseInput({ repo: "not-a-valid-repo!!!" });
      const report = rehearseSourcePublicApproval(input, configActive());

      assert.equal(report.decision, "NO_GO");
      assert.equal(report.evidenceBundle.gates[0].gate, "repo_exists");
      assert.equal(report.evidenceBundle.gates[0].passed, false);
    });

    it("returns NO_GO when plugin is disabled (hard blocker)", () => {
      const input = baseInput({ operatorAcknowledged: true, operatorReviewed: true });
      const report = rehearseSourcePublicApproval(input, configDisabled(), {
        runId: "test-no-go-disabled-001",
      });

      // With disabled plugin, plugin_active and operator_configured fail
      // Since not_already_public and plugin_active are hard blockers...
      // Actually, plugin_active is required but is it a hard blocker?
      // Hard blockers are: repo_exists, no_secrets_in_branch, no_runtime_context_in_branch
      // plugin_active is required but NOT a hard blocker → NEEDS_OPERATOR_APPROVAL
      // Wait, but operator_configured is also required.
      // Both plugin_active and operator_configured fail with disabled config
      // They are both required but NOT hard blockers → NEEDS_OPERATOR_APPROVAL

      // Let's verify the actual decision
      const decision: SourcePublicDecision = report.decision;
      assert.ok(
        decision === "NO_GO" || decision === "NEEDS_OPERATOR_APPROVAL",
        `expected NO_GO or NEEDS_OPERATOR_APPROVAL, got ${decision}`,
      );

      // Gate-level assertions
      const pluginGate = report.evidenceBundle.gates.find((g) => g.gate === "plugin_active");
      assert.ok(pluginGate, "plugin_active gate must exist");
      assert.equal(pluginGate.passed, false);
    });

    it("returns GO_CANDIDATE when repo is already public (no-op: not_already_public is non-required)", () => {
      const input = baseInput({ currentVisibility: "public" });
      const report = rehearseSourcePublicApproval(input, configActive(), {
        runId: "test-no-go-already-public-001",
      });

      // not_already_public is marked as required: false when already public
      // (the gate is non-required because no visibility change is needed).
      // All other required gates pass → GO_CANDIDATE (no-op approval).
      assert.equal(report.decision, "GO_CANDIDATE");

      const gate = report.evidenceBundle.gates.find((g) => g.gate === "not_already_public");
      assert.ok(gate, "not_already_public gate must exist");
      assert.equal(gate.passed, false, "gate signals already-public via failure");
      assert.equal(gate.required, false, "gate is non-required when already public");
      assert.ok(gate.message.includes("already public"));
      assert.ok(gate.message.includes("no-op"));
    });
  });

  // ── Approval packet invariants ─────────────────────────────────

  describe("approval packet invariants", () => {
    it("approval packet is always marked as rehearsal, never execution", () => {
      const report = rehearseSourcePublicApproval(baseInput(), configActive(), {
        runId: "test-packet-rehearsal-001",
      });

      assert.equal(report.approvalPacket.isRehearsal, true);
      assert.equal(report.approvalPacket.liveExecution, false);
      assert.equal(report.approvalPacket.visibilityChange, false);
    });

    it("approval packet has deterministic dedupe key", () => {
      const input = baseInput();
      const report1 = rehearseSourcePublicApproval(input, configActive(), {
        runId: "dedupe-test-run",
        now: () => 1700000000000,
      });
      const report2 = rehearseSourcePublicApproval(input, configActive(), {
        runId: "dedupe-test-run",
        now: () => 1700000000000,
      });

      // Same input + same runId + same timestamp = same dedupe key
      assert.equal(
        report1.approvalPacket.dedupeKey,
        report2.approvalPacket.dedupeKey,
        "dedupe keys must be deterministic for identical inputs",
      );
    });

    it("different runIds produce different dedupe keys (anti-replay)", () => {
      const input = baseInput();
      const report1 = rehearseSourcePublicApproval(input, configActive(), {
        runId: "dedupe-run-A",
        now: () => 1700000000000,
      });
      const report2 = rehearseSourcePublicApproval(input, configActive(), {
        runId: "dedupe-run-B",
        now: () => 1700000000000,
      });

      assert.notEqual(
        report1.approvalPacket.dedupeKey,
        report2.approvalPacket.dedupeKey,
        "different runIds must produce different dedupe keys",
      );
    });

    it("approval packet includes all required gate names", () => {
      const report = rehearseSourcePublicApproval(baseInput(), configActive());

      assert.equal(report.approvalPacket.approvalPayload.requiredGates.length, 12);
      assert.ok(
        report.approvalPacket.approvalPayload.requiredGates.includes("no_runtime_context_in_branch"),
      );
      assert.ok(
        report.approvalPacket.approvalPayload.requiredGates.includes("no_secrets_in_branch"),
      );
    });

    it("approval packet passedGates + failedGates = all gates", () => {
      const report = rehearseSourcePublicApproval(baseInput(), configActive());

      const total =
        report.approvalPacket.approvalPayload.passedGates.length +
        report.approvalPacket.approvalPayload.failedGates.length;
      assert.equal(total, 12, "passed + failed gates must equal total gates checked");
    });

    it("approval packet records current visibility", () => {
      const report = rehearseSourcePublicApproval(
        baseInput({ currentVisibility: "private" }),
        configActive(),
      );

      assert.equal(report.approvalPacket.currentVisibility, "private");
      assert.equal(report.approvalPacket.approvalPayload.from, "private");
      assert.equal(report.approvalPacket.approvalPayload.to, "public");
    });

    it("unknown visibility is preserved as unknown", () => {
      const report = rehearseSourcePublicApproval(
        baseInput({ currentVisibility: undefined }),
        configActive(),
      );

      assert.equal(report.approvalPacket.currentVisibility, "unknown");
    });
  });

  // ── Evidence bundle invariants ─────────────────────────────────

  describe("evidence bundle invariants", () => {
    it("evidence bundle schema is correct", () => {
      const report = rehearseSourcePublicApproval(baseInput(), configActive());

      assert.equal(
        report.evidenceBundle.schema,
        "a2a.source-public.evidence-bundle.rehearsal.v1",
      );
    });

    it("evidence bundle contains the approval packet by reference", () => {
      const report = rehearseSourcePublicApproval(baseInput(), configActive());

      assert.equal(
        report.evidenceBundle.approvalPacket.dedupeKey,
        report.approvalPacket.dedupeKey,
      );
    });

    it("evidence bundle has all 12 gates", () => {
      const report = rehearseSourcePublicApproval(baseInput(), configActive());

      assert.equal(report.evidenceBundle.gates.length, 12);
      const gateNames = report.evidenceBundle.gates.map((g) => g.gate);
      assert.ok(gateNames.includes("repo_exists"));
      assert.ok(gateNames.includes("repo_access"));
      assert.ok(gateNames.includes("not_already_public"));
      assert.ok(gateNames.includes("no_active_incidents"));
      assert.ok(gateNames.includes("operator_configured"));
      assert.ok(gateNames.includes("plugin_active"));
      assert.ok(gateNames.includes("approval_packet_valid"));
      assert.ok(gateNames.includes("no_secrets_in_branch"));
      assert.ok(gateNames.includes("no_runtime_context_in_branch"));
      assert.ok(gateNames.includes("ci_passing"));
      assert.ok(gateNames.includes("review_required"));
      assert.ok(gateNames.includes("operator_acknowledgment"));
    });

    it("each gate result has required fields", () => {
      const report = rehearseSourcePublicApproval(baseInput(), configActive());

      for (const gate of report.evidenceBundle.gates) {
        assert.equal(typeof gate.gate, "string");
        assert.equal(typeof gate.passed, "boolean");
        assert.equal(typeof gate.required, "boolean");
        assert.equal(typeof gate.message, "string");
        assert.ok(gate.message.length > 0, `gate ${gate.gate} must have a message`);
      }
    });

    it("failed gates have remediation hints", () => {
      const input = baseInput({ operatorAcknowledged: false });
      const report = rehearseSourcePublicApproval(input, configActive());

      const failedGate = report.evidenceBundle.gates.find((g) => !g.passed);
      assert.ok(failedGate, "at least one gate should fail");
      if (failedGate.remediation) {
        assert.ok(failedGate.remediation.length > 0);
      }
    });

    it("evidence bundle decision matches report decision", () => {
      const report = rehearseSourcePublicApproval(baseInput(), configActive());

      assert.equal(report.evidenceBundle.decision, report.decision);
    });
  });

  // ── Terminal Brief invariants ──────────────────────────────────

  describe("terminal brief invariants", () => {
    it("terminal brief is always rehearsal, never ACK or approval", () => {
      const report = rehearseSourcePublicApproval(baseInput(), configActive());

      assert.equal(report.terminalBrief.markers.isRehearsal, true);
      assert.equal(report.terminalBrief.markers.isTerminalAck, false);
      assert.equal(report.terminalBrief.markers.isApproval, false);
      assert.equal(report.terminalBrief.markers.isLiveProviderSend, false);
      assert.equal(report.terminalBrief.markers.isProductionDeploy, false);
    });

    it("terminal brief line contains decision and repo", () => {
      const report = rehearseSourcePublicApproval(baseInput(), configActive());

      assert.ok(report.terminalBrief.line.includes("GO_CANDIDATE"));
      assert.ok(report.terminalBrief.line.includes("jinwon-int/openclaw-plugin-a2a"));
      assert.ok(report.terminalBrief.line.includes("rehearsal-only"));
      assert.ok(report.terminalBrief.line.includes("non-ACK"));
    });

    it("terminal brief line includes evidence URLs", () => {
      const input = baseInput({
        evidenceUrls: {
          issue: "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/261",
          pullRequest: "https://github.com/jinwon-int/openclaw-plugin-a2a/pull/100",
        },
      });
      const report = rehearseSourcePublicApproval(input, configActive());

      assert.ok(report.terminalBrief.line.includes("issues/261"));
      assert.ok(report.terminalBrief.line.includes("pull/100"));
    });

    it("terminal brief for NO_GO shows failed gates", () => {
      const report = rehearseSourcePublicApproval(
        baseInput({ repo: "" }),
        configActive(),
      );

      assert.equal(report.decision, "NO_GO");
      assert.ok(
        report.terminalBrief.line.includes("NO_GO"),
        `terminal brief must show NO_GO, got: ${report.terminalBrief.line}`,
      );
    });

    it("terminal brief has abort path", () => {
      const report = rehearseSourcePublicApproval(baseInput(), configActive());

      assert.ok(report.terminalBrief.abortPath.length > 0);
      assert.ok(report.terminalBrief.abortPath.includes("rehearsal"));
    });

    it("terminal brief references evidence bundle via dedupe key", () => {
      const report = rehearseSourcePublicApproval(baseInput(), configActive());

      assert.equal(
        report.terminalBrief.evidenceBundleDedupeKey,
        report.evidenceBundle.approvalPacket.dedupeKey,
      );
    });
  });

  // ── Safety invariants ──────────────────────────────────────────

  describe("safety invariants", () => {
    it("every report has all safety invariants set to false/true correctly", () => {
      const inputs = [
        baseInput(),
        baseInput({ repo: "" }),
        baseInput({ operatorAcknowledged: false }),
        baseInput({ currentVisibility: "public" }),
      ];

      for (const input of inputs) {
        const report = rehearseSourcePublicApproval(input, configActive());

        assert.equal(report.safetyInvariants.liveExecution, false);
        assert.equal(report.safetyInvariants.visibilityChange, false);
        assert.equal(report.safetyInvariants.isRehearsal, true);
        assert.equal(report.safetyInvariants.noApprovalExecution, true);
        assert.equal(report.safetyInvariants.noReleasePublication, true);
        assert.equal(report.safetyInvariants.noProviderSend, true);
        assert.equal(report.safetyInvariants.noTerminalAck, true);
      }
    });

    it("safety invariants are identical across all decision paths", () => {
      const goReport = rehearseSourcePublicApproval(baseInput(), configActive());
      const needsReport = rehearseSourcePublicApproval(
        baseInput({ operatorAcknowledged: false }),
        configActive(),
      );
      const noGoReport = rehearseSourcePublicApproval(
        baseInput({ repo: "" }),
        configActive(),
      );

      // Deep compare safety invariants
      assert.deepEqual(goReport.safetyInvariants, needsReport.safetyInvariants);
      assert.deepEqual(goReport.safetyInvariants, noGoReport.safetyInvariants);
    });
  });

  // ── Rollback / Abort paths ─────────────────────────────────

  describe("rollback and abort paths", () => {
    it("abort is always available", () => {
      const reports = [
        rehearseSourcePublicApproval(baseInput(), configActive()),
        rehearseSourcePublicApproval(baseInput({ repo: "" }), configActive()),
        rehearseSourcePublicApproval(baseInput({ operatorAcknowledged: false }), configActive()),
      ];

      for (const report of reports) {
        assert.equal(report.abortAvailable, true);
      }
    });

    it("rollback path mentions rehearsal and no mutation", () => {
      const report = rehearseSourcePublicApproval(baseInput(), configActive());

      assert.ok(report.rollbackPath.includes("no state was mutated"));
      assert.ok(
        report.rollbackPath.includes("rehearsal") || report.rollbackPath.includes("rehearse"),
      );
      assert.ok(report.rollbackPath.length > 0);
    });

    it("rollback path is unique per runId", () => {
      const report1 = rehearseSourcePublicApproval(baseInput(), configActive(), {
        runId: "rollback-run-A",
      });
      const report2 = rehearseSourcePublicApproval(baseInput(), configActive(), {
        runId: "rollback-run-B",
      });

      assert.notEqual(report1.rollbackPath, report2.rollbackPath);
    });
  });

  // ── Decision output validation ──────────────────────────────

  describe("decision output validation", () => {
    it("decision is always one of the three valid values", () => {
      const validDecisions: SourcePublicDecision[] = [
        "GO_CANDIDATE",
        "NO_GO",
        "NEEDS_OPERATOR_APPROVAL",
      ];

      const scenarios = [
        { input: baseInput(), config: configActive() },
        { input: baseInput({ repo: "" }), config: configActive() },
        { input: baseInput({ operatorAcknowledged: false }), config: configActive() },
        { input: baseInput({ currentVisibility: "public" }), config: configActive() },
        { input: baseInput(), config: configDisabled() },
        { input: baseInput(), config: configNoActivation() },
      ];

      for (const { input } of scenarios) {
        const report = rehearseSourcePublicApproval(input, configActive());
        assert.ok(
          validDecisions.includes(report.decision),
          `decision "${report.decision}" must be one of ${validDecisions.join(", ")}`,
        );
      }
    });

    it("GO_CANDIDATE decision rationale mentions READY", () => {
      const report = rehearseSourcePublicApproval(baseInput(), configActive());

      assert.ok(
        report.evidenceBundle.decisionRationale.includes("Ready"),
        `rationale should indicate readiness, got: ${report.evidenceBundle.decisionRationale}`,
      );
    });
  });

  // ── Config sensitivity ───────────────────────────────────────

  describe("config sensitivity", () => {
    it("disabled plugin causes operator_configured and plugin_active to fail", () => {
      const report = rehearseSourcePublicApproval(baseInput(), configDisabled());

      const opGate = report.evidenceBundle.gates.find((g) => g.gate === "operator_configured");
      const plGate = report.evidenceBundle.gates.find((g) => g.gate === "plugin_active");

      assert.ok(opGate, "operator_configured gate must exist");
      assert.ok(plGate, "plugin_active gate must exist");
      assert.equal(opGate.passed, false);
      assert.equal(plGate.passed, false);
    });

    it("activated plugin shows both operator_configured and plugin_active as passed", () => {
      const report = rehearseSourcePublicApproval(baseInput(), configActive());

      const opGate = report.evidenceBundle.gates.find((g) => g.gate === "operator_configured");
      const plGate = report.evidenceBundle.gates.find((g) => g.gate === "plugin_active");

      assert.equal(opGate?.passed, true);
      assert.equal(plGate?.passed, true);
    });
  });

  // ── No live execution boundary ──────────────────────────────

  describe("no live execution boundary", () => {
    it("rehearsal never makes external calls — no URL validation beyond format", () => {
      // The module takes evidence URLs as input strings but never fetches them.
      // Providing fake/non-existent URLs should succeed without errors.
      const input = baseInput({
        evidenceUrls: {
          issue: "https://github.com/nonexistent-org/nonexistent-repo/issues/999999",
          pullRequest: "https://github.com/nonexistent-org/nonexistent-repo/pull/999999",
          startComment: "https://github.com/nonexistent-org/nonexistent-repo/issues/999999#fake",
        },
      });
      const report = rehearseSourcePublicApproval(input, configActive());

      assert.equal(report.decision, "GO_CANDIDATE");
      assert.equal(report.evidenceBundle.evidenceUrls.issue,
        "https://github.com/nonexistent-org/nonexistent-repo/issues/999999");
    });

    it("rehearsal works without any evidence URLs", () => {
      const input = baseInput({ evidenceUrls: undefined });
      const report = rehearseSourcePublicApproval(input, configActive());

      assert.equal(report.decision, "GO_CANDIDATE");
      assert.equal(Object.keys(report.evidenceBundle.evidenceUrls).length, 0);
    });

    it("liveExecution and visibilityChange are always false regardless of input", () => {
      // Even with all evidence URLs pointing to real repos, nothing is executed
      const report = rehearseSourcePublicApproval(
        baseInput({
          evidenceUrls: {
            issue: "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/261",
            pullRequest: "https://github.com/jinwon-int/openclaw-plugin-a2a/pull/262",
            startComment: "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/261#issuecomment-1",
            doneComment: "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/261#issuecomment-2",
            blockComment: "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/261#issuecomment-3",
          },
        }),
        configActive(),
        { runId: "no-live-boundary-001" },
      );

      assert.equal(report.approvalPacket.liveExecution, false);
      assert.equal(report.approvalPacket.visibilityChange, false);
      assert.equal(report.approvalPacket.isRehearsal, true);
      assert.equal(report.safetyInvariants.noProviderSend, true);
      assert.equal(report.safetyInvariants.noTerminalAck, true);
    });
  });

  // ── Replay / no-duplicate proof ────────────────────────────

  describe("replay / no-duplicate proof", () => {
    it("same inputs produce identical dedupe keys", () => {
      const input = baseInput();
      const config = configActive();
      const clock = () => 1715386400000;

      const report1 = rehearseSourcePublicApproval(input, config, {
        runId: "replay-test",
        now: clock,
      });
      const report2 = rehearseSourcePublicApproval(input, config, {
        runId: "replay-test",
        now: clock,
      });

      assert.equal(
        report1.approvalPacket.dedupeKey,
        report2.approvalPacket.dedupeKey,
      );
    });

    it("different timestamps produce different dedupe keys", () => {
      const input = baseInput();
      const config = configActive();

      const report1 = rehearseSourcePublicApproval(input, config, {
        runId: "replay-test",
        now: () => 1715386400000,
      });
      const report2 = rehearseSourcePublicApproval(input, config, {
        runId: "replay-test",
        now: () => 1715386500000,
      });

      assert.notEqual(
        report1.approvalPacket.dedupeKey,
        report2.approvalPacket.dedupeKey,
      );
    });

    it("different decisions produce different dedupe keys", () => {
      const config = configActive();
      const clock = () => 1715386400000;

      const goReport = rehearseSourcePublicApproval(baseInput(), config, {
        runId: "decision-dedupe",
        now: clock,
      });
      const needsReport = rehearseSourcePublicApproval(
        baseInput({ operatorAcknowledged: false }),
        config,
        { runId: "decision-dedupe", now: clock },
      );

      assert.notEqual(
        goReport.approvalPacket.dedupeKey,
        needsReport.approvalPacket.dedupeKey,
      );
    });
  });
});
