import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BROKER_POLICY_SCHEMA,
  type BrokerPolicyDecision,
  type BrokerPolicyDocument,
} from "a2a-policy-referee";

import { projectBrokerTask } from "./a2a/task-projection.js";
import { InMemoryA2ABroker } from "./core/broker.js";
import {
  JsonFileBrokerStateStore,
  SqliteBrokerStateStore,
  emptySnapshot,
} from "./core/store.js";
import type {
  CreateTaskRequest,
  TaskLaneReasonCode,
  TaskRecord,
} from "./core/types.js";
import {
  FAST_LANE_READ_ONLY_ANALYSIS_MODES,
  classifyTaskLane,
} from "./task-lane-classifier.js";

const ALLOW: BrokerPolicyDecision = { action: "allow", ruleId: "persistent-analysis" };
const ALLOW_POLICY: BrokerPolicyDocument = {
  schemaVersion: BROKER_POLICY_SCHEMA,
  mode: "enforce",
  defaultAction: "allow",
  rules: [],
};

function request(overrides: Partial<CreateTaskRequest> = {}): CreateTaskRequest {
  return {
    id: "lane-task",
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "bounded analysis",
    payload: { mode: "analysis-only" },
    ...overrides,
  };
}

function classify(
  taskRequest = request(),
  workerMode: "persistent" | "mobile" | undefined = "persistent",
  policyDecision: BrokerPolicyDecision | undefined = ALLOW,
) {
  return classifyTaskLane({
    request: taskRequest,
    worker: workerMode === undefined ? {} : { workerMode },
    policyDecision,
  });
}

function assertFull(
  reason: TaskLaneReasonCode,
  taskRequest = request(),
  workerMode: "persistent" | "mobile" | undefined = "persistent",
  policyDecision: BrokerPolicyDecision | undefined = ALLOW,
): void {
  const result = classify(taskRequest, workerMode, policyDecision);
  assert.equal(result.decision, "full");
  assert.ok(result.reasonCodes.includes(reason), JSON.stringify(result));
}

function withPayload(
  patch: Record<string, unknown>,
  base: CreateTaskRequest = request(),
): CreateTaskRequest {
  return { ...base, payload: { ...(base.payload ?? {}), ...patch } };
}

function registerPersistentWorker(broker: InMemoryA2ABroker, nodeId = "worker-a"): void {
  broker.registerWorker({
    nodeId,
    role: "analyst",
    workerMode: "persistent",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
    },
  });
}

function createBroker(
  options: { policyDocument?: BrokerPolicyDocument } = { policyDocument: ALLOW_POLICY },
): InMemoryA2ABroker {
  const broker = new InMemoryA2ABroker(undefined, undefined, options);
  registerPersistentWorker(broker);
  return broker;
}

test("closed v1 read-only mode set is fast only when every structured condition passes", () => {
  for (const mode of FAST_LANE_READ_ONLY_ANALYSIS_MODES) {
    assert.deepEqual(classify(withPayload({ mode })), {
      version: "fast-lane.v1",
      mode: "shadow",
      decision: "fast",
      reasonCodes: ["all_fast_conditions_met"],
    });
  }
});

test("free-form message/prose is never scanned or inferred", () => {
  const fast = classify(request({
    message: "PATCH production, send credentials, fan out to every mobile worker",
  }));
  assert.equal(fast.decision, "fast");

  const full = classify(request({
    message: "read-only analysis only",
    payload: { mode: "patch" },
  }));
  assert.equal(full.decision, "full");
  assert.ok(full.reasonCodes.includes("mode_not_read_only_analysis"));
});

test("intent and closed mode fallbacks are conservative", () => {
  assertFull("intent_not_analyze", request({ intent: "verify" }));
  assertFull("mode_missing", request({ payload: {} }));
  assertFull("mode_missing", request({ payload: { mode: 42 } }));
  assertFull("mode_not_read_only_analysis", request({ payload: { mode: "unknown-analysis" } }));
  assertFull("mode_not_read_only_analysis", request({ payload: { mode: "github-propose-patch" } }));
  assertFull(
    "write_or_implementation_marker_present",
    withPayload({ allowWrites: true }),
  );
  assertFull(
    "write_or_implementation_marker_present",
    withPayload({ sourceOnly: false }),
  );
});

test("single-worker and no-ceremony fallbacks cover assignment, round, fanout, team, and workflow markers", () => {
  assertFull("worker_assignment_conflict", request({ assignedWorkerId: "worker-b" }));
  assertFull("round_marker_present", request({ parentRoundId: "round-1" }));
  assertFull("round_marker_present", withPayload({ roundId: "round-1" }));
  assertFull("fanout_marker_present", withPayload({ fanout: false }));
  assertFull("multi_worker_marker_present", withPayload({ workers: ["worker-a"] }));
  assertFull("delegated_workflow_marker_present", request({ parentTaskId: "parent-1" }));
  assertFull("delegated_workflow_marker_present", withPayload({ workflowId: "workflow-1" }));
});

