/**
 * #2081 phase 2: graph evidence-path query scaling.
 *
 * Phase 1 added the two graph indexes (`shared_state_graph_batch_live_idx`,
 * `shared_state_graph_source_seq_idx`); phase 2 wires the query to them:
 *
 * - only LIVE batches are read (`rolled_back = 0`);
 * - the source rows are fetched over exactly the range the live batches tile
 *   (`[1, checkpoint]`), not the whole namespace — the live chain pins the
 *   range, so a corrupt row above the checkpoint is no longer observed here
 *   (the same separation the phase-1 keyset page drew; the whole-namespace
 *   audit stays in the conformance harnesses);
 * - the high-water mark is an index-only COUNT instead of a full
 *   materialize-and-validate.
 *
 * The tests pin the plan (index-backed, never a table scan), the answers
 * (identical to the semantics the graph suites pin), and both sides of the
 * trade-off: corruption inside the tiled range still fails closed, corruption
 * above the checkpoint no longer does.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
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

const NAMESPACE = "broker.claim-graph.scaling";
const PROJECTION_VERSION = "scaling-projection-v1";

function makeFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "shared-state-graph-scaling-"));
  const db = new DatabaseSync(join(directory, "v1.db"));
  assert.equal(applySharedStateSqliteSchemaV1(db).ok, true);
  return { db, directory };
}

function disposeFixture(fixture: Fixture): void {
  fixture.db.close();
  rmSync(fixture.directory, { recursive: true, force: true });
}

function readyAdapter(db: DatabaseSync): SharedStateSqliteAdapterV1 {
  const owner = new SharedStateSqliteAdapterV1({
    db,
    ownerToken: "graph-scaling-owner-a",
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
    namespace: NAMESPACE,
    components,
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error("unreachable");
  return built.value.digest;
}

function sourceFactDigest(ordinal: number): string {
  return digest("broker.claim-graph.source-fact", [
    { field: "nodeType", type: "utf8", value: "Claim" },
    {
      field: "fact",
      type: "bytes",
      value: ordinal.toString(16).padStart(2, "0"),
    },
  ]);
}

function graphCommand<Operation extends string>(
  operation: Operation,
  input: Record<string, unknown>,
): SharedStateTransactionCommandV1 {
  const parsed = parseSharedStateTransactionCommandV1({
    kind: V.kinds.transactionCommand,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation,
    input: { namespace: NAMESPACE, ...input },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.value;
}

function appendSourceCommand(ordinal: number): SharedStateTransactionCommandV1 {
  return graphCommand("appendGraphSource", {
    sourceStreamKeyDigest: digest("broker.claim-graph.source-stream-key", [
      { field: "sourceType", type: "utf8", value: "scaling" },
      { field: "sourceId", type: "utf8", value: "run-1" },
    ]),
    sourceFactDigest: sourceFactDigest(ordinal),
    nodeType: "Claim",
    expectedSourceSequence: String(ordinal - 1),
  });
}

function applyBatchCommand(input: {
  readonly batchId: string;
  readonly from: number;
  readonly through: number;
  readonly expectedCheckpoint: number;
}): SharedStateTransactionCommandV1 {
  const batchComponent = [
    {
      field: "batchId",
      type: "utf8" as const,
      value: input.batchId,
    },
  ];
  return graphCommand("applyGraphProjectionBatch", {
    projectionVersion: PROJECTION_VERSION,
    batchKeyDigest: digest("broker.claim-graph.projection-batch-key", [
      { field: "projectionVersion", type: "utf8", value: PROJECTION_VERSION },
      ...batchComponent,
    ]),
    batchDigest: digest("broker.claim-graph.projection-batch", [
      { field: "batch", type: "bytes", value: Buffer.from(input.batchId).toString("hex") },
    ]),
    inverseDigest: digest("broker.claim-graph.projection-inverse", [
      {
        field: "inverse",
        type: "bytes",
        value: Buffer.from(`inverse-${input.batchId}`).toString("hex"),
      },
    ]),
    sourceSequenceFrom: String(input.from),
    sourceSequenceThrough: String(input.through),
    expectedCheckpointSequence: String(input.expectedCheckpoint),
  });
}

function rollbackBatchCommand(input: {
  readonly batchId: string;
  readonly rollbackId: string;
  readonly expectedCheckpoint: number;
}): SharedStateTransactionCommandV1 {
  return graphCommand("rollbackGraphProjectionBatch", {
    projectionVersion: PROJECTION_VERSION,
    batchKeyDigest: digest("broker.claim-graph.projection-batch-key", [
      { field: "projectionVersion", type: "utf8", value: PROJECTION_VERSION },
      { field: "batchId", type: "utf8", value: input.batchId },
    ]),
    rollbackBatchKeyDigest: digest("broker.claim-graph.rollback-batch-key", [
      { field: "projectionVersion", type: "utf8", value: PROJECTION_VERSION },
      { field: "rollbackId", type: "utf8", value: input.rollbackId },
    ]),
    inverseDigest: digest("broker.claim-graph.projection-inverse", [
      {
        field: "inverse",
        type: "bytes",
        value: Buffer.from(`inverse-${input.batchId}`).toString("hex"),
      },
    ]),
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
): Record<string, unknown> {
  return committed(owner.transact(command, { observedAtUnixMs: "1000" }));
}

/** Appends `count` source facts, returning nothing; digests are derivable. */
function seedSources(
  owner: SharedStateSqliteAdapterV1,
  count: number,
): void {
  for (let ordinal = 1; ordinal <= count; ordinal += 1) {
    const result = transact(owner, appendSourceCommand(ordinal));
    assert.equal(result.sourceSequence, String(ordinal));
  }
}

