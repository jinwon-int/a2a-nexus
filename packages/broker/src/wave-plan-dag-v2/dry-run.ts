/**
 * Deterministic `WavePlanDagDryRunReceiptV2` production (spec §5, #1800
 * slice 1).
 *
 * Dry-run is a pure, read-only function of an admitted manifest plus a closed
 * outcome snapshot. Stages are visited in the manifest's canonical topological
 * order; partial outcome snapshots fail closed to `waiting`, never to
 * inferred readiness, and join failures fail closed to `not_selected`.
 * Neither state authorizes action — the receipt re-pins the full no-authority
 * boundary (`mode=read_only_rehearsal`, every authority `none`).
 *
 * Ported 1:1 from the signal rules in
 * `test/conformance/check-wave-plan-dag-v2.mjs`; the fixture's two receipt
 * vectors and their pinned digests cross-validate this walker byte-for-byte.
 */
import {
  WAVE_PLAN_DAG_V2_RECEIPT_DIGEST_DOMAIN,
  compareAscii,
  framedWavePlanDagV2Digest,
} from "./digest.js";
// spec §5 closed stage signal — only these state/reason pairs are legal
import { reject, wavePlanDagV2Rejection, type WavePlanDagV2Rejection } from "./errors.js";
import {
  type ValidatedWavePlanDagGraphV2,
  type WavePlanDagEdgePredicateV2,
  type WavePlanDagManifestAdmissionV2,
  type WavePlanDagManifestV2,
} from "./manifest.js";

const PLAN_ALIAS_PATTERN = /^wpm_[0-9a-f]{16}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const STAGE_ID_PATTERN = /^stg_[0-9a-f]{8}$/;

const REQUEST_FIELDS = ["kind", "manifestAlias", "manifestDigest", "outcomes", "version"] as const;
const OUTCOME_FIELDS = ["kind", "outcome", "stageId", "version"] as const;

export type WavePlanDagStageStateV2 = "ready" | "waiting" | "not_selected" | "terminal";

export type WavePlanDagStageReasonV2 =
  | "root_stage"
  | "all_matching_satisfied"
  | "any_matching_satisfied"
  | "join_unresolved"
  | "no_matching_edge"
  | "all_matching_unsatisfied"
  | "gate_passed"
  | "gate_failed";

export interface WavePlanDagStageOutcomeV2 {
  kind: "WavePlanDagStageOutcomeV2";
  version: 2;
  stageId: string;
  outcome: "gate_passed" | "gate_failed";
}

export interface WavePlanDagDryRunRequestV2 {
  kind: "WavePlanDagDryRunRequestV2";
  version: 2;
  manifestAlias: string;
  manifestDigest: string;
  outcomes: WavePlanDagStageOutcomeV2[];
}

/** Spec §5 closed stage signal. Only these state/reason pairs are legal. */
export interface WavePlanDagStageSignalV2 {
  stageId: string;
  state: WavePlanDagStageStateV2;
  reason: WavePlanDagStageReasonV2;
}

export interface WavePlanDagDryRunReceiptV2 {
  kind: "WavePlanDagDryRunReceiptV2";
  version: 2;
  manifestAlias: string;
  manifestDigest: string;
  mode: "read_only_rehearsal";
  topologicalOrder: readonly string[];
  stages: WavePlanDagStageSignalV2[];
  autoDispatch: false;
  operatorAdvanceRequired: true;
  dryRunRequired: true;
  claimAuthority: "none";
  executionAuthority: "none";
  retryAuthority: "none";
  finalizerAuthority: "none";
  successAuthority: "none";
  liveAuthority: "none";
  receiptDigestDomain: typeof WAVE_PLAN_DAG_V2_RECEIPT_DIGEST_DOMAIN;
  receiptDigest: string;
}

type SignalMap = Map<string, { state: string; reason?: string }>;

function edgeMatches(edge: { when: WavePlanDagEdgePredicateV2 }, sourceReason?: string): boolean {
  return edge.when === "any_terminal" || edge.when === sourceReason;
}

