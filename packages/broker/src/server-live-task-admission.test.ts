import assert from "node:assert/strict";
import test from "node:test";

import { buildLiveApprovalTokenV2 } from "./core/live-task-admission.js";
import { createInMemoryStateStore, jsonHeaders, startTestServer } from "./server-test-helpers.js";

const SIGNING_KEY = "test-live-admission-signing-key-with-32-bytes";
const EDGE_SECRET = "test-live-admission-edge-secret-32-bytes";

test("POST /tasks admits a signed live task once and stores only a broker receipt", async () => {
  const consumed = new Set<string>();
  const stateStore = createInMemoryStateStore();
  stateStore.consumeLiveApprovalKey = (key) => {
    if (consumed.has(key)) return false;
    consumed.add(key);
    return true;
  };
  const server = await startTestServer({
    stateStore,
    enforceRequesterIdentity: true,
    edgeSecret: EDGE_SECRET,
    liveApprovalSigningKey: SIGNING_KEY,
    brokerId: "seoseo-test",
  });
  try {
    const registration = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "nosuk",
        "x-a2a-requester-role": "analyst",
        "x-a2a-edge-secret": EDGE_SECRET,
      }),
      body: JSON.stringify({
        nodeId: "nosuk",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: true,
          canPromoteLive: true,
          workspaceIds: ["ccc-node"],
          environments: ["research", "staging", "live"],
        },
      }),
    });
    assert.equal(registration.status, 201, await registration.text());

    const issuedAt = new Date().toISOString();
    const scope = {
      taskId: "task-live-http-1",
      runId: "run-live-http-1",
      action: "promote_to_live_apply" as const,
      target: "ccc-node:nosuk:dff7c773",
    };
    const request = {
      id: scope.taskId,
      requester: { id: "seoseo-a2a-finalizer", kind: "service", role: "operator" },
      target: { id: "nosuk", kind: "node", role: "analyst" },
      targetNodeId: "nosuk",
      intent: "promote_to_live",
      message: "approved deterministic live operation",
      payload: {
        mode: "promote-to-live-v1",
        liveOperation: {
          schema: "a2a.live-operation.v1",
          runId: scope.runId,
          action: scope.action,
          target: scope.target,
          targetWorkerId: "nosuk",
          targetSha: "dff7c773b1f8eec62bd278945cb6e210f1c27f6f",
          runbookId: "ccc-node-3node-rollout-v1",
          approvalTokenIssuedAt: issuedAt,
          approvalToken: buildLiveApprovalTokenV2(
            scope,
            {
              targetWorkerId: "nosuk",
              targetSha: "dff7c773b1f8eec62bd278945cb6e210f1c27f6f",
              runbookId: "ccc-node-3node-rollout-v1",
            },
            issuedAt,
            "nonce-http-live-1",
            "seoseo-a2a-finalizer",
            SIGNING_KEY,
          ),
        },
      },
      taskOrigin: "api",
    };
    const headers = jsonHeaders({
      "x-a2a-requester-id": "seoseo-a2a-finalizer",
      "x-a2a-requester-role": "operator",
      "x-a2a-edge-secret": EDGE_SECRET,
    });
    const created = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
    const createdText = await created.text();
    assert.equal(created.status, 201, createdText);
    const body = JSON.parse(createdText) as { payload: Record<string, unknown> };
    const operation = body.payload.liveOperation as Record<string, unknown>;
    const receipt = body.payload.approvalReceipt as Record<string, unknown>;
    assert.equal(operation.approvalToken, undefined);
    assert.equal(receipt.schema, "a2a.live-approval-receipt.v1");
    assert.equal(receipt.taskId, scope.taskId);
    assert.match(String(receipt.receiptMac), /^[a-f0-9]{64}$/);

    const replayed = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
    assert.equal(replayed.status, 409);
    const replayBody = await replayed.json() as { error: { code: string; message: string } };
    assert.equal(replayBody.error.code, "invalid_transition");
    assert.match(replayBody.error.message, /already exists/);
  } finally {
    await server.close();
  }
});
