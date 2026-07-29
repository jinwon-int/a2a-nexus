/**
 * Pure authoritative-source carrier contract for bounded PR review lineages
 * (#1518 Phase 13).
 *
 * The serializable carrier is untrusted and cannot assert authority,
 * producerId, or sourceEventId. A future authenticated source boundary must
 * create the process-local trusted context. This module then verifies the
 * per-kind authority, derives both identities, and delegates the complete fact
 * to the existing Phase 11 / Phase 8 validation boundary.
 *
 * This module has no broker, store, task, route, outbox, or runtime call site.
 */

import {
  canonicalize,
  sha256Hex,
} from "./canonical-json.js";
import {
  REVIEW_LINEAGE_PRODUCER_FACT_KIND,
  buildReviewLineageObservationEnvelopeFromFact,
  type ReviewLineageProducerFactV1,
} from "./producer-contract.js";
import type {
  ReviewLineageObservationV1,
  ReviewLineageSubjectBindingV1,
} from "./observation.js";

export const REVIEW_LINEAGE_SOURCE_CARRIER_KIND =
  "a2a.review-lineage-source-carrier.v1" as const;
export const REVIEW_LINEAGE_TRUSTED_SOURCE_CONTEXT_KIND =
  "a2a.review-lineage-trusted-source-context.v1" as const;

type ObservationKind = ReviewLineageObservationV1["kind"];

type SourceAuthorityEntry<
  Kind extends ObservationKind,
  SourceKind extends string,
  AuthorityKind extends string,
> = {
  observationKind: Kind;
  sourceKind: SourceKind;
  authorityKind: AuthorityKind;
};

/**
 * Compile-time completeness and authority proof.
 *
 * Adding an observation kind fails this declaration until its immutable source
 * event and authenticated owner class are named explicitly.
 */
export const REVIEW_LINEAGE_SOURCE_AUTHORITY_MATRIX = {
  lineage_create: {
    observationKind: "lineage_create",
    sourceKind: "lineage_contract_frozen",
    authorityKind: "lineage_dispatcher",
  },
  review_report: {
    observationKind: "review_report",
    sourceKind: "review_report_submitted",
    authorityKind: "reviewer",
  },
  correction_generation: {
    observationKind: "correction_generation",
    sourceKind: "correction_generation_committed",
    authorityKind: "correction_controller",
  },
  reviewer_replacement: {
    observationKind: "reviewer_replacement",
    sourceKind: "reviewer_replacement_decided",
    authorityKind: "reviewer_allocator",
  },
  operator_cancel: {
    observationKind: "operator_cancel",
    sourceKind: "lineage_cancel_decided",
    authorityKind: "operator",
  },
} as const satisfies {
  [Kind in ObservationKind]: SourceAuthorityEntry<
    Kind,
    string,
    string
  >;
};

type AuthorityMatrix = typeof REVIEW_LINEAGE_SOURCE_AUTHORITY_MATRIX;

export type ReviewLineageSourceKind =
  AuthorityMatrix[ObservationKind]["sourceKind"];
export type ReviewLineageSourceAuthorityKind =
  AuthorityMatrix[ObservationKind]["authorityKind"];

type SourceCarrierFor<Kind extends ObservationKind> = {
  kind: typeof REVIEW_LINEAGE_SOURCE_CARRIER_KIND;
  sourceKind: AuthorityMatrix[Kind]["sourceKind"];
  /**
   * Immutable ID from the authoritative source's own namespace.
   *
   * It is not globally trusted by itself. The trusted context namespace and
   * issuer are included when sourceEventId is derived.
   */
  sourceEventRef: string;
  lineageId: string;
  observedAt: string;
  binding: ReviewLineageSubjectBindingV1;
  observation: Extract<ReviewLineageObservationV1, { kind: Kind }>;
};

export type ReviewLineageSourceCarrierV1 = {
  [Kind in ObservationKind]: SourceCarrierFor<Kind>;
}[ObservationKind];

export interface CreateReviewLineageTrustedSourceContextInput {
  authorityKind: ReviewLineageSourceAuthorityKind;
  issuerId: string;
  sourceNamespace: string;
}

/**
 * Process-local capability issued only after a caller has authenticated
 * the source. It is deliberately not serializable evidence.
 */
export interface ReviewLineageTrustedSourceContextV1 {
  readonly kind: typeof REVIEW_LINEAGE_TRUSTED_SOURCE_CONTEXT_KIND;
  readonly authorityKind: ReviewLineageSourceAuthorityKind;
  readonly issuerId: string;
  readonly sourceNamespace: string;
}

export type SourceCarrierValidationCode =
  | "invalid_object"
  | "unexpected_field"
  | "unsupported_version"
  | "invalid_string"
  | "invalid_enum"
  | "unsupported_source"
  | "source_kind_mismatch"
  | "authority_mismatch"
  | "issuer_mismatch"
  | "untrusted_context";

/**
 * Stable error surface. Input values and authentication material are never
 * copied into messages.
 */
export class SourceCarrierValidationError extends Error {
  constructor(
    readonly code: SourceCarrierValidationCode,
    readonly path: string,
  ) {
    super(`${code} at ${path}`);
  }
}

const CARRIER_FIELDS = new Set([
  "kind",
  "sourceKind",
  "sourceEventRef",
  "lineageId",
  "observedAt",
  "binding",
  "observation",
]);
const CONTEXT_INPUT_FIELDS = new Set([
  "authorityKind",
  "issuerId",
  "sourceNamespace",
]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const trustedContexts = new WeakSet<object>();

function fail(
  code: SourceCarrierValidationCode,
  path: string,
): never {
  throw new SourceCarrierValidationError(code, path);
}

function objectAt(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_object", path);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("unexpected_field", `${path}.${key}`);
  }
}

