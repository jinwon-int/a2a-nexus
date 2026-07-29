/**
 * Backend-neutral source contract for `a2a.shared-state.storage/v1`.
 *
 * This module is deliberately disconnected from broker runtime callsites. It
 * defines closed data envelopes and fail-closed parsers only; it does not
 * implement an adapter, storage, scheduling, clocks, migrations, or health
 * middleware.
 */

import { z } from "zod";

import {
  parseSharedStateDigestV1,
  type SharedStateDigestDomainV1,
} from "./shared-state-storage-keyspace-v1.js";
import {
  evaluateSharedStateIdempotencyPolicyV1,
  type SharedStateIdempotencyErrorCodeV1,
} from "./shared-state-idempotency-v1.js";
import { SHARED_STATE_STORAGE_V1_VALUES as V } from "./shared-state-storage-v1-values.js";

export { SHARED_STATE_STORAGE_V1_VALUES } from "./shared-state-storage-v1-values.js";
export {
  evaluateSharedStateIdempotencyExpiryV1,
  evaluateSharedStateIdempotencyPolicyV1,
  parseSharedStateIdempotencyCatalogV1,
  sharedStateIdempotencyCatalogV1,
  SHARED_STATE_IDEMPOTENCY_V1_VALUES,
} from "./shared-state-idempotency-v1.js";
export type {
  SharedStateIdempotencyAuthorityV1,
  SharedStateIdempotencyCatalogV1,
  SharedStateIdempotencyDurabilityV1,
  SharedStateIdempotencyEffectClassV1,
  SharedStateIdempotencyEffectKindV1,
  SharedStateIdempotencyErrorCodeV1,
  SharedStateIdempotencyErrorV1,
  SharedStateIdempotencyEvaluationReasonCodeV1,
  SharedStateIdempotencyExpiryEvaluationV1,
  SharedStateIdempotencyExpiryPostureV1,
  SharedStateIdempotencyPolicyEvaluationV1,
  SharedStateIdempotencyPolicyInputV1,
  SharedStateIdempotencyRegistrationV1,
  SharedStateIdempotencyResultV1,
} from "./shared-state-idempotency-v1.js";
export {
  canonicalizeSharedStateKeyV1,
  digestSharedStateKeyV1,
  parseSharedStateDigestV1,
} from "./shared-state-storage-keyspace-v1.js";
export type {
  ParsedSharedStateDigestV1,
  SharedStateCanonicalKeyV1,
  SharedStateDigestDomainV1,
  SharedStateDigestV1,
  SharedStateKeyComponentInputV1,
  SharedStateKeyComponentTypeV1,
  SharedStateKeyMaterialInputV1,
  SharedStateKeyspaceErrorCodeV1,
  SharedStateKeyspaceErrorV1,
  SharedStateKeyspaceResultV1,
  SharedStateNormalizedKeyComponentV1,
} from "./shared-state-storage-keyspace-v1.js";

export type SharedStateBackendClassV1 = (typeof V.backendClasses)[number];
export type SharedStateHealthBackendClassV1 =
  (typeof V.healthBackendClasses)[number];
export type SharedStateWriterModelV1 = (typeof V.writerModels)[number];
export type SharedStateLifecycleStateV1 = (typeof V.lifecycleStates)[number];
export type SharedStateOperationV1 = (typeof V.operations)[number];
export type SharedStateContractErrorCodeV1 =
  (typeof V.parserErrorCodes)[number];
export type SharedStateOperationUnavailableReasonCodeV1 =
  (typeof V.unavailableReasonCodes)[number];

export interface SharedStateContractErrorV1 {
  readonly code: SharedStateContractErrorCodeV1;
  readonly path: readonly (string | number)[];
}

export type SharedStateParseResultV1<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: SharedStateContractErrorV1;
    };

const versionTokenSchema = z
  .string()
  .min(1)
  .max(V.limits.implementationVersionLength)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/);
const namespaceSchema = z
  .string()
  .min(1)
  .max(V.limits.namespaceLength)
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/);
const opaqueTokenSchema = z
  .string()
  .min(1)
  .max(V.limits.opaqueTokenLength)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._~-]*$/);
const retentionVersionSchema = z
  .string()
  .min(1)
  .max(V.limits.retentionVersionLength)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
function purposeDigestSchema(domain: SharedStateDigestDomainV1) {
  return z.string().refine(
    (value) => parseSharedStateDigestV1(value, { domain }).ok,
  );
}
const positiveDurationSchema = z
  .number()
  .int()
  .positive()
  .max(V.limits.maxDurationMs);
const nonNegativeDurationSchema = z
  .number()
  .int()
  .nonnegative()
  .max(V.limits.maxDurationMs);
const positiveDecimalSchema = z
  .string()
  .regex(new RegExp(`^[1-9][0-9]{0,${V.limits.maxDecimalDigits - 1}}$`));
const nonNegativeDecimalSchema = z
  .string()
  .regex(new RegExp(`^(?:0|[1-9][0-9]{0,${V.limits.maxDecimalDigits - 1}})$`));
const positiveSchemaVersion = z.number().int().positive();
const expectedProcessCountSchema = z
  .number()
  .int()
  .positive()
  .max(V.limits.maxExpectedProcessCount);

export const sharedStateStorageCapabilitiesV1Schema = z
  .object({
    kind: z.literal(V.kinds.capabilities),
    capabilitiesVersion: z.literal(V.versions.capabilities),
    atomicCompareAndSet: z.boolean(),
    linearizablePerKey: z.boolean(),
    durableLogicalExpiry: z.boolean(),
    clockFloorProtection: z.boolean(),
    monotonicFencingTokens: z.boolean(),
    atomicIdempotencyDomainOutbox: z.boolean(),
    stablePerStreamOutboxOrdering: z.boolean(),
    durableOutboxAckState: z.boolean(),
    durableProjectionCheckpoints: z.boolean(),
    exactProjectionBatchRollback: z.boolean(),
    exclusiveSingletonOwnership: z.boolean(),
  })
  .strict();

export type SharedStateStorageCapabilitiesV1 = z.infer<
  typeof sharedStateStorageCapabilitiesV1Schema
>;

export const sharedStateConsistencyDeclarationV1Schema = z
  .object({
    kind: z.literal(V.kinds.consistency),
    declarationsVersion: z.literal(V.versions.declarations),
    replay: z.literal(V.consistencyGuarantees.replay),
    rateLimit: z.literal(V.consistencyGuarantees.rateLimit),
    lease: z.literal(V.consistencyGuarantees.lease),
    idempotency: z.literal(V.consistencyGuarantees.idempotency),
    outbox: z.literal(V.consistencyGuarantees.outbox),
    graphSource: z.literal(V.consistencyGuarantees.graphSource),
    graphProjection: z.literal(V.consistencyGuarantees.graphProjection),
  })
  .strict();

export type SharedStateConsistencyDeclarationV1 = z.infer<
  typeof sharedStateConsistencyDeclarationV1Schema
>;

export const sharedStateCompletenessDeclarationV1Schema = z
  .object({
    kind: z.literal(V.kinds.completeness),
    declarationsVersion: z.literal(V.versions.declarations),
    graphQueries: z.literal(V.completenessGuarantees.graphQueries),
    negativeEvidenceRequires: z.literal(
      V.completenessGuarantees.negativeEvidenceRequires,
    ),
    healthProjection: z.literal(
      V.completenessGuarantees.healthProjection,
    ),
  })
  .strict();

export type SharedStateCompletenessDeclarationV1 = z.infer<
  typeof sharedStateCompletenessDeclarationV1Schema
>;

export const sharedStateStorageMetadataV1Schema = z
  .object({
    kind: z.literal(V.kinds.metadata),
    metadataVersion: z.literal(V.versions.metadata),
    contractVersion: z.literal(V.versions.contract),
    operationVersion: z.literal(V.versions.operation),
    implementationVersion: versionTokenSchema,
    backendClass: z.enum(V.backendClasses),
    durability: z.literal(V.durabilities[1]),
    writerModel: z.enum(V.writerModels),
    schemaVersion: positiveSchemaVersion,
    clockAuthority: z.enum(V.clockAuthorities),
    migrationState: z.literal(V.migrationStates[0]),
    capabilities: sharedStateStorageCapabilitiesV1Schema,
    consistency: sharedStateConsistencyDeclarationV1Schema,
    completeness: sharedStateCompletenessDeclarationV1Schema,
  })
  .strict();

