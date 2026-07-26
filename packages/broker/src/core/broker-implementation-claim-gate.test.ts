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

test("a stale heartbeat does not deny a worker that is claiming right now (#1597)", () => {
  // workerPlane is derived only from heartbeat recency. A worker that missed a
  // few heartbeats but is making an authenticated claim is provably alive, so
  // liveness must not be confused with capability.
  const broker = brokerWith("enforce");
  addWorker(broker, "worker-ready", READY_PROFILE);

  const worker = broker.getWorker("worker-ready");
  assert.ok(worker);
  // Age the heartbeat well past every offline-after threshold.
  worker.lastSeenAt = new Date(Date.parse(worker.lastSeenAt) - 3_600_000).toISOString();

  addTask(broker, "task-stale-heartbeat", "worker-ready", "propose_patch");

  assert.equal(broker.claimTask("task-stale-heartbeat", "worker-ready").status, "claimed");
});

test("a denied claim is audited once, not once per retry (#1597)", () => {
  // policy_denied maps to HTTP 403, which the worker treats as skip-and-retry,
  // so it re-claims every poll interval for as long as the task exists.
  const broker = brokerWith("enforce");
  addWorker(broker, "worker-nocap");
  addTask(broker, "task-retry", "worker-nocap", "propose_patch");

  for (let attempt = 0; attempt < 25; attempt += 1) {
    assert.throws(() => broker.claimTask("task-retry", "worker-nocap"), /policy_denied|implementation capability/);
  }

  const denied = broker.listAuditEvents().filter((event) => event.action === "task.policy_denied");
  assert.equal(denied.length, 1, "25 retries must not write 25 audit events");
});

test("a warn-mode violation is audited once across retries (#1597)", () => {
  const broker = brokerWith("warn");
  addWorker(broker, "worker-nocap");
  addTask(broker, "task-warn-retry", "worker-nocap", "propose_patch");

  broker.claimTask("task-warn-retry", "worker-nocap");
  // Claiming again is rejected by the lifecycle, not the policy, but the policy
  // hook still runs first on every attempt.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      broker.claimTask("task-warn-retry", "worker-nocap");
    } catch {
      // status transition guard — irrelevant here
    }
  }

  const warned = broker.listAuditEvents().filter((event) => event.action === "task.policy_warned");
  assert.equal(warned.length, 1);
});

test("the deny reason and audit note carry no worker identity (#1597)", () => {
  // The referee package must never receive a worker identity; the broker only
  // passes a boolean and a secret-safe reason string.
  const broker = brokerWith("enforce");
  addWorker(broker, "worker-secretname", { ...READY_PROFILE, availability: "configured" });
  addTask(broker, "task-identity", "worker-secretname", "propose_patch");

  let message = "";
  try {
    broker.claimTask("task-identity", "worker-secretname");
  } catch (err) {
    message = (err as Error).message;
  }

  assert.ok(message.length > 0);
  assert.equal(message.includes("worker-secretname"), false, message);

  const denied = broker.listAuditEvents().filter((event) => event.action === "task.policy_denied");
  assert.equal(denied[0]?.note?.includes("worker-secretname"), false);
});
