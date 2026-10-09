/**
 * Authenticated operator-cancel source adapter for bounded review lineages
 * (#1518 Phase 14).
 *
 * This is the first runtime-owned observation kind. The request remains
 * untrusted data; only the operator-gated broker call site may supply the
 * issuer identity and create the process-local trusted context.
 */

import type { AuthorizedReviewLineageSourceV1 } from "./authorized-source.js";
import { defineLineageSourceAdapter } from "./lineage-source-adapter.js";

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

/**
 * Bind one exact operator request to the Phase 13 carrier/context contract.
 *
 * The source namespace, source kind, and authority are server constants.
 * Neither producer/source-event identity nor authority can be supplied by the
 * request body.
 */
const adapter = defineLineageSourceAdapter({
  fields: ["decisionRef", "observedAt", "binding", "detail"],
  refField: "decisionRef",
  descriptor: {
    sourceKind: "lineage_cancel_decided",
    authorityKind: "operator",
  },
  namespace: REVIEW_LINEAGE_OPERATOR_CANCEL_SOURCE_NAMESPACE,
  observation: (request) => ({
    kind: "operator_cancel",
    detail: request.detail as string,
  }),
});

export function authorizeOperatorReviewLineageCancel(
  lineageId: string,
  input: unknown,
  authenticatedOperatorId: string,
): AuthorizedReviewLineageSourceV1 {
  return adapter(input, authenticatedOperatorId, lineageId);
}
