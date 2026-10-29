/**
 * Authenticated reviewer-replacement source adapter for bounded review
 * lineages (#1518 Phase 18).
 *
 * An exact-role operator records an already classified infrastructure-failure
 * replacement decision. Trusted broker code assigns semantic
 * reviewer-allocator authority and every source identity; request JSON cannot
 * select a reason, reviewer, task assignment, authority, or identity.
 */

import type { AuthorizedReviewLineageSourceV1 } from "./authorized-source.js";
import { defineLineageSourceAdapter } from "./lineage-source-adapter.js";

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

/**
 * Bind one operator-observed replacement decision to the canonical
 * carrier/fact/parser chain. This records a prior classification only; it
 * never chooses a reviewer, mutates a task, or starts a replacement loop.
 */
const adapter = defineLineageSourceAdapter({
  fields: ["decisionRef", "observedAt", "binding"],
  refField: "decisionRef",
  descriptor: {
    sourceKind: "reviewer_replacement_decided",
    authorityKind: "reviewer_allocator",
  },
  namespace: REVIEW_LINEAGE_REVIEWER_REPLACEMENT_SOURCE_NAMESPACE,
  observation: () => ({
    kind: "reviewer_replacement",
    reason: "infrastructure_failure",
  }),
});

export function authorizeOperatorReviewLineageReviewerReplacement(
  lineageId: string,
  input: unknown,
  authenticatedOperatorId: string,
): AuthorizedReviewLineageSourceV1 {
  return adapter(input, authenticatedOperatorId, lineageId);
}
