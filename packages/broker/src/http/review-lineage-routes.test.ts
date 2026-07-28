import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import { intentHash } from "../review-lifecycle/canonical-json.js";
import {
  parseReviewLineageObservation,
} from "../review-lifecycle/observation.js";
import type {
  IntentContractV1,
  ReviewLineageBudgetV1,
} from "../review-lifecycle/types.js";
import { BrokerError, InMemoryA2ABroker } from "../core/broker.js";
import { SqliteBrokerStateStore } from "../core/store.js";
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

function budget(): ReviewLineageBudgetV1 {
  return {
    kind: "ReviewLineageBudgetV1",
    maxWallClockSeconds: 21_600,
    maxCorrectionGenerations: 1,
    maxReviewerRuns: 2,
    maxReviewerReplacements: 1,
    repeatedFindingThreshold: 2,
    onExhaustion: "blocked_needs_operator",
  };
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

  async function route(
    method: string,
    path: string,
    enforce = false,
    identity: unknown = null,
    body?: unknown,
  ) {
    const res = new CapturingResponse();
    const req = body === undefined
      ? Readable.from([])
      : Readable.from([JSON.stringify(body)]);
    const handled = await handleReviewLineageRoutesIfMatched({
      method,
      path,
      req: req as IncomingMessage,
      res: res as unknown as ServerResponse,
      url: new URL(path, "https://broker.test"),
      broker,
      enforceRequesterIdentity: enforce,
      requesterIdentity: identity as never,
      assertWorkerHttpSignatureRoute: async () => null,
      assertVerifiedWorkerMatches: () => undefined,
    });
    return {
      handled,
      res,
      json: res.body ? JSON.parse(res.body) : undefined,
    };
  }
  return { broker, route };
}

test("GET review lineage routes expose only projected operator fields", async () => {
  const { route } = makeRouter();

  const list = await route("GET", "/review-lineages");
  assert.equal(list.handled, true);
  assert.equal(list.res.statusCode, 200);
  assert.equal(list.json.count, 1);

  const item = await route("GET", "/review-lineages/lineage-http-1");
  assert.equal(item.json.lineage.lineageId, "lineage-http-1");
  assert.equal(item.json.lineage.mode, "record");
  assert.equal(item.json.lineage.state, "reviewing_initial");
  assert.equal(item.json.lineage.contract, undefined);
  assert.equal(item.json.lineage.ledger, undefined);
  assert.equal(item.json.lineage.currentDiffHash, undefined);
});

test("GET review lineage routes fail closed for unknown ids and missing roles", async () => {
  const { route } = makeRouter();

  await assert.rejects(
    route("GET", "/review-lineages/missing"),
    (error) => error instanceof BrokerError && error.code === "not_found",
  );
  await assert.rejects(
    route("GET", "/review-lineages", true, null),
    (error) => error instanceof BrokerError,
  );
});

test("review lineage routes match exact path boundaries", async () => {
  const { route } = makeRouter();

  assert.equal(
    (await route("POST", "/review-lineages/one/events")).handled,
    false,
  );
  assert.equal(
    (await route("GET", "/review-lineages/one/events")).handled,
    false,
  );
  assert.equal((await route("GET", "/review-lineagesX")).handled, false);
});

