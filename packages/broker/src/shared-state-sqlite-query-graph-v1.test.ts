import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  SHARED_STATE_SQLITE_ADAPTER_V1,
  SHARED_STATE_SQLITE_QUERY_OPERATIONS_V1,
  SharedStateSqliteAdapterV1,
  type SharedStateSqliteAdapterResultV1,
} from "./shared-state-sqlite-adapter-v1.js";
import { applySharedStateSqliteSchemaV1 } from "./shared-state-sqlite-schema-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateQueryRequestV1,
  parseSharedStateTransactionCommandV1,
  type SharedStateQueryRequestV1,
  type SharedStateQueryResultV1,
  type SharedStateTransactionCommandV1,
  type SharedStateTransactionResultV1,
} from "./shared-state-storage-contract-v1.js";
import { digestSharedStateKeyV1 } from "./shared-state-storage-keyspace-v1.js";

interface Fixture {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly directory: string;
}

type GraphQueryRequestV1 = Extract<
  SharedStateQueryRequestV1,
  { readonly operation: "queryGraphEvidencePath" }
>;

type GraphQuerySucceededV1 = Extract<
  SharedStateQueryResultV1,
  {
    readonly operation: "queryGraphEvidencePath";
    readonly status: "succeeded";
  }
>["result"];

type GraphOperationV1 =
  | "appendGraphSource"
  | "applyGraphProjectionBatch"
  | "rollbackGraphProjectionBatch";

type GraphCommandV1<Operation extends GraphOperationV1> = Extract<
  SharedStateTransactionCommandV1,
  { readonly operation: Operation }
>;

const GRAPH_NAMESPACE = "broker.claim-graph.query";
const PROJECTION_VERSION = "query-projection-v1";

function makeFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "shared-state-query-graph-"));
  const path = join(directory, "v1.db");
  const db = new DatabaseSync(path);
  assert.equal(applySharedStateSqliteSchemaV1(db).ok, true);
  return { db, path, directory };
}

function disposeFixture(fixture: Fixture, extra: DatabaseSync[] = []): void {
  for (const handle of extra) handle.close();
  fixture.db.close();
  rmSync(fixture.directory, { recursive: true, force: true });
}

function readyAdapter(db: DatabaseSync): SharedStateSqliteAdapterV1 {
  const owner = new SharedStateSqliteAdapterV1({
    db,
    ownerToken: "graph-query-owner-a",
    backwardSkewToleranceMs: "0",
  });
  assert.equal(owner.open().ok, true);
  return owner;
}