export type SharedStateStorageMetadataV1 = z.infer<
  typeof sharedStateStorageMetadataV1Schema
>;

export const sharedStateStorageOpenRequirementsV1Schema = z
  .object({
    kind: z.literal(V.kinds.openRequirements),
    requirementsVersion: z.literal(V.versions.openRequirements),
    contractVersion: z.literal(V.versions.contract),
    operationVersion: z.literal(V.versions.operation),
    expectedBackendClass: z.enum(V.backendClasses),
    expectedWriterModel: z.enum(V.writerModels),
    expectedSchemaVersion: positiveSchemaVersion,
    expectedProcessCount: expectedProcessCountSchema,
    clockAuthority: z.enum(V.clockAuthorities),
    callerClockAllowed: z.literal(false),
    migrationState: z.literal(V.migrationStates[0]),
    topologyOwnership: z.enum(V.topologyOwnershipRequirements),
    requiredCapabilities: sharedStateStorageCapabilitiesV1Schema,
    requiredConsistency: sharedStateConsistencyDeclarationV1Schema,
    requiredCompleteness: sharedStateCompletenessDeclarationV1Schema,
  })
  .strict();

export type SharedStateStorageOpenRequirementsV1 = z.infer<
  typeof sharedStateStorageOpenRequirementsV1Schema
>;

export const sharedStateStorageLifecycleV1Schema = z
  .object({
    kind: z.literal(V.kinds.lifecycle),
    lifecycleVersion: z.literal(V.versions.lifecycle),
    contractVersion: z.literal(V.versions.contract),
    state: z.enum(V.lifecycleStates),
    reasonCodes: z
      .array(z.enum(V.lifecycleReasonCodes))
      .max(V.limits.maxHealthReasonCodes),
  })
  .strict();

export type SharedStateStorageLifecycleV1 = z.infer<
  typeof sharedStateStorageLifecycleV1Schema
>;

const healthAdapterSchema = z
  .object({
    contractVersion: z.literal(V.versions.contract).nullable(),
    backendClass: z.enum(V.healthBackendClasses),
    lifecycle: z.enum(V.lifecycleStates),
    durability: z.enum(V.durabilities),
    writerModel: z.enum(V.writerModels),
    schemaVersion: positiveSchemaVersion.nullable(),
    clockAuthority: z.enum(V.clockAuthorities).nullable(),
    migrationState: z.enum(V.migrationStates).nullable(),
  })
  .strict();

const healthTopologySchema = z
  .object({
    expectedProcessCount: expectedProcessCountSchema,
    ownership: z.enum(V.ownershipStates),
  })
  .strict();

const healthClockSchema = z
  .object({
    safety: z.enum(V.clockSafetyStates),
  })
  .strict();

const primitiveHealthSchema = z
  .object({
    source: z.enum(V.primitiveSources),
    durability: z.enum(V.durabilities),
    continuity: z.enum(V.continuityStates),
    resetRisk: z.boolean(),
    epochAgeBand: z.enum(V.ageBands),
    pressureBand: z.enum(V.pressureBands),
    lastResetReason: z.enum(V.resetReasonCodes).nullable(),
  })
  .strict();

const healthConsistencySchema = z
  .object({
    replay: z.literal(V.consistencyGuarantees.replay),
    rateLimit: z.literal(V.consistencyGuarantees.rateLimit),
    lease: z.literal(V.consistencyGuarantees.lease),
    idempotency: z.literal(V.consistencyGuarantees.idempotency),
    outbox: z.literal(V.consistencyGuarantees.outbox),
    graphSource: z.literal(V.consistencyGuarantees.graphSource),
    graphProjection: z.literal(V.consistencyGuarantees.graphProjection),
  })
  .strict();

const healthCompletenessSchema = z
  .object({
    graphProjection: z.enum(V.graphCompletenessStates),
    negativeEvidenceAllowed: z.boolean(),
  })
  .strict();

export const sharedStateHealthProjectionV1Schema = z
  .object({
    kind: z.literal(V.kinds.health),
    specVersion: z.literal(V.versions.health),
    configuredGrade: z.enum(V.configuredGrades),
    effectiveGrade: z.enum(V.effectiveGrades),
    gradeDefaulted: z.boolean(),
    serving: z.boolean(),
    reasonCodes: z
      .array(z.enum(V.readinessReasonCodes))
      .max(V.limits.maxHealthReasonCodes),
    adapter: healthAdapterSchema,
    topology: healthTopologySchema,
    clock: healthClockSchema,
    consistency: healthConsistencySchema,
    completeness: healthCompletenessSchema,
    primitives: z
      .object({
        replay: primitiveHealthSchema,
        rateLimit: primitiveHealthSchema,
      })
      .strict(),
  })
  .strict();

export type SharedStateHealthProjectionV1 = z.infer<
  typeof sharedStateHealthProjectionV1Schema
>;

const leaseAuthoritySchema = z
  .object({
    namespace: namespaceSchema,
    resourceKeyDigest: purposeDigestSchema("broker.lease.resource-key"),
    ownerKeyDigest: purposeDigestSchema("broker.lease.owner-key"),
    attemptKeyDigest: purposeDigestSchema("broker.lease.attempt-key"),
    fencingToken: positiveDecimalSchema,
    expectedResourceVersion: nonNegativeDecimalSchema,
  })
  .strict();

const outboxEffectSchema = z
  .object({
    streamKeyDigest: purposeDigestSchema("broker.outbox.stream-key"),
    eventKeyDigest: purposeDigestSchema("broker.outbox.event-key"),
    payloadDigest: purposeDigestSchema("broker.outbox.payload"),
    retentionPolicyVersion: retentionVersionSchema,
  })
  .strict();

