// #1597: the worker must be able to PUBLISH an implementation-lane readiness
// profile. Registration and the claim-time gate both already understood
// `implementationCapability`, but parseWorkerCapabilities rebuilt the
// capabilities object from a fixed allowlist that omitted it, so the field was
// silently dropped and no worker could ever become implementation-eligible.
import test from "node:test";
import assert from "node:assert/strict";

import { createWorkerConfigFromEnv } from "./worker.js";
import { InMemoryA2ABroker } from "./core/broker.js";

const BASE_ENV = {
  BROKER_URL: "http://127.0.0.1:1",
  WORKER_ID: "worker-a",
  WORKER_ROLE: "analyst",
  WORKER_HANDLER_BUILTIN: "noop",
};

function capabilitiesFrom(env: Record<string, string>) {
  return createWorkerConfigFromEnv({ ...BASE_ENV, ...env }).worker.capabilities;
}

test("discrete env vars publish an implementation capability profile (#1597)", () => {
  const capabilities = capabilitiesFrom({
    WORKER_IMPLEMENTATION_CAPABLE: "true",
    WORKER_IMPLEMENTATION_RUNTIME: "claude-native",
    WORKER_IMPLEMENTATION_PROVIDER_ID: "anthropic",
    WORKER_IMPLEMENTATION_MODEL_TIER: "claude-sonnet-5",
    WORKER_IMPLEMENTATION_AVAILABILITY: "canary_passed",
    WORKER_IMPLEMENTATION_EVIDENCE_ID: "worker-canary-1",
  });

  assert.deepEqual(capabilities.implementationCapability, {
    capable: true,
    runtime: "claude-native",
    providerId: "anthropic",
    modelTier: "claude-sonnet-5",
    availability: "canary_passed",
    evidenceId: "worker-canary-1",
  });
});

test("the JSON capabilities blob can carry the profile (#1597)", () => {
  const capabilities = capabilitiesFrom({
    WORKER_CAPABILITIES_JSON: JSON.stringify({
      canAnalyze: true,
      canPatchWorkspace: true,
      workspaceIds: ["team2"],
      environments: ["research"],
      implementationCapability: {
        capable: true,
        runtime: "codex-native",
        providerId: "openai",
        modelTier: "gpt-5.6-sol",
        availability: "configured",
      },
    }),
  });

  assert.equal(capabilities.implementationCapability?.runtime, "codex-native");
  assert.equal(capabilities.implementationCapability?.availability, "configured");
});

test("discrete env vars win over the JSON blob (#1597)", () => {
  const capabilities = capabilitiesFrom({
    WORKER_CAPABILITIES_JSON: JSON.stringify({
      canAnalyze: true,
      implementationCapability: { capable: true, runtime: "codex-native", availability: "canary_passed" },
    }),
    WORKER_IMPLEMENTATION_CAPABLE: "false",
  });

  assert.equal(capabilities.implementationCapability?.capable, false);
  assert.equal(capabilities.implementationCapability?.runtime, undefined);
});

test("no declaration keeps legacy registration unchanged (#1597)", () => {
  assert.equal(capabilitiesFrom({}).implementationCapability, undefined);
  assert.equal(
    capabilitiesFrom({ WORKER_CAPABILITIES_JSON: JSON.stringify({ canAnalyze: true }) }).implementationCapability,
    undefined,
  );
});

test("a declared profile survives broker registration and normalization (#1597)", () => {
  // End-to-end: what the worker publishes is what the claim-time gate reads.
  const broker = new InMemoryA2ABroker();
  broker.registerWorker({
    nodeId: "worker-a",
    role: "analyst",
    capabilities: capabilitiesFrom({
      WORKER_IMPLEMENTATION_CAPABLE: "true",
      WORKER_IMPLEMENTATION_RUNTIME: "claude-code",
      WORKER_IMPLEMENTATION_PROVIDER_ID: "Anthropic",
      WORKER_IMPLEMENTATION_MODEL_TIER: "Claude-Sonnet-5",
      WORKER_IMPLEMENTATION_AVAILABILITY: "canary_passed",
    }),
  });

  const stored = broker.getWorker("worker-a")?.capabilities.implementationCapability;
  // The broker owns normalization: the runtime alias and the id casing are
  // resolved there, not in the worker.
  assert.equal(stored?.runtime, "claude-native");
  assert.equal(stored?.providerId, "anthropic");
  assert.equal(stored?.modelTier, "claude-sonnet-5");
  assert.equal(stored?.availability, "canary_passed");
});

test("credential-shaped evidence is stripped by the broker, not published as-is (#1597)", () => {
  const broker = new InMemoryA2ABroker();
  broker.registerWorker({
    nodeId: "worker-a",
    role: "analyst",
    capabilities: capabilitiesFrom({
      WORKER_IMPLEMENTATION_CAPABLE: "true",
      WORKER_IMPLEMENTATION_RUNTIME: "claude-native",
      WORKER_IMPLEMENTATION_PROVIDER_ID: "anthropic",
      WORKER_IMPLEMENTATION_MODEL_TIER: "claude-sonnet-5",
      WORKER_IMPLEMENTATION_AVAILABILITY: "canary_passed",
      WORKER_IMPLEMENTATION_EVIDENCE_ID: "sk-abcdefghijklmnop",
    }),
  });

  const stored = broker.getWorker("worker-a")?.capabilities.implementationCapability;
  assert.equal(stored?.evidenceId, undefined);
});
