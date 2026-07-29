/**
 * Backend-neutral parser and pure aggregate projectors for
 * `a2a.shared-state.observability/v1`.
 *
 * This module accepts only synthetic candidate objects. It reads no clock,
 * store, process, route, configuration, or runtime state. The operator
 * projector does not authorize a caller; a future runtime binding must enforce
 * the catalog's separate-authorization requirement before using that surface.
 */

import { z } from "zod";

import {
  parseSharedStateHealthProjectionV1,
  sharedStateHealthProjectionV1Schema,
} from "./shared-state-storage-contract-v1.js";
import { SHARED_STATE_STORAGE_V1_VALUES as SV } from "./shared-state-storage-v1-values.js";
import { SHARED_STATE_OBSERVABILITY_V1_VALUES as V } from "./shared-state-observability-v1-values.js";

export {
  SHARED_STATE_OBSERVABILITY_V1_VALUES,
} from "./shared-state-observability-v1-values.js";

export type SharedStateObservabilityErrorCodeV1 =
  (typeof V.errorCodes)[number];

export interface SharedStateObservabilityErrorV1 {
  readonly code: SharedStateObservabilityErrorCodeV1;
  readonly path: readonly (string | number)[];
}

export type SharedStateObservabilityResultV1<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SharedStateObservabilityErrorV1 };

export type SharedStateObservabilityCatalogV1 = typeof V.catalog;

const aggregateCountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(V.limits.maxAggregateCount);

const unavailableSchema = z
  .object({
    availability: z.literal("unavailable"),
    reasonCode: z.enum(V.unavailableReasonCodes),
  })
  .strict();

const notApplicableSchema = z
  .object({
    availability: z.literal("not-applicable"),
    reasonCode: z.enum(V.notApplicableReasonCodes),
  })
  .strict();

const replayAvailableSchema = z
  .object({
    availability: z.literal("available"),
    counts: z
      .object({
        accepted: aggregateCountSchema,
        replayed: aggregateCountSchema,
        unavailable: aggregateCountSchema,
        storeErrors: aggregateCountSchema,
      })
      .strict(),
  })
  .strict();

const rateLimitAvailableSchema = z
  .object({
    availability: z.literal("available"),
    windowBand: z.enum(V.rateWindowBands),
    limitBand: z.enum(V.rateLimitBands),
    counts: z
      .object({
        allowed: aggregateCountSchema,
        denied: aggregateCountSchema,
        storeErrors: aggregateCountSchema,
      })
      .strict(),
  })
  .strict();

const leaseAvailableSchema = z
  .object({
    availability: z.literal("available"),
    pressureBand: z.enum(V.pressureBands),
    oldestAgeBand: z.enum(V.ageBands),
    counts: z
      .object({
        active: aggregateCountSchema,
        expiring: aggregateCountSchema,
        stale: aggregateCountSchema,
        renewalFailures: aggregateCountSchema,
        fencingRejections: aggregateCountSchema,
      })
      .strict(),
  })
  .strict();

const idempotencyAvailableSchema = z
  .object({
    availability: z.literal("available"),
    retentionPolicyClass: z.enum(V.idempotencyRetentionPolicyClasses),
    counts: z
      .object({
        new: aggregateCountSchema,
        replayed: aggregateCountSchema,
        conflict: aggregateCountSchema,
        unknown: aggregateCountSchema,
      })
      .strict(),
  })
  .strict();

const outboxAvailableSchema = z
  .object({
    availability: z.literal("available"),
    pressureBand: z.enum(V.pressureBands),
    oldestAgeBand: z.enum(V.ageBands),
    highWaterClass: z.enum(V.highWaterClasses),
    lagBand: z.enum(V.lagBands),
    counts: z
      .object({
        pending: aggregateCountSchema,
        receiptConfirmed: aggregateCountSchema,
        failed: aggregateCountSchema,
        duplicateReplays: aggregateCountSchema,
        orderViolations: aggregateCountSchema,
      })
      .strict(),
  })
  .strict();

const claimGraphAvailableSchema = z
  .object({
    availability: z.literal("available"),
    projectionVersion: z.enum(V.graphProjectionVersionClasses),
    sourceHighWaterClass: z.enum(V.highWaterClasses),
    checkpointHighWaterClass: z.enum(V.highWaterClasses),
    lagBand: z.enum(V.lagBands),
    oldestAgeBand: z.enum(V.ageBands),
    completeness: z.enum(SV.graphCompletenessStates),
    counts: z
      .object({
        failedBatches: aggregateCountSchema,
        rollbackBatches: aggregateCountSchema,
      })
      .strict(),
  })
  .strict();

