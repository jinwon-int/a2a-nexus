/**
 * Authenticated reviewer-replacement source adapter for bounded review
 * lineages (#1518 Phase 18).
 *
 * An exact-role operator records an already classified infrastructure-failure
 * replacement decision. Trusted broker code assigns semantic
 * reviewer-allocator authority and every source identity; request JSON cannot
 * select a reason, reviewer, task assignment, authority, or identity.
 */

import {
  projectAuthorizedReviewLineageSource,
  type AuthorizedReviewLineageSourceV1,
} from "./authorized-source.js";
import {
  REVIEW_LINEAGE_SOURCE_CARRIER_KIND,
  SourceCarrierValidationError,
  authorizeReviewLineageSourceCarrier,
  createReviewLineageTrustedSourceContext,
  type ReviewLineageSourceCarrierV1,
} from "./source-carrier.js";

export const REVIEW_LINEAGE_REVIEWER_REPLACEMENT_SOURCE_NAMESPACE =
  "broker-http:review-lineage-reviewer-replacement:v1" as const;

export interface OperatorReviewLineageReviewerReplacementRequestV1 {
  decisionRef: string;
  observedAt: string;
  binding: {
    intentHash: string;
    headSha: string;
    diffHash: string;
  };
}

const REQUEST_FIELDS = new Set([
  "decisionRef",
  "observedAt",
  "binding",
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
 * Bind one operator-observed replacement decision to the canonical
 * carrier/fact/parser chain. This records a prior classification only; it
 * never chooses a reviewer, mutates a task, or starts a replacement loop.
 */
export function authorizeOperatorReviewLineageReviewerReplacement(
  lineageId: string,
  input: unknown,
  authenticatedOperatorId: string,
): AuthorizedReviewLineageSourceV1 {
  const request = requestObject(input);
  const carrier: ReviewLineageSourceCarrierV1 = {
    kind: REVIEW_LINEAGE_SOURCE_CARRIER_KIND,
    sourceKind: "reviewer_replacement_decided",
    sourceEventRef: request.decisionRef as string,
    lineageId,
    observedAt: request.observedAt as string,
    binding:
      request.binding as
        OperatorReviewLineageReviewerReplacementRequestV1["binding"],
    observation: {
      kind: "reviewer_replacement",
      reason: "infrastructure_failure",
    },
  };
  const context = createReviewLineageTrustedSourceContext({
    authorityKind: "reviewer_allocator",
    issuerId: authenticatedOperatorId,
    sourceNamespace: REVIEW_LINEAGE_REVIEWER_REPLACEMENT_SOURCE_NAMESPACE,
  });
  const fact = authorizeReviewLineageSourceCarrier(carrier, context);
  return projectAuthorizedReviewLineageSource(
    fact,
    {
      sourceKind: "reviewer_replacement_decided",
      authorityKind: "reviewer_allocator",
    },
    carrier.sourceEventRef,
  );
}