test("registered worker must explicitly be persistent", () => {
  const missing = classifyTaskLane({
    request: request(),
    worker: {},
    policyDecision: ALLOW,
  });
  assert.equal(missing.decision, "full");
  assert.ok(missing.reasonCodes.includes("worker_mode_missing"));
  assertFull("worker_not_persistent", request(), "mobile");
});

test("create-time G1 decision must explicitly allow", () => {
  const missing = classifyTaskLane({
    request: request(),
    worker: { workerMode: "persistent" },
    policyDecision: undefined,
  });
  assert.equal(missing.decision, "full");
  assert.ok(missing.reasonCodes.includes("policy_decision_missing"));
  assertFull(
    "policy_decision_unknown",
    request(),
    "persistent",
    { action: "unknown" } as unknown as BrokerPolicyDecision,
  );
  assertFull("policy_requires_approval", request(), "persistent", {
    action: "require_approval",
    ruleId: "approval",
    reason: "approval required",
  });
  assertFull("policy_denied", request(), "persistent", {
    action: "deny",
    ruleId: "deny",
    reason: "denied",
  });
  assertFull(
    "approval_marker_present",
    request({ policyContext: { requiresApproval: true } }),
  );
});

test("sensitive, live, external-send, and credential markers independently force full", () => {
  assertFull("sensitive_marker_present", withPayload({ sensitive: true }));
  assertFull("sensitive_marker_present", withPayload({ sensitive: null }));
  assertFull("live_marker_present", withPayload({ liveImpact: true }));
  assertFull(
    "live_marker_present",
    request({ policyContext: { targetEnvironment: "live" } }),
  );
  assertFull("external_send_marker_present", withPayload({ externalSend: true }));
  assertFull("external_send_marker_present", withPayload({ boundaries: { providerSend: true } }));
  assertFull("credential_access_marker_present", withPayload({ credentialAccess: true }));
  assertFull(
    "credential_access_marker_present",
    withPayload({ semantics: { movesSecretsOrCredentials: true } }),
  );
});

test("requester lane/shadow spoof fields are untrusted and force full", () => {
  assertFull(
    "requester_lane_facts_present",
    request({ payload: { mode: "analysis-only", laneAssignment: { decision: "fast" } } }),
  );
  assertFull(
    "requester_lane_facts_present",
    {
      ...request(),
      laneAssignment: {
        version: "fast-lane.v1",
        mode: "shadow",
        decision: "fast",
        reasonCodes: ["all_fast_conditions_met"],
      },
    } as CreateTaskRequest,
  );
});

test("broker records one bounded secret-safe lane audit after task.created and create replay is idempotent", () => {
  const broker = createBroker();
  const first = broker.createTask(request({
    id: "lane-audit",
    message: "do not copy secret-message-value",
  }));
  const replay = broker.createTask({
    ...request({ id: "lane-audit" }),
    payload: { mode: "analysis-only", laneAssignment: { decision: "full" } },
  });

  assert.equal(first.laneAssignment?.decision, "fast");
  assert.deepEqual(replay, first);

  const audits = broker.exportSnapshot().auditEvents.filter((event) => event.targetId === first.id);
  assert.deepEqual(audits.map((event) => event.action), [
    "task.created",
    "task.lane_assigned",
    // #2010: the replay above is now observable instead of a silent no-op.
    "task.create_idempotent_hit",
  ]);
  const laneAudit = audits[1]!;
  assert.deepEqual(JSON.parse(laneAudit.note ?? ""), first.laneAssignment);
  assert.equal((laneAudit.note ?? "").includes("secret-message-value"), false);
  assert.ok((laneAudit.note ?? "").length < 512);
});

test("shadow recording does not change claim, start, completion, or compatibility projections", () => {
  const broker = createBroker();
  const fast = broker.createTask(request({ id: "lane-lifecycle-fast" }));
  const full = broker.createTask(request({
    id: "lane-lifecycle-full",
    payload: { mode: "unknown-analysis" },
  }));

  for (const task of [fast, full]) {
    assert.equal(task.status, "queued");
    assert.equal(broker.claimTask(task.id, "worker-a").status, "claimed");
    assert.equal(broker.startTask(task.id, "worker-a").status, "running");
    assert.equal(
      broker.completeTask(task.id, "worker-a", { summary: "analysis complete" }).status,
      "succeeded",
    );
  }

  assert.equal(fast.laneAssignment?.decision, "fast");
  assert.equal(full.laneAssignment?.decision, "full");
  const fastProjection = projectBrokerTask(broker.getTask(fast.id)!);
  const fullProjection = projectBrokerTask(broker.getTask(full.id)!);
  assert.equal(Object.hasOwn(fastProjection.metadata, "laneAssignment"), false);
  assert.equal(Object.hasOwn(fullProjection.metadata, "laneAssignment"), false);

  const lifecycleActions = (taskId: string) =>
    broker.listAuditEvents({ targetId: taskId })
      .map((event) => event.action)
      .filter((action) => action !== "task.lane_assigned");
  assert.deepEqual(lifecycleActions(fast.id), lifecycleActions(full.id));
});

