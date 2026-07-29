/**
 * Backend-neutral parser and evaluator for
 * `a2a.shared-state.outbox/v1`.
 *
 * This module evaluates only the closed stream/policy catalog. It does not
 * append, sequence, deliver, update, acknowledge, replay, prune, migrate, or
 * connect any current broker authority to `SharedStateStorageAdapterV1`.
 */

import { z } from "zod";

import {
  digestSharedStateKeyV1,
  parseSharedStateDigestV1,
} from "./shared-state-storage-keyspace-v1.js";
import {
  SHARED_STATE_OUTBOX_V1_VALUES as V,
} from "./shared-state-outbox-v1-values.js";

export {
  SHARED_STATE_OUTBOX_V1_VALUES,
} from "./shared-state-outbox-v1-values.js";

export type SharedStateOutboxOperationV1 =
  (typeof V.operations)[number];
export type SharedStateOutboxEventPurposeV1 =
  (typeof V.eventPurposes)[number];
export type SharedStateOutboxReceiptEvidenceKindV1 =
  (typeof V.receiptEvidenceKinds)[number];
export type SharedStateOutboxErrorCodeV1 =
  (typeof V.errorCodes)[number];
export type SharedStateOutboxEvaluationReasonCodeV1 =
  (typeof V.evaluationReasonCodes)[number];

export interface SharedStateOutboxErrorV1 {
  readonly code: SharedStateOutboxErrorCodeV1;
  readonly path: readonly (string | number)[];
}

export type SharedStateOutboxResultV1<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SharedStateOutboxErrorV1 };

const sourceRefSchema = z
  .object({
    path: z.string().min(1).max(V.limits.sourcePathLength),
    symbol: z.string().min(1).max(V.limits.sourceSymbolLength),
    proves: z
      .array(z.enum(V.evidenceProperties))
      .min(1)
      .max(V.limits.maxEvidenceProperties),
  })
  .strict();

const producerSchema = z
  .object({
    producerId: z.string().min(1).max(V.limits.producerIdLength),
    eventPurpose: z.enum(V.eventPurposes),
    eventIdAuthority: z.enum(V.eventIdAuthorities),
    sourceRefs: z
      .array(sourceRefSchema)
      .min(1)
      .max(V.limits.maxSourceRefs),
  })
  .strict();

const authoritySchema = z
  .object({
    authorityId: z.string().min(1).max(V.limits.authorityIdLength),
    status: z.enum(V.authorityStatuses),
    currentStorageAuthority: z.string().min(1).max(192),
    currentStreamKeyDerivation: z.string().min(1).max(192),
    currentOrderingAuthority: z.enum(V.currentOrderingAuthorities),
    currentSequenceAuthority: z.enum(V.currentSequenceAuthorities),
    currentReceiptAuthority: z.enum(V.currentReceiptAuthorities),
    currentRetentionPosture: z.enum(V.currentRetentionPostures),
    sourceRefs: z
      .array(sourceRefSchema)
      .min(1)
      .max(V.limits.maxSourceRefs),
    producers: z
      .array(producerSchema)
      .min(1)
      .max(V.limits.maxProducers),
  })
  .strict();

const catalogStreamKeyComponentSchema = z
  .object({
    field: z.enum(["streamType", "streamId"]),
    type: z.literal("utf8"),
    valueAuthority: z.enum(V.streamKeyValueAuthorities),
    literalValue: z.string().min(1).max(
      V.limits.streamComponentValueLength,
    ).nullable(),
  })
  .strict();

const registrationSchema = z
  .object({
    registrationId: z
      .string()
      .min(1)
      .max(V.limits.registrationIdLength),
    status: z.enum(V.registrationStatuses),
    namespace: z.string().min(1).max(V.limits.namespaceLength),
    eventPurpose: z.enum(V.eventPurposes),
    authorityId: z.string().min(1).max(V.limits.authorityIdLength),
    producerId: z.string().min(1).max(V.limits.producerIdLength),
    streamKeyComponents: z
      .array(catalogStreamKeyComponentSchema)
      .length(2),
    orderingScope: z.enum(V.orderingScopes),
    sequenceAuthority: z.enum(V.sequenceAuthorities),
    monotonicityRule: z.enum(V.monotonicityRules),
    crossStreamOrder: z.enum(V.crossStreamOrderPostures),
    callerSequencePolicy: z.enum(V.callerSequencePolicies),
    eventIdAuthority: z.enum(V.eventIdAuthorities),
    idempotencyBinding: z.enum(V.idempotencyBindings),
    receiptPolicyVersion: z.enum(V.receiptPolicyVersions),
    receiptAuthority: z.enum(V.receiptAuthorities),
    acknowledgmentPolicyVersion: z.enum(
      V.acknowledgmentPolicyVersions,
    ),
    acknowledgmentAuthority: z.enum(V.acknowledgmentAuthorities),
    providerAcceptancePosture: z.enum(
      V.providerAcceptancePostures,
    ),
    retentionPolicyVersion: z.enum(V.retentionPolicyVersions),
    retentionPosture: z.enum(V.retentionPostures),
    prunePolicy: z.enum(V.prunePolicies),
    pruneEligibilityPreconditions: z
      .array(z.enum(V.pruneEligibilityPreconditions))
      .max(V.limits.maxPrunePreconditions),
    migrationRollbackPreservationRule: z.enum(
      V.migrationRollbackPreservationRules,
    ),
  })
  .strict();