export const sharedStateObservabilityCandidateV1Schema = z
  .object({
    kind: z.literal(V.kinds.candidate),
    catalogVersion: z.literal(V.version),
    health: sharedStateHealthProjectionV1Schema,
    clockContinuity: z.enum(V.clockContinuityStates),
    observations: z
      .object({
        replay: z.discriminatedUnion("availability", [
          replayAvailableSchema,
          unavailableSchema,
          notApplicableSchema,
        ]),
        rateLimit: z.discriminatedUnion("availability", [
          rateLimitAvailableSchema,
          unavailableSchema,
          notApplicableSchema,
        ]),
        leaseClaim: z.discriminatedUnion("availability", [
          leaseAvailableSchema,
          unavailableSchema,
          notApplicableSchema,
        ]),
        idempotency: z.discriminatedUnion("availability", [
          idempotencyAvailableSchema,
          unavailableSchema,
          notApplicableSchema,
        ]),
        outbox: z.discriminatedUnion("availability", [
          outboxAvailableSchema,
          unavailableSchema,
          notApplicableSchema,
        ]),
        claimGraphProjection: z.discriminatedUnion("availability", [
          claimGraphAvailableSchema,
          unavailableSchema,
          notApplicableSchema,
        ]),
      })
      .strict(),
  })
  .strict();

export type SharedStateObservabilityCandidateV1 = z.infer<
  typeof sharedStateObservabilityCandidateV1Schema
>;

const countResultSchema = (floor: number) =>
  z.discriminatedUnion("state", [
    z.object({ state: z.literal("zero"), value: z.literal(0) }).strict(),
    z
      .object({
        state: z.literal("reported"),
        value: aggregateCountSchema.min(floor),
      })
      .strict(),
    z
      .object({
        state: z.literal("suppressed"),
        value: z.null(),
      })
      .strict(),
  ]);

export type SharedStateAggregateCountV1 =
  | { readonly state: "zero"; readonly value: 0 }
  | { readonly state: "reported"; readonly value: number }
  | { readonly state: "suppressed"; readonly value: null };

const publicCountSchema = countResultSchema(V.limits.publicAggregationFloor);
const operatorCountSchema = countResultSchema(
  V.limits.operatorAggregationFloor,
);

const stateContractSchema = z
  .object({
    configuredGrade: z.enum(SV.configuredGrades),
    effectiveGrade: z.enum(SV.effectiveGrades),
    gradeDefaulted: z.boolean(),
    serving: z.boolean(),
    reasonCodes: z
      .array(z.enum(SV.readinessReasonCodes))
      .max(V.limits.maxReadinessReasonCodes),
    adapter: z
      .object({
        contractVersion: z.literal(V.storageContractVersion).nullable(),
        backendClass: z.enum(SV.healthBackendClasses),
        lifecycle: z.enum(SV.lifecycleStates),
        durability: z.enum(SV.durabilities),
        writerModel: z.enum(SV.writerModels),
        migrationState: z.enum(V.migrationProjectionStates),
      })
      .strict(),
    topology: z
      .object({
        expectedProcessBand: z.enum(V.expectedProcessBands),
        ownership: z.enum(SV.ownershipStates),
      })
      .strict(),
    clock: z
      .object({
        safety: z.enum(SV.clockSafetyStates),
        continuity: z.enum(V.clockContinuityStates),
      })
      .strict(),
    securityPrimitives: z
      .object({
        replay: z
          .object({
            source: z.enum(SV.primitiveSources),
            durability: z.enum(SV.durabilities),
            continuity: z.enum(SV.continuityStates),
            resetRisk: z.boolean(),
            epochAgeBand: z.enum(V.ageBands),
            pressureBand: z.enum(V.pressureBands),
            lastResetReason: z.enum(SV.resetReasonCodes).nullable(),
          })
          .strict(),
        rateLimit: z
          .object({
            source: z.enum(SV.primitiveSources),
            durability: z.enum(SV.durabilities),
            continuity: z.enum(SV.continuityStates),
            resetRisk: z.boolean(),
            epochAgeBand: z.enum(V.ageBands),
            pressureBand: z.enum(V.pressureBands),
            lastResetReason: z.enum(SV.resetReasonCodes).nullable(),
          })
          .strict(),
      })
      .strict(),
    graphCompleteness: z.enum(SV.graphCompletenessStates),
  })
  .strict();

const publicAbsenceSchema = z.discriminatedUnion("availability", [
  unavailableSchema,
  notApplicableSchema,
]);

