import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import { InMemoryA2ABroker } from "../core/broker.js";
import type { BrokerStateStore } from "../core/store.js";
import type { CreateProposalRequest } from "../core/types.js";
import { handleProposalsWriteRouteIfMatched } from "./proposals-write-routes.js";

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

function ackingStore() {
  let ackCount = 0;
  return {
    get ackCount() {
      return ackCount;
    },
    store: {
      load() {
        throw new Error("load should not be called by proposal write route helper");
      },
      save() {
        throw new Error("save should not be called by proposal write route helper");
      },
      async awaitDurablePersistenceAck() {
        ackCount += 1;
      },
    } as BrokerStateStore,
  };
}

async function routeCtx(
  method: string,
  path: string,
  broker: InMemoryA2ABroker,
  req: IncomingMessage,
  stateStore: BrokerStateStore,
  res = new CapturingResponse(),
) {
  return {
    handled: await handleProposalsWriteRouteIfMatched({
      method,
      path,
      segments: path.split("/").filter(Boolean),
      req,
      res: res as unknown as ServerResponse,
      broker,
      stateStore,
      enforceRequesterIdentity: false,
      requesterIdentity: null,
    }),
    res,
  };
}

function proposalBody(suffix = "a"): CreateProposalRequest {
  return {
    source: { id: `research-${suffix}`, kind: "node", role: "researcher" },
    target: { id: `live-${suffix}`, kind: "node", role: "live-trader" },
    kind: "patch",
    summary: `tighten threshold ${suffix}`,
    workspace: { nodeId: `live-${suffix}`, workspaceId: `ws-live-${suffix}` },
    patchText: "diff --git a/config.ts b/config.ts",
  };
}

test("proposal write route helper handles mutation routes and awaits durable ack (#1103)", async () => {
  const broker = new InMemoryA2ABroker();

  const createStore = ackingStore();
  const create = await routeCtx("POST", "/proposals", broker, jsonReq(proposalBody("a")), createStore.store);
  assert.equal(create.handled, true);
  assert.equal(create.res.statusCode, 201);
  assert.equal(createStore.ackCount, 1);
  const proposal = JSON.parse(create.res.body);

  const artifactStore = ackingStore();
  const artifact = await routeCtx("POST", `/proposals/${proposal.id}/artifacts`, broker, jsonReq({
    kind: "patch",
    uri: "file:///tmp/proposal.diff",
    summary: "attached patch",
  }), artifactStore.store);
  assert.equal(artifact.handled, true);
  assert.equal(artifact.res.statusCode, 201);
  assert.equal(artifactStore.ackCount, 1);

  const validationStore = ackingStore();
  const validation = await routeCtx("POST", `/proposals/${proposal.id}/validate`, broker, jsonReq({
    nodeId: "live-a",
    kind: "smoke",
    verdict: "pass",
    note: "validated",
  }), validationStore.store);
  assert.equal(validation.handled, true);
  assert.equal(validation.res.statusCode, 201);
  assert.equal(validationStore.ackCount, 1);

  const approveStore = ackingStore();
  const approve = await routeCtx("POST", `/proposals/${proposal.id}/approve`, broker, jsonReq({
    actor: { id: "live-a", kind: "node", role: "live-trader" },
    note: "approved by target",
  }), approveStore.store);
  assert.equal(approve.handled, true);
  assert.equal(approve.res.statusCode, 200);
  assert.equal(approveStore.ackCount, 1);
  assert.equal(JSON.parse(approve.res.body).status, "approved");

  const applyStore = ackingStore();
  const apply = await routeCtx("POST", `/proposals/${proposal.id}/apply`, broker, jsonReq({
    actor: { id: "live-a", kind: "node", role: "live-trader" },
    workspace: { nodeId: "live-a", workspaceId: "ws-live-a" },
    note: "applied by target",
  }), applyStore.store);
  assert.equal(apply.handled, true);
  assert.equal(apply.res.statusCode, 200);
  assert.equal(applyStore.ackCount, 1);
  assert.equal(JSON.parse(apply.res.body).status, "applied");

  const rejectedProposal = broker.createProposal(proposalBody("b"));
  const rejectStore = ackingStore();
  const reject = await routeCtx("POST", `/proposals/${rejectedProposal.id}/reject`, broker, jsonReq({
    actor: { id: "live-b", kind: "node", role: "live-trader" },
    note: "rejected by target",
  }), rejectStore.store);
  assert.equal(reject.handled, true);
  assert.equal(reject.res.statusCode, 200);
  assert.equal(rejectStore.ackCount, 1);
  assert.equal(JSON.parse(reject.res.body).status, "rejected");
});

test("proposal write route helper returns false for non-proposal write routes (#1103)", async () => {
  const broker = new InMemoryA2ABroker();
  const store = ackingStore();
  const res = new CapturingResponse();

  const handled = await handleProposalsWriteRouteIfMatched({
    method: "GET",
    path: "/proposals",
    segments: ["proposals"],
    req: jsonReq({}),
    res: res as unknown as ServerResponse,
    broker,
    stateStore: store.store,
    enforceRequesterIdentity: false,
    requesterIdentity: null,
  });

  assert.equal(handled, false);
  assert.equal(res.statusCode, undefined);
  assert.equal(res.body, "");
  assert.equal(store.ackCount, 0);
});
