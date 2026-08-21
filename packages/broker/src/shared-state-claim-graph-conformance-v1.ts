/**
 * Backend-neutral deterministic claim-graph projection and rollback
 * conformance harness for `a2a.shared-state.storage/v1`.
 *
 * The harness reuses the existing storage V1 command/result/lifecycle
 * envelopes, keyspace digests, and closed graph node-type and completeness
 * vocabulary. It does not implement storage, a graph query API, projection
 * scheduling, clocks, health/readiness routes, migrations, or broker runtime
 * wiring.
 *
 * Snapshot, projection-fault, and evidence-path methods on the target seam are
 * bounded test-only conformance controls. They are not V1 adapter, storage
 * query, or runtime APIs. In particular V1 registers no query operation, so
 * the evidence-path seam exists only to observe the reference model.
 */

import { z } from "zod";

import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  digestSharedStateKeyV1,
  parseSharedStateStorageLifecycleV1,
  parseSharedStateTransactionCommandV1,
  parseSharedStateTransactionResultV1,
  type SharedStateStorageLifecycleV1,
  type SharedStateTransactionCommandV1,
  type SharedStateTransactionResultV1,
} from "./shared-state-storage-contract-v1.js";

export const SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1 = Object.freeze({
  kind: "SharedStateClaimGraphConformanceReportV1",
  harnessVersion: 1,
  scope: "claim-graph-projection-rollback",
  schedulerSeed: 1504,
  projectionVersion: "claim-graph-conformance.v1",
  typedSourceCount: 6,
  pausedSourceCount: 2,
  targetCount: 3,
  targetCommandLimit: 48,
  expectedTargetCommandCount: 31,
  lifecycleLimit: 16,
  expectedLifecycleCount: 6,
  snapshotControlLimit: 24,
  expectedSnapshotControlCount: 10,
  faultControlCount: 1,
  evidenceControlLimit: 12,
  expectedEvidenceControlCount: 6,
} as const);

/**
 * Spec section 5.6 requires the evaluator to distinguish exactly these four
 * results, and states that only the first two are evidence judgments. The
 * vocabulary is declared here because V1 registers no query operation; it is
 * harness-owned and is not a storage contract addition.
 */
export const SHARED_STATE_CLAIM_GRAPH_EVIDENCE_RESULTS_V1 = Object.freeze([
  "path_found",
  "no_evidence_path",
  "projection_incomplete",
  "projection_unavailable",
] as const);

export const SHARED_STATE_CLAIM_GRAPH_EVIDENCE_JUDGMENTS_V1 = Object.freeze([
  "path_found",
  "no_evidence_path",
] as const);

export const SHARED_STATE_CLAIM_GRAPH_FAULT_POINTS_V1 = Object.freeze([
  "after-node-edge-writes-before-checkpoint",
] as const);

export const SHARED_STATE_CLAIM_GRAPH_ERROR_CODES_V1 = Object.freeze([
  "invalid_generated_command",
  "invalid_target_result",
  "invalid_target_lifecycle",
  "invalid_conformance_snapshot",
  "invalid_conformance_evidence_result",
  "target_create_failed",
  "target_operation_failed",
  "target_lifecycle_failed",
  "target_snapshot_control_failed",
  "target_fault_control_failed",
  "target_evidence_control_failed",
  "operation_limit_exceeded",
  "node_type_coverage_mismatch",
  "source_provenance_mismatch",
  "projection_atomicity_mismatch",
  "evidence_path_mismatch",
  "negative_evidence_before_complete_checkpoint",
  "incomplete_projection_mismatch",
  "checkpoint_advanced_on_fault",
  "rollback_restoration_mismatch",
  "immutable_source_mutated",
  "idempotent_reapply_mismatch",
  "high_water_regression",
  "report_invalid",
  "reference_model_invariant",
] as const);

export type SharedStateClaimGraphEvidenceResultV1 =
  (typeof SHARED_STATE_CLAIM_GRAPH_EVIDENCE_RESULTS_V1)[number];
export type SharedStateClaimGraphFaultPointV1 =
  (typeof SHARED_STATE_CLAIM_GRAPH_FAULT_POINTS_V1)[number];
export type SharedStateClaimGraphErrorCodeV1 =
  (typeof SHARED_STATE_CLAIM_GRAPH_ERROR_CODES_V1)[number];
export type SharedStateClaimGraphNodeTypeV1 =
  (typeof V.graphNodeTypes)[number];

type Operation = SharedStateTransactionCommandV1["operation"];
type CommandFor<Selected extends Operation> = Extract<
  SharedStateTransactionCommandV1,
  { readonly operation: Selected }
>;
type ResultFor<Selected extends Operation> = Extract<
  SharedStateTransactionResultV1,
  { readonly operation: Selected }
>;

export const sharedStateClaimGraphErrorReportV1Schema = z
  .object({
    kind: z.literal("SharedStateClaimGraphConformanceErrorV1"),
    errorVersion: z.literal(1),
    code: z.enum(SHARED_STATE_CLAIM_GRAPH_ERROR_CODES_V1),
  })
  .strict();

export type SharedStateClaimGraphErrorReportV1 = Readonly<
  z.infer<typeof sharedStateClaimGraphErrorReportV1Schema>
>;

export class SharedStateClaimGraphConformanceErrorV1 extends Error {
  readonly code: SharedStateClaimGraphErrorCodeV1;
  readonly publicReport: SharedStateClaimGraphErrorReportV1;

