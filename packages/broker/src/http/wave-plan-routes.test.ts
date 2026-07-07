import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import { BrokerError, InMemoryA2ABroker } from "../core/broker.js";
import type { BrokerStateStore } from "../core/store.js";
import { handleWavePlanRoutesIfMatched } from "./wave-plan-routes.js";

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

const noopStore = {} as BrokerStateStore;

function makeRouter() {
  const broker = new InMemoryA2ABroker();
  async function route(method: string, path: string, body: unknown, enforce = false, identity: unknown = null) {
    const res = new CapturingResponse();
    const handled = await handleWavePlanRoutesIfMatched({
      method,
      path,
      req: jsonReq(body),
      res: res as unknown as ServerResponse,
      broker,
      stateStore: noopStore,
      enforceRequesterIdentity: enforce,
      requesterIdentity: identity as never,
    });
    return { handled, res, json: res.body ? JSON.parse(res.body) : undefined };
  }
  return { broker, route };
}

const spec = {
  wavePlanId: "wave-http-1",
  stages: [
    { id: "design", dispatch: { manifestRef: "m-design" }, gate: { type: "quorum", minSubstantive: 2 } },
    { id: "closeout", gate: { type: "approval" } },
  ],
};

test("full lifecycle over HTTP: create -> start -> evidence -> advance -> completed", async () => {
  const { route } = makeRouter();

  const created = await route("POST", "/wave-plans", spec);
  assert.equal(created.handled, true);
  assert.equal(created.res.statusCode, 201);
  assert.equal(created.json.plan.state, "draft");

  assert.equal((await route("POST", "/wave-plans/wave-http-1/start", {})).json.plan.state, "running");

  const evidenced = await route("POST", "/wave-plans/wave-http-1/evidence", { substantiveCount: 2 });
  assert.equal(evidenced.res.statusCode, 200);
  assert.equal(evidenced.json.plan.state, "stage_ready");

  const advanced = await route("POST", "/wave-plans/wave-http-1/advance", {});
  assert.equal(advanced.json.plan.state, "running");
  assert.equal(advanced.json.plan.currentStage, 1);

  await route("POST", "/wave-plans/wave-http-1/evidence", { approvalGranted: true });
  assert.equal((await route("POST", "/wave-plans/wave-http-1/advance", {})).json.plan.state, "completed");
});

test("GET /wave-plans lists and GET /wave-plans/{id} returns one; unknown id is 404", async () => {
  const { route } = makeRouter();
  await route("POST", "/wave-plans", spec);

  const list = await route("GET", "/wave-plans", undefined);
  assert.equal(list.json.kind, "wave-plans");
  assert.equal(list.json.count, 1);

  assert.equal((await route("GET", "/wave-plans/wave-http-1", undefined)).json.plan.wavePlanId, "wave-http-1");

  await assert.rejects(
    () => route("GET", "/wave-plans/missing", undefined),
    (e) => e instanceof BrokerError && e.code === "not_found",
  );
});

test("advancing before the gate is met is a 409 invalid_transition", async () => {
  const { route } = makeRouter();
  await route("POST", "/wave-plans", spec);
  await route("POST", "/wave-plans/wave-http-1/start", {});
  await assert.rejects(
    () => route("POST", "/wave-plans/wave-http-1/advance", {}),
    (e) => e instanceof BrokerError && e.code === "invalid_transition",
  );
});

test("a malformed spec is a 400 bad_request; a duplicate id is a 409", async () => {
  const { route } = makeRouter();
  await assert.rejects(
    () => route("POST", "/wave-plans", { wavePlanId: "x", stages: [] }),
    (e) => e instanceof BrokerError && e.code === "bad_request",
  );
  await route("POST", "/wave-plans", spec);
  await assert.rejects(
    () => route("POST", "/wave-plans", spec),
    (e) => e instanceof BrokerError && e.code === "invalid_transition" && /already exists/.test(e.message),
  );
});

test("mutations require a hub/operator role when identity is enforced", async () => {
  const { route } = makeRouter();
  await assert.rejects(
    () => route("POST", "/wave-plans", spec, true, null),
    (e) => e instanceof BrokerError,
  );
});

test("returns false for non-matching paths and methods", async () => {
  const { route } = makeRouter();
  assert.equal((await route("DELETE", "/wave-plans/wave-http-1", undefined)).handled, false);
  assert.equal((await route("GET", "/wave-plansX", undefined)).handled, false);
});
