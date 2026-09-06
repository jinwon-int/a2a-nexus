/**
 * Backend-neutral parser and evaluator for
 * `a2a.shared-state.idempotency/v1`.
 *
 * This module evaluates only the closed catalog. It does not reserve keys,
 * persist outcomes, append outbox rows, read a clock, prune records, or connect
 * any current broker authority to `SharedStateStorageAdapterV1`.
 */

import { z } from "zod";
import { isRecord } from "./core/value-guards.js";

import {
  parseSharedStateLogicalBoundaryV1,
  type SharedStateLogicalBoundaryV1,
} from "./shared-state-time-v1.js";
import {
  SHARED_STATE_IDEMPOTENCY_V1_VALUES as V,
} from "./shared-state-idempotency-v1-values.js";

export {
  SHARED_STATE_IDEMPOTENCY_V1_VALUES,
} from "./shared-state-idempotency-v1-values.js";

export type SharedStateIdempotencyEffectKindV1 =
  (typeof V.effectKinds)[number];
export type SharedStateIdempotencyEffectClassV1 =
  (typeof V.effectClasses)[number];
export type SharedStateIdempotencyDurabilityV1 =
  (typeof V.durabilities)[number];
export type SharedStateIdempotencyExpiryPostureV1 =
  (typeof V.expiryPostures)[number];
export type SharedStateIdempotencyEvaluationReasonCodeV1 =
  (typeof V.evaluationReasonCodes)[number];
export type SharedStateIdempotencyErrorCodeV1 =
  (typeof V.errorCodes)[number];

export interface SharedStateIdempotencyErrorV1 {
  readonly code: SharedStateIdempotencyErrorCodeV1;
  readonly path: readonly (string | number)[];
}

export type SharedStateIdempotencyResultV1<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SharedStateIdempotencyErrorV1 };

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

const authoritySchema = z
  .object({
    authorityId: z.string().min(1).max(V.limits.authorityIdLength),
    status: z.enum(V.authorityStatuses),
    plannedNamespace: z.string().min(1).max(V.limits.namespaceLength),
    sourceRefs: z
      .array(sourceRefSchema)
      .min(1)
      .max(V.limits.maxSourceRefs),
  })
  .strict();

const registrationSchema = z
  .object({
    namespace: z.string().min(1).max(V.limits.namespaceLength),
    status: z.enum(V.registrationStatuses),
    retentionPolicyVersion: z
      .string()
      .min(1)
      .max(V.limits.retentionPolicyVersionLength),
    authorityId: z.string().min(1).max(V.limits.authorityIdLength),
    effectKind: z.enum(V.effectKinds),
    effectClass: z.enum(V.effectClasses),
    durability: z.enum(V.durabilities),
    expiryPosture: z.enum(V.expiryPostures),
    retryHorizonDependency: z.enum(V.retryHorizonDependencies),
    effectHorizonDependency: z.enum(V.effectHorizonDependencies),
    requiredEffectDependency: z.enum(V.requiredEffectDependencies),
    pruneEligibilityPreconditions: z
      .array(z.enum(V.pruneEligibilityPreconditions))
      .min(1)
      .max(V.limits.maxPrunePreconditions),
    migrationRollbackPreservationRule: z.enum(
      V.migrationRollbackPreservationRules,
    ),
    logicalExpiryBoundaryKind: z
      .enum(V.logicalExpiryBoundaryKinds)
      .nullable(),
  })
  .strict();

export const sharedStateIdempotencyCatalogV1Schema = z
  .object({
    kind: z.literal(V.kind),
    catalogVersion: z.literal(V.version),
    storageContractVersion: z.literal(V.storageContractVersion),
    timeVersion: z.literal(V.timeVersion),
    runtimeIntegration: z.literal(V.runtimeIntegration),
    extensionPolicy: z.literal(V.extensionPolicy),
    defaultRetentionPolicyVersion: z.null(),
    authorities: z.array(authoritySchema).min(1),
    entries: z.array(registrationSchema).min(1),
  })
  .strict();

export type SharedStateIdempotencyCatalogV1 = z.infer<
  typeof sharedStateIdempotencyCatalogV1Schema
>;
export type SharedStateIdempotencyAuthorityV1 =
  SharedStateIdempotencyCatalogV1["authorities"][number];
