import assert from "node:assert/strict";
import test from "node:test";

import { __test, handleTask } from "./a2a-task-handler.mjs";

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
