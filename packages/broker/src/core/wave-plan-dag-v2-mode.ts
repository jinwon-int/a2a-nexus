/**
 * WavePlanDagV2 rollout-mode resolution (#1800 slice 5).
 *
 * Same posture as `resolveReviewLineageRolloutMode`: empty/unset is the safe
 * default (`off`), the only other value is observational (`record`), and any
 * other value fails loudly at startup rather than being silently coerced.
 */

export type WavePlanDagV2RolloutMode = "off" | "record";

export function resolveWavePlanDagV2Mode(raw: string | undefined): WavePlanDagV2RolloutMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "off") return "off";
  if (value === "record") return "record";
  throw new Error(
    `invalid A2A_WAVE_PLAN_DAG_V2_MODE='${raw}' (expected off | record)`,
  );
}
