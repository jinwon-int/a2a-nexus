import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";

import { writeSseEvent, writeSseResponseHeaders } from "./sse.js";

function createResponseDouble(): {
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
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "Last-Event-ID, x-a2a-requester-id, x-a2a-edge-secret",
  });
  assert.equal(response.flushed, true);
  assert.deepEqual(response.writes, ["retry: 3000\n\n"]);
});

test("SSE event helper serializes optional id, event name, and JSON data (#788)", () => {
  const response = createResponseDouble();

  writeSseEvent(response.res, "task-terminal", { taskId: "task-1", final: true }, "task-1:7");

  assert.deepEqual(response.writes, [
    "id: task-1:7\n",
    "event: task-terminal\n",
    'data: {"taskId":"task-1","final":true}\n\n',
  ]);
});

test("SSE event helper skips writes after the response has ended (#788)", () => {
  const response = createResponseDouble();
  response.setWritableEnded(true);

  writeSseEvent(response.res, "ignored", { ok: false }, "ignored:1");

  assert.deepEqual(response.writes, []);
});