export const sharedStateOutboxCatalogV1Schema = z
  .object({
    kind: z.literal(V.kind),
    catalogVersion: z.literal(V.version),
    storageContractVersion: z.literal(V.storageContractVersion),
    keyspaceVersion: z.literal(V.keyspaceVersion),
    runtimeIntegration: z.literal(V.runtimeIntegration),
    extensionPolicy: z.literal(V.extensionPolicy),
    defaultStreamNamespace: z.null(),
    defaultOrderingScope: z.null(),
    globalOrdering: z.literal(false),
    authorities: z.array(authoritySchema).min(1),
    entries: z.array(registrationSchema).min(1),
  })
  .strict();

const streamKeyComponentInputSchema = z
  .object({
    field: z.string(),
    type: z.string(),
    value: z.unknown(),
  })
  .strict();

export const sharedStateOutboxStreamKeyInputV1Schema = z
  .object({
    keyspaceVersion: z.string(),
    components: z.array(streamKeyComponentInputSchema),
  })
  .strict();

export type SharedStateOutboxCatalogV1 = z.infer<
  typeof sharedStateOutboxCatalogV1Schema
>;
export type SharedStateOutboxAuthorityV1 =
  SharedStateOutboxCatalogV1["authorities"][number];
export type SharedStateOutboxProducerV1 =
  SharedStateOutboxAuthorityV1["producers"][number];
export type SharedStateOutboxRegistrationV1 =
  SharedStateOutboxCatalogV1["entries"][number];
export type SharedStateOutboxStreamKeyInputV1 = z.infer<
  typeof sharedStateOutboxStreamKeyInputV1Schema
>;

export interface SharedStateOutboxPolicyInputV1 {
  readonly operation: string;
  readonly namespace: string;
  readonly eventPurpose: string;
  readonly streamKey: SharedStateOutboxStreamKeyInputV1;
  readonly streamKeyDigest: string;
  readonly orderingScope: string;
  readonly retentionPolicyVersion: string;
  readonly receiptPolicyVersion: string;
  readonly acknowledgmentPolicyVersion: string;
  readonly receiptEvidenceKind?: string;
  readonly expectedReceiptState?: string;
  readonly newReceiptState?: string;
  readonly expectedAcknowledgmentState?: string;
}

export interface SharedStateOutboxPolicyEvaluationV1 {
  readonly decision: "registered";
  readonly reasonCode:
    | "registered_append_policy"
    | "registered_receipt_policy"
    | "registered_acknowledgment_policy";
  readonly operation: SharedStateOutboxOperationV1;
  readonly registration: SharedStateOutboxRegistrationV1;
  readonly streamKeyDigest: string;
  readonly orderingBinding: string;
}

export interface SharedStateOutboxRetentionInputV1 {
  readonly receiptState: string;
  readonly acknowledgmentState: string;
  readonly providerAcceptanceObserved: boolean;
  readonly consumerCheckpointSafetyProved: boolean;
  readonly idempotencyRetrySourcesGone: boolean;
  readonly migrationRollbackPreservationProved: boolean;
  readonly separateRetentionApprovalRecorded: boolean;
}

export type SharedStateOutboxRetentionEvaluationV1 =
  | {
      readonly decision: "retain";
      readonly reasonCode:
        | "retain_unacknowledged"
        | "retain_provider_acceptance_not_ack"
        | "retain_prune_proof_incomplete"
        | "retain_v1_prune_forbidden";
      readonly registration: SharedStateOutboxRegistrationV1;
    }
  | {
      readonly decision: "prune-eligible";
      readonly reasonCode: "prune_preconditions_satisfied";
      readonly registration: SharedStateOutboxRegistrationV1;
    };

export type SharedStateOutboxOrderingEvaluationV1 =
  | {
      readonly decision: "same-stream";
      readonly reasonCode: "same_stream_total_order";
      readonly orderingScope: "total-within-exact-stream-key";
    }
  | {
      readonly decision: "different-streams";
      readonly reasonCode: "cross_stream_no_order";
      readonly orderingScope: null;
    };

export interface SharedStateOutboxCommittedBindingV1 {
  readonly namespace: string;
  readonly idempotencyKeyDigest: string;
  readonly payloadDigest: string;
  readonly eventKeyDigest: string;
  readonly streamSequence: string;
}

export interface SharedStateOutboxRetryBindingInputV1 {
  readonly original: SharedStateOutboxCommittedBindingV1;
  readonly retry: SharedStateOutboxCommittedBindingV1;
}

export interface SharedStateOutboxRetryBindingEvaluationV1 {
  readonly decision: "original-binding";
  readonly reasonCode: "idempotent_retry_returns_original_binding";
  readonly eventKeyDigest: string;
  readonly streamSequence: string;
}

type RecordValue = Record<string, unknown>;

