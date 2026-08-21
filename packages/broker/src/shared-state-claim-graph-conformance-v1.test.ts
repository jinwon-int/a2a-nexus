/**
 * TEST-ONLY deterministic claim-graph projection reference model.
 *
 * This bounded in-memory model is non-production, non-SQLite, non-shared,
 * non-conforming, and detached from broker runtime. It exists only in this
 * adjacent test file to exercise the backend-neutral Phase 2.7 harness.
 * Its evidence-path method is a conformance control, not a V1 storage query
 * or runtime API — V1 registers no query operation. Source facts are append
 * -only and are never deleted, including by rollback.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1,
  SHARED_STATE_CLAIM_GRAPH_ERROR_CODES_V1,
  SHARED_STATE_CLAIM_GRAPH_EVIDENCE_JUDGMENTS_V1,
  SHARED_STATE_CLAIM_GRAPH_EVIDENCE_RESULTS_V1,
  SHARED_STATE_CLAIM_GRAPH_FAULT_POINTS_V1,
  SharedStateClaimGraphConformanceErrorV1,
  runSharedStateClaimGraphConformanceV1,
  seededDeterministicClaimGraphSourceOrderV1,
  sharedStateClaimGraphConformanceReportV1Schema,
  sharedStateClaimGraphConformanceSnapshotV1Schema,
  sharedStateClaimGraphErrorReportV1Schema,
  sharedStateClaimGraphEvidenceResultV1Schema,
  type SharedStateClaimGraphConformanceEvidenceQueryV1,
  type SharedStateClaimGraphConformanceTargetFactoryV1,
  type SharedStateClaimGraphConformanceTargetV1,
  type SharedStateClaimGraphFaultPointV1,
  type SharedStateClaimGraphNodeTypeV1,
} from "./shared-state-claim-graph-conformance-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateStorageLifecycleV1,
  parseSharedStateTransactionResultV1,
  type SharedStateStorageLifecycleV1,
  type SharedStateTransactionCommandV1,
} from "./shared-state-storage-contract-v1.js";

const TEST_ONLY_CLAIM_GRAPH_REFERENCE_MODEL_V1 = Object.freeze({
  label: "test-only-deterministic-claim-graph-reference-model",
  production: false,
  sqlite: false,
  shared: false,
  conforming: false,
  attachedToBrokerRuntime: false,
  durabilityClaim: "none",
  evidenceSeam: "test-only-control-not-a-v1-query",
  sourceFactsAppendOnly: true,
} as const);

function invariant(): never {
  throw new SharedStateClaimGraphConformanceErrorV1(
    "reference_model_invariant",
  );
}

interface SourceFact {
  readonly sourceFactDigest: string;
  readonly nodeType: SharedStateClaimGraphNodeTypeV1;
  readonly sourceSequence: bigint;
}

interface GraphNode {
  readonly nodeType: SharedStateClaimGraphNodeTypeV1;
  readonly sourceSequence: bigint;
  readonly batchKeyDigest: string;
}

interface GraphEdge {
  readonly fromSequence: bigint;
  readonly toSequence: bigint;
  readonly batchKeyDigest: string;
  tombstoned: boolean;
}

interface AppliedBatch {
  readonly batchKeyDigest: string;
  readonly sourceSequenceFrom: bigint;
  readonly sourceSequenceThrough: bigint;
  readonly priorCheckpoint: bigint;
  rolledBack: boolean;
}

/**
 * Adversarial controls exist only to prove the harness fails closed. Each one
 * makes the model violate exactly one Phase 2.7 claim.
 */
interface TestOnlyAdversarialClaimGraphControlV1 {
  readonly checkpointAdvancesOnFault?: boolean;
  readonly rollbackDeletesSourceFacts?: boolean;
  readonly negativeEvidenceWhileIncomplete?: boolean;
  readonly rollbackLeavesFalseEdge?: boolean;
  readonly reapplyDuplicatesEffect?: boolean;
}

function lifecycleEnvelope(
  state: "ready" | "closed",
  reasonCodes: readonly "close_requested"[],
): SharedStateStorageLifecycleV1 {
  const parsed = parseSharedStateStorageLifecycleV1({
    kind: V.kinds.lifecycle,
    lifecycleVersion: V.versions.lifecycle,
    contractVersion: V.versions.contract,
    state,
    reasonCodes,
  });
  if (!parsed.ok) return invariant();
  return parsed.value;
}

