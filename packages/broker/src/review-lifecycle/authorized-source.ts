/**
 * Minimized metadata shared by authenticated review-lineage source adapters
 * (#1518 Phases 14-16).
 *
 * Only source kinds with an actual runtime owner belong in the closed
 * descriptor union. Adding a carrier contract alone must not expand automatic
 * source coverage.
 */

import {
  canonicalize,
  sha256Hex,
} from "./canonical-json.js";
import type {
  ReviewLineageProducerFactV1,
} from "./producer-contract.js";

export type AttachedReviewLineageSourceDescriptorV1 =
  | {
      sourceKind: "lineage_contract_frozen";
      authorityKind: "lineage_dispatcher";
    }
  | {
      sourceKind: "lineage_cancel_decided";
      authorityKind: "operator";
    }
  | {
      sourceKind: "review_report_submitted";
      authorityKind: "reviewer";
    };

export type AuthorizedReviewLineageSourceEventV1 =
  AttachedReviewLineageSourceDescriptorV1 & {
    sourceEventId: string;
    producerId: string;
    sourceEventRefHash: string;
    observedAt: string;
  };

export interface AuthorizedReviewLineageSourceV1 {
  fact: ReviewLineageProducerFactV1;
  source: AuthorizedReviewLineageSourceEventV1;
}

/**
 * Project privacy-minimized durable metadata after carrier authorization.
 *
 * The raw source-local reference is hashed and never returned for storage.
 * Runtime admission still verifies the complete source/authority/command tuple
 * before any transaction starts.
 */
export function projectAuthorizedReviewLineageSource(
  fact: ReviewLineageProducerFactV1,
  descriptor: AttachedReviewLineageSourceDescriptorV1,
  sourceEventRef: string,
): AuthorizedReviewLineageSourceV1 {
  return {
    fact,
    source: {
      sourceEventId: fact.sourceEventId,
      producerId: fact.producerId,
      ...descriptor,
      sourceEventRefHash:
        `sha256:${sha256Hex(canonicalize(sourceEventRef))}`,
      observedAt: fact.observedAt,
    },
  };
}