  constructor(code: SharedStateClaimGraphErrorCodeV1) {
    super(code);
    this.name = "SharedStateClaimGraphConformanceErrorV1";
    this.code = code;
    this.publicReport = deepFreeze({
      kind: "SharedStateClaimGraphConformanceErrorV1",
      errorVersion: 1,
      code,
    } as const);
    this.stack = `${this.name}: ${code}`;
  }

  toJSON(): SharedStateClaimGraphErrorReportV1 {
    return this.publicReport;
  }
}

function fail(code: SharedStateClaimGraphErrorCodeV1): never {
  throw new SharedStateClaimGraphConformanceErrorV1(code);
}

const nonNegativeDecimalSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,39})$/);
const boundedCountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.targetCommandLimit);

/**
 * Strict aggregate snapshot returned only by the target's test-only
 * conformance control. It intentionally contains no identity, digest,
 * namespace, payload, time, backend, or reflected error value.
 */
export const sharedStateClaimGraphConformanceSnapshotV1Schema = z
  .object({
    kind: z.literal("SharedStateClaimGraphConformanceSnapshotV1"),
    snapshotVersion: z.literal(1),
    sourceFactCount: boundedCountSchema,
    sourceSequenceHighWater: nonNegativeDecimalSchema,
    nodeCount: boundedCountSchema,
    edgeCount: boundedCountSchema,
    tombstonedEdgeCount: boundedCountSchema,
    appliedBatchCount: boundedCountSchema,
    rolledBackBatchCount: boundedCountSchema,
    checkpointSequence: nonNegativeDecimalSchema,
    completeness: z.enum(V.graphCompletenessStates),
    authorityState: z.enum(["available", "unavailable"]),
  })
  .strict();

export type SharedStateClaimGraphConformanceSnapshotV1 = Readonly<
  z.infer<typeof sharedStateClaimGraphConformanceSnapshotV1Schema>
>;

/**
 * Bounded test-only evidence-path result. V1 registers no query operation, so
 * this shape is a conformance control and never a storage query contract.
 */
export const sharedStateClaimGraphEvidenceResultV1Schema = z
  .object({
    kind: z.literal("SharedStateClaimGraphConformanceEvidenceResultV1"),
    resultVersion: z.literal(1),
    scope: z.literal("test-only-claim-graph-conformance-control"),
    result: z.enum(SHARED_STATE_CLAIM_GRAPH_EVIDENCE_RESULTS_V1),
    completeness: z.enum(V.graphCompletenessStates),
    asOfSourceSequence: nonNegativeDecimalSchema,
    checkpointSequence: nonNegativeDecimalSchema,
    sourceSequenceHighWater: nonNegativeDecimalSchema,
    lag: boundedCountSchema,
    supportingEdgeCount: boundedCountSchema,
  })
  .strict();

export type SharedStateClaimGraphEvidenceResultV1Shape = Readonly<
  z.infer<typeof sharedStateClaimGraphEvidenceResultV1Schema>
>;

const typedSourceReportSchema = z
  .object({
    nodeType: z.enum(V.graphNodeTypes),
    appendRank: z
      .number()
      .int()
      .min(1)
      .max(SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.typedSourceCount),
    decision: z.literal("appended"),
    sourceSequence: nonNegativeDecimalSchema,
  })
  .strict();

