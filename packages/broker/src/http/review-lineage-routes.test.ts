import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import { intentHash } from "../review-lifecycle/canonical-json.js";
import type { IntentContractV1 } from "../review-lifecycle/types.js";
import { BrokerError, InMemoryA2ABroker } from "../core/broker.js";
import { handleReviewLineageRoutesIfMatched } from "./review-lineage-routes.js";

class CapturingResponse extends EventEmitter {
  statusCode?: number;
  headers?: Record<string, string | number>;
  body = "";

  writeHead(
    statusCode: number,
    headers: Record<string, string | number>,
  ): this {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  end(chunk?: string): this {
    if (chunk) this.body += chunk;
    return this;
  }
}

function contract(): IntentContractV1 {
  const value: IntentContractV1 = {
    kind: "IntentContractV1",
    lineageId: "lineage-http-1",
    goal: "Expose public-safe review metrics.",
    nonGoals: ["Do not expose raw contract data."],
    invariants: ["Completion remains unchanged."],
    acceptanceCriteria: [{ id: "AC-1", text: "Read model only." }],
    declaredPaths: { allowed: ["packages/broker/src/**"] },
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    createdAt: "2026-07-23T00:00:00.000Z",
    intentHash: "",
  };
  value.intentHash = intentHash(value as unknown as Record<string, unknown>);
  return value;
}

function makeRouter() {
  const broker = new InMemoryA2ABroker(
    undefined,
    undefined,
    { reviewLineageMode: "record" },
  );
  broker.createReviewLineage({
    contract: contract(),
    at: "2026-07-23T00:00:00.000Z",
    diffHash: "c".repeat(64),
  });

  function route(
    method: string,
    path: string,
    enforce = false,
    identity: unknown = null,
  ) {
    const res = new CapturingResponse();
    const handled = handleReviewLineageRoutesIfMatched({
      method,
      path,
      req: Readable.from([]) as IncomingMessage,
      res: res as unknown as ServerResponse,
      broker,
      enforceRequesterIdentity: enforce,
      requesterIdentity: identity as never,
    });
    return {
      handled,
      res,
      json: res.body ? JSON.parse(res.body) : undefined,
    };
  }
  return { broker, route };
}

test("GET review lineage routes expose only projected operator fields", () => {
  const { route } = makeRouter();

  const list = route("GET", "/review-lineages");
  assert.equal(list.handled, true);
  assert.equal(list.res.statusCode, 200);
  assert.equal(list.json.count, 1);

  const item = route("GET", "/review-lineages/lineage-http-1");
  assert.equal(item.json.lineage.lineageId, "lineage-http-1");
  assert.equal(item.json.lineage.mode, "record");
  assert.equal(item.json.lineage.state, "reviewing_initial");
  assert.equal(item.json.lineage.contract, undefined);
  assert.equal(item.json.lineage.ledger, undefined);
  assert.equal(item.json.lineage.currentDiffHash, undefined);
});

test("GET review lineage routes fail closed for unknown ids and missing roles", () => {
  const { route } = makeRouter();

  assert.throws(
    () => route("GET", "/review-lineages/missing"),
    (error) => error instanceof BrokerError && error.code === "not_found",
  );
  assert.throws(
    () => route("GET", "/review-lineages", true, null),
    (error) => error instanceof BrokerError,
  );
});

test("review lineage routes are read-only and match exact path boundaries", () => {
  const { route } = makeRouter();

  assert.equal(route("POST", "/review-lineages").handled, false);
  assert.equal(route("GET", "/review-lineages/one/events").handled, false);
  assert.equal(route("GET", "/review-lineagesX").handled, false);
});
