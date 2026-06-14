import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, createPrivateKey, sign } from "node:crypto";
import type { IncomingMessage } from "node:http";

import {
  assertGitHubWebhookSignature,
  buildA2AHttpSignatureBase,
  classifyRateLimitBucket,
  extractRequesterIdentity,
  InMemoryRateLimiter,
  loadA2AHttpSignatureKeyRegistryFile,
  rateLimitKey,
  verifyA2AHttpSignature,
} from "./request-security.js";

function createRequest(params: {
  headers?: Record<string, string>;
  remoteAddress?: string;
} = {}): IncomingMessage {
  return {
    headers: params.headers ?? {},
    socket: {
      remoteAddress: params.remoteAddress ?? "127.0.0.1",
    },
  } as IncomingMessage;
}

test("rateLimitKey ignores x-forwarded-for unless trusted proxy mode is enabled", () => {
  const request = createRequest({
    headers: {
      "x-forwarded-for": "203.0.113.10, 10.0.0.2",
    },
    remoteAddress: "10.0.0.2",
  });

  assert.equal(rateLimitKey(request, null), "ip:10.0.0.2");
  assert.equal(rateLimitKey(request, null, { trustedProxy: true }), "ip:203.0.113.10");
});

test("rateLimitKey always prefers requester identity over proxy headers", () => {
  const request = createRequest({
    headers: {
      "x-forwarded-for": "203.0.113.10",
    },
    remoteAddress: "10.0.0.2",
  });

  assert.equal(
    rateLimitKey(
      request,
      {
        id: "worker-a",
      },
      { trustedProxy: true },
    ),
    "requester:worker-a",
  );
});

test("extractRequesterIdentity parses requester scopes from headers", () => {
  const request = createRequest({
    headers: {
      "x-a2a-requester-id": "worker-a",
      "x-a2a-requester-scopes": "z.scope,a2a.peer.status.verbose z.scope",
    },
  });

  assert.deepEqual(extractRequesterIdentity(request), {
    id: "worker-a",
    scopes: ["a2a.peer.status.verbose", "z.scope"],
  });
});

test("extractRequesterIdentity rejects scopes headers without requester id", () => {
  const request = createRequest({
    headers: {
      "x-a2a-requester-scopes": "a2a.peer.status.verbose",
    },
  });

  assert.throws(
    () => extractRequesterIdentity(request),
    /x-a2a-requester-id is required/,
  );
});

test("classifyRateLimitBucket routes task heartbeats to the worker bucket", () => {
  const request = createRequest();
  request.method = "POST";

  for (const action of ["claim", "start", "complete", "evidence", "fail", "heartbeat"]) {
    const url = new URL(`http://broker.test/tasks/task-1/${action}`);
    assert.equal(
      classifyRateLimitBucket(request, url),
      "worker",
      `tasks/:id/${action} must use the worker bucket`,
    );
  }
});

test("assertGitHubWebhookSignature is a no-op when no secret is configured", () => {
  assert.doesNotThrow(() =>
    assertGitHubWebhookSignature(Buffer.from("{}"), undefined, undefined),
  );
});

test("assertGitHubWebhookSignature rejects missing or malformed signature headers", () => {
  const body = Buffer.from('{"action":"opened"}');

  assert.throws(
    () => assertGitHubWebhookSignature(body, undefined, "secret"),
    /x-hub-signature-256 is required/,
  );
  assert.throws(
    () => assertGitHubWebhookSignature(body, "sha1=deadbeef", "secret"),
    /x-hub-signature-256 is required/,
  );
});

test("assertGitHubWebhookSignature rejects signatures computed with the wrong secret", () => {
  const body = Buffer.from('{"action":"opened"}');
  const wrong = `sha256=${createHmac("sha256", "other-secret").update(body).digest("hex")}`;

  assert.throws(
    () => assertGitHubWebhookSignature(body, wrong, "secret"),
    /verification failed/,
  );
});

test("assertGitHubWebhookSignature accepts a valid signature over the raw body", () => {
  const body = Buffer.from('{"action":"opened"}');
  const valid = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;

  assert.doesNotThrow(() => assertGitHubWebhookSignature(body, valid, "secret"));
  assert.doesNotThrow(() =>
    assertGitHubWebhookSignature(body, valid.toUpperCase().replace("SHA256=", "sha256="), "secret"),
  );
});

test("InMemoryRateLimiter bounds its bucket map under a flood of distinct keys (a2a-nexus#573 item 14)", () => {
  const limiter = new InMemoryRateLimiter(100, 60_000);
  const now = 1_000_000;

  // The key is the (self-asserted) requester id, so a rotating-id flood could
  // grow the map without bound. Far more distinct keys than the cap, all within
  // the window, must still leave the bucket map bounded.
  for (let i = 0; i < 25_000; i++) {
    limiter.check(`key-${i}`, now);
  }

  const snap = limiter.snapshot(now);
  assert.ok(
    snap.activeKeys <= 10_000,
    `rate-limiter bucket map must stay bounded, got ${snap.activeKeys}`,
  );
});