export const sharedStateTransactionCommandInputV1Schemas = {
  consumeReplayNonce: z
    .object({
      namespace: namespaceSchema,
      keyDigest: purposeDigestSchema("security.replay.requester-key"),
      nonceDigest: purposeDigestSchema("security.replay.nonce"),
      ttlMs: positiveDurationSchema,
    })
    .strict(),
  reserveRateLimitCost: z
    .object({
      namespace: namespaceSchema,
      bucketKeyDigest: purposeDigestSchema("security.rate-limit.bucket-key"),
      cost: z.number().int().positive().max(V.limits.maxRateCost),
      limit: z.number().int().positive().max(V.limits.maxRateLimit),
      windowMs: positiveDurationSchema,
    })
    .strict(),
  claimLease: z
    .object({
      namespace: namespaceSchema,
      resourceKeyDigest: purposeDigestSchema("broker.lease.resource-key"),
      ownerKeyDigest: purposeDigestSchema("broker.lease.owner-key"),
      leaseDurationMs: positiveDurationSchema,
      expectedResourceVersion: nonNegativeDecimalSchema,
    })
    .strict(),
  renewLease: leaseAuthoritySchema
    .extend({
      leaseDurationMs: positiveDurationSchema,
    })
    .strict(),
  mutateWithFence: leaseAuthoritySchema
    .extend({
      mutationKind: z.enum(V.leaseMutationKinds),
      mutationDigest: purposeDigestSchema("broker.lease.mutation"),
    })
    .strict(),
  releaseLease: leaseAuthoritySchema
    .extend({
      releaseKind: z.enum(V.leaseReleaseKinds),
    })
    .strict(),
  executeIdempotent: z
    .object({
      namespace: namespaceSchema,
      keyDigest: purposeDigestSchema("broker.idempotency.key"),
      payloadFingerprint: purposeDigestSchema(
        "broker.idempotency.payload-fingerprint",
      ),
      retentionPolicyVersion: retentionVersionSchema,
      effect: z
        .object({
          kind: z.enum(V.idempotentEffectKinds),
          domainMutationDigest: purposeDigestSchema(
            "broker.idempotency.domain-mutation",
          ),
          outbox: outboxEffectSchema,
        })
        .strict(),
    })
    .strict(),
  appendOutbox: z
    .object({
      namespace: namespaceSchema,
      streamKeyDigest: purposeDigestSchema("broker.outbox.stream-key"),
      idempotencyKeyDigest: purposeDigestSchema(
        "broker.outbox.idempotency-key",
      ),
      eventKeyDigest: purposeDigestSchema("broker.outbox.event-key"),
      payloadDigest: purposeDigestSchema("broker.outbox.payload"),
      retentionPolicyVersion: retentionVersionSchema,
    })
    .strict(),
  updateOutboxReceipt: z
    .object({
      namespace: namespaceSchema,
      eventKeyDigest: purposeDigestSchema("broker.outbox.event-key"),
      receiptEvidenceDigest: purposeDigestSchema(
        "broker.outbox.receipt-evidence",
      ),
      expectedReceiptState: z.enum(V.receiptStates),
      newReceiptState: z.enum(V.receiptStates),
    })
    .strict(),
  acknowledgeOutbox: z
    .object({
      namespace: namespaceSchema,
      eventKeyDigest: purposeDigestSchema("broker.outbox.event-key"),
      receiptEvidenceDigest: purposeDigestSchema(
        "broker.outbox.receipt-evidence",
      ),
      expectedAcknowledgmentState: z.enum(V.acknowledgmentStates),
    })
    .strict(),
  appendGraphSource: z
    .object({
      namespace: namespaceSchema,
      sourceStreamKeyDigest: purposeDigestSchema(
        "broker.claim-graph.source-stream-key",
      ),
      sourceFactDigest: purposeDigestSchema(
        "broker.claim-graph.source-fact",
      ),
      nodeType: z.enum(V.graphNodeTypes),
      expectedSourceSequence: nonNegativeDecimalSchema,
    })
    .strict(),
  applyGraphProjectionBatch: z
    .object({
      namespace: namespaceSchema,
      projectionVersion: opaqueTokenSchema,
      batchKeyDigest: purposeDigestSchema(
        "broker.claim-graph.projection-batch-key",
      ),
      batchDigest: purposeDigestSchema(
        "broker.claim-graph.projection-batch",
      ),
      inverseDigest: purposeDigestSchema(
        "broker.claim-graph.projection-inverse",
      ),
      sourceSequenceFrom: positiveDecimalSchema,
      sourceSequenceThrough: positiveDecimalSchema,
      expectedCheckpointSequence: nonNegativeDecimalSchema,
    })
    .strict(),
  rollbackGraphProjectionBatch: z
    .object({
      namespace: namespaceSchema,
      projectionVersion: opaqueTokenSchema,
      batchKeyDigest: purposeDigestSchema(
        "broker.claim-graph.projection-batch-key",
      ),
      rollbackBatchKeyDigest: purposeDigestSchema(
        "broker.claim-graph.rollback-batch-key",
      ),
      inverseDigest: purposeDigestSchema(
        "broker.claim-graph.projection-inverse",
      ),
      expectedCheckpointSequence: nonNegativeDecimalSchema,
    })
    .strict(),
} as const satisfies Record<SharedStateOperationV1, z.ZodType>;

type SharedStateCommandInputByOperationV1 = {
  [Operation in SharedStateOperationV1]: z.infer<
    (typeof sharedStateTransactionCommandInputV1Schemas)[Operation]
  >;
};

type SharedStateTransactionCommandForV1<
  Operation extends SharedStateOperationV1,
> = {
  readonly kind: typeof V.kinds.transactionCommand;
  readonly contractVersion: typeof V.versions.contract;
  readonly transactionVersion: typeof V.versions.transaction;
  readonly operationVersion: typeof V.versions.operation;
  readonly operation: Operation;
  readonly input: SharedStateCommandInputByOperationV1[Operation];
};

export type SharedStateTransactionCommandV1 = {
  [Operation in SharedStateOperationV1]:
    SharedStateTransactionCommandForV1<Operation>;
}[SharedStateOperationV1];

function commandEnvelopeSchema<
  Operation extends SharedStateOperationV1,
  Schema extends z.ZodType,
>(operation: Operation, input: Schema) {
  return z
    .object({
      kind: z.literal(V.kinds.transactionCommand),
      contractVersion: z.literal(V.versions.contract),
      transactionVersion: z.literal(V.versions.transaction),
      operationVersion: z.literal(V.versions.operation),
      operation: z.literal(operation),
      input,
    })
    .strict();
}

export const sharedStateTransactionCommandV1Schema = z.discriminatedUnion(
  "operation",
  [
    commandEnvelopeSchema(
      V.operations[0],
      sharedStateTransactionCommandInputV1Schemas.consumeReplayNonce,
    ),
    commandEnvelopeSchema(
      V.operations[1],
      sharedStateTransactionCommandInputV1Schemas.reserveRateLimitCost,
    ),
    commandEnvelopeSchema(
      V.operations[2],
      sharedStateTransactionCommandInputV1Schemas.claimLease,
    ),
    commandEnvelopeSchema(
      V.operations[3],
      sharedStateTransactionCommandInputV1Schemas.renewLease,
    ),
    commandEnvelopeSchema(
      V.operations[4],
      sharedStateTransactionCommandInputV1Schemas.mutateWithFence,
    ),
    commandEnvelopeSchema(
      V.operations[5],
      sharedStateTransactionCommandInputV1Schemas.releaseLease,
    ),
    commandEnvelopeSchema(
      V.operations[6],
      sharedStateTransactionCommandInputV1Schemas.executeIdempotent,
    ),
    commandEnvelopeSchema(
      V.operations[7],
      sharedStateTransactionCommandInputV1Schemas.appendOutbox,
    ),
    commandEnvelopeSchema(
      V.operations[8],
      sharedStateTransactionCommandInputV1Schemas.updateOutboxReceipt,
    ),
    commandEnvelopeSchema(
      V.operations[9],
      sharedStateTransactionCommandInputV1Schemas.acknowledgeOutbox,
    ),
    commandEnvelopeSchema(
      V.operations[10],
      sharedStateTransactionCommandInputV1Schemas.appendGraphSource,
    ),
    commandEnvelopeSchema(
      V.operations[11],
      sharedStateTransactionCommandInputV1Schemas.applyGraphProjectionBatch,
    ),
    commandEnvelopeSchema(
      V.operations[12],
      sharedStateTransactionCommandInputV1Schemas.rollbackGraphProjectionBatch,
    ),
  ],
);

const replayResultSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal(V.operationDecisions.consumeReplayNonce[0]),
      expiresInMs: positiveDurationSchema,
    })
    .strict(),
  z
    .object({
      decision: z.literal(V.operationDecisions.consumeReplayNonce[1]),
      expiresInMs: positiveDurationSchema,
    })
    .strict(),
]);

const rateLimitResultSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal(V.operationDecisions.reserveRateLimitCost[0]),
      remaining: z.number().int().nonnegative().max(V.limits.maxRateLimit),
      resetInMs: nonNegativeDurationSchema,
    })
    .strict(),
  z
    .object({
      decision: z.literal(V.operationDecisions.reserveRateLimitCost[1]),
      resetInMs: nonNegativeDurationSchema,
    })
    .strict(),
]);

const leaseClaimResultSchema = z
  .object({
    decision: z.literal(V.operationDecisions.claimLease[0]),
    attemptKeyDigest: purposeDigestSchema("broker.lease.attempt-key"),
    fencingToken: positiveDecimalSchema,
    resourceVersion: positiveDecimalSchema,
    leaseExpiresInMs: positiveDurationSchema,
  })
  .strict();

const leaseRenewResultSchema = z
  .object({
    decision: z.literal(V.operationDecisions.renewLease[0]),
    resourceVersion: positiveDecimalSchema,
    leaseExpiresInMs: positiveDurationSchema,
  })
  .strict();

