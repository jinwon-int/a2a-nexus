/**
 * Slice M, first part: `/health` `stateContract` without primitive bands.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildSharedStateContractHealthV1 } from "./shared-state-contract-health-v1.js";
import { startTestServer, withEnv } from "./server-test-helpers.js";

test("builder emits the closed health envelope and no primitive bands", () => {
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
  assert.equal(Object.hasOwn(contract, "primitives"), false);
  assert.equal(JSON.stringify(contract).includes("owner_token"), false);
  assert.equal(JSON.stringify(contract).includes("/var/lib"), false);
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
      assert.equal(Object.hasOwn(contract, "primitives"), false);
      assert.equal(JSON.stringify(contract).includes("owner_token"), false);
      assert.equal(JSON.stringify(contract).includes("shared-state-v1"), false);
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
    } finally {
      await server.close();
    }
  });
});