function graphQueryRequest(input: {
  readonly claim: number;
  readonly evidence: number;
  readonly maxPathEdges?: number;
}): GraphQueryRequestV1 {
  const parsed = parseSharedStateQueryRequestV1({
    kind: V.kinds.queryRequest,
    contractVersion: V.versions.contract,
    queryVersion: V.versions.query,
    operation: "queryGraphEvidencePath",
    input: {
      namespace: NAMESPACE,
      projectionVersion: PROJECTION_VERSION,
      claimSourceFactDigest: sourceFactDigest(input.claim),
      evidenceSourceFactDigest: sourceFactDigest(input.evidence),
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

function succeededGraph(
  owner: SharedStateSqliteAdapterV1,
  request: GraphQueryRequestV1,
): GraphQuerySucceededV1 {
  const result = owner.query(request);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  if (
    result.value.operation !== "queryGraphEvidencePath"
    || result.value.status !== "succeeded"
  ) {
    assert.fail(`expected succeeded graph query, got ${result.value.status}`);
  }
  const value = result.value;
  assert.deepEqual(
    value.achievedConsistency,
    V.queryConsistency.queryGraphEvidencePath,
  );
  return value.result;
}

function unavailableGraph(
  owner: SharedStateSqliteAdapterV1,
  request: GraphQueryRequestV1,
): string {
  const result = owner.query(request);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  if (
    result.value.operation !== "queryGraphEvidencePath"
    || result.value.status !== "unavailable"
  ) {
    assert.fail(`expected unavailable, got ${result.value.status}`);
  }
  assert.equal(result.value.achievedConsistency, null);
  return result.value.reasonCode;
}

// ── plan: the reads are index-backed ───────────────────────────────────────

test("the graph query reads are index-backed (EXPLAIN QUERY PLAN)", () => {
  const fixture = makeFixture();
  try {
    const db = fixture.db;

    const batchPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN
           SELECT batch_key_digest, inverse_digest, source_sequence_from,
                  source_sequence_through, prior_checkpoint_sequence
             FROM shared_state_graph_batch
            WHERE namespace = ? AND projection_version = ?
              AND rolled_back = 0`,
      )
      .all(NAMESPACE, PROJECTION_VERSION) as Array<{ detail: string }>;
    assert.ok(
      batchPlan.some((row) =>
        row.detail.includes("shared_state_graph_batch_live_idx"),
      ),
      `expected the live-batch index: ${JSON.stringify(batchPlan)}`,
    );

    const sourcePlan = db
      .prepare(
        `EXPLAIN QUERY PLAN
           SELECT source_fact_digest, source_stream_key_digest, node_type,
                  source_sequence
             FROM shared_state_graph_source
            WHERE namespace = ?
              AND CAST(source_sequence AS INTEGER) BETWEEN 1 AND ?
            ORDER BY length(source_sequence), source_sequence`,
      )
      .all(NAMESPACE, "5") as Array<{ detail: string }>;
    assert.ok(
      sourcePlan.some((row) =>
        row.detail.includes("shared_state_graph_source_seq_idx"),
      ),
      `expected the source-sequence index: ${JSON.stringify(sourcePlan)}`,
    );
    assert.ok(
      sourcePlan.every((row) => !/SCAN shared_state_graph_source\b/.test(row.detail)),
      `must never table-scan the source ledger: ${JSON.stringify(sourcePlan)}`,
    );

    const countPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN
           SELECT COUNT(*) AS total
             FROM shared_state_graph_source
            WHERE namespace = ?`,
      )
      .all(NAMESPACE) as Array<{ detail: string }>;
    assert.ok(
      countPlan.some((row) => /SEARCH|SCAN.*INDEX/.test(row.detail)),
      `expected an index-only count: ${JSON.stringify(countPlan)}`,
    );
  } finally {
    disposeFixture(fixture);
  }
});

// ── answers: bounded reads preserve the pinned semantics ──────────────────

test("a query at a lagging checkpoint answers from the tiled range only", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    seedSources(owner, 6);
    transact(
      owner,
      applyBatchCommand({
        batchId: "b1",
        from: 1,
        through: 3,
        expectedCheckpoint: 0,
      }),
    );

    // Rows 4..6 exist but no live batch covers them yet: the path inside the
    // checkpoint is found, the evidence beyond it is not, and the completeness
    // fields expose the lag instead of hiding it.
    const within = succeededGraph(owner, graphQueryRequest({ claim: 1, evidence: 3 }));
    assert.equal(within.evidence, V.graphEvidenceResults[0]);
    assert.equal(within.completeness, "incomplete");
    assert.equal(within.asOfSourceSequence, "3");
    assert.equal(within.sourceSequenceHighWater, "6");
    assert.equal(within.lag, "3");
    // The pinned path shape: the evidence edge hangs off the BFS frontier, so
    // a batch edge [1..3] answers claim 1 → evidence 3 as one hop (same as
    // the graph suites pin).
    assert.deepEqual(within.sourcePath, [
      sourceFactDigest(1),
      sourceFactDigest(3),
    ]);

    const beyond = succeededGraph(owner, graphQueryRequest({ claim: 4, evidence: 5 }));
    assert.equal(beyond.evidence, V.graphEvidenceResults[2]);
    assert.equal(beyond.completeness, "incomplete");
    assert.deepEqual(beyond.sourcePath, []);
  } finally {
    disposeFixture(fixture);
  }
});

test("a rolled-back batch and its range drop out of the live read", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    seedSources(owner, 4);
    transact(
      owner,
      applyBatchCommand({ batchId: "b1", from: 1, through: 2, expectedCheckpoint: 0 }),
    );
    transact(
      owner,
      applyBatchCommand({ batchId: "b2", from: 3, through: 4, expectedCheckpoint: 2 }),
    );
    const rolled = transact(
      owner,
      rollbackBatchCommand({ batchId: "b2", rollbackId: "r1", expectedCheckpoint: 4 }),
    );
    assert.equal(rolled.checkpointSequence, "2");

    // The query reverts to the surviving live chain [1..2]; the rolled-back
    // batch's rows answer nothing, and the checkpoint went back with it.
    const within = succeededGraph(owner, graphQueryRequest({ claim: 1, evidence: 2 }));
    assert.equal(within.evidence, V.graphEvidenceResults[0]);
    assert.equal(within.checkpointSequence, "2");
    assert.equal(within.lag, "2");

    const rolledAway = succeededGraph(
      owner,
      graphQueryRequest({ claim: 3, evidence: 4 }),
    );
    assert.equal(rolledAway.evidence, V.graphEvidenceResults[2]);
  } finally {
    disposeFixture(fixture);
  }
});

