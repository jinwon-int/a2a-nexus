/**
 * Authenticated review-report source adapter for bounded PR review lineages
 * (#1518 Phase 16).
 *
 * The Ed25519 HTTP-signature registry supplies the trusted reviewer issuer.
 * Request JSON remains untrusted and cannot select authority, namespace,
 * producer identity, source-event identity, or reviewer issuer.
 */

import {
  projectAuthorizedReviewLineageSource,
  type AuthorizedReviewLineageSourceV1,
} from "./authorized-source.js";
import {
  parseReviewReceiptV1,
} from "./observation.js";
import {
  REVIEW_LINEAGE_SOURCE_CARRIER_KIND,
  SourceCarrierValidationError,
  authorizeReviewLineageSourceCarrier,
  createReviewLineageTrustedSourceContext,
  type ReviewLineageSourceCarrierV1,
} from "./source-carrier.js";
import type {
  FindingV1,
  NewFindingJustification,
  ReviewReceiptV1,
} from "./types.js";

export const REVIEW_LINEAGE_REVIEW_REPORT_SOURCE_NAMESPACE =
  "broker-http:review-lineage-review-report:v1" as const;

export interface ReviewerReviewLineageReportRequestV1 {
  reportRef: string;
  observedAt: string;
  binding: {
    intentHash: string;
    headSha: string;
    diffHash: string;
  };
  receipt: ReviewReceiptV1;
  resolvedFindingIds: string[];
  reopenedFindingIds: string[];
  newFindings: Array<FindingV1 & {
    justification?: NewFindingJustification;
  }>;
}

const REQUEST_FIELDS = new Set([
  "reportRef",
  "observedAt",
  "binding",
  "receipt",
  "resolvedFindingIds",
  "reopenedFindingIds",
  "newFindings",
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
 * Bind one signed reviewer submission to the Phase 13 carrier/context chain.
 *
 * The Phase 8 receipt parser proves that the verified signing-key owner is the
 * receipt reviewer. The complete carrier then re-enters the normal Phase 13,
 * Phase 11, and Phase 8 validation chain for subject and event validation.
 */
export function authorizeReviewerReviewLineageReport(
  lineageId: string,
  input: unknown,
  authenticatedReviewerId: string,
): AuthorizedReviewLineageSourceV1 {
  const request = requestObject(input);
  const receipt = parseReviewReceiptV1(
    request.receipt,
    authenticatedReviewerId,
  );
  const carrier: ReviewLineageSourceCarrierV1 = {
    kind: REVIEW_LINEAGE_SOURCE_CARRIER_KIND,
    sourceKind: "review_report_submitted",
    sourceEventRef: request.reportRef as string,
    lineageId,
    observedAt: request.observedAt as string,
    binding:
      request.binding as ReviewerReviewLineageReportRequestV1["binding"],
    observation: {
      kind: "review_report",
      receipt,
      resolvedFindingIds:
        request.resolvedFindingIds as string[],
      reopenedFindingIds:
        request.reopenedFindingIds as string[],
      newFindings:
        request.newFindings as ReviewerReviewLineageReportRequestV1[
          "newFindings"
        ],
    },
  };
  const context = createReviewLineageTrustedSourceContext({
    authorityKind: "reviewer",
    issuerId: authenticatedReviewerId,
    sourceNamespace: REVIEW_LINEAGE_REVIEW_REPORT_SOURCE_NAMESPACE,
  });
  const fact = authorizeReviewLineageSourceCarrier(carrier, context);
  return projectAuthorizedReviewLineageSource(
    fact,
    {
      sourceKind: "review_report_submitted",
      authorityKind: "reviewer",
    },
    carrier.sourceEventRef,
  );
}