/**
 * Joins rule for one non-root stage given its already-computed upstream
 * signals (§5 steps 2–4). Exported for conformance parity tests.
 */
export function baseWavePlanDagStageSignal(
  stageId: string,
  graph: ValidatedWavePlanDagGraphV2,
  signals: SignalMap,
): { state: WavePlanDagStageStateV2; reason: WavePlanDagStageReasonV2 } {
  if (stageId === graph.root) {
    return { state: "ready", reason: "root_stage" };
  }

  const incoming = graph.incoming.get(stageId) ?? [];
  let matching = 0;
  let unresolved = 0;
  for (const edge of incoming) {
    const source = signals.get(edge.fromStageId);
    if (!source) continue;
    if (source.state === "terminal") {
      if (edgeMatches(edge, source.reason)) matching += 1;
    } else if (source.state !== "not_selected") {
      // ready/waiting upstream facts are unresolved: partial snapshots stay waiting.
      unresolved += 1;
    }
  }

  const policy = graph.stagesById.get(stageId)?.joinPolicy;
  if (policy === "any_matching" && matching > 0) {
    return { state: "ready", reason: "any_matching_satisfied" };
  }
  if (unresolved > 0) {
    return { state: "waiting", reason: "join_unresolved" };
  }
  if (policy === "all_matching") {
    return matching === incoming.length
      ? { state: "ready", reason: "all_matching_satisfied" }
      : { state: "not_selected", reason: "all_matching_unsatisfied" };
  }
  // any_matching fully resolved with zero matches; root never reaches here.
  return { state: "not_selected", reason: "no_matching_edge" };
}

function assertClosedRecord(value: unknown, expectedFields: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    reject("outcome_set_malformed", `${label} must be an object`);
  }
  const actual = Object.keys(value).sort(compareAscii);
  const expected = [...expectedFields].sort(compareAscii);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    reject("outcome_set_malformed", `${label} fields differ: ${JSON.stringify(actual)}`);
  }
}

function assertPatternField(value: unknown, pattern: RegExp, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[\x20-\x7e]+$/.test(value)) {
    reject("outcome_set_malformed", `${label} must be non-empty printable ASCII`);
  }
  if (!pattern.test(value)) reject("outcome_set_malformed", `${label} has invalid form`);
}

/** Validates the closed dry-run request against the admitted manifest (§5). */
function validateRequestOrThrow(
  rawRequest: unknown,
  manifest: WavePlanDagManifestV2,
  graph: ValidatedWavePlanDagGraphV2,
): Map<string, WavePlanDagStageOutcomeV2["outcome"]> {
  assertClosedRecord(rawRequest, REQUEST_FIELDS, "WavePlanDagDryRunRequestV2");
  const request = rawRequest as unknown as WavePlanDagDryRunRequestV2;
  if (request.kind !== "WavePlanDagDryRunRequestV2" || request.version !== 2) {
    reject("outcome_set_malformed", "dry-run request kind/version mismatch");
  }
  assertPatternField(request.manifestAlias, PLAN_ALIAS_PATTERN, "request manifestAlias");
  assertPatternField(request.manifestDigest, DIGEST_PATTERN, "request manifestDigest");
  if (request.manifestAlias !== manifest.manifestAlias || request.manifestDigest !== manifest.manifestDigest) {
    reject("manifest_digest_mismatch", "dry-run request does not bind exact manifest");
  }
  if (!Array.isArray(request.outcomes) || request.outcomes.length > 32) {
    reject("outcome_set_malformed", "outcome count outside 0..32");
  }

  const outcomes = new Map<string, WavePlanDagStageOutcomeV2["outcome"]>();
  for (const rawOutcome of request.outcomes as unknown[]) {
    assertClosedRecord(rawOutcome, OUTCOME_FIELDS, "WavePlanDagStageOutcomeV2");
    const outcome = rawOutcome as unknown as WavePlanDagStageOutcomeV2;
    if (outcome.kind !== "WavePlanDagStageOutcomeV2" || outcome.version !== 2) {
      reject("outcome_set_malformed", "stage outcome kind/version mismatch");
    }
    assertPatternField(outcome.stageId, STAGE_ID_PATTERN, "outcome stageId");
    if (!graph.stagesById.has(outcome.stageId)) {
      reject("outcome_set_malformed", "outcome references unknown stage");
    }
    if (outcome.outcome !== "gate_passed" && outcome.outcome !== "gate_failed") {
      reject("unknown_outcome", "unknown stage gate outcome");
    }
    if (outcomes.has(outcome.stageId)) {
      reject("outcome_set_malformed", "duplicate stage outcome");
    }
    outcomes.set(outcome.stageId, outcome.outcome);
  }
  return outcomes;
}

