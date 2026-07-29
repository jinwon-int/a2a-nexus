/**
 * Minimized metadata shared by authenticated review-lineage source adapters
 * (#1518 Phases 14-18).
 *
 * Only source kinds with an actual runtime owner belong in the closed
 * descriptor union. Adding a carrier contract alone must not expand runtime
 * source-attachment coverage.
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
    }
  | {
      sourceKind: "correction_generation_committed";
      authorityKind: "correction_controller";
    }
  | {
      sourceKind: "reviewer_replacement_decided";
      authorityKind: "reviewer_allocator";
    };

/**
 * The complete runtime-attached set. Source, authority, command, and
 * observation classes are intentionally closed and independently checked
 * again at the durable store boundary.
 */
export const REVIEW_LINEAGE_ATTACHED_SOURCE_TUPLES = [
  {
    sourceKind: "lineage_contract_frozen",
    authorityKind: "lineage_dispatcher",
    commandKind: "create_lineage",
    observationKind: "lineage_create",
  },
  {
    sourceKind: "review_report_submitted",
    authorityKind: "reviewer",
    commandKind: "record_event",
    observationKind: "review_report",
  },
  {
    sourceKind: "correction_generation_committed",
    authorityKind: "correction_controller",
    commandKind: "record_event",
    observationKind: "correction_generation",
  },
  {
    sourceKind: "reviewer_replacement_decided",
    authorityKind: "reviewer_allocator",
    commandKind: "record_event",
    observationKind: "reviewer_replacement",
  },
  {
    sourceKind: "lineage_cancel_decided",
    authorityKind: "operator",
    commandKind: "record_event",
    observationKind: "operator_cancel",
  },
] as const satisfies ReadonlyArray<
  AttachedReviewLineageSourceDescriptorV1 & {
    commandKind: "create_lineage" | "record_event";
    observationKind:
      | "lineage_create"
      | "review_report"
      | "correction_generation"
      | "reviewer_replacement"
      | "operator_cancel";
  }
>;

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