const NAMESPACE_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const POLICY_VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const AUTHORITY_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const POSITIVE_DECIMAL_PATTERN = new RegExp(
  `^[1-9][0-9]{0,${V.limits.maxDecimalDigits - 1}}$`,
);
const BASE_POLICY_FIELDS = [
  "operation",
  "namespace",
  "eventPurpose",
  "streamKey",
  "streamKeyDigest",
  "orderingScope",
  "retentionPolicyVersion",
  "receiptPolicyVersion",
  "acknowledgmentPolicyVersion",
] as const;
const RECEIPT_POLICY_FIELDS = [
  ...BASE_POLICY_FIELDS,
  "receiptEvidenceKind",
  "expectedReceiptState",
  "newReceiptState",
] as const;
const ACKNOWLEDGMENT_POLICY_FIELDS = [
  ...BASE_POLICY_FIELDS,
  "receiptEvidenceKind",
  "expectedReceiptState",
  "expectedAcknowledgmentState",
] as const;
const RETENTION_FIELDS = [
  "receiptState",
  "acknowledgmentState",
  "providerAcceptanceObserved",
  "consumerCheckpointSafetyProved",
  "idempotencyRetrySourcesGone",
  "migrationRollbackPreservationProved",
  "separateRetentionApprovalRecorded",
] as const;
const RETRY_BINDING_FIELDS = ["original", "retry"] as const;
const COMMITTED_BINDING_FIELDS = [
  "namespace",
  "idempotencyKeyDigest",
  "payloadDigest",
  "eventKeyDigest",
  "streamSequence",
] as const;
const CALLER_SEQUENCE_FIELDS = new Set([
  "sequence",
  "streamsequence",
  "expectedstreamsequence",
  "nextstreamsequence",
]);
const RECEIPT_CONFIRMING_EVIDENCE = new Set([
  "current-session-visible",
  "operator-visible",
  "operator-confirmed",
]);
const PROVIDER_ACCEPTANCE_EVIDENCE = new Set([
  "provider-sent",
  "provider-accepted",
]);

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorResult<T>(
  code: SharedStateOutboxErrorCodeV1,
  path: readonly (string | number)[] = [],
): SharedStateOutboxResultV1<T> {
  return {
    ok: false,
    error: Object.freeze({ code, path: Object.freeze([...path]) }),
  };
}

function firstUnknownField(
  value: RecordValue,
  allowed: readonly string[],
): string | null {
  const allowedSet = new Set(allowed);
  return Object.keys(value).filter((key) => !allowedSet.has(key)).sort()[0] ??
    null;
}

function normalizedFieldName(value: string): string {
  return value.replace(/[-_]/g, "").toLowerCase();
}

function firstCallerSequencePath(
  value: unknown,
  path: readonly (string | number)[] = [],
): readonly (string | number)[] | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = firstCallerSequencePath(value[index], [...path, index]);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const key of Object.keys(value).sort()) {
    const nextPath = [...path, key];
    if (CALLER_SEQUENCE_FIELDS.has(normalizedFieldName(key))) {
      return nextPath;
    }
    const found = firstCallerSequencePath(value[key], nextPath);
    if (found) return found;
  }
  return null;
}

function firstDuplicate(values: readonly string[]): number | null {
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    if (seen.has(values[index])) return index;
    seen.add(values[index]);
  }
  return null;
}

function mapZodError(error: z.ZodError): SharedStateOutboxErrorV1 {
  const issues = [...error.issues].sort((left, right) => {
    const leftPath = JSON.stringify(left.path);
    const rightPath = JSON.stringify(right.path);
    return leftPath.localeCompare(rightPath) ||
      left.code.localeCompare(right.code);
  });
  const issue = issues[0];
  if (!issue) return Object.freeze({ code: "invalid_value", path: [] });
  const path = issue.path.map((segment) =>
    typeof segment === "symbol"
      ? (segment.description ?? "symbol")
      : segment
  );
  if (issue.code === "unrecognized_keys") {
    const key = [...issue.keys].sort()[0];
    return Object.freeze({
      code: "unknown_field",
      path: Object.freeze([...path, key]),
    });
  }
  return Object.freeze({
    code: issue.code === "invalid_type" ? "invalid_type" : "invalid_value",
    path: Object.freeze(path),
  });
}

function validateSourceRefs(
  refs: readonly z.infer<typeof sourceRefSchema>[],
  path: readonly (string | number)[],
): SharedStateOutboxResultV1<SharedStateOutboxCatalogV1> | null {
  for (let index = 0; index < refs.length; index += 1) {
    if (firstDuplicate(refs[index].proves) !== null) {
      return errorResult("invalid_value", [
        ...path,
        index,
        "proves",
      ]);
    }
  }
  return null;
}