const fencedMutationResultSchema = z
  .object({
    decision: z.literal(V.operationDecisions.mutateWithFence[0]),
    resourceVersion: positiveDecimalSchema,
  })
  .strict();

const leaseReleaseResultSchema = z
  .object({
    decision: z.literal(V.operationDecisions.releaseLease[0]),
    resourceVersion: positiveDecimalSchema,
  })
  .strict();

const idempotentResultSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal(V.operationDecisions.executeIdempotent[0]),
      outcomeDigest: purposeDigestSchema("broker.idempotency.outcome"),
    })
    .strict(),
  z
    .object({
      decision: z.literal(V.operationDecisions.executeIdempotent[1]),
      outcomeDigest: purposeDigestSchema("broker.idempotency.outcome"),
    })
    .strict(),
]);

const appendOutboxResultSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal(V.operationDecisions.appendOutbox[0]),
      eventKeyDigest: purposeDigestSchema("broker.outbox.event-key"),
      streamSequence: positiveDecimalSchema,
    })
    .strict(),
  z
    .object({
      decision: z.literal(V.operationDecisions.appendOutbox[1]),
      eventKeyDigest: purposeDigestSchema("broker.outbox.event-key"),
      streamSequence: positiveDecimalSchema,
    })
    .strict(),
]);

const updateReceiptResultSchema = z
  .object({
    decision: z.literal(V.operationDecisions.updateOutboxReceipt[0]),
    receiptState: z.enum(V.receiptStates),
  })
  .strict();

const acknowledgeResultSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal(V.operationDecisions.acknowledgeOutbox[0]),
      acknowledgmentState: z.literal(V.acknowledgmentStates[1]),
    })
    .strict(),
  z
    .object({
      decision: z.literal(V.operationDecisions.acknowledgeOutbox[1]),
      acknowledgmentState: z.literal(V.acknowledgmentStates[1]),
    })
    .strict(),
]);

const appendGraphSourceResultSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal(V.operationDecisions.appendGraphSource[0]),
      sourceSequence: positiveDecimalSchema,
    })
    .strict(),
  z
    .object({
      decision: z.literal(V.operationDecisions.appendGraphSource[1]),
      sourceSequence: positiveDecimalSchema,
    })
    .strict(),
]);

const applyGraphProjectionResultSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal(V.operationDecisions.applyGraphProjectionBatch[0]),
      checkpointSequence: positiveDecimalSchema,
    })
    .strict(),
  z
    .object({
      decision: z.literal(V.operationDecisions.applyGraphProjectionBatch[1]),
      checkpointSequence: positiveDecimalSchema,
    })
    .strict(),
]);

const rollbackGraphProjectionResultSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal(
        V.operationDecisions.rollbackGraphProjectionBatch[0],
      ),
      checkpointSequence: nonNegativeDecimalSchema,
    })
    .strict(),
  z
    .object({
      decision: z.literal(
        V.operationDecisions.rollbackGraphProjectionBatch[1],
      ),
      checkpointSequence: nonNegativeDecimalSchema,
    })
    .strict(),
]);

export const sharedStateTransactionCommittedResultV1Schemas = {
  consumeReplayNonce: replayResultSchema,
  reserveRateLimitCost: rateLimitResultSchema,
  claimLease: leaseClaimResultSchema,
  renewLease: leaseRenewResultSchema,
  mutateWithFence: fencedMutationResultSchema,
  releaseLease: leaseReleaseResultSchema,
  executeIdempotent: idempotentResultSchema,
  appendOutbox: appendOutboxResultSchema,
  updateOutboxReceipt: updateReceiptResultSchema,
  acknowledgeOutbox: acknowledgeResultSchema,
  appendGraphSource: appendGraphSourceResultSchema,
  applyGraphProjectionBatch: applyGraphProjectionResultSchema,
  rollbackGraphProjectionBatch: rollbackGraphProjectionResultSchema,
} as const satisfies Record<SharedStateOperationV1, z.ZodType>;

type SharedStateCommittedResultByOperationV1 = {
  [Operation in SharedStateOperationV1]: z.infer<
    (typeof sharedStateTransactionCommittedResultV1Schemas)[Operation]
  >;
};

type SharedStateConsistencyForOperationV1<
  Operation extends SharedStateOperationV1,
> = {
  readonly model: (typeof V.operationConsistency)[Operation]["model"];
  readonly scope: (typeof V.operationConsistency)[Operation]["scope"];
};

type SharedStateCommittedEnvelopeForV1<
  Operation extends SharedStateOperationV1,
> = {
  readonly kind: typeof V.kinds.transactionResult;
  readonly contractVersion: typeof V.versions.contract;
  readonly transactionVersion: typeof V.versions.transaction;
  readonly operationVersion: typeof V.versions.operation;
  readonly operation: Operation;
  readonly status: (typeof V.transactionStatuses)[0];
  readonly consistency: SharedStateConsistencyForOperationV1<Operation>;
  readonly completeness: (typeof V.resultCompletenessStates)[0];
  readonly result: SharedStateCommittedResultByOperationV1[Operation];
};

type SharedStateRejectedEnvelopeForV1<
  Operation extends SharedStateOperationV1,
> = {
  readonly kind: typeof V.kinds.transactionResult;
  readonly contractVersion: typeof V.versions.contract;
  readonly transactionVersion: typeof V.versions.transaction;
  readonly operationVersion: typeof V.versions.operation;
  readonly operation: Operation;
  readonly status: (typeof V.transactionStatuses)[1];
  readonly consistency: SharedStateConsistencyForOperationV1<Operation>;
  readonly completeness: (typeof V.resultCompletenessStates)[0];
  readonly reasonCode:
    (typeof V.operationRejectionReasonCodes)[Operation][number];
};

type SharedStateUnavailableEnvelopeForV1<
  Operation extends SharedStateOperationV1,
> = {
  readonly kind: typeof V.kinds.transactionResult;
  readonly contractVersion: typeof V.versions.contract;
  readonly transactionVersion: typeof V.versions.transaction;
  readonly operationVersion: typeof V.versions.operation;
  readonly operation: Operation;
  readonly status: (typeof V.transactionStatuses)[2];
  readonly consistency: SharedStateConsistencyForOperationV1<Operation>;
  readonly completeness: (typeof V.resultCompletenessStates)[1];
  readonly reasonCode: SharedStateOperationUnavailableReasonCodeV1;
};

export type SharedStateTransactionResultV1 = {
  [Operation in SharedStateOperationV1]:
    | SharedStateCommittedEnvelopeForV1<Operation>
    | SharedStateRejectedEnvelopeForV1<Operation>
    | SharedStateUnavailableEnvelopeForV1<Operation>;
}[SharedStateOperationV1];

function consistencySchema<Operation extends SharedStateOperationV1>(
  operation: Operation,
) {
  const declaration = V.operationConsistency[operation];
  return z
    .object({
      model: z.literal(declaration.model),
      scope: z.literal(declaration.scope),
    })
    .strict();
}

function resultEnvelopeSchema<
  Operation extends SharedStateOperationV1,
  Schema extends z.ZodType,
>(
  operation: Operation,
  resultSchema: Schema,
  rejectionReasons: (typeof V.operationRejectionReasonCodes)[Operation],
) {
  const common = {
    kind: z.literal(V.kinds.transactionResult),
    contractVersion: z.literal(V.versions.contract),
    transactionVersion: z.literal(V.versions.transaction),
    operationVersion: z.literal(V.versions.operation),
    operation: z.literal(operation),
    consistency: consistencySchema(operation),
  };
  return z.discriminatedUnion("status", [
    z
      .object({
        ...common,
        status: z.literal(V.transactionStatuses[0]),
        completeness: z.literal(V.resultCompletenessStates[0]),
        result: resultSchema,
      })
      .strict(),
    z
      .object({
        ...common,
        status: z.literal(V.transactionStatuses[1]),
        completeness: z.literal(V.resultCompletenessStates[0]),
        reasonCode: z.enum(rejectionReasons),
      })
      .strict(),
    z
      .object({
        ...common,
        status: z.literal(V.transactionStatuses[2]),
        completeness: z.literal(V.resultCompletenessStates[1]),
        reasonCode: z.enum(V.unavailableReasonCodes),
      })
      .strict(),
  ]);
}