test("lineage-create route requires operator identity and returns durable replay", async () => {
  const store = new SqliteBrokerStateStore(":memory:");
  try {
    const broker = new InMemoryA2ABroker(
      store,
      store.load(),
      { reviewLineageMode: "record" },
    );
    const frozen = contract();
    const diffHash = `sha256:${"c".repeat(64)}`;

    async function route(identity: unknown, body: unknown) {
      const res = new CapturingResponse();
      const handled = await handleReviewLineageRoutesIfMatched({
        method: "POST",
        path: "/review-lineages",
        req: Readable.from([JSON.stringify(body)]) as IncomingMessage,
        res: res as unknown as ServerResponse,
        url: new URL("/review-lineages", "https://broker.test"),
        broker,
        enforceRequesterIdentity: false,
        requesterIdentity: identity as never,
        assertWorkerHttpSignatureRoute: async () => null,
        assertVerifiedWorkerMatches: () => undefined,
      });
      return {
        handled,
        res,
        json: res.body ? JSON.parse(res.body) : undefined,
      };
    }
    const request = {
      dispatchRef: "lineage-dispatch:route:1",
      observedAt: frozen.createdAt,
      binding: {
        intentHash: frozen.intentHash,
        headSha: frozen.headSha,
        diffHash,
      },
      contract: frozen,
      budget: budget(),
    };

    await assert.rejects(
      route({ id: "hub-a", role: "hub" }, request),
      (error) =>
        error instanceof BrokerError
        && error.code === "unauthorized",
    );
    const applied = await route(
      { id: "operator-a", role: "operator" },
      request,
    );
    assert.equal(applied.handled, true);
    assert.equal(applied.res.statusCode, 201);
    assert.equal(applied.json.result.status, "applied");
    assert.equal(
      broker.getReviewLineage(frozen.lineageId)?.state,
      "reviewing_initial",
    );

    const replay = await route(
      { id: "operator-a", role: "operator" },
      request,
    );
    assert.equal(replay.res.statusCode, 200);
    assert.equal(replay.json.result.status, "replayed");
    await assert.rejects(
      route(
        { id: "operator-a", role: "operator" },
        { ...request, authorityKind: "lineage_dispatcher" },
      ),
      (error) =>
        error instanceof BrokerError
        && error.code === "bad_request",
    );
    await assert.rejects(
      route(
        { id: "operator-a", role: "operator" },
        { ...request, dispatchRef: "lineage-dispatch:route:2" },
      ),
      (error) =>
        error instanceof BrokerError
        && error.code === "invalid_transition",
    );
  } finally {
    store.close();
  }
});

test("operator-cancel route requires operator identity and returns durable replay", async () => {
  const store = new SqliteBrokerStateStore(":memory:");
  try {
    const broker = new InMemoryA2ABroker(
      store,
      store.load(),
      { reviewLineageMode: "record" },
    );
    const frozen = contract();
    const diffHash = `sha256:${"c".repeat(64)}`;
    await broker.applyReviewLineageObservation(
      parseReviewLineageObservation({
        kind: "a2a.review-lineage-observation.v1",
        producerId: "test-dispatcher",
        sourceEventId: "route:create:1",
        lineageId: frozen.lineageId,
        observedAt: frozen.createdAt,
        binding: {
          intentHash: frozen.intentHash,
          headSha: frozen.headSha,
          diffHash,
        },
        observation: {
          kind: "lineage_create",
          mode: "record",
          contract: frozen,
          budget: budget(),
        },
      }),
    );

    async function route(identity: unknown, body: unknown) {
      const res = new CapturingResponse();
      const handled = await handleReviewLineageRoutesIfMatched({
        method: "POST",
        path: `/review-lineages/${frozen.lineageId}/operator-cancel`,
        req: Readable.from([JSON.stringify(body)]) as IncomingMessage,
        res: res as unknown as ServerResponse,
        url: new URL(
          `/review-lineages/${frozen.lineageId}/operator-cancel`,
          "https://broker.test",
        ),
        broker,
        enforceRequesterIdentity: false,
        requesterIdentity: identity as never,
        assertWorkerHttpSignatureRoute: async () => null,
        assertVerifiedWorkerMatches: () => undefined,
      });
      return {
        handled,
        res,
        json: res.body ? JSON.parse(res.body) : undefined,
      };
    }
    const request = {
      decisionRef: "operator-decision:route:1",
      observedAt: "2026-07-23T00:01:00.000Z",
      binding: {
        intentHash: frozen.intentHash,
        headSha: frozen.headSha,
        diffHash,
      },
      detail: "Explicit operator cancellation.",
    };

    await assert.rejects(
      route({ id: "analyst-a", role: "analyst" }, request),
      (error) =>
        error instanceof BrokerError
        && error.code === "unauthorized",
    );
    const applied = await route(
      { id: "operator-a", role: "operator" },
      request,
    );
    assert.equal(applied.handled, true);
    assert.equal(applied.res.statusCode, 201);
    assert.equal(applied.json.result.status, "applied");
    assert.equal(
      broker.getReviewLineage(frozen.lineageId)?.state,
      "canceled",
    );

    const replay = await route(
      { id: "operator-a", role: "operator" },
      request,
    );
    assert.equal(replay.res.statusCode, 200);
    assert.equal(replay.json.result.status, "replayed");
    await assert.rejects(
      route(
        { id: "operator-a", role: "operator" },
        { ...request, authorityKind: "operator" },
      ),
      (error) =>
        error instanceof BrokerError
        && error.code === "bad_request",
    );
  } finally {
    store.close();
  }
});

