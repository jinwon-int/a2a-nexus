import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, createPrivateKey, sign } from "node:crypto";
import type { IncomingMessage } from "node:http";

import {
  A2A_WORKER_ROUTE_SCOPES,
  assertA2AWorkerScopeAllowed,
  assertGitHubWebhookSignature,
  buildA2AHttpSignatureBase,
  classifyRateLimitBucket,
  extractRequesterIdentity,
  InMemoryNonceCache,
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
  const maxBucketKeys = 10_000;

  // The key is the (self-asserted) requester id, so a rotating-id flood could
  // grow the map without bound. The safety property only needs to cross the
  // bucket cap: cap + 1 exercises pruneBuckets() without making the default test
  // gate spend seconds iterating keys that cannot change the assertion.
  for (let i = 0; i < maxBucketKeys + 1; i++) {
    limiter.check(`key-${i}`, now);
  }

  const snap = limiter.snapshot(now);
  assert.ok(
    snap.activeKeys <= maxBucketKeys,
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

test("A2A HTTP Signature key registry parses a per-key scope grant", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-signature-registry-scopes-"));
  const file = join(dir, "scoped-keys.json");
  writeFileSync(file, JSON.stringify({
    "worker:sogyo:v1": {
      keyid: "worker:sogyo:v1",
      workerId: "sogyo",
      publicKeyJwk: testPublicJwk,
      scopes: ["worker.register", "worker.heartbeat", "tasks.list", "tasks.list"],
    },
  }));
  const registry = loadA2AHttpSignatureKeyRegistryFile(file);
  // Duplicates are collapsed; declared order is preserved.
  assert.deepEqual(registry["worker:sogyo:v1"].scopes, [
    "worker.register",
    "worker.heartbeat",
    "tasks.list",
  ]);
});

test("A2A HTTP Signature key registry rejects unknown or malformed scope tokens", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-signature-registry-scopes-invalid-"));
  const unknownFile = join(dir, "unknown-scope.json");
  writeFileSync(unknownFile, JSON.stringify({
    "worker:sogyo:v1": {
      keyid: "worker:sogyo:v1",
      workerId: "sogyo",
      publicKeyJwk: testPublicJwk,
      scopes: ["task.claim", "tasks.delete-everything"],
    },
  }));
  assert.throws(
    () => loadA2AHttpSignatureKeyRegistryFile(unknownFile),
    /unknown scope token/,
  );

  const emptyFile = join(dir, "empty-scope.json");
  writeFileSync(emptyFile, JSON.stringify({
    "worker:sogyo:v1": {
      keyid: "worker:sogyo:v1",
      workerId: "sogyo",
      publicKeyJwk: testPublicJwk,
      scopes: [],
    },
  }));
  assert.throws(
    () => loadA2AHttpSignatureKeyRegistryFile(emptyFile),
    /scopes must be a non-empty array/,
  );
});

test("assertA2AWorkerScopeAllowed treats an unscoped legacy key as authorized for every route", () => {
  for (const scope of A2A_WORKER_ROUTE_SCOPES) {
    assert.doesNotThrow(() => assertA2AWorkerScopeAllowed(undefined, scope));
  }
});

test("assertA2AWorkerScopeAllowed authorizes only the declared scopes and fails closed otherwise", () => {
  const granted = ["worker.register", "worker.heartbeat", "tasks.list"] as const;
  for (const scope of granted) {
    assert.doesNotThrow(() => assertA2AWorkerScopeAllowed(granted, scope));
  }
  assert.throws(
    () => assertA2AWorkerScopeAllowed(granted, "task.complete"),
    /a2a_signature_scope_denied: signing key is not authorized for task\.complete/,
  );
});

