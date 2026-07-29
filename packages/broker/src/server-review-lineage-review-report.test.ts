import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  sign,
} from "node:crypto";
import test from "node:test";

import { buildA2AHttpSignatureBase } from "./core/request-security.js";
import { SqliteBrokerStateStore } from "./core/store.js";
import { intentHash } from "./review-lifecycle/canonical-json.js";
import {
  jsonHeaders,
  startTestServer,
} from "./server-test-helpers.js";

const privateJwk = {
  crv: "Ed25519",
  d: "AaTuhLv-jaClRWi80aTnBCH7OaqKDTRI1-BhVY6n8hw",
  x: "5WS0NM-6IqCFjg6O1otAWtJV2H-1kdybf7nFp4PEzdY",
  kty: "OKP",
} as const;

const publicJwk = {
  crv: "Ed25519",
  x: "5WS0NM-6IqCFjg6O1otAWtJV2H-1kdybf7nFp4PEzdY",
  kty: "OKP",
} as const;

function signedHeaders(params: {
  baseUrl: string;
  path: string;
  workerId: "reviewerbeta" | "reviewergamma";
  body: string;
  nonce: string;
}): Record<string, string> {
  const url = new URL(params.path, params.baseUrl);
  const rawBody = Buffer.from(params.body);
  const headers = {
    "content-type": "application/json",
    "content-digest":
      `sha-256=:${createHash("sha256").update(rawBody).digest("base64")}:`,
    "x-a2a-requester-id": params.workerId,
    "x-a2a-requester-role": "analyst",
    "x-a2a-broker-id": "brokeralpha",
  };
  const keyid = `worker:${params.workerId}:v1`;
  const created = Math.floor(Date.now() / 1000) - 1;
  const expires = created + 60;
  const signatureInput =
    `a2a=("@method" "@authority" "@path" "@query" "content-digest" `
    + `"x-a2a-requester-id" "x-a2a-requester-role" "x-a2a-broker-id");`
    + `alg="ed25519";keyid="${keyid}";created=${created};`
    + `expires=${expires};nonce="${params.nonce}";tag="a2a-worker-v1"`;
  const signatureBase = buildA2AHttpSignatureBase({
    method: "POST",
    authority: url.host,
    path: url.pathname,
    query: "",
    headers,
    signatureInput,
  });
  const signature = sign(
    null,
    Buffer.from(signatureBase),
    createPrivateKey({ key: privateJwk, format: "jwk" }),
  ).toString("base64");
  return {
    ...headers,
    "signature-input": signatureInput,
    signature: `a2a=:${signature}:`,
  };
}

function frozenContract() {
  const partial = {
    kind: "IntentContractV1" as const,
    lineageId: "phase16-signed-route",
    goal: "Authenticate the explicit review report source.",
    nonGoals: ["Do not infer reports from task results."],
    invariants: ["The signing-key owner is the reviewer issuer."],
    acceptanceCriteria: [
      { id: "AC-1", text: "The route is signature and scope gated." },
    ],
    declaredPaths: {
      allowed: ["packages/broker/src/**"],
      forbidden: ["packages/broker/src/worker.ts"],
    },
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    createdAt: "2026-07-28T10:20:00Z",
  };
  return {
    ...partial,
    intentHash: intentHash(partial as unknown as Record<string, unknown>),
  };
}

function reviewRequest(reviewerNodeId: string) {
  const contract = frozenContract();
  const diffHash = `sha256:${"c".repeat(64)}`;
  return {
    reportRef: `review-report:signed:${reviewerNodeId}:1`,
    observedAt: "2026-07-28T10:21:00Z",
    binding: {
      intentHash: contract.intentHash,
      headSha: contract.headSha,
      diffHash,
    },
    receipt: {
      kind: "ReviewReceiptV1",
      reviewerNodeId,
      verdict: "pass",
      note: "Signed review report.",
      headSha: contract.headSha,
      diffHash,
      intentHash: contract.intentHash,
      findingLedgerRef: `ledger-${contract.lineageId}`,
      authorWorkerId: "authoralpha",
    },
    resolvedFindingIds: [],
    reopenedFindingIds: [],
    newFindings: [],
  };
}