const publicReplaySchema = z.discriminatedUnion("availability", [
  z
    .object({
      availability: z.literal("available"),
      counts: z
        .object({
          accepted: publicCountSchema,
          replayed: publicCountSchema,
          unavailable: publicCountSchema,
          storeErrors: publicCountSchema,
        })
        .strict(),
    })
    .strict(),
  unavailableSchema,
  notApplicableSchema,
]);

const publicRateLimitSchema = z.discriminatedUnion("availability", [
  z
    .object({
      availability: z.literal("available"),
      counts: z
        .object({
          allowed: publicCountSchema,
          denied: publicCountSchema,
          storeErrors: publicCountSchema,
        })
        .strict(),
    })
    .strict(),
  unavailableSchema,
  notApplicableSchema,
]);

const publicLeaseSchema = z.discriminatedUnion("availability", [
  z
    .object({
      availability: z.literal("available"),
      pressureBand: z.enum(V.pressureBands),
      oldestAgeBand: z.enum(V.ageBands),
      counts: z
        .object({
          active: publicCountSchema,
          expiring: publicCountSchema,
          stale: publicCountSchema,
        })
        .strict(),
    })
    .strict(),
  unavailableSchema,
  notApplicableSchema,
]);

const publicIdempotencySchema = z.discriminatedUnion("availability", [
  z
    .object({
      availability: z.literal("available"),
      counts: z
        .object({
          new: publicCountSchema,
          replayed: publicCountSchema,
          conflict: publicCountSchema,
          unknown: publicCountSchema,
        })
        .strict(),
    })
    .strict(),
  unavailableSchema,
  notApplicableSchema,
]);

const publicOutboxSchema = z.discriminatedUnion("availability", [
  z
    .object({
      availability: z.literal("available"),
      pressureBand: z.enum(V.pressureBands),
      oldestAgeBand: z.enum(V.ageBands),
      lagBand: z.enum(V.lagBands),
      orderIntegrity: z.enum(V.orderIntegrityStates),
      counts: z
        .object({
          pending: publicCountSchema,
          receiptConfirmed: publicCountSchema,
          failed: publicCountSchema,
        })
        .strict(),
    })
    .strict(),
  unavailableSchema,
  notApplicableSchema,
]);

const publicClaimGraphSchema = z.discriminatedUnion("availability", [
  z
    .object({
      availability: z.literal("available"),
      completeness: z.enum(SV.graphCompletenessStates),
      lagBand: z.enum(V.lagBands),
    })
    .strict(),
  unavailableSchema,
  notApplicableSchema,
]);

export const sharedStatePublicReadinessProjectionV1Schema = z
  .object({
    kind: z.literal(V.kinds.readiness),
    catalogVersion: z.literal(V.version),
    visibility: z.literal("public-readiness-aggregate"),
    ready: z.boolean(),
    effectiveGrade: z.enum(SV.effectiveGrades),
    reasonCodes: z
      .array(z.enum(SV.readinessReasonCodes))
      .max(V.limits.maxReadinessReasonCodes),
  })
  .strict();

export type SharedStatePublicReadinessProjectionV1 = z.infer<
  typeof sharedStatePublicReadinessProjectionV1Schema
>;

export const sharedStatePublicObservabilityProjectionV1Schema = z
  .object({
    kind: z.literal(V.kinds.public),
    catalogVersion: z.literal(V.version),
    visibility: z.literal("public-aggregate"),
    stateContract: stateContractSchema,
    domains: z
      .object({
        replay: publicReplaySchema,
        rateLimit: publicRateLimitSchema,
        leaseClaim: publicLeaseSchema,
        idempotency: publicIdempotencySchema,
        outbox: publicOutboxSchema,
        claimGraphProjection: publicClaimGraphSchema,
      })
      .strict(),
  })
  .strict();

export type SharedStatePublicObservabilityProjectionV1 = z.infer<
  typeof sharedStatePublicObservabilityProjectionV1Schema
>;

const operatorReplaySchema = z.discriminatedUnion("availability", [
  z
    .object({
      availability: z.literal("available"),
      counts: z
        .object({
          accepted: operatorCountSchema,
          replayed: operatorCountSchema,
          unavailable: operatorCountSchema,
          storeErrors: operatorCountSchema,
        })
        .strict(),
    })
    .strict(),
  unavailableSchema,
  notApplicableSchema,
]);

const operatorRateLimitSchema = z.discriminatedUnion("availability", [
  z
    .object({
      availability: z.literal("available"),
      windowBand: z.enum(V.rateWindowBands),
      limitBand: z.enum(V.rateLimitBands),
      counts: z
        .object({
          allowed: operatorCountSchema,
          denied: operatorCountSchema,
          storeErrors: operatorCountSchema,
        })
        .strict(),
    })
    .strict(),
  unavailableSchema,
  notApplicableSchema,
]);

