import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { __test, handleTask } from "./a2a-task-handler.mjs";
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
    assignedWorkerId: "yukson",
    message: "source-only test",
    payload: {
      mode: "docker-broker-noop-smoke",
      noOp: true,
      runId: "run-853",
      worker: "yukson",
      sourceOnly: true,
      ...overrides.payload,
    },
    ...overrides,
  };
}

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
    "openai-codex/gpt-5.5",
    "gpt-5.5",
    "grok-4.20",
    "minimax-m3",
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
  "openai-codex/gpt-5.5",
  "gpt-5.5",
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

test("worker model policy module exposes auditable allowlist and fallbacks (#799)", () => {
  assert.deepEqual(ALLOWED_WORKER_MODELS, [
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v4-pro",
    "deepseek-v4-pro",
    "openai-codex/gpt-5.5",
    "gpt-5.5",
    "grok-4.20",
    "minimax-m3",
  ]);
  assert.equal(DEFAULT_WORKER_MODEL, "openai-codex/gpt-5.5");
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
  assert.deepEqual(resolveWorkerThinkingInput("invalid"), { thinking: "low", fromPayload: false });
});

test("worker model policy prevents Hermes profile from accepting unsupported aliases (#799)", () => {
  assert.equal(canonicalizeWorkerModel("deepseek-v4-flash"), "deepseek/deepseek-v4-flash");
  assert.equal(canonicalizeWorkerModel("gpt-5.5"), "openai-codex/gpt-5.5");
  assert.equal(canonicalizeWorkerModel("custom:minimax/minimax-m3"), "minimax-m3");

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
    selectedThinking: "low",
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
    selectedThinking: "low",
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

test("normal source-only task uses current fleet baseline model and low thinking by default (#766)", () => {
  const runnerTask = __test.buildRunnerTask(task({
    intent: "propose_patch",
    payload: {
      mode: "github-propose-patch",
      issue: "#853",
      issueUrl: "https://github.com/jinwon-int/a2a-broker/issues/853",
      repo: "jinwon-int/a2a-broker",
    },
  }), {});

  assert.equal(runnerTask.workerModel, "openai-codex/gpt-5.5");
  assert.equal(runnerTask.workerThinking, "low");
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
      assignedWorkerId: "sogyo",
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
      A2A_NODE_ID: "sogyo",
    });

    assert.equal(result.error, undefined);
    assert.equal(result.result.output.analysisKind, "analysis_bridge");
    assert.equal(result.result.output.bridgeAdapter, "openclaw");
    assert.equal(result.result.output.analysisStatus, "done");
    assert.equal(result.result.output.recoverySource, "state_db");
    assert.match(result.result.summary, /analysis bridge done/);
    assert.equal(result.result.note, "read-only A2A analysis completed through analysis bridge");
    assert.deepEqual(result.result.output.findings, ["bridge invoked"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
      assignedWorkerId: "nosuk",
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
      A2A_NODE_ID: "nosuk",
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
      assignedWorkerId: "soonwook",
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
      A2A_NODE_ID: "soonwook",
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
