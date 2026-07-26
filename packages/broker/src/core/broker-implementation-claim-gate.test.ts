// #1597 claim-time implementation capability gate.
//
// The readiness rule already existed in scheduler-dry-run, but nothing on the
// live claim path called it, so a worker without a verified implementation
// route could still claim propose_patch / propose_params / apply_local_change
// work. These tests pin the wiring: the gate is opt-in via the broker policy
// document, it fails closed, and it leaves every other lane alone.
import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryA2ABroker } from "./broker.js";
import { BROKER_POLICY_SCHEMA, validateBrokerPolicyDocument } from "a2a-policy-referee";
import type { A2AExchangeIntent, WorkerImplementationCapability } from "./types.js";

const IMPLEMENTATION_INTENTS: A2AExchangeIntent[] = ["propose_patch", "propose_params", "apply_local_change"];

const READY_PROFILE: WorkerImplementationCapability = {
  capable: true,
  runtime: "claude-native",
  providerId: "anthropic",
  modelTier: "claude-implementation",
  availability: "canary_passed",
};

function policy(mode: "warn" | "enforce", requireImplementationCapability = true) {
  return validateBrokerPolicyDocument({
    schemaVersion: BROKER_POLICY_SCHEMA,
    mode,
    defaultAction: "allow",
    rules: [{ id: "impl-gate", workerClass: "*", requireImplementationCapability }],
  });
}

function brokerWith(mode: "warn" | "enforce", requireImplementationCapability = true) {
  return new InMemoryA2ABroker(undefined, undefined, {
    policyDocument: policy(mode, requireImplementationCapability),
  });
}

function addWorker(
  broker: InMemoryA2ABroker,
  nodeId: string,
  implementationCapability?: WorkerImplementationCapability,
): void {
  broker.registerWorker({
    nodeId,
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      // canPatchWorkspace alone must not be enough to claim implementation work.
      canPatchWorkspace: true,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
      ...(implementationCapability ? { implementationCapability } : {}),
    },
  });
}

function addTask(broker: InMemoryA2ABroker, id: string, workerId: string, intent: A2AExchangeIntent) {
  const task = broker.createTask({
    id,
    intent,
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: workerId, kind: "node", role: "analyst" },
    assignedWorkerId: workerId,
    message: `implementation task ${id}`,
  });
  // apply_local_change is a dangerous intent that already requires operator
  // approval before claim. Satisfy that pre-existing gate so these tests
  // exercise the capability gate rather than the approval gate.
  if (task.policyContext?.requiresApproval === true) {
    return broker.approveTask(id, {
      actor: { id: "operator-a", kind: "node", role: "operator" },
      approvalId: `approval-${id}`,
      reason: "capability gate test fixture",
    });
  }
  return task;
}

test("enforce mode denies implementation claims from a worker with no capability profile (#1597)", () => {
  for (const intent of IMPLEMENTATION_INTENTS) {
    const broker = brokerWith("enforce");
    addWorker(broker, "worker-nocap");
    addTask(broker, `task-${intent}`, "worker-nocap", intent);

    assert.throws(
      () => broker.claimTask(`task-${intent}`, "worker-nocap"),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, "policy_denied", intent);
        assert.match(err.message, /verified implementation capability/, intent);
        assert.match(err.message, /not declared in registration\/heartbeat/, intent);
        return true;
      },
      intent,
    );

    assert.equal(broker.getTask(`task-${intent}`)?.status, "queued", `${intent} must stay claimable by a ready worker`);
  }
});

test("enforce mode denies an implementation claim that is declared but not canary-passed (#1597)", () => {
  const broker = brokerWith("enforce");
  addWorker(broker, "worker-unverified", { ...READY_PROFILE, availability: "configured" });
  addTask(broker, "task-unverified", "worker-unverified", "propose_patch");

  assert.throws(
    () => broker.claimTask("task-unverified", "worker-unverified"),
    /not 'canary_passed'/,
  );
});

test("enforce mode denies an implementation claim when the worker disables the capability (#1597)", () => {
  const broker = brokerWith("enforce");
  addWorker(broker, "worker-disabled", { ...READY_PROFILE, capable: false });
  addTask(broker, "task-disabled", "worker-disabled", "propose_patch");

  assert.throws(
    () => broker.claimTask("task-disabled", "worker-disabled"),
    /implementation capability disabled/,
  );
});

test("a verified implementation worker still claims implementation work (#1597)", () => {
  for (const intent of IMPLEMENTATION_INTENTS) {
    const broker = brokerWith("enforce");
    addWorker(broker, "worker-ready", READY_PROFILE);
    addTask(broker, `task-${intent}`, "worker-ready", intent);

    const claimed = broker.claimTask(`task-${intent}`, "worker-ready");
    assert.equal(claimed.status, "claimed", intent);
    assert.equal(claimed.claimedBy, "worker-ready", intent);
  }
});

test("non-implementation intents are unaffected by the gate (#1597)", () => {
  for (const intent of ["chat", "analyze", "verify", "validate_change"] as A2AExchangeIntent[]) {
    const broker = brokerWith("enforce");
    addWorker(broker, "worker-nocap");
    addTask(broker, `task-${intent}`, "worker-nocap", intent);

    const claimed = broker.claimTask(`task-${intent}`, "worker-nocap");
    assert.equal(claimed.status, "claimed", intent);
  }
});

test("warn mode records the violation without blocking the claim (#1597)", () => {
  const broker = brokerWith("warn");
  addWorker(broker, "worker-nocap");
  addTask(broker, "task-warn", "worker-nocap", "propose_patch");

  const claimed = broker.claimTask("task-warn", "worker-nocap");
  assert.equal(claimed.status, "claimed");

  const warned = broker.listAuditEvents().filter((event) => event.action === "task.policy_warned");
  assert.equal(warned.length, 1);
  assert.match(warned[0]?.note ?? "", /verified implementation capability/);
});

test("the gate is opt-in: a policy without the rule field allows the claim (#1597)", () => {
  const broker = brokerWith("enforce", false);
  addWorker(broker, "worker-nocap");
  addTask(broker, "task-optin", "worker-nocap", "propose_patch");

  assert.equal(broker.claimTask("task-optin", "worker-nocap").status, "claimed");
});

test("a broker with no policy document keeps legacy claim behaviour (#1597)", () => {
  const broker = new InMemoryA2ABroker();
  addWorker(broker, "worker-nocap");
  addTask(broker, "task-legacy", "worker-nocap", "propose_patch");

  assert.equal(broker.claimTask("task-legacy", "worker-nocap").status, "claimed");
});