function transactionResult(
  operation: SharedStateTransactionCommandV1["operation"],
  body: Record<string, unknown>,
): unknown {
  const parsed = parseSharedStateTransactionResultV1({
    kind: V.kinds.transactionResult,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation,
    consistency: V.operationConsistency[operation],
    ...body,
  });
  if (!parsed.ok || parsed.value.operation !== operation) {
    return invariant();
  }
  return parsed.value;
}

function committed(
  operation: SharedStateTransactionCommandV1["operation"],
  result: Record<string, unknown>,
): unknown {
  return transactionResult(operation, {
    status: "committed",
    completeness: "complete",
    result,
  });
}

function rejected(
  operation: SharedStateTransactionCommandV1["operation"],
  reasonCode: string,
): unknown {
  return transactionResult(operation, {
    status: "rejected",
    completeness: "complete",
    reasonCode,
  });
}

function unavailable(
  operation: SharedStateTransactionCommandV1["operation"],
): unknown {
  return transactionResult(operation, {
    status: "unavailable",
    completeness: "unavailable",
    reasonCode: "authority_unavailable",
  });
}

class TestOnlyDeterministicClaimGraphReferenceModelV1
implements SharedStateClaimGraphConformanceTargetV1 {
  readonly #adversarial: TestOnlyAdversarialClaimGraphControlV1;
  readonly #sources: SourceFact[] = [];
  readonly #nodes: GraphNode[] = [];
  readonly #edges: GraphEdge[] = [];
  readonly #batches = new Map<string, AppliedBatch>();
  readonly #rollbacks = new Set<string>();
  #sourceSequence = 0n;
  #checkpoint = 0n;
  #armedFault: SharedStateClaimGraphFaultPointV1 | null = null;
  #authorityUnavailable = false;
  #open = false;

  constructor(adversarial: TestOnlyAdversarialClaimGraphControlV1) {
    this.#adversarial = adversarial;
  }

  async open(): Promise<unknown> {
    this.#open = true;
    return lifecycleEnvelope("ready", []);
  }

  async close(): Promise<unknown> {
    this.#open = false;
    return lifecycleEnvelope("closed", ["close_requested"]);
  }

  async transact(
    command: SharedStateTransactionCommandV1,
  ): Promise<unknown> {
    if (!this.#open) return invariant();
    // A command issued with no armed fault is the clean retry: the authority
    // is reachable again. This is a test-only recovery control.
    if (this.#armedFault === null) this.#authorityUnavailable = false;
    switch (command.operation) {
      case "appendGraphSource":
        return this.#appendGraphSource(command.input);
      case "applyGraphProjectionBatch":
        return this.#applyBatch(command.input);
      case "rollbackGraphProjectionBatch":
        return this.#rollbackBatch(command.input);
      default:
        return invariant();
    }
  }

  #appendGraphSource(
    input: Extract<
      SharedStateTransactionCommandV1,
      { operation: "appendGraphSource" }
    >["input"],
  ): unknown {
    const existing = this.#sources.find(
      (source) => source.sourceFactDigest === input.sourceFactDigest,
    );
    if (existing !== undefined) {
      return committed("appendGraphSource", {
        decision: "replayed",
        sourceSequence: existing.sourceSequence.toString(),
      });
    }
    if (BigInt(input.expectedSourceSequence) !== this.#sourceSequence) {
      return rejected("appendGraphSource", "source_sequence_conflict");
    }
    this.#sourceSequence += 1n;
    this.#sources.push({
      sourceFactDigest: input.sourceFactDigest,
      nodeType: input.nodeType,
      sourceSequence: this.#sourceSequence,
    });
    return committed("appendGraphSource", {
      decision: "appended",
      sourceSequence: this.#sourceSequence.toString(),
    });
  }

  #applyBatch(
    input: Extract<
      SharedStateTransactionCommandV1,
      { operation: "applyGraphProjectionBatch" }
    >["input"],
  ): unknown {
    const existing = this.#batches.get(input.batchKeyDigest);
    if (existing !== undefined && !existing.rolledBack) {
      return committed("applyGraphProjectionBatch", {
        decision: "replayed",
        checkpointSequence: this.#checkpoint.toString(),
      });
    }
    if (existing !== undefined && existing.rolledBack) {
      // A rolled-back batch stays recorded; reapplying it is idempotent and
      // must not resurrect its inverse-removed effects.
      if (this.#adversarial.reapplyDuplicatesEffect === true) {
        this.#edges.push({
          fromSequence: existing.sourceSequenceFrom,
          toSequence: existing.sourceSequenceThrough,
          batchKeyDigest: input.batchKeyDigest,
          tombstoned: false,
        });
      }
      return committed("applyGraphProjectionBatch", {
        decision: "replayed",
        checkpointSequence: this.#checkpoint.toString(),
      });
    }
    const from = BigInt(input.sourceSequenceFrom);
    const through = BigInt(input.sourceSequenceThrough);
    if (through > this.#sourceSequence || from > through) {
      return rejected(
        "applyGraphProjectionBatch",
        "source_range_incomplete",
      );
    }
    if (BigInt(input.expectedCheckpointSequence) !== this.#checkpoint) {
      return rejected("applyGraphProjectionBatch", "checkpoint_conflict");
    }

    // Nodes and edges are written first, then the checkpoint advances. The
    // whole thing is one transaction: a fault before the checkpoint rolls the
    // node/edge writes back with it.
    const stagedNodes: GraphNode[] = [];
    const stagedEdges: GraphEdge[] = [];
    for (
      let sequence = from;
      sequence <= through;
      sequence += 1n
    ) {
      const source = this.#sources.find(
        (candidate) => candidate.sourceSequence === sequence,
      );
      if (source === undefined) return invariant();
      stagedNodes.push({
        nodeType: source.nodeType,
        sourceSequence: sequence,
        batchKeyDigest: input.batchKeyDigest,
      });
      if (sequence > from) {
        stagedEdges.push({
          fromSequence: from,
          toSequence: sequence,
          batchKeyDigest: input.batchKeyDigest,
          tombstoned: false,
        });
      }
    }

    if (this.#armedFault === "after-node-edge-writes-before-checkpoint") {
      this.#armedFault = null;
      this.#authorityUnavailable = true;
      if (this.#adversarial.checkpointAdvancesOnFault === true) {
        // Violation: the checkpoint moved without a committed batch.
        this.#nodes.push(...stagedNodes);
        this.#edges.push(...stagedEdges);
        this.#checkpoint = through;
      }
      return unavailable("applyGraphProjectionBatch");
    }

    this.#nodes.push(...stagedNodes);
    this.#edges.push(...stagedEdges);
    this.#checkpoint = through;
    this.#batches.set(input.batchKeyDigest, {
      batchKeyDigest: input.batchKeyDigest,
      sourceSequenceFrom: from,
      sourceSequenceThrough: through,
      priorCheckpoint: BigInt(input.expectedCheckpointSequence),
      rolledBack: false,
    });
    return committed("applyGraphProjectionBatch", {
      decision: "applied",
      checkpointSequence: this.#checkpoint.toString(),
    });
  }

  #rollbackBatch(
    input: Extract<
      SharedStateTransactionCommandV1,
      { operation: "rollbackGraphProjectionBatch" }
    >["input"],
  ): unknown {
    const batch = this.#batches.get(input.batchKeyDigest);
    if (batch === undefined) {
      return rejected(
        "rollbackGraphProjectionBatch",
        "projection_batch_not_found",
      );
    }
    if (
      batch.rolledBack
      && this.#rollbacks.has(input.rollbackBatchKeyDigest)
    ) {
      return committed("rollbackGraphProjectionBatch", {
        decision: "replayed",
        checkpointSequence: this.#checkpoint.toString(),
      });
    }
    if (BigInt(input.expectedCheckpointSequence) !== this.#checkpoint) {
      return rejected(
        "rollbackGraphProjectionBatch",
        "checkpoint_conflict",
      );
    }

    // Apply the recorded inverse: remove exactly this batch's nodes and
    // tombstone exactly its edges. Immutable source facts are untouched.
    for (let index = this.#nodes.length - 1; index >= 0; index -= 1) {
      if (this.#nodes[index]!.batchKeyDigest === input.batchKeyDigest) {
        this.#nodes.splice(index, 1);
      }
    }
    for (let index = this.#edges.length - 1; index >= 0; index -= 1) {
      const edge = this.#edges[index]!;
      if (edge.batchKeyDigest !== input.batchKeyDigest) continue;
      if (this.#adversarial.rollbackLeavesFalseEdge === true) {
        // Violation: the false merge survives its own rollback.
        continue;
      }
      this.#edges.splice(index, 1);
    }
    if (this.#adversarial.rollbackDeletesSourceFacts === true) {
      // Violation: rollback deleted immutable source truth.
      this.#sources.length = 0;
      this.#sourceSequence = 0n;
    }
    this.#checkpoint = batch.priorCheckpoint;
    batch.rolledBack = true;
    this.#rollbacks.add(input.rollbackBatchKeyDigest);
    return committed("rollbackGraphProjectionBatch", {
      decision: "rolled_back",
      checkpointSequence: this.#checkpoint.toString(),
    });
  }

  armConformanceProjectionFault(
    faultPoint: SharedStateClaimGraphFaultPointV1,
  ): void {
    this.#armedFault = faultPoint;
  }

  #completeness(): (typeof V.graphCompletenessStates)[number] {
    if (this.#authorityUnavailable) return "unavailable";
    return this.#checkpoint === this.#sourceSequence
      ? "complete"
      : "incomplete";
  }

  async captureConformanceSnapshot(): Promise<unknown> {
    return sharedStateClaimGraphConformanceSnapshotV1Schema.parse({
      kind: "SharedStateClaimGraphConformanceSnapshotV1",
      snapshotVersion: 1,
      sourceFactCount: this.#sources.length,
      sourceSequenceHighWater: this.#sourceSequence.toString(),
      nodeCount: this.#nodes.length,
      edgeCount: this.#edges.filter((edge) => !edge.tombstoned).length,
      tombstonedEdgeCount: this.#edges.filter((edge) => edge.tombstoned)
        .length,
      appliedBatchCount: [...this.#batches.values()].filter(
        (batch) => !batch.rolledBack,
      ).length,
      rolledBackBatchCount: [...this.#batches.values()].filter(
        (batch) => batch.rolledBack,
      ).length,
      checkpointSequence: this.#checkpoint.toString(),
      completeness: this.#completeness(),
      authorityState: this.#authorityUnavailable
        ? "unavailable"
        : "available",
    });
  }

  async evaluateConformanceEvidencePath(
    query: SharedStateClaimGraphConformanceEvidenceQueryV1,
  ): Promise<unknown> {
    const completeness = this.#completeness();
    const lag = Number(this.#sourceSequence - this.#checkpoint);
    const claimSequence = BigInt(query.claimOrdinal);
    const evidenceSequence = BigInt(query.evidenceOrdinal);
    const supporting = this.#edges.filter(
      (edge) =>
        !edge.tombstoned
        && edge.fromSequence === claimSequence
        && edge.toSequence === evidenceSequence,
    ).length;

    let result: (typeof SHARED_STATE_CLAIM_GRAPH_EVIDENCE_RESULTS_V1)[number];
    if (completeness === "unavailable") {
      result = "projection_unavailable";
    } else if (supporting > 0) {
      result = "path_found";
    } else if (
      completeness === "complete"
      || this.#adversarial.negativeEvidenceWhileIncomplete === true
    ) {
      // Spec 5.6 permits `no_evidence_path` only at a complete checkpoint.
      // The adversarial branch violates exactly that rule.
      result = "no_evidence_path";
    } else {
      result = "projection_incomplete";
    }

    return sharedStateClaimGraphEvidenceResultV1Schema.parse({
      kind: "SharedStateClaimGraphConformanceEvidenceResultV1",
      resultVersion: 1,
      scope: "test-only-claim-graph-conformance-control",
      result,
      completeness,
      asOfSourceSequence: this.#checkpoint.toString(),
      checkpointSequence: this.#checkpoint.toString(),
      sourceSequenceHighWater: this.#sourceSequence.toString(),
      lag: lag < 0 ? 0 : lag,
      supportingEdgeCount: supporting,
    });
  }
}

