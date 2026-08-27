/**
 * Record-only observation surface for WavePlanDagV2 (#1800 slice 2, item 6).
 *
 * The issue line is "default-off/record-only 관측 모드와 bounded
 * public/operator diagnostics". This module implements exactly that and
 * deliberately nothing more:
 *
 * - **Off by default.** {@link observeWavePlanDagV2Public} takes an explicit
 *   mode. `off` yields `{observed:false}` and nothing else — even for a valid,
 *   rehearsable proposal. There is no module-level flag anywhere;
 *   observability must be opted in at every call site. Rolling back a future
 *   live wiring is a single value flip back to `off` at the caller boundary
 *   (no code change), which is the documentation the issue's acceptance
 *   criterion ("단일 플래그 rollback") asks for at this layer.
 * - **No acting variant.** The mode union is closed at `off | record_only`.
 *   An `enforce`-like member would turn observation into authority; spec §1
 *   forbids that ("a rejection grants no authority"). Keeping the union closed
 *   here means such a member cannot be added silently.
 * - **Pure and side-effect free.** Inputs are deep-cloned before validation,
 *   so mutating a proposal after observing it cannot alter an already-built
 *   observation, and observing never mutates its inputs. Replay determinism
 *   follows from slice 1's pure functions: identical inputs produce identical
 *   observations.
 * - **Bounded projections.** Public observations carry only booleans, closed
 *   §5 rejection-reason enums, and clamped counts (cap 64 with per-field
 *   collapse flags) — malformed proposals may arrive carrying arbitrarily
 *   large arrays and the projection must stay bounded regardless. No task ids,
 *   no free-form strings. Operator observations additionally carry the
 *   human-readable note (truncated to
 *   {@link WAVE_PLAN_DAG_V2_OBSERVATION_MAX_MESSAGE_CHARS}) and, when
 *   admitted, digests and the topological order — the same public vs operator
 *   split #1799 slice 2 established for attempt views.
 */

import {
  runWavePlanDagDryRunV2,
} from "./dry-run.js";
import {
  admitWavePlanDagManifestV2,
  type WavePlanDagManifestAdmissionFailedV2,
  type WavePlanDagManifestAdmissionOkV2,
} from "./manifest.js";
import type { WavePlanDagV2RejectionReason } from "./errors.js";

/** Observation modes. Closed: no acting/enforcing member will ever exist here. */
export type WavePlanDagV2ObservationMode = "off" | "record_only";

/** Default everywhere until a future operator wiring opts in explicitly. */
export const WAVE_PLAN_DAG_V2_DEFAULT_OBSERVATION_MODE: WavePlanDagV2ObservationMode = "off";

/** Counts above this are collapsed to the cap with `<field>CollapsedAtCap`. */
export const WAVE_PLAN_DAG_V2_OBSERVATION_COUNT_CAP = 64;
/** Operator message length cap; longer text truncates (deterministically). */
export const WAVE_PLAN_DAG_V2_OBSERVATION_MAX_MESSAGE_CHARS = 240;

export const WAVE_PLAN_DAG_V2_PUBLIC_OBSERVATION_KIND = "WavePlanDagV2PublicObservation" as const;
export const WAVE_PLAN_DAG_V2_OPERATOR_OBSERVATION_KIND = "WavePlanDagV2OperatorObservation" as const;

interface BoundedCounts {
  stageCount: number;
  edgeCount: number;
  stageCountCollapsedAtCap: boolean;
  edgeCountCollapsedAtCap: boolean;
}

function boundedCounts(value: unknown): BoundedCounts {
  const candidate = value as { stages?: unknown; edges?: unknown } | null;
  const stages = Array.isArray(candidate?.stages) ? candidate.stages.length : 0;
  const edges = Array.isArray(candidate?.edges) ? candidate.edges.length : 0;
  return {
    stageCount: Math.min(stages, WAVE_PLAN_DAG_V2_OBSERVATION_COUNT_CAP),
    edgeCount: Math.min(edges, WAVE_PLAN_DAG_V2_OBSERVATION_COUNT_CAP),
    stageCountCollapsedAtCap: stages > WAVE_PLAN_DAG_V2_OBSERVATION_COUNT_CAP,
    edgeCountCollapsedAtCap: edges > WAVE_PLAN_DAG_V2_OBSERVATION_COUNT_CAP,
  };
}