function validateCatalogMappings(
  catalog: SharedStateOutboxCatalogV1,
): SharedStateOutboxResultV1<SharedStateOutboxCatalogV1> | null {
  const authorityDuplicate = firstDuplicate(
    catalog.authorities.map((authority) => authority.authorityId),
  );
  if (authorityDuplicate !== null) {
    return errorResult("duplicate_authority", [
      "authorities",
      authorityDuplicate,
      "authorityId",
    ]);
  }

  const allProducers = catalog.authorities.flatMap(
    (authority, authorityIndex) =>
      authority.producers.map((producer, producerIndex) => ({
      authorityId: authority.authorityId,
      authorityIndex,
      producerIndex,
      producer,
    })),
  );
  const producerDuplicate = firstDuplicate(
    allProducers.map(({ producer }) => producer.producerId),
  );
  if (producerDuplicate !== null) {
    const duplicate = allProducers[producerDuplicate];
    return errorResult("duplicate_producer", [
      "authorities",
      duplicate.authorityIndex,
      "producers",
      duplicate.producerIndex,
      "producerId",
    ]);
  }

  const registrationDuplicate = firstDuplicate(
    catalog.entries.map((entry) => entry.registrationId),
  );
  if (registrationDuplicate !== null) {
    return errorResult("duplicate_registration", [
      "entries",
      registrationDuplicate,
      "registrationId",
    ]);
  }
  const pairDuplicate = firstDuplicate(
    catalog.entries.map((entry) =>
      `${entry.namespace}\u0000${entry.eventPurpose}`
    ),
  );
  if (pairDuplicate !== null) {
    return errorResult("duplicate_registration", [
      "entries",
      pairDuplicate,
      "eventPurpose",
    ]);
  }

  const authorities = new Map(
    catalog.authorities.map((authority) => [
      authority.authorityId,
      authority,
    ]),
  );
  const mappedProducers = new Set<string>();
  for (let index = 0; index < catalog.entries.length; index += 1) {
    const entry = catalog.entries[index];
    const authority = authorities.get(entry.authorityId);
    if (!authority) {
      return errorResult("unknown_authority", [
        "entries",
        index,
        "authorityId",
      ]);
    }
    const producer = authority.producers.find(
      (candidate) => candidate.producerId === entry.producerId,
    );
    if (!producer) {
      return errorResult("unknown_producer", [
        "entries",
        index,
        "producerId",
      ]);
    }
    if (
      producer.eventPurpose !== entry.eventPurpose ||
      producer.eventIdAuthority !== entry.eventIdAuthority
    ) {
      return errorResult("producer_mapping_mismatch", [
        "entries",
        index,
        producer.eventPurpose !== entry.eventPurpose
          ? "eventPurpose"
          : "eventIdAuthority",
      ]);
    }
    mappedProducers.add(entry.producerId);
  }

  for (let authorityIndex = 0;
    authorityIndex < catalog.authorities.length;
    authorityIndex += 1) {
    const authority = catalog.authorities[authorityIndex];
    for (let producerIndex = 0;
      producerIndex < authority.producers.length;
      producerIndex += 1) {
      if (!mappedProducers.has(authority.producers[producerIndex].producerId)) {
        return errorResult("authority_mapping_mismatch", [
          "authorities",
          authorityIndex,
          "producers",
          producerIndex,
          "producerId",
        ]);
      }
    }
  }
  return null;
}

function validateCatalogSafety(
  catalog: SharedStateOutboxCatalogV1,
): SharedStateOutboxResultV1<SharedStateOutboxCatalogV1> | null {
  if (
    catalog.entries.length !== V.eventPurposes.length ||
    new Set(catalog.entries.map((entry) => entry.eventPurpose)).size !==
      V.eventPurposes.length ||
    V.eventPurposes.some((purpose) =>
      !catalog.entries.some((entry) => entry.eventPurpose === purpose)
    )
  ) {
    return errorResult("incomplete_registry", ["entries"]);
  }

  for (let authorityIndex = 0;
    authorityIndex < catalog.authorities.length;
    authorityIndex += 1) {
    const authority = catalog.authorities[authorityIndex];
    if (!AUTHORITY_ID_PATTERN.test(authority.authorityId)) {
      return errorResult("invalid_value", [
        "authorities",
        authorityIndex,
        "authorityId",
      ]);
    }
    const sourceError = validateSourceRefs(authority.sourceRefs, [
      "authorities",
      authorityIndex,
      "sourceRefs",
    ]);
    if (sourceError) return sourceError;
    for (let producerIndex = 0;
      producerIndex < authority.producers.length;
      producerIndex += 1) {
      if (
        !AUTHORITY_ID_PATTERN.test(
          authority.producers[producerIndex].producerId,
        )
      ) {
        return errorResult("invalid_value", [
          "authorities",
          authorityIndex,
          "producers",
          producerIndex,
          "producerId",
        ]);
      }
      const producerSourceError = validateSourceRefs(
        authority.producers[producerIndex].sourceRefs,
        [
          "authorities",
          authorityIndex,
          "producers",
          producerIndex,
          "sourceRefs",
        ],
      );
      if (producerSourceError) return producerSourceError;
    }
  }

  for (let index = 0; index < catalog.entries.length; index += 1) {
    const entry = catalog.entries[index];
    const prefix = ["entries", index] as const;
    if (
      !NAMESPACE_PATTERN.test(entry.namespace) ||
      entry.namespace !== "broker.terminal-outbox"
    ) {
      return errorResult("invalid_namespace", [...prefix, "namespace"]);
    }
    const [streamType, streamId] = entry.streamKeyComponents;
    if (
      streamType.field !== "streamType" ||
      streamType.type !== "utf8" ||
      streamType.valueAuthority !== "catalog-literal" ||
      streamType.literalValue !== "broker-terminal-outbox"
    ) {
      return errorResult("unsafe_registration", [
        ...prefix,
        "streamKeyComponents",
        0,
      ]);
    }
    if (
      streamId.field !== "streamId" ||
      streamId.type !== "utf8" ||
      streamId.valueAuthority !== "broker-authority-id" ||
      streamId.literalValue !== null
    ) {
      return errorResult("unsafe_registration", [
        ...prefix,
        "streamKeyComponents",
        1,
      ]);
    }
    if (
      entry.orderingScope !== "total-within-exact-stream-key" ||
      entry.sequenceAuthority !==
        "adapter-allocated-per-exact-stream-key" ||
      entry.monotonicityRule !==
        "unique-strictly-increasing-gaps-allowed" ||
      entry.crossStreamOrder !== "no-global-cross-stream-order" ||
      entry.callerSequencePolicy !== "forbidden" ||
      entry.idempotencyBinding !==
        "same-key-and-payload-return-original-event-id-and-sequence" ||
      entry.retentionPosture !==
        "unacknowledged-non-expiring-until-prune-proof" ||
      entry.migrationRollbackPreservationRule !==
        V.migrationRollbackPreservationRules[0]
    ) {
      return errorResult("unsafe_registration", prefix);
    }

    const duplicatePrune = firstDuplicate(
      entry.pruneEligibilityPreconditions,
    );
    if (duplicatePrune !== null) {
      return errorResult("unsafe_registration", [
        ...prefix,
        "pruneEligibilityPreconditions",
        duplicatePrune,
      ]);
    }

    if (
      entry.acknowledgmentAuthority === "forbidden-projection-evidence"
    ) {
      if (
        entry.eventPurpose !== "cross-broker-projection-evidence" ||
        entry.providerAcceptancePosture !==
          "forbidden-on-projection-evidence" ||
        entry.prunePolicy !== "v1-prune-forbidden" ||
        entry.pruneEligibilityPreconditions.length !== 0
      ) {
        return errorResult("unsafe_registration", prefix);
      }
    } else {
      if (
        entry.providerAcceptancePosture !==
          "pending-receipt-only-never-ack" ||
        entry.prunePolicy !== "receipt-confirmed-proof-gated"
      ) {
        return errorResult("unsafe_registration", prefix);
      }
      for (const required of V.pruneEligibilityPreconditions) {
        if (!entry.pruneEligibilityPreconditions.includes(required)) {
          return errorResult("unsafe_registration", [
            ...prefix,
            "pruneEligibilityPreconditions",
          ]);
        }
      }
    }
  }
  return null;
}

