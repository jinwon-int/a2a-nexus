/**
 * Shared skeleton for authenticated review-lineage source adapters
 * (#1518 Phases 14-18; folded from five byte-identical copies in #2350 A5).
 *
 * Every adapter follows the same four trusted steps:
 *   1. exact-field request validation (unexpected fields first, then missing);
 *   2. carrier construction from server constants + request fields;
 *   3. process-local trusted context for the authenticated issuer;
 *   4. carrier authorization + privacy-minimized projection.
 *
 * Request JSON still cannot select authority, namespace, producer identity,
 * source-event identity, or issuer — those come from the adapter definition
 * and the authenticated route, exactly as before.
 */

import {
  projectAuthorizedReviewLineageSource,
  type AttachedReviewLineageSourceDescriptorV1,
  type AuthorizedReviewLineageSourceV1,
} from "./authorized-source.js";
import {
  REVIEW_LINEAGE_SOURCE_CARRIER_KIND,
  SourceCarrierValidationError,
  authorizeReviewLineageSourceCarrier,
  createReviewLineageTrustedSourceContext,
  type ReviewLineageSourceCarrierV1,
} from "./source-carrier.js";

export type LineageSourceRequest = Record<string, unknown>;

export interface LineageSourceAdapterDefinition<
  Descriptor extends AttachedReviewLineageSourceDescriptorV1,
> {
  /** Closed exact-field set; any other key or any missing key is rejected. */
  fields: readonly string[];
  /** Request field carrying the source-local event reference. */
  refField: string;
  descriptor: Descriptor;
  namespace: string;
  /**
   * Build the observation from the validated request. Runs before the
   * carrier exists, so adapters that parse issuer-bound evidence (review
   * receipts) keep their original validation order.
   */
  observation: (
    request: LineageSourceRequest,
    issuerId: string,
  ) => Extract<
    ReviewLineageSourceCarrierV1,
    { sourceKind: Descriptor["sourceKind"] }
  >["observation"];
  /**
   * Where the lineage id comes from when the route does not carry it
   * (lineage create derives it from the frozen contract).
   */
  lineageIdFrom?: (request: LineageSourceRequest) => string | undefined;
}

export interface LineageSourceAdapter {
  (
    input: unknown,
    issuerId: string,
    lineageId?: string,
  ): AuthorizedReviewLineageSourceV1;
}

/**
 * Validate the untrusted request body against a closed field set.
 * Exported so adapter tests can pin the error order independently.
 */
export function exactLineageSourceRequest(
  input: unknown,
  fields: readonly string[],
): LineageSourceRequest {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new SourceCarrierValidationError("invalid_object", "$request");
  }
  const request = input as LineageSourceRequest;
  const allowed = new Set(fields);
  for (const field of Object.keys(request)) {
    if (!allowed.has(field)) {
      throw new SourceCarrierValidationError(
        "unexpected_field",
        `$request.${field}`,
      );
    }
  }
  for (const field of fields) {
    if (!Object.hasOwn(request, field)) {
      throw new SourceCarrierValidationError(
        "invalid_string",
        `$request.${field}`,
      );
    }
  }
  return request;
}

export function defineLineageSourceAdapter<
  Descriptor extends AttachedReviewLineageSourceDescriptorV1,
>(definition: LineageSourceAdapterDefinition<Descriptor>): LineageSourceAdapter {
  const { fields, refField, descriptor, namespace, observation, lineageIdFrom } =
    definition;
  return (input, issuerId, lineageId) => {
    const request = exactLineageSourceRequest(input, fields);
    const carrier = {
      kind: REVIEW_LINEAGE_SOURCE_CARRIER_KIND,
      sourceKind: descriptor.sourceKind,
      sourceEventRef: request[refField] as string,
      lineageId: (lineageIdFrom ? lineageIdFrom(request) : lineageId) as string,
      observedAt: request.observedAt as string,
      binding: request.binding as ReviewLineageSourceCarrierV1["binding"],
      observation: observation(request, issuerId),
    } as ReviewLineageSourceCarrierV1;
    const context = createReviewLineageTrustedSourceContext({
      authorityKind: descriptor.authorityKind,
      issuerId,
      sourceNamespace: namespace,
    });
    const fact = authorizeReviewLineageSourceCarrier(carrier, context);
    return projectAuthorizedReviewLineageSource(
      fact,
      descriptor,
      carrier.sourceEventRef,
    );
  };
}
