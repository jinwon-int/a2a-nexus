import assert from "node:assert/strict";
import test from "node:test";

import { __test, handleTask } from "./openclaw-a2a-task-handler.mjs";

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
  ]);
});

test("normal source-only task uses Flash model and low thinking by default", () => {
  const runnerTask = __test.buildRunnerTask(task({
    intent: "propose_patch",
    payload: {
      mode: "github-propose-patch",
      issue: "#853",
      issueUrl: "https://github.com/jinwon-int/a2a-broker/issues/853",
      repo: "jinwon-int/a2a-broker",
    },
  }), {});

  assert.equal(runnerTask.workerModel, "deepseek/deepseek-v4-flash");
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