function createTestOnlyDeterministicClaimGraphFactoryV1(
  adversarial: TestOnlyAdversarialClaimGraphControlV1 = {},
): SharedStateClaimGraphConformanceTargetFactoryV1 {
  return Object.freeze({
    async create(): Promise<SharedStateClaimGraphConformanceTargetV1> {
      return new TestOnlyDeterministicClaimGraphReferenceModelV1(
        adversarial,
      );
    },
  });
}

function assertDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) assertDeepFrozen(nested);
}

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (value === null || typeof value !== "object") return keys;
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, keys);
    return keys;
  }
  for (const [key, nested] of Object.entries(value)) {
    keys.push(key);
    collectKeys(nested, keys);
  }
  return keys;
}

async function expectConformanceErrorCode(
  adversarial: TestOnlyAdversarialClaimGraphControlV1,
  expected: string,
): Promise<void> {
  await assert.rejects(
    runSharedStateClaimGraphConformanceV1(
      createTestOnlyDeterministicClaimGraphFactoryV1(adversarial),
    ),
    (error: unknown) => {
      assert.equal(
        error instanceof SharedStateClaimGraphConformanceErrorV1,
        true,
      );
      if (!(error instanceof SharedStateClaimGraphConformanceErrorV1)) {
        return false;
      }
      assert.equal(error.code, expected);
      return true;
    },
  );
}