export function parseSharedStateOutboxCatalogV1(
  input: unknown,
): SharedStateOutboxResultV1<SharedStateOutboxCatalogV1> {
  if (!isRecord(input)) return errorResult("invalid_type");
  if (
    Object.hasOwn(input, "catalogVersion") &&
    input.catalogVersion !== V.version
  ) {
    return errorResult("unknown_catalog_version", ["catalogVersion"]);
  }
  const parsed = sharedStateOutboxCatalogV1Schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: mapZodError(parsed.error) };
  }
  const safetyError = validateCatalogSafety(parsed.data);
  if (safetyError) return safetyError;
  const mappingError = validateCatalogMappings(parsed.data);
  if (mappingError) return mappingError;
  return {
    ok: true,
    value: deepFreeze(parsed.data) as SharedStateOutboxCatalogV1,
  };
}

let parsedCanonicalCatalog: SharedStateOutboxCatalogV1 | undefined;

export function sharedStateOutboxCatalogV1():
  SharedStateOutboxCatalogV1 {
  if (!parsedCanonicalCatalog) {
    const parsed = parseSharedStateOutboxCatalogV1(V.catalog);
    if (!parsed.ok) {
      throw new Error(
        `invalid built-in shared-state outbox catalog: ${parsed.error.code}`,
      );
    }
    parsedCanonicalCatalog = parsed.value;
  }
  return parsedCanonicalCatalog;
}

function validatePolicyVersion(
  value: unknown,
  field: string,
  invalidCode:
    | "invalid_retention_policy_version"
    | "invalid_receipt_policy_version"
    | "invalid_acknowledgment_policy_version",
): SharedStateOutboxResultV1<string> {
  if (typeof value !== "string") return errorResult("invalid_type", [field]);
  if (
    value.length > V.limits.policyVersionLength ||
    !POLICY_VERSION_PATTERN.test(value)
  ) {
    return errorResult(invalidCode, [field]);
  }
  return { ok: true, value };
}

function evaluateStreamKey(
  input: RecordValue,
  namespace: string,
  registration: SharedStateOutboxRegistrationV1,
): SharedStateOutboxResultV1<{
  readonly streamKeyDigest: string;
  readonly orderingBinding: string;
}> {
  if (!isRecord(input.streamKey)) {
    return errorResult("invalid_stream_key", ["streamKey"]);
  }
  const unknownStreamKey = firstUnknownField(input.streamKey, [
    "keyspaceVersion",
    "components",
  ]);
  if (unknownStreamKey !== null) {
    return errorResult("unknown_field", ["streamKey", unknownStreamKey]);
  }
  if (input.streamKey.keyspaceVersion !== V.keyspaceVersion) {
    return errorResult("invalid_stream_key", [
      "streamKey",
      "keyspaceVersion",
    ]);
  }
  if (
    !Array.isArray(input.streamKey.components) ||
    input.streamKey.components.length !==
      registration.streamKeyComponents.length
  ) {
    return errorResult("stream_key_shape_mismatch", [
      "streamKey",
      "components",
    ]);
  }

  for (let index = 0;
    index < registration.streamKeyComponents.length;
    index += 1) {
    const actual = input.streamKey.components[index];
    const expected = registration.streamKeyComponents[index];
    const path = ["streamKey", "components", index] as const;
    if (!isRecord(actual)) {
      return errorResult("stream_key_shape_mismatch", path);
    }
    const unknownComponent = firstUnknownField(actual, [
      "field",
      "type",
      "value",
    ]);
    if (unknownComponent !== null) {
      return errorResult("unknown_field", [...path, unknownComponent]);
    }
    if (
      actual.field !== expected.field ||
      actual.type !== expected.type
    ) {
      return errorResult("stream_key_component_mismatch", [
        ...path,
        actual.field !== expected.field ? "field" : "type",
      ]);
    }
    if (
      expected.literalValue !== null &&
      actual.value !== expected.literalValue
    ) {
      return errorResult("stream_key_component_mismatch", [
        ...path,
        "value",
      ]);
    }
    if (
      expected.valueAuthority === "broker-authority-id" &&
      (
        typeof actual.value !== "string" ||
        actual.value.length > V.limits.streamComponentValueLength ||
        !IDENTIFIER_PATTERN.test(actual.value)
      )
    ) {
      return errorResult("invalid_stream_key_component", [
        ...path,
        "value",
      ]);
    }
  }

  const digest = digestSharedStateKeyV1({
    keyspaceVersion: V.keyspaceVersion,
    domain: "broker.outbox.stream-key",
    namespace,
    components: input.streamKey.components,
  });
  if (!digest.ok) {
    return errorResult("invalid_stream_key", [
      "streamKey",
      ...digest.error.path,
    ]);
  }
  if (input.streamKeyDigest !== digest.value.digest) {
    return errorResult("stream_key_digest_mismatch", [
      "streamKeyDigest",
    ]);
  }
  return {
    ok: true,
    value: Object.freeze({
      streamKeyDigest: digest.value.digest,
      orderingBinding:
        `${registration.orderingScope}:${digest.value.digest}`,
    }),
  };
}

