import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { IncomingMessage } from "node:http";

import {
  assertA2AContentDigestMatches,
  hasA2AHttpSignatureHeaders,
  headerValue,
  requestHeadersForA2AHttpSignature,
} from "./worker-route-auth.js";

function req(headers: IncomingMessage["headers"]): IncomingMessage {
  return { headers } as IncomingMessage;
}

test("worker route auth helpers normalize single and array headers", () => {
  const request = req({
    "x-a2a-requester-id": " workerbeta ",
    "signature": [" sig1 ", "sig2"],
    "empty": "   ",
  });

  assert.equal(headerValue(request, "x-a2a-requester-id"), "workerbeta");
  assert.equal(headerValue(request, "signature"), "sig1");
  assert.equal(headerValue(request, "empty"), undefined);

  assert.deepEqual(requestHeadersForA2AHttpSignature(request), {
    "x-a2a-requester-id": " workerbeta ",
    signature: " sig1 ",
    empty: "   ",
  });
});

test("worker route auth detects either HTTP Signature header", () => {
  assert.equal(hasA2AHttpSignatureHeaders(req({})), false);
  assert.equal(hasA2AHttpSignatureHeaders(req({ signature: "sig" })), true);
  assert.equal(hasA2AHttpSignatureHeaders(req({ "signature-input": "input" })), true);
});

test("worker route auth content-digest check fails closed", () => {
  const body = Buffer.from('{"ok":true}');
  const digest = `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;

  assert.doesNotThrow(() => assertA2AContentDigestMatches(req({ "content-digest": digest }), body));
  assert.throws(
    () => assertA2AContentDigestMatches(req({}), body),
    /a2a_signature_digest_required/,
  );
  assert.throws(
    () => assertA2AContentDigestMatches(req({ "content-digest": "sha-256=:bad:" }), body),
    /a2a_signature_digest_mismatch/,
  );
});