export type SharedStateIdempotencyRegistrationV1 =
  SharedStateIdempotencyCatalogV1["entries"][number];

export interface SharedStateIdempotencyPolicyInputV1 {
  readonly namespace: string;
  readonly retentionPolicyVersion: string;
  readonly effectKind: string;
}

export interface SharedStateIdempotencyPolicyEvaluationV1 {
  readonly decision: "registered";
  readonly reasonCode: "registered_policy";
  readonly registration: SharedStateIdempotencyRegistrationV1;
}

export type SharedStateIdempotencyExpiryEvaluationV1 =
  | {
      readonly decision: "non-expiring";
      readonly reasonCode: "non_expiring_until_prune_proof";
      readonly registration: SharedStateIdempotencyRegistrationV1;
    }
  | {
      readonly decision: "time-bounded";
      readonly reasonCode: "explicit_time_v1_boundary_accepted";
      readonly registration: SharedStateIdempotencyRegistrationV1;
      readonly boundary: SharedStateLogicalBoundaryV1 & {
        readonly kind: "idempotency-explicit-retention";
      };
    };

type RecordValue = Record<string, unknown>;

const NAMESPACE_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const RETENTION_POLICY_VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const AUTHORITY_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const POLICY_INPUT_FIELDS = [
  "namespace",
  "retentionPolicyVersion",
  "effectKind",
] as const;
const RISKY_EFFECT_CLASSES = new Set<SharedStateIdempotencyEffectClassV1>([
  "externally-visible",
  "irreversible",
]);
const REQUIRED_NON_EXPIRING_PRUNE_PRECONDITIONS = new Set<
  (typeof V.pruneEligibilityPreconditions)[number]
>([
  "retry-sources-provably-gone",
  "outbox-effects-provably-gone",
  "retained-effects-provably-gone",
  "migration-and-rollback-preservation-proved",
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

function errorResult<T>(
  code: SharedStateIdempotencyErrorCodeV1,
  path: readonly (string | number)[] = [],
): SharedStateIdempotencyResultV1<T> {
  return {
    ok: false,
    error: Object.freeze({ code, path: Object.freeze([...path]) }),
  };
}

function firstDuplicate(values: readonly string[]): number | null {
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    if (seen.has(values[index])) return index;
    seen.add(values[index]);
  }
  return null;
}

function firstUnknownField(
  value: RecordValue,
  allowed: readonly string[],
): string | null {
  // Single pass tracking the code-unit-first unknown key (same pick as
  // filter().sort()[0]); the common all-known path allocates nothing.
  let first: string | null = null;
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    if (first === null || key < first) first = key;
  }
  return first;
}

function mapZodError(
  error: z.ZodError,
): SharedStateIdempotencyErrorV1 {
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

function validateCatalogMappings(
  catalog: SharedStateIdempotencyCatalogV1,
): SharedStateIdempotencyResultV1<SharedStateIdempotencyCatalogV1> | null {
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
  const namespaceDuplicate = firstDuplicate(
    catalog.entries.map((entry) => entry.namespace),
  );
  if (namespaceDuplicate !== null) {
    return errorResult("duplicate_namespace", [
      "entries",
      namespaceDuplicate,
      "namespace",
    ]);
  }
  const retentionDuplicate = firstDuplicate(
    catalog.entries.map((entry) => entry.retentionPolicyVersion),
  );
  if (retentionDuplicate !== null) {
    return errorResult("duplicate_retention_policy_version", [
      "entries",
      retentionDuplicate,
      "retentionPolicyVersion",
    ]);
  }

  const authorities = new Map(
    catalog.authorities.map((authority) => [
      authority.authorityId,
      authority,
    ]),
  );
  const mappedAuthorities = new Set<string>();
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
    if (authority.plannedNamespace !== entry.namespace) {
      return errorResult("authority_mapping_mismatch", [
        "entries",
        index,
        "namespace",
      ]);
    }
    mappedAuthorities.add(entry.authorityId);
  }
  for (let index = 0; index < catalog.authorities.length; index += 1) {
    if (!mappedAuthorities.has(catalog.authorities[index].authorityId)) {
      return errorResult("authority_mapping_mismatch", [
        "authorities",
        index,
        "plannedNamespace",
      ]);
    }
  }
  return null;
}