function identifierAt(
  value: unknown,
  path: string,
): string {
  if (
    typeof value !== "string"
    || !IDENTIFIER_PATTERN.test(value)
  ) {
    fail("invalid_string", path);
  }
  return value;
}

function authorityKindAt(
  value: unknown,
  path: string,
): ReviewLineageSourceAuthorityKind {
  const authorities = new Set<ReviewLineageSourceAuthorityKind>(
    Object.values(REVIEW_LINEAGE_SOURCE_AUTHORITY_MATRIX)
      .map((entry) => entry.authorityKind),
  );
  if (
    typeof value !== "string"
    || !authorities.has(value as ReviewLineageSourceAuthorityKind)
  ) {
    fail("invalid_enum", path);
  }
  return value as ReviewLineageSourceAuthorityKind;
}

/**
 * Create a non-serializable trusted capability after external authentication.
 *
 * Calling this function is itself a trusted-code operation. Phase 13 adds no
 * route or runtime owner that calls it.
 */
export function createReviewLineageTrustedSourceContext(
  input: CreateReviewLineageTrustedSourceContextInput,
): ReviewLineageTrustedSourceContextV1 {
  const raw = objectAt(input, "$trustedContext");
  exactKeys(raw, CONTEXT_INPUT_FIELDS, "$trustedContext");
  const context = Object.freeze({
    kind: REVIEW_LINEAGE_TRUSTED_SOURCE_CONTEXT_KIND,
    authorityKind: authorityKindAt(
      raw.authorityKind,
      "$trustedContext.authorityKind",
    ),
    issuerId: identifierAt(
      raw.issuerId,
      "$trustedContext.issuerId",
    ),
    sourceNamespace: identifierAt(
      raw.sourceNamespace,
      "$trustedContext.sourceNamespace",
    ),
  });
  trustedContexts.add(context);
  return context;
}

function requireTrustedContext(
  context: ReviewLineageTrustedSourceContextV1,
): ReviewLineageTrustedSourceContextV1 {
  if (
    context === null
    || typeof context !== "object"
    || !trustedContexts.has(context)
  ) {
    fail("untrusted_context", "$trustedContext");
  }
  return context;
}

function deriveProducerId(
  context: ReviewLineageTrustedSourceContextV1,
): string {
  const digest = sha256Hex(canonicalize({
    authorityKind: context.authorityKind,
    issuerId: context.issuerId,
    sourceNamespace: context.sourceNamespace,
    version: 1,
  }));
  return `review-lineage-source:v1:${digest}`;
}

function deriveSourceEventId(
  producerId: string,
  sourceKind: ReviewLineageSourceKind,
  sourceEventRef: string,
): string {
  const digest = sha256Hex(canonicalize({
    producerId,
    sourceEventRef,
    sourceKind,
    version: 1,
  }));
  return `review-lineage-event:v1:${digest}`;
}

/**
 * Authorize one untrusted carrier and build the canonical Phase 11 fact.
 *
 * The existing Phase 8 parser remains the sole complete field, subject,
 * transition, idempotency, and fingerprint validator. This layer validates
 * only the carrier/authority boundary and reviewer issuer binding.
 */
export function authorizeReviewLineageSourceCarrier(
  input: unknown,
  trustedContext: ReviewLineageTrustedSourceContextV1,
): ReviewLineageProducerFactV1 {
  const context = requireTrustedContext(trustedContext);
  const carrier = objectAt(input, "$");
  exactKeys(carrier, CARRIER_FIELDS, "$");
  if (carrier.kind !== REVIEW_LINEAGE_SOURCE_CARRIER_KIND) {
    fail("unsupported_version", "$.kind");
  }

  const sourceEventRef = identifierAt(
    carrier.sourceEventRef,
    "$.sourceEventRef",
  );
  const observation = objectAt(carrier.observation, "$.observation");
  const observationKind = observation.kind;
  if (
    typeof observationKind !== "string"
    || !Object.hasOwn(
      REVIEW_LINEAGE_SOURCE_AUTHORITY_MATRIX,
      observationKind,
    )
  ) {
    fail("unsupported_source", "$.observation.kind");
  }
  const entry = REVIEW_LINEAGE_SOURCE_AUTHORITY_MATRIX[
    observationKind as ObservationKind
  ];
  if (carrier.sourceKind !== entry.sourceKind) {
    fail("source_kind_mismatch", "$.sourceKind");
  }
  if (context.authorityKind !== entry.authorityKind) {
    fail("authority_mismatch", "$trustedContext.authorityKind");
  }

  const producerId = deriveProducerId(context);
  const sourceEventId = deriveSourceEventId(
    producerId,
    entry.sourceKind,
    sourceEventRef,
  );
  const envelope = buildReviewLineageObservationEnvelopeFromFact({
    kind: REVIEW_LINEAGE_PRODUCER_FACT_KIND,
    producerId,
    sourceEventId,
    lineageId: carrier.lineageId,
    observedAt: carrier.observedAt,
    binding: carrier.binding,
    observation: carrier.observation,
  });

  if (
    envelope.observation.kind === "review_report"
    && envelope.observation.receipt.reviewerNodeId !== context.issuerId
  ) {
    fail("issuer_mismatch", "$trustedContext.issuerId");
  }

  return {
    ...envelope,
    kind: REVIEW_LINEAGE_PRODUCER_FACT_KIND,
  };
}
