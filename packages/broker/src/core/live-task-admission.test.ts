import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_TASK_MODE,
  admitLiveTaskSubmission,
  buildLiveApprovalTokenV2,
  type LiveTaskOperation,
} from "./live-task-admission.js";
import type { BrokerStateStore } from "./store-contracts.js";
import type { CreateTaskRequest, WorkerView } from "./types.js";

const SIGNING_KEY = "test-live-approval-authority-key";
const NOW = "2026-07-10T20:30:00.000Z";

function operation(overrides: Partial<LiveTaskOperation> = {}): LiveTaskOperation {
  const base: LiveTaskOperation = {
    schema: "a2a.live-operation.v1",
    runId: "run-343-1",
    action: "promote_to_live_apply",
    target: "ccc-node:nosuk:dff7c773",
    targetWorkerId: "nosuk",
    targetSha: "dff7c773b1f8eec62bd278945cb6e210f1c27f6f",
    runbookId: "ccc-node-3node-rollout-v1",
    approvalTokenIssuedAt: "2026-07-10T20:29:30.000Z",
    approvalToken: "",
  };
  const merged = { ...base, ...overrides };
  merged.approvalToken = overrides.approvalToken ?? buildLiveApprovalTokenV2(
    {
      taskId: "task-live-343-1",
      runId: merged.runId,
      action: merged.action,
      target: merged.target,
    },
    {
      targetWorkerId: merged.targetWorkerId,
      targetSha: merged.targetSha,
      runbookId: merged.runbookId,
    },
    merged.approvalTokenIssuedAt,
    "nonce-live-343-1",
    "seoseo-a2a-finalizer",
    SIGNING_KEY,
  );
  return merged;
}

function task(overrides: Partial<CreateTaskRequest> = {}): CreateTaskRequest {
  return {
    id: "task-live-343-1",
    requester: { id: "seoseo-a2a-finalizer", role: "operator" },
    target: { id: "nosuk", role: "analyst" },
    intent: "promote_to_live",
    message: "execute approved deterministic live runbook",
    payload: { mode: LIVE_TASK_MODE, liveOperation: operation() },
    ...overrides,
  };
}

function worker(overrides: Partial<WorkerView> = {}): WorkerView {
  return {
    nodeId: "nosuk",
    role: "analyst",
    status: "online",
    workerPlane: "online",
    managementPlane: "online",
    updateEligible: true,
    substantiveAnalysisReady: true,
    createdAt: NOW,
    updatedAt: NOW,
    lastSeenAt: NOW,
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: true,
      canPromoteLive: true,
      workspaceIds: ["ccc-node"],
      environments: ["research", "staging", "live"],
    },
    ...overrides,
  };
}

function store(consume: (key: string, consumedAt: string) => boolean): BrokerStateStore {
  return {
    load: () => { throw new Error("unused"); },
    save: () => undefined,
    consumeLiveApprovalKey: consume,
  } as BrokerStateStore;
}

test("live task admission verifies, consumes, and replaces the token with a broker receipt", () => {
  const consumed: string[] = [];
  const admitted = admitLiveTaskSubmission(task(), {
    requesterIdentity: { id: "seoseo-a2a-finalizer", role: "operator" },
    worker: worker(),
    stateStore: store((key) => { consumed.push(key); return true; }),
    signingKey: SIGNING_KEY,
    brokerId: "seoseo",
    now: NOW,
  });

  const payload = admitted.payload as Record<string, unknown>;
  const admittedOperation = payload.liveOperation as Record<string, unknown>;
  assert.equal(admittedOperation.approvalToken, undefined);
  assert.equal(consumed.length, 1);
  const receipt = payload.approvalReceipt as Record<string, unknown>;
  const { receiptMac, ...receiptFields } = receipt;
  assert.match(String(receiptMac), /^[a-f0-9]{64}$/);
  assert.deepEqual(receiptFields, {
    schema: "a2a.live-approval-receipt.v1",
    brokerId: "seoseo",
    taskId: "task-live-343-1",
    runId: "run-343-1",
    action: "promote_to_live_apply",
    target: "ccc-node:nosuk:dff7c773",
    targetWorkerId: "nosuk",
    targetSha: "dff7c773b1f8eec62bd278945cb6e210f1c27f6f",
    runbookId: "ccc-node-3node-rollout-v1",
    consumedAt: NOW,
    consumptionKey: consumed[0],
  });
});

test("live task admission fails closed without an atomic consumption store", () => {
  assert.throws(
    () => admitLiveTaskSubmission(task(), {
      requesterIdentity: { id: "seoseo-a2a-finalizer", role: "operator" },
      worker: worker(),
      stateStore: { load: () => { throw new Error("unused"); }, save: () => undefined } as BrokerStateStore,
      signingKey: SIGNING_KEY,
      brokerId: "seoseo",
      now: NOW,
    }),
    /atomic live approval consumption is unavailable/,
  );
});

