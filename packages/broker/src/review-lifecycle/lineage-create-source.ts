/**
 * Authenticated lineage-create source adapter for bounded review lineages
 * (#1518 Phase 15).
 *
 * The normative lifecycle contract permits only an operator to start a new
 * lineage. The request remains untrusted data; trusted broker code assigns the
 * semantic lineage-dispatcher authority after the route's exact-role gate.
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

const REQUEST_FIELDS = new Set([
  "dispatchRef",
  "observedAt",
  "binding",
  "contract",
  "budget",
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
 * Bind one operator-owned contract freeze to the existing carrier/fact/parser
 * chain. No authority or derived identity comes from request JSON.
 */
export function authorizeOperatorReviewLineageCreate(
  input: unknown,
  authenticatedOperatorId: string,
): AuthorizedReviewLineageSourceV1 {
  const request = requestObject(input);
  const contract =
    request.contract as OperatorReviewLineageCreateRequestV1["contract"];
  const carrier: ReviewLineageSourceCarrierV1 = {
    kind: REVIEW_LINEAGE_SOURCE_CARRIER_KIND,
    sourceKind: "lineage_contract_frozen",
    sourceEventRef: request.dispatchRef as string,
    lineageId: contract?.lineageId,
    observedAt: request.observedAt as string,
    binding: request.binding as OperatorReviewLineageCreateRequestV1["binding"],
    observation: {
      kind: "lineage_create",
      mode: "record",
      contract,
      budget:
        request.budget as OperatorReviewLineageCreateRequestV1["budget"],
    },
  };
  const context = createReviewLineageTrustedSourceContext({
    authorityKind: "lineage_dispatcher",
    issuerId: authenticatedOperatorId,
    sourceNamespace: REVIEW_LINEAGE_CREATE_SOURCE_NAMESPACE,
  });
  const fact = authorizeReviewLineageSourceCarrier(carrier, context);
  return projectAuthorizedReviewLineageSource(
    fact,
    {
      sourceKind: "lineage_contract_frozen",
      authorityKind: "lineage_dispatcher",
    },
    carrier.sourceEventRef,
  );
}
