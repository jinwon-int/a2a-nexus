/**
 * Authenticated review-report source adapter for bounded PR review lineages
 * (#1518 Phase 16).
 *
 * The Ed25519 HTTP-signature registry supplies the trusted reviewer issuer.
 * Request JSON remains untrusted and cannot select authority, namespace,
 * producer identity, source-event identity, or reviewer issuer.
 */

import type { AuthorizedReviewLineageSourceV1 } from "./authorized-source.js";
import { defineLineageSourceAdapter } from "./lineage-source-adapter.js";
import { parseReviewReceiptV1 } from "./observation.js";
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

/**
 * Bind one signed reviewer submission to the Phase 13 carrier/context chain.
 *
 * The Phase 8 receipt parser proves that the verified signing-key owner is the
 * receipt reviewer. The complete carrier then re-enters the normal Phase 13,
 * Phase 11, and Phase 8 validation chain for subject and event validation.
 */
const adapter = defineLineageSourceAdapter({
  fields: [
    "reportRef",
    "observedAt",
    "binding",
    "receipt",
    "resolvedFindingIds",
    "reopenedFindingIds",
    "newFindings",
  ],
  refField: "reportRef",
  descriptor: {
    sourceKind: "review_report_submitted",
    authorityKind: "reviewer",
  },
  namespace: REVIEW_LINEAGE_REVIEW_REPORT_SOURCE_NAMESPACE,
  observation: (request, authenticatedReviewerId) => ({
    kind: "review_report",
    receipt: parseReviewReceiptV1(request.receipt, authenticatedReviewerId),
    resolvedFindingIds: request.resolvedFindingIds as string[],
    reopenedFindingIds: request.reopenedFindingIds as string[],
    newFindings:
      request.newFindings as ReviewerReviewLineageReportRequestV1["newFindings"],
  }),
});

export function authorizeReviewerReviewLineageReport(
  lineageId: string,
  input: unknown,
  authenticatedReviewerId: string,
): AuthorizedReviewLineageSourceV1 {
  return adapter(input, authenticatedReviewerId, lineageId);
}