const operatorLeaseSchema = z.discriminatedUnion("availability", [
  z
    .object({
      availability: z.literal("available"),
      pressureBand: z.enum(V.pressureBands),
      oldestAgeBand: z.enum(V.ageBands),
      counts: z
        .object({
          active: operatorCountSchema,
          expiring: operatorCountSchema,
          stale: operatorCountSchema,
          renewalFailures: operatorCountSchema,
          fencingRejections: operatorCountSchema,
        })
        .strict(),
    })
    .strict(),
  unavailableSchema,
  notApplicableSchema,
]);

const operatorIdempotencySchema = z.discriminatedUnion("availability", [
  z
    .object({
      availability: z.literal("available"),
      retentionPolicyClass: z.enum(V.idempotencyRetentionPolicyClasses),
      counts: z
        .object({
          new: operatorCountSchema,
          replayed: operatorCountSchema,
          conflict: operatorCountSchema,
          unknown: operatorCountSchema,
        })
        .strict(),
    })
    .strict(),
  unavailableSchema,
  notApplicableSchema,
]);

const operatorOutboxSchema = z.discriminatedUnion("availability", [
  z
    .object({
      availability: z.literal("available"),
      pressureBand: z.enum(V.pressureBands),
      oldestAgeBand: z.enum(V.ageBands),
      highWaterClass: z.enum(V.highWaterClasses),
      lagBand: z.enum(V.lagBands),
      orderIntegrity: z.enum(V.orderIntegrityStates),
      counts: z
        .object({
          pending: operatorCountSchema,
          receiptConfirmed: operatorCountSchema,
          failed: operatorCountSchema,
          duplicateReplays: operatorCountSchema,
          orderViolations: operatorCountSchema,
        })
        .strict(),
    })
    .strict(),
  unavailableSchema,
  notApplicableSchema,
]);

const operatorClaimGraphSchema = z.discriminatedUnion("availability", [
  z
    .object({
      availability: z.literal("available"),
      projectionVersion: z.enum(V.graphProjectionVersionClasses),
      sourceHighWaterClass: z.enum(V.highWaterClasses),
      checkpointHighWaterClass: z.enum(V.highWaterClasses),
      lagBand: z.enum(V.lagBands),
      oldestAgeBand: z.enum(V.ageBands),
      completeness: z.enum(SV.graphCompletenessStates),
      counts: z
        .object({
          failedBatches: operatorCountSchema,
          rollbackBatches: operatorCountSchema,
        })
        .strict(),
    })
    .strict(),
  unavailableSchema,
  notApplicableSchema,
]);

export const sharedStateOperatorObservabilityProjectionV1Schema = z
  .object({
    kind: z.literal(V.kinds.operator),
    catalogVersion: z.literal(V.version),
    visibility: z.literal("authorized-operator-aggregate"),
    authorizationRequired: z.literal(true),
    stateContract: stateContractSchema,
    domains: z
      .object({
        replay: operatorReplaySchema,
        rateLimit: operatorRateLimitSchema,
        leaseClaim: operatorLeaseSchema,
        idempotency: operatorIdempotencySchema,
        outbox: operatorOutboxSchema,
        claimGraphProjection: operatorClaimGraphSchema,
      })
      .strict(),
  })
  .strict();

export type SharedStateOperatorObservabilityProjectionV1 = z.infer<
  typeof sharedStateOperatorObservabilityProjectionV1Schema
>;

type RecordValue = Record<string, unknown>;

const CONFUSABLE_ASCII: Readonly<Record<string, string>> = Object.freeze({
  "\u0430": "a",
  "\u0435": "e",
  "\u043e": "o",
  "\u0440": "p",
  "\u0441": "c",
  "\u0445": "x",
  "\u0456": "i",
  "\u0455": "s",
  "\u03b1": "a",
  "\u03b5": "e",
  "\u03b9": "i",
  "\u03ba": "k",
  "\u03bf": "o",
  "\u03c1": "p",
  "\u03c4": "t",
  "\u03c7": "x",
});

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedFieldName(value: string): string {
  const folded = [...value.normalize("NFKC")]
    .map((character) => CONFUSABLE_ASCII[character] ?? character)
    .join("");
  return folded.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

const FORBIDDEN_FIELD_NAMES = new Set(
  V.forbidden.fieldNames.map(normalizedFieldName),
);

function observabilityError(
  code: SharedStateObservabilityErrorCodeV1,
  path: readonly (string | number)[] = [],
): SharedStateObservabilityErrorV1 {
  return Object.freeze({ code, path: Object.freeze([...path]) });
}

function errorResult<T>(
  code: SharedStateObservabilityErrorCodeV1,
  path: readonly (string | number)[] = [],
): SharedStateObservabilityResultV1<T> {
  return { ok: false, error: observabilityError(code, path) };
}

function findForbiddenField(
  value: unknown,
  path: readonly (string | number)[] = [],
): readonly (string | number)[] | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenField(value[index], [...path, index]);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return [...path, "__proto__"];
  }
  for (const key of Object.keys(value)) {
    const nextPath = [...path, key];
    if (FORBIDDEN_FIELD_NAMES.has(normalizedFieldName(key))) {
      return nextPath;
    }
    const found = findForbiddenField(value[key], nextPath);
    if (found) return found;
  }
  return null;
}

