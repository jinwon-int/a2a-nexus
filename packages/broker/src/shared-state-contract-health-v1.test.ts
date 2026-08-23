/**
 * Slice M, second part: `/health` `stateContract` with process reset-risk.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildSharedStateContractHealthV1,
  SHARED_STATE_CONTRACT_PROCESS_RESET_RISK_V1,
} from "./shared-state-contract-health-v1.js";
import { startTestServer, withEnv } from "./server-test-helpers.js";

function assertProcessResetRisk(contract: {
  readonly primitives: {
    readonly replay: unknown;
    readonly rateLimit: unknown;
  };
}): void {
  assert.deepEqual(
    contract.primitives.replay,
    SHARED_STATE_CONTRACT_PROCESS_RESET_RISK_V1,
  );
  assert.deepEqual(
    contract.primitives.rateLimit,
    SHARED_STATE_CONTRACT_PROCESS_RESET_RISK_V1,
  );
  assert.deepEqual(Object.keys(contract.primitives).sort(), [
    "rateLimit",
    "replay",
  ]);
}

test("health module does not import catalog or storage-contract projectors", () => {
  const compiled = readFileSync(
    fileURLToPath(new URL("./shared-state-contract-health-v1.js", import.meta.url)),
    "utf8",
  );
  assert.equal(compiled.includes("shared-state-observability"), false);
  assert.equal(compiled.includes("shared-state-storage-contract"), false);
});

test("builder emits the closed health envelope and process reset-risk", () => {
  const contract = buildSharedStateContractHealthV1({
    configuredGrade: "single-process",
    effectiveGrade: "single-process",
    gradeDefaulted: true,
    expectedProcessCount: 1,
    serving: true,
    ownership: "held",
  });
  assert.equal(contract.specVersion, 1);
  assert.equal(contract.adapter.contractVersion, null);
  assert.equal(contract.adapter.backendClass, "legacy-process");
  assert.equal(contract.topology.ownership, "held");
  assertProcessResetRisk(contract);
  assert.equal(contract.primitives.replay.resetRisk, true);
  assert.equal(contract.primitives.replay.epochAgeBand, "unknown");
  assert.equal(contract.primitives.replay.pressureBand, "unknown");
  assert.equal(contract.primitives.replay.lastResetReason, "process_start");
  const encoded = JSON.stringify(contract);
  assert.equal(encoded.includes("owner_token"), false);
  assert.equal(encoded.includes("/var/lib"), false);
  assert.equal(encoded.includes("nonce"), false);
  assert.equal(encoded.includes("bucket"), false);
});

test("builder keeps reset-risk when the fence is already lost", () => {
  const contract = buildSharedStateContractHealthV1({
    configuredGrade: "single-process",
    effectiveGrade: "single-process",
    gradeDefaulted: true,
    expectedProcessCount: 1,
    serving: false,
    ownership: "lost",
    reasonCodes: ["lost_fence"],
  });
  assert.equal(contract.serving, false);
  assert.equal(contract.topology.ownership, "lost");
  assert.deepEqual(contract.reasonCodes, ["lost_fence"]);
  assertProcessResetRisk(contract);
});

test("/health stateContract reports the defaulted grade and held fence", async () => {
  await withEnv({
    BROKER_DEPLOYMENT_GRADE: undefined,
    BROKER_EXPECTED_PROCESS_COUNT: undefined,
  }, async () => {
    const server = await startTestServer({ edgeSecret: "s" });
    try {
      const res = await fetch(`${server.baseUrl}/health`, {
        headers: { "x-a2a-edge-secret": "s" },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      const contract = body.stateContract;
      assert.equal(contract.specVersion, 1);
      assert.equal(contract.configuredGrade, "single-process");
      assert.equal(contract.effectiveGrade, "single-process");
      assert.equal(contract.gradeDefaulted, true);
      assert.equal(contract.serving, true);
      assert.deepEqual(contract.reasonCodes, []);
      assert.equal(contract.topology.expectedProcessCount, 1);
      assert.equal(contract.topology.ownership, "held");
      assert.equal(contract.adapter.backendClass, "legacy-process");
      assert.equal(contract.adapter.contractVersion, null);
      assertProcessResetRisk(contract);
      const encoded = JSON.stringify(contract);
      assert.equal(encoded.includes("owner_token"), false);
      assert.equal(encoded.includes("shared-state-v1"), false);
      assert.equal(encoded.includes("nonce"), false);
      assert.equal(encoded.includes("bucket"), false);
    } finally {
      await server.close();
    }
  });
});

test("/health stateContract marks an explicit grade as not defaulted", async () => {
  await withEnv({
    BROKER_DEPLOYMENT_GRADE: "single-writer-durable",
    BROKER_EXPECTED_PROCESS_COUNT: "1",
  }, async () => {
    const server = await startTestServer({ edgeSecret: "s" });
    try {
      const res = await fetch(`${server.baseUrl}/health`, {
        headers: { "x-a2a-edge-secret": "s" },
      });
      assert.equal(res.status, 200);
      const contract = (await res.json()).stateContract;
      assert.equal(contract.configuredGrade, "single-writer-durable");
      assert.equal(contract.effectiveGrade, "single-writer-durable");
      assert.equal(contract.gradeDefaulted, false);
      assertProcessResetRisk(contract);
    } finally {
      await server.close();
    }
  });
});
