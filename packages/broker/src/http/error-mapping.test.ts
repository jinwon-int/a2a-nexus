/**
 * HTTP error-surface mapping coverage.
 *
 * Regression origin: `statusCodeFor` used to `throw` on an unmapped
 * BrokerErrorCode. Its only caller, `sendError`, runs inside the request
 * handler's `catch` block, and the handler is `async` — so the throw rejected
 * the handler promise instead of propagating. Node never wrote a response, the
 * client hung until its own timeout, and the broker logged nothing but an
 * `unhandledRejection`. `review_author_conflict` (added for #1518, routed from
 * #1725 finding 3) was unmapped and reachable from `POST /tasks`, so the guard
 * meant to save a wasted provider call instead hung the dispatcher.
 *
 * @see jinwon-int/a2a-nexus#1518
 * @see jinwon-int/a2a-nexus#1725
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BROKER_ERROR_CODES, BrokerError } from "../core/broker-error.js";
import { statusCodeFor, sendError } from "./error-mapping.js";

// Minimal ServerResponse stand-in: records what sendError writes.
function fakeResponse() {
  const recorded: { status?: number; body?: string; headers: Record<string, unknown> } = { headers: {} };
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader(name: string, value: unknown) {
      recorded.headers[name.toLowerCase()] = value;
    },
    writeHead(status: number, headers?: Record<string, unknown>) {
      recorded.status = status;
      Object.assign(recorded.headers, headers ?? {});
      return res;
    },
    end(chunk?: unknown) {
      if (typeof chunk === "string") recorded.body = chunk;
      return res;
    },
  };
  return { res, recorded };
}

test("statusCodeFor maps every BrokerErrorCode without throwing (#1518/#1725)", () => {
  const unmapped: string[] = [];
  for (const code of BROKER_ERROR_CODES) {
    let status: number | undefined;
    assert.doesNotThrow(() => {
      status = statusCodeFor(code);
    }, `statusCodeFor("${code}") must never throw — sendError calls it from inside an async catch block`);
    if (typeof status !== "number" || status < 100 || status > 599) {
      unmapped.push(code);
    }
  }
  assert.deepEqual(unmapped, [], "every broker error code must map to a valid HTTP status");
});

test("statusCodeFor returns 500 rather than throwing for an untyped code (#1518/#1725)", () => {
  // Defense in depth for JS callers that bypass the compile-time exhaustiveness
  // check. The contract is "generic 500", never a throw.
  const status = statusCodeFor("not_a_real_broker_code" as never);
  assert.equal(status, 500);
});

test("review_author_conflict maps to 400, matching the other review contract codes (#1518/#1725)", () => {
  assert.equal(statusCodeFor("review_author_conflict"), 400);
  // Sibling codes it must stay consistent with.
  assert.equal(statusCodeFor("review_not_independent"), 400);
  assert.equal(statusCodeFor("review_verdict_failed"), 400);
  assert.equal(statusCodeFor("review_evidence_missing"), 400);
});

test("state-conflict and media-type codes keep distinguishable statuses (#1518/#1725)", () => {
  assert.equal(statusCodeFor("invalid_transition"), 409);
  assert.equal(statusCodeFor("unsupported_operation"), 409);
  assert.equal(statusCodeFor("task_lineage_cycle"), 409);
  assert.equal(statusCodeFor("content_type_not_supported"), 415);
  assert.equal(statusCodeFor("retry_policy_malformed"), 400);
});

test("sendError writes a response for every BrokerErrorCode (#1518/#1725)", () => {
  for (const code of BROKER_ERROR_CODES) {
    const { res, recorded } = fakeResponse();
    assert.doesNotThrow(
      () => sendError(res as never, new BrokerError(code, `synthetic ${code}`)),
      `sendError must write a response for "${code}" instead of throwing`,
    );
    assert.equal(typeof recorded.status, "number", `no status written for "${code}"`);
    const parsed = JSON.parse(recorded.body ?? "{}");
    assert.equal(parsed.error?.code, code, `response body must preserve the broker code for "${code}"`);
  }
});
