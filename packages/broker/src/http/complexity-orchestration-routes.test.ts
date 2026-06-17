import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import { BrokerError } from "../core/broker.js";
import { handleComplexityOrchestrationRoutesIfMatched } from "./complexity-orchestration-routes.js";

class CapturingResponse extends EventEmitter {
  statusCode?: number;
  headers?: Record<string, string | number>;
  body = "";

  writeHead(statusCode: number, headers: Record<string, string | number>): this {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  end(chunk?: string): this {
    if (chunk) this.body += chunk;
    return this;
  }
}

function jsonReq(body: unknown): IncomingMessage {
  return Readable.from([JSON.stringify(body)]) as IncomingMessage;
}

async function route(method: string, path: string, body: unknown, options: { enforceRequesterIdentity?: boolean } = {}) {
  const res = new CapturingResponse();
  const handled = await handleComplexityOrchestrationRoutesIfMatched({
    method,
    path,
    req: jsonReq(body),
    res: res as unknown as ServerResponse,
    enforceRequesterIdentity: options.enforceRequesterIdentity ?? false,
    requesterIdentity: null,
  });
  return { handled, res, json: res.body ? JSON.parse(res.body) : undefined };
}

test("complexity orchestration route helper handles the three stateless POST routes (#848)", async () => {
  const subagent = await route("POST", "/workers/subagent-orchestration/plan", {
    task: { taskId: "task-1", size: "small", coupling: "low" },
    host: { workerId: "worker-a", cpuLoadPct: 10, memoryUsedPct: 20 },
  });
  assert.equal(subagent.handled, true);
  assert.equal(subagent.res.statusCode, 200);
  assert.equal(subagent.res.headers?.["cache-control"], "no-store");
  assert.equal(typeof subagent.json.kind, "string");

  const recommendation = await route("POST", "/complexity-orchestration/recommendation", {
    intent: "analyze",
    targetEnvironment: "source-only",
    referenceCount: 2,
    artifactCount: 0,
    turnCount: 1,
  });
  assert.equal(recommendation.handled, true);
  assert.equal(recommendation.res.statusCode, 200);
  assert.equal(recommendation.res.headers?.["cache-control"], "no-store");
  assert.equal(recommendation.json.kind, "a2a-broker.complexity-orchestration-recommendation-packet");

  const draft = await route("POST", "/complexity-execution-plan/draft", recommendation.json);
  assert.equal(draft.handled, true);
  assert.equal(draft.res.statusCode, 200);
  assert.equal(draft.res.headers?.["cache-control"], "no-store");
  assert.equal(typeof draft.json.kind, "string");
});

test("complexity orchestration route helper preserves bad-request validation (#848)", async () => {
  await assert.rejects(
    () => route("POST", "/complexity-orchestration/recommendation", { referenceCount: 1 }),
    (error) => error instanceof BrokerError && error.code === "bad_request" && /intent/.test(error.message),
  );
});

test("complexity orchestration route helper returns false for non-matching routes (#848)", async () => {
  const res = new CapturingResponse();
  const handled = await handleComplexityOrchestrationRoutesIfMatched({
    method: "GET",
    path: "/complexity-orchestration/recommendation",
    req: jsonReq({}),
    res: res as unknown as ServerResponse,
    enforceRequesterIdentity: false,
    requesterIdentity: null,
  });

  assert.equal(handled, false);
  assert.equal(res.statusCode, undefined);
  assert.equal(res.body, "");
});