export const sharedStateTransactionResultV1Schema = z.discriminatedUnion(
  "operation",
  [
    resultEnvelopeSchema(
      V.operations[0],
      sharedStateTransactionCommittedResultV1Schemas.consumeReplayNonce,
      V.operationRejectionReasonCodes.consumeReplayNonce,
    ),
    resultEnvelopeSchema(
      V.operations[1],
      sharedStateTransactionCommittedResultV1Schemas.reserveRateLimitCost,
      V.operationRejectionReasonCodes.reserveRateLimitCost,
    ),
    resultEnvelopeSchema(
      V.operations[2],
      sharedStateTransactionCommittedResultV1Schemas.claimLease,
      V.operationRejectionReasonCodes.claimLease,
    ),
    resultEnvelopeSchema(
      V.operations[3],
      sharedStateTransactionCommittedResultV1Schemas.renewLease,
      V.operationRejectionReasonCodes.renewLease,
    ),
    resultEnvelopeSchema(
      V.operations[4],
      sharedStateTransactionCommittedResultV1Schemas.mutateWithFence,
      V.operationRejectionReasonCodes.mutateWithFence,
    ),
    resultEnvelopeSchema(
      V.operations[5],
      sharedStateTransactionCommittedResultV1Schemas.releaseLease,
      V.operationRejectionReasonCodes.releaseLease,
    ),
    resultEnvelopeSchema(
      V.operations[6],
      sharedStateTransactionCommittedResultV1Schemas.executeIdempotent,
      V.operationRejectionReasonCodes.executeIdempotent,
    ),
    resultEnvelopeSchema(
      V.operations[7],
      sharedStateTransactionCommittedResultV1Schemas.appendOutbox,
      V.operationRejectionReasonCodes.appendOutbox,
    ),
    resultEnvelopeSchema(
      V.operations[8],
      sharedStateTransactionCommittedResultV1Schemas.updateOutboxReceipt,
      V.operationRejectionReasonCodes.updateOutboxReceipt,
    ),
    resultEnvelopeSchema(
      V.operations[9],
      sharedStateTransactionCommittedResultV1Schemas.acknowledgeOutbox,
      V.operationRejectionReasonCodes.acknowledgeOutbox,
    ),
    resultEnvelopeSchema(
      V.operations[10],
      sharedStateTransactionCommittedResultV1Schemas.appendGraphSource,
      V.operationRejectionReasonCodes.appendGraphSource,
    ),
    resultEnvelopeSchema(
      V.operations[11],
      sharedStateTransactionCommittedResultV1Schemas.applyGraphProjectionBatch,
      V.operationRejectionReasonCodes.applyGraphProjectionBatch,
    ),
    resultEnvelopeSchema(
      V.operations[12],
      sharedStateTransactionCommittedResultV1Schemas.rollbackGraphProjectionBatch,
      V.operationRejectionReasonCodes.rollbackGraphProjectionBatch,
    ),
  ],
);

export const sharedStateDrainRequestV1Schema = z
  .object({
    kind: z.literal(V.kinds.drainRequest),
    drainVersion: z.literal(V.versions.drain),
    contractVersion: z.literal(V.versions.contract),
    timeoutMs: positiveDurationSchema,
  })
  .strict();

export type SharedStateDrainRequestV1 = z.infer<
  typeof sharedStateDrainRequestV1Schema
>;

/**
 * Structural seam for this bounded transaction/lifecycle slice only. It has no
 * runtime implementation and exposes only validated V1 envelopes. The broader
 * `query(request)` union remains checklist-open; this interface is not a claim
 * that a complete or conforming adapter exists.
 */
export interface SharedStateStorageTransactionV1 {
  execute(
    command: SharedStateTransactionCommandV1,
  ): Promise<SharedStateTransactionResultV1>;
}

export interface SharedStateStorageAdapterV1 {
  metadata(): SharedStateStorageMetadataV1;
  lifecycle(): SharedStateStorageLifecycleV1;
  open(
    expected: SharedStateStorageOpenRequirementsV1,
  ): Promise<SharedStateStorageLifecycleV1>;
  withTransaction<Result>(
    callback: (transaction: SharedStateStorageTransactionV1) => Promise<Result>,
  ): Promise<Result>;
  health(): Promise<SharedStateHealthProjectionV1>;
  drain(
    request: SharedStateDrainRequestV1,
  ): Promise<SharedStateStorageLifecycleV1>;
  close(): Promise<SharedStateStorageLifecycleV1>;
}

type RecordValue = Record<string, unknown>;

const CLOCK_FIELD_NAMES = new Set([
  "now",
  "nowms",
  "currenttime",
  "currenttimems",
  "clocktime",
  "clocktimems",
  "timestamp",
  "timestampms",
  "expiresat",
  "expiresatms",
  "expiresatunixms",
  "leaseexpiresat",
  "leaseexpiresatms",
  "leaseexpiresatunixms",
  "observedatunixms",
  "persistedfloorunixms",
  "minimumexpectedfloorunixms",
  "effectivenowunixms",
  "safeclampunixms",
  "eventatunixms",
  "retainuntilunixms",
  "backwardskewtolerancems",
  "createdat",
  "updatedat",
]);
const BACKEND_COMMAND_FIELD_NAMES = new Set([
  "sql",
  "statement",
  "backendcommand",
  "rawcommand",
  "script",
]);
const SENSITIVE_FIELD_NAMES = new Set([
  "apikey",
  "accesstoken",
  "authtoken",
  "bearer",
  "credential",
  "credentials",
  "password",
  "passwd",
  "secret",
  "refreshtoken",
  "privatekey",
  "dsn",
  "databaseurl",
  "databasepath",
  "dbpath",
  "filepath",
  "socketpath",
]);
const HEALTH_IDENTITY_FIELD_NAMES = new Set([
  "rawnonce",
  "noncedigest",
  "bucketkey",
  "bucketkeydigest",
  "requester",
  "requesterid",
  "worker",
  "workerid",
  "task",
  "taskid",
  "leaseowner",
  "leaseownerid",
  "ownerid",
  "eventid",
  "receiptid",
  "streamkey",
  "streamkeydigest",
  "claim",
  "claimtext",
  "artifact",
  "artifactpath",
  "provider",
  "providerid",
  "ip",
  "ipaddress",
  "nodeid",
  "edgeid",
  "sourcecontent",
  "provenancepayload",
]);

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedFieldName(value: string): string {
  return value.replace(/[-_]/g, "").toLowerCase();
}

function contractError(
  code: SharedStateContractErrorCodeV1,
  path: readonly (string | number)[] = [],
): SharedStateContractErrorV1 {
  return Object.freeze({ code, path: Object.freeze([...path]) });
}

function errorResult<T>(
  code: SharedStateContractErrorCodeV1,
  path: readonly (string | number)[] = [],
): SharedStateParseResultV1<T> {
  return { ok: false, error: contractError(code, path) };
}

function findForbiddenField(
  value: unknown,
  names: ReadonlySet<string>,
  path: readonly (string | number)[] = [],
): readonly (string | number)[] | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenField(value[index], names, [...path, index]);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [key, nested] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (names.has(normalizedFieldName(key))) return nextPath;
    const found = findForbiddenField(nested, names, nextPath);
    if (found) return found;
  }
  return null;
}

