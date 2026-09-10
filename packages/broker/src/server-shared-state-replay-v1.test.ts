/**
 * Server-level tests for the #1504 §4 Slice S replay-primitive integration.
 *
 * With `sharedStateReplayV1: true` the worker HTTP-signature replay check is
 * consumed through the V1 adapter via the serving fence: the first signed
 * request succeeds, replaying the exact same signed headers is rejected as
 * `a2a_signature_replay`, and a fresh nonce still passes. The default-off
 * posture and the loud startup failure on an invalid env value are asserted
 * as well.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createBrokerServer } from "./server.js";
import { buildA2AHttpSignatureBase } from "./core/request-security.js";
import { createPrivateKey, sign } from "node:crypto";
import {
  createInMemoryStateStore,
  startTestServer,
  withEnv,
  workerPayload,
} from "./server-test-helpers.js";

const replayPrivateJwk = {
  crv: "Ed25519",
  d: "AaTuhLv-jaClRWi80aTnBCH7OaqKDTRI1-BhVY6n8hw",
  x: "5WS0NM-6IqCFjg6O1otAWtJV2H-1kdybf7nFp4PEzdY",
  kty: "OKP",
} as const;

const replayPublicJwk = {
  crv: "Ed25519",
  x: "5WS0NM-6IqCFjg6O1otAWtJV2H-1kdybf7nFp4PEzdY",
  kty: "OKP",
} as const;

const replayKeyRegistry = {
  "worker:workerbeta:v1": {
    keyid: "worker:workerbeta:v1",
    workerId: "workerbeta",
    publicKeyJwk: replayPublicJwk,
  },
};

function signedWorkerHeaders(params: {
  baseUrl: string;
  method: string;
  path: string;
  body?: string;
  nonce: string;
}): Record<string, string> {
  const url = new URL(params.path, params.baseUrl);
  const rawBody = Buffer.from(params.body ?? "");
  const headers = {
    "content-type": "application/json",
    "content-digest": `sha-256=:${createHash("sha256").update(rawBody).digest("base64")}:`,
    "x-a2a-requester-id": "workerbeta",
    "x-a2a-requester-role": "analyst",
    "x-a2a-broker-id": "brokeralpha",
  };
  const keyid = "worker:workerbeta:v1";
  const created = Math.floor(Date.now() / 1000) - 1;
  const expires = created + 60;
  const signatureInput = `a2a=("@method" "@authority" "@path" "@query" "content-digest" "x-a2a-requester-id" "x-a2a-requester-role" "x-a2a-broker-id");alg="ed25519";keyid="${keyid}";created=${created};expires=${expires};nonce="${params.nonce}";tag="a2a-worker-v1"`;
  const signatureBase = buildA2AHttpSignatureBase({
    method: params.method,
    authority: url.host,
    path: url.pathname,
    query: "",
    headers,
    signatureInput,
  });
  const privateKey = createPrivateKey({ key: replayPrivateJwk, format: "jwk" });
  const signature = sign(null, Buffer.from(signatureBase), privateKey).toString("base64");
  return {
    ...headers,
    "signature-input": signatureInput,
    signature: `a2a=:${signature}:`,
  };
}

test("sharedStateReplayV1 consumes worker signature nonces through the V1 primitive", async () => {
  const server = await startTestServer({
    brokerId: "brokeralpha",
    a2aHttpSignatureWorkerAuth: "strict",
    a2aHttpSignatureKeyRegistry: replayKeyRegistry,
    sharedStateReplayV1: true,
  });
  try {
    const body = JSON.stringify(workerPayload("workerbeta"));
    const firstHeaders = signedWorkerHeaders({
      baseUrl: server.baseUrl,
      method: "POST",
      path: "/workers/register",
      body,
      nonce: "v1-replay-register-once",
    });
    const firstRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: firstHeaders,
      body,
    });
    assert.equal(firstRes.status, 201);

    // Exact same signed headers: the V1 consumeReplayNonce tuple repeats, so
    // the decision must be `replay` → 401 a2a_signature_replay.
    const replayRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: firstHeaders,
      body,
    });
    assert.equal(replayRes.status, 401);
    const replayBody = await replayRes.json() as { error: { message: string } };
    assert.match(replayBody.error.message, /a2a_signature_replay/);

    // A fresh nonce is a first consumption, not a replay.
    const freshHeaders = signedWorkerHeaders({
      baseUrl: server.baseUrl,
      method: "POST",
      path: "/workers/register",
      body,
      nonce: "v1-replay-register-fresh",
    });
    const freshRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: freshHeaders,
      body,
    });
    // The worker already exists from the first registration, so a 409-class
    // conflict is fine; what matters is that the failure is NOT a replay.
    if (freshRes.status === 401) {
      const freshBody = await freshRes.json() as { error: { message: string } };
      assert.doesNotMatch(freshBody.error.message, /a2a_signature_replay/);
    }
  } finally {
    await server.close();
  }
});

test("invalid BROKER_SHARED_STATE_V1_REPLAY value fails startup loudly", async () => {
  await withEnv({ BROKER_SHARED_STATE_V1_REPLAY: "definitely-not-a-mode" }, async () => {
    assert.throws(
      () =>
        createBrokerServer({
          host: "127.0.0.1",
          port: 0,
          publicBaseUrl: "https://broker.test/",
          brokerId: "brokeralpha",
          stateStore: createInMemoryStateStore(),
          a2aHttpSignatureWorkerAuth: "strict",
          a2aHttpSignatureKeyRegistry: replayKeyRegistry,
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("BROKER_SHARED_STATE_V1_REPLAY"),
    );
  });
});

test("default-off keeps the process-local replay cache behavior unchanged", async () => {
  const server = await startTestServer({
    brokerId: "brokeralpha",
    a2aHttpSignatureWorkerAuth: "strict",
    a2aHttpSignatureKeyRegistry: replayKeyRegistry,
    sharedStateReplayV1: false,
  });
  try {
    const body = JSON.stringify(workerPayload("workerbeta"));
    const headers = signedWorkerHeaders({
      baseUrl: server.baseUrl,
      method: "POST",
      path: "/workers/register",
      body,
      nonce: "local-cache-register-once",
    });
    const firstRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers,
      body,
    });
    assert.equal(firstRes.status, 201);
    const replayRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers,
      body,
    });
    assert.equal(replayRes.status, 401);
    const replayBody = await replayRes.json() as { error: { message: string } };
    assert.match(replayBody.error.message, /a2a_signature_replay/);
  } finally {
    await server.close();
  }
});
