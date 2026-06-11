import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";

import {
  assertGitHubWebhookSignature,
  classifyRateLimitBucket,
  extractRequesterIdentity,
  rateLimitKey,
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
