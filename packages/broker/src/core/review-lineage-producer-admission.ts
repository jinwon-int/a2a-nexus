/**
 * Explicit asynchronous producer-fact admission for bounded PR review
 * lineages (#1518 Phase 12).
 *
 * This is a prerequisite boundary, not an automatic producer. Callers must
 * already possess one complete ReviewLineageProducerFactV1 and must await the
 * returned Promise. Generic task/result/cancellation state is never inspected
 * or projected here.
 */

import {
  projectReviewLineageProducerFact,
} from "../review-lifecycle/producer-contract.js";
import type {
  ProjectedReviewLineageObservation,
} from "../review-lifecycle/observation.js";
import type {
  ReviewLineageObservationApplicationResult,
} from "./review-lineage-observation-store.js";
import type {
  ReviewLineageRolloutMode,
} from "./review-lineage-store.js";

export interface ReviewLineageProducerAdmissionContext {
  mode: ReviewLineageRolloutMode;
  apply: (
    command: ProjectedReviewLineageObservation,
  ) =>
    | ReviewLineageObservationApplicationResult
    | Promise<ReviewLineageObservationApplicationResult>;
}

/**
 * Validate and durably apply one explicit producer fact.
 *
 * Off mode returns before parsing so the default posture remains fully inert.
 * Record mode uses the Phase 11 projector as its sole validation boundary,
 * then awaits exactly one canonical compound command. Store/queue failures are
 * intentionally returned to the caller rather than detached or downgraded.
 */
export async function admitReviewLineageProducerFact(
  input: unknown,
  context: ReviewLineageProducerAdmissionContext,
): Promise<ReviewLineageObservationApplicationResult | undefined> {
  if (context.mode === "off") {
    return undefined;
  }
  const command = projectReviewLineageProducerFact(input);
  return await context.apply(command);
}
