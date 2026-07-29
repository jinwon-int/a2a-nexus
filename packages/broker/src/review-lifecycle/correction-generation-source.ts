/**
 * Authenticated correction-generation source adapter for bounded review
 * lineages (#1518 Phase 17).
 *
 * An exact-role operator records an already committed correction generation.
 * Trusted broker code assigns the semantic correction-controller authority;
 * request JSON cannot select authority, namespace, issuer, or derived identity.
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

export const REVIEW_LINEAGE_CORRECTION_GENERATION_SOURCE_NAMESPACE =
  "broker-http:review-lineage-correction-generation:v1" as const;

export interface OperatorReviewLineageCorrectionGenerationRequestV1 {
  generationRef: string;
  observedAt: string;
  binding: {
    intentHash: string;
    headSha: string;
    diffHash: string;
  };
  headSha: string;
  diffHash: string;
  intentHash: string;
  pathsChanged: string[];
}

const REQUEST_FIELDS = new Set([
  "generationRef",
  "observedAt",
  "binding",
  "headSha",
  "diffHash",
  "intentHash",
  "pathsChanged",
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
 * Bind one operator-observed committed generation to the canonical carrier,
 * fact, and Phase 8 parser chain. This records commit evidence only; it never
 * applies a patch or invokes a fixer, retry, completion, or finalizer path.
 */
export function authorizeOperatorReviewLineageCorrectionGeneration(
  lineageId: string,
  input: unknown,
  authenticatedOperatorId: string,
): AuthorizedReviewLineageSourceV1 {
  const request = requestObject(input);
  const carrier: ReviewLineageSourceCarrierV1 = {
    kind: REVIEW_LINEAGE_SOURCE_CARRIER_KIND,
    sourceKind: "correction_generation_committed",
    sourceEventRef: request.generationRef as string,
    lineageId,
    observedAt: request.observedAt as string,
    binding:
      request.binding as
        OperatorReviewLineageCorrectionGenerationRequestV1["binding"],
    observation: {
      kind: "correction_generation",
      headSha: request.headSha as string,
      diffHash: request.diffHash as string,
      intentHash: request.intentHash as string,
      pathsChanged: request.pathsChanged as string[],
    },
  };
  const context = createReviewLineageTrustedSourceContext({
    authorityKind: "correction_controller",
    issuerId: authenticatedOperatorId,
    sourceNamespace: REVIEW_LINEAGE_CORRECTION_GENERATION_SOURCE_NAMESPACE,
  });
  const fact = authorizeReviewLineageSourceCarrier(carrier, context);
  return projectAuthorizedReviewLineageSource(
    fact,
    {
      sourceKind: "correction_generation_committed",
      authorityKind: "correction_controller",
    },
    carrier.sourceEventRef,
  );
}
