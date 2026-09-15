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

type HighWaterQueryRequestV1 = Extract<
  SharedStateQueryRequestV1,
  { readonly operation: "queryGraphSourceHighWater" }
>;

type HighWaterQuerySucceededV1 = Extract<
  SharedStateQueryResultV1,
  {
    readonly operation: "queryGraphSourceHighWater";
    readonly status: "succeeded";
  }
>["result"];

function highWaterQueryRequest(
  namespace: string = HIGH_WATER_NAMESPACE,
): HighWaterQueryRequestV1 {
  const parsed = parseSharedStateQueryRequestV1({
    kind: V.kinds.queryRequest,
    contractVersion: V.versions.contract,
    queryVersion: V.versions.query,
    operation: "queryGraphSourceHighWater",
    input: {
      namespace,
      requiredConsistency: V.queryConsistency.queryGraphSourceHighWater,
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.value.operation !== "queryGraphSourceHighWater") {
    throw new Error("unreachable");
  }
  return parsed.value;
}

function highWaterSucceeded(
  result: SharedStateSqliteAdapterResultV1<SharedStateQueryResultV1>,
): HighWaterQuerySucceededV1 {
  const value = queryValue(result);
  assert.equal(value.operation, "queryGraphSourceHighWater");
  assert.equal(value.status, "succeeded");
  if (
    value.operation !== "queryGraphSourceHighWater"
    || value.status !== "succeeded"
  ) {
    throw new Error("unreachable");
  }
  assert.deepEqual(
    value.achievedConsistency,
    V.queryConsistency.queryGraphSourceHighWater,
  );
  return value.result;
}

function highWaterUnavailable(
  result: SharedStateSqliteAdapterResultV1<SharedStateQueryResultV1>,
): string {
  const value = queryValue(result);
  assert.equal(value.operation, "queryGraphSourceHighWater");
  assert.equal(value.status, "unavailable");
  if (
    value.operation !== "queryGraphSourceHighWater"
    || value.status !== "unavailable"
  ) {
    throw new Error("unreachable");
  }
  assert.equal(value.achievedConsistency, null);
  return value.reasonCode;
}

test("pins all three closed SQLite query operations and an empty complete graph", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    assert.deepEqual(SHARED_STATE_SQLITE_QUERY_OPERATIONS_V1, [
      "reconcileOutbox",
      "queryGraphEvidencePath",
      "queryGraphSourceHighWater",
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

// --- #1504 cold-start resync: the closed `queryGraphSourceHighWater` read ---

// The high-water operation is bound to the one literal §5.6 namespace the
// fence and gate share, NOT the per-fixture graph namespace above.
const HIGH_WATER_NAMESPACE = "broker.claim-graph";
const HIGH_WATER_PROJECTION = "high-water-projection-v1";

function highWaterDigest(
  domain: string,
  components: readonly Record<string, unknown>[],
): string {
  const built = digestSharedStateKeyV1({
    keyspaceVersion: V.versions.keyspace,
    domain,
    namespace: HIGH_WATER_NAMESPACE,
    components,
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error("unreachable");
  return built.value.digest;
}

function highWaterFactDigest(index: number): string {
  return highWaterDigest("broker.claim-graph.source-fact", [
    { field: "nodeType", type: "utf8", value: "AgentRun" },
    { field: "fact", type: "bytes", value: index.toString(16).padStart(4, "0") },
  ]);
}

function highWaterStreamKey(streamId: string): string {
  return highWaterDigest("broker.claim-graph.source-stream-key", [
    { field: "sourceType", type: "utf8", value: "high-water-test" },
    { field: "sourceId", type: "utf8", value: streamId },
  ]);
}

function highWaterAppendCommand(
  index: number,
  expected: string,
  streamId = "authority-a",
): GraphCommandV1<"appendGraphSource"> {
  return graphCommand("appendGraphSource", {
    namespace: HIGH_WATER_NAMESPACE,
    sourceStreamKeyDigest: highWaterStreamKey(streamId),
    sourceFactDigest: highWaterFactDigest(index),
    nodeType: "AgentRun",
    expectedSourceSequence: expected,
  });
}

function seedHighWaterSources(
  owner: SharedStateSqliteAdapterV1,
  count: number,
  streamId = "authority-a",
): bigint {
  let high = 0n;
  for (let index = 1; index <= count; index += 1) {
    const committed = transact(
      owner,
      highWaterAppendCommand(index, high.toString(), streamId),
      3_000 + index,
    );
    high += 1n;
    assert.equal(committed.sourceSequence, high.toString());
  }
  return high;
}

function observedHighWater(
  owner: SharedStateSqliteAdapterV1,
): HighWaterQuerySucceededV1 {
  return highWaterSucceeded(owner.query(highWaterQueryRequest()));
}

function storedSequenceCount(db: DatabaseSync, namespace: string): number {
  return (db.prepare(
    `SELECT COUNT(*) AS count FROM shared_state_graph_source WHERE namespace = ?`,
  ).get(namespace) as { count: number }).count;
}

function insertRawSourceRow(
  db: DatabaseSync,
  factDigest: string,
  sourceSequence: string,
  namespace = HIGH_WATER_NAMESPACE,
): void {
  db.prepare(
    `INSERT INTO shared_state_graph_source
       (namespace, source_fact_digest, source_stream_key_digest,
        node_type, source_sequence)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    namespace,
    factDigest,
    highWaterStreamKey("raw-seed"),
    "AgentRun",
    sourceSequence,
  );
}

test("high-water: an empty real SQLite namespace observes canonical zero", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    assert.deepEqual(observedHighWater(owner), {
      namespace: HIGH_WATER_NAMESPACE,
      sourceSequenceHighWater: "0",
    });
    // The read allocated nothing.
    assert.equal(storedSequenceCount(fixture.db, HIGH_WATER_NAMESPACE), 0);
  } finally {
    disposeFixture(fixture);
  }
});

test("high-water: real appends above nine, replay stays original, a second authority advances, reopen persists", () => {
  const fixture = makeFixture();
  let closed = false;
  try {
    const owner = readyAdapter(fixture.db);
    const seeded = seedHighWaterSources(owner, 12);
    assert.equal(seeded, 12n);
    assert.equal(observedHighWater(owner).sourceSequenceHighWater, "12");

    // Replay of an OLD fact: the adapter answers the original sequence
    // regardless of the stale expectation, and the high-water does not move.
    const replayed = transact(
      owner,
      highWaterAppendCommand(1, "0"),
      4_000,
    );
    assert.equal(replayed.decision, "replayed");
    assert.equal(replayed.sourceSequence, "1");
    assert.equal(observedHighWater(owner).sourceSequenceHighWater, "12");

    // A second append authority on a DIFFERENT source stream advances the
    // same namespace: the read spans streams, the max is namespace-wide.
    const other = transact(
      owner,
      highWaterAppendCommand(101, "12", "authority-b"),
      4_001,
    );
    assert.equal(other.decision, "appended");
    assert.equal(other.sourceSequence, "13");
    assert.equal(observedHighWater(owner).sourceSequenceHighWater, "13");

    // Reopen the same SQLite file: the namespace high-water persists.
    // Release ownership cleanly first (drain + close), as a real restart does.
    assert.equal(owner.drain().ok, true);
    assert.equal(owner.close().ok, true);
    fixture.db.close();
    closed = true;
    const reopened = new DatabaseSync(fixture.path);
    try {
      const owner2 = new SharedStateSqliteAdapterV1({
        db: reopened,
        ownerToken: "graph-query-owner-reopen",
        backwardSkewToleranceMs: "0",
      });
      assert.equal(owner2.open().ok, true);
      assert.equal(observedHighWater(owner2).sourceSequenceHighWater, "13");
    } finally {
      reopened.close();
    }
  } finally {
    if (!closed) fixture.db.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("high-water: labeled direct sparse fixture above MAX_SAFE_INTEGER — greatest canonical sequence, not COUNT, not TEXT order", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    // Sparse direct seeds: gaps everywhere, TEXT order would pick "9" over
    // "10", and COUNT would answer 4. The true maximum is 2^53 + 1.
    insertRawSourceRow(fixture.db, highWaterFactDigest(1), "1");
    insertRawSourceRow(fixture.db, highWaterFactDigest(9), "9");
    insertRawSourceRow(fixture.db, highWaterFactDigest(10), "10");
    insertRawSourceRow(
      fixture.db,
      highWaterFactDigest(9007199254740993),
      "9007199254740993",
    );

    assert.equal(
      observedHighWater(owner).sourceSequenceHighWater,
      "9007199254740993",
    );
  } finally {
    disposeFixture(fixture);
  }
});

test("high-water: ANY malformed stored sequence in the namespace fails closed without mutation", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    insertRawSourceRow(fixture.db, highWaterFactDigest(1), "1");
    insertRawSourceRow(fixture.db, highWaterFactDigest(2), "2");
    const before = () =>
      fixture.db.prepare(
        `SELECT source_fact_digest, source_sequence
           FROM shared_state_graph_source WHERE namespace = ?
          ORDER BY source_fact_digest`,
      ).all(HIGH_WATER_NAMESPACE);

    for (const malformed of ["0", "007", "-5", "1.5", "9".repeat(41), "", "1e3"]) {
      // Corrupt a NON-maximum row: a valid maximum elsewhere must not
      // rehabilitate the scoped read.
      fixture.db
        .prepare(
          `UPDATE shared_state_graph_source SET source_sequence = ?
            WHERE namespace = ? AND source_fact_digest = ?`,
        )
        .run(malformed, HIGH_WATER_NAMESPACE, highWaterFactDigest(1));
      const corruptedOne = before();
      assert.equal(
        highWaterUnavailable(owner.query(highWaterQueryRequest())),
        "authority_unavailable",
        `expected fail-closed for ${JSON.stringify(malformed)}`,
      );
      // The failed read itself mutated nothing.
      assert.deepEqual(before(), corruptedOne);
      // And corrupting the maximum row fails the same way.
      fixture.db
        .prepare(
          `UPDATE shared_state_graph_source SET source_sequence = ?
            WHERE namespace = ? AND source_fact_digest = ?`,
        )
        .run(malformed, HIGH_WATER_NAMESPACE, highWaterFactDigest(2));
      const corruptedBoth = before();
      assert.equal(
        highWaterUnavailable(owner.query(highWaterQueryRequest())),
        "authority_unavailable",
      );
      assert.deepEqual(before(), corruptedBoth);
      // Restore both rows for the next case.
      fixture.db
        .prepare(
          `UPDATE shared_state_graph_source SET source_sequence = ?
            WHERE namespace = ? AND source_fact_digest = ?`,
        )
        .run("1", HIGH_WATER_NAMESPACE, highWaterFactDigest(1));
      fixture.db
        .prepare(
          `UPDATE shared_state_graph_source SET source_sequence = ?
            WHERE namespace = ? AND source_fact_digest = ?`,
        )
        .run("2", HIGH_WATER_NAMESPACE, highWaterFactDigest(2));
    }

    // Values are never normalized: after the read, the store still holds
    // exactly the canonical rows, and the read recovers to the true maximum.
    assert.equal(observedHighWater(owner).sourceSequenceHighWater, "2");
  } finally {
    disposeFixture(fixture);
  }
});

test("high-water: unrelated namespaces never affect the scoped read", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    insertRawSourceRow(fixture.db, highWaterFactDigest(5), "5");
    // Malformed rows in OTHER namespaces are outside this scoped read.
    insertRawSourceRow(fixture.db, "other-fact-1", "007", "broker.claim-graph.other");
    insertRawSourceRow(fixture.db, "other-fact-2", "999", "broker.claim-graph.aux");
    assert.equal(
      observedHighWater(owner).sourceSequenceHighWater,
      "5",
    );
    assert.equal(storedSequenceCount(fixture.db, "broker.claim-graph"), 1);
  } finally {
    disposeFixture(fixture);
  }
});

test("high-water: projection rollback leaves the source high-water untouched; the read recovers after a lock is released", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    const seeded = seedHighWaterSources(owner, 3);
    assert.equal(seeded, 3n);

    const batchKey = highWaterDigest("broker.claim-graph.projection-batch-key", [
      { field: "projectionVersion", type: "utf8", value: HIGH_WATER_PROJECTION },
      { field: "batchId", type: "utf8", value: "batch-one" },
    ]);
    const inverse = highWaterDigest("broker.claim-graph.projection-inverse", [
      { field: "inverse", type: "bytes", value: "696e7665727365" },
    ]);
    transact(
      owner,
      graphCommand("applyGraphProjectionBatch", {
        namespace: HIGH_WATER_NAMESPACE,
        projectionVersion: HIGH_WATER_PROJECTION,
        batchKeyDigest: batchKey,
        batchDigest: highWaterDigest("broker.claim-graph.projection-batch", [
          { field: "batch", type: "bytes", value: "62617463682d6f6e65" },
        ]),
        inverseDigest: inverse,
        sourceSequenceFrom: "1",
        sourceSequenceThrough: "3",
        expectedCheckpointSequence: "0",
      }),
      5_000,
    );
    transact(
      owner,
      graphCommand("rollbackGraphProjectionBatch", {
        namespace: HIGH_WATER_NAMESPACE,
        projectionVersion: HIGH_WATER_PROJECTION,
        batchKeyDigest: batchKey,
        rollbackBatchKeyDigest: highWaterDigest(
          "broker.claim-graph.rollback-batch-key",
          [
            { field: "projectionVersion", type: "utf8", value: HIGH_WATER_PROJECTION },
            { field: "rollbackId", type: "utf8", value: "rollback-one" },
          ],
        ),
        inverseDigest: inverse,
        expectedCheckpointSequence: "3",
      }),
      5_001,
    );

    // A valid rollback restores the CHECKPOINT; immutable source facts — and
    // therefore the namespace source high-water — are untouched.
    assert.equal(observedHighWater(owner).sourceSequenceHighWater, "3");
  } finally {
    disposeFixture(fixture);
  }

  // Recovery where valid: once the conflicting writer releases the lock,
  // the same read succeeds against the unchanged store.
  const locked = makeFixture();
  const blocker = new DatabaseSync(locked.path);
  try {
    const owner = readyAdapter(locked.db);
    insertRawSourceRow(locked.db, highWaterFactDigest(7), "7");
    blocker.exec("BEGIN IMMEDIATE");
    assert.equal(
      highWaterUnavailable(owner.query(highWaterQueryRequest())),
      "lock_timeout",
    );
    blocker.exec("ROLLBACK");
    assert.equal(observedHighWater(owner).sourceSequenceHighWater, "7");
    assert.equal(storedSequenceCount(locked.db, HIGH_WATER_NAMESPACE), 1);
  } finally {
    disposeFixture(locked, [blocker]);
  }
});

test("high-water: lost ownership and a released adapter fail closed without mutation", () => {
  const lost = makeFixture();
  try {
    const owner = readyAdapter(lost.db);
    insertRawSourceRow(lost.db, highWaterFactDigest(2), "2");
    lost.db
      .prepare(`UPDATE shared_state_ownership SET owner_token = ? WHERE id = ?`)
      .run("graph-query-owner-b", SHARED_STATE_SQLITE_ADAPTER_V1.ownershipRowId);
    assert.equal(
      highWaterUnavailable(owner.query(highWaterQueryRequest())),
      "lost_ownership",
    );
    assert.equal(owner.lifecycle()?.state, "failed");
    assert.equal(storedSequenceCount(lost.db, HIGH_WATER_NAMESPACE), 1);
  } finally {
    disposeFixture(lost);
  }

  const released = makeFixture();
  try {
    const owner = readyAdapter(released.db);
    insertRawSourceRow(released.db, highWaterFactDigest(2), "2");
    assert.equal(owner.drain().ok, true);
    assert.equal(owner.close().ok, true);
    const result = owner.query(highWaterQueryRequest());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "not_ready");
    assert.equal(storedSequenceCount(released.db, HIGH_WATER_NAMESPACE), 1);
  } finally {
    disposeFixture(released);
  }
});


test("high-water: a zero source row is corruption, not an empty namespace", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    assert.equal(observedHighWater(owner).sourceSequenceHighWater, "0");
    insertRawSourceRow(fixture.db, highWaterFactDigest(1), "0");
    const before = fixture.db.prepare("SELECT * FROM shared_state_graph_source").all();
    assert.equal(highWaterUnavailable(owner.query(highWaterQueryRequest())), "authority_unavailable");
    assert.deepEqual(fixture.db.prepare("SELECT * FROM shared_state_graph_source").all(), before);
    fixture.db.prepare("UPDATE shared_state_graph_source SET source_sequence = '1' WHERE namespace = ?").run(HIGH_WATER_NAMESPACE);
    assert.equal(observedHighWater(owner).sourceSequenceHighWater, "1");
  } finally {
    disposeFixture(fixture);
  }
});