function digest(
  domain: string,
  components: readonly Record<string, unknown>[],
): string {
  const built = digestSharedStateKeyV1({
    keyspaceVersion: V.versions.keyspace,
    domain,
    namespace: GRAPH_NAMESPACE,
    components,
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error("unreachable");
  return built.value.digest;
}

function sourceFactDigest(index: number, nodeType: string): string {
  return digest("broker.claim-graph.source-fact", [
    { field: "nodeType", type: "utf8", value: nodeType },
    {
      field: "fact",
      type: "bytes",
      value: index.toString(16).padStart(2, "0"),
    },
  ]);
}

function graphCommand<Operation extends GraphOperationV1>(
  operation: Operation,
  input: GraphCommandV1<Operation>["input"],
): GraphCommandV1<Operation> {
  const parsed = parseSharedStateTransactionCommandV1({
    kind: V.kinds.transactionCommand,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation,
    input,
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.value.operation !== operation) {
    throw new Error("unreachable");
  }
  return parsed.value as GraphCommandV1<Operation>;
}

function appendSourceCommand(
  index: number,
  nodeType: (typeof V.graphNodeTypes)[number],
): GraphCommandV1<"appendGraphSource"> {
  return graphCommand("appendGraphSource", {
    namespace: GRAPH_NAMESPACE,
    sourceStreamKeyDigest: digest(
      "broker.claim-graph.source-stream-key",
      [
        { field: "sourceType", type: "utf8", value: "query-test" },
        { field: "sourceId", type: "utf8", value: "graph-query" },
      ],
    ),
    sourceFactDigest: sourceFactDigest(index, nodeType),
    nodeType,
    expectedSourceSequence: String(index - 1),
  });
}

function batchKeyDigest(batchId: string): string {
  return digest("broker.claim-graph.projection-batch-key", [
    { field: "projectionVersion", type: "utf8", value: PROJECTION_VERSION },
    { field: "batchId", type: "utf8", value: batchId },
  ]);
}

function batchBodyDigest(batchId: string): string {
  return digest("broker.claim-graph.projection-batch", [
    { field: "batch", type: "bytes", value: Buffer.from(batchId).toString("hex") },
  ]);
}

function inverseDigest(batchId: string): string {
  return digest("broker.claim-graph.projection-inverse", [
    {
      field: "inverse",
      type: "bytes",
      value: Buffer.from(`inverse-${batchId}`).toString("hex"),
    },
  ]);
}

function applyBatchCommand(input: {
  readonly batchId: string;
  readonly from: number;
  readonly through: number;
  readonly expectedCheckpoint: number;
}): GraphCommandV1<"applyGraphProjectionBatch"> {
  return graphCommand("applyGraphProjectionBatch", {
    namespace: GRAPH_NAMESPACE,
    projectionVersion: PROJECTION_VERSION,
    batchKeyDigest: batchKeyDigest(input.batchId),
    batchDigest: batchBodyDigest(input.batchId),
    inverseDigest: inverseDigest(input.batchId),
    sourceSequenceFrom: String(input.from),
    sourceSequenceThrough: String(input.through),
    expectedCheckpointSequence: String(input.expectedCheckpoint),
  });
}

function rollbackBatchCommand(input: {
  readonly batchId: string;
  readonly expectedCheckpoint: number;
}): GraphCommandV1<"rollbackGraphProjectionBatch"> {
  return graphCommand("rollbackGraphProjectionBatch", {
    namespace: GRAPH_NAMESPACE,
    projectionVersion: PROJECTION_VERSION,
    batchKeyDigest: batchKeyDigest(input.batchId),
    rollbackBatchKeyDigest: digest(
      "broker.claim-graph.rollback-batch-key",
      [
        { field: "projectionVersion", type: "utf8", value: PROJECTION_VERSION },
        { field: "rollbackId", type: "utf8", value: `rollback-${input.batchId}` },
      ],
    ),
    inverseDigest: inverseDigest(input.batchId),
    expectedCheckpointSequence: String(input.expectedCheckpoint),
  });
}

function committed(
  result: SharedStateSqliteAdapterResultV1<SharedStateTransactionResultV1>,
): Record<string, unknown> {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.value.status, "committed");
  if (result.value.status !== "committed") throw new Error("unreachable");
  return result.value.result;
}

function transact(
  owner: SharedStateSqliteAdapterV1,
  command: SharedStateTransactionCommandV1,
  observedAtUnixMs: number,
): Record<string, unknown> {
  return committed(owner.transact(command, {
    observedAtUnixMs: String(observedAtUnixMs),
  }));
}

function seedSources(
  owner: SharedStateSqliteAdapterV1,
  nodeTypes: readonly (typeof V.graphNodeTypes)[number][],
): readonly string[] {
  return nodeTypes.map((nodeType, index) => {
    const ordinal = index + 1;
    const result = transact(
      owner,
      appendSourceCommand(ordinal, nodeType),
      1_000 + ordinal,
    );
    assert.equal(result.sourceSequence, String(ordinal));
    return sourceFactDigest(ordinal, nodeType);
  });
}

function graphQueryRequest(input: {
  readonly claimSourceFactDigest: string;
  readonly evidenceSourceFactDigest: string;
  readonly projectionVersion?: string;
  readonly maxPathEdges?: number;
}): GraphQueryRequestV1 {
  const parsed = parseSharedStateQueryRequestV1({
    kind: V.kinds.queryRequest,
    contractVersion: V.versions.contract,
    queryVersion: V.versions.query,
    operation: "queryGraphEvidencePath",
    input: {
      namespace: GRAPH_NAMESPACE,
      projectionVersion: input.projectionVersion ?? PROJECTION_VERSION,
      claimSourceFactDigest: input.claimSourceFactDigest,
      evidenceSourceFactDigest: input.evidenceSourceFactDigest,
      maxPathEdges: input.maxPathEdges ?? 8,
      requiredConsistency: V.queryConsistency.queryGraphEvidencePath,
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.value.operation !== "queryGraphEvidencePath") {
    throw new Error("unreachable");
  }
  return parsed.value;
}

function queryValue(
  result: SharedStateSqliteAdapterResultV1<SharedStateQueryResultV1>,
): SharedStateQueryResultV1 {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return result.value;
}

function succeeded(
  result: SharedStateSqliteAdapterResultV1<SharedStateQueryResultV1>,
): GraphQuerySucceededV1 {
  const value = queryValue(result);
  assert.equal(value.operation, "queryGraphEvidencePath");
  assert.equal(value.status, "succeeded");
  if (
    value.operation !== "queryGraphEvidencePath"
    || value.status !== "succeeded"
  ) {
    throw new Error("unreachable");
  }
  assert.deepEqual(
    value.achievedConsistency,
    V.queryConsistency.queryGraphEvidencePath,
  );
  return value.result;
}

function unavailable(
  result: SharedStateSqliteAdapterResultV1<SharedStateQueryResultV1>,
): string {
  const value = queryValue(result);
  assert.equal(value.operation, "queryGraphEvidencePath");
  assert.equal(value.status, "unavailable");
  if (
    value.operation !== "queryGraphEvidencePath"
    || value.status !== "unavailable"
  ) {
    throw new Error("unreachable");
  }
  assert.equal(value.achievedConsistency, null);
  return value.reasonCode;
}

test("pins both closed SQLite query operations and an empty complete graph", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    assert.deepEqual(SHARED_STATE_SQLITE_QUERY_OPERATIONS_V1, [
      "reconcileOutbox",
      "queryGraphEvidencePath",
    ]);
    assert.equal(Object.isFrozen(SHARED_STATE_SQLITE_QUERY_OPERATIONS_V1), true);

    const claim = sourceFactDigest(1, "Claim");
    const evidence = sourceFactDigest(2, "Source");
    const result = succeeded(owner.query(graphQueryRequest({
      claimSourceFactDigest: claim,
      evidenceSourceFactDigest: evidence,
    })));
    assert.deepEqual(result, {
      namespace: GRAPH_NAMESPACE,
      projectionVersion: PROJECTION_VERSION,
      claimSourceFactDigest: claim,
      evidenceSourceFactDigest: evidence,
      asOfSourceSequence: "0",
      checkpointSequence: "0",
      sourceSequenceHighWater: "0",
      lag: "0",
      evidence: "no_evidence_path",
      completeness: "complete",
      sourcePath: [],
    });
  } finally {
    disposeFixture(fixture);
  }
});

test("withholds negative evidence until projection catches source high-water", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    const sources = seedSources(owner, ["Claim", "Source", "Artifact"]);
    const request = graphQueryRequest({
      claimSourceFactDigest: sources[0]!,
      evidenceSourceFactDigest: sources[2]!,
      maxPathEdges: 1,
    });

    const behind = succeeded(owner.query(request));
    assert.equal(behind.evidence, "projection_incomplete");
    assert.equal(behind.completeness, "incomplete");
    assert.equal(behind.checkpointSequence, "0");
    assert.equal(behind.sourceSequenceHighWater, "3");
    assert.equal(behind.lag, "3");
    assert.deepEqual(behind.sourcePath, []);

    transact(owner, applyBatchCommand({
      batchId: "one",
      from: 1,
      through: 3,
      expectedCheckpoint: 0,
    }), 2_000);
    const found = succeeded(owner.query(request));
    assert.equal(found.evidence, "path_found");
    assert.equal(found.completeness, "complete");
    assert.equal(found.checkpointSequence, "3");
    assert.equal(found.sourceSequenceHighWater, "3");
    assert.equal(found.lag, "0");
    assert.deepEqual(found.sourcePath, [sources[0], sources[2]]);

    const absent = succeeded(owner.query(graphQueryRequest({
      claimSourceFactDigest: sources[1]!,
      evidenceSourceFactDigest: sources[2]!,
    })));
    assert.equal(absent.evidence, "no_evidence_path");
    assert.equal(absent.completeness, "complete");
    assert.deepEqual(absent.sourcePath, []);
  } finally {
    disposeFixture(fixture);
  }
});

