/**
 * Authenticated operator-cancel source adapter for bounded review lineages
 * (#1518 Phase 14).
 *
 * This is the first runtime-owned observation kind. The request remains
 * untrusted data; only the operator-gated broker call site may supply the
 * issuer identity and create the process-local trusted context.
 */

import {
  canonicalize,
  sha256Hex,
} from "./canonical-json.js";
import type {
  ReviewLineageProducerFactV1,
} from "./producer-contract.js";
import {
  REVIEW_LINEAGE_SOURCE_CARRIER_KIND,
  SourceCarrierValidationError,
  authorizeReviewLineageSourceCarrier,
  createReviewLineageTrustedSourceContext,
  type ReviewLineageSourceCarrierV1,
} from "./source-carrier.js";

export const REVIEW_LINEAGE_OPERATOR_CANCEL_SOURCE_NAMESPACE =
  "broker-http:review-lineage-operator-cancel:v1" as const;

export interface OperatorReviewLineageCancelRequestV1 {
  decisionRef: string;
  observedAt: string;
  binding: {
    intentHash: string;
    headSha: string;
    diffHash: string;
  };
  detail: string;
}

export interface AuthorizedReviewLineageSourceEventV1 {
  sourceEventId: string;
  producerId: string;
  sourceKind: "lineage_cancel_decided";
  authorityKind: "operator";
  sourceEventRefHash: string;
  observedAt: string;
}

export interface AuthorizedOperatorCancelSourceV1 {
  fact: ReviewLineageProducerFactV1;
  source: AuthorizedReviewLineageSourceEventV1;
}

const REQUEST_FIELDS = new Set([
  "decisionRef",
  "observedAt",
  "binding",
  "detail",
]);

function requestObject(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new SourceCarrierValidationError("invalid_object", "$request");
  }
  const request = input as Record<string, unknown>;
  for (const field of Object.keys(request)) {
    if (!REQUEST_FIELDS.has(field)) {
      throw new SourceCarrierValidationError(
        "unexpected_field",
        `$request.${field}`,
      );
    }
  }
  for (const field of REQUEST_FIELDS) {
    if (!Object.hasOwn(request, field)) {
      throw new SourceCarrierValidationError(
        "invalid_string",
        `$request.${field}`,
      );
    }
  }
  return request;
}

/**
 * Bind one exact operator request to the Phase 13 carrier/context contract.
 *
 * The source namespace, source kind, and authority are server constants.
 * Neither producer/source-event identity nor authority can be supplied by the
 * request body.
 */
export function authorizeOperatorReviewLineageCancel(
  lineageId: string,
  input: unknown,
  authenticatedOperatorId: string,
): AuthorizedOperatorCancelSourceV1 {
  const request = requestObject(input);
  const carrier: ReviewLineageSourceCarrierV1 = {
    kind: REVIEW_LINEAGE_SOURCE_CARRIER_KIND,
    sourceKind: "lineage_cancel_decided",
    sourceEventRef: request.decisionRef as string,
    lineageId,
    observedAt: request.observedAt as string,
    binding: request.binding as OperatorReviewLineageCancelRequestV1["binding"],
    observation: {
      kind: "operator_cancel",
      detail: request.detail as string,
    },
  };
  const context = createReviewLineageTrustedSourceContext({
    authorityKind: "operator",
    issuerId: authenticatedOperatorId,
    sourceNamespace: REVIEW_LINEAGE_OPERATOR_CANCEL_SOURCE_NAMESPACE,
  });
  const fact = authorizeReviewLineageSourceCarrier(carrier, context);
  return {
    fact,
    source: {
      sourceEventId: fact.sourceEventId,
      producerId: fact.producerId,
      sourceKind: "lineage_cancel_decided",
      authorityKind: "operator",
      sourceEventRefHash:
        `sha256:${sha256Hex(canonicalize(carrier.sourceEventRef))}`,
      observedAt: fact.observedAt,
    },
  };
}