function validateCatalogSafety(
  catalog: SharedStateIdempotencyCatalogV1,
): SharedStateIdempotencyResultV1<SharedStateIdempotencyCatalogV1> | null {
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
    if (!NAMESPACE_PATTERN.test(authority.plannedNamespace)) {
      return errorResult("invalid_namespace", [
        "authorities",
        authorityIndex,
        "plannedNamespace",
      ]);
    }
    for (let sourceIndex = 0;
      sourceIndex < authority.sourceRefs.length;
      sourceIndex += 1) {
      const duplicateProof = firstDuplicate(
        authority.sourceRefs[sourceIndex].proves,
      );
      if (duplicateProof !== null) {
        return errorResult("invalid_value", [
          "authorities",
          authorityIndex,
          "sourceRefs",
          sourceIndex,
          "proves",
          duplicateProof,
        ]);
      }
    }
  }

  for (let index = 0; index < catalog.entries.length; index += 1) {
    const entry = catalog.entries[index];
    const prefix = ["entries", index] as const;
    if (!NAMESPACE_PATTERN.test(entry.namespace)) {
      return errorResult("invalid_namespace", [...prefix, "namespace"]);
    }
    if (!RETENTION_POLICY_VERSION_PATTERN.test(
      entry.retentionPolicyVersion,
    )) {
      return errorResult("invalid_retention_policy_version", [
        ...prefix,
        "retentionPolicyVersion",
      ]);
    }
    const duplicatePrune = firstDuplicate(
      entry.pruneEligibilityPreconditions,
    );
    if (duplicatePrune !== null) {
      return errorResult("invalid_value", [
        ...prefix,
        "pruneEligibilityPreconditions",
        duplicatePrune,
      ]);
    }

    const risky = RISKY_EFFECT_CLASSES.has(entry.effectClass);
    if (
      risky &&
      (entry.expiryPosture !== "non-expiring-until-prune-proof" ||
        entry.durability !== "durable")
    ) {
      return errorResult("unsafe_expiry_policy", [
        ...prefix,
        entry.expiryPosture !== "non-expiring-until-prune-proof"
          ? "expiryPosture"
          : "durability",
      ]);
    }
    if (
      risky &&
      entry.requiredEffectDependency !== "outbox-and-retained-effect"
    ) {
      return errorResult("unsafe_expiry_policy", [
        ...prefix,
        "requiredEffectDependency",
      ]);
    }
    if (risky) {
      for (const required of REQUIRED_NON_EXPIRING_PRUNE_PRECONDITIONS) {
        if (!entry.pruneEligibilityPreconditions.includes(required)) {
          return errorResult("unsafe_expiry_policy", [
            ...prefix,
            "pruneEligibilityPreconditions",
          ]);
        }
      }
    }

    const expectedBoundary = entry.expiryPosture === "time-bounded"
      ? "idempotency-explicit-retention"
      : null;
    if (entry.logicalExpiryBoundaryKind !== expectedBoundary) {
      return errorResult("expiry_boundary_requirement_mismatch", [
        ...prefix,
        "logicalExpiryBoundaryKind",
      ]);
    }
    if (
      entry.expiryPosture === "time-bounded" &&
      entry.effectClass !== "reversible" &&
      entry.effectClass !== "non-effecting"
    ) {
      return errorResult("unsafe_expiry_policy", [
        ...prefix,
        "effectClass",
      ]);
    }
  }
  return null;
}

export function parseSharedStateIdempotencyCatalogV1(
  input: unknown,
): SharedStateIdempotencyResultV1<SharedStateIdempotencyCatalogV1> {
  if (!isRecord(input)) return errorResult("invalid_type");
  if (
    Object.hasOwn(input, "catalogVersion") &&
    input.catalogVersion !== V.version
  ) {
    return errorResult("unknown_catalog_version", ["catalogVersion"]);
  }
  const parsed = sharedStateIdempotencyCatalogV1Schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: mapZodError(parsed.error) };
  }
  const safetyError = validateCatalogSafety(parsed.data);
  if (safetyError) return safetyError;
  const mappingError = validateCatalogMappings(parsed.data);
  if (mappingError) return mappingError;
  return {
    ok: true,
    value: deepFreeze(parsed.data) as SharedStateIdempotencyCatalogV1,
  };
}

