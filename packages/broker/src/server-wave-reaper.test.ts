// Stale wave-plan reaper wiring (#1357 G3-c follow-up): the broker method
// sweepStalledWavePlans existed but nothing called it in production, so a
// stalled wave could never emit its wave.stalled warning live. The sweep now
// rides the existing stale-task reaper interval, gated by waveStaleAfterSec
// (WAVE_STALE_AFTER_SEC, 0 = disabled). Warn-only — never auto-aborts.
import test from "node:test";
import assert from "node:assert/strict";

import { startTestServer } from "./server-test-helpers.js";

const HUB_HEADERS = {
  "content-type": "application/json",
  "x-a2a-requester-id": "test-hub",
  "x-a2a-requester-role": "hub",
};

test("the reaper interval emits wave.stalled for an idle running wave, once per stall", async () => {
  const server = await startTestServer({
    staleReaperEnabled: true,
    staleReaperIntervalSec: 1,
    waveStaleAfterSec: 1,
  });
  try {
    const created = await fetch(`${server.baseUrl}/wave-plans`, {
      method: "POST",
      headers: HUB_HEADERS,
      body: JSON.stringify({
        wavePlanId: "wave-reaper-e2e",
        stages: [{ id: "design", gate: { type: "quorum", minSubstantive: 2 } }],
      }),
    });
    assert.equal(created.status, 201);
    const started = await fetch(`${server.baseUrl}/wave-plans/wave-reaper-e2e/start`, {
      method: "POST",
      headers: HUB_HEADERS,
      body: "{}",
    });
    assert.equal(started.status, 200);

    // Idle past waveStaleAfterSec across several 1s sweeps.
    await new Promise((resolve) => setTimeout(resolve, 3200));

    const audit = await (await fetch(`${server.baseUrl}/audit?action=wave.stalled`, { headers: HUB_HEADERS })).json();
    assert.equal(audit.items.length, 1, "exactly one wave.stalled warning per stall (sweeps must dedup)");
    assert.equal(audit.items[0].targetType, "wave-plan");
    assert.equal(audit.items[0].targetId, "wave-reaper-e2e");

    // Warn-only contract: the wave itself is untouched.
    const plan = await (await fetch(`${server.baseUrl}/wave-plans/wave-reaper-e2e`, { headers: HUB_HEADERS })).json();
    assert.equal(plan.plan.state, "running", "the reaper never auto-aborts");

    const health = await (await fetch(`${server.baseUrl}/health`)).json();
    assert.equal(health.staleReaper.waveStaleAfterSec, 1);
  } finally {
    await server.close();
  }
});

test("waveStaleAfterSec 0 disables the wave sweep and surfaces as disabled in health", async () => {
  const server = await startTestServer({
    staleReaperEnabled: true,
    staleReaperIntervalSec: 1,
    waveStaleAfterSec: 0,
  });
  try {
    await fetch(`${server.baseUrl}/wave-plans`, {
      method: "POST",
      headers: HUB_HEADERS,
      body: JSON.stringify({
        wavePlanId: "wave-reaper-off",
        stages: [{ id: "design", gate: { type: "quorum", minSubstantive: 2 } }],
      }),
    });
    await fetch(`${server.baseUrl}/wave-plans/wave-reaper-off/start`, {
      method: "POST",
      headers: HUB_HEADERS,
      body: "{}",
    });

    await new Promise((resolve) => setTimeout(resolve, 2200));

    const audit = await (await fetch(`${server.baseUrl}/audit?action=wave.stalled`, { headers: HUB_HEADERS })).json();
    assert.equal(audit.items.length, 0, "disabled sweep must not emit wave.stalled");

    const health = await (await fetch(`${server.baseUrl}/health`)).json();
    assert.equal(health.staleReaper.waveStaleAfterSec, 0);
  } finally {
    await server.close();
  }
});
