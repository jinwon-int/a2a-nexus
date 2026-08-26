/**
 * Stable rejection vocabulary for the WavePlanDagV2 contract (#1800 slice 1).
 *
 * Spec §5 fixes every stable rejection reason and §7 rules that "a rejection
 * grants no authority and emits no success-like receipt". The runtime mirrors
 * `test/conformance/check-wave-plan-dag-v2.mjs`, which throws on each of
 * these reasons while validating its curated fixture; the production surface
 * deliberately reports them as **data** (`ok: false` unions in
 * `manifest.ts` / `dry-run.ts`) because future dispatcher integration will
 * feed untrusted proposals through this module and must branch on the reason,
 * not catch exceptions. The message text and reasons are identical either way.
 */

/** Spec §5: the complete closed list of stable rejection reasons. */
export const WAVE_PLAN_DAG_V2_REJECTION_REASONS = [
  "manifest_malformed",
  "duplicate_stage",
  "unknown_endpoint",
  "duplicate_edge",
  "self_edge",
  "root_count_invalid",
  "unreachable_stage",
  "cycle_detected",
  "stage_limit_exceeded",
  "edge_limit_exceeded",
  "depth_limit_exceeded",
  "fan_in_limit_exceeded",
  "fan_out_limit_exceeded",
  "manifest_digest_mismatch",
  "outcome_set_malformed",
  "unknown_outcome",
  "outcome_join_mismatch",
] as const;

export type WavePlanDagV2RejectionReason = (typeof WAVE_PLAN_DAG_V2_REJECTION_REASONS)[number];

/**
 * Internal control-flow vehicle shared with the checker port. Public callers
 * only ever see {@link WavePlanDagV2Rejection} data; this class never escapes
 * the module's exported entry points.
 */
export class WavePlanDagV2ContractError extends Error {
  readonly reason: WavePlanDagV2RejectionReason;

  constructor(reason: WavePlanDagV2RejectionReason, message: string) {
    super(message);
    this.name = "WavePlanDagV2ContractError";
    this.reason = reason;
  }
}

export function reject(reason: WavePlanDagV2RejectionReason, message: string): never {
  throw new WavePlanDagV2ContractError(reason, message);
}

/** A rejection carries exactly the stable reason plus a human-readable note. */
export interface WavePlanDagV2Rejection {
  ok: false;
  reason: WavePlanDagV2RejectionReason;
  message: string;
}

export function wavePlanDagV2Rejection(reason: WavePlanDagV2RejectionReason, message: string): WavePlanDagV2Rejection {
  return { ok: false, reason, message };
}
