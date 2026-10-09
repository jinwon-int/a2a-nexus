/**
 * Authenticated correction-generation source adapter for bounded review
 * lineages (#1518 Phase 17).
 *
 * An exact-role operator records an already committed correction generation.
 * Trusted broker code assigns the semantic correction-controller authority;
 * request JSON cannot select authority, namespace, issuer, or derived identity.
 */

import type { AuthorizedReviewLineageSourceV1 } from "./authorized-source.js";
import { defineLineageSourceAdapter } from "./lineage-source-adapter.js";

export const REVIEW_LINEAGE_CORRECTION_GENERATION_SOURCE_NAMESPACE =
  "broker-http:review-lineage-correction-generation:v1" as const;

export interface OperatorReviewLineageCorrectionGenerationRequestV1 {
  generationRef: string;
  observedAt: string;
  binding: {
    intentHash: string;
    headSha: string;
    diffHash: string;
  };
  headSha: string;
  diffHash: string;
  intentHash: string;
  pathsChanged: string[];
}

/**
 * Bind one operator-observed committed generation to the canonical carrier,
 * fact, and Phase 8 parser chain. This records commit evidence only; it never
 * applies a patch or invokes a fixer, retry, completion, or finalizer path.
 */
const adapter = defineLineageSourceAdapter({
  fields: [
    "generationRef",
    "observedAt",
    "binding",
    "headSha",
    "diffHash",
    "intentHash",
    "pathsChanged",
  ],
  refField: "generationRef",
  descriptor: {
    sourceKind: "correction_generation_committed",
    authorityKind: "correction_controller",
  },
  namespace: REVIEW_LINEAGE_CORRECTION_GENERATION_SOURCE_NAMESPACE,
  observation: (request) => ({
    kind: "correction_generation",
    headSha: request.headSha as string,
    diffHash: request.diffHash as string,
    intentHash: request.intentHash as string,
    pathsChanged: request.pathsChanged as string[],
  }),
});

export function authorizeOperatorReviewLineageCorrectionGeneration(
  lineageId: string,
  input: unknown,
  authenticatedOperatorId: string,
): AuthorizedReviewLineageSourceV1 {
  return adapter(input, authenticatedOperatorId, lineageId);
}