test("InMemoryRateLimiter prunes idle buckets once over the cap (a2a-nexus#573 item 14)", () => {
  const limiter = new InMemoryRateLimiter(100, 60_000);

  // Insert just over the cap with old timestamps, then one fresh key past the
  // cap so check() runs a prune; the stale buckets should be dropped.
  for (let i = 0; i < 10_001; i++) {
    limiter.check(`stale-${i}`, 0);
  }
  // Far past the window so the earlier keys are idle.
  limiter.check("fresh", 10 * 60_000);

  const snap = limiter.snapshot(10 * 60_000);
  assert.ok(snap.activeKeys <= 10_000, `idle buckets should be pruned, got ${snap.activeKeys}`);
});

// Synthetic test-only Ed25519 fixture generated locally for deterministic verifier
// coverage. This key pair is not used by any broker or worker deployment.
const testPrivateJwk = {
  crv: "Ed25519",
  d: "AaTuhLv-jaClRWi80aTnBCH7OaqKDTRI1-BhVY6n8hw",
  x: "5WS0NM-6IqCFjg6O1otAWtJV2H-1kdybf7nFp4PEzdY",
  kty: "OKP",
} as const;

const testPublicJwk = {
  crv: "Ed25519",
  x: "5WS0NM-6IqCFjg6O1otAWtJV2H-1kdybf7nFp4PEzdY",
  kty: "OKP",
} as const;

const signedRequestBase = {
  method: "POST",
  authority: "broker.seoyoon-family.com",
  path: "/tasks/task-123/claim",
  query: "",
  headers: {
    "content-digest": "sha-256=:HT2PpCSN0Yph+r0hZ1dMmC5RkVx9LBtB7l9nD7vrFq8=:",
    "x-a2a-requester-id": "sogyo",
    "x-a2a-requester-role": "analyst",
    "x-a2a-broker-id": "seoseo",
  },
  signatureInput: "a2a=(\"@method\" \"@authority\" \"@path\" \"@query\" \"content-digest\" \"x-a2a-requester-id\" \"x-a2a-requester-role\" \"x-a2a-broker-id\");alg=\"ed25519\";keyid=\"worker:sogyo:v1\";created=1770861600;expires=1770861660;nonce=\"nonce-test-1\";tag=\"a2a-worker-v1\"",
};

function makeSignedA2ARequest(
  overrides: Omit<Partial<typeof signedRequestBase>, "headers"> & {
    headers?: Partial<typeof signedRequestBase.headers>;
  } = {},
) {
  const request = {
    ...signedRequestBase,
    ...overrides,
    headers: {
      ...signedRequestBase.headers,
      ...(overrides.headers ?? {}),
    },
  };
  const privateKey = createPrivateKey({ key: testPrivateJwk, format: "jwk" });
  const signature = sign(null, Buffer.from(buildA2AHttpSignatureBase(request)), privateKey).toString("base64");
  return {
    ...request,
    signature: `a2a=:${signature}:`,
  };
}

const a2aKeyRegistry = {
  "worker:sogyo:v1": {
    keyid: "worker:sogyo:v1",
    workerId: "sogyo",
    publicKeyJwk: testPublicJwk,
  },
};


test("A2A HTTP Signature key registry loads validated public worker keys from a JSON file", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-signature-registry-"));
  const file = join(dir, "worker-public-keys.json");
  writeFileSync(file, JSON.stringify({
    "worker:sogyo:v1": {
      keyid: "worker:sogyo:v1",
      workerId: "sogyo",
      publicKeyJwk: testPublicJwk,
    },
  }));

  assert.deepEqual(loadA2AHttpSignatureKeyRegistryFile(file), a2aKeyRegistry);
});

test("A2A HTTP Signature key registry rejects private key material and keyid mismatches", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-signature-registry-invalid-"));
  const privateFile = join(dir, "private-material.json");
  writeFileSync(privateFile, JSON.stringify({
    "worker:sogyo:v1": {
      keyid: "worker:sogyo:v1",
      workerId: "sogyo",
      publicKeyJwk: testPrivateJwk,
    },
  }));
  assert.throws(
    () => loadA2AHttpSignatureKeyRegistryFile(privateFile),
    /must not contain private key material/,
  );

  const mismatchFile = join(dir, "keyid-mismatch.json");
  writeFileSync(mismatchFile, JSON.stringify({
    "worker:sogyo:v1": {
      keyid: "worker:bangtong:v1",
      workerId: "sogyo",
      publicKeyJwk: testPublicJwk,
    },
  }));
  assert.throws(
    () => loadA2AHttpSignatureKeyRegistryFile(mismatchFile),
    /registry key must match embedded keyid/,
  );

  const duplicateWorkerFile = join(dir, "duplicate-worker.json");
  writeFileSync(duplicateWorkerFile, JSON.stringify({
    "worker:sogyo:v1": {
      keyid: "worker:sogyo:v1",
      workerId: "sogyo",
      publicKeyJwk: testPublicJwk,
    },
    "worker:sogyo:v2": {
      keyid: "worker:sogyo:v2",
      workerId: "sogyo",
      publicKeyJwk: testPublicJwk,
    },
  }));
  assert.throws(
    () => loadA2AHttpSignatureKeyRegistryFile(duplicateWorkerFile),
    /duplicate workerId/,
  );
});

