import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  SHARED_STATE_SQLITE_ADAPTER_ERROR_CODES_V1,
  SharedStateSqliteAdapterV1,
  type SharedStateSqliteAdapterErrorCodeV1,
  type SharedStateSqliteAdapterResultV1,
} from "./shared-state-sqlite-adapter-v1.js";
import {
  SHARED_STATE_SQLITE_QUERY_NORMALIZATION_V1,
  createSharedStateSqliteQuerySurfaceV1,
  type SharedStateSqliteQueryDispatcherV1,
} from "./shared-state-sqlite-query-surface-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateQueryRequestV1,
  parseSharedStateQueryResultV1,
  type SharedStateQueryRequestV1,
  type SharedStateQueryResultV1,
  type SharedStateStorageAdapterV1,
} from "./shared-state-storage-contract-v1.js";

interface QueryFixtureV1 {
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

function request(index: number): SharedStateQueryRequestV1 {
  const parsed = parseSharedStateQueryRequestV1(
    structuredClone(fixture.requests[index]),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("synthetic query request must parse");
  return parsed.value;
}

function result(index: number): SharedStateQueryResultV1 {
  const parsed = parseSharedStateQueryResultV1(
    structuredClone(fixture.results[index]),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("synthetic query result must parse");
  return parsed.value;
}

function localFailure(
  code: SharedStateSqliteAdapterErrorCodeV1,
): SharedStateSqliteAdapterResultV1<SharedStateQueryResultV1> {
  return { ok: false, error: { code } };
}

function expectUnavailable(
  value: SharedStateQueryResultV1,
  operation: SharedStateQueryRequestV1["operation"],
  reasonCode: string,
): void {
  assert.equal(value.operation, operation);
  assert.equal(value.status, "unavailable");
  if (value.status !== "unavailable") return;
  assert.equal(value.achievedConsistency, null);
  assert.equal(value.reasonCode, reasonCode);
  assert.equal(parseSharedStateQueryResultV1(value).ok, true);
}

test("exposes only the planned broad async query member", async () => {
  const calls: SharedStateQueryRequestV1[] = [];
  const expected = result(0);
  const dispatcher: SharedStateSqliteQueryDispatcherV1 = {
    query(value) {
      calls.push(value);
      return { ok: true, value: expected };
    },
  };
  const surface = createSharedStateSqliteQuerySurfaceV1(dispatcher);
  const broad: Pick<SharedStateStorageAdapterV1, "query"> = surface;

  assert.deepEqual(SHARED_STATE_SQLITE_QUERY_NORMALIZATION_V1, {
    kind: "SharedStateSqliteQueryNormalizationV1",
    source: "synchronous-sqlite-query-dispatcher",
    target: "async-backend-neutral-query-surface",
    operations: V.queryOperations,
    attachedToBrokerRuntime: false,
    fullAdapterConformanceClaimed: false,
  });
  assert.equal(Object.isFrozen(SHARED_STATE_SQLITE_QUERY_NORMALIZATION_V1), true);
  assert.equal(Object.isFrozen(surface), true);
  assert.deepEqual(Object.keys(surface), ["query"]);

  const pending = broad.query(request(0));
  assert.equal(pending instanceof Promise, true);
  assert.deepEqual(await pending, expected);
  assert.equal(calls.length, 1);
});

test("passes both validated operation results without weakening them", async () => {
  for (const [requestIndex, resultIndex] of [[0, 0], [1, 1]] as const) {
    const expected = result(resultIndex);
    const surface = createSharedStateSqliteQuerySurfaceV1({
      query: () => ({ ok: true, value: expected }),
    });
    assert.deepEqual(await surface.query(request(requestIndex)), expected);
  }
});

test("rejects an unparsed request with its closed parser error", async () => {
  let calls = 0;
  const surface = createSharedStateSqliteQuerySurfaceV1({
    query: () => {
      calls += 1;
      return { ok: true, value: result(0) };
    },
  });
  const invalid = {
    ...request(0),
    operation: "consumeReplayNonce",
  } as unknown as SharedStateQueryRequestV1;

  await assert.rejects(surface.query(invalid), (error: unknown) => {
    assert.deepEqual(error, {
      code: "invalid_discriminant",
      path: ["operation"],
    });
    return true;
  });
  assert.equal(calls, 0);
});

test("normalizes every SQLite-local failure without inventing evidence", async () => {
  assert.equal(Object.isFrozen(SHARED_STATE_SQLITE_ADAPTER_ERROR_CODES_V1), true);
  for (const code of SHARED_STATE_SQLITE_ADAPTER_ERROR_CODES_V1) {
    const surface = createSharedStateSqliteQuerySurfaceV1({
      query: () => localFailure(code),
    });
    for (const requestIndex of [0, 1]) {
      const input = request(requestIndex);
      const value = await surface.query(input);
      expectUnavailable(
        value,
        input.operation,
        code === "ownership_lost"
          ? "lost_ownership"
          : "authority_unavailable",
      );
    }
  }
});

test("preserves closed unavailable reasons already observed by SQLite", async () => {
  for (const reasonCode of V.queryUnavailableReasonCodes) {
    const candidate = {
      ...result(5),
      reasonCode,
    };
    const parsed = parseSharedStateQueryResultV1(candidate);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) throw new Error("closed unavailable result must parse");
    const surface = createSharedStateSqliteQuerySurfaceV1({
      query: () => ({ ok: true, value: parsed.value }),
    });
    assert.deepEqual(await surface.query(request(0)), parsed.value);
  }
});

test("fails closed on throws, malformed results, and crossed operations", async () => {
  const thrown = createSharedStateSqliteQuerySurfaceV1({
    query: () => {
      throw new Error("synthetic storage failure");
    },
  });
  expectUnavailable(
    await thrown.query(request(0)),
    "reconcileOutbox",
    "authority_unavailable",
  );

  const malformed = createSharedStateSqliteQuerySurfaceV1({
    query: () => ({
      ok: true,
      value: { operation: "reconcileOutbox", status: "succeeded" },
    } as unknown as SharedStateSqliteAdapterResultV1<SharedStateQueryResultV1>),
  });
  expectUnavailable(
    await malformed.query(request(0)),
    "reconcileOutbox",
    "authority_unavailable",
  );

  const malformedFailure = createSharedStateSqliteQuerySurfaceV1({
    query: () => ({
      ok: false,
    } as unknown as SharedStateSqliteAdapterResultV1<SharedStateQueryResultV1>),
  });
  expectUnavailable(
    await malformedFailure.query(request(0)),
    "reconcileOutbox",
    "authority_unavailable",
  );

  const crossed = createSharedStateSqliteQuerySurfaceV1({
    query: () => ({ ok: true, value: result(1) }),
  });
  expectUnavailable(
    await crossed.query(request(0)),
    "reconcileOutbox",
    "authority_unavailable",
  );
});

test("maps a real not-ready SQLite dispatcher to closed unavailable", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const sqlite = new SharedStateSqliteAdapterV1({
      db,
      ownerToken: "query-normalization-test-owner",
      backwardSkewToleranceMs: "0",
    });
    const surface = createSharedStateSqliteQuerySurfaceV1(sqlite);
    expectUnavailable(
      await surface.query(request(1)),
      "queryGraphEvidencePath",
      "authority_unavailable",
    );
  } finally {
    db.close();
  }
});