function snapshot(value: unknown): unknown {
  return value === null || typeof value !== "object" ? value : structuredClone(value);
}

/** Public-safe observation. Closed fields only; safe to project anywhere. */
export type WavePlanDagV2PublicObservation =
  | {
      kind: typeof WAVE_PLAN_DAG_V2_PUBLIC_OBSERVATION_KIND;
      version: 2;
      observed: false;
    }
  | {
      kind: typeof WAVE_PLAN_DAG_V2_PUBLIC_OBSERVATION_KIND;
      version: 2;
      observed: true;
      proposalAdmitted: false;
      /** Closed §5 reason — never a free-form message at this boundary. */
      rejectionReason: WavePlanDagV2RejectionReason;
      /** Admission failed before any request could be examined. */
      requestExamined: false;
    } & BoundedCounts
  | ({
      kind: typeof WAVE_PLAN_DAG_V2_PUBLIC_OBSERVATION_KIND;
      version: 2;
      observed: true;
      proposalAdmitted: true;
      requestExamined: boolean;
    } & BoundedCounts
      & ({ dryRunIssued: true; topologyLength: number }
        | { dryRunIssued: false; dryRunRejectionReason?: WavePlanDagV2RejectionReason }));

/** Operator-scoped observation: adds diagnostics that are not audience-neutral. */
export type WavePlanDagV2OperatorObservation =
  | {
      kind: typeof WAVE_PLAN_DAG_V2_OPERATOR_OBSERVATION_KIND;
      version: 2;
      observed: false;
    }
  | ({
      kind: typeof WAVE_PLAN_DAG_V2_OPERATOR_OBSERVATION_KIND;
      version: 2;
      observed: true;
      proposalAdmitted: false;
      rejectionReason: WavePlanDagV2RejectionReason;
      requestExamined: false;
      /** Bounded human-readable note for the rejection. */
      message: string;
    } & BoundedCounts)
  | ({
      kind: typeof WAVE_PLAN_DAG_V2_OPERATOR_OBSERVATION_KIND;
      version: 2;
      observed: true;
      proposalAdmitted: true;
      /** Manifest digest — present only for admitted proposals. */
      manifestDigest: string;
      /** Canonical topological order — present only for admitted proposals. */
      topologicalOrder: string[];
      /** Present only when an admitted rehearsal succeeded. */
      receiptDigest?: string;
      /** Bounded human-readable note; absent when there is nothing to say. */
      message?: string;
      requestExamined: boolean;
    } & BoundedCounts
      & ({ dryRunIssued: true; topologyLength: number }
        | { dryRunIssued: false; dryRunRejectionReason?: WavePlanDagV2RejectionReason }));

function truncateMessage(message: string): string {
  return message.length <= WAVE_PLAN_DAG_V2_OBSERVATION_MAX_MESSAGE_CHARS
    ? message
    : `${message.slice(0, WAVE_PLAN_DAG_V2_OBSERVATION_MAX_MESSAGE_CHARS)}…`;
}

/**
 * Single shared computation so public and operator projections can never
 * disagree about what happened (one admission, one dry-run per observation).
 */
type ObservedOutcome =
  | { observed: false }
  | {
      observed: true;
      proposalAdmitted: true;
      admission: WavePlanDagManifestAdmissionOkV2;
      counts: BoundedCounts;
      requestExamined: boolean;
      dryRun?: { ok: true; receiptDigest: string; topologyLength: number }
        | { ok: false; reason: WavePlanDagV2RejectionReason };
    }
  | {
      observed: true;
      proposalAdmitted: false;
      rejection: WavePlanDagManifestAdmissionFailedV2;
      counts: BoundedCounts;
    };

