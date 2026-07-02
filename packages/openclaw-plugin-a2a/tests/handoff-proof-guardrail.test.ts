/**
 * Tests for handoff-proof-guardrail (Round 15, #81).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHandoffProofGuard } from "../dist/src/handoff-proof-guardrail.js";
import type { ProofCommandKind, NodeResourceProfile } from "../dist/src/handoff-proof-guardrail.js";

const FIXED_NOW = 1_774_700_000_000;
const now = () => FIXED_NOW;

describe("handoff-proof-guardrail", () => {
  describe("mobile node rejects heavy commands", () => {
    const guard = createHandoffProofGuard({
      nowMs: now,
      delegateTarget: "node-hub",
      nodeProfile: { isMobile: true, isLowResource: true, freeMemoryMb: 600, cpuLoad: 0.3 },
    });

    const mobileSafe: ProofCommandKind[] = ["observe_ping", "observe_dispatch", "observe_ack", "observe_health"];
    const heavy: ProofCommandKind[] = ["full_gate", "full_proof_loop", "full_regression"];

    for (const cmd of mobileSafe) {
      it(`allows ${cmd} on mobile`, () => {
        const result = guard.checkCommand(cmd);
        assert.equal(result.allowed, true);
        assert.equal(result.noGoReasons.length, 0);
      });
    }

    for (const cmd of heavy) {
      it(`blocks ${cmd} on mobile`, () => {
        const result = guard.checkCommand(cmd);
        assert.equal(result.allowed, false);
        assert.ok(result.noGoReasons.includes("mobile_no_heavy"));
        assert.equal(result.delegateTo, "node-hub");
      });
    }
  });

  describe("resource pressure triggers NO-GO", () => {
    it("low memory triggers NO-GO on mobile", () => {
      const guard = createHandoffProofGuard({
        nowMs: now,
        nodeProfile: { isMobile: true, isLowResource: false, freeMemoryMb: 100, cpuLoad: 0.1 },
      });
      const result = guard.checkCommand("observe_ping");
      assert.equal(result.allowed, false);
      assert.ok(result.noGoReasons.includes("memory_pressure"));
    });

    it("high CPU triggers NO-GO on mobile", () => {
      const guard = createHandoffProofGuard({
        nowMs: now,
        nodeProfile: { isMobile: true, isLowResource: false, freeMemoryMb: 500, cpuLoad: 0.95 },
      });
      const result = guard.checkCommand("observe_health");
      assert.equal(result.allowed, false);
      assert.ok(result.noGoReasons.includes("cpu_pressure"));
    });

    it("low memory triggers NO-GO on non-mobile", () => {
      const guard = createHandoffProofGuard({
        nowMs: now,
        memoryThresholdMb: 300,
        nodeProfile: { isMobile: false, isLowResource: false, freeMemoryMb: 200, cpuLoad: 0.1 },
      });
      const result = guard.checkCommand("observe_ping");
      assert.equal(result.allowed, false);
      assert.ok(result.noGoReasons.includes("memory_pressure"));
    });
  });

  describe("healthy node allows all commands", () => {
    const guard = createHandoffProofGuard({
      nowMs: now,
      nodeProfile: { isMobile: false, isLowResource: false, freeMemoryMb: 2000, cpuLoad: 0.2 },
    });

    for (const cmd of [
      "observe_ping", "observe_dispatch", "observe_ack", "observe_health",
      "full_gate", "full_proof_loop", "full_regression",
    ] as ProofCommandKind[]) {
      it(`allows ${cmd} on healthy host`, () => {
        const result = guard.checkCommand(cmd);
        assert.equal(result.allowed, true);
      });
    }
  });

  describe("submitObservation", () => {
    it("returns ok observation for allowed command", () => {
      const guard = createHandoffProofGuard({
        nowMs: now,
        nodeProfile: { isMobile: true, nodeId: "mobileAlpha", freeMemoryMb: 600, cpuLoad: 0.2 },
      });
      const obs = guard.submitObservation("observe_ping", { latencyMs: 42, reachable: true }, 15);
      assert.equal(obs.status, "ok");
      assert.equal(obs.nodeId, "mobileAlpha");
      assert.equal(obs.command, "observe_ping");
      assert.equal(obs.observations.latencyMs, 42);
    });

    it("returns delegated observation for blocked heavy command", () => {
      const guard = createHandoffProofGuard({
        nowMs: now,
        delegateTarget: "node-hub",
        nodeProfile: { isMobile: true, nodeId: "mobileAlpha", freeMemoryMb: 600, cpuLoad: 0.2 },
      });
      const obs = guard.submitObservation("full_gate", { attempted: true }, 5);
      assert.equal(obs.status, "delegated");
      assert.equal(obs.delegatedTo, "node-hub");
      assert.ok(obs.noGoReasons!.includes("mobile_no_heavy"));
    });
  });

  describe("scenario matrix", () => {
    it("returns S1-S5 with correct mobile safety", () => {
      const guard = createHandoffProofGuard({ nowMs: now, delegateTarget: "node-hub" });
      const matrix = guard.createMobileSafeScenarioMatrix();

      assert.equal(matrix.S1.mobileSafe, true);
      assert.equal(matrix.S2.mobileSafe, true);
      assert.equal(matrix.S3.mobileSafe, true);
      assert.equal(matrix.S4.mobileSafe, true);
      assert.equal(matrix.S5.mobileSafe, false);
      assert.equal(matrix.S5.delegateTo, "node-hub");
    });
  });

  describe("assessNoGo", () => {
    it("returns empty for healthy profile", () => {
      const guard = createHandoffProofGuard({
        nowMs: now,
        nodeProfile: { isMobile: false, isLowResource: false, freeMemoryMb: 2000, cpuLoad: 0.1 },
      });
      const reasons = guard.assessNoGo(guard.resolveProfile());
      assert.equal(reasons.length, 0);
    });
  });

  describe("custom delegate target", () => {
    it("delegates to custom target", () => {
      const guard = createHandoffProofGuard({
        nowMs: now,
        delegateTarget: "ci-runner",
        nodeProfile: { isMobile: true, isLowResource: true, freeMemoryMb: 500, cpuLoad: 0.1 },
      });
      const result = guard.checkCommand("full_gate");
      assert.equal(result.delegateTo, "ci-runner");
    });
  });
});
