// Broker-level durable wave plan persistence + restart resume (#1357 G3-c).
// A running wave, its stage cursor, and its retry budget must survive a broker
// restart through the ordinary snapshot path — and re-evaluate gates identically.
import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryA2ABroker } from "./broker.js";

function retryOnceSpec() {
  return {
    wavePlanId: "wave-recovery-1",
    stages: [
      { id: "design", dispatch: { manifestRef: "m-design" }, gate: { type: "quorum", minSubstantive: 2 }, onGateFail: "retry-once" },
      { id: "closeout", gate: { type: "approval" } },
    ],
  };
}

test("a running wave plan survives a broker restart with identical state", () => {
  const broker = new InMemoryA2ABroker();
  broker.createWavePlan(retryOnceSpec());
  broker.startWavePlan("wave-recovery-1");
  broker.reportWaveStageEvidence("wave-recovery-1", { substantiveCount: 1 }); // not met -> retry-once consumed, stays running

  const before = broker.getWavePlan("wave-recovery-1");
  assert.equal(before?.state, "running");
  assert.deepEqual(before?.retriedStages, [0]);

  const restarted = new InMemoryA2ABroker(undefined, broker.exportSnapshot());
  const after = restarted.getWavePlan("wave-recovery-1");
  assert.deepEqual(after, before, "wave plan state/currentStage/retriedStages restored identically");

  // The retry budget is spent, so the same failing evidence now halts on both.
  assert.equal(restarted.reportWaveStageEvidence("wave-recovery-1", { substantiveCount: 1 }).state, "halted");
});

test("a completed wave plan round-trips and stays terminal after restart", () => {
  const broker = new InMemoryA2ABroker();
  broker.createWavePlan({
    wavePlanId: "wave-recovery-2",
    stages: [{ id: "only", gate: { type: "approval" } }],
  });
  broker.startWavePlan("wave-recovery-2");
  broker.reportWaveStageEvidence("wave-recovery-2", { approvalGranted: true });
  assert.equal(broker.advanceWavePlan("wave-recovery-2").state, "completed");

  const restarted = new InMemoryA2ABroker(undefined, broker.exportSnapshot());
  assert.equal(restarted.getWavePlan("wave-recovery-2")?.state, "completed");
});

test("sweepStalledWavePlans emits one wave.stalled audit event per stall", () => {
  const broker = new InMemoryA2ABroker();
  broker.createWavePlan(retryOnceSpec());
  broker.startWavePlan("wave-recovery-1");

  // Sweep far in the future so the running wave is well past any threshold.
  const future = Date.parse("2030-01-01T00:00:00.000Z");
  const stalled = broker.sweepStalledWavePlans(3_600_000, future);
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].wavePlanId, "wave-recovery-1");

  const events = broker.listAuditEvents({ action: "wave.stalled" });
  assert.equal(events.length, 1);
  assert.equal(events[0].targetType, "wave-plan");

  // A second sweep does not re-warn (dedup) until the wave makes progress.
  assert.equal(broker.sweepStalledWavePlans(3_600_000, future).length, 0);
  assert.equal(broker.listAuditEvents({ action: "wave.stalled" }).length, 1);
});