test("A2A HTTP Signature key registry parses and validates credential lifecycle metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-signature-registry-lifecycle-"));
  const validFile = join(dir, "lifecycle.json");
  writeFileSync(validFile, JSON.stringify({
    "worker:sogyo:v1": {
      keyid: "worker:sogyo:v1",
      workerId: "sogyo",
      publicKeyJwk: testPublicJwk,
      status: "revoked",
      notBefore: "2026-06-01T00:00:00Z",
      expiresAt: "2026-07-01T00:00:00Z",
    },
  }));
  const record = loadA2AHttpSignatureKeyRegistryFile(validFile)["worker:sogyo:v1"];
  assert.equal(record.status, "revoked");
  assert.equal(record.notBefore, "2026-06-01T00:00:00Z");
  assert.equal(record.expiresAt, "2026-07-01T00:00:00Z");

  const badStatus = join(dir, "bad-status.json");
  writeFileSync(badStatus, JSON.stringify({
    "worker:sogyo:v1": { keyid: "worker:sogyo:v1", workerId: "sogyo", publicKeyJwk: testPublicJwk, status: "disabled" },
  }));
  assert.throws(() => loadA2AHttpSignatureKeyRegistryFile(badStatus), /status must be "active" or "revoked"/);

  const badInstant = join(dir, "bad-instant.json");
  writeFileSync(badInstant, JSON.stringify({
    "worker:sogyo:v1": { keyid: "worker:sogyo:v1", workerId: "sogyo", publicKeyJwk: testPublicJwk, expiresAt: "not-a-date" },
  }));
  assert.throws(() => loadA2AHttpSignatureKeyRegistryFile(badInstant), /expiresAt must be an ISO-8601 instant/);

  const invertedWindow = join(dir, "inverted-window.json");
  writeFileSync(invertedWindow, JSON.stringify({
    "worker:sogyo:v1": {
      keyid: "worker:sogyo:v1",
      workerId: "sogyo",
      publicKeyJwk: testPublicJwk,
      notBefore: "2026-07-01T00:00:00Z",
      expiresAt: "2026-06-01T00:00:00Z",
    },
  }));
  assert.throws(() => loadA2AHttpSignatureKeyRegistryFile(invertedWindow), /notBefore must be earlier than expiresAt/);
});

test("A2A HTTP Signature verifier rejects revoked keys and keys outside their validity window (#691)", () => {
  const now = 1770861630; // within the fixture's created/expires window
  const iso = (epochSec: number) => new Date(epochSec * 1000).toISOString();
  const request = makeSignedA2ARequest();

  const revoked = verifyA2AHttpSignature(
    request,
    { "worker:sogyo:v1": { ...a2aKeyRegistry["worker:sogyo:v1"], status: "revoked" } },
    { nowEpochSeconds: now },
  );
  assert.equal(revoked.ok, false);
  assert.equal(revoked.ok === false && revoked.code, "a2a_signature_key_revoked");

  const expired = verifyA2AHttpSignature(
    request,
    { "worker:sogyo:v1": { ...a2aKeyRegistry["worker:sogyo:v1"], expiresAt: iso(now - 1) } },
    { nowEpochSeconds: now },
  );
  assert.equal(expired.ok === false && expired.code, "a2a_signature_key_inactive");

  const notYet = verifyA2AHttpSignature(
    request,
    { "worker:sogyo:v1": { ...a2aKeyRegistry["worker:sogyo:v1"], notBefore: iso(now + 1000) } },
    { nowEpochSeconds: now },
  );
  assert.equal(notYet.ok === false && notYet.code, "a2a_signature_key_inactive");

  const active = verifyA2AHttpSignature(
    request,
    {
      "worker:sogyo:v1": {
        ...a2aKeyRegistry["worker:sogyo:v1"],
        status: "active",
        notBefore: iso(now - 1000),
        expiresAt: iso(now + 1000),
      },
    },
    { nowEpochSeconds: now },
  );
  assert.equal(active.ok, true);
});