export const sharedStateClaimGraphConformanceReportV1Schema = z
  .object({
    kind: z.literal(SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.kind),
    harnessVersion: z.literal(
      SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.harnessVersion,
    ),
    contractVersion: z.literal(V.versions.contract),
    scope: z.literal(SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.scope),
    status: z.literal("passed"),
    controls: z
      .object({
        scheduler: z.literal("seeded-deterministic-serial"),
        schedulerSeed: z.literal(
          SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.schedulerSeed,
        ),
        concurrency: z.literal("not-exercised"),
        barrier: z.literal("not-required"),
        clock: z.literal("not-required"),
        targetIsolation: z.literal("factory-created-per-scenario"),
        targetCount: z.literal(
          SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.targetCount,
        ),
        targetCommandLimit: z.literal(
          SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.targetCommandLimit,
        ),
        targetCommandCount: boundedCountSchema,
        lifecycleLimit: z.literal(
          SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.lifecycleLimit,
        ),
        lifecycleCount: boundedCountSchema,
        snapshotControlLimit: z.literal(
          SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.snapshotControlLimit,
        ),
        snapshotControlCount: boundedCountSchema,
        faultControlCount: z.literal(
          SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.faultControlCount,
        ),
        evidenceControlLimit: z.literal(
          SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.evidenceControlLimit,
        ),
        evidenceControlCount: boundedCountSchema,
      })
      .strict(),
    typedSources: z
      .object({
        nodeTypeCoverage: z.literal("exactly-the-closed-node-types"),
        count: z.literal(
          SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.typedSourceCount,
        ),
        sequencesStrictlyIncreasing: z.literal(true),
        provenanceBinding: z.literal("stream-key-and-fact-digest"),
        entries: z
          .array(typedSourceReportSchema)
          .length(SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.typedSourceCount),
      })
      .strict(),
    atomicProjection: z
      .object({
        decision: z.literal("applied"),
        checkpointAdvancedTo: nonNegativeDecimalSchema,
        batchBoundary: z.literal("separate-from-source-append"),
        evidenceResult: z.literal("path_found"),
        evidenceCompleteness: z.literal("complete"),
        evidenceLag: z.literal(0),
        evidenceQueryInputs: z.literal("graph-and-source-references-only"),
      })
      .strict(),
    pausedProjection: z
      .object({
        pausedSourceCount: z.literal(
          SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.pausedSourceCount,
        ),
        evidenceResult: z.literal("projection_incomplete"),
        evidenceCompleteness: z.literal("incomplete"),
        evidenceLag: z.literal(
          SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.pausedSourceCount,
        ),
        checkpointUnchanged: z.literal(true),
        negativeEvidenceWithheld: z.literal(true),
        negativeEvidenceRequires: z.literal(
          V.completenessGuarantees.negativeEvidenceRequires,
        ),
        aheadOfHighWaterRejection: z.literal("source_range_incomplete"),
      })
      .strict(),
    checkpointFault: z
      .object({
        faultPoint: z.literal(
          "after-node-edge-writes-before-checkpoint",
        ),
        attemptStatus: z.literal("unavailable"),
        attemptReasonCode: z.literal("authority_unavailable"),
        checkpointAdvanced: z.literal(false),
        graphStateUnchanged: z.literal(true),
        evidenceResultWhileUnavailable: z.literal("projection_unavailable"),
        cleanRetryDecision: z.literal("applied"),
        cleanRetryEffectCount: z.literal(1),
      })
      .strict(),
    falseMergeRollback: z
      .object({
        priorEvidenceResult: z.literal("no_evidence_path"),
        priorEvidenceCompleteness: z.literal("complete"),
        falseMergeDecision: z.literal("applied"),
        falseMergeEvidenceResult: z.literal("path_found"),
        rollbackDecision: z.literal("rolled_back"),
        rollbackMechanism: z.literal("recorded-inverse-tombstone-batch"),
        priorGraphRestored: z.literal(true),
        restoredEvidenceResult: z.literal("projection_incomplete"),
        immutableSourceCountUnchanged: z.literal(true),
        immutableSourceHighWaterUnchanged: z.literal(true),
      })
      .strict(),
    idempotentReapply: z
      .object({
        batchReapplyDecision: z.literal("replayed"),
        rollbackReapplyDecision: z.literal("replayed"),
        checkpointUnchangedOnReapply: z.literal(true),
        duplicateEffectCount: z.literal(0),
      })
      .strict(),
    monotonicity: z
      .object({
        sourceSequenceHighWater: z.literal("nondecreasing"),
        immutableSourceFacts: z.literal("never-deleted"),
      })
      .strict(),
    claims: z
      .object({
        referenceModel: z.literal("test-only"),
        adapterConformance: z.literal("not-claimed"),
        runtimeIntegration: z.literal("none"),
        storageQueryContract: z.literal("none"),
        evidenceSeam: z.literal("test-only-control-not-a-v1-query"),
        retentionPruneExecution: z.literal("not-executed"),
        partitionUnavailableInjection: z.literal("out-of-scope"),
      })
      .strict(),
  })
  .strict();

export type SharedStateClaimGraphConformanceReportV1 = Readonly<
  z.infer<typeof sharedStateClaimGraphConformanceReportV1Schema>
>;

/**
 * Bounded test-only evidence-path query input. It carries only graph and
 * source references, never claim text, payloads, or identities.
 */
export interface SharedStateClaimGraphConformanceEvidenceQueryV1 {
  readonly scope: "test-only-claim-graph-conformance-control";
  readonly claimNodeType: SharedStateClaimGraphNodeTypeV1;
  readonly claimOrdinal: number;
  readonly evidenceNodeType: SharedStateClaimGraphNodeTypeV1;
  readonly evidenceOrdinal: number;
}

/**
 * Backend-neutral target seam. `transact`, `open`, and `close` use only the
 * existing storage V1 contract. Every other method is explicitly a bounded
 * test-only conformance control and must never be exposed as an adapter,
 * storage query, or broker runtime API.
 */
export interface SharedStateClaimGraphConformanceTargetV1 {
  open(): Promise<unknown>;
  transact(command: SharedStateTransactionCommandV1): Promise<unknown>;
  captureConformanceSnapshot(): Promise<unknown>;
  armConformanceProjectionFault(
    faultPoint: SharedStateClaimGraphFaultPointV1,
  ): void;
  evaluateConformanceEvidencePath(
    query: SharedStateClaimGraphConformanceEvidenceQueryV1,
  ): Promise<unknown>;
  close(): Promise<unknown>;
}