test("review-report route requires a signed reviewer and binds it to the receipt", async () => {
  const store = new SqliteBrokerStateStore(":memory:");
  try {
    const broker = new InMemoryA2ABroker(
      store,
      store.load(),
      { reviewLineageMode: "record" },
    );
    const frozen = contract();
    const diffHash = `sha256:${"c".repeat(64)}`;
    await broker.applyReviewLineageObservation(
      parseReviewLineageObservation({
        kind: "a2a.review-lineage-observation.v1",
        producerId: "test-dispatcher",
        sourceEventId: "route:create:review-report",
        lineageId: frozen.lineageId,
        observedAt: frozen.createdAt,
        binding: {
          intentHash: frozen.intentHash,
          headSha: frozen.headSha,
          diffHash,
        },
        observation: {
          kind: "lineage_create",
          mode: "record",
          contract: frozen,
          budget: budget(),
        },
      }),
    );

    async function route(
      reviewerId: string | null,
      body: unknown,
      scopeAllowed = true,
    ) {
      const path =
        `/review-lineages/${frozen.lineageId}/review-report`;
      const res = new CapturingResponse();
      const handled = await handleReviewLineageRoutesIfMatched({
        method: "POST",
        path,
        req: Readable.from([JSON.stringify(body)]) as IncomingMessage,
        res: res as unknown as ServerResponse,
        url: new URL(path, "https://broker.test"),
        broker,
        enforceRequesterIdentity: false,
        requesterIdentity: reviewerId
          ? { id: reviewerId, role: "analyst" }
          : null,
        assertWorkerHttpSignatureRoute: async () =>
          reviewerId
            ? {
                keyid: `worker:${reviewerId}:v1`,
                requesterId: reviewerId,
                scopes: ["review-lineage.report"],
              }
            : null,
        assertVerifiedWorkerMatches: (_verified, _expected, operation) => {
          assert.equal(operation, "review-lineage.report");
          if (!scopeAllowed) {
            throw new BrokerError(
              "policy_denied",
              "review-lineage.report scope denied",
            );
          }
        },
      });
      return {
        handled,
        res,
        json: res.body ? JSON.parse(res.body) : undefined,
      };
    }
    const reviewerId = "reviewer-yukson";
    const request = {
      reportRef: "review-report:route:1",
      observedAt: "2026-07-23T00:01:00.000Z",
      binding: {
        intentHash: frozen.intentHash,
        headSha: frozen.headSha,
        diffHash,
      },
      receipt: {
        kind: "ReviewReceiptV1",
        reviewerNodeId: reviewerId,
        verdict: "pass",
        note: "Private review prose retained only in the canonical lineage.",
        headSha: frozen.headSha,
        diffHash,
        intentHash: frozen.intentHash,
        findingLedgerRef: `ledger-${frozen.lineageId}`,
        authorWorkerId: "author-bangtong",
      },
      resolvedFindingIds: [],
      reopenedFindingIds: [],
      newFindings: [],
    };

    await assert.rejects(
      route(null, request),
      (error) =>
        error instanceof BrokerError
        && error.code === "unauthorized",
    );
    await assert.rejects(
      route(reviewerId, request, false),
      (error) =>
        error instanceof BrokerError
        && error.code === "policy_denied",
    );
    await assert.rejects(
      route(
        "different-signed-reviewer",
        request,
      ),
      (error) =>
        error instanceof BrokerError
        && error.code === "bad_request"
        && /issuer_mismatch/.test(error.message),
    );

    const applied = await route(reviewerId, request);
    assert.equal(applied.handled, true);
    assert.equal(applied.res.statusCode, 201);
    assert.equal(applied.json.result.status, "applied");
    assert.equal(
      broker.getReviewLineage(frozen.lineageId)?.state,
      "passed",
    );

    const replay = await route(reviewerId, request);
    assert.equal(replay.res.statusCode, 200);
    assert.equal(replay.json.result.status, "replayed");
    await assert.rejects(
      route(
        reviewerId,
        { ...request, sourceKind: "review_report_submitted" },
      ),
      (error) =>
        error instanceof BrokerError
        && error.code === "bad_request",
    );
    await assert.rejects(
      route(
        reviewerId,
        {
          ...request,
          receipt: {
            ...request.receipt,
            note: "Changed payload under one immutable report.",
          },
        },
      ),
      (error) =>
        error instanceof BrokerError
        && error.code === "invalid_transition",
    );
  } finally {
    store.close();
  }
});