function normalizedPath(path: readonly PropertyKey[]): (string | number)[] {
  return path.map((part) =>
    typeof part === "number" ? part : String(part),
  );
}

const DISCRIMINANTS = new Set([
  "kind",
  "availability",
  "visibility",
  "state",
]);

function mapZodError(error: z.ZodError): SharedStateObservabilityErrorV1 {
  const issues = [...error.issues].sort((left, right) => {
    const leftPath = JSON.stringify(left.path);
    const rightPath = JSON.stringify(right.path);
    return leftPath.localeCompare(rightPath) || left.code.localeCompare(right.code);
  });
  const issue = issues[0]!;
  const path = normalizedPath(issue.path);
  if (issue.code === "unrecognized_keys") {
    const keys = [...issue.keys].sort();
    return observabilityError("unknown_field", [...path, keys[0]!]);
  }
  if (issue.code === "too_big" || issue.code === "too_small") {
    return observabilityError("out_of_range", path);
  }
  if (issue.code === "invalid_type") {
    return observabilityError("invalid_type", path);
  }
  const last = path[path.length - 1];
  if (typeof last === "string" && DISCRIMINANTS.has(last)) {
    return observabilityError("invalid_discriminant", path);
  }
  return observabilityError("invalid_enum", path);
}

function parseSchema<T>(
  schema: z.ZodType<T>,
  input: unknown,
): SharedStateObservabilityResultV1<T> {
  const result = schema.safeParse(input);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: mapZodError(result.error) };
}

function preflightInput<T>(
  input: unknown,
): SharedStateObservabilityResultV1<T> | null {
  if (!isRecord(input)) return errorResult("invalid_type");
  const forbidden = findForbiddenField(input);
  if (forbidden) {
    return errorResult("forbidden_observability_field", forbidden);
  }
  if (
    Object.hasOwn(input, "catalogVersion") &&
    input.catalogVersion !== V.version
  ) {
    return errorResult("unknown_catalog_version", ["catalogVersion"]);
  }
  return null;
}

function compareCanonical(
  input: unknown,
  expected: unknown,
  path: readonly (string | number)[] = [],
): SharedStateObservabilityErrorV1 | null {
  if (Array.isArray(expected)) {
    if (!Array.isArray(input)) return observabilityError("invalid_type", path);
    if (input.length !== expected.length) {
      return observabilityError("invalid_value", path);
    }
    for (let index = 0; index < expected.length; index += 1) {
      const nested = compareCanonical(
        input[index],
        expected[index],
        [...path, index],
      );
      if (nested) return nested;
    }
    return null;
  }
  if (isRecord(expected)) {
    if (!isRecord(input)) return observabilityError("invalid_type", path);
    const unknown = Object.keys(input)
      .filter((key) => !Object.hasOwn(expected, key))
      .sort()[0];
    if (unknown !== undefined) {
      return observabilityError("unknown_field", [...path, unknown]);
    }
    for (const key of Object.keys(expected)) {
      if (!Object.hasOwn(input, key)) {
        return observabilityError("invalid_value", [...path, key]);
      }
      const nested = compareCanonical(
        input[key],
        expected[key],
        [...path, key],
      );
      if (nested) return nested;
    }
    return null;
  }
  return Object.is(input, expected)
    ? null
    : observabilityError("invalid_value", path);
}

export function parseSharedStateObservabilityCatalogV1(
  input: unknown,
): SharedStateObservabilityResultV1<SharedStateObservabilityCatalogV1> {
  if (!isRecord(input)) return errorResult("invalid_type");
  if (
    Object.hasOwn(input, "catalogVersion") &&
    input.catalogVersion !== V.version
  ) {
    return errorResult("unknown_catalog_version", ["catalogVersion"]);
  }
  if (Object.hasOwn(input, "kind") && input.kind !== V.kinds.catalog) {
    return errorResult("invalid_discriminant", ["kind"]);
  }
  const error = compareCanonical(input, V.catalog);
  return error
    ? { ok: false, error }
    : { ok: true, value: V.catalog };
}

