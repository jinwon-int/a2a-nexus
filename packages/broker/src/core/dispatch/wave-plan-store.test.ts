// Wave plan persistence + resume determinism + stale detection (#1357 G3-c).
import test from "node:test";
import assert from "node:assert/strict";

import { WavePlanStore } from "./wave-plan-store.js";
import { WavePlanError } from "./wave-plan.js";

let tick = 0;
function fixedClock(startIso: string) {
  const base = Date.parse(startIso);
  return () => new Date(base + tick++ * 1000);
}

function twoStageSpec() {
  return {
    wavePlanId: "wave-1",
    stages: [
      { id: "design", dispatch: { manifestRef: "m-design" }, gate: { type: "quorum", minSubstantive: 2 } },
      { id: "closeout", gate: { type: "approval" } },
    ],
  };
}

test("create registers a draft and stamps updatedAt; duplicate ids fail closed", () => {
  const store = new WavePlanStore();
  const plan = store.create(twoStageSpec());
  assert.equal(plan.state, "draft");
  assert.deepEqual(store.list().map((p) => p.wavePlanId), ["wave-1"]);
  assert.throws(() => store.create(twoStageSpec()), (e) => e instanceof WavePlanError && e.code === "wave_spec_invalid");
});

test("transitions on unknown ids fail closed", () => {
  const store = new WavePlanStore();
  assert.throws(() => store.start("nope"), (e) => e instanceof WavePlanError && e.code === "wave_illegal_transition");
});

test("snapshot -> restore round-trips a running wave to identical state (resume determinism)", () => {
  tick = 0;
  const store = new WavePlanStore([], { now: fixedClock("2026-07-07T00:00:00.000Z") });
  store.create(twoStageSpec());
  store.start("wave-1"); // running, mid-flight, first stage gate not yet reported
  const blob = JSON.parse(JSON.stringify(store.snapshot()));

  // A fresh broker process reloads the persisted blob.
  const resumed = new WavePlanStore(blob, { now: fixedClock("2026-07-07T09:00:00.000Z") });
  assert.deepEqual(resumed.snapshot(), blob, "restore is a byte-identical round-trip");
  const before = store.get("wave-1");
  const after = resumed.get("wave-1");
  assert.deepEqual(after, before, "wave state (state/currentStage/retriedStages) survives restart identically");
});

test("gate re-evaluation is identical across a restart (deterministic resume)", () => {
  tick = 0;
  const store = new WavePlanStore([], { now: fixedClock("2026-07-07T00:00:00.000Z") });
  store.create(twoStageSpec());
  store.start("wave-1");
  const blob = JSON.parse(JSON.stringify(store.snapshot()));

  const resumed = new WavePlanStore(blob, { now: fixedClock("2026-07-07T09:00:00.000Z") });
  // Same evidence -> same gate decision -> same next state on both instances.
  const a = store.reportEvidence("wave-1", { substantiveCount: 2 });
  const b = resumed.reportEvidence("wave-1", { substantiveCount: 2 });
  assert.equal(a.state, "stage_ready");
  assert.equal(b.state, "stage_ready");
  assert.equal(a.currentStage, b.currentStage);
});

test("findStalled flags live plans idle past the threshold, once per stall", () => {
  tick = 0;
  const store = new WavePlanStore([], { now: fixedClock("2026-07-07T00:00:00.000Z") });
  store.create(twoStageSpec());
  const started = store.start("wave-1"); // updatedAt = ...:01
  assert.equal(started.state, "running");

  const startedAtMs = Date.parse(store.snapshot()[0].updatedAt);
  const oneHour = 3_600_000;

  // Not yet stale.
  assert.equal(store.findStalled(2 * oneHour, startedAtMs + oneHour).length, 0);

  // Stale after the threshold.
  const stalled = store.findStalled(oneHour, startedAtMs + 2 * oneHour);
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].wavePlanId, "wave-1");
  assert.equal(stalled[0].stageId, "design");
  assert.ok(stalled[0].idleMs >= oneHour);

  // Once notified, it is not re-flagged on the next sweep.
  store.markStalledNotified("wave-1");
  assert.equal(store.findStalled(oneHour, startedAtMs + 3 * oneHour).length, 0);

  // A real transition clears the stall flag, so a fresh stall warns again.
  store.reportEvidence("wave-1", { substantiveCount: 2 }); // -> stage_ready, updatedAt bumped
  const reStalled = store.findStalled(oneHour, Date.parse(store.snapshot()[0].updatedAt) + 2 * oneHour);
  assert.equal(reStalled.length, 1);
  assert.equal(reStalled[0].state, "stage_ready");
});

test("terminal plans are never flagged as stalled", () => {
  tick = 0;
  const store = new WavePlanStore([], { now: fixedClock("2026-07-07T00:00:00.000Z") });
  store.create(twoStageSpec());
  store.start("wave-1");
  store.abort("wave-1");
  assert.equal(store.findStalled(1, Date.parse("2030-01-01T00:00:00.000Z")).length, 0);
});