function preflightClosedInput<T>(
  input: unknown,
  options: {
    health?: boolean;
    versionFields?: readonly {
      field: string;
      expected: string | number;
      code: SharedStateContractErrorCodeV1;
    }[];
  } = {},
): SharedStateParseResultV1<T> | null {
  if (!isRecord(input)) return errorResult("invalid_type");

  for (const version of options.versionFields ?? []) {
    if (
      Object.hasOwn(input, version.field) &&
      input[version.field] !== version.expected
    ) {
      return errorResult(version.code, [version.field]);
    }
  }

  const clockField = findForbiddenField(input, CLOCK_FIELD_NAMES);
  if (clockField) return errorResult("caller_clock_forbidden", clockField);

  const backendCommandField = findForbiddenField(
    input,
    BACKEND_COMMAND_FIELD_NAMES,
  );
  if (backendCommandField) {
    return errorResult("backend_command_forbidden", backendCommandField);
  }

  const sensitiveField = findForbiddenField(input, SENSITIVE_FIELD_NAMES);
  if (sensitiveField) {
    return errorResult("sensitive_field_forbidden", sensitiveField);
  }

  if (options.health) {
    const identityField = findForbiddenField(
      input,
      HEALTH_IDENTITY_FIELD_NAMES,
    );
    if (identityField) {
      return errorResult("identity_health_field_forbidden", identityField);
    }
  }
  return null;
}

const DISCRIMINANT_FIELDS = new Set([
  "kind",
  "operation",
  "status",
  "state",
  "decision",
  "backendClass",
  "writerModel",
  "configuredGrade",
  "effectiveGrade",
  "source",
  "continuity",
]);

function mapZodError(error: z.ZodError): SharedStateContractErrorV1 {
  const issues = [...error.issues].sort((left, right) => {
    const leftPath = JSON.stringify(left.path);
    const rightPath = JSON.stringify(right.path);
    return leftPath.localeCompare(rightPath) || left.code.localeCompare(right.code);
  });
  const issue = issues[0];
  if (!issue) return contractError("invalid_value");
  const issuePath = issue.path.map((segment) =>
    typeof segment === "symbol"
      ? (segment.description ?? "symbol")
      : segment,
  );

  if (issue.code === "unrecognized_keys") {
    const key = [...issue.keys].sort()[0];
    return contractError("unknown_field", [...issuePath, key]);
  }
  const finalPath = issuePath[issuePath.length - 1];
  if (
    typeof finalPath === "string" &&
    DISCRIMINANT_FIELDS.has(finalPath)
  ) {
    return contractError("invalid_discriminant", issuePath);
  }
  if (issue.code === "invalid_type") {
    return contractError("invalid_type", issuePath);
  }
  if (issue.code === "invalid_union") {
    return contractError("invalid_discriminant", issuePath);
  }
  return contractError("invalid_value", issuePath);
}

function parseSchema<T>(
  schema: z.ZodType<T>,
  input: unknown,
): SharedStateParseResultV1<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: mapZodError(parsed.error) };
  }
  return { ok: true, value: parsed.data };
}

function firstDuplicate(
  values: readonly string[],
): number | null {
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (seen.has(value)) return index;
    seen.add(value);
  }
  return null;
}

function validateCapabilities(
  capabilities: SharedStateStorageCapabilitiesV1,
  writerModel: SharedStateWriterModelV1,
  pathPrefix: readonly (string | number)[],
): SharedStateContractErrorV1 | null {
  for (const key of V.capabilityKeys) {
    if (key === "exclusiveSingletonOwnership") continue;
    if (!capabilities[key]) {
      return contractError("capability_downgrade", [...pathPrefix, key]);
    }
  }
  if (writerModel === "single" && !capabilities.exclusiveSingletonOwnership) {
    return contractError("capability_downgrade", [
      ...pathPrefix,
      "exclusiveSingletonOwnership",
    ]);
  }
  if (writerModel === "multi" && capabilities.exclusiveSingletonOwnership) {
    return contractError("invalid_capability_combination", [
      ...pathPrefix,
      "exclusiveSingletonOwnership",
    ]);
  }
  return null;
}

function validateBackendCombination(
  backendClass: SharedStateBackendClassV1,
  writerModel: SharedStateWriterModelV1,
  clockAuthority: (typeof V.clockAuthorities)[number],
  pathPrefix: readonly (string | number)[] = [],
): SharedStateContractErrorV1 | null {
  const expectedWriter =
    backendClass === "sqlite-single-writer" ? "single" : "multi";
  const expectedClock =
    backendClass === "sqlite-single-writer"
      ? "adapter-controlled"
      : "backend-server";
  if (writerModel !== expectedWriter) {
    return contractError("invalid_capability_combination", [
      ...pathPrefix,
      "writerModel",
    ]);
  }
  if (clockAuthority !== expectedClock) {
    return contractError("invalid_capability_combination", [
      ...pathPrefix,
      "clockAuthority",
    ]);
  }
  return null;
}

export function parseSharedStateStorageMetadataV1(
  input: unknown,
): SharedStateParseResultV1<SharedStateStorageMetadataV1> {
  const preflight = preflightClosedInput<SharedStateStorageMetadataV1>(input, {
    versionFields: [
      {
        field: "contractVersion",
        expected: V.versions.contract,
        code: "unknown_contract_version",
      },
      {
        field: "metadataVersion",
        expected: V.versions.metadata,
        code: "unknown_metadata_version",
      },
      {
        field: "operationVersion",
        expected: V.versions.operation,
        code: "unknown_operation_version",
      },
    ],
  });
  if (preflight) return preflight;
  const parsed = parseSchema(sharedStateStorageMetadataV1Schema, input);
  if (!parsed.ok) return parsed;
  const backendError = validateBackendCombination(
    parsed.value.backendClass,
    parsed.value.writerModel,
    parsed.value.clockAuthority,
  );
  if (backendError) return { ok: false, error: backendError };
  const capabilityError = validateCapabilities(
    parsed.value.capabilities,
    parsed.value.writerModel,
    ["capabilities"],
  );
  if (capabilityError) return { ok: false, error: capabilityError };
  return parsed;
}

export function parseSharedStateStorageOpenRequirementsV1(
  input: unknown,
): SharedStateParseResultV1<SharedStateStorageOpenRequirementsV1> {
  const preflight =
    preflightClosedInput<SharedStateStorageOpenRequirementsV1>(input, {
      versionFields: [
        {
          field: "contractVersion",
          expected: V.versions.contract,
          code: "unknown_contract_version",
        },
        {
          field: "requirementsVersion",
          expected: V.versions.openRequirements,
          code: "unknown_requirements_version",
        },
        {
          field: "operationVersion",
          expected: V.versions.operation,
          code: "unknown_operation_version",
        },
      ],
    });
  if (preflight) return preflight;
  const parsed = parseSchema(sharedStateStorageOpenRequirementsV1Schema, input);
  if (!parsed.ok) return parsed;
  const backendError = validateBackendCombination(
    parsed.value.expectedBackendClass,
    parsed.value.expectedWriterModel,
    parsed.value.clockAuthority,
    ["expectedBackendClass"],
  );
  if (backendError) return { ok: false, error: backendError };
  const expectedOwnership =
    parsed.value.expectedWriterModel === "single"
      ? "required"
      : "not-required";
  if (parsed.value.topologyOwnership !== expectedOwnership) {
    return errorResult(
      "invalid_capability_combination",
      ["topologyOwnership"],
    );
  }
  if (
    parsed.value.expectedWriterModel === "single" &&
    parsed.value.expectedProcessCount !== 1
  ) {
    return errorResult(
      "invalid_capability_combination",
      ["expectedProcessCount"],
    );
  }
  const capabilityError = validateCapabilities(
    parsed.value.requiredCapabilities,
    parsed.value.expectedWriterModel,
    ["requiredCapabilities"],
  );
  if (capabilityError) return { ok: false, error: capabilityError };
  return parsed;
}