test("review-report route authenticates Ed25519 key ownership and enforces its dedicated scope", async () => {
  const stateStore = new SqliteBrokerStateStore(":memory:");
  const keyRegistry = {
    "worker:reviewerbeta:v1": {
      keyid: "worker:reviewerbeta:v1",
      workerId: "reviewerbeta",
      publicKeyJwk: publicJwk,
      scopes: ["review-lineage.report"] as const,
    },
    "worker:reviewergamma:v1": {
      keyid: "worker:reviewergamma:v1",
      workerId: "reviewergamma",
      publicKeyJwk: publicJwk,
      scopes: ["task.complete"] as const,
    },
  };
  const server = await startTestServer({
    brokerId: "brokeralpha",
    stateStore,
    reviewLineageMode: "record",
    a2aHttpSignatureWorkerAuth: "strict",
    a2aHttpSignatureKeyRegistry: keyRegistry,
  });
  try {
    const contract = frozenContract();
    const createResponse = await fetch(`${server.baseUrl}/review-lineages`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "operatoralpha",
        "x-a2a-requester-role": "operator",
      }),
      body: JSON.stringify({
        dispatchRef: "lineage-dispatch:signed-route:1",
        observedAt: contract.createdAt,
        binding: {
          intentHash: contract.intentHash,
          headSha: contract.headSha,
          diffHash: `sha256:${"c".repeat(64)}`,
        },
        contract,
        budget: {
          kind: "ReviewLineageBudgetV1",
          maxWallClockSeconds: 21_600,
          maxCorrectionGenerations: 1,
          maxReviewerRuns: 2,
          maxReviewerReplacements: 1,
          repeatedFindingThreshold: 2,
          onExhaustion: "blocked_needs_operator",
        },
      }),
    });
    assert.equal(createResponse.status, 201);

    const path = `/review-lineages/${contract.lineageId}/review-report`;
    const allowedBody = JSON.stringify(reviewRequest("reviewerbeta"));
    const unsigned = await fetch(`${server.baseUrl}${path}`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "reviewerbeta",
        "x-a2a-requester-role": "analyst",
      }),
      body: allowedBody,
    });
    assert.equal(unsigned.status, 401);

    const deniedBody = JSON.stringify(reviewRequest("reviewergamma"));
    const denied = await fetch(`${server.baseUrl}${path}`, {
      method: "POST",
      headers: signedHeaders({
        baseUrl: server.baseUrl,
        path,
        workerId: "reviewergamma",
        body: deniedBody,
        nonce: "phase16-scope-denied",
      }),
      body: deniedBody,
    });
    assert.equal(denied.status, 403);
    const deniedJson = await denied.json() as {
      error: { code: string; message: string };
    };
    assert.equal(deniedJson.error.code, "policy_denied");
    assert.match(
      deniedJson.error.message,
      /not authorized for review-lineage\.report/,
    );

    const mismatchBody = JSON.stringify(reviewRequest("reviewergamma"));
    const mismatch = await fetch(`${server.baseUrl}${path}`, {
      method: "POST",
      headers: signedHeaders({
        baseUrl: server.baseUrl,
        path,
        workerId: "reviewerbeta",
        body: mismatchBody,
        nonce: "phase16-reviewer-mismatch",
      }),
      body: mismatchBody,
    });
    assert.equal(mismatch.status, 400);
    const mismatchJson = await mismatch.json() as {
      error: { message: string };
    };
    assert.match(mismatchJson.error.message, /issuer_mismatch/);

    const allowed = await fetch(`${server.baseUrl}${path}`, {
      method: "POST",
      headers: signedHeaders({
        baseUrl: server.baseUrl,
        path,
        workerId: "reviewerbeta",
        body: allowedBody,
        nonce: "phase16-review-accepted",
      }),
      body: allowedBody,
    });
    assert.equal(allowed.status, 201);
    const allowedJson = await allowed.json() as {
      result: { status: string; state: string };
    };
    assert.deepEqual(allowedJson.result, {
      status: "applied",
      lineageId: contract.lineageId,
      outcome: "applied",
      state: "passed",
      recordVersion: 2,
      effects: ["lineage_passed"],
    });
  } finally {
    await server.close();
    stateStore.close();
  }
});