test("binds reads to projection version and exposes exact rollback state", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    const sources = seedSources(
      owner,
      ["Claim", "Source", "Artifact", "Claim", "Evaluation"],
    );
    transact(owner, applyBatchCommand({
      batchId: "one",
      from: 1,
      through: 3,
      expectedCheckpoint: 0,
    }), 2_000);
    transact(owner, applyBatchCommand({
      batchId: "two",
      from: 4,
      through: 5,
      expectedCheckpoint: 3,
    }), 2_001);

    const falsePathRequest = graphQueryRequest({
      claimSourceFactDigest: sources[3]!,
      evidenceSourceFactDigest: sources[4]!,
    });
    assert.equal(succeeded(owner.query(falsePathRequest)).evidence, "path_found");

    transact(owner, rollbackBatchCommand({
      batchId: "two",
      expectedCheckpoint: 5,
    }), 2_002);
    const restored = succeeded(owner.query(falsePathRequest));
    assert.equal(restored.evidence, "projection_incomplete");
    assert.equal(restored.checkpointSequence, "3");
    assert.equal(restored.sourceSequenceHighWater, "5");
    assert.equal(restored.lag, "2");

    const retained = succeeded(owner.query(graphQueryRequest({
      claimSourceFactDigest: sources[0]!,
      evidenceSourceFactDigest: sources[2]!,
    })));
    assert.equal(retained.evidence, "path_found");
    assert.equal(retained.completeness, "incomplete");

    const otherVersion = succeeded(owner.query(graphQueryRequest({
      claimSourceFactDigest: sources[0]!,
      evidenceSourceFactDigest: sources[2]!,
      projectionVersion: "query-projection-v2",
    })));
    assert.equal(otherVersion.evidence, "projection_incomplete");
    assert.equal(otherVersion.checkpointSequence, "0");
    assert.equal(otherVersion.sourceSequenceHighWater, "5");
    assert.equal(
      fixture.db.prepare(
        `SELECT count(*) AS count FROM shared_state_graph_source
          WHERE namespace = ?`,
      ).get(GRAPH_NAMESPACE)?.count,
      5,
    );
  } finally {
    disposeFixture(fixture);
  }
});