function policyVersionBinding(
  input: RecordValue,
  registration: SharedStateOutboxRegistrationV1,
): SharedStateOutboxResultV1<true> {
  const retention = validatePolicyVersion(
    input.retentionPolicyVersion,
    "retentionPolicyVersion",
    "invalid_retention_policy_version",
  );
  if (!retention.ok) return retention;
  const receipt = validatePolicyVersion(
    input.receiptPolicyVersion,
    "receiptPolicyVersion",
    "invalid_receipt_policy_version",
  );
  if (!receipt.ok) return receipt;
  const acknowledgment = validatePolicyVersion(
    input.acknowledgmentPolicyVersion,
    "acknowledgmentPolicyVersion",
    "invalid_acknowledgment_policy_version",
  );
  if (!acknowledgment.ok) return acknowledgment;

  const catalog = sharedStateOutboxCatalogV1();
  if (
    !catalog.entries.some((entry) =>
      entry.retentionPolicyVersion === retention.value
    )
  ) {
    return errorResult("unknown_retention_policy_version", [
      "retentionPolicyVersion",
    ]);
  }
  if (
    !catalog.entries.some((entry) =>
      entry.receiptPolicyVersion === receipt.value
    )
  ) {
    return errorResult("unknown_receipt_policy_version", [
      "receiptPolicyVersion",
    ]);
  }
  if (
    !catalog.entries.some((entry) =>
      entry.acknowledgmentPolicyVersion === acknowledgment.value
    )
  ) {
    return errorResult("unknown_acknowledgment_policy_version", [
      "acknowledgmentPolicyVersion",
    ]);
  }
  if (registration.retentionPolicyVersion !== retention.value) {
    return errorResult("retention_policy_mismatch", [
      "retentionPolicyVersion",
    ]);
  }
  if (registration.receiptPolicyVersion !== receipt.value) {
    return errorResult("receipt_policy_mismatch", [
      "receiptPolicyVersion",
    ]);
  }
  if (
    registration.acknowledgmentPolicyVersion !== acknowledgment.value
  ) {
    return errorResult("acknowledgment_policy_mismatch", [
      "acknowledgmentPolicyVersion",
    ]);
  }
  return { ok: true, value: true };
}

function validateReceiptPolicy(
  input: RecordValue,
  registration: SharedStateOutboxRegistrationV1,
): SharedStateOutboxResultV1<true> {
  if (
    typeof input.receiptEvidenceKind !== "string" ||
    !V.receiptEvidenceKinds.includes(
      input.receiptEvidenceKind as SharedStateOutboxReceiptEvidenceKindV1,
    )
  ) {
    return errorResult("receipt_transition_mismatch", [
      "receiptEvidenceKind",
    ]);
  }
  if (
    typeof input.expectedReceiptState !== "string" ||
    !V.receiptStates.includes(
      input.expectedReceiptState as (typeof V.receiptStates)[number],
    )
  ) {
    return errorResult("receipt_transition_mismatch", [
      "expectedReceiptState",
    ]);
  }
  if (
    typeof input.newReceiptState !== "string" ||
    !V.receiptStates.includes(
      input.newReceiptState as (typeof V.receiptStates)[number],
    )
  ) {
    return errorResult("receipt_transition_mismatch", [
      "newReceiptState",
    ]);
  }

  const evidence = input.receiptEvidenceKind;
  const expected = input.expectedReceiptState;
  const next = input.newReceiptState;
  if (
    registration.eventPurpose === "cross-broker-projection-evidence"
  ) {
    if (
      evidence !== "projection-evidence" ||
      expected !== "pending" ||
      next !== "pending"
    ) {
      return errorResult("receipt_transition_mismatch", [
        evidence !== "projection-evidence"
          ? "receiptEvidenceKind"
          : next !== "pending"
            ? "newReceiptState"
            : "expectedReceiptState",
      ]);
    }
    return { ok: true, value: true };
  }

  const valid =
    (
      PROVIDER_ACCEPTANCE_EVIDENCE.has(evidence) &&
      expected === "pending" &&
      next === "pending"
    ) ||
    (
      RECEIPT_CONFIRMING_EVIDENCE.has(evidence) &&
      expected === "pending" &&
      next === "confirmed"
    ) ||
    (
      evidence === "delivery-failed" &&
      expected === "pending" &&
      next === "failed"
    );
  if (!valid) {
    return errorResult("receipt_transition_mismatch", [
      "newReceiptState",
    ]);
  }
  return { ok: true, value: true };
}

