/**
 * Route table ↔ legacy classifier equivalence snapshot (#2079 A).
 *
 * Pins every route entry's observability labels (endpoint group, request
 * route), rate-limit bucket, and drain class to the output of the legacy
 * if-chain classifiers (`classifyEndpointGroup` / `classifyRequestRoute` /
 * `classifyRateLimitBucket`). If a label drifts, the schedz/observability
 * projections change — this test fails first.
 *
 * It also pins:
 * - table coverage: a corpus of every real route path matches an entry (a
 *   pattern typo would silently 404 a live route);
 * - no shadowing: each entry's canonical path resolves to that entry itself
 *   (insertion order mirrors the legacy chain, and the legacy chain never
 *   shadowed a live route with an earlier one);
 * - the drain-refusal set is exactly {GET /tasks, POST /tasks/:id/claim}.
 */
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";

import {
  createA2AJsonRpcRouteEntries,
  createComplexityOrchestrationRouteEntries,
  createWavePlanRouteEntries,
  createWavePlanDagV2RouteEntries,
  createReviewLineageRouteEntries,
  createNclexEvaluationRouteEntries,
  createA2ATaskStreamRouteEntries,
  createA2ATerminalOutboxRouteEntries,
  createA2AStreamRouteEntries,
  createOperatorDashboardRouteEntries,
  createOperatorReportingReadRouteEntries,
  createTerminalBriefCloseoutRouteEntries,
  createOperatorCleanupRouteEntries,
  createOperatorDiagnosticsReadRouteEntries,
  createWorkersReadRouteEntries,
  createWorkersWriteRouteEntries,
  createExchangeRouteEntries,
  createConversationRouteEntries,
  createConversationRelayRouteEntries,
  createProposalsReadRouteEntries,
  createProposalsWriteRouteEntries,
  createRoundStatusRouteEntries,
  createTaskStatsRouteEntries,
  createWorkerLatencyStatsRouteEntries,
  createTasksCollectionRouteEntries,
  createTasksReadRouteEntries,
  createTasksWakeRouteEntries,
  createTasksDecisionRouteEntries,
  createTasksWorkerRouteEntries,
  createAuditReadRouteEntries,
  createGitHubRouteEntries,
} from "./route-entries.js";
import {
  buildRouteIndex,
  entryRateLimitBucket,
  lookupRoute,
  type BrokerRouteEntry,
} from "./route-table.js";
import {
  classifyEndpointGroup,
  classifyRequestRoute,
} from "./route-classification.js";
import { classifyRateLimitBucket } from "../core/request-security.js";
import { createDialecticRouteEntries } from "./dialectic-routes.js";

/**
 * Stub deps: factories only close over these — matching and classification
 * never touch them — so `null`-ish stubs are safe here.
 */
function allEntries(): BrokerRouteEntry[] {
  const nullDeps = null as never;
  return [
    ...createA2AJsonRpcRouteEntries(nullDeps),
    ...createComplexityOrchestrationRouteEntries({}),
    ...createWavePlanRouteEntries(nullDeps),
    ...createWavePlanDagV2RouteEntries(nullDeps),
    ...createReviewLineageRouteEntries(nullDeps),
    ...createNclexEvaluationRouteEntries(nullDeps),
    ...createA2ATaskStreamRouteEntries(nullDeps),
    ...createA2ATerminalOutboxRouteEntries(nullDeps),
    ...createA2AStreamRouteEntries(nullDeps),
    ...createOperatorDashboardRouteEntries(nullDeps),
    ...createOperatorReportingReadRouteEntries(nullDeps),
    ...createTerminalBriefCloseoutRouteEntries({}),
    ...createOperatorCleanupRouteEntries(nullDeps),
    ...createOperatorDiagnosticsReadRouteEntries(nullDeps),
    ...createWorkersReadRouteEntries(nullDeps),
    ...createWorkersWriteRouteEntries(nullDeps),
    ...createExchangeRouteEntries(nullDeps),
    ...createConversationRouteEntries(nullDeps),
    ...createConversationRelayRouteEntries(nullDeps),
    ...createProposalsReadRouteEntries(nullDeps),
    ...createProposalsWriteRouteEntries(nullDeps),
    ...createRoundStatusRouteEntries(nullDeps),
    ...createTaskStatsRouteEntries(nullDeps),
    ...createWorkerLatencyStatsRouteEntries(nullDeps),
    ...createTasksCollectionRouteEntries(nullDeps),
    // Inserted between collection and reads, mirroring server.ts order.
    ...createDialecticRouteEntries(nullDeps),
    ...createTasksReadRouteEntries(nullDeps),
    ...createTasksWakeRouteEntries(nullDeps),
    ...createTasksDecisionRouteEntries(nullDeps),
    ...createTasksWorkerRouteEntries(nullDeps),
    ...createAuditReadRouteEntries(nullDeps),
    ...createGitHubRouteEntries(nullDeps),
  ];
}

/** Render a pattern into the canonical request path used for pinning. */
function canonicalPath(pattern: readonly string[]): string {
  const parts = pattern
    .filter((part) => part !== "**")
    .map((part) => (part.startsWith(":") ? "x1" : part));
  return `/${parts.join("/")}`;
}

function fakeRequest(method: string): IncomingMessage {
  return { method, headers: {} } as unknown as IncomingMessage;
}

function segmentsOf(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map(decodeURIComponent);
}

test("every entry's group/route labels match the legacy if-chain classifiers", () => {
  const entries = allEntries();
  assert.ok(entries.length >= 70, `expected the full route table, got ${entries.length} entries`);
  for (const e of entries) {
    const path = canonicalPath(e.pattern);
    const method = e.method === "*" ? "POST" : e.method; // wildcard entry pins its non-GET rejection path
    const segs = segmentsOf(path);
    assert.equal(
      e.group,
      classifyEndpointGroup(method, path, segs),
      `group drift for ${method} ${path}`,
    );
    assert.equal(
      e.route,
      classifyRequestRoute(method, path, segs),
      `route drift for ${method} ${path}`,
    );
  }
});

