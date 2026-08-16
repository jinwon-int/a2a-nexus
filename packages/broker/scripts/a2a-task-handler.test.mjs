import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { __test, handleTask, validateWorkerModelEnvCandidatesForPatchProfile } from "./a2a-task-handler.mjs";
import {
  ADVISORY_SIDECAR_ROUTING_POLICY,
  ALLOWED_WORKER_MODELS,
  DEFAULT_WORKER_MODEL,
  HERMES_UNSUPPORTED_WORKER_MODELS,
  advisorySidecarWorkerModelPolicySnapshot,
  canonicalizeWorkerModel,
  isWorkerModelSupportedByPatchProfile,
  resolveAdvisorySidecarFallbackDecision,
  resolveAdvisorySidecarRoutingPolicy,
  resolveWorkerModelInputs,
  resolveWorkerThinkingInput,
} from "./worker-model-policy.mjs";

function task(overrides = {}) {
  return {
    id: "task-853",
    intent: "noop",
    assignedWorkerId: "workerdelta",
    message: "source-only test",
    payload: {
      mode: "docker-broker-noop-smoke",
      noOp: true,
      runId: "run-853",
      worker: "workerdelta",
      sourceOnly: true,
      ...overrides.payload,
    },
    ...overrides,
  };
}

function sha256Prefix(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function signedSnapshotFixture(overrides = {}) {
  const content = overrides.content ?? "# source-grounded analysis fixture\nconst answer = 42;\n";
  return {
    schemaVersion: "a2a.retrieval.snapshot.v1",
    canonicalization: "rfc8785-jcs-v1",
    source: "github",
    repo: "jinwon-int/a2a-nexus",
    requestedRef: "838e58a7587d0f352cc1d19e6a0c5edae9903251",
    resolvedRef: "838e58a7587d0f352cc1d19e6a0c5edae9903251",
    path: "packages/broker/README.md",
    fetchedAt: "2026-07-06T00:00:00.000Z",
    byteLen: Buffer.byteLength(content, "utf8"),
    contentHash: sha256Prefix(content),
    content,
    signature: { protected: "signed-header", signature: "signed-body" },
    ...overrides,
  };
}

test("implementation intent fails closed when no executor ran (#1593)", () => {
  const outcome = handleTask({
    id: "task-implementation-fallback",
    intent: "implementation",
    message: "Implement the requested source patch",
    payload: {},
  }, {
    A2A_EXECUTOR_MODE: "builtin",
  });

  assert.equal(outcome.error?.code, "unsupported_intent");
  assert.match(outcome.error?.message ?? "", /no executor ran/);
  assert.equal(outcome.error?.details?.intent, "implementation");
  assert.equal(outcome.error?.details?.mode, "implementation");
  assert.equal(outcome.result, undefined);
  assert.equal(Object.hasOwn(outcome, "artifactIds"), false);
});

// Regression for #1597: the original #1593 guard only matched the literal string
// "implementation", which is not a member of A2AExchangeIntent. The real
// implementation-lane intents therefore fell through to the generic_ack success
// path, so a worker with no executor reported false success for patch work.
// The live-operation intents had the same hole with a larger blast radius:
// handleTask only routes to runLiveOperationTask when taskMode() is
// "promote-to-live-v1", and taskMode() falls back to the intent when
// payload.mode is absent, so a mode-less promote_to_live was acked as success.
const EXECUTOR_REQUIRED_INTENTS = [
  "propose_patch",
  "propose_params",
  "apply_local_change",
  "promote_to_live",
  "rollback_live",
];

for (const intent of EXECUTOR_REQUIRED_INTENTS) {
  test(`real implementation intent ${intent} fails closed in builtin fallback (#1597)`, () => {
    const outcome = handleTask({
      id: `task-${intent}-fallback`,
      intent,
      message: "Implement the requested source patch",
      payload: {},
    }, {
      A2A_EXECUTOR_MODE: "builtin",
    });

    assert.equal(outcome.error?.code, "unsupported_intent");
    assert.match(outcome.error?.message ?? "", /no executor ran/);
    assert.equal(outcome.error?.details?.intent, intent);
    assert.equal(outcome.result, undefined);
    assert.equal(Object.hasOwn(outcome, "artifactIds"), false);
  });
}

test("executor-required intents never yield any success result (#1597)", () => {
  for (const intent of [...EXECUTOR_REQUIRED_INTENTS, "implementation"]) {
    const outcome = handleTask({
      id: `task-${intent}-evidence`,
      intent,
      message: "Implement the requested source patch",
      payload: {},
    }, {
      A2A_EXECUTOR_MODE: "builtin",
    });

    // Asserting the error code rather than "not generic_ack" — a different
    // bogus evidence class would still be a false success.
    assert.equal(outcome.error?.code, "unsupported_intent", intent);
    assert.equal(outcome.result, undefined, intent);
  }
});

test("caller-declared smoke mode cannot buy success for a mutating intent (#1597)", () => {
  // mode and noOp are both caller-supplied, so the smoke fast-path must not be
  // usable to bypass the executor requirement. The real smoke lane dispatches
  // intent "analyze" and is asserted below to still work.
  for (const intent of EXECUTOR_REQUIRED_INTENTS) {
    const outcome = handleTask({
      id: `task-${intent}-smoke-bypass`,
      intent,
      message: "smoke bypass attempt",
      payload: { mode: "docker-broker-noop-smoke", noOp: true },
    }, {
      A2A_EXECUTOR_MODE: "builtin",
    });

    assert.equal(outcome.error?.code, "unsupported_intent", intent);
    assert.equal(outcome.result, undefined, intent);
  }

  const legitimateSmoke = handleTask({
    id: "task-smoke-analyze",
    intent: "analyze",
    message: "docker broker noop smoke",
    payload: { schemaVersion: 1, mode: "docker-broker-noop-smoke", noOp: true },
  }, {
    A2A_EXECUTOR_MODE: "builtin",
  });

  assert.equal(legitimateSmoke.error, undefined);
});

test("non-implementation intents keep the generic fallback (#1597)", () => {
  for (const intent of ["chat", "analyze", "verify", "backfill", "validate_change"]) {
    const outcome = handleTask({
      id: `task-${intent}-generic`,
      intent,
      message: "Record receipt of this non-substantive task",
      payload: {},
    }, {
      A2A_EXECUTOR_MODE: "builtin",
    });

    assert.equal(outcome.error, undefined, `${intent} must not fail closed`);
  }
});

test("permitted generic fallback is explicitly classified as generic_ack (#1593)", () => {
  const outcome = handleTask({
    id: "task-generic-probe",
    intent: "probe",
    message: "Record receipt of this non-substantive probe",
    payload: { mode: "probe" },
  }, {
    A2A_EXECUTOR_MODE: "builtin",
  });

  assert.equal(outcome.error, undefined);
  assert.equal(outcome.result?.summary, "generic probe task accepted by versioned A2A task handler");
  assert.equal(outcome.result?.output?.evidenceClass, "generic_ack");
});

test("dedicated smoke and structured analysis handlers remain non-generic (#1593)", () => {
  const smokeOutcome = handleTask(task(), { A2A_EXECUTOR_MODE: "builtin" });
  const analysisOutcome = handleTask({
    id: "task-structured-analysis",
    intent: "analyze",
    message: "Inspect supplied source evidence",
    payload: {
      mode: "analysis-only",
      summary: "source evidence inspected",
      sourceOnly: true,
    },
  }, {
    A2A_EXECUTOR_MODE: "builtin",
  });

  assert.equal(smokeOutcome.error, undefined);
  assert.equal(smokeOutcome.result?.output?.smoke?.ok, true);
  assert.equal(smokeOutcome.result?.output?.evidenceClass, undefined);
  assert.equal(analysisOutcome.error, undefined);
  assert.equal(analysisOutcome.result?.output?.analysisKind, "builtin_structured");
  assert.equal(analysisOutcome.result?.output?.evidenceClass, undefined);
});

test("direct task payload with allowlisted workerModel and workerThinking is accepted", () => {
  const result = handleTask(task({
    payload: {
      workerModel: "deepseek/deepseek-v4-pro",
      workerThinking: "high",
    },
  }), {});

  assert.equal(result.error, undefined);
  assert.equal(result.result.output.effectiveModel, "deepseek/deepseek-v4-pro");
  assert.equal(result.result.output.effectiveThinking, "high");
  assert.equal(result.result.output.modelFromPayload, true);
  assert.ok(!JSON.stringify(result).includes("secret-value"));
});

test("unsupported workerModel fails closed before a patch attempt", () => {
  const result = handleTask(task({
    intent: "propose_patch",
    payload: {
      mode: "github-propose-patch",
      issue: "#853",
      workerModel: "deepseek/not-allowed",
    },
  }), {
    A2A_DOCKER_RUNNER_CMD: "this-must-not-run",
  });

  assert.equal(result.error.code, "worker_model_not_allowed");
  assert.match(result.error.message, /not in the allowlist/);
  assert.deepEqual(result.error.details.allowedModels, [
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v4-pro",
    "deepseek-v4-pro",
    "openai-codex/gpt-5.6-sol",
    "gpt-5.6-sol",
    "openai-codex/gpt-5.5",
    "gpt-5.5",
    "claude-fable-5",
    "claude-sonnet-5",
    "grok-4.20",
    "minimax-m3",
    "kimi-coding/k3",
    "k3[1m]",
    "zai/glm-5.2",
    "glm-5.2[1m]",
  ]);
});

test("minimax-m3 payload workerModel is allowlisted and accepted (#673)", () => {
  const result = handleTask(task({
    payload: { workerModel: "minimax-m3" },
  }), {});

  assert.equal(result.error, undefined);
  assert.equal(result.result.output.effectiveModel, "minimax-m3");
  assert.equal(result.result.output.modelFromPayload, true);
});

const FLEET_BASELINE_WORKER_MODELS = [
  "openai-codex/gpt-5.6-sol",
  "gpt-5.6-sol",
  "openai-codex/gpt-5.5",
  "gpt-5.5",
  "claude-fable-5",
  "claude-sonnet-5",
  "grok-4.20",
  "deepseek-v4-pro",
  "deepseek/deepseek-v4-pro",
  "minimax-m3",
];

test("fleet baseline payload workerModels are allowlisted and accepted (#766)", () => {
  for (const workerModel of FLEET_BASELINE_WORKER_MODELS) {
    const result = handleTask(task({
      payload: { workerModel },
    }), {});

    assert.equal(result.error, undefined, `${workerModel} should be accepted`);
    assert.equal(result.result.output.effectiveModel, workerModel);
    assert.equal(result.result.output.modelFromPayload, true);
  }
});

test("fleet baseline env workerModels are accepted as Docker runner fallback (#766)", () => {
  for (const workerModel of FLEET_BASELINE_WORKER_MODELS) {
    const resolved = __test.resolveWorkerModel(task({}), { A2A_HERMES_DEFAULT_MODEL: workerModel });

    assert.equal(resolved.model, workerModel);
    assert.equal(resolved.fromPayload, false);
  }
});

test("A2A_HERMES_DEFAULT_MODEL env resolves minimax-m3 as a fallback (#673)", () => {
  const viaHermesEnv = __test.resolveWorkerModel(task({}), { A2A_HERMES_DEFAULT_MODEL: "minimax-m3" });
  assert.equal(viaHermesEnv.model, "minimax-m3");
  assert.equal(viaHermesEnv.fromPayload, false);

  // The legacy env name still works too.
  const viaOpenclawEnv = __test.resolveWorkerModel(task({}), { A2A_OPENCLAW_MODEL: "minimax-m3" });
  assert.equal(viaOpenclawEnv.model, "minimax-m3");
});

test("A2A_CODEX_MODEL env selects the first-class Codex fleet model", () => {
  const viaCodexEnv = __test.resolveWorkerModel(task({}), {
    A2A_CODEX_MODEL: "openai-codex/gpt-5.6-sol",
    A2A_OPENCLAW_MODEL: "openai-codex/gpt-5.5",
  });
  assert.equal(viaCodexEnv.model, "openai-codex/gpt-5.6-sol");
  assert.equal(viaCodexEnv.fromPayload, false);
});

test("A2A_CLAUDE_MODEL env selects an allowlisted Claude ccc-node model", () => {
  const result = handleTask(task(), {
    A2A_CLAUDE_MODEL: "claude-fable-5",
  });

  assert.equal(result.error, undefined);
  assert.equal(result.result.output.effectiveModel, "claude-fable-5");
  assert.equal(result.result.output.modelFromPayload, undefined);
});

test("worker model policy module exposes auditable allowlist and fallbacks (#799)", () => {
  assert.deepEqual(ALLOWED_WORKER_MODELS, [
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v4-pro",
    "deepseek-v4-pro",
    "openai-codex/gpt-5.6-sol",
    "gpt-5.6-sol",
    "openai-codex/gpt-5.5",
    "gpt-5.5",
    "claude-fable-5",
    "claude-sonnet-5",
    "grok-4.20",
    "minimax-m3",
    "kimi-coding/k3",
    "k3[1m]",
    "zai/glm-5.2",
    "glm-5.2[1m]",
  ]);
  assert.equal(DEFAULT_WORKER_MODEL, "openai-codex/gpt-5.6-sol");
  assert.deepEqual(HERMES_UNSUPPORTED_WORKER_MODELS, [
    "deepseek/deepseek-v4-flash",
    "deepseek-v4-flash",
  ]);

  assert.deepEqual(resolveWorkerModelInputs({ payloadModel: "minimax-m3" }), {
    model: "minimax-m3",
    fromPayload: true,
  });
  assert.deepEqual(resolveWorkerModelInputs({ payloadModel: "custom:minimax/minimax-m3" }), {
    model: "minimax-m3",
    fromPayload: true,
  });
  // Piri fleet models (a2a-nexus#1802): provider-prefixed, node-env [1m]
  // variants, and bare registry ids canonicalized to the prefixed form.
  assert.deepEqual(resolveWorkerModelInputs({ payloadModel: "kimi-coding/k3" }), {
    model: "kimi-coding/k3",
    fromPayload: true,
  });
  assert.deepEqual(resolveWorkerModelInputs({ payloadModel: "k3[1m]" }), {
    model: "k3[1m]",
    fromPayload: true,
  });
  assert.deepEqual(resolveWorkerModelInputs({ payloadModel: "zai/glm-5.2" }), {
    model: "zai/glm-5.2",
    fromPayload: true,
  });
  assert.deepEqual(resolveWorkerModelInputs({ payloadModel: "glm-5.2[1m]" }), {
    model: "glm-5.2[1m]",
    fromPayload: true,
  });
  assert.deepEqual(resolveWorkerModelInputs({ payloadModel: "k3" }), {
    model: "kimi-coding/k3",
    fromPayload: true,
  });
  assert.deepEqual(resolveWorkerModelInputs({ envModel: "glm-5.2" }), {
    model: "zai/glm-5.2",
    fromPayload: false,
  });
  assert.match(
    resolveWorkerModelInputs({ payloadModel: "deepseek/not-allowed" }).error,
    /not in the allowlist/,
  );
  assert.match(
    resolveWorkerModelInputs({ payloadModel: "custom:unknown/minimax-m3" }).error,
    /not in the allowlist/,
  );
  assert.deepEqual(resolveWorkerModelInputs({ envModel: "not-allowed" }), {
    model: DEFAULT_WORKER_MODEL,
    fromPayload: false,
  });
  assert.deepEqual(resolveWorkerThinkingInput("max"), { thinking: "max", fromPayload: true });
  assert.deepEqual(resolveWorkerThinkingInput("invalid"), { thinking: "high", fromPayload: false });
});

test("worker model policy prevents Hermes profile from accepting unsupported aliases (#799)", () => {
  assert.equal(canonicalizeWorkerModel("deepseek-v4-flash"), "deepseek/deepseek-v4-flash");
  assert.equal(canonicalizeWorkerModel("gpt-5.6-sol"), "openai-codex/gpt-5.6-sol");
  assert.equal(canonicalizeWorkerModel("gpt-5.5"), "openai-codex/gpt-5.5");
  assert.equal(canonicalizeWorkerModel("custom:minimax/minimax-m3"), "minimax-m3");
  assert.equal(canonicalizeWorkerModel("k3"), "kimi-coding/k3");
  assert.equal(canonicalizeWorkerModel("glm-5.2"), "zai/glm-5.2");

  const rejected = isWorkerModelSupportedByPatchProfile("hermes", "deepseek-v4-flash");
  assert.equal(rejected.supported, false);
  assert.equal(rejected.failureCategory, "unsupported_hermes_model");
  assert.equal(rejected.canonicalModel, "deepseek/deepseek-v4-flash");

  const accepted = isWorkerModelSupportedByPatchProfile("hermes", "openai-codex/gpt-5.5");
  assert.equal(accepted.supported, true);
});

test("advisory sidecar model policy snapshot is source-only and cannot bypass broker gates (#799)", () => {
  const snapshot = advisorySidecarWorkerModelPolicySnapshot();
  assert.equal(snapshot.advisoryOnly, true);
  assert.equal(snapshot.defaultWorkerModel, DEFAULT_WORKER_MODEL);
  assert.deepEqual(snapshot.allowedWorkerModels, ALLOWED_WORKER_MODELS);
  assert.equal(snapshot.sidecarRecommendationBypassesAllowlist, false);
  assert.equal(snapshot.sidecarRecommendationBypassesCapabilityChecks, false);
  assert.equal(snapshot.sidecarRecommendationBypassesApprovalGates, false);
  assert.equal(snapshot.sidecarRecommendationBypassesFinalizer, false);
  assert.equal(snapshot.startsSidecarProcess, false);
  assert.equal(snapshot.sendsProviderRequests, false);
  assert.equal(snapshot.mutatesBrokerState, false);
  assert.equal(snapshot.dispatchesTasks, false);
  assert.equal(snapshot.routingInfluencePermitted, false);
});

test("advisory sidecar routing policy exposes explicit deterministic data (#804)", () => {
  assert.equal(ADVISORY_SIDECAR_ROUTING_POLICY.kind, "a2a.advisory-sidecar-routing-policy.v1");
  assert.deepEqual(ADVISORY_SIDECAR_ROUTING_POLICY.activationLabels, [
    "advisory-sidecar",
    "sidecar:advisory",
    "sidecar-candidate",
  ]);
  assert.deepEqual(ADVISORY_SIDECAR_ROUTING_POLICY.requiredCapabilities, [
    "advisory-sidecar",
    "source-analysis",
  ]);
  assert.equal(ADVISORY_SIDECAR_ROUTING_POLICY.advisoryOnly, true);
  assert.equal(ADVISORY_SIDECAR_ROUTING_POLICY.routingInfluencePermitted, false);
  assert.equal(ADVISORY_SIDECAR_ROUTING_POLICY.allowedRoute, "default_worker");
  assert.equal(ADVISORY_SIDECAR_ROUTING_POLICY.advisoryCandidateRoute, "advisory_sidecar");
  assert.equal(ADVISORY_SIDECAR_ROUTING_POLICY.bypasses.allowlist, false);
  assert.equal(ADVISORY_SIDECAR_ROUTING_POLICY.bypasses.capabilityChecks, false);
  assert.equal(ADVISORY_SIDECAR_ROUTING_POLICY.bypasses.approvalGates, false);
  assert.equal(ADVISORY_SIDECAR_ROUTING_POLICY.bypasses.finalizer, false);
});

test("advisory sidecar routing permits advisory metadata without changing operational route (#804, #831)", () => {
  const route = resolveAdvisorySidecarRoutingPolicy({
    taskLabels: ["advisory-sidecar", "source-only"],
    workerModel: "deepseek/deepseek-v4-pro",
    patchProfile: "docker",
    workerCapabilities: ["advisory-sidecar", "source-analysis", "github-read"],
    requiresApproval: false,
  });

  assert.deepEqual(route, {
    status: "allowed",
    route: "default_worker",
    advisoryOnly: true,
    selectedModel: "deepseek/deepseek-v4-pro",
    selectedThinking: "high",
    reasons: [],
    evidence: {
      labelMatched: "advisory-sidecar",
      modelAllowed: true,
      capabilityChecksPassed: true,
      approvalGatePassed: true,
      finalizerRequired: true,
      routingInfluencePermitted: false,
      advisoryCandidateRoute: "advisory_sidecar",
      operationalRoutingChanged: false,
    },
    bypasses: {
      allowlist: false,
      capabilityChecks: false,
      approvalGates: false,
      finalizer: false,
    },
  });

  const minimaxRoute = resolveAdvisorySidecarRoutingPolicy({
    taskLabels: ["advisory-sidecar"],
    workerModel: "custom:minimax/minimax-m3",
    patchProfile: "hermes",
    workerCapabilities: ["advisory-sidecar", "source-analysis"],
    requiresApproval: false,
  });

  assert.equal(minimaxRoute.status, "allowed");
  assert.equal(minimaxRoute.route, "default_worker");
  assert.equal(minimaxRoute.evidence.advisoryCandidateRoute, "advisory_sidecar");
  assert.equal(minimaxRoute.evidence.routingInfluencePermitted, false);
  assert.equal(minimaxRoute.evidence.operationalRoutingChanged, false);
  assert.equal(minimaxRoute.selectedModel, "minimax-m3");
  assert.deepEqual(minimaxRoute.reasons, []);
  assert.equal(minimaxRoute.evidence.modelAllowed, true);
});

test("advisory sidecar routing blocks unsupported model, missing capability, and approval bypass attempts (#804)", () => {
  const route = resolveAdvisorySidecarRoutingPolicy({
    taskLabels: ["sidecar:advisory"],
    workerModel: "deepseek/deepseek-v4-flash",
    patchProfile: "hermes",
    workerCapabilities: ["source-analysis"],
    requiresApproval: true,
  });

  assert.equal(route.status, "blocked");
  assert.equal(route.route, "finalizer_review");
  assert.deepEqual(route.reasons, [
    "worker_model_not_supported_by_profile",
    "missing_worker_capability:advisory-sidecar",
    "approval_gate_required",
  ]);
  assert.equal(route.evidence.modelAllowed, true);
  assert.equal(route.evidence.capabilityChecksPassed, false);
  assert.equal(route.evidence.approvalGatePassed, false);
  assert.equal(route.evidence.finalizerRequired, true);
  assert.equal(route.bypasses.allowlist, false);
  assert.equal(route.bypasses.capabilityChecks, false);
  assert.equal(route.bypasses.approvalGates, false);
  assert.equal(route.bypasses.finalizer, false);
});

test("advisory sidecar routing falls back deterministically when no activation label is present (#804)", () => {
  const route = resolveAdvisorySidecarRoutingPolicy({
    taskLabels: ["source-only"],
    workerCapabilities: ["source-analysis"],
  });

  assert.deepEqual(route, {
    status: "fallback",
    route: "default_worker",
    advisoryOnly: true,
    selectedModel: DEFAULT_WORKER_MODEL,
    selectedThinking: "high",
    reasons: ["no_advisory_route_label"],
    evidence: {
      labelMatched: null,
      modelAllowed: true,
      capabilityChecksPassed: false,
      approvalGatePassed: true,
      finalizerRequired: true,
      routingInfluencePermitted: false,
      advisoryCandidateRoute: "advisory_sidecar",
      operationalRoutingChanged: false,
    },
    bypasses: {
      allowlist: false,
      capabilityChecks: false,
      approvalGates: false,
      finalizer: false,
    },
  });
});



test("advisory sidecar cannot select an operational sidecar route without a future live-routing gate (#831)", () => {
  for (const input of [
    {
      taskLabels: ["advisory-sidecar"],
      workerModel: "deepseek/deepseek-v4-pro",
      patchProfile: "docker",
      workerCapabilities: ["advisory-sidecar", "source-analysis"],
      requiresApproval: false,
    },
    {
      taskLabels: ["sidecar:advisory"],
      workerModel: "minimax-m3",
      patchProfile: "hermes",
      workerCapabilities: ["advisory-sidecar", "source-analysis", "github-read"],
      requiresApproval: false,
    },
    {
      taskLabels: ["sidecar-candidate"],
      workerModel: "openai-codex/gpt-5.5",
      patchProfile: "hermes",
      workerCapabilities: ["advisory-sidecar", "source-analysis"],
      requiresApproval: false,
    },
  ]) {
    const route = resolveAdvisorySidecarRoutingPolicy(input);
    assert.equal(route.status, "allowed");
    assert.equal(route.route, "default_worker");
    assert.equal(route.evidence.advisoryCandidateRoute, "advisory_sidecar");
    assert.equal(route.evidence.routingInfluencePermitted, false);
    assert.equal(route.evidence.operationalRoutingChanged, false);
    assert.equal(route.bypasses.finalizer, false);
  }
});

test("advisory sidecar fallback decision fails closed for disabled, unavailable, timeout, schema, and bypass cases (#811)", () => {
  const cases = [
    { name: "null-input", input: null, reason: "sidecar_disabled" },
    { name: "disabled", input: { enabled: false }, reason: "sidecar_disabled" },
    { name: "unavailable", input: { enabled: true, available: false }, reason: "sidecar_unavailable" },
    { name: "timeout", input: { enabled: true, available: true, timedOut: true }, reason: "sidecar_timeout" },
    { name: "schema", input: { enabled: true, available: true, response: { route: "advisory_sidecar" } }, reason: "sidecar_schema_mismatch" },
    { name: "unknown-recommendation", input: { enabled: true, available: true, response: { schemaVersion: "a2a.advisory-sidecar.response.v1", recommendation: "use_sidecar", bypasses: { allowlist: false, capabilityChecks: false, approvalGates: false, finalizer: false } } }, reason: "sidecar_schema_mismatch" },
    { name: "missing-bypass-key", input: { enabled: true, available: true, response: { schemaVersion: "a2a.advisory-sidecar.response.v1", recommendation: "continue_default", bypasses: { finalizer: false } } }, reason: "sidecar_schema_mismatch" },
    { name: "prototype-supplied-schema", input: { enabled: true, available: true, response: Object.create({ schemaVersion: "a2a.advisory-sidecar.response.v1", recommendation: "continue_default", bypasses: { allowlist: false, capabilityChecks: false, approvalGates: false, finalizer: false } }) }, reason: "sidecar_schema_mismatch" },
    { name: "prototype-supplied-bypass-gates", input: { enabled: true, available: true, response: { schemaVersion: "a2a.advisory-sidecar.response.v1", recommendation: "continue_default", bypasses: Object.create({ allowlist: false, capabilityChecks: false, approvalGates: false, finalizer: false }) } }, reason: "sidecar_schema_mismatch" },
    { name: "bypass", input: { enabled: true, available: true, response: { schemaVersion: "a2a.advisory-sidecar.response.v1", recommendation: "continue_default", bypasses: { finalizer: true } } }, reason: "sidecar_bypass_recommended:finalizer" },
  ];

  for (const { name, input, reason } of cases) {
    const decision = resolveAdvisorySidecarFallbackDecision(input);
    assert.equal(decision.status, "fallback", name);
    assert.equal(decision.route, "default_worker", name);
    assert.equal(decision.advisoryOnly, true, name);
    assert.equal(decision.finalizerRequired, true, name);
    assert.equal(decision.startsSidecarProcess, false, name);
    assert.equal(decision.sendsProviderRequests, false, name);
    assert.equal(decision.mutatesBrokerState, false, name);
    assert.equal(decision.bypasses.finalizer, false, name);
    assert.ok(decision.reasons.includes(reason), `${name} should include ${reason}`);
  }
});

test("advisory sidecar fallback decision accepts only valid advisory-only schema without bypasses (#811)", () => {
  const decision = resolveAdvisorySidecarFallbackDecision({
    enabled: true,
    available: true,
    response: {
      schemaVersion: "a2a.advisory-sidecar.response.v1",
      recommendation: "continue_default",
      bypasses: {
        allowlist: false,
        capabilityChecks: false,
        approvalGates: false,
        finalizer: false,
      },
    },
  });

  assert.equal(decision.status, "accepted_advisory");
  assert.equal(decision.route, "default_worker");
  assert.deepEqual(decision.reasons, []);
  assert.equal(decision.finalizerRequired, true);
  assert.equal(decision.advisoryOnly, true);
});

test("normal source-only task uses the Codex fleet baseline model and high reasoning by default", () => {
  const runnerTask = __test.buildRunnerTask(task({
    intent: "propose_patch",
    payload: {
      mode: "github-propose-patch",
      issue: "#853",
      issueUrl: "https://github.com/jinwon-int/a2a-broker/issues/853",
      repo: "jinwon-int/a2a-broker",
    },
  }), {});

  assert.equal(runnerTask.workerModel, "openai-codex/gpt-5.6-sol");
  assert.equal(runnerTask.workerThinking, "high");
});

test("worker reasoning follows A2A_WORKER_THINKING when the task has no override", () => {
  const runnerTask = __test.buildRunnerTask(task({
    intent: "propose_patch",
    payload: {
      mode: "github-propose-patch",
      repo: "jinwon-int/a2a-nexus",
    },
  }), { A2A_WORKER_THINKING: "xhigh" });

  assert.equal(runnerTask.workerThinking, "xhigh");
});

test("task workerThinking override takes precedence over A2A_WORKER_THINKING", () => {
  const runnerTask = __test.buildRunnerTask(task({
    intent: "propose_patch",
    payload: {
      mode: "github-propose-patch",
      repo: "jinwon-int/a2a-nexus",
      workerThinking: "medium",
    },
  }), { A2A_WORKER_THINKING: "xhigh" });

  assert.equal(runnerTask.workerThinking, "medium");
});

test("github runner task defaults to 60 minutes", () => {
  const runnerTask = __test.buildRunnerTask(task({
    intent: "propose_patch",
    payload: {
      mode: "github-propose-patch",
      issue: "#853",
      issueUrl: "https://github.com/jinwon-int/a2a-broker/issues/853",
      repo: "jinwon-int/a2a-broker",
    },
  }), {});

  assert.equal(__test.DEFAULT_OPENCLAW_TIMEOUT_SEC, 60 * 60);
  assert.equal(runnerTask.timeoutMs, 60 * 60 * 1000);
});

test("runner task carries model and thinking overrides to downstream runner command input", () => {
  const runnerTask = __test.buildRunnerTask(task({
    intent: "propose_patch",
    payload: {
      mode: "github-propose-patch",
      issue: "#853",
      issueUrl: "https://github.com/jinwon-int/a2a-broker/issues/853",
      repo: "jinwon-int/a2a-broker",
      workerModel: "deepseek/deepseek-v4-pro",
      workerThinking: "high",
    },
  }), {});

  assert.equal(runnerTask.workerModel, "deepseek/deepseek-v4-pro");
  assert.equal(runnerTask.workerThinking, "high");
});

test("runner task preserves the broker-generated bounded subagent context brief (Phase-2 WS5)", () => {
  const brief = "# A2A sub-agent context brief\n\nredacted shared context";
  const runnerTask = __test.buildRunnerTask(task({
    intent: "propose_patch",
    subagentContextBrief: brief,
    payload: {
      mode: "github-propose-patch",
      repo: "jinwon-int/a2a-nexus",
    },
  }), {});

  assert.equal(runnerTask.subagentContextBrief, brief);
  assert.throws(
    () => __test.buildRunnerTask(task({
      intent: "propose_patch",
      subagentContextBrief: "x".repeat(64 * 1024 + 1),
      payload: { mode: "github-propose-patch", repo: "jinwon-int/a2a-nexus" },
    }), {}),
    /subagentContextBrief exceeds the 65536-byte limit/,
  );
});

test("effective model evidence is sanitized and contains no secret fields", () => {
  const result = handleTask(task({
    payload: {
      workerModel: "deepseek/deepseek-v4-pro",
      workerThinking: "max",
      token: "secret-value",
    },
  }), {});

  const output = result.result.output;
  assert.equal(output.effectiveModel, "deepseek/deepseek-v4-pro");
  assert.equal(output.effectiveThinking, "max");
  assert.equal(output.modelFromPayload, true);
  assert.ok(!Object.keys(output).some((key) => /token|secret|password/i.test(key)));
  assert.ok(!JSON.stringify(output).includes("secret-value"));
});

function patchTask(overrides = {}) {
  const { payload: payloadOverrides, ...restOverrides } = overrides;
  return {
    id: "task-gh-patch",
    intent: "propose_patch",
    message: "Implement the fix",
    payload: {
      mode: "github-propose-patch",
      repo: "jinwon-int/a2a-broker",
      issue: "#1256",
      issueUrl: "https://github.com/jinwon-int/a2a-broker/issues/1256",
      ...(payloadOverrides || {}),
    },
    ...restOverrides,
  };
}

test("Hermes patch profile rejects deepseek flash before docker runner execution (#776)", () => {
  const result = handleTask(patchTask({
    payload: { workerModel: "deepseek/deepseek-v4-flash" },
  }), {
    A2A_EXECUTOR_MODE: "docker",
    A2A_DOCKER_RUNNER_BIN: "this-must-not-run",
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
  });

  assert.equal(result.error.code, "worker_model_not_supported_by_profile");
  assert.equal(result.error.details.failureCategory, "unsupported_hermes_model");
  assert.equal(result.error.details.profile, "hermes");
  assert.equal(result.error.details.requestedModel, "deepseek/deepseek-v4-flash");
});

test("Hermes runner image rejects env default deepseek flash before docker runner execution (#776)", () => {
  const result = handleTask(patchTask(), {
    A2A_EXECUTOR_MODE: "docker",
    A2A_DOCKER_RUNNER_BIN: "this-must-not-run",
    A2A_DOCKER_RUNNER_IMAGE: "a2a-docker-runner-hermes:5f0ff71",
    A2A_OPENCLAW_MODEL: "deepseek/deepseek-v4-flash",
  });

  assert.equal(result.error.code, "worker_model_not_supported_by_profile");
  assert.equal(result.error.details.canonicalModel, "deepseek/deepseek-v4-flash");
});

test("piri patch command profile is recognized from env and runner image (#1802)", () => {
  assert.equal(__test.normalizedPatchCommandProfile({
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "piri",
  }), "piri");
  assert.equal(__test.normalizedPatchCommandProfile({
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "Piri",
  }), "piri");
  assert.equal(__test.normalizedPatchCommandProfile({
    A2A_DOCKER_RUNNER_IMAGE: "a2a-docker-runner-piri:bd4f92c-fix2",
  }), "piri");
  // Explicit non-piri profiles and images keep their existing mapping.
  assert.equal(__test.normalizedPatchCommandProfile({
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
    A2A_DOCKER_RUNNER_IMAGE: "a2a-docker-runner-piri:bd4f92c-fix2",
  }), "hermes");
  assert.equal(__test.normalizedPatchCommandProfile({
    A2A_DOCKER_RUNNER_IMAGE: "a2a-docker-runner-hermes:5f0ff71",
  }), "hermes");
  assert.equal(__test.normalizedPatchCommandProfile({}), "");
});

test("piri patch profile accepts Kimi/GLM worker models before docker runner execution (#1802)", () => {
  for (const workerModel of ["kimi-coding/k3", "k3[1m]", "zai/glm-5.2", "glm-5.2[1m]"]) {
    const result = handleTask(patchTask({
      payload: { workerModel },
    }), {
      A2A_EXECUTOR_MODE: "docker",
      A2A_DOCKER_RUNNER_BIN: "this-must-not-run",
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "piri",
      A2A_DOCKER_RUNNER_IMAGE: "a2a-docker-runner-piri:bd4f92c-fix2",
    });

    assert.notEqual(result.error?.code, "worker_model_not_allowed", `workerModel ${workerModel} must be allowlisted`);
    assert.notEqual(result.error?.code, "worker_model_not_supported_by_profile", `workerModel ${workerModel} must be supported by the piri profile`);
  }
});

test("validateWorkerModelEnvCandidatesForPatchProfile is a public export for fleet-visibility tooling reuse (#1802 follow-up)", () => {
  assert.equal(typeof validateWorkerModelEnvCandidatesForPatchProfile, "function");

  // A caller outside the broker (e.g. a2a-worker-readiness-matrix.mjs, which
  // is explicitly read-only/source-only fleet-visibility tooling) must be
  // able to import this directly and get the exact same profile-support
  // decision handleTask()'s preflight gate makes for the same task/env,
  // without invoking handleTask or any broker/runner state.
  const env = {
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
    A2A_CLAUDE_MODEL: "deepseek/deepseek-v4-flash",
  };
  const direct = validateWorkerModelEnvCandidatesForPatchProfile(patchTask({}), env);
  assert.equal(direct?.error?.code, "worker_model_not_supported_by_profile");
  assert.equal(direct.error.details.canonicalModel, "deepseek/deepseek-v4-flash");
  assert.equal(direct.error.details.modelSource, "env");

  const viaHandleTask = handleTask(patchTask({}), {
    ...env,
    A2A_EXECUTOR_MODE: "docker",
    A2A_DOCKER_RUNNER_BIN: "this-must-not-run",
  });
  assert.equal(viaHandleTask.error?.code, direct.error.code);
  assert.equal(viaHandleTask.error?.details?.canonicalModel, direct.error.details.canonicalModel);
});

test("validateWorkerModelEnvCandidatesForPatchProfile checks env candidates in priority order and skips non-allowlisted values", () => {
  // Priority order is A2A_CODEX_MODEL > A2A_CLAUDE_MODEL > ... (see
  // workerModelEnvCandidates). A profile-unsupported-but-allowlisted model
  // earlier in that order must be reported even though a later candidate
  // would have been fine.
  const codexFirst = validateWorkerModelEnvCandidatesForPatchProfile(patchTask({}), {
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
    A2A_CODEX_MODEL: "deepseek/deepseek-v4-flash",
    A2A_CLAUDE_MODEL: "claude-sonnet-5",
  });
  assert.equal(codexFirst?.error?.details?.requestedModel, "deepseek/deepseek-v4-flash");

  // A non-allowlisted candidate ahead of an allowlisted-but-unsupported one
  // must be skipped rather than short-circuiting the scan or throwing.
  const skipsUnknown = validateWorkerModelEnvCandidatesForPatchProfile(patchTask({}), {
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
    A2A_CODEX_MODEL: "not-a-real-model",
    A2A_CLAUDE_MODEL: "deepseek/deepseek-v4-flash",
  });
  assert.equal(skipsUnknown?.error?.details?.requestedModel, "deepseek/deepseek-v4-flash");

  // All candidates supported by the profile -> no error.
  assert.equal(validateWorkerModelEnvCandidatesForPatchProfile(patchTask({}), {
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
    A2A_CODEX_MODEL: "openai-codex/gpt-5.6-sol",
    A2A_CLAUDE_MODEL: "claude-sonnet-5",
  }), null);
});

test("github-propose-patch + allowNoChanges=true sets runnerTask.allowNoChanges", () => {
  const runnerTask = __test.buildRunnerTask(patchTask({
    payload: { allowNoChanges: true },
  }), {});

  assert.equal(runnerTask.allowNoChanges, true);
  assert.equal(runnerTask.readOnlyValidation, undefined);
});

test("github-propose-patch + readOnlyValidation=true sets both flags", () => {
  const runnerTask = __test.buildRunnerTask(patchTask({
    payload: { readOnlyValidation: true },
  }), {});

  assert.equal(runnerTask.allowNoChanges, true);
  assert.equal(runnerTask.readOnlyValidation, true);
});

test("github-propose-patch + validationOnly=true sets both flags", () => {
  const runnerTask = __test.buildRunnerTask(patchTask({
    payload: { validationOnly: true },
  }), {});

  assert.equal(runnerTask.allowNoChanges, true);
  assert.equal(runnerTask.readOnlyValidation, true);
});

test("github-propose-patch + evidenceOnlyAllowed=true sets allowNoChanges", () => {
  const runnerTask = __test.buildRunnerTask(patchTask({
    payload: { evidenceOnlyAllowed: true },
  }), {});

  assert.equal(runnerTask.allowNoChanges, true);
  assert.equal(runnerTask.readOnlyValidation, undefined);
});

test("github-propose-patch with no flags keeps existing behavior (no allowNoChanges/readOnlyValidation)", () => {
  const runnerTask = __test.buildRunnerTask(patchTask({}), {});

  assert.equal(runnerTask.allowNoChanges, undefined);
  assert.equal(runnerTask.readOnlyValidation, undefined);
});

test("existing read-only evidence task still sets readOnlyValidation", () => {
  const runnerTask = __test.buildRunnerTask({
    id: "task-readonly",
    intent: "analyze",
    message: "Read-only verification",
    payload: {
      mode: "github-read-only-validation",
      repo: "jinwon-int/a2a-broker",
      issue: "#988",
      issueUrl: "https://github.com/jinwon-int/a2a-broker/issues/988",
    },
  }, {});

  assert.equal(runnerTask.readOnlyValidation, true);
  // Non-patch tasks should NOT get allowNoChanges from this propagation
  assert.equal(runnerTask.allowNoChanges, undefined);
});

test("github-readonly-validation alias is treated as GitHub evidence and refuses generic builtin success", () => {
  const result = handleTask({
    id: "task-readonly-alias",
    intent: "analyze",
    message: "Analyze source bundle only",
    payload: {
      mode: "github-readonly-validation",
      repo: "jinwon-int/a2a-nexus",
      issue: "#645",
      sourceOnly: true,
      githubWriteAllowed: false,
    },
  }, {
    A2A_EXECUTOR_MODE: "builtin",
  });

  assert.equal(result.error?.code, "github_executor_not_configured");
  assert.match(result.error?.message ?? "", /refusing built-in no-op success/);
});

function writeHybridRunnerStub(path, body) {
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
}

test("H2 GREEN: no executionMode flag preserves existing docker runner behavior (#1348)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-h2-no-flag-"));
  const runner = join(dir, "fake-runner.mjs");
  writeHybridRunnerStub(runner, `
process.stdout.write(JSON.stringify({
  ok: true,
  status: "pr_opened",
  prUrl: "https://github.com/jinwon-int/a2a-nexus/pull/9997",
  branch: "h2-no-flag-compat",
  filesChanged: ["packages/broker/src/core/store.ts"],
  tests: ["legacy path still accepts runner evidence"]
}) + "\\n");
`);

  try {
    const result = handleTask(patchTask({
      id: "task-h2-no-flag-compat",
      payload: {
        repo: "jinwon-int/a2a-nexus",
        issue: "#1348",
        issueUrl: "https://github.com/jinwon-int/a2a-nexus/issues/1348",
      },
    }), {
      PATH: process.env.PATH,
      A2A_EXECUTOR_MODE: "docker",
      A2A_DOCKER_RUNNER_BIN: runner,
    });

    assert.equal(result.error, undefined);
    assert.equal(result.result?.output?.prUrl, "https://github.com/jinwon-int/a2a-nexus/pull/9997");
    assert.deepEqual(result.result?.output?.filesChanged, ["packages/broker/src/core/store.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("docker runner max-turn failure stays failed with stable reason and checkpoint reference", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-max-turn-runner-failure-"));
  const runner = join(dir, "fake-runner.mjs");
  writeHybridRunnerStub(runner, `
process.stdout.write(JSON.stringify({
  ok: false,
  status: "failed",
  terminalReason: "max_turns",
  checkpointRef: "artifacts/claude-max-turn-checkpoint.json",
  error: "Claude Code max-turn budget exhausted; task remains failed (terminal_reason=max_turns).",
  claudeTurnBudget: {
    schemaVersion: "a2a.claude.turn-budget.v1",
    mode: "agentic-patch",
    effectiveMaxTurns: 40,
    source: "canonical_default",
    outcome: "failure",
    failureReason: "max_turns",
    checkpointStatus: "preserved",
    checkpointRef: "artifacts/claude-max-turn-checkpoint.json"
  },
  artifacts: ["artifacts/claude-max-turn-checkpoint.json"]
}) + "\\n");
process.exitCode = 1;
`);

  try {
    const result = handleTask(patchTask({
      id: "task-max-turn-failure",
      payload: {
        repo: "jinwon-int/a2a-nexus",
        issue: "#1700",
        issueUrl: "https://github.com/jinwon-int/a2a-nexus/issues/1700",
      },
    }), {
      PATH: process.env.PATH,
      A2A_EXECUTOR_MODE: "docker",
      A2A_DOCKER_RUNNER_BIN: runner,
    });

    assert.equal(result.result, undefined);
    assert.equal(result.error?.code, "docker_runner_max_turns");
    assert.equal(result.error?.details?.terminalReason, "max_turns");
    assert.equal(result.error?.details?.checkpointRef, "artifacts/claude-max-turn-checkpoint.json");
    assert.equal(result.error?.details?.runnerResult?.ok, false);
    assert.equal(result.error?.details?.runnerResult?.status, "failed");
    assert.equal(result.error?.details?.runnerResult?.prUrl, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WS5: docker runner bridge envelope preserves bounded subagentReport for broker redaction", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-ws5-report-"));
  const runner = join(dir, "fake-runner.mjs");
  writeHybridRunnerStub(runner, `
const subagentReport = {
  count: 1,
  entries: [{ role: "verifier", id: "verify-1", writeSet: [], status: "complete", output: "checked TOKEN=runtime-synthetic" }]
};
const stdout = JSON.stringify({ payloads: [{ text: JSON.stringify({
  prUrl: "https://github.com/jinwon-int/a2a-nexus/pull/9995",
  subagentReport
}) }] });
process.stdout.write(JSON.stringify({
  ok: true,
  status: "pr_opened",
  prUrl: "https://github.com/jinwon-int/a2a-nexus/pull/9995",
  branch: "ws5-report-handoff",
  filesChanged: ["packages/broker/src/worker.ts"],
  tests: ["report handoff"],
  stdout
}) + "\\n");
`);

  try {
    const result = handleTask(patchTask({
      id: "task-ws5-report-handoff",
      payload: {
        repo: "jinwon-int/a2a-nexus",
        issue: "#1543",
        issueUrl: "https://github.com/jinwon-int/a2a-nexus/issues/1543",
      },
    }), {
      PATH: process.env.PATH,
      A2A_EXECUTOR_MODE: "docker",
      A2A_DOCKER_RUNNER_BIN: runner,
    });

    assert.equal(result.error, undefined);
    assert.equal(result.result?.output?.subagentReport?.count, 1);
    assert.equal(result.result?.output?.subagentReport?.entries?.[0]?.role, "verifier");
    assert.match(result.result?.output?.subagentReport?.entries?.[0]?.output ?? "", /runtime-synthetic/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("H2 RED: hybrid-subagent budget exhaustion fails closed before runner spawn (#1348)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-h2-budget-red-"));
  const runner = join(dir, "fake-runner.mjs");
  const invocation = join(dir, "runner-invoked.json");
  writeHybridRunnerStub(runner, `
const { readFileSync, writeFileSync } = await import("node:fs");
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
writeFileSync(${JSON.stringify(invocation)}, JSON.stringify(task, null, 2));
process.stdout.write(JSON.stringify({
  ok: true,
  status: "pr_opened",
  prUrl: "https://github.com/jinwon-int/a2a-nexus/pull/9999",
  branch: "h2-budget-should-not-run",
  filesChanged: ["packages/broker/src/core/broker-exchange-task-decision.ts"],
  tests: ["not expected to run"]
}) + "\\n");
`);

  try {
    const result = handleTask(patchTask({
      id: "task-h2-budget-exhausted",
      payload: {
        repo: "jinwon-int/a2a-nexus",
        issue: "#1348",
        issueUrl: "https://github.com/jinwon-int/a2a-nexus/issues/1348",
        executionMode: "hybrid-subagent",
        subagentBudget: { max: 0, remaining: 0 },
        declaredScope: { paths: ["packages/broker/src/core/broker-exchange-task-decision.ts"] },
      },
    }), {
      PATH: process.env.PATH,
      A2A_EXECUTOR_MODE: "docker",
      A2A_DOCKER_RUNNER_BIN: runner,
    });

    assert.equal(result.result, undefined);
    assert.equal(result.error?.code, "hybrid_subagent_budget_exhausted");
    assert.match(result.error?.message ?? "", /subagentBudget/i);
    assert.equal(existsSync(invocation), false, "budget-exhausted H2 tasks must not invoke the runner");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("H2 RED: hybrid-subagent declaredScope rejects out-of-scope runner evidence (#1348)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-h2-scope-red-"));
  const runner = join(dir, "fake-runner.mjs");
  writeHybridRunnerStub(runner, `
process.stdout.write(JSON.stringify({
  ok: true,
  status: "pr_opened",
  prUrl: "https://github.com/jinwon-int/a2a-nexus/pull/9998",
  branch: "h2-scope-drift",
  filesChanged: ["packages/broker/src/core/store.ts"],
  tests: ["npx tsx --test packages/broker/src/core/lifecycle.test.ts -> pass"]
}) + "\\n");
`);

  try {
    const result = handleTask(patchTask({
      id: "task-h2-scope-drift",
      payload: {
        repo: "jinwon-int/a2a-nexus",
        issue: "#1348",
        issueUrl: "https://github.com/jinwon-int/a2a-nexus/issues/1348",
        executionMode: "hybrid-subagent",
        subagentBudget: { max: 2, remaining: 1 },
        declaredScope: { paths: ["packages/broker/src/core/broker-exchange-task-decision.ts"] },
      },
    }), {
      PATH: process.env.PATH,
      A2A_EXECUTOR_MODE: "docker",
      A2A_DOCKER_RUNNER_BIN: runner,
    });

    assert.equal(result.result, undefined);
    assert.equal(result.error?.code, "hybrid_declared_scope_violation");
    assert.deepEqual(result.error?.details?.outsideDeclaredScope, ["packages/broker/src/core/store.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("H2 GREEN: hybrid-subagent accepts in-budget in-scope runner evidence (#1348)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-h2-happy-path-"));
  const runner = join(dir, "fake-runner.mjs");
  const invocation = join(dir, "runner-invoked.json");
  writeHybridRunnerStub(runner, `
const { readFileSync, writeFileSync } = await import("node:fs");
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
writeFileSync(${JSON.stringify(invocation)}, JSON.stringify(task, null, 2));
process.stdout.write(JSON.stringify({
  ok: true,
  status: "pr_opened",
  prUrl: "https://github.com/jinwon-int/a2a-nexus/pull/9996",
  branch: "h2-happy-path",
  filesChanged: ["packages/broker/src/core/broker-exchange-task-decision.ts"],
  tests: ["hybrid happy path runner invoked"]
}) + "\\n");
`);

  try {
    const result = handleTask(patchTask({
      id: "task-h2-happy-path",
      payload: {
        repo: "jinwon-int/a2a-nexus",
        issue: "#1348",
        issueUrl: "https://github.com/jinwon-int/a2a-nexus/issues/1348",
        executionMode: "hybrid-subagent",
        subagentBudget: { max: 2, remaining: 1 },
        declaredScope: { paths: ["packages/broker/src/core/broker-exchange-task-decision.ts"] },
      },
    }), {
      PATH: process.env.PATH,
      A2A_EXECUTOR_MODE: "docker",
      A2A_DOCKER_RUNNER_BIN: runner,
    });

    assert.equal(result.error, undefined);
    assert.equal(result.result?.output?.prUrl, "https://github.com/jinwon-int/a2a-nexus/pull/9996");
    assert.equal(existsSync(invocation), true, "in-budget H2 tasks should invoke the runner");
    assert.deepEqual(result.result?.output?.filesChanged, ["packages/broker/src/core/broker-exchange-task-decision.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("H2 GREEN: declaredScope uses directory-boundary matching, not substring matching (#1348/#1235)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-h2-scope-boundary-"));
  const runner = join(dir, "fake-runner.mjs");
  writeHybridRunnerStub(runner, `
process.stdout.write(JSON.stringify({
  ok: true,
  status: "pr_opened",
  prUrl: "https://github.com/jinwon-int/a2a-nexus/pull/9995",
  branch: "h2-boundary-drift",
  filesChanged: ["packages/broker-evil/src/backdoor.ts"],
  tests: ["boundary drift should fail"]
}) + "\\n");
`);

  try {
    const result = handleTask(patchTask({
      id: "task-h2-scope-boundary",
      payload: {
        repo: "jinwon-int/a2a-nexus",
        issue: "#1348",
        issueUrl: "https://github.com/jinwon-int/a2a-nexus/issues/1348",
        executionMode: "hybrid-subagent",
        subagentBudget: { max: 2, remaining: 1 },
        declaredScope: { paths: ["packages/broker/**"] },
      },
    }), {
      PATH: process.env.PATH,
      A2A_EXECUTOR_MODE: "docker",
      A2A_DOCKER_RUNNER_BIN: runner,
    });

    assert.equal(result.result, undefined);
    assert.equal(result.error?.code, "hybrid_declared_scope_violation");
    assert.deepEqual(result.error?.details?.outsideDeclaredScope, ["packages/broker-evil/src/backdoor.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("H2 RED: write-point readback catches an under-reporting runner (out-of-scope write, filesChanged:[]) (#1376)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-h2-writepoint-red-"));
  const runner = join(dir, "fake-runner.mjs");
  // The runner writes an OUT-OF-SCOPE file into a git worktree it controls but
  // UNDER-REPORTS filesChanged:[] — the self-report gate would pass. The handler
  // must independently git-inspect workDir and fail closed.
  writeHybridRunnerStub(runner, `
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
const wd = mkdtempSync(join(tmpdir(), "h2-runner-worktree-"));
spawnSync("git", ["-C", wd, "init", "-q"], { encoding: "utf8" });
const evil = join(wd, "packages/broker/src/core/store.ts");
mkdirSync(dirname(evil), { recursive: true });
writeFileSync(evil, "// out-of-scope write the runner hid\\n");
process.stdout.write(JSON.stringify({
  ok: true,
  status: "pr_opened",
  prUrl: "https://github.com/jinwon-int/a2a-nexus/pull/9994",
  branch: "h2-underreport",
  workDir: wd,
  filesChanged: [],
  tests: ["under-report should be caught by write-point readback"]
}) + "\\n");
`);

  try {
    const result = handleTask(patchTask({
      id: "task-h2-underreport",
      payload: {
        repo: "jinwon-int/a2a-nexus",
        issue: "#1376",
        issueUrl: "https://github.com/jinwon-int/a2a-nexus/issues/1376",
        executionMode: "hybrid-subagent",
        subagentBudget: { max: 2, remaining: 1 },
        declaredScope: { paths: ["packages/broker/src/core/broker-exchange-task-decision.ts"] },
      },
    }), {
      PATH: process.env.PATH,
      A2A_EXECUTOR_MODE: "docker",
      A2A_DOCKER_RUNNER_BIN: runner,
    });

    assert.equal(result.result, undefined, "under-reporting runner must not produce accepted evidence");
    assert.equal(result.error?.code, "hybrid_declared_scope_writepoint_violation");
    assert.deepEqual(result.error?.details?.outsideDeclaredScope, ["packages/broker/src/core/store.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("H2 GREEN: write-point readback accepts an in-scope actual git diff (#1376)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-h2-writepoint-green-"));
  const runner = join(dir, "fake-runner.mjs");
  writeHybridRunnerStub(runner, `
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
const wd = mkdtempSync(join(tmpdir(), "h2-runner-worktree-"));
spawnSync("git", ["-C", wd, "init", "-q"], { encoding: "utf8" });
const inScope = join(wd, "packages/broker/src/core/broker-exchange-task-decision.ts");
mkdirSync(dirname(inScope), { recursive: true });
writeFileSync(inScope, "// in-scope change\\n");
process.stdout.write(JSON.stringify({
  ok: true,
  status: "pr_opened",
  prUrl: "https://github.com/jinwon-int/a2a-nexus/pull/9993",
  branch: "h2-writepoint-ok",
  workDir: wd,
  filesChanged: ["packages/broker/src/core/broker-exchange-task-decision.ts"],
  tests: ["in-scope write-point readback passes"]
}) + "\\n");
`);

  try {
    const result = handleTask(patchTask({
      id: "task-h2-writepoint-ok",
      payload: {
        repo: "jinwon-int/a2a-nexus",
        issue: "#1376",
        issueUrl: "https://github.com/jinwon-int/a2a-nexus/issues/1376",
        executionMode: "hybrid-subagent",
        subagentBudget: { max: 2, remaining: 1 },
        declaredScope: { paths: ["packages/broker/src/core/broker-exchange-task-decision.ts"] },
      },
    }), {
      PATH: process.env.PATH,
      A2A_EXECUTOR_MODE: "docker",
      A2A_DOCKER_RUNNER_BIN: runner,
    });

    assert.equal(result.error, undefined, result.error?.message ?? "");
    assert.equal(result.result?.output?.prUrl, "https://github.com/jinwon-int/a2a-nexus/pull/9993");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("github-read-only-validation uses the read-only analysis bridge when enabled (#884)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-openclaw-analysis-"));
  const bin = join(dir, "fake-openclaw.mjs");
  writeFileSync(bin, `#!/usr/bin/env node
const response = {
  status: "done",
  summary: "source-backed readonly validation reached analysis bridge",
  findings: ["bridge invoked"],
  risks: ["none"],
  recommendations: ["continue"],
  evidenceRefs: ["#884"],
  recoverySource: "state_db"
};
process.stdout.write(JSON.stringify({ text: JSON.stringify(response) }) + "\\n");
`);
  chmodSync(bin, 0o755);
  try {
    const result = handleTask({
      id: "task-readonly-bridge",
      intent: "analyze",
      assignedWorkerId: "workerbeta",
      message: "Analyze #884 read-only evidence",
      payload: {
        mode: "github-read-only-validation",
        repo: "jinwon-int/a2a-nexus",
        issue: "#884",
        sourceOnly: true,
        readOnlyValidation: true,
        noLive: true,
        noGitHubWrites: true,
      },
    }, {
      PATH: process.env.PATH,
      A2A_EXECUTOR_MODE: "builtin",
      A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
      A2A_OPENCLAW_ANALYSIS_BIN: bin,
      A2A_OPENCLAW_ANALYSIS_TIMEOUT_SEC: "1",
      A2A_NODE_ID: "workerbeta",
    });

    assert.equal(result.error, undefined);
    assert.equal(result.result.output.analysisKind, "analysis_bridge");
    // Default adapter for a worker whose env names no harness. Was "openclaw";
    // piri since the fleet runs CCC_AGENT_PROVIDER=piri and the openclaw default
    // resolved to a binary installed nowhere.
    assert.equal(result.result.output.bridgeAdapter, "piri");
    assert.equal(result.result.output.analysisStatus, "done");
    assert.equal(result.result.output.recoverySource, "state_db");
    assert.match(result.result.summary, /analysis bridge done/);
    assert.equal(result.result.note, "read-only A2A analysis completed through analysis bridge");
    assert.deepEqual(result.result.output.findings, ["bridge invoked"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analysis bridge injects signed retrieval snapshots and declares result.output.sources (#1378 K2 wave2)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-analysis-snapshot-binding-"));
  const bin = join(dir, "fake-openclaw-snapshot.mjs");
  const snapshot = signedSnapshotFixture();
  writeFileSync(bin, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const payload = JSON.parse(readFileSync(process.env.A2A_ANALYSIS_PAYLOAD_FILE, "utf8"));
const files = payload.sourceBundle?.files || [];
if (files.length !== 1) throw new Error("expected exactly one retrieval snapshot source carrier");
if (!files[0].untrustedExternalData) throw new Error("snapshot carrier must be marked untrustedExternalData");
if (!String(files[0].contentText || "").includes("<untrusted_external_data ")) throw new Error("snapshot content must be delimiter-safe external data");
if (String(files[0].contentText || "").includes("signature")) throw new Error("source carrier text must not expose signature material");
const response = {
  status: "done",
  summary: "snapshot-backed analysis reached bridge",
  findings: ["bridge consumed signed snapshot carrier"],
  risks: [],
  recommendations: ["declare consumed snapshot in result.output.sources"],
  evidenceRefs: [files[0].repo + ":" + files[0].path]
};
process.stdout.write(JSON.stringify({ payloads: [{ text: JSON.stringify(response) }] }) + "\\n");
`);
  chmodSync(bin, 0o755);
  try {
    const result = handleTask({
      id: "task-snapshot-binding",
      intent: "analyze",
      assignedWorkerId: "workergamma",
      message: "Analyze from signed retrieval snapshot only",
      payload: {
        mode: "github-read-only-validation",
        repo: "jinwon-int/a2a-nexus",
        issue: "#1378",
        sourceOnly: true,
        readOnlyValidation: true,
        noLive: true,
        noGitHubWrites: true,
        sourceBundle: { files: [] },
        retrievalSnapshots: [snapshot],
      },
    }, {
      PATH: process.env.PATH,
      A2A_EXECUTOR_MODE: "builtin",
      A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
      A2A_OPENCLAW_ANALYSIS_BIN: bin,
      A2A_OPENCLAW_ANALYSIS_TIMEOUT_SEC: "1",
      A2A_NODE_ID: "workergamma",
    });

    assert.equal(result.error, undefined);
    assert.equal(result.result.output.analysisStatus, "done");
    assert.equal(result.result.output.sources.length, 1);
    assert.match(result.result.output.sources[0].sourceId, /^github-retrieval:sha256:[0-9a-f]{64}$/);
    assert.equal(result.result.output.sources[0].contentHash, snapshot.contentHash);
    assert.doesNotMatch(JSON.stringify(result.result.output.sources), /source-grounded analysis fixture/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analysis bridge rejects unsigned retrieval snapshots before invoking bridge (#1378 K2 wave2)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-analysis-unsigned-snapshot-"));
  const bin = join(dir, "must-not-run.mjs");
  writeFileSync(bin, `#!/usr/bin/env node\nthrow new Error("analysis bridge must not run for unsigned snapshots");\n`);
  chmodSync(bin, 0o755);
  try {
    const snapshot = signedSnapshotFixture();
    delete snapshot.signature;
    const result = handleTask({
      id: "task-unsigned-snapshot",
      intent: "analyze",
      assignedWorkerId: "workergamma",
      message: "Analyze from signed retrieval snapshot only",
      payload: {
        mode: "github-read-only-validation",
        sourceOnly: true,
        readOnlyValidation: true,
        noLive: true,
        noGitHubWrites: true,
        sourceBundle: { files: [] },
        retrievalSnapshots: [snapshot],
      },
    }, {
      PATH: process.env.PATH,
      A2A_EXECUTOR_MODE: "builtin",
      A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
      A2A_OPENCLAW_ANALYSIS_BIN: bin,
      A2A_OPENCLAW_ANALYSIS_TIMEOUT_SEC: "1",
      A2A_NODE_ID: "workergamma",
    });

    assert.equal(result.error.code, "retrieval_snapshot_invalid");
    assert.match(result.error.message, /missing signed snapshot signature/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("github-read-only-validation prefers analysis bridge over docker patch/no-diff routing (#1275)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-readonly-routing-"));
  const runner = join(dir, "fake-runner.mjs");
  const bin = join(dir, "fake-analysis.mjs");
  writeFileSync(runner, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, status: "done", noDiff: true }) + "\\n");
`);
  writeFileSync(bin, `#!/usr/bin/env node
const response = {
  status: "done",
  summary: "read-only review reached analysis bridge instead of docker patch path",
  findings: ["analysis bridge invoked"],
  risks: ["none"],
  recommendations: ["continue"],
  evidenceRefs: ["#1275"]
};
process.stdout.write(JSON.stringify({ payloads: [{ text: JSON.stringify(response) }] }) + "\\n");
`);
  chmodSync(runner, 0o755);
  chmodSync(bin, 0o755);
  try {
    const result = handleTask({
      id: "task-readonly-routing",
      intent: "analyze",
      assignedWorkerId: "gongyung",
      message: "GO/NO-GO read-only review should not require a patch diff",
      payload: {
        mode: "github-read-only-validation",
        repo: "jinwon-int/a2a-nexus",
        issue: "#1275",
        sourceOnly: true,
        readOnlyValidation: true,
        noLive: true,
        noGitHubWrites: true,
      },
    }, {
      PATH: process.env.PATH,
      A2A_EXECUTOR_MODE: "docker",
      A2A_DOCKER_RUNNER_SCOPE: "all-github",
      A2A_DOCKER_RUNNER_BIN: runner,
      A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
      A2A_OPENCLAW_ANALYSIS_BIN: bin,
      A2A_OPENCLAW_ANALYSIS_TIMEOUT_SEC: "1",
      A2A_NODE_ID: "gongyung",
    });

    assert.equal(result.error, undefined);
    assert.equal(result.result.output.analysisKind, "analysis_bridge");
    // Default adapter for a worker whose env names no harness. Was "openclaw";
    // piri since the fleet runs CCC_AGENT_PROVIDER=piri and the openclaw default
    // resolved to a binary installed nowhere.
    assert.equal(result.result.output.bridgeAdapter, "piri");
    assert.equal(result.result.output.analysisStatus, "done");
    assert.equal(result.result.output.findings[0], "analysis bridge invoked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("review.required analysis bridge output emits review validation (#1330)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-review-validation-"));
  const bin = join(dir, "fake-review-bridge.mjs");
  writeFileSync(bin, `#!/usr/bin/env node
const response = {
  status: "done",
  summary: "PASS: source projection matches the requested helper boundary",
  findings: ["PASS: helper boundary is isolated"],
  risks: ["none"],
  recommendations: ["merge"],
  evidenceRefs: ["#1330"]
};
process.stdout.write(JSON.stringify({ text: JSON.stringify(response) }) + "\\n");
`);
  chmodSync(bin, 0o755);
  try {
    const reviewTask = {
      id: "task-review-required",
      intent: "analyze",
      assignedWorkerId: "author-worker",
      message: "Review the patch and return explicit PASS/FAIL with note.",
      payload: {
        mode: "analysis-only",
        sourceOnly: true,
        readOnlyValidation: true,
        review: { required: true, targetLaneId: "lane-1" },
      },
    };
    const result = handleTask(reviewTask, {
      PATH: process.env.PATH,
      A2A_EXECUTOR_MODE: "builtin",
      A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
      A2A_OPENCLAW_ANALYSIS_BIN: bin,
      A2A_NODE_ID: "reviewer-node",
    });

    assert.equal(result.error, undefined);
    assert.deepEqual(result.result.validations, [{
      kind: "review",
      verdict: "pass",
      nodeId: "reviewer-node",
      note: "source projection matches the requested helper boundary",
    }]);

    const { validateReviewEvidence } = await import("../dist/worker-review.js");
    assert.equal(validateReviewEvidence({
      id: reviewTask.id,
      intent: "analyze",
      status: "running",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "author-worker", kind: "node", role: "analyst" },
      targetNodeId: "author-worker",
      assignedWorkerId: "author-worker",
      claimedBy: "author-worker",
      payload: reviewTask.payload,
      createdAt: "2026-07-05T00:00:00.000Z",
      updatedAt: "2026-07-05T00:00:00.000Z",
    }, result.result), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review.required analysis bridge omits validation when verdict is absent (#1330)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-review-validation-absent-"));
  const bin = join(dir, "fake-review-bridge.mjs");
  writeFileSync(bin, `#!/usr/bin/env node
const response = {
  status: "done",
  summary: "source projection has observations but no verdict",
  findings: ["helper boundary exists"],
  risks: ["unknown"],
  recommendations: ["inspect manually"]
};
process.stdout.write(JSON.stringify({ text: JSON.stringify(response) }) + "\\n");
`);
  chmodSync(bin, 0o755);
  try {
    const result = handleTask({
      id: "task-review-no-verdict",
      intent: "analyze",
      assignedWorkerId: "author-worker",
      message: "Review the patch.",
      payload: {
        mode: "analysis-only",
        sourceOnly: true,
        readOnlyValidation: true,
        review: { required: true },
      },
    }, {
      PATH: process.env.PATH,
      A2A_EXECUTOR_MODE: "builtin",
      A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
      A2A_OPENCLAW_ANALYSIS_BIN: bin,
      A2A_NODE_ID: "reviewer-node",
    });

    assert.equal(result.error, undefined);
    assert.equal(result.result.validations, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-review analysis bridge output does not emit review validation (#1330)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-review-validation-nonreview-"));
  const bin = join(dir, "fake-review-bridge.mjs");
  writeFileSync(bin, `#!/usr/bin/env node
const response = { status: "done", summary: "PASS: ordinary analysis", findings: [] };
process.stdout.write(JSON.stringify({ text: JSON.stringify(response) }) + "\\n");
`);
  chmodSync(bin, 0o755);
  try {
    const result = handleTask({
      id: "task-review-not-required",
      intent: "analyze",
      assignedWorkerId: "workerbeta",
      message: "Analyze only.",
      payload: { mode: "analysis-only", sourceOnly: true, readOnlyValidation: true },
    }, {
      PATH: process.env.PATH,
      A2A_EXECUTOR_MODE: "builtin",
      A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
      A2A_OPENCLAW_ANALYSIS_BIN: bin,
      A2A_NODE_ID: "workerbeta",
    });

    assert.equal(result.error, undefined);
    assert.equal(result.result.validations, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analysis bridge source projection blocks fail the task with stage/excerpt readback (#1257)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-source-projection-block-"));
  const bin = join(dir, "source-projection-block.mjs");
  writeFileSync(bin, `#!/usr/bin/env node
const response = {
  status: "blocked",
  summary: "source-only local bridge blocked round-1257: no_source_files",
  findings: ["sourceProjection quality=zero_files reason=no_source_files"],
  risks: ["source-only local evidence contract was not fully satisfied"],
  recommendations: ["retry with sourceBundle.files"],
  evidenceRefs: [],
  sourceProjection: {
    quality: "zero_files",
    budgetReason: "no_source_files",
    canonicalFileCount: 0,
    projectedFileCount: 0,
    canonicalBytes: 0,
    projectedBytes: 0,
    droppedByReason: { empty_content: 2 },
    warnings: ["skipped empty embedded source file: embedded:SUMMARY-ONLY.md", "skipped empty embedded source file: embedded:PAYLOAD.md"]
  },
  failureReadback: {
    stage: "projection",
    excerpt: "stage=projection quality=zero_files budgetReason=no_source_files canonicalFileCount=0 projectedFileCount=0 canonicalBytes=0 projectedBytes=0"
  }
};
console.log(JSON.stringify({ payloads: [{ text: JSON.stringify(response) }] }));
`);
  chmodSync(bin, 0o755);
  try {
    const result = handleTask({
      id: "task-source-projection-block",
      intent: "analyze",
      assignedWorkerId: "workeralpha",
      message: "Analyze empty source bundle",
      payload: {
        mode: "analysis-only",
        sourceOnly: true,
        noLive: true,
      },
    }, {
      PATH: process.env.PATH,
      A2A_EXECUTOR_MODE: "builtin",
      A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
      A2A_OPENCLAW_ANALYSIS_BIN: bin,
      A2A_NODE_ID: "workeralpha",
    });

    assert.equal(result.result, undefined);
    assert.equal(result.error?.code, "source_projection_blocked");
    assert.equal(result.error?.details.stage, "projection");
    assert.match(result.error?.details.excerpt ?? "", /quality=zero_files/);
    assert.deepEqual(result.error?.details.droppedByReason, { empty_content: 2 });
    assert.deepEqual(result.error?.details.warnings, [
      "skipped empty embedded source file: embedded:SUMMARY-ONLY.md",
      "skipped empty embedded source file: embedded:PAYLOAD.md",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analysis bridge reports carrier stats at task receipt and payload-file write (#1272)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-source-carrier-stats-"));
  const bin = join(dir, "source-carrier-stats.mjs");
  writeFileSync(bin, `#!/usr/bin/env node
const stats = JSON.parse(process.env.A2A_ANALYSIS_SOURCE_CARRIER_STATS || "{}");
const response = {
  status: "done",
  summary: "carrier stats visible",
  findings: ["source carrier stats visible to bridge"],
  sourceProjection: { quality: "complete", sourceCarrierStats: stats },
  evidenceRefs: []
};
console.log(JSON.stringify({ payloads: [{ text: JSON.stringify(response) }] }));
`);
  chmodSync(bin, 0o755);
  try {
    const result = handleTask({
      id: "task-source-carrier-stats",
      intent: "analyze",
      assignedWorkerId: "workeralpha",
      message: "Analyze carrier stats",
      payload: {
        mode: "analysis-only",
        sourceOnly: true,
        noLive: true,
        sourceFiles: [{ path: "A.md", content: "aaa" }],
        sourceBundle: { files: [{ path: "B.md", summary: "bbbb" }] },
      },
    }, {
      PATH: process.env.PATH,
      A2A_EXECUTOR_MODE: "builtin",
      A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
      A2A_OPENCLAW_ANALYSIS_BIN: bin,
      A2A_NODE_ID: "workeralpha",
    });

    assert.equal(result.error, undefined);
    assert.equal(result.result.output.sourceCarrierStats.taskReceipt.sourceFiles, 1);
    assert.equal(result.result.output.sourceCarrierStats.taskReceipt.sourceBundleFiles, 1);
    assert.equal(result.result.output.sourceCarrierStats.payloadFile.totalFiles, 2);
    assert.equal(result.result.output.sourceCarrierStats.lossyRecoveryUsed, false);
    assert.equal(result.result.output.sourceProjection.sourceCarrierStats.payloadFile.totalBytes, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analysis bridge fails closed when lossy JSON recovery reports zero_files (#1272)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-lossy-recovery-"));
  const bin = join(dir, "lossy-recovery.mjs");
  writeFileSync(bin, `#!/usr/bin/env node
const response = {
  status: "blocked",
  summary: "zero files after lossy recovery",
  sourceProjection: { quality: "zero_files", canonicalFileCount: 0, projectedFileCount: 0 },
};
console.log(JSON.stringify({ payloads: [{ text: "truncated payload prefix sourceFiles=[lost] " + JSON.stringify(response) + " trailing noise" }] }));
`);
  chmodSync(bin, 0o755);
  try {
    const result = handleTask({
      id: "task-lossy-recovery",
      intent: "analyze",
      assignedWorkerId: "workeralpha",
      message: "Analyze lossy recovery",
      payload: {
        mode: "analysis-only",
        sourceOnly: true,
        noLive: true,
        sourceFiles: [{ path: "A.md", content: "aaa" }],
      },
    }, {
      PATH: process.env.PATH,
      A2A_EXECUTOR_MODE: "builtin",
      A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
      A2A_OPENCLAW_ANALYSIS_BIN: bin,
      A2A_NODE_ID: "workeralpha",
    });

    assert.equal(result.result, undefined);
    assert.equal(result.error?.code, "payload_recovery_lossy");
    assert.equal(result.error?.details.stage, "payload_recovery");
    assert.equal(result.error?.details.sourceCarrierStats.taskReceipt.sourceFiles, 1);
    assert.equal(result.error?.details.recovery.lossy, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analysis bridge .mjs commands are invoked through the current Node binary for Termux service contexts (#1141)", () => {
  const invocation = __test.resolveNodeScriptInvocation("/data/data/com.termux/files/home/a2a-broker-worker/scripts/claude-a2a-patch-bridge.mjs", ["agent", "--json"]);

  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, ["/data/data/com.termux/files/home/a2a-broker-worker/scripts/claude-a2a-patch-bridge.mjs", "agent", "--json"]);
});

test("analysis bridge non-JS commands keep direct invocation", () => {
  const invocation = __test.resolveNodeScriptInvocation("openclaw", ["agent", "--json"]);

  assert.equal(invocation.command, "openclaw");
  assert.deepEqual(invocation.args, ["agent", "--json"]);
});

test("Termux glibc node wrappers use the node wrapper instead of process.execPath loader (#1141)", () => {
  const invocation = __test.resolveNodeScriptInvocation("/data/data/com.termux/files/home/a2a-broker-worker/scripts/claude-a2a-patch-bridge.mjs", ["agent"], {}, {
    execPath: "/data/data/com.termux/files/usr/glibc/lib/ld-linux-aarch64.so.1",
    argv0: "/data/data/com.termux/files/usr/bin/node.real",
  });

  assert.equal(invocation.command, "/data/data/com.termux/files/usr/bin/node");
  assert.deepEqual(invocation.args, ["/data/data/com.termux/files/home/a2a-broker-worker/scripts/claude-a2a-patch-bridge.mjs", "agent"]);
});

test("Claude bridge env is attributed as claude_code without OpenClaw success labels (#948)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-claude-telemetry-"));
  const bin = join(dir, "claude-a2a-analysis-bridge.mjs");
  writeFileSync(bin, `#!/usr/bin/env node
const response = {
  status: "done",
  summary: "Claude bridge telemetry reached analysis bridge",
  findings: ["claude bridge invoked"],
  risks: ["none"],
  recommendations: ["continue"],
  evidenceRefs: ["#948"],
  recoverySource: "direct_stdout",
  bridgeAdapter: "claude_code",
  requestedModel: "openai-codex/gpt-5.5",
  requestedThinking: "low",
  actualRuntimeModel: "claude-opus-4-8[1m]",
  modelInheritanceMode: "metadata_only",
  claudeModelArgumentApplied: false,
  modelInheritanceNote: "Claude Code bridge preserves model metadata without passing --model"
};
process.stdout.write(JSON.stringify({ payloads: [{ text: JSON.stringify(response) }] }) + "\\n");
`);
  chmodSync(bin, 0o755);
  try {
    const result = handleTask({
      id: "task-claude-telemetry",
      intent: "analyze",
      assignedWorkerId: "workeralpha",
      message: "Analyze Claude bridge sourceOnly evidence",
      payload: {
        mode: "analysis-only",
        sourceOnly: true,
        noLive: true,
      },
    }, {
      PATH: process.env.PATH,
      A2A_EXECUTOR_MODE: "builtin",
      A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
      A2A_OPENCLAW_ANALYSIS_BIN: bin,
      A2A_CLAUDE_CODE_BIN: "/usr/bin/claude",
      A2A_NODE_ID: "workeralpha",
    });

    assert.equal(result.error, undefined);
    assert.equal(result.result.output.analysisKind, "analysis_bridge");
    assert.equal(result.result.output.bridgeAdapter, "claude_code");
    assert.equal(result.result.output.bridgeCommand, "claude-a2a-analysis-bridge.mjs");
    assert.equal(result.result.output.analysisStatus, "done");
    assert.equal(result.result.output.recoverySource, "direct_stdout");
    assert.equal(result.result.output.bridgeReportedAdapter, "claude_code");
    assert.equal(result.result.output.requestedModel, "openai-codex/gpt-5.5");
    assert.equal(result.result.output.requestedThinking, "low");
    assert.equal(result.result.output.actualRuntimeModel, "claude-opus-4-8[1m]");
    assert.equal(result.result.output.modelInheritanceMode, "metadata_only");
    assert.equal(result.result.output.claudeModelArgumentApplied, false);
    assert.match(result.result.output.modelInheritanceNote, /preserves model metadata/);
    assert.equal(result.result.note, "read-only A2A analysis completed through analysis bridge");
    assert.doesNotMatch(result.result.note, /OpenClaw/);
    assert.doesNotMatch(JSON.stringify(result.result.output), /openclaw_bridge/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude bridge prose recovery source is preserved through task handler", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-claude-prose-recovery-"));
  const bin = join(dir, "claude-a2a-analysis-bridge.mjs");
  writeFileSync(bin, `#!/usr/bin/env node
const response = {
  status: "done",
  summary: "Claude prose was recovered as analysis",
  findings: ["recovered Claude Code prose opinion"],
  risks: ["strict JSON was not emitted"],
  recommendations: ["preserve recovery source"],
  evidenceRefs: ["claude-code:result"],
  recoverySource: "claude_result_text"
};
process.stdout.write(JSON.stringify({ payloads: [{ text: JSON.stringify(response) }] }) + "\\n");
`);
  chmodSync(bin, 0o755);
  try {
    const result = handleTask({
      id: "task-claude-prose-recovery",
      intent: "analyze",
      assignedWorkerId: "workereta",
      message: "Analyze Claude Code prose recovery evidence",
      payload: {
        mode: "analysis-only",
        sourceOnly: true,
        noLive: true,
      },
    }, {
      PATH: process.env.PATH,
      A2A_EXECUTOR_MODE: "builtin",
      A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
      A2A_OPENCLAW_ANALYSIS_BIN: bin,
      A2A_CLAUDE_CODE_BIN: "/usr/bin/claude",
      A2A_NODE_ID: "workereta",
    });

    assert.equal(result.error, undefined);
    assert.equal(result.result.output.bridgeAdapter, "claude_code");
    assert.equal(result.result.output.analysisStatus, "done");
    assert.equal(result.result.output.recoverySource, "claude_result_text");
    assert.deepEqual(result.result.output.findings, ["recovered Claude Code prose opinion"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("analysis bridge fails closed with missing bridge artifact before Node spawn (#1147)", () => {
  const missingBin = join(tmpdir(), `missing-workertheta-source-analysis-bridge-${Date.now()}.mjs`);
  const result = handleTask({
    id: "task-workertheta-missing-bridge",
    intent: "analyze",
    assignedWorkerId: "workertheta",
    message: "Analyze no-live bundle",
    payload: {
      mode: "analysis-only",
      sourceOnly: true,
      noLive: true,
      sourceBundle: { files: [{ repo: "ops-live-check", path: "health-check-request.md", content: "runId: missing-bridge" }] },
    },
  }, {
    PATH: process.env.PATH,
    A2A_EXECUTOR_MODE: "builtin",
    A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
    A2A_OPENCLAW_ANALYSIS_BIN: missingBin,
    A2A_NODE_ID: "workertheta",
  });

  assert.equal(result.error?.code, "openclaw_analysis_bridge_missing");
  assert.equal(result.error?.details.failureCategory, "missing_bridge_artifact");
  assert.equal(result.error?.details.bridgeCommand, missingBin);
});

test("Hermes source-only analysis bridge receives structured task files when prompt payload is truncated", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-hermes-structured-analysis-"));
  const bin = join(dir, "workertheta-source-analysis-bridge.mjs");
  writeFileSync(bin, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const payload = JSON.parse(readFileSync(process.env.A2A_ANALYSIS_PAYLOAD_FILE, "utf8"));
const task = JSON.parse(readFileSync(process.env.A2A_ANALYSIS_TASK_FILE, "utf8"));
const response = {
  status: payload.noLive === true && payload.sourceOnly === true && Array.isArray(payload.sourceBundle?.files) ? "done" : "blocked",
  summary: "Hermes source-only bridge read structured task file",
  findings: [
    "round=" + payload.parentRoundId,
    "role=" + payload.dialecticRole,
    "files=" + String(payload.sourceBundle?.files?.length || 0),
    "task=" + task.id,
  ],
  risks: [],
  recommendations: ["keep structured env file handoff"],
  evidenceRefs: [payload.sourceBundle.files[0].path],
  sourceProjection: { quality: "partial", canonicalFileCount: payload.sourceBundle.files.length, projectedFileCount: payload.sourceBundle.files.length },
  bridgeAdapter: "hermes"
};
process.stdout.write(JSON.stringify({ payloads: [{ text: JSON.stringify(response) }] }) + "\\n");
`);
  chmodSync(bin, 0o755);
  try {
    const result = handleTask({
      id: "task-workertheta-hermes-source-only",
      intent: "analyze",
      assignedWorkerId: "workertheta",
      message: "Analyze large source-only bundle",
      payload: {
        mode: "analysis-only",
        roundMode: "a2ad",
        parentRoundId: "round-large-payload",
        dialecticRole: "synthesis",
        sourceOnly: true,
        noLive: true,
        sourceBundle: {
          files: [{
            repo: "jinwon-int/ccc-node",
            path: "issue-190-pr192-full.patch",
            content: "x".repeat(40000),
          }],
        },
      },
    }, {
      PATH: process.env.PATH,
      A2A_EXECUTOR_MODE: "builtin",
      A2A_HERMES_ANALYSIS_ENABLED: "1",
      A2A_HERMES_ANALYSIS_BIN: bin,
      A2A_WORKER_RUNTIME_FLAVOR: "hermes-agent-source-only",
      A2A_NODE_ID: "workertheta",
      A2A_OPENCLAW_ANALYSIS_TIMEOUT_SEC: "1",
    });

    assert.equal(result.error, undefined);
    assert.equal(result.result.output.analysisKind, "analysis_bridge");
    assert.equal(result.result.output.bridgeAdapter, "hermes");
    assert.equal(result.result.output.bridgeCommand, "workertheta-source-analysis-bridge.mjs");
    assert.equal(result.result.output.bridgeReportedAdapter, "hermes");
    assert.equal(result.result.output.analysisStatus, "done");
    assert.equal(result.result.output.noLive, true);
    assert.equal(result.result.output.sourceOnly, true);
    assert.equal(result.result.output.role, "synthesis");
    assert.match(result.result.output.findings.join("\n"), /files=1/);
    assert.match(result.result.output.findings.join("\n"), /round=round-large-payload/);
    assert.equal(result.result.output.sourceProjection.quality, "partial");
    assert.equal(result.result.output.sourceProjection.canonicalFileCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("Hermes patch profile rejects legacy OPENCLAW_MODEL deepseek flash before docker runner execution (#860)", () => {
  const result = handleTask(patchTask(), {
    A2A_EXECUTOR_MODE: "docker",
    A2A_DOCKER_RUNNER_BIN: "this-must-not-run",
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
    OPENCLAW_MODEL: "deepseek/deepseek-v4-flash",
  });

  assert.equal(result.error?.code, "worker_model_not_supported_by_profile");
  assert.equal(result.error?.details.profile, "hermes");
  assert.equal(result.error?.details.canonicalModel, "deepseek/deepseek-v4-flash");
});

test("Hermes patch profile rejects later legacy model drift even when an earlier env model is supported (#860)", () => {
  const result = handleTask(patchTask(), {
    A2A_EXECUTOR_MODE: "docker",
    A2A_DOCKER_RUNNER_BIN: "this-must-not-run",
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
    A2A_HERMES_DEFAULT_MODEL: "openai-codex/gpt-5.5",
    OPENCLAW_MODEL: "deepseek/deepseek-v4-flash",
  });

  assert.equal(result.error?.code, "worker_model_not_supported_by_profile");
  assert.equal(result.error?.details.modelSource, "env");
  assert.equal(result.error?.details.canonicalModel, "deepseek/deepseek-v4-flash");
});

test("Hermes plugin preset tasks reject runner env model drift before plugin execution (#860)", () => {
  const result = handleTask(patchTask({
    payload: {
      repo: "jinwon-int/openclaw-plugin-a2a",
      runnerPreset: "openclaw-plugin-a2a-dev",
    },
  }), {
    A2A_EXECUTOR_MODE: "docker",
    A2A_DOCKER_RUNNER_BIN: "this-must-not-run",
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
    A2A_HERMES_DEFAULT_MODEL: "openai-codex/gpt-5.5",
    A2A_DOCKER_RUNNER_WORKER_MODEL: "deepseek/deepseek-v4-flash",
  });

  assert.equal(result.error?.code, "worker_model_not_supported_by_profile");
  assert.equal(result.error?.details.modelSource, "env");
  assert.equal(result.error?.details.canonicalModel, "deepseek/deepseek-v4-flash");
});

test("github-verify read-only tasks with plugin-only scope return structured Block evidence instead of executor config error (#860)", () => {
  const result = handleTask({
    id: "task-readonly-verify",
    intent: "verify",
    message: "Verify source-only advisory sidecar guardrails",
    payload: {
      mode: "github-verify",
      repo: "jinwon-int/a2a-nexus",
      issue: "#764",
      issueUrl: "https://github.com/jinwon-int/a2a-nexus/issues/764",
      readOnlyValidation: true,
      forbidNewPr: true,
      sourceOnly: true,
      noLive: true,
    },
  }, {
    A2A_EXECUTOR_MODE: "auto",
    A2A_DOCKER_RUNNER_SCOPE: "plugin-only",
  });

  assert.equal(result.error, undefined);
  assert.equal(result.result.output.analysisStatus, "blocked");
  assert.equal(result.result.output.blockReason, "github_readonly_executor_not_configured");
  assert.equal(result.result.output.noLive, true);
  assert.equal(result.result.output.sourceOnly, true);
});

// #1726 — 페이로드 전문 파일이 핸들러 cwd 밖(OS tmpdir)에 있으면
// claude-code 어댑터가 열지 못해 평가자가 16k 발췌만 보고 BLOCK 을 낸다.
// 실제로 nclex PR #113 라운드에서 codex 노드는 findings 12건, claude-code 노드는
// "파일시스템 전역 Glob 에서도 파일 0건" 으로 BLOCK 이 갈렸다.
test("analysis bridge writes the full payload under the handler cwd and pins its absolute path (#1726)", () => {
  const workspace = mkdtempSync(join(tmpdir(), "a2a-handler-cwd-"));
  const dir = mkdtempSync(join(tmpdir(), "a2a-payload-scope-"));
  const bin = join(dir, "claude-a2a-analysis-bridge.mjs");
  const capture = join(dir, "capture.json");
  writeFileSync(bin, `#!/usr/bin/env node
import fs from "node:fs";
// 프롬프트는 stdin 이 아니라 --message 인자로 전달된다.
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf("--message") + 1] || "";
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  payloadFile: process.env.A2A_ANALYSIS_PAYLOAD_FILE || "",
  payloadReadable: (() => {
    try { return fs.readFileSync(process.env.A2A_ANALYSIS_PAYLOAD_FILE, "utf8").length > 0; }
    catch { return false; }
  })(),
  prompt,
}));
const response = {
  status: "done", summary: "ok", findings: [], risks: [], recommendations: [],
  evidenceRefs: ["#1726"], bridgeAdapter: "claude_code",
};
process.stdout.write(JSON.stringify({ payloads: [{ text: JSON.stringify(response) }] }) + "\\n");
`);
  chmodSync(bin, 0o755);

  const result = handleTask({
    id: "task-payload-scope",
    intent: "analyze",
    assignedWorkerId: "workeralpha",
    message: "Analyze payload scope",
    payload: { mode: "analysis-only", sourceOnly: true, noLive: true, bulk: "x".repeat(40000) },
  }, {
    PATH: process.env.PATH,
    A2A_EXECUTOR_MODE: "builtin",
    A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
    A2A_OPENCLAW_ANALYSIS_BIN: bin,
    A2A_CLAUDE_CODE_BIN: "/usr/bin/claude",
    A2A_NODE_ID: "workeralpha",
    A2A_HANDLER_CWD: workspace,
  });

  assert.equal(result.error, undefined);
  const seen = JSON.parse(readFileSync(capture, "utf8"));

  // 핸들러 cwd 하위여야 claude-code 가 읽을 수 있다.
  assert.ok(
    seen.payloadFile.startsWith(workspace),
    `payload file must live under the handler cwd; got ${seen.payloadFile} (cwd ${workspace})`,
  );
  assert.equal(seen.payloadReadable, true, "bridge child must be able to read the full payload file");
  // 환경변수 이름만 주면 평가자가 Glob 탐색에 실패해 "파일 0건"으로 본다.
  assert.ok(
    seen.prompt.includes(seen.payloadFile),
    "prompt must pin the absolute payload path so the reviewer can Read it without globbing",
  );
});

test("analysis handler preserves structured bridge failure details (#1725)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-analysis-bridge-failure-"));
  const bin = join(dir, "failing-bridge.mjs");
  writeFileSync(bin, `#!/usr/bin/env node
process.stderr.write('A2A_BRIDGE_ERROR={"code":"analysis_bridge_invalid_json","stage":"extract","failureShape":"schema_invalid","adapterClass":"claude_code","bridgeContractVersion":"claude-a2a-analysis.v1","structuredOutputMode":"cli_json_output","turnsUsed":20,"elapsedMs":920000}\\n');
process.stderr.write('Claude output did not contain valid analysis JSON\\n');
process.exit(1);
`);
  chmodSync(bin, 0o755);
  try {
    const result = handleTask({
      id: "task-structured-bridge-failure",
      intent: "analyze",
      assignedWorkerId: "workerzeta",
      message: "Analyze #1725 read-only evidence",
      payload: {
        mode: "github-read-only-validation",
        repo: "jinwon-int/a2a-nexus",
        issue: "#1725",
        sourceOnly: true,
        readOnlyValidation: true,
        noLive: true,
        noGitHubWrites: true,
      },
    }, {
      PATH: process.env.PATH,
      A2A_EXECUTOR_MODE: "builtin",
      A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
      A2A_OPENCLAW_ANALYSIS_BIN: bin,
      A2A_OPENCLAW_ANALYSIS_TIMEOUT_SEC: "5",
      A2A_NODE_ID: "workerzeta",
    });

    assert.equal(result.error?.code, "openclaw_analysis_failed", "outer code stays compatible with existing classifiers");
    const bridgeFailure = result.error?.details?.bridgeFailure;
    assert.ok(bridgeFailure, "structured bridge failure must be preserved in error details");
    assert.equal(bridgeFailure.code, "analysis_bridge_invalid_json");
    assert.equal(bridgeFailure.stage, "extract");
    assert.equal(bridgeFailure.failureShape, "schema_invalid");
    assert.equal(bridgeFailure.adapterClass, "claude_code");
    assert.equal(bridgeFailure.turnsUsed, 20);
    assert.equal(bridgeFailure.elapsedMs, 920000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analysis handler tolerates bridges without the structured failure line", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-analysis-bridge-plain-failure-"));
  const bin = join(dir, "plain-failing-bridge.mjs");
  writeFileSync(bin, `#!/usr/bin/env node
process.stderr.write('plain legacy failure with no structured line\\n');
process.exit(1);
`);
  chmodSync(bin, 0o755);
  try {
    const result = handleTask({
      id: "task-legacy-bridge-failure",
      intent: "analyze",
      assignedWorkerId: "workerzeta",
      message: "Analyze legacy failure read-only",
      payload: {
        mode: "github-read-only-validation",
        repo: "jinwon-int/a2a-nexus",
        sourceOnly: true,
        readOnlyValidation: true,
        noLive: true,
        noGitHubWrites: true,
      },
    }, {
      PATH: process.env.PATH,
      A2A_EXECUTOR_MODE: "builtin",
      A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
      A2A_OPENCLAW_ANALYSIS_BIN: bin,
      A2A_OPENCLAW_ANALYSIS_TIMEOUT_SEC: "5",
      A2A_NODE_ID: "workerzeta",
    });

    assert.equal(result.error?.code, "openclaw_analysis_failed");
    assert.equal(result.error?.details?.bridgeFailure, undefined, "legacy bridges keep the pre-#1725 failure shape");
    assert.match(result.error?.message || "", /plain legacy failure/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bridge failure details are projected onto a bounded field set before reaching the task error (#1725)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-analysis-bridge-forged-failure-"));
  const bin = join(dir, "forged-failing-bridge.mjs");
  const forged = JSON.stringify({
    code: "analysis_bridge_schema_unsatisfied",
    stage: "validate",
    failureShape: "provider_or_model_failure",
    adapterClass: "piri",
    bridgeContractVersion: "piri-a2a-analysis.v1",
    structuredOutputMode: "piri_output_schema",
    requestedModel: "kimi-coding/k3",
    actualRuntimeModel: "zai/glm-5.2",
    modelInheritanceMode: "bridge_env_pin",
    excerpt: "x".repeat(900),
    turnsUsed: -5,
    elapsedMs: 1234,
    // unknown key with oversized payload must not survive
    promptLeak: "y".repeat(5000),
    sourceCarrierStats: {
      sourceFiles: 3,
      totalFiles: 3,
      totalBytes: 4096,
      secretPath: "/root/.ssh/id_ed25519",
      totalBytesFractional: 1.5,
    },
    executionTelemetry: {
      schemaVersion: "a2a.analysis-execution-telemetry.v1",
      source: "piri_progress_file",
      elapsedMs: 1234,
      schemaRetries: 2,
      schemaRetryReasons: { extra_property: 1, forged_reason: 7 },
      modelRequests: 4,
    },
  });
  // forged is already the JSON string; one stringify here turns it into a
  // safely escaped JS string literal whose runtime value is the raw JSON.
  const detailJson = JSON.stringify(forged);
  writeFileSync(bin, `#!/usr/bin/env node
const line = "A2A_BRIDGE_ERROR=" + ${detailJson};
process.stderr.write(line + String.fromCharCode(10));
process.exit(1);
`);
  chmodSync(bin, 0o755);
  try {
    const result = handleTask({
      id: "task-forged-bridge-failure",
      intent: "analyze",
      assignedWorkerId: "workerzeta",
      message: "Analyze forged bridge failure read-only",
      payload: {
        mode: "github-read-only-validation",
        repo: "jinwon-int/a2a-nexus",
        sourceOnly: true,
        readOnlyValidation: true,
        noLive: true,
        noGitHubWrites: true,
      },
    }, {
      PATH: process.env.PATH,
      A2A_EXECUTOR_MODE: "builtin",
      A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
      A2A_OPENCLAW_ANALYSIS_BIN: bin,
      A2A_OPENCLAW_ANALYSIS_TIMEOUT_SEC: "5",
      A2A_NODE_ID: "workerzeta",
    });

    assert.equal(result.error?.code, "openclaw_analysis_failed");
    const bridgeFailure = result.error?.details?.bridgeFailure;
    assert.ok(bridgeFailure, "structured failure survives");
    // bounded string set
    assert.equal(bridgeFailure.code, "analysis_bridge_schema_unsatisfied");
    assert.equal(bridgeFailure.requestedModel, "kimi-coding/k3");
    assert.equal(bridgeFailure.actualRuntimeModel, "zai/glm-5.2");
    assert.ok(!("promptLeak" in bridgeFailure), "unknown keys drop off");
    assert.ok(bridgeFailure.excerpt.length <= 500, "excerpt is capped");
    assert.equal(bridgeFailure.turnsUsed, undefined, "negative counts drop off");
    assert.equal(bridgeFailure.elapsedMs, 1234);
    // source stats keep only known non-negative integer keys
    assert.deepEqual(bridgeFailure.sourceCarrierStats, { sourceFiles: 3, totalFiles: 3, totalBytes: 4096 });
    // telemetry reuses the #1847 bounded-enum normalizer
    assert.equal(bridgeFailure.executionTelemetry.schemaRetries, 2);
    assert.deepEqual(bridgeFailure.executionTelemetry.schemaRetryReasons, { extra_property: 1 });
    assert.equal(bridgeFailure.executionTelemetry.modelRequests, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a structured failure line without a code is discarded, not half-preserved", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-analysis-bridge-nocode-failure-"));
  const bin = join(dir, "nocode-failing-bridge.mjs");
  writeFileSync(bin, `#!/usr/bin/env node
const line = "A2A_BRIDGE_ERROR=" + '{"stage":"extract","adapterClass":"piri","elapsedMs":5}';
process.stderr.write(line + String.fromCharCode(10));
process.exit(1);
`);
  chmodSync(bin, 0o755);
  try {
    const result = handleTask({
      id: "task-nocode-bridge-failure",
      intent: "analyze",
      assignedWorkerId: "workerzeta",
      message: "Analyze codeless bridge failure read-only",
      payload: {
        mode: "github-read-only-validation",
        repo: "jinwon-int/a2a-nexus",
        sourceOnly: true,
        readOnlyValidation: true,
        noLive: true,
        noGitHubWrites: true,
      },
    }, {
      PATH: process.env.PATH,
      A2A_EXECUTOR_MODE: "builtin",
      A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
      A2A_OPENCLAW_ANALYSIS_BIN: bin,
      A2A_OPENCLAW_ANALYSIS_TIMEOUT_SEC: "5",
      A2A_NODE_ID: "workerzeta",
    });

    assert.equal(result.error?.code, "openclaw_analysis_failed");
    assert.equal(result.error?.details?.bridgeFailure, undefined, "no code means no structured failure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizeAnalysisBridgeAdapter maps piri aliases (a2a-nexus#1745)", () => {
  assert.equal(__test.normalizeAnalysisBridgeAdapter("piri"), "piri");
  assert.equal(__test.normalizeAnalysisBridgeAdapter("pi"), "piri");
  assert.equal(__test.normalizeAnalysisBridgeAdapter("Piri"), "piri");
  // 기존 어댑터 회귀 방지
  assert.equal(__test.normalizeAnalysisBridgeAdapter("claude-code"), "claude_code");
  assert.equal(__test.normalizeAnalysisBridgeAdapter("codex"), "codex");
  assert.equal(__test.normalizeAnalysisBridgeAdapter(""), "");
});
