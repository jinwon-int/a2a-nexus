// a2a-nexus#2046 — three-way resolution of payload.mode on the policy path.
//
// #2040 made the referee's `denyModes` check fail closed: a matched rule that
// declares denyModes DENIES when it was not handed a non-empty `mode` string,
// because it cannot prove the task's mode is outside the deny list. Callers
// opt out with `modeResolution: "absent"` once they have positively
// established the payload declares no mode.
//
// The broker had not been updated. Both call sites wrote
// `typeof payload?.mode === "string" ? payload.mode : undefined`, collapsing
// "no mode key" and "mode present but unreadable" into the same value. Left
// that way, ordinary mode-less traffic in a denyModes class would have warned
// on every task and inflated the warn-window false-positive count that gates
// the enforce promotion (contracts/a2a/broker-policy.md §5.1).
//
// These tests pin both halves: normal traffic stays quiet, malformed traffic
// still fails closed.
import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryA2ABroker } from "./broker.js";
import { resolveTaskPolicyMode } from "./broker-task-admission.js";
import { BROKER_POLICY_SCHEMA, validateBrokerPolicyDocument } from "a2a-policy-referee";

function denyModesPolicy(mode: "warn" | "enforce") {
  return validateBrokerPolicyDocument({
    schemaVersion: BROKER_POLICY_SCHEMA,
    mode,
    defaultAction: "allow",
    rules: [
      {
        id: "deny-patch-modes",
        workerClass: "*",
        denyModes: ["patch", "github-propose-patch"],
      },
    ],
  });
}

function brokerWith(mode: "warn" | "enforce") {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    policyDocument: denyModesPolicy(mode),
  });
  broker.registerWorker({
    nodeId: "worker-a",
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: true,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
    },
  });
  return broker;
}

function createWithPayload(broker: InMemoryA2ABroker, id: string, payload: unknown) {
  return broker.createTask({
    id,
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: `mode resolution task ${id}`,
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
}

function policyEvents(broker: InMemoryA2ABroker) {
  return broker
    .listAuditEvents()
    .filter((event) => event.action === "task.policy_warned" || event.action === "task.policy_denied");
}

test("resolveTaskPolicyMode separates absent, declared, and unreadable modes", () => {
  assert.deepEqual(resolveTaskPolicyMode(undefined), { modeResolution: "absent", malformed: false });
  assert.deepEqual(resolveTaskPolicyMode({}), { modeResolution: "absent", malformed: false });
  assert.deepEqual(resolveTaskPolicyMode({ mode: undefined }), { modeResolution: "absent", malformed: false });
  assert.deepEqual(resolveTaskPolicyMode({ mode: "analyze" }), {
    mode: "analyze",
    modeResolution: "declared",
    malformed: false,
  });
  // The exact shapes that used to slip past the deny rule: a non-string mode
  // normalized to undefined, which skipped the denyModes check entirely.
  for (const raw of [["patch"], 3, "", null, { value: "patch" }, true]) {
    assert.deepEqual(
      resolveTaskPolicyMode({ mode: raw }),
      { modeResolution: "undetermined", malformed: true },
      `mode ${JSON.stringify(raw)} must be undeterminable`,
    );
  }
});

test("a task that declares no mode does not warn under a denyModes rule (#2046)", () => {
  const broker = brokerWith("warn");
  createWithPayload(broker, "task-no-mode", undefined);
  createWithPayload(broker, "task-empty-payload", {});
  // This is the regression that matters for the enforce promotion: ordinary
  // mode-less traffic must stay silent, or the warn window fills with noise
  // and the §5.1 false-positive baseline becomes unusable.
  assert.deepEqual(policyEvents(broker), []);
});

test("a task declaring an allowed mode is unaffected", () => {
  const broker = brokerWith("warn");
  createWithPayload(broker, "task-allowed-mode", { mode: "analyze" });
  assert.deepEqual(policyEvents(broker), []);
});

test("a task declaring a denied mode still warns", () => {
  const broker = brokerWith("warn");
  createWithPayload(broker, "task-denied-mode", { mode: "patch" });
  const events = policyEvents(broker);
  assert.equal(events.length, 1);
  assert.match(events[0].note ?? "", /mode 'patch' is denied/);
});

test("a non-string mode fails closed and says so in the audit note (#2046)", () => {
  const broker = brokerWith("warn");
  createWithPayload(broker, "task-array-mode", { mode: ["patch"] });
  const events = policyEvents(broker);
  assert.equal(events.length, 1, "an unreadable mode must not be silently treated as absent");
  const note = events[0].note ?? "";
  assert.match(note, /mode could not be determined/);
  // Distinguish the anomaly from a plain missing field, so an operator reading
  // the audit trail can tell a malformed payload from a policy gap.
  assert.match(note, /not a non-empty string/);
});

test("enforce mode rejects an unreadable mode instead of admitting it", () => {
  const broker = brokerWith("enforce");
  assert.throws(
    () => createWithPayload(broker, "task-numeric-mode", { mode: 7 }),
    (error: unknown) => {
      assert.match(String((error as Error).message), /mode could not be determined/);
      return true;
    },
  );
  // And the allowed path still works under the same document.
  const ok = createWithPayload(broker, "task-enforce-allowed", { mode: "analyze" });
  assert.equal(ok.id, "task-enforce-allowed");
});