export interface SharedStateClaimGraphConformanceTargetFactoryV1 {
  create(): Promise<SharedStateClaimGraphConformanceTargetV1>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

/**
 * The declared typed-source fixtures must stay exactly the closed graph
 * node-type vocabulary. If the vocabulary grows, this slice fails closed
 * instead of silently under-covering the typed source surface.
 */
const NODE_TYPE_COVERAGE = (() => {
  const closed = [...V.graphNodeTypes];
  if (
    closed.length !== SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.typedSourceCount
    || new Set(closed).size !== closed.length
  ) {
    return fail("node_type_coverage_mismatch");
  }
  return "exactly-the-closed-node-types" as const;
})();

type DigestDomain =
  | "broker.claim-graph.source-stream-key"
  | "broker.claim-graph.source-fact"
  | "broker.claim-graph.projection-batch-key"
  | "broker.claim-graph.projection-batch"
  | "broker.claim-graph.projection-inverse"
  | "broker.claim-graph.rollback-batch-key";

function digest(
  domain: DigestDomain,
  namespace: string,
  components: readonly {
    readonly field: string;
    readonly type: "utf8" | "uint" | "bytes";
    readonly value: string;
  }[],
): string {
  const parsed = digestSharedStateKeyV1({
    keyspaceVersion: V.versions.keyspace,
    domain,
    namespace,
    components,
  });
  if (!parsed.ok) return fail("invalid_generated_command");
  return parsed.value.digest;
}

function command<Selected extends Operation>(
  operation: Selected,
  input: CommandFor<Selected>["input"],
): CommandFor<Selected> {
  const parsed = parseSharedStateTransactionCommandV1({
    kind: V.kinds.transactionCommand,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation,
    input,
  });
  if (!parsed.ok || parsed.value.operation !== operation) {
    return fail("invalid_generated_command");
  }
  return parsed.value as CommandFor<Selected>;
}

const GRAPH_NAMESPACE = "broker.claim-graph.conformance";
const PROJECTION_VERSION =
  SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.projectionVersion;

const SOURCE_STREAM_KEY_DIGEST = digest(
  "broker.claim-graph.source-stream-key",
  GRAPH_NAMESPACE,
  [
    { field: "sourceType", type: "utf8", value: "conformance-source" },
    { field: "sourceId", type: "utf8", value: "claim-graph" },
  ],
);

function hexOrdinal(ordinal: number): string {
  return ordinal.toString(16).padStart(2, "0");
}

function sourceFactDigest(
  nodeType: SharedStateClaimGraphNodeTypeV1,
  ordinal: number,
): string {
  return digest("broker.claim-graph.source-fact", GRAPH_NAMESPACE, [
    { field: "nodeType", type: "utf8", value: nodeType },
    { field: "fact", type: "bytes", value: hexOrdinal(ordinal) },
  ]);
}

function appendSourceCommand(
  nodeType: SharedStateClaimGraphNodeTypeV1,
  ordinal: number,
  expectedSourceSequence: string,
): CommandFor<"appendGraphSource"> {
  return command("appendGraphSource", {
    namespace: GRAPH_NAMESPACE,
    sourceStreamKeyDigest: SOURCE_STREAM_KEY_DIGEST,
    sourceFactDigest: sourceFactDigest(nodeType, ordinal),
    nodeType,
    expectedSourceSequence,
  });
}

function batchKeyDigest(batchId: string): string {
  return digest(
    "broker.claim-graph.projection-batch-key",
    GRAPH_NAMESPACE,
    [
      { field: "projectionVersion", type: "utf8", value: PROJECTION_VERSION },
      { field: "batchId", type: "utf8", value: batchId },
    ],
  );
}

function rollbackKeyDigest(rollbackId: string): string {
  return digest(
    "broker.claim-graph.rollback-batch-key",
    GRAPH_NAMESPACE,
    [
      { field: "projectionVersion", type: "utf8", value: PROJECTION_VERSION },
      { field: "rollbackId", type: "utf8", value: rollbackId },
    ],
  );
}

function batchBodyDigest(batchId: string): string {
  return digest("broker.claim-graph.projection-batch", GRAPH_NAMESPACE, [
    { field: "batch", type: "bytes", value: `27${hexOrdinal(
      batchId.length,
    )}` },
  ]);
}

function inverseDigest(batchId: string): string {
  return digest("broker.claim-graph.projection-inverse", GRAPH_NAMESPACE, [
    { field: "inverse", type: "bytes", value: `28${hexOrdinal(
      batchId.length,
    )}` },
  ]);
}

function applyBatchCommand(input: {
  readonly batchId: string;
  readonly sourceSequenceFrom: string;
  readonly sourceSequenceThrough: string;
  readonly expectedCheckpointSequence: string;
}): CommandFor<"applyGraphProjectionBatch"> {
  return command("applyGraphProjectionBatch", {
    namespace: GRAPH_NAMESPACE,
    projectionVersion: PROJECTION_VERSION,
    batchKeyDigest: batchKeyDigest(input.batchId),
    batchDigest: batchBodyDigest(input.batchId),
    inverseDigest: inverseDigest(input.batchId),
    sourceSequenceFrom: input.sourceSequenceFrom,
    sourceSequenceThrough: input.sourceSequenceThrough,
    expectedCheckpointSequence: input.expectedCheckpointSequence,
  });
}

function rollbackBatchCommand(input: {
  readonly batchId: string;
  readonly rollbackId: string;
  readonly expectedCheckpointSequence: string;
}): CommandFor<"rollbackGraphProjectionBatch"> {
  return command("rollbackGraphProjectionBatch", {
    namespace: GRAPH_NAMESPACE,
    projectionVersion: PROJECTION_VERSION,
    batchKeyDigest: batchKeyDigest(input.batchId),
    rollbackBatchKeyDigest: rollbackKeyDigest(input.rollbackId),
    inverseDigest: inverseDigest(input.batchId),
    expectedCheckpointSequence: input.expectedCheckpointSequence,
  });
}

function evidenceQuery(
  claimOrdinal: number,
  evidenceOrdinal: number,
): SharedStateClaimGraphConformanceEvidenceQueryV1 {
  return {
    scope: "test-only-claim-graph-conformance-control",
    claimNodeType: "Claim",
    claimOrdinal,
    evidenceNodeType: "Artifact",
    evidenceOrdinal,
  };
}

async function createTarget(
  factory: SharedStateClaimGraphConformanceTargetFactoryV1,
): Promise<SharedStateClaimGraphConformanceTargetV1> {
  try {
    return await factory.create();
  } catch {
    return fail("target_create_failed");
  }
}

export function seededDeterministicClaimGraphSourceOrderV1():
readonly SharedStateClaimGraphNodeTypeV1[] {
  const order = [...V.graphNodeTypes];
  let state = SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.schedulerSeed >>> 0;
  for (let index = order.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const other = state % (index + 1);
    [order[index], order[other]] = [order[other]!, order[index]!];
  }
  return Object.freeze(order);
}

/**
 * Runs the bounded Phase 2.7 source-only slice. Successful output contains
 * only strict public-safe aggregate facts; target values and thrown messages
 * are never reflected.
 */
export async function runSharedStateClaimGraphConformanceV1(
  factory: SharedStateClaimGraphConformanceTargetFactoryV1,
): Promise<SharedStateClaimGraphConformanceReportV1> {
  let targetCount = 0;
  let targetCommandCount = 0;
  let lifecycleCount = 0;
  let snapshotControlCount = 0;
  let faultControlCount = 0;
  let evidenceControlCount = 0;

  async function lifecycle(
    action: () => Promise<unknown>,
  ): Promise<SharedStateStorageLifecycleV1> {
    lifecycleCount += 1;
    if (
      lifecycleCount
      > SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.lifecycleLimit
    ) {
      return fail("operation_limit_exceeded");
    }
    let raw: unknown;
    try {
      raw = await action();
    } catch {
      return fail("target_lifecycle_failed");
    }
    const parsed = parseSharedStateStorageLifecycleV1(raw);
    if (!parsed.ok) return fail("invalid_target_lifecycle");
    return parsed.value;
  }

  async function openedTarget():
  Promise<SharedStateClaimGraphConformanceTargetV1> {
    targetCount += 1;
    if (targetCount > SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.targetCount) {
      return fail("operation_limit_exceeded");
    }
    const target = await createTarget(factory);
    const opened = await lifecycle(() => target.open());
    if (opened.state !== "ready" || opened.reasonCodes.length !== 0) {
      fail("target_lifecycle_failed");
    }
    return target;
  }

  async function closeTarget(
    target: SharedStateClaimGraphConformanceTargetV1,
  ): Promise<void> {
    const value = await lifecycle(() => target.close());
    if (
      value.state !== "closed"
      || value.reasonCodes.length !== 1
      || value.reasonCodes[0] !== "close_requested"
    ) {
      fail("target_lifecycle_failed");
    }
  }

  async function transact<Selected extends Operation>(
    target: SharedStateClaimGraphConformanceTargetV1,
    generatedCommand: CommandFor<Selected>,
  ): Promise<ResultFor<Selected>> {
    targetCommandCount += 1;
    if (
      targetCommandCount
      > SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.targetCommandLimit
    ) {
      return fail("operation_limit_exceeded");
    }
    let raw: unknown;
    try {
      raw = await target.transact(generatedCommand);
    } catch {
      return fail("target_operation_failed");
    }
    const parsed = parseSharedStateTransactionResultV1(raw);
    if (!parsed.ok || parsed.value.operation !== generatedCommand.operation) {
      return fail("invalid_target_result");
    }
    return parsed.value as ResultFor<Selected>;
  }

  async function snapshot(
    target: SharedStateClaimGraphConformanceTargetV1,
  ): Promise<SharedStateClaimGraphConformanceSnapshotV1> {
    snapshotControlCount += 1;
    if (
      snapshotControlCount
      > SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.snapshotControlLimit
    ) {
      return fail("operation_limit_exceeded");
    }
    let raw: unknown;
    try {
      raw = await target.captureConformanceSnapshot();
    } catch {
      return fail("target_snapshot_control_failed");
    }
    const parsed =
      sharedStateClaimGraphConformanceSnapshotV1Schema.safeParse(raw);
    if (!parsed.success) return fail("invalid_conformance_snapshot");
    return deepFreeze(parsed.data);
  }

  async function evidence(
    target: SharedStateClaimGraphConformanceTargetV1,
    query: SharedStateClaimGraphConformanceEvidenceQueryV1,
  ): Promise<SharedStateClaimGraphEvidenceResultV1Shape> {
    evidenceControlCount += 1;
    if (
      evidenceControlCount
      > SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.evidenceControlLimit
    ) {
      return fail("operation_limit_exceeded");
    }
    let raw: unknown;
    try {
      raw = await target.evaluateConformanceEvidencePath(query);
    } catch {
      return fail("target_evidence_control_failed");
    }
    const parsed =
      sharedStateClaimGraphEvidenceResultV1Schema.safeParse(raw);
    if (!parsed.success) return fail("invalid_conformance_evidence_result");
    const value = deepFreeze(parsed.data);
    // Spec 5.6: `no_evidence_path` is valid only at a complete checkpoint.
    if (
      value.result === "no_evidence_path"
      && value.completeness !== "complete"
    ) {
      fail("negative_evidence_before_complete_checkpoint");
    }
    return value;
  }

  function armFault(
    target: SharedStateClaimGraphConformanceTargetV1,
    faultPoint: SharedStateClaimGraphFaultPointV1,
  ): void {
    faultControlCount += 1;
    if (
      faultControlCount
      > SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.faultControlCount
    ) {
      fail("operation_limit_exceeded");
    }
    try {
      target.armConformanceProjectionFault(faultPoint);
    } catch {
      fail("target_fault_control_failed");
    }
  }

  async function appendTypedSources(
    target: SharedStateClaimGraphConformanceTargetV1,
  ): Promise<{
    nodeType: SharedStateClaimGraphNodeTypeV1;
    appendRank: number;
    decision: "appended";
    sourceSequence: string;
  }[]> {
    const order = seededDeterministicClaimGraphSourceOrderV1();
    const entries: {
      nodeType: SharedStateClaimGraphNodeTypeV1;
      appendRank: number;
      decision: "appended";
      sourceSequence: string;
    }[] = [];
    let previous = 0n;
    for (let index = 0; index < order.length; index += 1) {
      const nodeType = order[index]!;
      const result = await transact(
        target,
        appendSourceCommand(nodeType, index + 1, previous.toString()),
      );
      if (
        result.status !== "committed"
        || result.result.decision !== "appended"
      ) {
        fail("source_provenance_mismatch");
      }
      const sequence = BigInt(result.result.sourceSequence);
      if (sequence !== previous + 1n) fail("source_provenance_mismatch");
      previous = sequence;
      entries.push({
        nodeType,
        appendRank: index + 1,
        decision: "appended",
        sourceSequence: result.result.sourceSequence,
      });
    }
    return entries;
  }

  // Scenario A + B: typed provenance-bearing sources on one target, then one
  // atomic projection batch answered by the bounded evidence-path control.
  const primaryTarget = await openedTarget();
  const typedEntries = await appendTypedSources(primaryTarget);
  const afterSources = await snapshot(primaryTarget);
  if (
    afterSources.sourceFactCount
      !== SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.typedSourceCount
    || afterSources.sourceSequenceHighWater
      !== String(SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.typedSourceCount)
    || afterSources.checkpointSequence !== "0"
    || afterSources.nodeCount !== 0
  ) {
    fail("source_provenance_mismatch");
  }

  const firstBatch = await transact(
    primaryTarget,
    applyBatchCommand({
      batchId: "batch-one",
      sourceSequenceFrom: "1",
      sourceSequenceThrough: String(
        SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.typedSourceCount,
      ),
      expectedCheckpointSequence: "0",
    }),
  );
  const afterProjection = await snapshot(primaryTarget);
  if (
    firstBatch.status !== "committed"
    || firstBatch.result.decision !== "applied"
    || firstBatch.result.checkpointSequence
      !== String(SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.typedSourceCount)
    || afterProjection.checkpointSequence
      !== firstBatch.result.checkpointSequence
    || afterProjection.completeness !== "complete"
    || afterProjection.nodeCount === 0
    || afterProjection.edgeCount === 0
    || afterProjection.sourceFactCount !== afterSources.sourceFactCount
  ) {
    fail("projection_atomicity_mismatch");
  }

  const pathFound = await evidence(primaryTarget, evidenceQuery(1, 2));
  if (
    pathFound.result !== "path_found"
    || pathFound.completeness !== "complete"
    || pathFound.lag !== 0
    || pathFound.supportingEdgeCount === 0
    || pathFound.asOfSourceSequence !== afterProjection.checkpointSequence
  ) {
    fail("evidence_path_mismatch");
  }

  // Scenario C: pause projection behind the source high-water.
  for (
    let index = 0;
    index < SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.pausedSourceCount;
    index += 1
  ) {
    const ordinal =
      SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.typedSourceCount + index + 1;
    const appended = await transact(
      primaryTarget,
      appendSourceCommand("Evaluation", ordinal, String(ordinal - 1)),
    );
    if (
      appended.status !== "committed"
      || appended.result.decision !== "appended"
    ) {
      fail("source_provenance_mismatch");
    }
  }

  const pausedSnapshot = await snapshot(primaryTarget);
  const incomplete = await evidence(primaryTarget, evidenceQuery(1, 8));
  if (
    pausedSnapshot.completeness !== "incomplete"
    || pausedSnapshot.checkpointSequence
      !== afterProjection.checkpointSequence
    || incomplete.result !== "projection_incomplete"
    || incomplete.completeness !== "incomplete"
    || incomplete.lag
      !== SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.pausedSourceCount
    || incomplete.checkpointSequence !== afterProjection.checkpointSequence
  ) {
    fail("incomplete_projection_mismatch");
  }

  // A batch reaching past the durable source high-water must fail closed.
  const aheadOfHighWater = await transact(
    primaryTarget,
    applyBatchCommand({
      batchId: "batch-ahead",
      sourceSequenceFrom: String(pausedSnapshot.sourceSequenceHighWater),
      sourceSequenceThrough: String(
        BigInt(pausedSnapshot.sourceSequenceHighWater) + 1n,
      ),
      expectedCheckpointSequence: pausedSnapshot.checkpointSequence,
    }),
  );
  const afterAhead = await snapshot(primaryTarget);
  if (
    aheadOfHighWater.status !== "rejected"
    || aheadOfHighWater.reasonCode !== "source_range_incomplete"
    || afterAhead.checkpointSequence !== pausedSnapshot.checkpointSequence
  ) {
    fail("incomplete_projection_mismatch");
  }
  await closeTarget(primaryTarget);

  // Scenario D: a failure between node/edge writes and the checkpoint must
  // leave the checkpoint exactly where it was.
  const faultTarget = await openedTarget();
  await appendTypedSources(faultTarget);
  const faultBaseline = await snapshot(faultTarget);
  armFault(faultTarget, "after-node-edge-writes-before-checkpoint");
  const faulted = await transact(
    faultTarget,
    applyBatchCommand({
      batchId: "batch-one",
      sourceSequenceFrom: "1",
      sourceSequenceThrough: String(
        SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.typedSourceCount,
      ),
      expectedCheckpointSequence: "0",
    }),
  );
  const afterFault = await snapshot(faultTarget);
  const unavailableEvidence = await evidence(
    faultTarget,
    evidenceQuery(1, 2),
  );
  if (
    faulted.status !== "unavailable"
    || faulted.reasonCode !== "authority_unavailable"
  ) {
    fail("checkpoint_advanced_on_fault");
  }
  // The authority legitimately reports itself unavailable after the fault, so
  // compare the graph state rather than the whole snapshot.
  if (
    afterFault.checkpointSequence !== faultBaseline.checkpointSequence
    || afterFault.nodeCount !== faultBaseline.nodeCount
    || afterFault.edgeCount !== faultBaseline.edgeCount
    || afterFault.tombstonedEdgeCount !== faultBaseline.tombstonedEdgeCount
    || afterFault.appliedBatchCount !== faultBaseline.appliedBatchCount
    || afterFault.sourceFactCount !== faultBaseline.sourceFactCount
    || afterFault.sourceSequenceHighWater
      !== faultBaseline.sourceSequenceHighWater
  ) {
    fail("checkpoint_advanced_on_fault");
  }
  if (unavailableEvidence.result !== "projection_unavailable") {
    fail("evidence_path_mismatch");
  }

  const cleanRetry = await transact(
    faultTarget,
    applyBatchCommand({
      batchId: "batch-one",
      sourceSequenceFrom: "1",
      sourceSequenceThrough: String(
        SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.typedSourceCount,
      ),
      expectedCheckpointSequence: "0",
    }),
  );
  const afterRetry = await snapshot(faultTarget);
  if (
    cleanRetry.status !== "committed"
    || cleanRetry.result.decision !== "applied"
    || afterRetry.appliedBatchCount !== faultBaseline.appliedBatchCount + 1
  ) {
    fail("projection_atomicity_mismatch");
  }
  await closeTarget(faultTarget);

  // Scenario E: an injected false merge is reversed by its recorded inverse
  // batch while immutable source facts survive.
  const rollbackTarget = await openedTarget();
  await appendTypedSources(rollbackTarget);
  const cleanBatch = await transact(
    rollbackTarget,
    applyBatchCommand({
      batchId: "batch-one",
      sourceSequenceFrom: "1",
      sourceSequenceThrough: String(
        SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.typedSourceCount,
      ),
      expectedCheckpointSequence: "0",
    }),
  );
  if (
    cleanBatch.status !== "committed"
    || cleanBatch.result.decision !== "applied"
  ) {
    fail("projection_atomicity_mismatch");
  }
  // At a complete checkpoint a missing path is a real evidence judgment.
  const priorEvidence = await evidence(rollbackTarget, evidenceQuery(4, 5));
  if (
    priorEvidence.result !== "no_evidence_path"
    || priorEvidence.completeness !== "complete"
  ) {
    fail("evidence_path_mismatch");
  }

  for (
    let index = 0;
    index < SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.pausedSourceCount;
    index += 1
  ) {
    const ordinal =
      SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.typedSourceCount + index + 1;
    const appended = await transact(
      rollbackTarget,
      appendSourceCommand("Evaluation", ordinal, String(ordinal - 1)),
    );
    if (
      appended.status !== "committed"
      || appended.result.decision !== "appended"
    ) {
      fail("source_provenance_mismatch");
    }
  }
  const beforeFalseMerge = await snapshot(rollbackTarget);

  const falseMergeFrom = String(
    SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.typedSourceCount + 1,
  );
  const falseMergeThrough = beforeFalseMerge.sourceSequenceHighWater;
  const falseMerge = await transact(
    rollbackTarget,
    applyBatchCommand({
      batchId: "batch-false-merge",
      sourceSequenceFrom: falseMergeFrom,
      sourceSequenceThrough: falseMergeThrough,
      expectedCheckpointSequence: beforeFalseMerge.checkpointSequence,
    }),
  );
  const falseMergeEvidence = await evidence(
    rollbackTarget,
    evidenceQuery(Number(falseMergeFrom), Number(falseMergeThrough)),
  );
  if (
    falseMerge.status !== "committed"
    || falseMerge.result.decision !== "applied"
    || falseMergeEvidence.result !== "path_found"
  ) {
    fail("rollback_restoration_mismatch");
  }

  const rolledBack = await transact(
    rollbackTarget,
    rollbackBatchCommand({
      batchId: "batch-false-merge",
      rollbackId: "rollback-false-merge",
      expectedCheckpointSequence: falseMerge.result.checkpointSequence,
    }),
  );
  const afterRollback = await snapshot(rollbackTarget);
  const restoredEvidence = await evidence(
    rollbackTarget,
    evidenceQuery(Number(falseMergeFrom), Number(falseMergeThrough)),
  );
  if (
    rolledBack.status !== "committed"
    || rolledBack.result.decision !== "rolled_back"
    || rolledBack.result.checkpointSequence
      !== beforeFalseMerge.checkpointSequence
  ) {
    fail("rollback_restoration_mismatch");
  }
  // The prior graph is restored exactly, and the false edge is gone. The
  // checkpoint is now behind the source high-water again, so spec 5.6 requires
  // the negative judgment to be withheld rather than reported.
  if (
    afterRollback.nodeCount !== beforeFalseMerge.nodeCount
    || afterRollback.edgeCount !== beforeFalseMerge.edgeCount
    || afterRollback.checkpointSequence
      !== beforeFalseMerge.checkpointSequence
    || restoredEvidence.supportingEdgeCount !== 0
    || restoredEvidence.result !== "projection_incomplete"
  ) {
    fail("rollback_restoration_mismatch");
  }
  if (
    afterRollback.sourceFactCount !== beforeFalseMerge.sourceFactCount
    || afterRollback.sourceSequenceHighWater
      !== beforeFalseMerge.sourceSequenceHighWater
  ) {
    fail("immutable_source_mutated");
  }

  // Scenario F: reapplying the same batch and the same rollback is idempotent.
  const reapplied = await transact(
    rollbackTarget,
    applyBatchCommand({
      batchId: "batch-false-merge",
      sourceSequenceFrom: falseMergeFrom,
      sourceSequenceThrough: falseMergeThrough,
      expectedCheckpointSequence: afterRollback.checkpointSequence,
    }),
  );
  const rollbackReapplied = await transact(
    rollbackTarget,
    rollbackBatchCommand({
      batchId: "batch-false-merge",
      rollbackId: "rollback-false-merge",
      expectedCheckpointSequence: afterRollback.checkpointSequence,
    }),
  );
  const afterReapply = await snapshot(rollbackTarget);
  if (
    reapplied.status !== "committed"
    || reapplied.result.decision !== "replayed"
    || rollbackReapplied.status !== "committed"
    || rollbackReapplied.result.decision !== "replayed"
  ) {
    fail("idempotent_reapply_mismatch");
  }
  if (JSON.stringify(afterReapply) !== JSON.stringify(afterRollback)) {
    fail("idempotent_reapply_mismatch");
  }
  if (
    BigInt(afterReapply.sourceSequenceHighWater)
      < BigInt(beforeFalseMerge.sourceSequenceHighWater)
  ) {
    fail("high_water_regression");
  }
  await closeTarget(rollbackTarget);

  if (
    targetCount !== SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.targetCount
    || targetCommandCount
      !== SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.expectedTargetCommandCount
    || lifecycleCount
      !== SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.expectedLifecycleCount
    || snapshotControlCount
      !== SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1
        .expectedSnapshotControlCount
    || faultControlCount
      !== SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.faultControlCount
    || evidenceControlCount
      !== SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1
        .expectedEvidenceControlCount
  ) {
    fail("operation_limit_exceeded");
  }

  const report = {
    kind: SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.kind,
    harnessVersion: SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.harnessVersion,
    contractVersion: V.versions.contract,
    scope: SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.scope,
    status: "passed",
    controls: {
      scheduler: "seeded-deterministic-serial",
      schedulerSeed: SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.schedulerSeed,
      concurrency: "not-exercised",
      barrier: "not-required",
      clock: "not-required",
      targetIsolation: "factory-created-per-scenario",
      targetCount,
      targetCommandLimit:
        SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.targetCommandLimit,
      targetCommandCount,
      lifecycleLimit:
        SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.lifecycleLimit,
      lifecycleCount,
      snapshotControlLimit:
        SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.snapshotControlLimit,
      snapshotControlCount,
      faultControlCount,
      evidenceControlLimit:
        SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.evidenceControlLimit,
      evidenceControlCount,
    },
    typedSources: {
      nodeTypeCoverage: NODE_TYPE_COVERAGE,
      count: SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.typedSourceCount,
      sequencesStrictlyIncreasing: true,
      provenanceBinding: "stream-key-and-fact-digest",
      entries: typedEntries,
    },
    atomicProjection: {
      decision: "applied",
      checkpointAdvancedTo: firstBatch.result.checkpointSequence,
      batchBoundary: "separate-from-source-append",
      evidenceResult: "path_found",
      evidenceCompleteness: "complete",
      evidenceLag: 0,
      evidenceQueryInputs: "graph-and-source-references-only",
    },
    pausedProjection: {
      pausedSourceCount:
        SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.pausedSourceCount,
      evidenceResult: "projection_incomplete",
      evidenceCompleteness: "incomplete",
      evidenceLag: SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.pausedSourceCount,
      checkpointUnchanged: true,
      negativeEvidenceWithheld: true,
      negativeEvidenceRequires:
        V.completenessGuarantees.negativeEvidenceRequires,
      aheadOfHighWaterRejection: "source_range_incomplete",
    },
    checkpointFault: {
      faultPoint: "after-node-edge-writes-before-checkpoint",
      attemptStatus: "unavailable",
      attemptReasonCode: "authority_unavailable",
      checkpointAdvanced: false,
      graphStateUnchanged: true,
      evidenceResultWhileUnavailable: "projection_unavailable",
      cleanRetryDecision: "applied",
      cleanRetryEffectCount: 1,
    },
    falseMergeRollback: {
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
    },
    idempotentReapply: {
      batchReapplyDecision: "replayed",
      rollbackReapplyDecision: "replayed",
      checkpointUnchangedOnReapply: true,
      duplicateEffectCount: 0,
    },
    monotonicity: {
      sourceSequenceHighWater: "nondecreasing",
      immutableSourceFacts: "never-deleted",
    },
    claims: {
      referenceModel: "test-only",
      adapterConformance: "not-claimed",
      runtimeIntegration: "none",
      storageQueryContract: "none",
      evidenceSeam: "test-only-control-not-a-v1-query",
      retentionPruneExecution: "not-executed",
      partitionUnavailableInjection: "out-of-scope",
    },
  } as const;
  const parsed =
    sharedStateClaimGraphConformanceReportV1Schema.safeParse(report);
  if (!parsed.success) return fail("report_invalid");
  return deepFreeze(parsed.data);
}