test("A2A HTTP Signature key registry parses and validates allowed roles", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-signature-registry-roles-"));
  const validFile = join(dir, "roles.json");
  writeFileSync(validFile, JSON.stringify({
    "worker:sogyo:v1": {
      keyid: "worker:sogyo:v1",
      workerId: "sogyo",
      publicKeyJwk: testPublicJwk,
      roles: ["analyst", "researcher", "analyst"],
    },
  }));
  assert.deepEqual(loadA2AHttpSignatureKeyRegistryFile(validFile)["worker:sogyo:v1"].roles, [
    "analyst",
    "researcher",
  ]);

  const unknownRole = join(dir, "unknown-role.json");
  writeFileSync(unknownRole, JSON.stringify({
    "worker:sogyo:v1": { keyid: "worker:sogyo:v1", workerId: "sogyo", publicKeyJwk: testPublicJwk, roles: ["overlord"] },
  }));
  assert.throws(() => loadA2AHttpSignatureKeyRegistryFile(unknownRole), /unknown role/);

  const emptyRoles = join(dir, "empty-roles.json");
  writeFileSync(emptyRoles, JSON.stringify({
    "worker:sogyo:v1": { keyid: "worker:sogyo:v1", workerId: "sogyo", publicKeyJwk: testPublicJwk, roles: [] },
  }));
  assert.throws(() => loadA2AHttpSignatureKeyRegistryFile(emptyRoles), /roles must be a non-empty array/);
});