test("labels the claim-graph model test-only with no query claim", () => {
  assert.deepEqual(TEST_ONLY_CLAIM_GRAPH_REFERENCE_MODEL_V1, {
    label: "test-only-deterministic-claim-graph-reference-model",
    production: false,
    sqlite: false,
    shared: false,
    conforming: false,
    attachedToBrokerRuntime: false,
    durabilityClaim: "none",
    evidenceSeam: "test-only-control-not-a-v1-query",
    sourceFactsAppendOnly: true,
  });
});

test("proves the exact bounded Phase 2.7 claim-graph slice", async () => {
  const report = await runSharedStateClaimGraphConformanceV1(
    createTestOnlyDeterministicClaimGraphFactoryV1(),
  );

  assert.equal(report.status, "passed");
  assert.equal(report.scope, "claim-graph-projection-rollback");
  assert.equal(report.contractVersion, V.versions.contract);

  assert.deepEqual(report.controls, {
    scheduler: "seeded-deterministic-serial",
    schedulerSeed: SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.schedulerSeed,
    concurrency: "not-exercised",
    barrier: "not-required",
    clock: "not-required",
    targetIsolation: "factory-created-per-scenario",
    targetCount: SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.targetCount,
    targetCommandLimit:
      SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.targetCommandLimit,
    targetCommandCount:
      SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.expectedTargetCommandCount,
    lifecycleLimit: SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.lifecycleLimit,
    lifecycleCount:
      SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.expectedLifecycleCount,
    snapshotControlLimit:
      SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.snapshotControlLimit,
    snapshotControlCount:
      SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.expectedSnapshotControlCount,
    faultControlCount:
      SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.faultControlCount,
    evidenceControlLimit:
      SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.evidenceControlLimit,
    evidenceControlCount:
      SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.expectedEvidenceControlCount,
  });

  // Every closed node type appears exactly once, with strictly increasing
  // source sequences.
  assert.equal(
    report.typedSources.entries.length,
    SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.typedSourceCount,
  );
  assert.deepEqual(
    [...report.typedSources.entries.map((entry) => entry.nodeType)].sort(),
    [...V.graphNodeTypes].sort(),
  );
  const sequences = report.typedSources.entries.map((entry) =>
    Number(entry.sourceSequence),
  );
  assert.deepEqual(sequences, [1, 2, 3, 4, 5, 6]);
  assert.equal(report.typedSources.nodeTypeCoverage,
    "exactly-the-closed-node-types");

  assert.deepEqual(report.atomicProjection, {
    decision: "applied",
    checkpointAdvancedTo: "6",
    batchBoundary: "separate-from-source-append",
    evidenceResult: "path_found",
    evidenceCompleteness: "complete",
    evidenceLag: 0,
    evidenceQueryInputs: "graph-and-source-references-only",
  });

  assert.deepEqual(report.pausedProjection, {
    pausedSourceCount:
      SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.pausedSourceCount,
    evidenceResult: "projection_incomplete",
    evidenceCompleteness: "incomplete",
    evidenceLag: SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.pausedSourceCount,
    checkpointUnchanged: true,
    negativeEvidenceWithheld: true,
    negativeEvidenceRequires: "complete-checkpoint",
    aheadOfHighWaterRejection: "source_range_incomplete",
  });

  assert.deepEqual(report.checkpointFault, {
    faultPoint: "after-node-edge-writes-before-checkpoint",
    attemptStatus: "unavailable",
    attemptReasonCode: "authority_unavailable",
    checkpointAdvanced: false,
    graphStateUnchanged: true,
    evidenceResultWhileUnavailable: "projection_unavailable",
    cleanRetryDecision: "applied",
    cleanRetryEffectCount: 1,
  });

  assert.deepEqual(report.falseMergeRollback, {
    priorEvidenceResult: "no_evidence_path",
    priorEvidenceCompleteness: "complete",
    falseMergeDecision: "applied",
    falseMergeEvidenceResult: "path_found",
    rollbackDecision: "rolled_back",
    rollbackMechanism: "recorded-inverse-tombstone-batch",
    priorGraphRestored: true,
    restoredEvidenceResult: "projection_incomplete",
    immutableSourceCountUnchanged: true,
    immutableSourceHighWaterUnchanged: true,
  });

  assert.deepEqual(report.idempotentReapply, {
    batchReapplyDecision: "replayed",
    rollbackReapplyDecision: "replayed",
    checkpointUnchangedOnReapply: true,
    duplicateEffectCount: 0,
  });

  assert.deepEqual(report.claims, {
    referenceModel: "test-only",
    adapterConformance: "not-claimed",
    runtimeIntegration: "none",
    storageQueryContract: "none",
    evidenceSeam: "test-only-control-not-a-v1-query",
    retentionPruneExecution: "not-executed",
    partitionUnavailableInjection: "out-of-scope",
  });

  assertDeepFrozen(report);
});