test("returns closed unavailable for a busy writer and lost ownership", () => {
  const locked = makeFixture();
  const blocker = new DatabaseSync(locked.path);
  try {
    const owner = readyAdapter(locked.db);
    const request = graphQueryRequest({
      claimSourceFactDigest: sourceFactDigest(1, "Claim"),
      evidenceSourceFactDigest: sourceFactDigest(2, "Source"),
    });
    blocker.exec("BEGIN IMMEDIATE");
    assert.equal(unavailable(owner.query(request)), "lock_timeout");
    blocker.exec("ROLLBACK");
  } finally {
    disposeFixture(locked, [blocker]);
  }

  const lost = makeFixture();
  try {
    const owner = readyAdapter(lost.db);
    lost.db
      .prepare(`UPDATE shared_state_ownership SET owner_token = ? WHERE id = ?`)
      .run("graph-query-owner-b", SHARED_STATE_SQLITE_ADAPTER_V1.ownershipRowId);
    const request = graphQueryRequest({
      claimSourceFactDigest: sourceFactDigest(1, "Claim"),
      evidenceSourceFactDigest: sourceFactDigest(2, "Source"),
    });
    assert.equal(unavailable(owner.query(request)), "lost_ownership");
    assert.equal(owner.lifecycle()?.state, "failed");
  } finally {
    disposeFixture(lost);
  }
});

test("does not emit graph judgments from malformed durable state", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    const sources = seedSources(owner, ["Claim", "Source", "Artifact"]);
    transact(owner, applyBatchCommand({
      batchId: "one",
      from: 1,
      through: 3,
      expectedCheckpoint: 0,
    }), 2_000);
    fixture.db
      .prepare(
        `UPDATE shared_state_graph_source SET source_sequence = ?
          WHERE namespace = ? AND source_fact_digest = ?`,
      )
      .run("03", GRAPH_NAMESPACE, sources[2]);

    assert.equal(
      unavailable(owner.query(graphQueryRequest({
        claimSourceFactDigest: sources[0]!,
        evidenceSourceFactDigest: sources[2]!,
      }))),
      "authority_unavailable",
    );
  } finally {
    disposeFixture(fixture);
  }
});

test("keeps graph reads outside the pre-open lifecycle", () => {
  const fixture = makeFixture();
  try {
    const owner = new SharedStateSqliteAdapterV1({
      db: fixture.db,
      ownerToken: "graph-query-owner-a",
      backwardSkewToleranceMs: "0",
    });
    const result = owner.query(graphQueryRequest({
      claimSourceFactDigest: sourceFactDigest(1, "Claim"),
      evidenceSourceFactDigest: sourceFactDigest(2, "Source"),
    }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "not_ready");
  } finally {
    disposeFixture(fixture);
  }
});
