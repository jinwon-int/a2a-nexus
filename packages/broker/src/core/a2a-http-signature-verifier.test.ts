import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildA2AHttpSignatureBase,
  verifyA2AHttpSignature,
  type A2AHttpSignatureRequest,
  type A2AWorkerKeyRecord,
} from "./a2a-http-signature-verifier.js";

const syntheticPublicJwk = {
  kty: "OKP",
  crv: "Ed25519",
  x: "0pdecEuEwxKSZNPLm3rQk3wU6YQrTYg8-WWf0LB-2k4",
} as const;

const fixedBody = Buffer.from('{"taskId":"task-1","workerId":"sogyo"}');
const fixedCreated = 1_770_861_600;
const fixedExpires = 1_770_861_660;
const fixedNonce = "nonce-20260614-0001";
const fixedSignature = "xq/0yoxGTf73BsQphIONxkgHN9AnvmFfbi/CvmT0j5EY8b7dw76z1+cBrrQQjZML9QPt2nI31iH6iQs/JR3oCA==";
const fixedSignatureInput = `a2a=("@method" "@authority" "@path" "@query" "content-digest" "x-a2a-requester-id" "x-a2a-requester-role" "x-a2a-broker-id");alg="ed25519";keyid="worker:sogyo:v1";created=${fixedCreated};expires=${fixedExpires};nonce="${fixedNonce}";tag="a2a-worker-v1"`;