// ── fail-closed: both sides of the bounded-read trade-off ─────────────────

test("corruption inside the tiled range still fails closed", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    seedSources(owner, 3);
    transact(
      owner,
      applyBatchCommand({ batchId: "b1", from: 1, through: 3, expectedCheckpoint: 0 }),
    );
    assert.ok(succeededGraph(owner, graphQueryRequest({ claim: 1, evidence: 3 })));

    // Non-canonical sequence on an IN-RANGE row: CAST still lands it inside
    // [1, checkpoint], so the bounded read observes it and refuses.
    fixture.db
      .prepare(
        `UPDATE shared_state_graph_source SET source_sequence = '03'
          WHERE namespace = ? AND source_fact_digest = ?`,
      )
      .run(NAMESPACE, sourceFactDigest(2));
    assert.equal(
      unavailableGraph(owner, graphQueryRequest({ claim: 1, evidence: 3 })),
      "authority_unavailable",
    );

    // A missing row the chain tiles over is equally observable.
    const fixture2 = makeFixture();
    try {
      const owner2 = readyAdapter(fixture2.db);
      seedSources(owner2, 3);
      transact(
        owner2,
        applyBatchCommand({ batchId: "b1", from: 1, through: 3, expectedCheckpoint: 0 }),
      );
      fixture2.db
        .prepare(
          `DELETE FROM shared_state_graph_source
            WHERE namespace = ? AND source_fact_digest = ?`,
        )
        .run(NAMESPACE, sourceFactDigest(2));
      assert.equal(
        unavailableGraph(owner2, graphQueryRequest({ claim: 1, evidence: 3 })),
        "authority_unavailable",
      );
    } finally {
      disposeFixture(fixture2);
    }
  } finally {
    disposeFixture(fixture);
  }
});