test("live task admission rejects replay and incapable workers", () => {
  const base = {
    requesterIdentity: { id: "seoseo-a2a-finalizer", role: "operator" as const },
    signingKey: SIGNING_KEY,
    brokerId: "seoseo",
    now: NOW,
  };
  assert.throws(
    () => admitLiveTaskSubmission(task(), { ...base, worker: worker(), stateStore: store(() => false) }),
    /approval token has already been consumed/,
  );
  assert.throws(
    () => admitLiveTaskSubmission(task(), {
      ...base,
      worker: worker({ capabilities: { ...worker().capabilities, canPromoteLive: false } }),
      stateStore: store(() => true),
    }),
    /canPromoteLive/,
  );
});

test("live task admission binds token issuance time and target identity", () => {
  const badOperation = operation({ approvalTokenIssuedAt: "2026-07-10T20:29:31.000Z" });
  badOperation.approvalToken = buildLiveApprovalTokenV2(
    {
      taskId: "task-live-343-1",
      runId: badOperation.runId,
      action: badOperation.action,
      target: badOperation.target,
    },
    {
      targetWorkerId: badOperation.targetWorkerId,
      targetSha: badOperation.targetSha,
      runbookId: badOperation.runbookId,
    },
    "2026-07-10T20:29:30.000Z",
    "nonce-live-343-1",
    "seoseo-a2a-finalizer",
    SIGNING_KEY,
  );
  const badTask = task({ payload: { mode: LIVE_TASK_MODE, liveOperation: badOperation } });
  assert.throws(
    () => admitLiveTaskSubmission(badTask, {
      requesterIdentity: { id: "seoseo-a2a-finalizer", role: "operator" },
      worker: worker(),
      stateStore: store(() => true),
      signingKey: SIGNING_KEY,
      brokerId: "seoseo",
      now: NOW,
    }),
    /issued-at binding mismatch/,
  );
});

test("live task admission rejects a token issued for a different requester identity", () => {
  const op = operation();
  op.approvalToken = buildLiveApprovalTokenV2(
    {
      taskId: "task-live-343-1",
      runId: op.runId,
      action: op.action,
      target: op.target,
    },
    {
      targetWorkerId: op.targetWorkerId,
      targetSha: op.targetSha,
      runbookId: op.runbookId,
    },
    op.approvalTokenIssuedAt,
    "nonce-live-343-1",
    "different-operator",
    SIGNING_KEY,
  );
  assert.throws(
    () => admitLiveTaskSubmission(task({ payload: { mode: LIVE_TASK_MODE, liveOperation: op } }), {
      requesterIdentity: { id: "seoseo-a2a-finalizer", role: "operator" },
      worker: worker(),
      stateStore: store(() => true),
      signingKey: SIGNING_KEY,
      brokerId: "seoseo",
      now: NOW,
    }),
    /signature mismatch/,
  );
});

test("live task admission cryptographically binds target SHA and runbook", () => {
  const op = operation();
  op.targetSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  assert.throws(
    () => admitLiveTaskSubmission(task({ payload: { mode: LIVE_TASK_MODE, liveOperation: op } }), {
      requesterIdentity: { id: "seoseo-a2a-finalizer", role: "operator" },
      worker: worker(),
      stateStore: store(() => true),
      signingKey: SIGNING_KEY,
      brokerId: "seoseo",
      now: NOW,
    }),
    /signature mismatch/,
  );
});

test("live task admission rejects control-character framing ambiguity", () => {
  const op = operation({ runId: "run-343-1\nshifted" });
  assert.throws(
    () => admitLiveTaskSubmission(task({ payload: { mode: LIVE_TASK_MODE, liveOperation: op } }), {
      requesterIdentity: { id: "seoseo-a2a-finalizer", role: "operator" },
      worker: worker(),
      stateStore: store(() => true),
      signingKey: SIGNING_KEY,
      brokerId: "seoseo",
      now: NOW,
    }),
    /without control characters/,
  );
});

test("non-live task admission is byte-preserving", () => {
  const ordinary = task({ payload: { mode: "analysis-only", note: "unchanged" } });
  assert.equal(admitLiveTaskSubmission(ordinary, {
    requesterIdentity: null,
    worker: null,
    stateStore: { load: () => { throw new Error("unused"); }, save: () => undefined } as BrokerStateStore,
    signingKey: "",
    brokerId: "seoseo",
    now: NOW,
  }), ordinary);
});