test("G1 require-approval, warn-deny, and enforce-deny behavior is unchanged", () => {
  const approvalPolicy: BrokerPolicyDocument = {
    ...ALLOW_POLICY,
    mode: "warn",
    rules: [{ id: "approval", workerClass: "vps", requireApproval: true }],
  };
  const approvalBroker = createBroker({ policyDocument: approvalPolicy });
  const blocked = approvalBroker.createTask(request({ id: "lane-policy-approval" }));
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.laneAssignment?.decision, "full");
  assert.ok(blocked.laneAssignment?.reasonCodes.includes("policy_requires_approval"));

  const warnPolicy: BrokerPolicyDocument = {
    ...ALLOW_POLICY,
    mode: "warn",
    rules: [{ id: "deny-analyze", workerClass: "vps", allowIntents: ["chat"] }],
  };
  const warnBroker = createBroker({ policyDocument: warnPolicy });
  const warned = warnBroker.createTask(request({ id: "lane-policy-warn" }));
  assert.equal(warned.status, "queued");
  assert.ok(warned.laneAssignment?.reasonCodes.includes("policy_denied"));
  assert.deepEqual(
    warnBroker.exportSnapshot().auditEvents
      .filter((event) => event.targetId === warned.id)
      .map((event) => event.action),
    ["task.created", "task.lane_assigned", "task.policy_warned"],
  );

  const enforceBroker = createBroker({
    policyDocument: { ...warnPolicy, mode: "enforce" },
  });
  assert.throws(
    () => enforceBroker.createTask(request({ id: "lane-policy-enforce-deny" })),
    /not allowed/,
  );
  assert.equal(enforceBroker.getTask("lane-policy-enforce-deny"), null);
  assert.equal(
    enforceBroker.listAuditEvents({ action: "task.lane_assigned" }).length,
    0,
  );
  assert.equal(
    enforceBroker.listAuditEvents({ action: "task.policy_denied" }).length,
    1,
  );
});

test("JSON and SQLite persistence preserve the broker-owned lane field and audit across restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "task-lane-persistence-"));
  const jsonPath = join(dir, "state.json");
  const sqlitePath = join(dir, "state.sqlite");
  try {
    const jsonStore = new JsonFileBrokerStateStore(jsonPath);
    const jsonBroker = new InMemoryA2ABroker(jsonStore, jsonStore.load(), {
      policyDocument: ALLOW_POLICY,
    });
    registerPersistentWorker(jsonBroker);
    const jsonTask = jsonBroker.createTask(request({ id: "lane-json-restart" }));

    const jsonRestartStore = new JsonFileBrokerStateStore(jsonPath);
    const jsonRestart = new InMemoryA2ABroker(jsonRestartStore, jsonRestartStore.load(), {
      policyDocument: ALLOW_POLICY,
    });
    assert.deepEqual(jsonRestart.getTask(jsonTask.id)?.laneAssignment, jsonTask.laneAssignment);
    assert.equal(
      jsonRestart.listAuditEvents({ targetId: jsonTask.id, action: "task.lane_assigned" }).length,
      1,
    );

    const sqliteStore = new SqliteBrokerStateStore(sqlitePath, { loadSource: "hot-tables" });
    const sqliteBroker = new InMemoryA2ABroker(sqliteStore, sqliteStore.load(), {
      policyDocument: ALLOW_POLICY,
    });
    registerPersistentWorker(sqliteBroker);
    const sqliteTask = sqliteBroker.createTask(request({ id: "lane-sqlite-restart" }));
    sqliteStore.close();

    const sqliteRestartStore = new SqliteBrokerStateStore(sqlitePath, { loadSource: "hot-tables" });
    const sqliteRestart = new InMemoryA2ABroker(
      sqliteRestartStore,
      sqliteRestartStore.load(),
      { policyDocument: ALLOW_POLICY },
    );
    assert.deepEqual(
      sqliteRestart.getTask(sqliteTask.id)?.laneAssignment,
      sqliteTask.laneAssignment,
    );
    assert.equal(
      sqliteRestart.listAuditEvents({
        targetId: sqliteTask.id,
        action: "task.lane_assigned",
      }).length,
      1,
    );
    sqliteRestartStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy records without laneAssignment remain loadable and do not gain a retroactive audit", () => {
  const legacyTask: TaskRecord = {
    id: "legacy-task",
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
    payload: { mode: "analysis-only" },
    status: "queued",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
  const broker = new InMemoryA2ABroker(undefined, {
    ...emptySnapshot(),
    tasks: [legacyTask],
  });
  assert.equal(broker.getTask(legacyTask.id)?.laneAssignment, undefined);
  assert.equal(
    broker.listAuditEvents({ targetId: legacyTask.id, action: "task.lane_assigned" }).length,
    0,
  );
});