test("corruption above the checkpoint is no longer observed (audit moved to harnesses)", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    seedSources(owner, 6);
    transact(
      owner,
      applyBatchCommand({ batchId: "b1", from: 1, through: 3, expectedCheckpoint: 0 }),
    );
    // Row 5 sits above the checkpoint the live chain tiles to. The bounded
    // read never fetches it, so the closed query answers — the whole-namespace
    // ledger audit is the conformance harnesses' job, exactly like the
    // whole-stream outbox audit phase 1 moved.
    fixture.db
      .prepare(
        `UPDATE shared_state_graph_source SET source_sequence = 'not-a-number'
          WHERE namespace = ? AND source_fact_digest = ?`,
      )
      .run(NAMESPACE, sourceFactDigest(5));

    const result = succeededGraph(owner, graphQueryRequest({ claim: 1, evidence: 3 }));
    assert.equal(result.evidence, V.graphEvidenceResults[0]);
    assert.equal(result.sourceSequenceHighWater, "6");
    assert.equal(result.lag, "3");
  } finally {
    disposeFixture(fixture);
  }
});

test("a checkpoint above the high-water mark fails closed as unavailable", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    seedSources(owner, 2);
    transact(
      owner,
      applyBatchCommand({ batchId: "b1", from: 1, through: 2, expectedCheckpoint: 0 }),
    );
    fixture.db
      .prepare(
        `UPDATE shared_state_graph_projection SET checkpoint_sequence = '9'
          WHERE namespace = ? AND projection_version = ?`,
      )
      .run(NAMESPACE, PROJECTION_VERSION);
    assert.equal(
      unavailableGraph(owner, graphQueryRequest({ claim: 1, evidence: 2 })),
      "authority_unavailable",
    );
  } finally {
    disposeFixture(fixture);
  }
});
