/**
 * Authenticated lineage-create source adapter for bounded review lineages
 * (#1518 Phase 15).
 *
 * The normative lifecycle contract permits only an operator to start a new
 * lineage. The request remains untrusted data; trusted broker code assigns the
 * semantic lineage-dispatcher authority after the route's exact-role gate.
 */

import type { AuthorizedReviewLineageSourceV1 } from "./authorized-source.js";
import { defineLineageSourceAdapter } from "./lineage-source-adapter.js";
import type {
  IntentContractV1,
  ReviewLineageBudgetV1,
} from "./types.js";

export const REVIEW_LINEAGE_CREATE_SOURCE_NAMESPACE =
  "broker-http:review-lineage-create:v1" as const;

export interface OperatorReviewLineageCreateRequestV1 {
  dispatchRef: string;
  observedAt: string;
  binding: {
    intentHash: string;
    headSha: string;
    diffHash: string;
  };
  contract: IntentContractV1;
  budget: ReviewLineageBudgetV1;
}

function contractOf(
  request: Record<string, unknown>,
): OperatorReviewLineageCreateRequestV1["contract"] {
  return request.contract as OperatorReviewLineageCreateRequestV1["contract"];
}

/**
 * Bind one operator-owned contract freeze to the existing carrier/fact/parser
 * chain. No authority or derived identity comes from request JSON.
 */
const adapter = defineLineageSourceAdapter({
  fields: ["dispatchRef", "observedAt", "binding", "contract", "budget"],
  refField: "dispatchRef",
  descriptor: {
    sourceKind: "lineage_contract_frozen",
    authorityKind: "lineage_dispatcher",
  },
  namespace: REVIEW_LINEAGE_CREATE_SOURCE_NAMESPACE,
  lineageIdFrom: (request) => contractOf(request)?.lineageId,
  observation: (request) => ({
    kind: "lineage_create",
    mode: "record",
    contract: contractOf(request),
    budget: request.budget as OperatorReviewLineageCreateRequestV1["budget"],
  }),
});

export function authorizeOperatorReviewLineageCreate(
  input: unknown,
  authenticatedOperatorId: string,
): AuthorizedReviewLineageSourceV1 {
  return adapter(input, authenticatedOperatorId);
}
