// #1601/#2208 fast-lane operator re-judgment (rejudgeLaneTask, POST
// /tasks/:id/rejudge-lane). Pins the broker-layer invariants: hub/operator
// gating, fast -> full only, mandatory reasonCode, terminal-status guard, and
// the core structural rule — the create-time `laneAssignment` shadow record is
// immutable; the ruling lands in the separate `laneRejudgment` field, is
// audited as `task.lane_rejudged`, emits a non-final `rejudged` task update,
// commits in exactly one store transaction, and changes no lifecycle or
// scheduling state (observational).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BROKER_POLICY_SCHEMA, type BrokerPolicyDocument } from "a2a-policy-referee";

import { InMemoryA2ABroker } from "./broker.js";
import { BrokerError } from "./broker-error.js";
import {
  SqliteArtifactRuntimeRepository,
  SqliteAuditRuntimeRepository,
  SqliteBrokerStateStore,
  SqliteExchangeMessageRuntimeRepository,
  SqliteExchangeRuntimeRepository,
  SqliteProposalRuntimeRepository,
  SqliteTaskRuntimeRepository,
  SqliteTombstoneRuntimeRepository,
  SqliteValidationRuntimeRepository,
  SqliteWorkerRuntimeRepository,
  type BrokerSnapshot,
} from "./store.js";
import type { TaskLaneRejudgeRequest } from "./types.js";

const REJUDGE_NOTE = "payload carried a fanout marker; not a single-worker analysis";

const OPERATOR = { id: "ops", kind: "node", role: "operator" } as const;
const HUB = { id: "hub-a", kind: "node", role: "hub" } as const;

const ALLOW_POLICY: BrokerPolicyDocument = {
  schemaVersion: BROKER_POLICY_SCHEMA,
  mode: "enforce",
  defaultAction: "allow",
  rules: [],
};

function makeBroker(fastLaneOptions: Record<string, unknown> = {}): InMemoryA2ABroker {
  return new InMemoryA2ABroker(undefined, undefined, {
    policyDocument: ALLOW_POLICY,
    ...fastLaneOptions,
  });
}

function registerPersistentWorker(broker: InMemoryA2ABroker, nodeId = "worker-1"): void {
  broker.registerWorker({
    nodeId,
    role: "operator",
    workerMode: "persistent",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["default"],
      environments: ["research"],
    },
  });
}

function rejudgeRequest(
  overrides: Partial<TaskLaneRejudgeRequest> = {},
): TaskLaneRejudgeRequest {
  return {
    actor: OPERATOR,
    decision: "full",
    reasonCode: "multi_worker_marker_present",
    note: REJUDGE_NOTE,
    ...overrides,
  };
}

/** Fast-lane task at `queued` (create only, never claimed). */
function queuedFastTask(broker: InMemoryA2ABroker): { id: string } {
  return broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "worker-1", kind: "node", role: "operator" },
    payload: { mode: "analysis-only" },
  });
}

/** Fast-lane task already claimed and started by the persistent worker. */
function claimedTask(broker: InMemoryA2ABroker): { id: string } {
  const task = queuedFastTask(broker);
  broker.claimTask(task.id, "worker-1");
  broker.startTask(task.id, "worker-1");
  return task;
}

function audits(broker: InMemoryA2ABroker, action: string) {
  return broker.listAuditEvents().filter((event) => event.action === action);
}

function expectBrokerError(fn: () => unknown, code: string): void {
  assert.throws(
    fn,
    (err: unknown) => err instanceof BrokerError && err.code === code,
    `expected BrokerError ${code}`,
  );
}

