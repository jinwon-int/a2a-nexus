import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateRemoteHandoffVisibilityPolicy,
  mapRemoteHandoffPolicyError,
} from "../dist/src/handoff-visibility-policy.js";
import { createRemoteNodeHandoffAdapter } from "../dist/src/remote-node-handoff-adapter.js";

function activeConfig(extraConfig = {}) {
  return {
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: { baseUrl: "https://broker.example", ...extraConfig },
        },
      },
    },
  };
}

const remote = { nodeId: "nosuk", source: "displayKey" };

function event(overrides = {}) {
  return {
    sessionKey: "nosuk",
    target: { sessionKey: "nosuk", displayKey: "nosuk" },
    message: "delegate safely",
    task: { intent: "propose_patch", instructions: "delegate safely" },
    rawParams: { taskInput: { workspace: { workspaceId: "plugin-a2a" } } },
    ...overrides,
  };
}

test("handoff visibility policy allows configured remote target/task/workspace", () => {
  const decision = evaluateRemoteHandoffVisibilityPolicy({
    event: event(),
    remote,
    policy: {
      allowedTargets: ["nosuk"],
      allowedTaskKinds: ["propose_patch"],
      allowedWorkspaces: ["plugin-a2a"],
    },
  });

  assert.deepEqual(decision, {
    status: "allowed",
    visibility: "remote_handoff_allowed",
    remote,
  });
});

test("handoff visibility policy denies disallowed remote target before inner dispatch", async () => {
  let innerCalled = false;
  const adapter = createRemoteNodeHandoffAdapter(activeConfig(), {
    visibilityPolicy: { deniedTargets: ["nosuk"] },
    innerHook: async () => {
      innerCalled = true;
      return { handled: true, mode: "direct", result: {} };
    },
  });

  const result = await adapter(event());

  assert.equal(innerCalled, false);
  assert.equal(result.handled, false);
  assert.equal(result.visibility, "policy_denied");
  assert.equal(result.policy.status, "denied");
  assert.match(result.reason, /nosuk.*denied/);
  assert.deepEqual(result.remote, remote);
});

test("handoff visibility policy reports missing remote target explicitly", () => {
  const decision = evaluateRemoteHandoffVisibilityPolicy({
    event: event({ target: undefined, sessionKey: "agent:main:telegram:hub" }),
  });

  assert.deepEqual(decision, {
    status: "missing_target",
    visibility: "missing_target",
    reason: "remote handoff target could not be resolved",
  });
});

test("handoff visibility policy surfaces approval-required live handoff", () => {
  const decision = evaluateRemoteHandoffVisibilityPolicy({
    event: event({
      rawParams: {
        taskInput: {
          workspace: { workspaceId: "plugin-a2a" },
          policyContext: { requiresApproval: true, liveImpact: true, targetEnvironment: "live" },
        },
      },
    }),
    remote,
    policy: { allowedTargets: ["nosuk"], requireApprovalForLiveImpact: true },
  });

  assert.equal(decision.status, "approval_required");
  assert.equal(decision.visibility, "approval_required");
  assert.deepEqual(decision.remote, remote);
  assert.match(decision.reason, /explicit operator approval/);
});

test("handoff visibility policy maps thrown errors to visibility error result", () => {
  const decision = mapRemoteHandoffPolicyError({
    error: new Error("policy backend unavailable"),
    remote,
  });

  assert.deepEqual(decision, {
    status: "error",
    visibility: "error",
    reason: "policy backend unavailable",
    remote,
  });
});


test("handoff visibility policy can be read from plugin config", () => {
  const decision = evaluateRemoteHandoffVisibilityPolicy({
    event: event(),
    remote,
    config: activeConfig({ remoteHandoff: { allowedTargets: ["sogyo"] } }),
  });

  assert.equal(decision.status, "denied");
  assert.equal(decision.visibility, "policy_denied");
  assert.match(decision.reason, /not in the plugin allowlist/);
});