test("uses a stable seeded source order with no barrier", () => {
  const first = seededDeterministicClaimGraphSourceOrderV1();
  const second = seededDeterministicClaimGraphSourceOrderV1();
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual([...first].sort(), [...V.graphNodeTypes].sort());
});

test("fails closed on each adversarial claim-graph violation", async () => {
  // Item: a failure before the checkpoint must not advance the checkpoint.
  await expectConformanceErrorCode(
    { checkpointAdvancesOnFault: true },
    "checkpoint_advanced_on_fault",
  );
  // Item: rollback reverses the projection without deleting source truth.
  await expectConformanceErrorCode(
    { rollbackDeletesSourceFacts: true },
    "immutable_source_mutated",
  );
  // Spec 5.6: negative evidence requires a complete checkpoint.
  await expectConformanceErrorCode(
    { negativeEvidenceWhileIncomplete: true },
    "negative_evidence_before_complete_checkpoint",
  );
  // Item: the false merge must not survive its own inverse batch.
  await expectConformanceErrorCode(
    { rollbackLeavesFalseEdge: true },
    "rollback_restoration_mismatch",
  );
  // Item: reapplying a batch must be idempotent.
  await expectConformanceErrorCode(
    { reapplyDuplicatesEffect: true },
    "idempotent_reapply_mismatch",
  );
});

