import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";

import {
  attachSseConnectionCleanup,
  parseSseReplayAfterId,
  startSseHeartbeat,
} from "./sse-stream-lifecycle.js";

test("parseSseReplayAfterId normalizes numeric Last-Event-ID headers (#793)", () => {
  assert.equal(parseSseReplayAfterId(undefined), -1);
  assert.equal(parseSseReplayAfterId(""), -1);
  assert.equal(parseSseReplayAfterId("0"), 0);
  assert.equal(parseSseReplayAfterId("42"), 42);
  assert.equal(parseSseReplayAfterId("-1"), -1);
  assert.equal(parseSseReplayAfterId("NaN"), -1);
  assert.equal(parseSseReplayAfterId("abc"), -1);
  assert.equal(parseSseReplayAfterId(undefined, 7), 7);
});

test("attachSseConnectionCleanup cleans up and ends open responses on close (#793)", () => {
  const req = new EventEmitter() as IncomingMessage;
  let cleanupCalls = 0;
  let ended = false;
  const res = {
    get writableEnded() {
      return ended;
    },
    end() {
      ended = true;
      return res;
    },
  } as unknown as ServerResponse<IncomingMessage>;

  attachSseConnectionCleanup(req, res, () => {
    cleanupCalls += 1;
  });
  req.emit("close");

  assert.equal(cleanupCalls, 1);
  assert.equal(ended, true);
});

test("attachSseConnectionCleanup can leave response ending to the caller (#793)", () => {
  const req = new EventEmitter() as IncomingMessage;
  let cleanupCalls = 0;
  let ended = false;
  const res = {
    get writableEnded() {
      return ended;
    },
    end() {
      ended = true;
      return res;
    },
  } as unknown as ServerResponse<IncomingMessage>;

  attachSseConnectionCleanup(req, res, () => {
    cleanupCalls += 1;
  }, { endResponseOnClose: false });
  req.emit("close");

  assert.equal(cleanupCalls, 1);
  assert.equal(ended, false);
});

test("attachSseConnectionCleanup cleans up on request errors without ending response (#793)", () => {
  const req = new EventEmitter() as IncomingMessage;
  let cleanupCalls = 0;
  let ended = false;
  const res = {
    get writableEnded() {
      return ended;
    },
    end() {
      ended = true;
      return res;
    },
  } as unknown as ServerResponse<IncomingMessage>;

  attachSseConnectionCleanup(req, res, () => {
    cleanupCalls += 1;
  });
  req.emit("error", new Error("boom"));

  assert.equal(cleanupCalls, 1);
  assert.equal(ended, false);
});

test("startSseHeartbeat is disabled for non-positive intervals (#793)", () => {
  const res = {
    writableEnded: false,
    write() {
      throw new Error("heartbeat should not write while disabled");
    },
  } as unknown as ServerResponse<IncomingMessage>;
  let cleanupCalls = 0;

  const stop = startSseHeartbeat(res, 0, () => {
    cleanupCalls += 1;
  });
  stop();

  assert.equal(cleanupCalls, 0);
});

test("startSseHeartbeat cleanup is idempotent (#793)", () => {
  const res = {
    writableEnded: false,
    write() {
      return true;
    },
  } as unknown as ServerResponse<IncomingMessage>;

  const stop = startSseHeartbeat(res, 60_000, () => undefined);

  assert.doesNotThrow(() => {
    stop();
    stop();
  });
});
