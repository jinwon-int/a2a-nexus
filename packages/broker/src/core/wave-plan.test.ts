// Durable wave plan state machine + gate evaluation (#1357 G3-a/b).
// Pure functions: explicit transition table (illegal transitions fail closed),
// quorum/approval/manual gate evaluation over an evidence summary. Persistence,
// HTTP routes, and resume are separate slices (G3-c).
import test from "node:test";
import assert from "node:assert/strict";

import {
  validateWavePlanSpec,
  startWavePlan,
  evaluateWaveGate,
  reportStageEvidence,
  advanceWavePlan,
  abortWavePlan,
  WavePlanError,
} from "./wave-plan.js";

function twoStageSpec(overrides = {}) {
  return {
    wavePlanId: "wave-1",
    stages: [
      { id: "design", dispatch: { manifestRef: "m-design" }, gate: { type: "quorum", minSubstantive: 2 } },
      { id: "closeout", gate: { type: "approval" } },
    ],
    ...overrides,
  };
}

test("validateWavePlanSpec accepts a well-formed spec as a draft and rejects malformed specs (fail-closed)", () => {
  const plan = validateWavePlanSpec(twoStageSpec());
  assert.equal(plan.state, "draft");
  assert.equal(plan.currentStage, 0);
  assert.equal(plan.stages.length, 2);

  assert.throws(() => validateWavePlanSpec({ wavePlanId: "x", stages: [] }), /at least one stage/);
  assert.throws(() => validateWavePlanSpec({ wavePlanId: "x", stages: [{ id: "s", gate: { type: "quorum" } }] }), /minSubstantive/);
  assert.throws(() => validateWavePlanSpec({ wavePlanId: "x", stages: [{ id: "s", gate: { type: "bogus" } }] }), /gate type/);
  assert.throws(() => validateWavePlanSpec({ wavePlanId: "x", stages: [{ gate: { type: "manual" } }] }), /stage id/);
  assert.throws(() => validateWavePlanSpec({ wavePlanId: "x", stages: [{ id: "a", gate: { type: "manual" } }, { id: "a", gate: { type: "manual" } }] }), /duplicate stage id/);
  assert.throws(() => validateWavePlanSpec({ wavePlanId: "x", stages: [{ id: "s", gate: { type: "quorum", minSubstantive: 1 }, onGateFail: "nope" }] }), /onGateFail/);
});

test("evaluateWaveGate: quorum meets at/above threshold; approval and manual need their explicit signal", () => {
  assert.equal(evaluateWaveGate({ type: "quorum", minSubstantive: 2 }, { substantiveCount: 2 }).met, true);
  assert.equal(evaluateWaveGate({ type: "quorum", minSubstantive: 2 }, { substantiveCount: 1 }).met, false);
  assert.equal(evaluateWaveGate({ type: "quorum", minSubstantive: 2 }, {}).met, false);
  assert.equal(evaluateWaveGate({ type: "approval" }, { approvalGranted: true }).met, true);
  assert.equal(evaluateWaveGate({ type: "approval" }, {}).met, false);
  assert.equal(evaluateWaveGate({ type: "manual" }, { manualPass: true }).met, true);
  assert.equal(evaluateWaveGate({ type: "manual" }, { manualPass: false }).met, false);
});

test("start transitions draft -> running; starting a non-draft plan fails closed", () => {
  const plan = startWavePlan(validateWavePlanSpec(twoStageSpec()));
  assert.equal(plan.state, "running");
  assert.throws(() => startWavePlan(plan), (e) => e instanceof WavePlanError && e.code === "wave_illegal_transition");
});

test("gate met -> stage_ready; advance moves to the next running stage, last stage -> completed", () => {
  let plan = startWavePlan(validateWavePlanSpec(twoStageSpec()));
  plan = reportStageEvidence(plan, { substantiveCount: 3 }); // design quorum met
  assert.equal(plan.state, "stage_ready");
  plan = advanceWavePlan(plan);
  assert.equal(plan.state, "running");
  assert.equal(plan.currentStage, 1);
  plan = reportStageEvidence(plan, { approvalGranted: true }); // closeout approval met
  assert.equal(plan.state, "stage_ready");
  plan = advanceWavePlan(plan);
  assert.equal(plan.state, "completed");
});

test("advance before the gate is met is rejected (wave_gate_not_met)", () => {
  let plan = startWavePlan(validateWavePlanSpec(twoStageSpec()));
  assert.throws(() => advanceWavePlan(plan), (e) => e instanceof WavePlanError && e.code === "wave_gate_not_met");
  plan = reportStageEvidence(plan, { substantiveCount: 0 }); // not met, default onGateFail halt
  assert.equal(plan.state, "halted");
  assert.throws(() => advanceWavePlan(plan), (e) => e instanceof WavePlanError && e.code === "wave_illegal_transition");
});

test("onGateFail retry-once allows one more running attempt, then halts", () => {
  const spec = twoStageSpec({
    stages: [
      { id: "design", dispatch: { manifestRef: "m-design" }, gate: { type: "quorum", minSubstantive: 2 }, onGateFail: "retry-once" },
      { id: "closeout", gate: { type: "approval" } },
    ],
  });
  let plan = startWavePlan(validateWavePlanSpec(spec));
  plan = reportStageEvidence(plan, { substantiveCount: 1 }); // not met, retry-once -> stays running
  assert.equal(plan.state, "running");
  assert.equal(plan.currentStage, 0);
  plan = reportStageEvidence(plan, { substantiveCount: 1 }); // still not met, retry spent -> halted
  assert.equal(plan.state, "halted");
});

test("abort is allowed from running/stage_ready/halted and is terminal", () => {
  let plan = startWavePlan(validateWavePlanSpec(twoStageSpec()));
  plan = abortWavePlan(plan);
  assert.equal(plan.state, "aborted");
  assert.throws(() => abortWavePlan(plan), (e) => e instanceof WavePlanError && e.code === "wave_illegal_transition");
  assert.throws(() => advanceWavePlan(plan), (e) => e instanceof WavePlanError && e.code === "wave_illegal_transition");
});

test("transitions are pure — inputs are not mutated (resume determinism precondition)", () => {
  const plan = startWavePlan(validateWavePlanSpec(twoStageSpec()));
  const snapshot = JSON.stringify(plan);
  reportStageEvidence(plan, { substantiveCount: 3 });
  assert.equal(JSON.stringify(plan), snapshot, "reportStageEvidence must not mutate its input");
});

test("reportStageEvidence emits a stage_ready signal payload the broker can surface as an event/audit", () => {
  let plan = startWavePlan(validateWavePlanSpec(twoStageSpec()));
  plan = reportStageEvidence(plan, { substantiveCount: 2 });
  assert.equal(plan.state, "stage_ready");
  // the privileged next-stage dispatch is NOT taken here — only the ready signal is recorded.
  assert.equal(plan.currentStage, 0, "stage_ready does not auto-advance (privileged action is the operator's)");
});