function computeObservation(
  mode: WavePlanDagV2ObservationMode,
  rawProposal: unknown,
  rawRequest: unknown,
): ObservedOutcome {
  if (mode === "off") return { observed: false };

  const proposal = snapshot(rawProposal);
  const admission = admitWavePlanDagManifestV2(proposal);
  if (!admission.ok) {
    return { observed: true, proposalAdmitted: false, rejection: admission, counts: boundedCounts(proposal) };
  }

  const counts = boundedCounts(proposal);
  if (rawRequest === undefined) {
    return { observed: true, proposalAdmitted: true, admission, counts, requestExamined: false };
  }

  const dryRunResult = runWavePlanDagDryRunV2(admission, snapshot(rawRequest));
  return {
    observed: true,
    proposalAdmitted: true,
    admission,
    counts,
    requestExamined: true,
    dryRun: dryRunResult.ok
      ? { ok: true, receiptDigest: dryRunResult.receipt.receiptDigest, topologyLength: dryRunResult.receipt.topologicalOrder.length }
      : { ok: false, reason: dryRunResult.reason },
  };
}

export function observeWavePlanDagV2Public(
  mode: WavePlanDagV2ObservationMode,
  rawProposal: unknown,
  rawRequest?: unknown,
): WavePlanDagV2PublicObservation {
  const outcome = computeObservation(mode, rawProposal, rawRequest);
  if (!outcome.observed) {
    return { kind: WAVE_PLAN_DAG_V2_PUBLIC_OBSERVATION_KIND, version: 2, observed: false };
  }
  if (!outcome.proposalAdmitted) {
    return {
      kind: WAVE_PLAN_DAG_V2_PUBLIC_OBSERVATION_KIND,
      version: 2,
      observed: true,
      proposalAdmitted: false,
      rejectionReason: outcome.rejection.reason,
      requestExamined: false,
      ...outcome.counts,
    };
  }

  const base = {
    kind: WAVE_PLAN_DAG_V2_PUBLIC_OBSERVATION_KIND,
    version: 2 as const,
    observed: true as const,
    proposalAdmitted: true as const,
    ...outcome.counts,
    requestExamined: outcome.requestExamined,
  };
  if (outcome.dryRun === undefined) {
    return { ...base, dryRunIssued: false };
  }
  if (outcome.dryRun.ok) {
    return { ...base, dryRunIssued: true, topologyLength: outcome.dryRun.topologyLength };
  }
  return { ...base, dryRunIssued: false, dryRunRejectionReason: outcome.dryRun.reason };
}

export function observeWavePlanDagV2Operator(
  mode: WavePlanDagV2ObservationMode,
  rawProposal: unknown,
  rawRequest?: unknown,
): WavePlanDagV2OperatorObservation {
  const outcome = computeObservation(mode, rawProposal, rawRequest);
  if (!outcome.observed) {
    return { kind: WAVE_PLAN_DAG_V2_OPERATOR_OBSERVATION_KIND, version: 2, observed: false };
  }
  if (!outcome.proposalAdmitted) {
    return {
      kind: WAVE_PLAN_DAG_V2_OPERATOR_OBSERVATION_KIND,
      version: 2,
      observed: true,
      proposalAdmitted: false,
      rejectionReason: outcome.rejection.reason,
      requestExamined: false,
      ...outcome.counts,
      message: truncateMessage(outcome.rejection.message),
    };
  }

  const base = {
    kind: WAVE_PLAN_DAG_V2_OPERATOR_OBSERVATION_KIND,
    version: 2 as const,
    observed: true as const,
    proposalAdmitted: true as const,
    ...outcome.counts,
    requestExamined: outcome.requestExamined,
    manifestDigest: outcome.admission.manifest.manifestDigest,
    // Kahn order from slice 1's admission — already canonical; do not re-sort.
    topologicalOrder: [...outcome.admission.graph.topology],
  };

  if (outcome.dryRun === undefined) {
    return { ...base, dryRunIssued: false };
  }
  if (outcome.dryRun.ok) {
    return {
      ...base,
      dryRunIssued: true,
      topologyLength: outcome.dryRun.topologyLength,
      receiptDigest: outcome.dryRun.receiptDigest,
    };
  }
  return {
    ...base,
    dryRunIssued: false,
    dryRunRejectionReason: outcome.dryRun.reason,
    message: truncateMessage(`dry-run rejected: ${outcome.dryRun.reason}`),
  };
}