export function parseSharedStateObservabilityCandidateV1(
  input: unknown,
): SharedStateObservabilityResultV1<SharedStateObservabilityCandidateV1> {
  const preflight = preflightInput<SharedStateObservabilityCandidateV1>(input);
  if (preflight) return preflight;
  const parsed = parseSchema(sharedStateObservabilityCandidateV1Schema, input);
  if (!parsed.ok) return parsed;

  const health = parseSharedStateHealthProjectionV1(parsed.value.health);
  if (!health.ok) {
    return errorResult("health_declaration_invalid", [
      "health",
      ...health.error.path,
    ]);
  }
  const graph = parsed.value.observations.claimGraphProjection;
  if (
    graph.availability === "available" &&
    graph.completeness !== parsed.value.health.completeness.graphProjection
  ) {
    return errorResult("health_observation_mismatch", [
      "observations",
      "claimGraphProjection",
      "completeness",
    ]);
  }
  return parsed;
}

function projectCountGroup<T extends Record<string, number>>(
  counts: T,
  floor: number,
): { [K in keyof T]: SharedStateAggregateCountV1 } {
  const suppressNonzero = Object.values(counts).some(
    (count) => count > 0 && count < floor,
  );
  return Object.fromEntries(
    Object.entries(counts).map(([key, count]) => {
      const projected: SharedStateAggregateCountV1 =
        count === 0
          ? { state: "zero", value: 0 }
          : suppressNonzero
            ? { state: "suppressed", value: null }
            : { state: "reported", value: count };
      return [key, projected];
    }),
  ) as { [K in keyof T]: SharedStateAggregateCountV1 };
}

function projectStateContract(
  candidate: SharedStateObservabilityCandidateV1,
): SharedStatePublicObservabilityProjectionV1["stateContract"] {
  const health = candidate.health;
  return {
    configuredGrade: health.configuredGrade,
    effectiveGrade: health.effectiveGrade,
    gradeDefaulted: health.gradeDefaulted,
    serving: health.serving,
    reasonCodes: health.reasonCodes,
    adapter: {
      contractVersion: health.adapter.contractVersion,
      backendClass: health.adapter.backendClass,
      lifecycle: health.adapter.lifecycle,
      durability: health.adapter.durability,
      writerModel: health.adapter.writerModel,
      migrationState: health.adapter.migrationState ?? "not-applicable",
    },
    topology: {
      expectedProcessBand:
        health.topology.expectedProcessCount === 1 ? "one" : "multiple",
      ownership: health.topology.ownership,
    },
    clock: {
      safety: health.clock.safety,
      continuity: candidate.clockContinuity,
    },
    securityPrimitives: health.primitives,
    graphCompleteness: health.completeness.graphProjection,
  };
}

function projectAbsence(
  observation:
    | z.infer<typeof unavailableSchema>
    | z.infer<typeof notApplicableSchema>,
): z.infer<typeof publicAbsenceSchema> {
  if (observation.availability === "unavailable") {
    return {
      availability: "unavailable",
      reasonCode: observation.reasonCode,
    };
  }
  return {
    availability: "not-applicable",
    reasonCode: observation.reasonCode,
  };
}

function publicDomains(
  candidate: SharedStateObservabilityCandidateV1,
): SharedStatePublicObservabilityProjectionV1["domains"] {
  const observations = candidate.observations;
  const replay = observations.replay.availability === "available"
    ? {
        availability: "available" as const,
        counts: projectCountGroup(
          observations.replay.counts,
          V.limits.publicAggregationFloor,
        ),
      }
    : projectAbsence(observations.replay);
  const rateLimit = observations.rateLimit.availability === "available"
    ? {
        availability: "available" as const,
        counts: projectCountGroup(
          observations.rateLimit.counts,
          V.limits.publicAggregationFloor,
        ),
      }
    : projectAbsence(observations.rateLimit);
  const leaseClaim = observations.leaseClaim.availability === "available"
    ? {
        availability: "available" as const,
        pressureBand: observations.leaseClaim.pressureBand,
        oldestAgeBand: observations.leaseClaim.oldestAgeBand,
        counts: projectCountGroup(
          {
            active: observations.leaseClaim.counts.active,
            expiring: observations.leaseClaim.counts.expiring,
            stale: observations.leaseClaim.counts.stale,
          },
          V.limits.publicAggregationFloor,
        ),
      }
    : projectAbsence(observations.leaseClaim);
  const idempotency = observations.idempotency.availability === "available"
    ? {
        availability: "available" as const,
        counts: projectCountGroup(
          observations.idempotency.counts,
          V.limits.publicAggregationFloor,
        ),
      }
    : projectAbsence(observations.idempotency);
  const outbox = observations.outbox.availability === "available"
    ? {
        availability: "available" as const,
        pressureBand: observations.outbox.pressureBand,
        oldestAgeBand: observations.outbox.oldestAgeBand,
        lagBand: observations.outbox.lagBand,
        orderIntegrity:
          observations.outbox.counts.orderViolations === 0
            ? "preserved" as const
            : "violations-observed" as const,
        counts: projectCountGroup(
          {
            pending: observations.outbox.counts.pending,
            receiptConfirmed: observations.outbox.counts.receiptConfirmed,
            failed: observations.outbox.counts.failed,
          },
          V.limits.publicAggregationFloor,
        ),
      }
    : projectAbsence(observations.outbox);
  const claimGraphProjection =
    observations.claimGraphProjection.availability === "available"
      ? {
          availability: "available" as const,
          completeness: observations.claimGraphProjection.completeness,
          lagBand: observations.claimGraphProjection.lagBand,
        }
      : projectAbsence(observations.claimGraphProjection);
  return {
    replay,
    rateLimit,
    leaseClaim,
    idempotency,
    outbox,
    claimGraphProjection,
  };
}

