// #2079 C: the per-heartbeat capability/metadata equality checks used to
// serialize both records to JSON two to four times per heartbeat. These pin
// the field-comparison helpers' semantics: normalized-input equivalence,
// order-sensitivity for arrays, and deep provider/implementation entries.
import assert from "node:assert/strict";
import test from "node:test";

import {
  workerCapabilitiesEqual,
  workerMetadataMateriallyEqual,
} from "./broker-worker-identity.js";
import type { WorkerCapabilities } from "./types.js";

function capabilities(overrides: Partial<WorkerCapabilities> = {}): WorkerCapabilities {
  return {
    canAnalyze: true,
    canBackfill: false,
    canPatchWorkspace: false,
    canPromoteLive: false,
    workspaceIds: ["ws-a"],
    environments: ["research"],
    ...overrides,
  };
}

test("workerCapabilitiesEqual accepts identical and absent-optional records", () => {
  assert.equal(workerCapabilitiesEqual(capabilities(), capabilities()), true);
  assert.equal(workerCapabilitiesEqual(capabilities({ runtimeFlavor: "termux-hermes" }), capabilities({ runtimeFlavor: "termux-hermes" })), true);
  assert.equal(workerCapabilitiesEqual(capabilities({}), capabilities({ gatewayRequired: undefined })), true);
});

test("workerCapabilitiesEqual rejects any scalar field drift", () => {
  const cases: Array<Partial<WorkerCapabilities>> = [
    { canAnalyze: false },
    { canBackfill: true },
    { canPatchWorkspace: true },
    { canPromoteLive: true },
    { workspaceIds: ["ws-b"] },
    { environments: ["live"] },
    { runtimeFlavor: "openclaw-poll-handler" },
    { gatewayRequired: false },
  ];
  for (const overrides of cases) {
    assert.equal(
      workerCapabilitiesEqual(capabilities(), capabilities(overrides)),
      false,
      `expected drift on ${JSON.stringify(overrides)}`,
    );
  }
});

test("workerCapabilitiesEqual compares provider capability entries per field", () => {
  const base = capabilities({
    providerCapabilities: [{
      providerId: "zai",
      modelFamily: "glm",
      modelId: "glm-5.2",
      routeKind: "api-key",
      availability: "canary_passed",
      lastVerifiedAt: "2026-09-01T00:00:00.000Z",
    }],
  });
  assert.equal(workerCapabilitiesEqual(base, capabilities({ providerCapabilities: base.providerCapabilities })), true);
  assert.equal(
    workerCapabilitiesEqual(
      base,
      capabilities({
        providerCapabilities: [{ ...base.providerCapabilities![0]!, availability: "disabled" }],
      }),
    ),
    false,
  );
  assert.equal(
    workerCapabilitiesEqual(
      base,
      capabilities({
        providerCapabilities: [{ ...base.providerCapabilities![0]!, providerId: "openai" }],
      }),
    ),
    false,
  );
  assert.equal(
    workerCapabilitiesEqual(base, capabilities({ providerCapabilities: [] })),
    false,
  );
});

test("workerCapabilitiesEqual compares implementation capability per field", () => {
  const base = capabilities({
    implementationCapability: {
      capable: true,
      runtime: "claude-native",
      availability: "configured",
    },
  });
  assert.equal(workerCapabilitiesEqual(base, capabilities({ implementationCapability: base.implementationCapability })), true);
  assert.equal(
    workerCapabilitiesEqual(
      base,
      capabilities({ implementationCapability: { ...base.implementationCapability!, capable: false } }),
    ),
    false,
  );
  assert.equal(
    workerCapabilitiesEqual(
      base,
      capabilities({ implementationCapability: { ...base.implementationCapability!, evidenceId: "EV-1" } }),
    ),
    false,
  );
});

test("workerMetadataMateriallyEqual ignores ephemeral keys and compares key-wise", () => {
  assert.equal(workerMetadataMateriallyEqual({ a: "1", b: "2" }, { b: "2", a: "1" }), true);
  assert.equal(workerMetadataMateriallyEqual({ a: "1" }, { a: "2" }), false);
  assert.equal(workerMetadataMateriallyEqual({ a: "1" }, { a: "1", extra: "x" }), false);
  // ephemeral heartbeat keys (see EPHEMERAL_WORKER_HEARTBEAT_METADATA_KEYS)
  assert.equal(
    workerMetadataMateriallyEqual({ a: "1", heartbeatAtEpochMs: "123" }, { a: "1" }),
    true,
  );
});