export function validateSharedStateStorageOpenCompatibilityV1(
  requirementsInput: unknown,
  metadataInput: unknown,
): SharedStateParseResultV1<{
  readonly requirements: SharedStateStorageOpenRequirementsV1;
  readonly metadata: SharedStateStorageMetadataV1;
}> {
  const requirements =
    parseSharedStateStorageOpenRequirementsV1(requirementsInput);
  if (!requirements.ok) return requirements;
  const metadata = parseSharedStateStorageMetadataV1(metadataInput);
  if (!metadata.ok) return metadata;

  if (
    metadata.value.backendClass !==
    requirements.value.expectedBackendClass
  ) {
    return errorResult("backend_class_mismatch", ["backendClass"]);
  }
  if (
    metadata.value.writerModel !==
    requirements.value.expectedWriterModel
  ) {
    return errorResult("writer_model_mismatch", ["writerModel"]);
  }
  if (
    metadata.value.schemaVersion !==
    requirements.value.expectedSchemaVersion
  ) {
    return errorResult("schema_version_mismatch", ["schemaVersion"]);
  }
  if (
    metadata.value.clockAuthority !== requirements.value.clockAuthority
  ) {
    return errorResult("clock_authority_mismatch", ["clockAuthority"]);
  }
  if (metadata.value.migrationState !== requirements.value.migrationState) {
    return errorResult("migration_state_mismatch", ["migrationState"]);
  }
  for (const key of V.capabilityKeys) {
    if (
      requirements.value.requiredCapabilities[key] &&
      !metadata.value.capabilities[key]
    ) {
      return errorResult("capability_downgrade", ["capabilities", key]);
    }
  }
  return {
    ok: true,
    value: {
      requirements: requirements.value,
      metadata: metadata.value,
    },
  };
}

export function parseSharedStateStorageLifecycleV1(
  input: unknown,
): SharedStateParseResultV1<SharedStateStorageLifecycleV1> {
  const preflight = preflightClosedInput<SharedStateStorageLifecycleV1>(input, {
    versionFields: [
      {
        field: "contractVersion",
        expected: V.versions.contract,
        code: "unknown_contract_version",
      },
      {
        field: "lifecycleVersion",
        expected: V.versions.lifecycle,
        code: "unknown_lifecycle_version",
      },
    ],
  });
  if (preflight) return preflight;
  const parsed = parseSchema(sharedStateStorageLifecycleV1Schema, input);
  if (!parsed.ok) return parsed;
  const duplicate = firstDuplicate(parsed.value.reasonCodes);
  if (duplicate !== null) {
    return errorResult("duplicate_value", ["reasonCodes", duplicate]);
  }
  if (
    (parsed.value.state === "ready" && parsed.value.reasonCodes.length > 0) ||
    (parsed.value.state === "failed" && parsed.value.reasonCodes.length === 0)
  ) {
    return errorResult("invalid_value", ["reasonCodes"]);
  }
  return parsed;
}

function validateHealthAdapterCombination(
  health: SharedStateHealthProjectionV1,
): SharedStateContractErrorV1 | null {
  const adapter = health.adapter;
  if (adapter.backendClass === "legacy-process") {
    if (
      adapter.contractVersion !== null ||
      adapter.durability !== "volatile" ||
      adapter.writerModel !== "single" ||
      adapter.schemaVersion !== null ||
      adapter.clockAuthority !== null ||
      adapter.migrationState !== null
    ) {
      return contractError("invalid_capability_combination", ["adapter"]);
    }
    return null;
  }
  if (adapter.backendClass === "legacy-sqlite") {
    if (
      adapter.contractVersion !== null ||
      adapter.durability !== "durable" ||
      adapter.writerModel !== "single" ||
      adapter.schemaVersion === null ||
      adapter.clockAuthority !== null ||
      adapter.migrationState !== null
    ) {
      return contractError("invalid_capability_combination", ["adapter"]);
    }
    return null;
  }
  if (
    adapter.contractVersion !== V.versions.contract ||
    adapter.durability !== "durable" ||
    adapter.schemaVersion === null ||
    adapter.clockAuthority === null ||
    adapter.migrationState === null
  ) {
    return contractError("invalid_capability_combination", ["adapter"]);
  }
  return validateBackendCombination(
    adapter.backendClass,
    adapter.writerModel,
    adapter.clockAuthority,
    ["adapter"],
  );
}

function validatePrimitiveHealth(
  primitive: SharedStateHealthProjectionV1["primitives"]["replay"],
  path: readonly (string | number)[],
): SharedStateContractErrorV1 | null {
  if (primitive.source === "process") {
    if (
      primitive.durability !== "volatile" ||
      primitive.continuity !== "reset" ||
      !primitive.resetRisk ||
      primitive.lastResetReason === null
    ) {
      return contractError("invalid_capability_combination", path);
    }
    return null;
  }
  if (
    primitive.durability !== "durable" ||
    primitive.continuity !== "preserved" ||
    primitive.resetRisk ||
    primitive.lastResetReason !== null
  ) {
    return contractError("invalid_capability_combination", path);
  }
  return null;
}

export function parseSharedStateHealthProjectionV1(
  input: unknown,
): SharedStateParseResultV1<SharedStateHealthProjectionV1> {
  const preflight = preflightClosedInput<SharedStateHealthProjectionV1>(input, {
    health: true,
    versionFields: [
      {
        field: "specVersion",
        expected: V.versions.health,
        code: "unknown_health_version",
      },
    ],
  });
  if (preflight) return preflight;
  if (
    isRecord(input) &&
    isRecord(input.adapter) &&
    input.adapter.contractVersion !== null &&
    input.adapter.contractVersion !== V.versions.contract
  ) {
    return errorResult("unknown_contract_version", [
      "adapter",
      "contractVersion",
    ]);
  }
  const parsed = parseSchema(sharedStateHealthProjectionV1Schema, input);
  if (!parsed.ok) return parsed;
  const health = parsed.value;

  const duplicate = firstDuplicate(health.reasonCodes);
  if (duplicate !== null) {
    return errorResult("duplicate_value", ["reasonCodes", duplicate]);
  }
  const adapterError = validateHealthAdapterCombination(health);
  if (adapterError) return { ok: false, error: adapterError };
  const replayError = validatePrimitiveHealth(health.primitives.replay, [
    "primitives",
    "replay",
  ]);
  if (replayError) return { ok: false, error: replayError };
  const rateError = validatePrimitiveHealth(health.primitives.rateLimit, [
    "primitives",
    "rateLimit",
  ]);
  if (rateError) return { ok: false, error: rateError };

  const configuredMatchesEffective =
    health.configuredGrade === health.effectiveGrade;
  if (
    !configuredMatchesEffective &&
    health.effectiveGrade !== "multi-process-unsupported"
  ) {
    return errorResult("invalid_capability_combination", ["effectiveGrade"]);
  }
  if (
    health.configuredGrade !== "shared-state-ha" &&
    health.topology.expectedProcessCount > 1 &&
    health.effectiveGrade !== "multi-process-unsupported"
  ) {
    return errorResult(
      "invalid_capability_combination",
      ["topology", "expectedProcessCount"],
    );
  }
  if (
    health.configuredGrade === "shared-state-ha" &&
    health.adapter.backendClass !== "shared" &&
    health.effectiveGrade !== "multi-process-unsupported"
  ) {
    return errorResult("invalid_capability_combination", [
      "adapter",
      "backendClass",
    ]);
  }
  if (
    health.configuredGrade === "single-writer-durable" &&
    health.adapter.backendClass !== "legacy-sqlite" &&
    health.adapter.backendClass !== "sqlite-single-writer" &&
    health.effectiveGrade !== "multi-process-unsupported"
  ) {
    return errorResult("invalid_capability_combination", [
      "adapter",
      "backendClass",
    ]);
  }

  const requiredReasons = new Set<
    (typeof V.readinessReasonCodes)[number]
  >();
  if (health.effectiveGrade === "multi-process-unsupported") {
    requiredReasons.add("unsupported_topology");
  }
  if (health.topology.ownership === "conflict") {
    requiredReasons.add("ownership_conflict");
  } else if (health.topology.ownership === "lost") {
    requiredReasons.add("lost_fence");
  } else if (health.topology.ownership === "unknown") {
    requiredReasons.add("adapter_unavailable");
  }
  if (health.clock.safety !== "safe") {
    requiredReasons.add("unsafe_clock");
  }
  if (health.adapter.migrationState === "incomplete") {
    requiredReasons.add("incomplete_migration");
  }
  if (health.adapter.lifecycle === "draining") {
    requiredReasons.add("draining");
  } else if (health.adapter.lifecycle === "closed") {
    requiredReasons.add("closed");
  } else if (health.adapter.lifecycle === "failed") {
    requiredReasons.add("adapter_failed");
  } else if (
    health.adapter.lifecycle === "new" ||
    health.adapter.lifecycle === "opening"
  ) {
    requiredReasons.add("adapter_unavailable");
  }
  for (const reason of requiredReasons) {
    if (!health.reasonCodes.includes(reason)) {
      return errorResult("invalid_value", ["reasonCodes"]);
    }
  }

  const migrationServiceable =
    health.adapter.contractVersion === null ||
    health.adapter.migrationState === "complete";
  const expectedServing =
    health.effectiveGrade !== "multi-process-unsupported" &&
    health.adapter.lifecycle === "ready" &&
    health.clock.safety === "safe" &&
    migrationServiceable &&
    health.reasonCodes.length === 0 &&
    (health.adapter.writerModel === "single"
      ? health.topology.ownership === "held"
      : health.topology.ownership === "not-required");
  if (health.serving !== expectedServing) {
    return errorResult("invalid_value", ["serving"]);
  }
  if (!health.serving && health.reasonCodes.length === 0) {
    return errorResult("invalid_value", ["reasonCodes"]);
  }
  if (
    health.completeness.negativeEvidenceAllowed !==
    (health.completeness.graphProjection === "complete")
  ) {
    return errorResult("invalid_value", [
      "completeness",
      "negativeEvidenceAllowed",
    ]);
  }
  return parsed;
}

