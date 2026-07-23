/**
 * Source-only producer completeness contract for bounded PR review lineages
 * (#1518 Phase 11).
 *
 * A producer fact is already-structured source evidence. This module changes
 * only its outer version tag, then delegates every field and transition check
 * to the Phase 8 observation parser. It never infers evidence from task state,
 * result prose, logs, provider output, or wall-clock time.
 */

import {
  ObservationValidationError,
  REVIEW_LINEAGE_OBSERVATION_KIND,
  parseReviewLineageObservation,
  type ProjectedReviewLineageObservation,
  type ReviewLineageObservationEnvelopeV1,
  type ReviewLineageObservationV1,
} from "./observation.js";

export const REVIEW_LINEAGE_PRODUCER_FACT_KIND =
  "a2a.review-lineage-producer-fact.v1" as const;

export type ReviewLineageProducerFactV1 =
  Omit<ReviewLineageObservationEnvelopeV1, "kind"> & {
    kind: typeof REVIEW_LINEAGE_PRODUCER_FACT_KIND;
  };

type ProducerCompletenessEntry<
  Kind extends ReviewLineageObservationV1["kind"],
> = {
  factKind: typeof REVIEW_LINEAGE_PRODUCER_FACT_KIND;
  observationKind: Kind;
  commandKind: Kind extends "lineage_create"
    ? "create_lineage"
    : "record_event";
  engineEventType: Kind extends "lineage_create" ? null : Kind;
};

/**
 * This mapped type is the compile-time completeness proof. Adding a new
 * ReviewLineageObservationV1 kind makes this declaration fail until an
 * explicit producer row is supplied.
 */
export const REVIEW_LINEAGE_PRODUCER_COMPLETENESS_MATRIX = {
  lineage_create: {
    factKind: REVIEW_LINEAGE_PRODUCER_FACT_KIND,
    observationKind: "lineage_create",
    commandKind: "create_lineage",
    engineEventType: null,
  },
  review_report: {
    factKind: REVIEW_LINEAGE_PRODUCER_FACT_KIND,
    observationKind: "review_report",
    commandKind: "record_event",
    engineEventType: "review_report",
  },
  correction_generation: {
    factKind: REVIEW_LINEAGE_PRODUCER_FACT_KIND,
    observationKind: "correction_generation",
    commandKind: "record_event",
    engineEventType: "correction_generation",
  },
  reviewer_replacement: {
    factKind: REVIEW_LINEAGE_PRODUCER_FACT_KIND,
    observationKind: "reviewer_replacement",
    commandKind: "record_event",
    engineEventType: "reviewer_replacement",
  },
  operator_cancel: {
    factKind: REVIEW_LINEAGE_PRODUCER_FACT_KIND,
    observationKind: "operator_cancel",
    commandKind: "record_event",
    engineEventType: "operator_cancel",
  },
} as const satisfies {
  [Kind in ReviewLineageObservationV1["kind"]]:
    ProducerCompletenessEntry<Kind>;
};

const PRODUCER_FACT_FIELDS = new Set([
  "kind",
  "producerId",
  "sourceEventId",
  "lineageId",
  "observedAt",
  "binding",
  "observation",
]);

function producerFactObject(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ObservationValidationError("invalid_object", "$");
  }
  const fact = input as Record<string, unknown>;
  for (const field of Object.keys(fact)) {
    if (!PRODUCER_FACT_FIELDS.has(field)) {
      throw new ObservationValidationError("unexpected_field", `$.${field}`);
    }
  }
  if (fact.kind !== REVIEW_LINEAGE_PRODUCER_FACT_KIND) {
    throw new ObservationValidationError("unsupported_version", "$.kind");
  }
  return fact;
}

/**
 * Build the exact lossless Phase 8 envelope for one structured producer fact.
 * The parser call is intentional: no producer-specific validation fork may
 * drift from the canonical observation boundary.
 */
export function buildReviewLineageObservationEnvelopeFromFact(
  input: unknown,
): ReviewLineageObservationEnvelopeV1 {
  const fact = producerFactObject(input);
  const envelope = {
    ...fact,
    kind: REVIEW_LINEAGE_OBSERVATION_KIND,
  } as ReviewLineageObservationEnvelopeV1;
  parseReviewLineageObservation(envelope);
  // Clone only after validation. Invalid non-JSON values must receive the
  // parser's stable code/path error rather than a structuredClone exception.
  return structuredClone(envelope);
}

export function projectReviewLineageProducerFact(
  input: unknown,
): ProjectedReviewLineageObservation {
  return parseReviewLineageObservation(
    buildReviewLineageObservationEnvelopeFromFact(input),
  );
}