function operatorDomains(
  candidate: SharedStateObservabilityCandidateV1,
): SharedStateOperatorObservabilityProjectionV1["domains"] {
  const observations = candidate.observations;
  const replay = observations.replay.availability === "available"
    ? {
        availability: "available" as const,
        counts: projectCountGroup(
          observations.replay.counts,
          V.limits.operatorAggregationFloor,
        ),
      }
    : projectAbsence(observations.replay);
  const rateLimit = observations.rateLimit.availability === "available"
    ? {
        availability: "available" as const,
        windowBand: observations.rateLimit.windowBand,
        limitBand: observations.rateLimit.limitBand,
        counts: projectCountGroup(
          observations.rateLimit.counts,
          V.limits.operatorAggregationFloor,
        ),
      }
    : projectAbsence(observations.rateLimit);
  const leaseClaim = observations.leaseClaim.availability === "available"
    ? {
        availability: "available" as const,
        pressureBand: observations.leaseClaim.pressureBand,
        oldestAgeBand: observations.leaseClaim.oldestAgeBand,
        counts: projectCountGroup(
          observations.leaseClaim.counts,
          V.limits.operatorAggregationFloor,
        ),
      }
    : projectAbsence(observations.leaseClaim);
  const idempotency = observations.idempotency.availability === "available"
    ? {
        availability: "available" as const,
        retentionPolicyClass: observations.idempotency.retentionPolicyClass,
        counts: projectCountGroup(
          observations.idempotency.counts,
          V.limits.operatorAggregationFloor,
        ),
      }
    : projectAbsence(observations.idempotency);
  const outbox = observations.outbox.availability === "available"
    ? {
        availability: "available" as const,
        pressureBand: observations.outbox.pressureBand,
        oldestAgeBand: observations.outbox.oldestAgeBand,
        highWaterClass: observations.outbox.highWaterClass,
        lagBand: observations.outbox.lagBand,
        orderIntegrity:
          observations.outbox.counts.orderViolations === 0
            ? "preserved" as const
            : "violations-observed" as const,
        counts: projectCountGroup(
          observations.outbox.counts,
          V.limits.operatorAggregationFloor,
        ),
      }
    : projectAbsence(observations.outbox);
  const claimGraphProjection =
    observations.claimGraphProjection.availability === "available"
      ? {
          availability: "available" as const,
          projectionVersion:
            observations.claimGraphProjection.projectionVersion,
          sourceHighWaterClass:
            observations.claimGraphProjection.sourceHighWaterClass,
          checkpointHighWaterClass:
            observations.claimGraphProjection.checkpointHighWaterClass,
          lagBand: observations.claimGraphProjection.lagBand,
          oldestAgeBand: observations.claimGraphProjection.oldestAgeBand,
          completeness: observations.claimGraphProjection.completeness,
          counts: projectCountGroup(
            observations.claimGraphProjection.counts,
            V.limits.operatorAggregationFloor,
          ),
        }
      : projectAbsence(observations.claimGraphProjection);
  return {
    replay,
    rateLimit,
    leaseClaim,
    idempotency,
    outbox,
    claimGraphProjection,
  };
}