test(
  "keeps reports, snapshots, controls, and errors strict and non-reflecting",
  async () => {
    const report = await runSharedStateClaimGraphConformanceV1(
      createTestOnlyDeterministicClaimGraphFactoryV1(),
    );

    const forbiddenPublicKeys =
      /(?:identity|digest|namespace|prompt|payload|path|secret|endpoint|host|provider|worker|task|timestamp)/iu;
    assert.equal(
      collectKeys(report).some((key) => forbiddenPublicKeys.test(key)),
      false,
    );

    assert.equal(
      sharedStateClaimGraphConformanceReportV1Schema.safeParse({
        ...report,
        reflectedTargetError: "leaked",
      }).success,
      false,
    );
    assert.equal(
      sharedStateClaimGraphConformanceSnapshotV1Schema.safeParse({
        kind: "SharedStateClaimGraphConformanceSnapshotV1",
        snapshotVersion: 1,
        identityDigest: "leaked",
      }).success,
      false,
    );
    assert.equal(
      sharedStateClaimGraphEvidenceResultV1Schema.safeParse({
        kind: "SharedStateClaimGraphConformanceEvidenceResultV1",
        resultVersion: 1,
        scope: "test-only-claim-graph-conformance-control",
        result: "path_found",
        completeness: "complete",
        asOfSourceSequence: "1",
        checkpointSequence: "1",
        sourceSequenceHighWater: "1",
        lag: 0,
        supportingEdgeCount: 1,
        claimText: "leaked",
      }).success,
      false,
    );
    assert.equal(
      sharedStateClaimGraphErrorReportV1Schema.safeParse({
        kind: "SharedStateClaimGraphConformanceErrorV1",
        errorVersion: 1,
        code: "report_invalid",
        targetError: "leaked",
      }).success,
      false,
    );

    const sentinel = "sensitive-target-value";
    await assert.rejects(
      runSharedStateClaimGraphConformanceV1({
        async create() {
          throw new Error(sentinel);
        },
      }),
      (error: unknown) => {
        assert.equal(
          error instanceof SharedStateClaimGraphConformanceErrorV1,
          true,
        );
        if (!(error instanceof SharedStateClaimGraphConformanceErrorV1)) {
          return false;
        }
        assert.equal(error.code, "target_create_failed");
        assert.equal(error.message.includes(sentinel), false);
        assert.equal(error.stack?.includes(sentinel) ?? false, false);
        assert.deepEqual(error.toJSON(), {
          kind: "SharedStateClaimGraphConformanceErrorV1",
          errorVersion: 1,
          code: "target_create_failed",
        });
        assertDeepFrozen(error.toJSON());
        return true;
      },
    );
  },
);

