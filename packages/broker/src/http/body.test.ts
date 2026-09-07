/**
 * Request-body reader contract. A request stream can only be consumed once, so
 * the reader caches the in-flight read rather than its result: two callers
 * racing on one IncomingMessage (A2A signature verification and the route
 * handler, say) must share a single read instead of letting the second drain an
 * already-consumed stream and cache an empty body over the real one.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

import { MAX_REQUEST_BODY_BYTES, readJson, readRawBody } from "./body.js";
import { BrokerError } from "../core/broker.js";

/** A minimal IncomingMessage stand-in: the reader only iterates the stream. */
function fakeRequest(chunks: Array<Buffer | string>): IncomingMessage {
  return Readable.from(chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))) as unknown as IncomingMessage;
}

test("readRawBody concatenates the request stream", async () => {
  const req = fakeRequest(["{\"a\":", "1}"]);
  assert.equal((await readRawBody(req)).toString("utf8"), '{"a":1}');
});

test("concurrent readRawBody callers share one read of the stream", async () => {
  const req = fakeRequest(["hello ", "world"]);
  // Both callers start before either resolves — the racing case the cache
  // exists for. Caching the resolved Buffer alone let the second caller
  // iterate a drained stream and observe an empty body.
  const [first, second] = await Promise.all([readRawBody(req), readRawBody(req)]);
  assert.equal(first.toString("utf8"), "hello world");
  assert.equal(second.toString("utf8"), "hello world");
});

test("a sequential second read replays the cached body", async () => {
  const req = fakeRequest(["payload"]);
  assert.equal((await readRawBody(req)).toString("utf8"), "payload");
  assert.equal((await readRawBody(req)).toString("utf8"), "payload");
});

test("readJson reuses the raw-body cache rather than re-reading the stream", async () => {
  const req = fakeRequest(['{"intent":"analyze"}']);
  assert.equal((await readRawBody(req)).toString("utf8"), '{"intent":"analyze"}');
  assert.deepEqual(await readJson(req), { intent: "analyze" });
});

test("readJson returns null for an empty body and rejects malformed JSON", async () => {
  assert.equal(await readJson(fakeRequest([])), null);
  await assert.rejects(
    () => readJson(fakeRequest(["{not json"])),
    (error: unknown) => error instanceof BrokerError && /invalid JSON body/.test(error.message),
  );
});

test("an over-cap body is rejected, and every caller sees the same rejection", async () => {
  const req = fakeRequest([Buffer.alloc(MAX_REQUEST_BODY_BYTES + 1)]);
  const results = await Promise.allSettled([readRawBody(req), readRawBody(req)]);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    const reason: unknown = (result as PromiseRejectedResult).reason;
    assert.ok(reason instanceof BrokerError, "over-cap bodies fail as a BrokerError");
    assert.match(reason.message, /request body exceeds/);
  }
});
