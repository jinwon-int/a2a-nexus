import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import test from "node:test";

import { InMemoryA2ABroker } from "../core/broker.js";
import type { BrokerStateStore } from "../core/store.js";
import type { WorkerRecord } from "../core/types.js";
import { handleWorkersReadRouteIfMatched } from "./workers-read.js";

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

function workerRecord(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  const now = new Date().toISOString();
  return {
    nodeId: "worker-1",
    role: "analyst",
    displayName: "Worker 1",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: true,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
      providerCapabilities: [
        { providerId: "xai", modelFamily: "grok", routeKind: "api-key", availability: "configured" },
      ],
    },
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    ...overrides,
  };
}

function routeCtx(path: string, broker: InMemoryA2ABroker, res = new CapturingResponse()) {
  return {
    handled: handleWorkersReadRouteIfMatched({
      method: "GET",
      path,
      segments: path.split("/").filter(Boolean),
      res: res as unknown as ServerResponse,
      url: new URL(`http://broker.test${path}`),
      stateStore: {} as BrokerStateStore,
      broker,
      workerOfflineAfterMs: 60_000,
    }),
    res,
  };
}

test("workers read route helper handles list/capacity/detail routes and redacts provider capability details (#836)", () => {
  const broker = new InMemoryA2ABroker();
  broker.registerWorker(workerRecord());

  const list = routeCtx("/workers", broker);
  assert.equal(list.handled, true);
  assert.equal(list.res.statusCode, 200);
  assert.equal(JSON.stringify(JSON.parse(list.res.body)).includes("xai"), false);
  assert.equal(JSON.parse(list.res.body).items[0].nodeId, "worker-1");

  const capacity = routeCtx("/workers/capacity", broker);
  assert.equal(capacity.handled, true);
  assert.equal(capacity.res.statusCode, 200);
  assert.equal(JSON.parse(capacity.res.body).items[0].nodeId, "worker-1");

  const detail = routeCtx("/workers/worker-1", broker);
  assert.equal(detail.handled, true);
  assert.equal(detail.res.statusCode, 200);
  assert.equal(JSON.parse(detail.res.body).nodeId, "worker-1");
});

test("workers read route helper returns false for non-read worker routes (#836)", () => {
  const broker = new InMemoryA2ABroker();
  const res = new CapturingResponse();

  const handled = handleWorkersReadRouteIfMatched({
    method: "POST",
    path: "/workers/register",
    segments: ["workers", "register"],
    res: res as unknown as ServerResponse,
    url: new URL("http://broker.test/workers/register"),
    stateStore: {} as BrokerStateStore,
    broker,
    workerOfflineAfterMs: 60_000,
  });

  assert.equal(handled, false);
  assert.equal(res.statusCode, undefined);
  assert.equal(res.body, "");
});