function nestedValue(
  input: RecordValue,
  path: readonly string[],
): unknown {
  let current: unknown = input;
  for (const segment of path) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function contractDigestErrorCode(
  code: (typeof V.keyspaceErrorCodes)[number],
): SharedStateContractErrorCodeV1 {
  switch (code) {
    case "unknown_keyspace_version":
    case "unknown_digest_domain":
    case "digest_domain_mismatch":
    case "digest_namespace_mismatch":
      return code;
    default:
      return "invalid_digest";
  }
}

function validateTransactionDigestBindings<T>(
  input: RecordValue,
): SharedStateParseResultV1<T> | null {
  if (!V.operations.includes(input.operation as SharedStateOperationV1)) {
    return null;
  }
  const operation = input.operation as SharedStateOperationV1;
  const section =
    input.kind === V.kinds.transactionCommand
      ? "input"
      : input.kind === V.kinds.transactionResult &&
          input.status === V.transactionStatuses[0]
        ? "result"
        : null;
  if (section === null) return null;

  const namespace =
    section === "input" &&
    isRecord(input.input) &&
    typeof input.input.namespace === "string"
      ? input.input.namespace
      : undefined;
  const locationPrefix = `${operation}.${section}.`;

  for (const [rawDomain, specification] of Object.entries(V.digestDomains)) {
    for (const location of specification.operationFields) {
      if (!location.startsWith(locationPrefix)) continue;
      const relativePath = location.slice(locationPrefix.length).split(".");
      const envelopePath = [section, ...relativePath];
      const digest = nestedValue(input, envelopePath);
      if (digest === undefined) continue;
      const parsed = parseSharedStateDigestV1(digest, {
        domain: rawDomain as SharedStateDigestDomainV1,
        namespace,
      });
      if (!parsed.ok) {
        return errorResult(
          contractDigestErrorCode(parsed.error.code),
          envelopePath,
        );
      }
    }
  }
  return null;
}

function storageIdempotencyErrorCode(
  code: SharedStateIdempotencyErrorCodeV1,
): SharedStateContractErrorCodeV1 {
  switch (code) {
    case "invalid_namespace":
      return "invalid_idempotency_namespace";
    case "unknown_namespace":
      return "unknown_idempotency_namespace";
    case "invalid_retention_policy_version":
      return "invalid_idempotency_retention_policy_version";
    case "unknown_retention_policy_version":
      return "unknown_idempotency_retention_policy_version";
    case "retention_policy_mismatch":
      return "idempotency_retention_policy_mismatch";
    case "effect_policy_mismatch":
      return "idempotency_effect_policy_mismatch";
    default:
      return code === "invalid_type" ? "invalid_type" : "invalid_value";
  }
}

function validateExecuteIdempotentPolicyBinding<T>(
  input: RecordValue,
): SharedStateParseResultV1<T> | null {
  if (
    input.kind !== V.kinds.transactionCommand ||
    input.operation !== "executeIdempotent" ||
    !isRecord(input.input) ||
    typeof input.input.namespace !== "string" ||
    typeof input.input.retentionPolicyVersion !== "string" ||
    !isRecord(input.input.effect) ||
    typeof input.input.effect.kind !== "string"
  ) {
    return null;
  }
  const evaluated = evaluateSharedStateIdempotencyPolicyV1({
    namespace: input.input.namespace,
    retentionPolicyVersion: input.input.retentionPolicyVersion,
    effectKind: input.input.effect.kind,
  });
  if (evaluated.ok) return null;
  const mappedPath = evaluated.error.path[0] === "effectKind"
    ? ["input", "effect", "kind"]
    : ["input", ...evaluated.error.path];
  return errorResult(
    storageIdempotencyErrorCode(evaluated.error.code),
    mappedPath,
  );
}

function preflightTransactionEnvelope<T>(
  input: unknown,
): SharedStateParseResultV1<T> | null {
  const preflight = preflightClosedInput<T>(input, {
    versionFields: [
      {
        field: "contractVersion",
        expected: V.versions.contract,
        code: "unknown_contract_version",
      },
      {
        field: "transactionVersion",
        expected: V.versions.transaction,
        code: "unknown_transaction_version",
      },
      {
        field: "operationVersion",
        expected: V.versions.operation,
        code: "unknown_operation_version",
      },
    ],
  });
  if (preflight) return preflight;
  if (
    isRecord(input) &&
    Object.hasOwn(input, "operation") &&
    !V.operations.includes(input.operation as SharedStateOperationV1)
  ) {
    return errorResult("invalid_discriminant", ["operation"]);
  }
  if (isRecord(input)) {
    const idempotencyError = validateExecuteIdempotentPolicyBinding<T>(input);
    if (idempotencyError) return idempotencyError;
    const digestError = validateTransactionDigestBindings<T>(input);
    if (digestError) return digestError;
  }
  return null;
}

export function parseSharedStateTransactionCommandV1(
  input: unknown,
): SharedStateParseResultV1<SharedStateTransactionCommandV1> {
  const preflight =
    preflightTransactionEnvelope<SharedStateTransactionCommandV1>(input);
  if (preflight) return preflight;
  return parseSchema(
    sharedStateTransactionCommandV1Schema as z.ZodType<SharedStateTransactionCommandV1>,
    input,
  );
}

export function parseSharedStateTransactionResultV1(
  input: unknown,
): SharedStateParseResultV1<SharedStateTransactionResultV1> {
  const preflight =
    preflightTransactionEnvelope<SharedStateTransactionResultV1>(input);
  if (preflight) return preflight;
  const parsed = parseSchema(
    sharedStateTransactionResultV1Schema as z.ZodType<SharedStateTransactionResultV1>,
    input,
  );
  if (
    !parsed.ok &&
    isRecord(input) &&
    V.operations.includes(input.operation as SharedStateOperationV1) &&
    input.status === "committed" &&
    Object.hasOwn(input, "result")
  ) {
    return errorResult("operation_result_mismatch", ["result"]);
  }
  return parsed;
}

export function parseSharedStateDrainRequestV1(
  input: unknown,
): SharedStateParseResultV1<SharedStateDrainRequestV1> {
  const preflight = preflightClosedInput<SharedStateDrainRequestV1>(input, {
    versionFields: [
      {
        field: "contractVersion",
        expected: V.versions.contract,
        code: "unknown_contract_version",
      },
      {
        field: "drainVersion",
        expected: V.versions.drain,
        code: "unknown_drain_version",
      },
    ],
  });
  if (preflight) return preflight;
  return parseSchema(sharedStateDrainRequestV1Schema, input);
}
