import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateQueryRequestV1,
  parseSharedStateQueryResultV1,
  type SharedStateContractErrorCodeV1,
  type SharedStateParseResultV1,
} from "./shared-state-storage-contract-v1.js";

interface QueryFixtureV1 {
  readonly fixtureVersion: number;
  readonly contractVersion: string;
  readonly queryVersion: number;
  readonly requests: readonly unknown[];
  readonly results: readonly unknown[];
}

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/shared-state-storage/query-v1-golden.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as QueryFixtureV1;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function expectError<T>(
  parsed: SharedStateParseResultV1<T>,
  code: SharedStateContractErrorCodeV1,
  path?: readonly (string | number)[],
): void {
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.error.code, code);
  if (path) assert.deepEqual(parsed.error.path, path);
}

function request(index: number): Record<string, unknown> {
  return clone(fixture.requests[index]) as Record<string, unknown>;
}

function result(index: number): Record<string, unknown> {
  return clone(fixture.results[index]) as Record<string, unknown>;
}

function inputOf(value: Record<string, unknown>): Record<string, unknown> {
  return value.input as Record<string, unknown>;
}

function resultOf(value: Record<string, unknown>): Record<string, unknown> {
  return value.result as Record<string, unknown>;
}

test("pins the two closed query families and parses every synthetic fixture", () => {
  assert.deepEqual(V.queryOperations, [
    "reconcileOutbox",
    "queryGraphEvidencePath",
  ]);
  assert.equal(Object.isFrozen(V.queryOperations), true);
  assert.equal(fixture.fixtureVersion, 1);
  assert.equal(fixture.contractVersion, V.versions.contract);
  assert.equal(fixture.queryVersion, V.versions.query);
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.results.length, 6);

  for (const value of fixture.requests) {
    assert.equal(parseSharedStateQueryRequestV1(value).ok, true);
  }
  for (const value of fixture.results) {
    assert.equal(parseSharedStateQueryResultV1(value).ok, true);
  }
});

test("fails closed on query versions, operations, fields, and forbidden inputs", () => {
  const wrongVersion = request(0);
  wrongVersion.queryVersion = 2;
  expectError(
    parseSharedStateQueryRequestV1(wrongVersion),
    "unknown_query_version",
    ["queryVersion"],
  );

  const wrongContract = request(0);
  wrongContract.contractVersion = "a2a.shared-state.storage/v2";
  expectError(
    parseSharedStateQueryRequestV1(wrongContract),
    "unknown_contract_version",
    ["contractVersion"],
  );

  const wrongOperation = request(0);
  wrongOperation.operation = "consumeReplayNonce";
  expectError(
    parseSharedStateQueryRequestV1(wrongOperation),
    "invalid_discriminant",
    ["operation"],
  );

  const extended = request(0);
  inputOf(extended).extension = true;
  expectError(
    parseSharedStateQueryRequestV1(extended),
    "unknown_field",
    ["input", "extension"],
  );

  for (const [field, code] of [
    ["now", "caller_clock_forbidden"],
    ["sql", "backend_command_forbidden"],
    ["databasePath", "sensitive_field_forbidden"],
  ] as const) {
    const forbidden = request(1);
    inputOf(forbidden)[field] = "synthetic";
    expectError(
      parseSharedStateQueryRequestV1(forbidden),
      code,
      ["input", field],
    );
  }
});

test("requires each query to request and report its exact consistency", () => {
  const requestMismatch = request(0);
  const required = inputOf(requestMismatch).requiredConsistency as
    Record<string, unknown>;
  required.model = "linearizable";
  expectError(
    parseSharedStateQueryRequestV1(requestMismatch),
    "query_consistency_mismatch",
    ["input", "requiredConsistency", "model"],
  );

  const resultMismatch = result(1);
  const achieved = resultMismatch.achievedConsistency as
    Record<string, unknown>;
  achieved.scope = "per-stream";
  expectError(
    parseSharedStateQueryResultV1(resultMismatch),
    "query_consistency_mismatch",
    ["achievedConsistency", "scope"],
  );

  const unavailableWithClaim = result(5);
  unavailableWithClaim.achievedConsistency = {
    model: "serializable",
    scope: "per-stream",
  };
  expectError(
    parseSharedStateQueryResultV1(unavailableWithClaim),
    "query_consistency_mismatch",
    ["achievedConsistency"],
  );
});

test("bounds outbox requests and binds their stream digest to the namespace", () => {
  const unknownNamespace = request(0);
  inputOf(unknownNamespace).namespace = "other.namespace";
  inputOf(unknownNamespace).streamKeyDigest =
    "a2a.shared-state.keyspace/v1|broker.outbox.stream-key|other.namespace|sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  expectError(
    parseSharedStateQueryRequestV1(unknownNamespace),
    "unknown_outbox_stream_namespace",
    ["input", "namespace"],
  );

  const wrongNamespaceDigest = request(0);
  inputOf(wrongNamespaceDigest).streamKeyDigest =
    "a2a.shared-state.keyspace/v1|broker.outbox.stream-key|other.namespace|sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  expectError(
    parseSharedStateQueryRequestV1(wrongNamespaceDigest),
    "digest_namespace_mismatch",
    ["input", "streamKeyDigest"],
  );

  const oversized = request(0);
  inputOf(oversized).limit = V.limits.maxQueryPageSize + 1;
  expectError(parseSharedStateQueryRequestV1(oversized), "invalid_value");

  const reflectingCursor = request(0);
  inputOf(reflectingCursor).cursor = "cursor:contains:backend:syntax";
  expectError(
    parseSharedStateQueryRequestV1(reflectingCursor),
    "invalid_value",
    ["input", "cursor"],
  );
});