function contentDigest(body = fixedBody): string {
  return `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;
}

const keyRecord: A2AWorkerKeyRecord = {
  keyid: "worker:sogyo:v1",
  workerId: "sogyo",
  requesterId: "sogyo",
  alg: "ed25519",
  publicKeyJwk: syntheticPublicJwk,
  status: "active",
};

function unsignedRequest(overrides: Partial<A2AHttpSignatureRequest> = {}): A2AHttpSignatureRequest {
  return {
    method: "POST",
    authority: "broker.seoyoon-family.com",
    path: "/tasks/task-1/claim",
    query: "assignedWorkerId=sogyo&status=queued",
    headers: {
      "content-digest": contentDigest(),
      "x-a2a-requester-id": "sogyo",
      "x-a2a-requester-role": "analyst",
      "x-a2a-broker-id": "seoseo",
    },
    signatureInput: fixedSignatureInput,
    signature: "",
    expectedWorkerId: "sogyo",
    expectedRequesterId: "sogyo",
    keyRegistry: [keyRecord],
    nowEpochSeconds: fixedCreated + 10,
    clockSkewSeconds: 60,
    ...overrides,
  };
}

function validRequest(overrides: Partial<A2AHttpSignatureRequest> = {}): A2AHttpSignatureRequest {
  const request = unsignedRequest(overrides);
  return { ...request, signature: `a2a=:${fixedSignature}:` };
}

test("A2A HTTP signature verifier accepts the fixed valid Ed25519 vector", () => {
  const request = validRequest();
  const result = verifyA2AHttpSignature(request);

  assert.deepEqual(result, {
    ok: true,
    keyid: "worker:sogyo:v1",
    workerId: "sogyo",
    requesterId: "sogyo",
    created: fixedCreated,
    expires: fixedExpires,
    nonce: fixedNonce,
  });
});

test("A2A HTTP signature verifier builds the fixed RFC 9421-style signing base", () => {
  assert.equal(
    buildA2AHttpSignatureBase(unsignedRequest()),
    [
      '"@method": POST',
      '"@authority": broker.seoyoon-family.com',
      '"@path": /tasks/task-1/claim',
      '"@query": ?assignedWorkerId=sogyo&status=queued',
      `"content-digest": ${contentDigest()}`,
      '"x-a2a-requester-id": sogyo',
      '"x-a2a-requester-role": analyst',
      '"x-a2a-broker-id": seoseo',
      `"@signature-params": (${[
        '"@method"',
        '"@authority"',
        '"@path"',
        '"@query"',
        '"content-digest"',
        '"x-a2a-requester-id"',
        '"x-a2a-requester-role"',
        '"x-a2a-broker-id"',
      ].join(" ")});alg="ed25519";keyid="worker:sogyo:v1";created=${fixedCreated};expires=${fixedExpires};nonce="${fixedNonce}";tag="a2a-worker-v1"`,
    ].join("\n"),
  );
});

test("A2A HTTP signature verifier fails closed when covered request components mutate", () => {
  const valid = validRequest();

  const mutations: Array<[string, Partial<A2AHttpSignatureRequest>, ReturnType<typeof verifyA2AHttpSignature>]> = [
    ["method", { method: "GET" }, { ok: false, code: "signature_invalid" }],
    ["path", { path: "/tasks/task-1/start" }, { ok: false, code: "signature_invalid" }],
    ["query", { query: "assignedWorkerId=bangtong&status=queued" }, { ok: false, code: "signature_invalid" }],
    [
      "content-digest",
      { headers: { ...valid.headers, "content-digest": contentDigest(Buffer.from("tampered")) } },
      { ok: false, code: "signature_invalid" },
    ],
    ["requester", { headers: { ...valid.headers, "x-a2a-requester-id": "bangtong" } }, { ok: false, code: "identity_mismatch" }],
    ["broker", { headers: { ...valid.headers, "x-a2a-broker-id": "gwakga" } }, { ok: false, code: "signature_invalid" }],
  ];

  for (const [name, mutation, expected] of mutations) {
    const result = verifyA2AHttpSignature({ ...valid, ...mutation });
    assert.deepEqual(result, expected, name);
  }
});

test("A2A HTTP signature verifier fails closed for unknown keys and identity mismatch", () => {
  assert.deepEqual(
    verifyA2AHttpSignature(validRequest({ keyRegistry: [] })),
    { ok: false, code: "unknown_key" },
  );

  assert.deepEqual(
    verifyA2AHttpSignature(validRequest({ expectedWorkerId: "bangtong" })),
    { ok: false, code: "identity_mismatch" },
  );

  assert.deepEqual(
    verifyA2AHttpSignature(validRequest({ expectedRequesterId: "bangtong" })),
    { ok: false, code: "identity_mismatch" },
  );
});

test("A2A HTTP signature verifier fails closed for expired or future-created vectors", () => {
  assert.deepEqual(
    verifyA2AHttpSignature(validRequest({ nowEpochSeconds: fixedExpires + 61 })),
    { ok: false, code: "time_invalid" },
  );

  assert.deepEqual(
    verifyA2AHttpSignature(validRequest({ nowEpochSeconds: fixedCreated - 61 })),
    { ok: false, code: "time_invalid" },
  );
});

test("A2A HTTP signature verifier rejects unsupported algorithm, tag, and malformed headers", () => {
  assert.deepEqual(
    verifyA2AHttpSignature(validRequest({ signatureInput: fixedSignatureInput.replace('alg="ed25519"', 'alg="rsa-pss-sha512"') })),
    { ok: false, code: "unsupported_alg" },
  );

  assert.deepEqual(
    verifyA2AHttpSignature(validRequest({ signatureInput: fixedSignatureInput.replace('tag="a2a-worker-v1"', 'tag="other"') })),
    { ok: false, code: "unsupported_tag" },
  );

  const malformed = validRequest();
  assert.deepEqual(
    verifyA2AHttpSignature({ ...malformed, signature: "a2a=not-base64" }),
    { ok: false, code: "malformed_signature" },
  );
});

test("A2A HTTP signature verifier rejects component-list drift before route integration", () => {
  const request = validRequest({
    signatureInput: fixedSignatureInput.replace(' "x-a2a-broker-id"', ""),
  });

  assert.deepEqual(verifyA2AHttpSignature(request), {
    ok: false,
    code: "component_mismatch",
  });
});
