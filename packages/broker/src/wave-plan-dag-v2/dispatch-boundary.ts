/**
 * Versioned dispatch-boundary classifier for wave-plan intakes (#1800
 * slice 3 — issue item "v1/v2 versioned dispatch 경계").
 *
 * Wave-plan v1 stays linear, live, and untouched (spec §1): this module does
 * not validate, route, store, or dispatch anything. It defines the single
 * boundary a future dispatcher integration must pass through BEFORE any v1
 * surface sees a payload: it answers exactly one closed question — *which
 * version owns this intake payload?* — plus, for V2 payloads only, whether
 * the proposal is a rehearsal candidate.
 *
 * The non-interference rule is structural:
 *
 * - A payload that is not a `kind: "WavePlanDagManifestV2"` object is
 *   **passed through unexamined** (`routesTo: "v1_wave_plan_spec"`). The
 *   classifier reads nothing beyond `kind`, throws on nothing (even
 *   `null`/strings classify as v1-surface — shape policing belongs to the
 *   existing fail-closed `validateWavePlanSpec`), and returns no derived
 *   facts about the payload.
 * - A `WavePlanDagManifestV2` payload goes through slice-1 admission; passing
 *   yields `rehearsal_candidate` with the admission graph's canonical facts,
 *   failing yields `rejected_v2` with the exact stable §5 reason.
 *
 * Classification is never authority (spec §1): the returned record carries
 * no action field of any kind. There is deliberately no `dispatch`,
 * `advance`, `claim` bucket — adding one means changing this closed union,
 * which makes the boundary reviewable.
 */

import { runWavePlanDagDryRunV2 } from "./dry-run.js";
import {
  admitWavePlanDagManifestV2,
} from "./manifest.js";
import type { WavePlanDagV2RejectionReason } from "./errors.js";

export const WAVE_PLAN_DAG_V2_INTAKE_RECORD_KIND = "WavePlanDagV2IntakeRecordV1" as const;

/** Closed routing verdicts. No acting bucket exists by design. */
export type WavePlanDagIntakeRouting =
  /** Not ours: forward to the unchanged v1 wave-plan surface, untouched. */
  | "v1_wave_plan_spec"
  /** V2 proposal admitted: rehearsal candidate only — still no authority. */
  | "v2_rehearsal_candidate"
  /** V2 proposal rejected for the pinned §5 reason: no receipt, no authority. */
  | "v2_rejected";

/**
 * Every fact permitted on an intake record, bounded:
 * - `stageCount`: clamped at the spec cap so oversized garbage cannot blow up
 *   the record (admission rejects >32 anyway);
 * - digests appear only after full validation bound them;
 * - rejection reasons are the closed §5 enum, never free text.
 */
export type WavePlanDagV2IntakeRecordV1 =
  | {
      kind: typeof WAVE_PLAN_DAG_V2_INTAKE_RECORD_KIND;
      version: 1;
      routesTo: "v1_wave_plan_spec";
      /** The only field read from a v1 payload. */
      observedKind: string | null;
    }
  | {
      kind: typeof WAVE_PLAN_DAG_V2_INTAKE_RECORD_KIND;
      version: 1;
      routesTo: "v2_rehearsal_candidate";
      manifestAlias: string;
      manifestDigest: string;
      stageCount: number;
      dryRunIssued: boolean;
    }
  | {
      kind: typeof WAVE_PLAN_DAG_V2_INTAKE_RECORD_KIND;
      version: 1;
      routesTo: "v2_rehearsal_candidate";
      manifestAlias: string;
      manifestDigest: string;
      stageCount: number;
      /** Request supplied but rehearsal rejected: reason carried for operators. */
      dryRunIssued: false;
      dryRunRejectionReason: WavePlanDagV2RejectionReason;
    }
  | {
      kind: typeof WAVE_PLAN_DAG_V2_INTAKE_RECORD_KIND;
      version: 1;
      routesTo: "v2_rejected";
      rejectionReason: WavePlanDagV2RejectionReason;
    };

const MAX_STAGES = 32;

function looksLikeV2Manifest(payload: unknown): boolean {
  return (
    payload !== null
    && typeof payload === "object"
    && !Array.isArray(payload)
    && (payload as { kind?: unknown }).kind === "WavePlanDagManifestV2"
  );
}

/**
 * Classifies one raw intake payload behind the version boundary. Pure,
 * total (never throws), and side-effect free; identical inputs produce
 * identical records.
 */
export function classifyWavePlanIntake(
  rawPayload: unknown,
  rawRequest?: unknown,
): WavePlanDagV2IntakeRecordV1 {
  if (!looksLikeV2Manifest(rawPayload)) {
    const observedKind =
      rawPayload !== null && typeof rawPayload === "object" && !Array.isArray(rawPayload)
        ? typeof (rawPayload as { kind?: unknown }).kind === "string"
          ? ((rawPayload as { kind: string }).kind)
          : null
        : null;
    return { kind: WAVE_PLAN_DAG_V2_INTAKE_RECORD_KIND, version: 1, routesTo: "v1_wave_plan_spec", observedKind };
  }

  // Snapshot before validation so caller-side mutation after classification
  // cannot alter an already-built record (same isolation rule as observe.ts).
  const proposal = structuredClone(rawPayload);
  const admission = admitWavePlanDagManifestV2(proposal);
  if (!admission.ok) {
    return {
      kind: WAVE_PLAN_DAG_V2_INTAKE_RECORD_KIND,
      version: 1,
      routesTo: "v2_rejected",
      rejectionReason: admission.reason,
    };
  }

  const manifestAlias = admission.manifest.manifestAlias;
  const manifestDigest = admission.manifest.manifestDigest;
  const stageCount = Math.min(admission.manifest.stages.length, MAX_STAGES);

  if (rawRequest === undefined) {
    return {
      kind: WAVE_PLAN_DAG_V2_INTAKE_RECORD_KIND,
      version: 1,
      routesTo: "v2_rehearsal_candidate",
      manifestAlias,
      manifestDigest,
      stageCount,
      dryRunIssued: false,
    };
  }

  const result = runWavePlanDagDryRunV2(admission, structuredClone(rawRequest));
  if (!result.ok) {
    return {
      kind: WAVE_PLAN_DAG_V2_INTAKE_RECORD_KIND,
      version: 1,
      routesTo: "v2_rehearsal_candidate",
      manifestAlias,
      manifestDigest,
      stageCount,
      dryRunIssued: false,
      dryRunRejectionReason: result.reason,
    };
  }
  return {
    kind: WAVE_PLAN_DAG_V2_INTAKE_RECORD_KIND,
    version: 1,
    routesTo: "v2_rehearsal_candidate",
    manifestAlias,
    manifestDigest,
    stageCount,
    dryRunIssued: true,
  };
}
