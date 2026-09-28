import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";

import { resolveSseCorsOrigin, writeSseEvent, writeSseResponseHeaders } from "./sse.js";

function createResponseDouble(origin?: string): {
  res: ServerResponse<IncomingMessage>;
  writes: string[];
  statusCode: number | null;
  headers: Record<string, string> | null;
  flushed: boolean;
  setWritableEnded(value: boolean): void;
} {
  const writes: string[] = [];
  let statusCode: number | null = null;
  let headers: Record<string, string> | null = null;
  let flushed = false;
  let writableEnded = false;

  const res = {
    req: { headers: origin === undefined ? {} : { origin } },
    get writableEnded() {
      return writableEnded;
    },
    writeHead(code: number, nextHeaders: Record<string, string>) {
      statusCode = code;
      headers = nextHeaders;
      return res;
    },
    flushHeaders() {
      flushed = true;
    },
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
  } as unknown as ServerResponse<IncomingMessage>;

  return {
    res,
    writes,
    get statusCode() {
      return statusCode;
    },
    get headers() {
      return headers;
    },
    get flushed() {
      return flushed;
    },
    setWritableEnded(value: boolean) {
      writableEnded = value;
    },
  };
}

test("SSE response helper writes event-stream headers and retry advisory (#788)", () => {
  const response = createResponseDouble();

  writeSseResponseHeaders(response.res);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.headers, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  assert.equal(response.flushed, true);
  assert.deepEqual(response.writes, ["retry: 3000\n\n"]);
});

test("#2256 A5 SSE sends no CORS headers by default and never advertises the edge secret", () => {
  const previous = process.env.A2A_SSE_ALLOWED_ORIGINS;
  delete process.env.A2A_SSE_ALLOWED_ORIGINS;
  try {
    const response = createResponseDouble("https://evil.example");
    writeSseResponseHeaders(response.res);
    const headers = response.headers ?? {};
    assert.equal(headers["access-control-allow-origin"], undefined);
    assert.equal(JSON.stringify(headers).includes("x-a2a-edge-secret"), false);
  } finally {
    if (previous === undefined) delete process.env.A2A_SSE_ALLOWED_ORIGINS;
    else process.env.A2A_SSE_ALLOWED_ORIGINS = previous;
  }
});

test("#2256 A5 SSE echoes only an allowlisted origin, with Vary: Origin", () => {
  const previous = process.env.A2A_SSE_ALLOWED_ORIGINS;
  process.env.A2A_SSE_ALLOWED_ORIGINS = "https://dash.example, https://ops.example";
  try {
    const allowed = createResponseDouble("https://ops.example");
    writeSseResponseHeaders(allowed.res);
    assert.equal(allowed.headers?.["access-control-allow-origin"], "https://ops.example");
    assert.equal(allowed.headers?.vary, "Origin");
    assert.equal(allowed.headers?.["access-control-allow-headers"], "Last-Event-ID");

    const denied = createResponseDouble("https://evil.example");
    writeSseResponseHeaders(denied.res);
    assert.equal(denied.headers?.["access-control-allow-origin"], undefined);
  } finally {
    if (previous === undefined) delete process.env.A2A_SSE_ALLOWED_ORIGINS;
    else process.env.A2A_SSE_ALLOWED_ORIGINS = previous;
  }
  assert.equal(resolveSseCorsOrigin("https://a.example", "https://a.example"), "https://a.example");
  assert.equal(resolveSseCorsOrigin("https://a.example.evil", "https://a.example"), undefined, "exact match only");
  assert.equal(resolveSseCorsOrigin("null", "null"), undefined, "opaque origins are never allowed");
  assert.equal(resolveSseCorsOrigin(undefined, "https://a.example"), undefined);
  assert.equal(resolveSseCorsOrigin("https://a.example", undefined), undefined);
});

test("SSE event helper serializes optional id, event name, and JSON data (#788)", () => {
  const response = createResponseDouble();

  writeSseEvent(response.res, "task-terminal", { taskId: "task-1", final: true }, "task-1:7");

  // One write per frame (id/event/data concatenated) keeps syscalls down.
  assert.deepEqual(response.writes, [
    'id: task-1:7\nevent: task-terminal\ndata: {"taskId":"task-1","final":true}\n\n',
  ]);
});

test("SSE event helper omits the id line when no id is given (#788)", () => {
  const response = createResponseDouble();

  writeSseEvent(response.res, "task-status", { taskId: "task-2" });

  assert.deepEqual(response.writes, [
    'event: task-status\ndata: {"taskId":"task-2"}\n\n',
  ]);
});

test("SSE event helper skips writes after the response has ended (#788)", () => {
  const response = createResponseDouble();
  response.setWritableEnded(true);

  writeSseEvent(response.res, "ignored", { ok: false }, "ignored:1");

  assert.deepEqual(response.writes, []);
});