function validateAcknowledgmentPolicy(
  input: RecordValue,
  registration: SharedStateOutboxRegistrationV1,
): SharedStateOutboxResultV1<true> {
  if (
    registration.acknowledgmentAuthority ===
      "forbidden-projection-evidence"
  ) {
    return errorResult("acknowledgment_forbidden", ["eventPurpose"]);
  }
  if (
    typeof input.receiptEvidenceKind !== "string" ||
    !V.receiptEvidenceKinds.includes(
      input.receiptEvidenceKind as SharedStateOutboxReceiptEvidenceKindV1,
    )
  ) {
    return errorResult("acknowledgment_evidence_mismatch", [
      "receiptEvidenceKind",
    ]);
  }
  if (PROVIDER_ACCEPTANCE_EVIDENCE.has(input.receiptEvidenceKind)) {
    return errorResult("provider_acceptance_not_ack", [
      "receiptEvidenceKind",
    ]);
  }
  if (!RECEIPT_CONFIRMING_EVIDENCE.has(input.receiptEvidenceKind)) {
    return errorResult("acknowledgment_evidence_mismatch", [
      "receiptEvidenceKind",
    ]);
  }
  if (input.expectedReceiptState !== "confirmed") {
    return errorResult("acknowledgment_evidence_mismatch", [
      "expectedReceiptState",
    ]);
  }
  if (input.expectedAcknowledgmentState !== "unacknowledged") {
    return errorResult("acknowledgment_evidence_mismatch", [
      "expectedAcknowledgmentState",
    ]);
  }
  return { ok: true, value: true };
}

export function evaluateSharedStateOutboxPolicyV1(
  input: unknown,
): SharedStateOutboxResultV1<SharedStateOutboxPolicyEvaluationV1> {
  if (!isRecord(input)) return errorResult("invalid_type");
  const sequencePath = firstCallerSequencePath(input);
  if (sequencePath !== null) {
    return errorResult("caller_sequence_forbidden", sequencePath);
  }
  if (
    typeof input.operation !== "string" ||
    !V.operations.includes(input.operation as SharedStateOutboxOperationV1)
  ) {
    return errorResult("invalid_value", ["operation"]);
  }
  const operation = input.operation as SharedStateOutboxOperationV1;
  const allowedFields = operation === "appendOutbox"
    ? BASE_POLICY_FIELDS
    : operation === "updateOutboxReceipt"
      ? RECEIPT_POLICY_FIELDS
      : ACKNOWLEDGMENT_POLICY_FIELDS;
  const unknownField = firstUnknownField(input, allowedFields);
  if (unknownField !== null) {
    return errorResult("unknown_field", [unknownField]);
  }

  if (typeof input.namespace !== "string") {
    return errorResult("invalid_type", ["namespace"]);
  }
  if (
    input.namespace.length > V.limits.namespaceLength ||
    !NAMESPACE_PATTERN.test(input.namespace)
  ) {
    return errorResult("invalid_namespace", ["namespace"]);
  }
  const catalog = sharedStateOutboxCatalogV1();
  if (
    !catalog.entries.some((entry) => entry.namespace === input.namespace)
  ) {
    return errorResult("unknown_namespace", ["namespace"]);
  }
  if (
    typeof input.eventPurpose !== "string" ||
    !V.eventPurposes.includes(
      input.eventPurpose as SharedStateOutboxEventPurposeV1,
    )
  ) {
    return errorResult("unknown_event_purpose", ["eventPurpose"]);
  }
  const registration = catalog.entries.find(
    (entry) =>
      entry.namespace === input.namespace &&
      entry.eventPurpose === input.eventPurpose,
  );
  if (!registration) {
    return errorResult("unknown_event_purpose", ["eventPurpose"]);
  }

  if (input.orderingScope !== registration.orderingScope) {
    return errorResult("ordering_scope_mismatch", ["orderingScope"]);
  }
  const policies = policyVersionBinding(input, registration);
  if (!policies.ok) return policies;
  const streamKey = evaluateStreamKey(
    input,
    input.namespace,
    registration,
  );
  if (!streamKey.ok) return streamKey;

  if (operation === "updateOutboxReceipt") {
    const receipt = validateReceiptPolicy(input, registration);
    if (!receipt.ok) return receipt;
  } else if (operation === "acknowledgeOutbox") {
    const acknowledgment = validateAcknowledgmentPolicy(
      input,
      registration,
    );
    if (!acknowledgment.ok) return acknowledgment;
  }

  const reasonCode = operation === "appendOutbox"
    ? "registered_append_policy"
    : operation === "updateOutboxReceipt"
      ? "registered_receipt_policy"
      : "registered_acknowledgment_policy";
  return {
    ok: true,
    value: Object.freeze({
      decision: "registered" as const,
      reasonCode,
      operation,
      registration,
      streamKeyDigest: streamKey.value.streamKeyDigest,
      orderingBinding: streamKey.value.orderingBinding,
    }),
  };
}

export function compareSharedStateOutboxOrderingV1(
  left: SharedStateOutboxPolicyEvaluationV1,
  right: SharedStateOutboxPolicyEvaluationV1,
): SharedStateOutboxOrderingEvaluationV1 {
  if (left.streamKeyDigest === right.streamKeyDigest) {
    return Object.freeze({
      decision: "same-stream" as const,
      reasonCode: "same_stream_total_order" as const,
      orderingScope: "total-within-exact-stream-key" as const,
    });
  }
  return Object.freeze({
    decision: "different-streams" as const,
    reasonCode: "cross_stream_no_order" as const,
    orderingScope: null,
  });
}

