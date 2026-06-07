/**
 * Terminal Brief receipt/activation gate plugin no-live proof.
 *
 * Issue:  jinwon-int/openclaw-plugin-a2a#303
 * Run:    a2a-r11-stability-activation-gates-20260513T231046Z
 * Worker: sogyo
 *
 * Proves that the Source-Public Terminal Brief receipt/activation gate
 * functions correctly in the plugin go/no-go projection context without
 * any live execution, provider send, or terminal ACK.
 *
 * Safety gates (all enforced without live execution):
 *  - Terminal Brief markers: isRehearsal=true, isTerminalAck=false,
 *    isApproval=false, isLiveProviderSend=false, isProductionDeploy=false
 *  - Execution plan safety invariants: liveExecution=false,
 *    noProviderSend=true, noTerminalAck=true, noDeploy=true, noDbMutation=true
 *  - Plugin projection safety invariants: confirmed, projectionIsSafe=true
 *  - Plugin projection requiredActions: operator acknowledgment gated
 *
 * This is the definitive no-live proof for the Terminal Brief
 * receipt/activation gate in the plugin projection layer.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  rehearseSourcePublicApproval,
} from "../dist/src/source-public-approval-rehearsal.js";
import {
  buildSourcePublicExecutionPlan,
} from "../dist/src/source-public-execution-orchestrator.js";
import {
  projectPluginGoNoGo,
} from "../dist/src/plugin-go-no-go-projection.js";
import type { A2ABrokerAdapterPluginRuntimeConfig } from "../dist/config.js";

// ── Constants ───────────────────────────────────────────────────────

const TEST_REPO = "jinwon-int/openclaw-plugin-a2a";
const TEST_RUN = "terminal-brief-receipt-gate-no-live-proof-20260513T231046Z";

// ── Config fixtures ─────────────────────────────────────────────────

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

// ── Tests ───────────────────────────────────────────────────────────

describe("Terminal Brief receipt/activation gate plugin no-live proof", () => {
  // ── Terminal Brief markers proof ─────────────────────────────

  describe("Terminal Brief — non-terminal, non-approval, non-live markers", () => {
    it("proof: Terminal Brief markers are hardcoded to safe defaults (no-live)", () => {
      const report = rehearseSourcePublicApproval(
        { repo: TEST_REPO },
        configActive(),
        { runId: TEST_RUN, now: () => 1710000000000 },
      );

      // Terminal Brief markers must prove non-terminal / non-live / non-approval
      assert.equal(report.terminalBrief.markers.isRehearsal, true);
      assert.equal(report.terminalBrief.markers.isTerminalAck, false);
      assert.equal(report.terminalBrief.markers.isApproval, false);
      assert.equal(report.terminalBrief.markers.isLiveProviderSend, false);
      assert.equal(report.terminalBrief.markers.isProductionDeploy, false);
    });

    it("proof: Terminal Brief line explicitly states rehearsal-only and non-ACK", () => {
      const report = rehearseSourcePublicApproval(
        { repo: TEST_REPO },
        configActive(),
        { runId: TEST_RUN, now: () => 1710000000000 },
      );

      const line = report.terminalBrief.line;
      assert.ok(
        line.includes("rehearsal-only"),
        `Terminal Brief line must state rehearsal-only, got: ${line}`,
      );
      assert.ok(
        line.includes("non-ACK"),
        `Terminal Brief line must state non-ACK, got: ${line}`,
      );
      assert.ok(
        line.includes("no-execution"),
        `Terminal Brief line must state no-execution, got: ${line}`,
      );
    });
  });

  // ── Execution plan safety invariants proof ───────────────────

  describe("Execution plan safety invariants — no live execution", () => {
    it("proof: execution plan safety invariants enforce no-live + no-terminal-ACK", () => {
      const report = rehearseSourcePublicApproval(
        { repo: TEST_REPO },
        configActive(),
        { runId: TEST_RUN, now: () => 1710000000000 },
      );

      const plan = buildSourcePublicExecutionPlan(
        { approvalPacket: report },
        configActive(),
        { runId: TEST_RUN, now: () => 1710000001000 },
      );

      // Every safety invariant must be at its safe sentinel
      const si = plan.safetyInvariants;
      assert.equal(si.liveExecution, false);
      assert.equal(si.visibilityChange, false);
      assert.equal(si.isSimulation, true);
      assert.equal(si.noApprovalExecution, true);
      assert.equal(si.noReleasePublication, true);
      assert.equal(si.noProviderSend, true);
      assert.equal(si.noTerminalAck, true);
      assert.equal(si.noDeploy, true);
      assert.equal(si.noDbMutation, true);
      assert.equal(si.operatorGated, true);
    });
  });

  // ── Plugin projection safety invariants proof ────────────────

  describe("Plugin projection — safety and receipt gate", () => {
    it("proof: plugin projection confirms all safety invariants with projectionIsSafe=true", () => {
      const report = rehearseSourcePublicApproval(
        { repo: TEST_REPO },
        configActive(),
        { runId: TEST_RUN, now: () => 1710000000000 },
      );

      const plan = buildSourcePublicExecutionPlan(
        { approvalPacket: report },
        configActive(),
        { runId: TEST_RUN, now: () => 1710000001000 },
      );

      const projection = projectPluginGoNoGo(
        {
          executionPlan: plan,
          metadata: { issueNumber: 303, worker: "sogyo" },
        },
        configActive(),
        { runId: `plugin-${TEST_RUN}`, now: () => 1710000002000 },
      );

      // Safety confirmation: all invariants must hold
      assert.equal(projection.safetyConfirmation.confirmed, true);
      assert.equal(projection.safetyConfirmation.projectionIsSafe, true);

      const invariants = projection.safetyConfirmation.invariants;
      assert.ok(
        invariants.some((i) => i.includes("No live execution")),
        `invariants must include 'No live execution': ${invariants.join("; ")}`,
      );
      assert.ok(
        invariants.some((i) => i.includes("No terminal ACK")),
        `invariants must include 'No terminal ACK': ${invariants.join("; ")}`,
      );
      assert.ok(
        invariants.some((i) => i.includes("No provider send")),
        `invariants must include 'No provider send': ${invariants.join("; ")}`,
      );
      assert.ok(
        invariants.some((i) => i.includes("No approval execution")),
        `invariants must include 'No approval execution': ${invariants.join("; ")}`,
      );
      assert.ok(
        invariants.some((i) => i.includes("No deploy")),
        `invariants must include 'No deploy': ${invariants.join("; ")}`,
      );
      assert.ok(
        invariants.some((i) => i.includes("Operator-gated")),
        `invariants must include 'Operator-gated': ${invariants.join("; ")}`,
      );
    });
  });

  // ── Full chain: Terminal Brief → execution plan → plugin projection ──

  describe("Full chain proof — rehearsal → execution → projection", () => {
    it("proof: complete 3-layer chain preserves no-live semantics", () => {
      // Layer 1: Terminal Brief from rehearsal
      const report = rehearseSourcePublicApproval(
        {
          repo: TEST_REPO,
          currentVisibility: "private",
          evidenceUrls: {
            issue: "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/303",
          },
        },
        configActive(),
        { runId: TEST_RUN, now: () => 1710000000000 },
      );

      // Prove Layer 1: Terminal Brief is non-terminal, non-live
      assert.equal(report.terminalBrief.markers.isTerminalAck, false);
      assert.equal(report.terminalBrief.markers.isLiveProviderSend, false);
      assert.equal(report.terminalBrief.markers.isProductionDeploy, false);
      assert.match(report.terminalBrief.line, /rehearsal-only/);
      assert.match(report.terminalBrief.line, /non-ACK/);
      assert.match(report.terminalBrief.line, /no-execution/);

      // Layer 2: Execution plan from rehearsal report
      const plan = buildSourcePublicExecutionPlan(
        { approvalPacket: report },
        configActive(),
        { runId: TEST_RUN, now: () => 1710000001000 },
      );

      // Prove Layer 2: Plan safety invariants
      assert.equal(plan.safetyInvariants.liveExecution, false);
      assert.equal(plan.safetyInvariants.noTerminalAck, true);
      assert.equal(plan.safetyInvariants.noProviderSend, true);
      assert.equal(plan.safetyInvariants.noDeploy, true);
      assert.equal(plan.safetyInvariants.noDbMutation, true);
      assert.equal(plan.safetyInvariants.operatorGated, true);

      // Layer 3: Plugin go/no-go projection from execution plan
      const projection = projectPluginGoNoGo(
        { executionPlan: plan },
        configActive(),
        { runId: `plugin-${TEST_RUN}`, now: () => 1710000002000 },
      );

      // Prove Layer 3: Plugin projection safety
      assert.equal(projection.safetyConfirmation.confirmed, true);
      assert.equal(projection.safetyConfirmation.projectionIsSafe, true);
      assert.ok(projection.safetyConfirmation.invariants.some(
        (i) => i.includes("No live execution"),
      ));
      assert.ok(projection.safetyConfirmation.invariants.some(
        (i) => i.includes("No terminal ACK"),
      ));

      // Prove Layer 3: Plugin projection requires operator gates
      assert.ok(
        projection.requiredActions.length > 0,
        "plugin projection must require operator action",
      );
    });
  });
});