let parsedCanonicalCatalog:
  | SharedStateIdempotencyCatalogV1
  | undefined;

export function sharedStateIdempotencyCatalogV1():
  SharedStateIdempotencyCatalogV1 {
  if (!parsedCanonicalCatalog) {
    const parsed = parseSharedStateIdempotencyCatalogV1(V.catalog);
    if (!parsed.ok) {
      throw new Error(
        `invalid built-in shared-state idempotency catalog: ${parsed.error.code}`,
      );
    }
    parsedCanonicalCatalog = parsed.value;
  }
  return parsedCanonicalCatalog;
}

export function evaluateSharedStateIdempotencyPolicyV1(
  input: unknown,
): SharedStateIdempotencyResultV1<
  SharedStateIdempotencyPolicyEvaluationV1
> {
  if (!isRecord(input)) return errorResult("invalid_type");
  const unknownField = firstUnknownField(input, POLICY_INPUT_FIELDS);
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
  if (typeof input.retentionPolicyVersion !== "string") {
    return errorResult("invalid_type", ["retentionPolicyVersion"]);
  }
  if (
    input.retentionPolicyVersion.length >
      V.limits.retentionPolicyVersionLength ||
    !RETENTION_POLICY_VERSION_PATTERN.test(input.retentionPolicyVersion)
  ) {
    return errorResult("invalid_retention_policy_version", [
      "retentionPolicyVersion",
    ]);
  }
  if (typeof input.effectKind !== "string") {
    return errorResult("invalid_type", ["effectKind"]);
  }

  const catalog = sharedStateIdempotencyCatalogV1();
  const registration = catalog.entries.find(
    (entry) => entry.namespace === input.namespace,
  );
  if (!registration) return errorResult("unknown_namespace", ["namespace"]);
  const retentionKnown = catalog.entries.some(
    (entry) =>
      entry.retentionPolicyVersion === input.retentionPolicyVersion,
  );
  if (!retentionKnown) {
    return errorResult("unknown_retention_policy_version", [
      "retentionPolicyVersion",
    ]);
  }
  if (
    registration.retentionPolicyVersion !== input.retentionPolicyVersion
  ) {
    return errorResult("retention_policy_mismatch", [
      "retentionPolicyVersion",
    ]);
  }
  if (registration.effectKind !== input.effectKind) {
    return errorResult("effect_policy_mismatch", ["effectKind"]);
  }
  return {
    ok: true,
    value: Object.freeze({
      decision: "registered" as const,
      reasonCode: "registered_policy" as const,
      registration,
    }),
  };
}

export function evaluateSharedStateIdempotencyExpiryV1(
  registration: SharedStateIdempotencyRegistrationV1,
  boundaryInput?: unknown,
): SharedStateIdempotencyResultV1<
  SharedStateIdempotencyExpiryEvaluationV1
> {
  if (registration.expiryPosture === "non-expiring-until-prune-proof") {
    if (boundaryInput !== undefined) {
      return errorResult("expiry_boundary_forbidden", ["boundary"]);
    }
    return {
      ok: true,
      value: Object.freeze({
        decision: "non-expiring" as const,
        reasonCode: "non_expiring_until_prune_proof" as const,
        registration,
      }),
    };
  }
  if (boundaryInput === undefined) {
    return errorResult("expiry_boundary_required", ["boundary"]);
  }
  const boundary = parseSharedStateLogicalBoundaryV1(boundaryInput);
  if (
    !boundary.ok ||
    boundary.value.kind !== "idempotency-explicit-retention"
  ) {
    return errorResult("invalid_expiry_boundary", [
      "boundary",
      ...(boundary.ok ? ["kind"] : boundary.error.path),
    ]);
  }
  const acceptedBoundary = Object.freeze({
    ...boundary.value,
    kind: "idempotency-explicit-retention" as const,
  });
  return {
    ok: true,
    value: Object.freeze({
      decision: "time-bounded" as const,
      reasonCode: "explicit_time_v1_boundary_accepted" as const,
      registration,
      boundary: acceptedBoundary,
    }),
  };
}