export function projectSharedStatePublicReadinessV1(
  input: unknown,
): SharedStateObservabilityResultV1<SharedStatePublicReadinessProjectionV1> {
  const parsed = parseSharedStateObservabilityCandidateV1(input);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: {
      kind: V.kinds.readiness,
      catalogVersion: V.version,
      visibility: "public-readiness-aggregate",
      ready: parsed.value.health.serving,
      effectiveGrade: parsed.value.health.effectiveGrade,
      reasonCodes: parsed.value.health.reasonCodes,
    },
  };
}

export function projectSharedStatePublicObservabilityV1(
  input: unknown,
): SharedStateObservabilityResultV1<SharedStatePublicObservabilityProjectionV1> {
  const parsed = parseSharedStateObservabilityCandidateV1(input);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: {
      kind: V.kinds.public,
      catalogVersion: V.version,
      visibility: "public-aggregate",
      stateContract: projectStateContract(parsed.value),
      domains: publicDomains(parsed.value),
    },
  };
}

export function projectSharedStateOperatorObservabilityV1(
  input: unknown,
): SharedStateObservabilityResultV1<SharedStateOperatorObservabilityProjectionV1> {
  const parsed = parseSharedStateObservabilityCandidateV1(input);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: {
      kind: V.kinds.operator,
      catalogVersion: V.version,
      visibility: "authorized-operator-aggregate",
      authorizationRequired: true,
      stateContract: projectStateContract(parsed.value),
      domains: operatorDomains(parsed.value),
    },
  };
}

function duplicateReasonPath(
  reasonCodes: readonly string[],
): readonly (string | number)[] | null {
  const seen = new Set<string>();
  for (let index = 0; index < reasonCodes.length; index += 1) {
    const reason = reasonCodes[index]!;
    if (seen.has(reason)) return ["stateContract", "reasonCodes", index];
    seen.add(reason);
  }
  return null;
}

function validateCountGroup(
  counts: Record<string, SharedStateAggregateCountV1>,
  path: readonly (string | number)[],
): SharedStateObservabilityErrorV1 | null {
  const values = Object.values(counts);
  if (
    values.some((value) => value.state === "suppressed") &&
    values.some((value) => value.state === "reported")
  ) {
    return observabilityError("unsafe_aggregate_combination", path);
  }
  return null;
}

function projectionPreflight<T>(
  input: unknown,
  schema: z.ZodType<T>,
): SharedStateObservabilityResultV1<T> {
  const preflight = preflightInput<T>(input);
  return preflight ?? parseSchema(schema, input);
}

export function parseSharedStatePublicReadinessProjectionV1(
  input: unknown,
): SharedStateObservabilityResultV1<SharedStatePublicReadinessProjectionV1> {
  const parsed = projectionPreflight(
    input,
    sharedStatePublicReadinessProjectionV1Schema,
  );
  if (!parsed.ok) return parsed;
  const duplicate = duplicateReasonPath(parsed.value.reasonCodes);
  if (duplicate) {
    return errorResult("duplicate_value", duplicate.slice(1));
  }
  if (
    parsed.value.ready !== (parsed.value.reasonCodes.length === 0)
  ) {
    return errorResult("invalid_value", ["ready"]);
  }
  return parsed;
}

export function parseSharedStatePublicObservabilityProjectionV1(
  input: unknown,
): SharedStateObservabilityResultV1<SharedStatePublicObservabilityProjectionV1> {
  const parsed = projectionPreflight(
    input,
    sharedStatePublicObservabilityProjectionV1Schema,
  );
  if (!parsed.ok) return parsed;
  const duplicate = duplicateReasonPath(parsed.value.stateContract.reasonCodes);
  if (duplicate) return errorResult("duplicate_value", duplicate);
  for (const [domain, observation] of Object.entries(parsed.value.domains)) {
    if (observation.availability !== "available" || !("counts" in observation)) {
      continue;
    }
    const error = validateCountGroup(
      observation.counts,
      ["domains", domain, "counts"],
    );
    if (error) return { ok: false, error };
  }
  return parsed;
}

export function parseSharedStateOperatorObservabilityProjectionV1(
  input: unknown,
): SharedStateObservabilityResultV1<SharedStateOperatorObservabilityProjectionV1> {
  const parsed = projectionPreflight(
    input,
    sharedStateOperatorObservabilityProjectionV1Schema,
  );
  if (!parsed.ok) return parsed;
  const duplicate = duplicateReasonPath(parsed.value.stateContract.reasonCodes);
  if (duplicate) return errorResult("duplicate_value", duplicate);
  for (const [domain, observation] of Object.entries(parsed.value.domains)) {
    if (observation.availability !== "available" || !("counts" in observation)) {
      continue;
    }
    const error = validateCountGroup(
      observation.counts,
      ["domains", domain, "counts"],
    );
    if (error) return { ok: false, error };
  }
  return parsed;
}
