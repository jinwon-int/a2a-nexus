import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMobileSafetyLane } from "../dist/src/mobile-safety-lane.js";

describe("mobile-safety-lane", () => {
  describe("default mobile profile", () => {
    it("allows fanout with lightweight proof on mobile", () => {
      const lane = createMobileSafetyLane({
        nodeId: "mobileAlpha",
        profile: { isMobile: true, isLowResource: true },
      });
      const result = lane.evaluate("fanout");
      assert.ok(result.ok);
      assert.equal(result.lane, "full");
      assert.equal(result.proofLevel, "lightweight");
    });

    it("allows review with lightweight proof on mobile", () => {
      const lane = createMobileSafetyLane({
        nodeId: "mobileAlpha",
        profile: { isMobile: true, isLowResource: true },
      });
      const result = lane.evaluate("review");
      assert.ok(result.ok);
      assert.equal(result.lane, "full");
      assert.equal(result.proofLevel, "lightweight");
    });

    it("returns observe-only for swarm mode on mobile", () => {
      const lane = createMobileSafetyLane({
        nodeId: "mobileAlpha",
        profile: { isMobile: true, isLowResource: true },
      });
      const result = lane.evaluate("swarm");
      assert.ok(result.ok);
      assert.equal(result.lane, "observe");
      assert.equal(result.proofLevel, "none");
    });

    it("returns NO-GO for split mode on mobile", () => {
      const lane = createMobileSafetyLane({
        nodeId: "mobileAlpha",
        profile: { isMobile: true, isLowResource: true },
        handoffTargets: ["node-hub"],
      });
      const result = lane.evaluate("split");
      assert.ok(!result.ok);
      if (result.ok) return;
      assert.equal(result.signal.type, "team_assignment_no_go");
      assert.equal(result.signal.nodeId, "mobileAlpha");
      assert.equal(result.signal.observeOnly, true);
      assert.deepEqual(result.signal.handoffTargets, ["node-hub"]);
    });
  });

  describe("default non-mobile profile", () => {
    it("allows all modes with full proof", () => {
      const lane = createMobileSafetyLane({
        nodeId: "node-hub",
        profile: { isMobile: false, isLowResource: false },
        laneConfig: {
          allowedModes: ["fanout", "split", "review", "swarm"],
          observeOnlyModes: [],
        },
      });
      for (const mode of ["fanout", "split", "review", "swarm"]) {
        const result = lane.evaluate(mode);
        assert.ok(result.ok);
        if (!result.ok) return;
        assert.equal(result.proofLevel, "full");
      }
    });
  });

  describe("GitHub write handoff", () => {
    it("mobile node should handoff GitHub writes", () => {
      const lane = createMobileSafetyLane({
        profile: { isMobile: true, canPushToGitHub: false, githubWriteHandoff: "node-hub" },
      });
      assert.equal(lane.shouldHandoffGitHubWrite(), true);
      assert.equal(lane.githubWriteTarget(), "node-hub");
    });

    it("non-mobile node should not handoff GitHub writes", () => {
      const lane = createMobileSafetyLane({
        profile: { isMobile: false, canPushToGitHub: true },
      });
      assert.equal(lane.shouldHandoffGitHubWrite(), false);
    });
  });

  describe("NO-GO signal shape", () => {
    it("includes all required fields", () => {
      const lane = createMobileSafetyLane({
        nodeId: "mobileAlpha",
        profile: { isMobile: true, isLowResource: true },
        handoffTargets: ["node-hub", "worker-alpha"],
        nowMs: () => 1_700_000_000_000,
      });
      const signal = lane.noGoSignal("test reason");
      assert.deepEqual(signal, {
        type: "team_assignment_no_go",
        nodeId: "mobileAlpha",
        reason: "test reason",
        timestampMs: 1_700_000_000_000,
        observeOnly: true,
        handoffTargets: ["node-hub", "worker-alpha"],
      });
    });
  });

  describe("capability profile", () => {
    it("mobile profile has correct defaults", () => {
      const lane = createMobileSafetyLane({
        profile: { isMobile: true, isLowResource: true },
      });
      const p = lane.profile();
      assert.equal(p.maxConcurrentTasks, 1);
      assert.equal(p.canRunHeavyProof, false);
      assert.equal(p.canPushToGitHub, false);
    });

    it("allows overriding mobile defaults", () => {
      const lane = createMobileSafetyLane({
        profile: { isMobile: true, isLowResource: true, maxConcurrentTasks: 2 },
      });
      assert.equal(lane.profile().maxConcurrentTasks, 2);
    });
  });

  describe("custom lane config", () => {
    it("custom allowed modes override defaults", () => {
      const lane = createMobileSafetyLane({
        profile: { isMobile: true, isLowResource: true },
        laneConfig: { allowedModes: ["fanout", "split"], observeOnlyModes: [] },
      });
      assert.ok(lane.evaluate("fanout").ok);
      assert.ok(lane.evaluate("split").ok);
      assert.ok(!lane.evaluate("swarm").ok);
    });
  });
});