test("A2A HTTP Signature verifier accepts a deterministic Ed25519 signed worker request", () => {
  const result = verifyA2AHttpSignature(makeSignedA2ARequest(), a2aKeyRegistry, { nowEpochSeconds: 1770861620 });

  assert.deepEqual(result, {
    ok: true,
    keyid: "worker:sogyo:v1",
    requesterId: "sogyo",
    brokerId: "seoseo",
    created: 1770861600,
    expires: 1770861660,
    nonce: "nonce-test-1",
  });
});

test("A2A HTTP Signature verifier rejects a signed request after covered path mutation", () => {
  const signed = makeSignedA2ARequest();
  const result = verifyA2AHttpSignature({ ...signed, path: "/tasks/task-999/claim" }, a2aKeyRegistry, { nowEpochSeconds: 1770861620 });

  assert.equal(result.ok, false);
  assert.equal(result.code, "a2a_signature_invalid");
});

test("A2A HTTP Signature verifier rejects mutations to covered method, query, digest, or broker id", () => {
  const signed = makeSignedA2ARequest();

  for (const [label, mutated] of [
    ["method", { ...signed, method: "GET" }],
    ["query", { ...signed, query: "assignedWorkerId=sogyo" }],
    [
      "content-digest",
      {
        ...signed,
        headers: { ...signed.headers, "content-digest": "sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:" },
      },
    ],
    ["broker id", { ...signed, headers: { ...signed.headers, "x-a2a-broker-id": "gwakga" } }],
  ] as const) {
    const result = verifyA2AHttpSignature(mutated, a2aKeyRegistry, { nowEpochSeconds: 1770861620 });
    assert.equal(result.ok, false, label);
    assert.equal(result.code, "a2a_signature_invalid", label);
  }
});

test("A2A HTTP Signature verifier fails closed for unknown key ids", () => {
  const request = makeSignedA2ARequest({
    signatureInput: signedRequestBase.signatureInput.replace("worker:sogyo:v1", "worker:unknown:v1"),
  });
  const result = verifyA2AHttpSignature(request, a2aKeyRegistry, { nowEpochSeconds: 1770861620 });

  assert.equal(result.ok, false);
  assert.equal(result.code, "a2a_signature_unknown_key");
});

test("A2A HTTP Signature verifier binds requester id to the key owner", () => {
  const request = makeSignedA2ARequest({
    headers: { "x-a2a-requester-id": "bangtong" },
  });
  const result = verifyA2AHttpSignature(request, a2aKeyRegistry, { nowEpochSeconds: 1770861620 });

  assert.equal(result.ok, false);
  assert.equal(result.code, "a2a_signature_identity_mismatch");
});

test("A2A HTTP Signature verifier rejects expired or future-created signatures", () => {
  assert.equal(
    verifyA2AHttpSignature(makeSignedA2ARequest(), a2aKeyRegistry, { nowEpochSeconds: 1770861661 }).code,
    "a2a_signature_time_invalid",
  );
  assert.equal(
    verifyA2AHttpSignature(makeSignedA2ARequest(), a2aKeyRegistry, { nowEpochSeconds: 1770861500 }).code,
    "a2a_signature_time_invalid",
  );
});

test("A2A HTTP Signature verifier rejects unsupported algorithm or tag", () => {
  assert.equal(
    verifyA2AHttpSignature(
      makeSignedA2ARequest({ signatureInput: signedRequestBase.signatureInput.replace('alg="ed25519"', 'alg="rsa-pss-sha512"') }),
      a2aKeyRegistry,
      { nowEpochSeconds: 1770861620 },
    ).code,
    "a2a_signature_unsupported_profile",
  );
  assert.equal(
    verifyA2AHttpSignature(
      makeSignedA2ARequest({ signatureInput: signedRequestBase.signatureInput.replace('tag="a2a-worker-v1"', 'tag="other"') }),
      a2aKeyRegistry,
      { nowEpochSeconds: 1770861620 },
    ).code,
    "a2a_signature_unsupported_profile",
  );
});