export function evaluateSharedStateOutboxRetentionV1(
  registration: SharedStateOutboxRegistrationV1,
  input: unknown,
): SharedStateOutboxResultV1<SharedStateOutboxRetentionEvaluationV1> {
  if (!isRecord(input)) return errorResult("invalid_type");
  const unknownField = firstUnknownField(input, RETENTION_FIELDS);
  if (unknownField !== null) {
    return errorResult("unknown_field", [unknownField]);
  }
  if (
    typeof input.receiptState !== "string" ||
    !V.receiptStates.includes(
      input.receiptState as (typeof V.receiptStates)[number],
    )
  ) {
    return errorResult("invalid_retention_evaluation", ["receiptState"]);
  }
  if (
    typeof input.acknowledgmentState !== "string" ||
    !V.acknowledgmentStates.includes(
      input.acknowledgmentState as
        (typeof V.acknowledgmentStates)[number],
    )
  ) {
    return errorResult("invalid_retention_evaluation", [
      "acknowledgmentState",
    ]);
  }
  for (const field of RETENTION_FIELDS.slice(2)) {
    if (typeof input[field] !== "boolean") {
      return errorResult("invalid_retention_evaluation", [field]);
    }
  }

  if (input.acknowledgmentState !== "acknowledged") {
    return {
      ok: true,
      value: Object.freeze({
        decision: "retain" as const,
        reasonCode: input.providerAcceptanceObserved
          ? "retain_provider_acceptance_not_ack" as const
          : "retain_unacknowledged" as const,
        registration,
      }),
    };
  }
  if (registration.prunePolicy === "v1-prune-forbidden") {
    return {
      ok: true,
      value: Object.freeze({
        decision: "retain" as const,
        reasonCode: "retain_v1_prune_forbidden" as const,
        registration,
      }),
    };
  }
  if (
    input.receiptState !== "confirmed" ||
    !input.consumerCheckpointSafetyProved ||
    !input.idempotencyRetrySourcesGone ||
    !input.migrationRollbackPreservationProved ||
    !input.separateRetentionApprovalRecorded
  ) {
    return {
      ok: true,
      value: Object.freeze({
        decision: "retain" as const,
        reasonCode: "retain_prune_proof_incomplete" as const,
        registration,
      }),
    };
  }
  return {
    ok: true,
    value: Object.freeze({
      decision: "prune-eligible" as const,
      reasonCode: "prune_preconditions_satisfied" as const,
      registration,
    }),
  };
}

function parseCommittedBinding(
  input: unknown,
  path: readonly (string | number)[],
): SharedStateOutboxResultV1<SharedStateOutboxCommittedBindingV1> {
  if (!isRecord(input)) return errorResult("invalid_retry_binding", path);
  const unknownField = firstUnknownField(input, COMMITTED_BINDING_FIELDS);
  if (unknownField !== null) {
    return errorResult("unknown_field", [...path, unknownField]);
  }
  if (
    typeof input.namespace !== "string" ||
    !NAMESPACE_PATTERN.test(input.namespace)
  ) {
    return errorResult("invalid_retry_binding", [...path, "namespace"]);
  }
  const digestFields = [
    ["idempotencyKeyDigest", "broker.outbox.idempotency-key"],
    ["payloadDigest", "broker.outbox.payload"],
    ["eventKeyDigest", "broker.outbox.event-key"],
  ] as const;
  for (const [field, domain] of digestFields) {
    const parsed = parseSharedStateDigestV1(input[field], {
      domain,
      namespace: input.namespace,
    });
    if (!parsed.ok) {
      return errorResult("invalid_retry_binding", [...path, field]);
    }
  }
  if (
    typeof input.streamSequence !== "string" ||
    !POSITIVE_DECIMAL_PATTERN.test(input.streamSequence)
  ) {
    return errorResult("invalid_retry_binding", [
      ...path,
      "streamSequence",
    ]);
  }
  return {
    ok: true,
    value: input as unknown as SharedStateOutboxCommittedBindingV1,
  };
}

export function evaluateSharedStateOutboxRetryBindingV1(
  input: unknown,
): SharedStateOutboxResultV1<
  SharedStateOutboxRetryBindingEvaluationV1
> {
  if (!isRecord(input)) return errorResult("invalid_type");
  const unknownField = firstUnknownField(input, RETRY_BINDING_FIELDS);
  if (unknownField !== null) {
    return errorResult("unknown_field", [unknownField]);
  }
  const original = parseCommittedBinding(input.original, ["original"]);
  if (!original.ok) return original;
  const retry = parseCommittedBinding(input.retry, ["retry"]);
  if (!retry.ok) return retry;
  if (
    original.value.namespace !== retry.value.namespace ||
    original.value.idempotencyKeyDigest !==
      retry.value.idempotencyKeyDigest ||
    original.value.payloadDigest !== retry.value.payloadDigest
  ) {
    return errorResult("idempotent_retry_conflict", ["retry"]);
  }
  if (
    original.value.eventKeyDigest !== retry.value.eventKeyDigest ||
    original.value.streamSequence !== retry.value.streamSequence
  ) {
    return errorResult("idempotent_retry_conflict", [
      "retry",
      original.value.eventKeyDigest !== retry.value.eventKeyDigest
        ? "eventKeyDigest"
        : "streamSequence",
    ]);
  }
  return {
    ok: true,
    value: Object.freeze({
      decision: "original-binding" as const,
      reasonCode:
        "idempotent_retry_returns_original_binding" as const,
      eventKeyDigest: original.value.eventKeyDigest,
      streamSequence: original.value.streamSequence,
    }),
  };
}