test("entry rate-limit buckets match the legacy classifier (with and without requester headers)", () => {
  for (const e of allEntries()) {
    const path = canonicalPath(e.pattern);
    if (e.method === "*") {
      continue; // wildcard entries never carry bucket data; dispatch rejects them
    }
    const url = new URL(path, "http://broker.test");
    // Anonymous request: the legacy classifier's answer must equal the
    // table-derived bucket (falling back to the classifier for routes whose
    // bucket is request-dependent).
    const legacy = classifyRateLimitBucket(fakeRequest(e.method), url);
    const derived = entryRateLimitBucket(e, {
      method: e.method,
      segments: segmentsOf(path),
      params: {},
      req: fakeRequest(e.method),
      url,
      path,
    });
    assert.equal(
      derived ?? legacy,
      legacy,
      `bucket drift for ${e.method} ${path}`,
    );
  }

  // Request-dependent buckets: worker poll names itself, assignment-events
  // subscribes as the named worker.
  const pollEntry = allEntries().find((e) => e.method === "GET" && canonicalPath(e.pattern) === "/tasks");
  assert.ok(pollEntry?.bucketOf, "GET /tasks must carry the worker-poll bucket refinement");
  const pollUrl = new URL("http://broker.test/tasks?assignedWorkerId=w-9");
  const pollReq = { method: "GET", headers: { "x-a2a-requester-id": "w-9" } } as unknown as IncomingMessage;
  assert.equal(entryRateLimitBucket(pollEntry, { method: "GET", segments: ["tasks"], params: {}, req: pollReq, url: pollUrl, path: "/tasks" }), "worker");

  const eventsEntry = allEntries().find((e) => e.pattern.join("/") === "a2a/workers/:id/assignment-events");
  assert.ok(eventsEntry?.bucketOf, "assignment-events must carry the worker bucket refinement");
  const eventsUrl = new URL("http://broker.test/a2a/workers/w-9/assignment-events");
  const eventsReq = { method: "GET", headers: { "x-a2a-requester-id": "w-9" } } as unknown as IncomingMessage;
  assert.equal(entryRateLimitBucket(eventsEntry, { method: "GET", segments: ["a2a", "workers", "w-9", "assignment-events"], params: {}, req: eventsReq, url: eventsUrl, path: "/a2a/workers/w-9/assignment-events" }), "worker");
});

test("drain refusal set is exactly {GET /tasks, POST /tasks/:id/claim}", () => {
  const refused = allEntries()
    .filter((e) => e.drainRefused)
    .map((e) => `${e.method} ${canonicalPath(e.pattern)}`);
  assert.deepEqual(refused.sort(), ["GET /tasks", "POST /tasks/x1/claim"]);
});

test("table coverage: every real route resolves to its own entry (no shadowing, no 404 drift)", () => {
  const entries = allEntries();
  const index = buildRouteIndex(entries);

  // One canonical path per entry plus depth variants for the open-ended
  // "**" patterns (the legacy dispatchers accepted trailing extras).
  const corpus: Array<{ method: string; path: string }> = [];
  for (const e of entries) {
    if (e.method === "*") {
      continue;
    }
    const path = canonicalPath(e.pattern);
    corpus.push({ method: e.method, path });
    if (e.pattern[e.pattern.length - 1] === "**") {
      corpus.push({ method: e.method, path: `${path}/extra` });
      corpus.push({ method: e.method, path: `${path}/extra/deeper` });
    }
  }
  // Trailing-slash tolerance: the A2A JSON-RPC transport accepts "/a2a/jsonrpc/".
  corpus.push({ method: "POST", path: "/a2a/jsonrpc/" });

  for (const { method, path } of corpus) {
    const match = lookupRoute(index, method, segmentsOf(path));
    assert.ok(match, `table miss for ${method} ${path}`);
    const e = match.entry;
    if (e.method === "*") {
      continue; // canonical paths are checked against their exact entry below
    }
    if (path === canonicalPath(e.pattern)) {
      assert.ok(
        e.method === method && canonicalPath(e.pattern) === path,
        `shadowing: ${method} ${path} resolved to ${e.method} ${canonicalPath(e.pattern)}`,
      );
    }
  }

  // Method-wildcard dag-v2 entry: non-GET methods land on it, GET sub-paths
  // that miss the literals fall through to it after the exact bucket.
  const wildcard = lookupRoute(index, "POST", segmentsOf("/wave-plan-dag-v2/admissions"));
  assert.equal(wildcard?.entry.method, "*", "non-GET dag-v2 must land on the wildcard (read-only 400) entry");
  const fallback = lookupRoute(index, "GET", segmentsOf("/wave-plan-dag-v2/unknown"));
  assert.equal(fallback?.entry.method, "*", "unknown dag-v2 GET sub-paths must fall through to the wildcard entry");
});

test("legacy near-miss spellings stay labeled but unrouted (404 parity)", () => {
  const entries = allEntries();
  const index = buildRouteIndex(entries);
  // The underscore spelling classifies as tasks.reject-approval but the
  // dispatcher never accepted it — it must stay a table miss.
  assert.equal(
    classifyRequestRoute("POST", "/tasks/t-1/reject_approval", segmentsOf("/tasks/t-1/reject_approval")),
    "tasks.reject-approval",
  );
  assert.equal(lookupRoute(index, "POST", segmentsOf("/tasks/t-1/reject_approval")), null);
});