/** Throws on violations; see module doc. Builds the signed-boundary receipt. */
function buildReceiptOrThrow(
  manifest: WavePlanDagManifestV2,
  graph: ValidatedWavePlanDagGraphV2,
  rawRequest: unknown,
): WavePlanDagDryRunReceiptV2 {
  const outcomes = validateRequestOrThrow(rawRequest, manifest, graph);
  const signals: SignalMap = new Map();

  for (const stageId of graph.topology) {
    const base = baseWavePlanDagStageSignal(stageId, graph, signals);
    let signal: { state: string; reason: string } = base;
    const admittedOutcome = outcomes.get(stageId);
    if (admittedOutcome !== undefined) {
      if (base.state !== "ready") {
        reject("outcome_join_mismatch", `outcome supplied for ${stageId} while ${base.state}`);
      }
      signal = { state: "terminal", reason: admittedOutcome };
    }
    signals.set(stageId, signal);
  }

  const receipt: Omit<WavePlanDagDryRunReceiptV2, "receiptDigest"> = {
    kind: "WavePlanDagDryRunReceiptV2",
    version: 2,
    manifestAlias: manifest.manifestAlias,
    manifestDigest: manifest.manifestDigest,
    mode: "read_only_rehearsal",
    topologicalOrder: [...graph.topology],
    stages: graph.topology.map((stageId) => {
      const signal = signals.get(stageId) as { state: string; reason: string };
      return { stageId, state: signal.state as WavePlanDagStageStateV2, reason: signal.reason as WavePlanDagStageReasonV2 };
    }),
    autoDispatch: false,
    operatorAdvanceRequired: true,
    dryRunRequired: true,
    claimAuthority: "none",
    executionAuthority: "none",
    retryAuthority: "none",
    finalizerAuthority: "none",
    successAuthority: "none",
    liveAuthority: "none",
    receiptDigestDomain: WAVE_PLAN_DAG_V2_RECEIPT_DIGEST_DOMAIN,
  };

  const { receiptDigest: _excluded, ...payloadForDigest } = receipt as unknown as Record<string, unknown>;
  return {
    ...receipt,
    receiptDigest: framedWavePlanDagV2Digest(WAVE_PLAN_DAG_V2_RECEIPT_DIGEST_DOMAIN, payloadForDigest as never),
  };
}

export interface WavePlanDagDryRunOkV2 {
  ok: true;
  receipt: WavePlanDagDryRunReceiptV2;
}
export type WavePlanDagDryRunResultV2 = WavePlanDagDryRunOkV2 | WavePlanDagV2Rejection;

/**
 * Runs the read-only rehearsal. When admission failed, its rejection is
 * passed through unchanged so dispatchers can branch on a single result.
 */
export function runWavePlanDagDryRunV2(
  admission: WavePlanDagManifestAdmissionV2,
  rawRequest: unknown,
): WavePlanDagDryRunResultV2 {
  if (!admission.ok) {
    return wavePlanDagV2Rejection(admission.reason, admission.message);
  }
  try {
    return { ok: true, receipt: buildReceiptOrThrow(admission.manifest, admission.graph, rawRequest) };
  } catch (error) {
    if (error instanceof Error && "reason" in error) {
      const reason = (error as { reason?: string }).reason;
      if (typeof reason === "string") {
        return wavePlanDagV2Rejection(reason as Parameters<typeof wavePlanDagV2Rejection>[0], error.message);
      }
    }
    throw error;
  }
}