test("A2A HTTP Signature verifier binds the signed role to the key's allowed roles (#691)", () => {
  const now = 1770861630; // within the fixture window
  // The fixture signs x-a2a-requester-role: "analyst".
  const request = makeSignedA2ARequest();

  const denied = verifyA2AHttpSignature(
    request,
    { "worker:sogyo:v1": { ...a2aKeyRegistry["worker:sogyo:v1"], roles: ["operator"] } },
    { nowEpochSeconds: now },
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.ok === false && denied.code, "a2a_signature_role_denied");

  const allowed = verifyA2AHttpSignature(
    request,
    { "worker:sogyo:v1": { ...a2aKeyRegistry["worker:sogyo:v1"], roles: ["analyst"] } },
    { nowEpochSeconds: now },
  );
  assert.equal(allowed.ok, true);

  // No declared roles => no role restriction (legacy compatibility).
  const unrestricted = verifyA2AHttpSignature(request, a2aKeyRegistry, { nowEpochSeconds: now });
  assert.equal(unrestricted.ok, true);
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

// ── Replay protection (nonce cache) — TDD: fail before implementation (#917) ──

test("InMemoryNonceCache records a never-seen nonce as new and allows a first signature through", () => {
  const cache = new InMemoryNonceCache(/* maxNonces */ 1000);
  // A fresh nonce should not be in the cache.
  assert.equal(cache.has("nonce-fresh-1"), false);
  // Recording it should succeed.
  assert.equal(cache.record("nonce-fresh-1", 1770862000), true);
  // Now it should be seen.
  assert.equal(cache.has("nonce-fresh-1"), true);
});

test("InMemoryNonceCache rejects a duplicate nonce (replay attack)", () => {
  const cache = new InMemoryNonceCache(1000);
  const nonce = "nonce-replay-target";
  // First use succeeds.
  assert.equal(cache.record(nonce, 1770862000), true);
  // Second use with the same nonce and same expiry is a replay — must be rejected.
  // In a real replay, the signed request's expiry is identical because the
  // entire signed envelope is replayed, not a new signing with a fresh expiry.
  assert.equal(cache.record(nonce, 1770862000), false);
});

test("InMemoryNonceCache rejects the same nonce with a later expiry until the old entry is pruned", () => {
  const cache = new InMemoryNonceCache(1000);
  const nonce = "nonce-expiry-check";
  // Record with expiry at epoch 1000.
  assert.equal(cache.record(nonce, 1000), true);
  // Reusing the nonce with a later expiry before the old entry is pruned is still
  // a replay/nonce-reuse hazard. The caller must prune by current time first.
  assert.equal(cache.record(nonce, 2000), false);
  cache.prune(1001);
  assert.equal(cache.record(nonce, 2000), true);
});

test("InMemoryNonceCache allows two distinct nonces from the same worker", () => {
  const cache = new InMemoryNonceCache(1000);
  assert.equal(cache.record("nonce-a", 1770862000), true);
  assert.equal(cache.record("nonce-b", 1770862000), true);
  // Both should be tracked.
  assert.equal(cache.has("nonce-a"), true);
  assert.equal(cache.has("nonce-b"), true);
});

test("A2A HTTP Signature verifier rejects a replayed nonce when nonce cache is provided (#917)", () => {
  const now = 1770861630;
  const cache = new InMemoryNonceCache(1000);
  const request = makeSignedA2ARequest();
  // The fixture nonce is "nonce-test-1".

  // First verification: nonce is new, should pass.
  const first = verifyA2AHttpSignature(request, a2aKeyRegistry, { nowEpochSeconds: now, nonceCache: cache });
  assert.equal(first.ok, true);
  assert.equal(cache.has("nonce-test-1"), true);

  // Second verification of the same signed request: nonce is a replay, should fail.
  const replay = verifyA2AHttpSignature(request, a2aKeyRegistry, { nowEpochSeconds: now + 1, nonceCache: cache });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, "a2a_signature_replay_detected");
});

test("A2A HTTP Signature verifier allows distinct nonces from the same key when nonce cache is provided", () => {
  const now = 1770861630;
  const cache = new InMemoryNonceCache(1000);

  // Request 1 with nonce "nonce-1"
  const req1 = makeSignedA2ARequest({
    signatureInput: signedRequestBase.signatureInput.replace('nonce="nonce-test-1"', 'nonce="nonce-1"'),
  });
  const r1 = verifyA2AHttpSignature(req1, a2aKeyRegistry, { nowEpochSeconds: now, nonceCache: cache });
  assert.equal(r1.ok, true);

  // Request 2 with nonce "nonce-2" — different nonce, same key, should pass.
  const req2 = makeSignedA2ARequest({
    signatureInput: signedRequestBase.signatureInput.replace('nonce="nonce-test-1"', 'nonce="nonce-2"'),
  });
  const r2 = verifyA2AHttpSignature(req2, a2aKeyRegistry, { nowEpochSeconds: now + 1, nonceCache: cache });
  assert.equal(r2.ok, true);
});

test("A2A HTTP Signature verifier nonce check is not applied when no nonce cache is provided (backward compatible)", () => {
  // Existing behavior: no nonce cache = no replay check.
  const result = verifyA2AHttpSignature(makeSignedA2ARequest(), a2aKeyRegistry, { nowEpochSeconds: 1770861620 });
  assert.equal(result.ok, true);
  // Verify the same request again without a nonce cache — must still pass.
  const same = verifyA2AHttpSignature(makeSignedA2ARequest(), a2aKeyRegistry, { nowEpochSeconds: 1770861621 });
  assert.equal(same.ok, true);
});

test("InMemoryNonceCache prunes nonces past their expiresAt window", () => {
  const cache = new InMemoryNonceCache(1000);
  // Record a nonce with expiry at epoch 1000.
  assert.equal(cache.record("stale-nonce", 1000), true);
  // Before expiry, it's still tracked.
  assert.equal(cache.has("stale-nonce"), true);
  // Prune with a cutoff that should remove the stale entry.
  cache.prune(1001);
  // After pruning past its expiry, it should be gone.
  assert.equal(cache.has("stale-nonce"), false);
});

test("InMemoryNonceCache bounds memory under a flood of distinct nonces", () => {
  const cache = new InMemoryNonceCache(/* maxNonces */ 500);
  const now = 1_000_000;
  // Record far more distinct nonces than the cap.
  for (let i = 0; i < 5000; i++) {
    cache.record(`nonce-flood-${i}`, now + 1000);
  }
  // The internal map must stay bounded at or near the configured maximum.
  assert.ok(
    cache.size() <= 500,
    `NonceCache must stay bounded under a nonce flood, got size ${cache.size()}`,
  );
});