test("pins the evidence vocabulary and existing graph decisions", () => {
  // Spec 5.6 names exactly these four results; only the first two are
  // evidence judgments.
  assert.deepEqual(
    [...SHARED_STATE_CLAIM_GRAPH_EVIDENCE_RESULTS_V1],
    [
      "path_found",
      "no_evidence_path",
      "projection_incomplete",
      "projection_unavailable",
    ],
  );
  assert.deepEqual(
    [...SHARED_STATE_CLAIM_GRAPH_EVIDENCE_JUDGMENTS_V1],
    ["path_found", "no_evidence_path"],
  );
  for (const judgment of SHARED_STATE_CLAIM_GRAPH_EVIDENCE_JUDGMENTS_V1) {
    assert.equal(
      SHARED_STATE_CLAIM_GRAPH_EVIDENCE_RESULTS_V1.includes(judgment),
      true,
    );
  }
  assert.deepEqual(
    [...SHARED_STATE_CLAIM_GRAPH_FAULT_POINTS_V1],
    ["after-node-edge-writes-before-checkpoint"],
  );

  // The harness reuses existing storage V1 vocabulary only.
  assert.deepEqual(
    [...V.graphNodeTypes],
    ["Entity", "Claim", "Source", "Artifact", "AgentRun", "Evaluation"],
  );
  assert.deepEqual(
    [...V.graphCompletenessStates],
    ["complete", "incomplete", "unavailable"],
  );
  assert.equal(
    V.completenessGuarantees.negativeEvidenceRequires,
    "complete-checkpoint",
  );
  assert.deepEqual(
    [...V.operationDecisions.rollbackGraphProjectionBatch],
    ["rolled_back", "replayed"],
  );
  assert.equal(
    V.operationRejectionReasonCodes.applyGraphProjectionBatch.includes(
      "source_range_incomplete",
    ),
    true,
  );
  assert.equal(
    new Set(SHARED_STATE_CLAIM_GRAPH_ERROR_CODES_V1).size,
    SHARED_STATE_CLAIM_GRAPH_ERROR_CODES_V1.length,
  );
});