describe("fast-lane operator re-judgment (#1601/#2208)", () => {
  it("records laneRejudgment without touching the immutable create-time laneAssignment", () => {
    const broker = makeBroker();
    registerPersistentWorker(broker);
    const task = claimedTask(broker);
    const assignmentBefore = structuredClone(broker.getTask(task.id)?.laneAssignment);
    assert.equal(assignmentBefore?.decision, "fast");
    assert.equal(assignmentBefore?.mode, "shadow");

    const rejudged = broker.rejudgeLaneTask(task.id, rejudgeRequest());
    const ruling = rejudged.laneRejudgment;
    assert.ok(ruling, "rejudgeLaneTask must populate laneRejudgment");
    const { at, ...rest } = ruling;
    assert.ok(at, "laneRejudgment.at must be set");
    assert.deepEqual(rest, {
      actorId: "ops",
      from: "fast",
      to: "full",
      reasonCode: "multi_worker_marker_present",
      note: REJUDGE_NOTE,
    });

    // Create-time shadow record is byte-identical after the ruling: cohort
    // reconciliation depends on it, so the ruling may never rewrite it.
    assert.deepEqual(broker.getTask(task.id)?.laneAssignment, assignmentBefore);
    // Observational: the ruling changes no lifecycle state.
    assert.equal(broker.getTask(task.id)?.status, "running");
  });

  it("hub actors may rule; note stays optional and absent when omitted", () => {
    const broker = makeBroker();
    registerPersistentWorker(broker);
    const task = queuedFastTask(broker);

    const rejudged = broker.rejudgeLaneTask(
      task.id,
      rejudgeRequest({ actor: HUB, note: undefined }),
    );
    const ruling = rejudged.laneRejudgment;
    assert.ok(ruling);
    const { at, ...rest } = ruling;
    assert.ok(at);
    assert.deepEqual(rest, {
      actorId: "hub-a",
      from: "fast",
      to: "full",
      reasonCode: "multi_worker_marker_present",
    });
    assert.ok(!("note" in ruling), "omitted note must not materialize as a key");
    assert.equal(rejudged.status, "queued");
  });

  it("appends exactly one task.lane_rejudged audit whose note serializes the ruling", () => {
    const broker = makeBroker();
    registerPersistentWorker(broker);
    const task = claimedTask(broker);
    const actionsBefore = broker.listAuditEvents().map((event) => event.action);

    broker.rejudgeLaneTask(task.id, rejudgeRequest());

    // Observational, part 2: the audit trail gains the ruling and nothing else
    // — no lifecycle/scheduling event may ride along. listAuditEvents is
    // newest-first, so the single new event must sit at the head.
    const actionsAfter = broker.listAuditEvents();
    assert.equal(
      actionsAfter.length - actionsBefore.length,
      1,
      "exactly one new audit event",
    );
    assert.equal(actionsAfter[0]?.action, "task.lane_rejudged");
    const events = audits(broker, "task.lane_rejudged");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.actorId, "ops");
    assert.equal(events[0]?.targetType, "task");
    assert.equal(events[0]?.targetId, task.id);
    const note = events[0]?.note ?? "";
    assert.ok(note, "audit note must carry the serialized ruling");
    assert.deepEqual(JSON.parse(note), broker.getTask(task.id)?.laneRejudgment);
  });

  it("emits exactly one non-final `rejudged` task update", () => {
    const broker = makeBroker();
    registerPersistentWorker(broker);
    const task = claimedTask(broker);
    const updates: Array<{ reason: string; final: boolean }> = [];
    broker.subscribeToTask(task.id, (update) => {
      updates.push({ reason: update.reason, final: update.final });
    });

    broker.rejudgeLaneTask(task.id, rejudgeRequest());

    const rejudged = updates.filter((update) => update.reason === "rejudged");
    assert.equal(rejudged.length, 1);
    assert.equal(rejudged[0]?.final, false, "re-judgment is observational, never terminal");
  });

  it("gates: blank actor id, non-hub/operator actor, non-full decision, blank reasonCode", () => {
    const broker = makeBroker();
    registerPersistentWorker(broker);
    const task = queuedFastTask(broker);

    expectBrokerError(
      () => broker.rejudgeLaneTask(task.id, rejudgeRequest({ actor: { id: "", kind: "node", role: "operator" } })),
      "bad_request",
    );
    expectBrokerError(
      () => broker.rejudgeLaneTask(task.id, rejudgeRequest({ actor: { id: "worker-1", kind: "node", role: "analyst" } })),
      "policy_denied",
    );
    expectBrokerError(
      () => broker.rejudgeLaneTask(
        task.id,
        { actor: OPERATOR, decision: "fast", reasonCode: "multi_worker_marker_present" } as unknown as TaskLaneRejudgeRequest,
      ),
      "bad_request",
    );
    expectBrokerError(
      () => broker.rejudgeLaneTask(
        task.id,
        { actor: OPERATOR, decision: "full", reasonCode: "" } as unknown as TaskLaneRejudgeRequest,
      ),
      "bad_request",
    );
    expectBrokerError(
      () => broker.rejudgeLaneTask(
        task.id,
        { actor: OPERATOR, decision: "full", reasonCode: "   " } as unknown as TaskLaneRejudgeRequest,
      ),
      "bad_request",
    );
    assert.ok(!broker.getTask(task.id)?.laneRejudgment, "failed gates must not mutate the task");
  });

  it("terminal tasks (failed, canceled) reject the ruling", () => {
    const broker = makeBroker();
    registerPersistentWorker(broker);

    const failed = claimedTask(broker);
    broker.failTask(failed.id, "worker-1", { code: "boom", message: "m" });
    expectBrokerError(
      () => broker.rejudgeLaneTask(failed.id, rejudgeRequest()),
      "invalid_transition",
    );

    const canceled = queuedFastTask(broker);
    broker.cancelTask(canceled.id, { actor: HUB });
    expectBrokerError(
      () => broker.rejudgeLaneTask(canceled.id, rejudgeRequest()),
      "invalid_transition",
    );
  });

  it("full-lane tasks reject the ruling — v1 only corrects fast -> full", () => {
    const broker = makeBroker();
    registerPersistentWorker(broker);
    const task = broker.createTask({
      intent: "analyze",
      requester: { id: "hub", kind: "node", role: "hub" },
      target: { id: "worker-1", kind: "node", role: "operator" },
      payload: { mode: "analysis-only", workers: ["w-1", "w-2"] },
    });
    assert.equal(broker.getTask(task.id)?.laneAssignment?.decision, "full");
    expectBrokerError(
      () => broker.rejudgeLaneTask(task.id, rejudgeRequest()),
      "invalid_transition",
    );
  });

  it("legacy tasks without a create-time laneAssignment reject the ruling", () => {
    // laneAssignment exists on every createTask result; the absent case only
    // occurs for records created before fast-lane v1 and restored from a
    // snapshot, so build that record via exportSnapshot -> strip -> reload.
    const source = makeBroker();
    registerPersistentWorker(source);
    const task = queuedFastTask(source);
    const snapshot = structuredClone(source.exportSnapshot()) as BrokerSnapshot;
    const legacyTask = snapshot.tasks.find((record) => record.id === task.id);
    assert.ok(legacyTask, "snapshot must carry the task");
    delete legacyTask.laneAssignment;

    const broker = new InMemoryA2ABroker(undefined, snapshot, { policyDocument: ALLOW_POLICY });
    assert.ok(!broker.getTask(task.id)?.laneAssignment);
    expectBrokerError(
      () => broker.rejudgeLaneTask(task.id, rejudgeRequest()),
      "invalid_transition",
    );
  });

  it("re-judgment is irreversible — a second ruling is rejected", () => {
    const broker = makeBroker();
    registerPersistentWorker(broker);
    const task = queuedFastTask(broker);
    broker.rejudgeLaneTask(task.id, rejudgeRequest());

    expectBrokerError(
      () => broker.rejudgeLaneTask(task.id, rejudgeRequest({ actor: HUB })),
      "invalid_transition",
    );
    assert.equal(
      audits(broker, "task.lane_rejudged").length,
      1,
      "the rejected second ruling must not audit",
    );
  });

  it("ends in exactly one store commit (record + audit + persist)", () => {
    const dir = mkdtempSync(join(tmpdir(), "a2a-rejudge-commit-"));
    const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
    try {
      const broker = new InMemoryA2ABroker(store, store.load(), {
        policyDocument: ALLOW_POLICY,
        taskRepository: new SqliteTaskRuntimeRepository(store),
        auditRepository: new SqliteAuditRuntimeRepository(store),
        tombstoneRepository: new SqliteTombstoneRuntimeRepository(store),
        workerRepository: new SqliteWorkerRuntimeRepository(store),
        exchangeRepository: new SqliteExchangeRuntimeRepository(store),
        exchangeMessageRepository: new SqliteExchangeMessageRuntimeRepository(store),
        proposalRepository: new SqliteProposalRuntimeRepository(store),
        artifactRepository: new SqliteArtifactRuntimeRepository(store),
        validationRepository: new SqliteValidationRuntimeRepository(store),
      });
      registerPersistentWorker(broker);
      const task = queuedFastTask(broker);

      const before = store.commits;
      broker.rejudgeLaneTask(task.id, rejudgeRequest());
      assert.equal(
        store.commits - before,
        1,
        "rejudgeLaneTask must be one transaction (setTaskRecord + audit + persist), not 3",
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