test("rejects inconsistent outbox pages and receipt/ACK claims", () => {
  const cursorMismatch = result(0);
  resultOf(cursorMismatch).hasMore = false;
  expectError(
    parseSharedStateQueryResultV1(cursorMismatch),
    "query_result_mismatch",
    ["result", "nextCursor"],
  );

  const outOfOrder = result(0);
  const events = resultOf(outOfOrder).events as Record<string, unknown>[];
  events[1]!.streamSequence = "1";
  expectError(
    parseSharedStateQueryResultV1(outOfOrder),
    "query_result_mismatch",
    ["result", "events", 1, "streamSequence"],
  );

  const duplicateEvent = result(0);
  const duplicateEvents = resultOf(duplicateEvent).events as
    Record<string, unknown>[];
  duplicateEvents[1]!.eventKeyDigest = duplicateEvents[0]!.eventKeyDigest;
  expectError(
    parseSharedStateQueryResultV1(duplicateEvent),
    "query_result_mismatch",
    ["result", "events", 1, "eventKeyDigest"],
  );

  const unconfirmedAck = result(0);
  const acked = (resultOf(unconfirmedAck).events as Record<string, unknown>[])[1]!;
  acked.receiptState = "pending";
  expectError(
    parseSharedStateQueryResultV1(unconfirmedAck),
    "query_result_mismatch",
    ["result", "events", 1, "acknowledgmentState"],
  );

  const wrongEventNamespace = result(0);
  const first = (resultOf(wrongEventNamespace).events as Record<string, unknown>[])[0]!;
  first.eventKeyDigest =
    "a2a.shared-state.keyspace/v1|broker.outbox.event-key|other.namespace|sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  expectError(
    parseSharedStateQueryResultV1(wrongEventNamespace),
    "digest_namespace_mismatch",
    ["result", "events", 0, "eventKeyDigest"],
  );
});

test("pins all four graph evidence states and complete negative evidence", () => {
  const evidenceStates = fixture.results.slice(1, 5).map((value) => {
    const parsed = parseSharedStateQueryResultV1(value);
    assert.equal(parsed.ok, true);
    if (!parsed.ok || parsed.value.status !== "succeeded") return null;
    assert.equal(parsed.value.operation, "queryGraphEvidencePath");
    if (parsed.value.operation !== "queryGraphEvidencePath") return null;
    return parsed.value.result.evidence;
  });
  assert.deepEqual(evidenceStates, V.graphEvidenceResults);

  const invalidNegative = result(2);
  resultOf(invalidNegative).completeness = "incomplete";
  expectError(
    parseSharedStateQueryResultV1(invalidNegative),
    "query_completeness_mismatch",
    ["result", "completeness"],
  );
});

test("binds graph paths to anchors and exact checkpoint arithmetic", () => {
  const wrongFirst = result(1);
  const graph = resultOf(wrongFirst);
  const path = graph.sourcePath as string[];
  path[0] =
    "a2a.shared-state.keyspace/v1|broker.claim-graph.source-fact|broker.claim-graph|sha256:4444444444444444444444444444444444444444444444444444444444444444";
  expectError(
    parseSharedStateQueryResultV1(wrongFirst),
    "query_result_mismatch",
    ["result", "sourcePath", 0],
  );

  const cyclicPath = result(1);
  const cyclic = resultOf(cyclicPath).sourcePath as string[];
  cyclic[1] = cyclic[0]!;
  expectError(
    parseSharedStateQueryResultV1(cyclicPath),
    "query_result_mismatch",
    ["result", "sourcePath"],
  );

  const wrongAsOf = result(3);
  resultOf(wrongAsOf).asOfSourceSequence = "3";
  expectError(
    parseSharedStateQueryResultV1(wrongAsOf),
    "query_result_mismatch",
    ["result", "asOfSourceSequence"],
  );

  const wrongLag = result(3);
  resultOf(wrongLag).lag = "1";
  expectError(
    parseSharedStateQueryResultV1(wrongLag),
    "query_result_mismatch",
    ["result", "lag"],
  );

  const regressedCheckpoint = result(3);
  resultOf(regressedCheckpoint).checkpointSequence = "7";
  expectError(
    parseSharedStateQueryResultV1(regressedCheckpoint),
    "query_result_mismatch",
    ["result", "checkpointSequence"],
  );
});

test("keeps query operation results closed and distinct", () => {
  const crossed = result(0);
  crossed.operation = "queryGraphEvidencePath";
  crossed.achievedConsistency = {
    model: "monotonic-eventual",
    scope: "projection-batch",
  };
  expectError(
    parseSharedStateQueryResultV1(crossed),
    "query_result_mismatch",
    ["result"],
  );

  const extended = result(1);
  resultOf(extended).rawClaim = "must-not-reflect";
  expectError(
    parseSharedStateQueryResultV1(extended),
    "query_result_mismatch",
    ["result"],
  );

  const commitOnlyReason = result(5);
  commitOnlyReason.reasonCode = "ambiguous_commit";
  expectError(parseSharedStateQueryResultV1(commitOnlyReason), "invalid_value");
});
