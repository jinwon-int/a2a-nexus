// Canonical substantive predicate for wave stage quorum (#1357 G3-c classifier
// single-source).
//
// The wave-plan quorum gate compares a `substantiveCount` against a threshold
// (wave-plan.ts). Before this module the count was caller-asserted; now the
// broker derives it from per-lane evidence classes so a wave cannot be advanced
// on a count the evidence does not support.
//
// The taxonomy below mirrors the offline finalizer gate's closed
// evidence-class list (scripts/a2ad-finalizer-gate.mjs EVIDENCE_CLASSES). The
// gate stays deliberately broker-independent — it is the offline publication
// guard and must run without a broker build — so the single-source contract is
// enforced the other way around: scripts/a2ad-finalizer-gate.test.mjs pins
// this module's taxonomy and predicate against the gate's, failing CI on any
// drift. Exactly one class ('substantive') counts toward quorum in both.
import { WavePlanError, type WaveStageEvidence } from "./wave-plan.js";

/**
 * Closed lane evidence-class taxonomy. Keep synchronized with
 * scripts/a2ad-finalizer-gate.mjs EVIDENCE_CLASSES — the finalizer-gate test
 * asserts exact equality.
 */
export const WAVE_LANE_EVIDENCE_CLASSES = [
  "substantive",
  "readiness_only",
  "generic_ack",
  "wrapper_only",
  "empty_substantive_output",
  "source_projection_manifest_missing",
  "source_projection_payload_dropped",
  "source_projection_prompt_budget_truncated",
  "source_projection_worker_insufficient",
  "source_projection_blocked",
  "provider_or_model_failure",
  "analysis_blocked",
  "analysis_bridge_invalid_json",
  "evidence_contract_failure",
  "nonterminal_claimed_missing_evidence",
  "mobile_limited",
  "superseded_by_supplement",
  "failed",
  "missing_evidence",
] as const;

export type WaveLaneEvidenceClass = (typeof WAVE_LANE_EVIDENCE_CLASSES)[number];

const KNOWN_CLASSES = new Set<string>(WAVE_LANE_EVIDENCE_CLASSES);

/**
 * The quorum predicate: exactly the 'substantive' class counts. Exact match —
 * no case or whitespace forgiveness; a near-miss is an unknown class and the
 * summarizer fails closed on it rather than silently not counting it.
 */
export function isSubstantiveEvidenceClass(evidenceClass: string): boolean {
  return evidenceClass === "substantive";
}

export interface WaveLaneEvidence {
  evidenceClass?: string;
}

/**
 * Derive the quorum evidence summary from per-lane evidence classes. Unknown
 * or missing classes throw wave_spec_invalid (fail-closed) instead of being
 * silently dropped — a typo'd 'substantive' must surface, not shave the count.
 */
export function summarizeWaveStageEvidence(lanes: WaveLaneEvidence[]): WaveStageEvidence {
  let substantiveCount = 0;
  lanes.forEach((lane, index) => {
    const evidenceClass = lane.evidenceClass;
    if (typeof evidenceClass !== "string" || !KNOWN_CLASSES.has(evidenceClass)) {
      throw new WavePlanError(
        "wave_spec_invalid",
        `lanes[${index}]: unknown evidence class '${String(evidenceClass)}' (closed taxonomy; see WAVE_LANE_EVIDENCE_CLASSES)`,
      );
    }
    if (isSubstantiveEvidenceClass(evidenceClass)) substantiveCount += 1;
  });
  return { substantiveCount };
}
