/**
 * `WavePlanDagManifestV2` admission: closed-schema parsing, graph invariants,
 * and the exact manifest digest (spec §2–§4 and §6, #1800 slice 1).
 *
 * This is a pure read-only **admission** surface. It grants no execution,
 * claim, retry, finalizer, success, or live authority (spec §1): an admitted
 * manifest is only a rehearsal candidate. Wave-plan v1 remains linear, live,
 * and untouched — v2 is not a conversion path for v1.
 *
 * Validation order is a deliberate port of
 * `test/conformance/check-wave-plan-dag-v2.mjs` so that every mutated input
 * falls out with the same stable reason in both implementations; the golden
 * fixture pins one digest byte-for-byte (`fixtures/contract/wave-plan-dag-v2.json`).
 */
import {
  compareAscii,
  canonicalizeWavePlanDagV2Json,
  framedWavePlanDagV2Digest,
  WAVE_PLAN_DAG_V2_MANIFEST_DIGEST_DOMAIN,
  type WavePlanDagV2CanonicalValue,
} from "./digest.js";
import { reject, wavePlanDagV2Rejection, type WavePlanDagV2Rejection } from "./errors.js";

/** Spec §3: fixed limits. Not configurable anywhere in the contract. */
export const WAVE_PLAN_DAG_V2_LIMITS = Object.freeze({
  maxStages: 32,
  maxEdges: 64,
  maxDepth: 8,
  maxFanIn: 8,
  maxFanOut: 8,
});

const PLAN_ALIAS_PATTERN = /^wpm_[0-9a-f]{16}$/;
const STAGE_ID_PATTERN = /^stg_[0-9a-f]{8}$/;
const STAGE_MANIFEST_ALIAS_PATTERN = /^mft_[0-9a-f]{16}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

const MANIFEST_FIELDS = [
  "autoDispatch",
  "claimAuthority",
  "dryRunRequired",
  "edges",
  "executionAuthority",
  "finalizerAuthority",
  "kind",
  "limits",
  "liveAuthority",
  "manifestAlias",
  "manifestDigest",
  "manifestDigestDomain",
  "operatorAdvanceRequired",
  "proposalSource",
  "retryAuthority",
  "stages",
  "successAuthority",
  "version",
] as const;

const STAGE_FIELDS = ["joinPolicy", "manifestAlias", "reviewedManifestDigest", "stageId"] as const;

/** Authority fields, all of which must stay exactly `"none"` (spec §3). */
export const WAVE_PLAN_DAG_V2_AUTHORITY_FIELDS = [
  "claimAuthority",
  "executionAuthority",
  "finalizerAuthority",
  "liveAuthority",
  "retryAuthority",
  "successAuthority",
] as const;

export type WavePlanDagProposalSourceV2 = "model" | "operator";
export type WavePlanDagJoinPolicyV2 = "root" | "all_matching" | "any_matching";
export type WavePlanDagEdgePredicateV2 = "gate_passed" | "gate_failed" | "any_terminal";

/** Spec §3 stage entry. Caller-selected strings are limited to closed alias forms. */
export interface WavePlanDagStageV2 {
  stageId: string;
  manifestAlias: string;
  reviewedManifestDigest: string;
  joinPolicy: WavePlanDagJoinPolicyV2;
}

/** Spec §3 edge entry. `when` is the entire conditional vocabulary — no expressions. */
export interface WavePlanDagEdgeV2 {
  fromStageId: string;
  toStageId: string;
  when: WavePlanDagEdgePredicateV2;
}

/** The frozen limits block, typed at its literal values. */
export interface WavePlanDagLimitsV2 {
  readonly maxStages: 32;
  readonly maxEdges: 64;
  readonly maxDepth: 8;
  readonly maxFanIn: 8;
  readonly maxFanOut: 8;
}

/** Spec §3 closed manifest shape. An unlisted field is malformed. */
export interface WavePlanDagManifestV2 {
  kind: "WavePlanDagManifestV2";
  version: 2;
  proposalSource: WavePlanDagProposalSourceV2;
  manifestAlias: string;
  stages: WavePlanDagStageV2[];
  edges: WavePlanDagEdgeV2[];
  limits: WavePlanDagLimitsV2;
  autoDispatch: false;
  operatorAdvanceRequired: true;
  dryRunRequired: true;
  claimAuthority: "none";
  executionAuthority: "none";
  retryAuthority: "none";
  finalizerAuthority: "none";
  successAuthority: "none";
  liveAuthority: "none";
  manifestDigestDomain: typeof WAVE_PLAN_DAG_V2_MANIFEST_DIGEST_DOMAIN;
  manifestDigest: string;
}

/** Structural result of successful admission, reused by the dry-run walker. */
export interface ValidatedWavePlanDagGraphV2 {
  root: string;
  stagesById: ReadonlyMap<string, WavePlanDagStageV2>;
  incoming: ReadonlyMap<string, readonly WavePlanDagEdgeV2[]>;
  outgoing: ReadonlyMap<string, readonly WavePlanDagEdgeV2[]>;
  /** Kahn order; ties broken by lexicographically smallest ASCII `stageId` (§4). */
  topology: readonly string[];
  /** Longest root-to-stage path length per stage (edges), capped at maxDepth. */
  depthByStage: ReadonlyMap<string, number>;
}

function assertClosedRecord(
  value: unknown,
  expectedFields: readonly string[],
  label: string,
  reason: Parameters<typeof reject>[0] = "manifest_malformed",
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    reject(reason, `${label} must be an object`);
  }
  const actual = Object.keys(value).sort(compareAscii);
  const expected = [...expectedFields].sort(compareAscii);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    reject(reason, `${label} fields differ: ${JSON.stringify(actual)}`);
  }
}

function assertPattern(
  value: unknown,
  pattern: RegExp,
  label: string,
  reason: Parameters<typeof reject>[0] = "manifest_malformed",
): asserts value is string {
  if (typeof value !== "string" || !/^[\x20-\x7e]+$/.test(value)) {
    reject(reason, `${label} must be non-empty printable ASCII`);
  }
  if (!pattern.test(value)) reject(reason, `${label} has invalid form`);
}

/**
 * Recomputes the §6 manifest digest: exclude only `manifestDigest`, sort
 * stages by ASCII `stageId`, sort edges by the ASCII tuple
 * `(fromStageId,toStageId,when)` — making the digest independent of input
 * array order while binding every declarative field.
 *
 * Exported for deterministic test/tooling reuse: callers building synthetic
 * manifests must set `manifestDigest` to this output before admission.
 */
export function computeWavePlanDagManifestV2Digest(manifest: WavePlanDagManifestV2): string {
  const { manifestDigest: _excluded, ...payload } = manifest as unknown as Record<string, unknown>;
  const { stages, edges } = payload as Pick<WavePlanDagManifestV2, "stages" | "edges">;
  const sortedPayload = {
    ...payload,
    stages: [...stages].sort((left, right) => compareAscii(left.stageId, right.stageId)),
    edges: [...edges].sort((left, right) => compareAscii(edgeTuple(left), edgeTuple(right))),
  };
  return framedWavePlanDagV2Digest(
    WAVE_PLAN_DAG_V2_MANIFEST_DIGEST_DOMAIN,
    sortedPayload as unknown as WavePlanDagV2CanonicalValue,
  );
}

function edgeTuple(edge: WavePlanDagEdgeV2): string {
  return `${edge.fromStageId}\0${edge.toStageId}\0${edge.when}`;
}

function assertAuthorityBoundary(value: Record<string, unknown>, label: string): void {
  if (value.autoDispatch !== false || value.operatorAdvanceRequired !== true || value.dryRunRequired !== true) {
    reject("manifest_malformed", `${label} dispatch/dry-run boundary changed`);
  }
  for (const field of WAVE_PLAN_DAG_V2_AUTHORITY_FIELDS) {
    if (value[field] !== "none") {
      reject("manifest_malformed", `${label} attempted to grant ${field}`);
    }
  }
}

function topologicalOrder(
  stageIds: readonly string[],
  outgoing: ReadonlyMap<string, WavePlanDagEdgeV2[]>,
  indegree: ReadonlyMap<string, number>,
): string[] {
  const remaining = new Map(indegree);
  const available = stageIds.filter((stageId) => remaining.get(stageId) === 0).sort(compareAscii);
  const ordered: string[] = [];
  while (available.length > 0) {
    const stageId = available.shift() as string;
    ordered.push(stageId);
    for (const edge of outgoing.get(stageId) ?? []) {
      const next = (remaining.get(edge.toStageId) ?? 0) - 1;
      remaining.set(edge.toStageId, next);
      if (next === 0) {
        available.push(edge.toStageId);
        available.sort(compareAscii);
      }
    }
  }
  return ordered;
}

/** Throws {@link WavePlanDagV2ContractError} on any spec violation; see module doc. */
function validateManifestOrThrow(rawManifest: unknown): {
  manifest: WavePlanDagManifestV2;
  graph: ValidatedWavePlanDagGraphV2;
} {
  assertClosedRecord(rawManifest, MANIFEST_FIELDS, "WavePlanDagManifestV2");
  const manifest = rawManifest as unknown as WavePlanDagManifestV2;
  if (manifest.kind !== "WavePlanDagManifestV2" || manifest.version !== 2) {
    reject("manifest_malformed", "manifest kind/version mismatch");
  }
  if (manifest.proposalSource !== "model" && manifest.proposalSource !== "operator") {
    reject("manifest_malformed", "proposalSource is not closed");
  }
  assertPattern(manifest.manifestAlias, PLAN_ALIAS_PATTERN, "manifestAlias");
  assertPattern(manifest.manifestDigest, DIGEST_PATTERN, "manifestDigest");
  if (manifest.manifestDigestDomain !== WAVE_PLAN_DAG_V2_MANIFEST_DIGEST_DOMAIN) {
    reject("manifest_malformed", "manifest digest domain mismatch");
  }
  assertClosedRecord(manifest.limits, Object.keys(WAVE_PLAN_DAG_V2_LIMITS), "limits");
  if (
    canonicalizeWavePlanDagV2Json(manifest.limits as WavePlanDagV2CanonicalValue)
    !== canonicalizeWavePlanDagV2Json(WAVE_PLAN_DAG_V2_LIMITS)
  ) {
    reject("manifest_malformed", "limits must equal fixed V2 limits");
  }
  assertAuthorityBoundary(manifest as unknown as Record<string, unknown>, "manifest");

  if (!Array.isArray(manifest.stages)) {
    reject("manifest_malformed", "stages must be an array");
  }
  if (manifest.stages.length < 1 || manifest.stages.length > WAVE_PLAN_DAG_V2_LIMITS.maxStages) {
    reject("stage_limit_exceeded", "stage count outside 1..32");
  }
  if (!Array.isArray(manifest.edges)) {
    reject("manifest_malformed", "edges must be an array");
  }
  if (manifest.edges.length > WAVE_PLAN_DAG_V2_LIMITS.maxEdges) {
    reject("edge_limit_exceeded", "edge count exceeds 64");
  }

  const stageIds: string[] = [];
  const stagesById = new Map<string, WavePlanDagStageV2>();
  const manifestAliases = new Set<string>();
  for (const rawStage of manifest.stages as unknown[]) {
    assertClosedRecord(rawStage, STAGE_FIELDS, "WavePlanDagStageV2");
    const stage = rawStage as unknown as WavePlanDagStageV2;
    assertPattern(stage.stageId, STAGE_ID_PATTERN, "stageId");
    assertPattern(stage.manifestAlias, STAGE_MANIFEST_ALIAS_PATTERN, "stage manifestAlias");
    assertPattern(stage.reviewedManifestDigest, DIGEST_PATTERN, "reviewedManifestDigest");
    if (stage.joinPolicy !== "root" && stage.joinPolicy !== "all_matching" && stage.joinPolicy !== "any_matching") {
      reject("manifest_malformed", "unknown joinPolicy");
    }
    if (stagesById.has(stage.stageId)) {
      reject("duplicate_stage", `duplicate stage ${stage.stageId}`);
    }
    if (manifestAliases.has(stage.manifestAlias)) {
      reject("manifest_malformed", "stage manifest aliases must be unique");
    }
    stageIds.push(stage.stageId);
    stagesById.set(stage.stageId, stage);
    manifestAliases.add(stage.manifestAlias);
  }

  const incoming = new Map<string, WavePlanDagEdgeV2[]>(stageIds.map((stageId) => [stageId, []]));
  const outgoing = new Map<string, WavePlanDagEdgeV2[]>(stageIds.map((stageId) => [stageId, []]));
  const endpointPairs = new Set<string>();
  for (const rawEdge of manifest.edges as unknown[]) {
    assertClosedRecord(rawEdge, ["fromStageId", "toStageId", "when"], "WavePlanDagEdgeV2");
    const edge = rawEdge as unknown as WavePlanDagEdgeV2;
    assertPattern(edge.fromStageId, STAGE_ID_PATTERN, "fromStageId");
    assertPattern(edge.toStageId, STAGE_ID_PATTERN, "toStageId");
    if (edge.when !== "gate_passed" && edge.when !== "gate_failed" && edge.when !== "any_terminal") {
      reject("manifest_malformed", "unknown edge predicate");
    }
    if (edge.fromStageId === edge.toStageId) {
      reject("self_edge", `self edge ${edge.fromStageId}`);
    }
    if (!stagesById.has(edge.fromStageId) || !stagesById.has(edge.toStageId)) {
      reject("unknown_endpoint", "edge references unknown stage");
    }
    const pair = `${edge.fromStageId}\0${edge.toStageId}`;
    if (endpointPairs.has(pair)) {
      reject("duplicate_edge", "repeated endpoint pair");
    }
    endpointPairs.add(pair);
    outgoing.get(edge.fromStageId)?.push(edge);
    incoming.get(edge.toStageId)?.push(edge);
  }

  for (const stageId of stageIds) {
    if ((incoming.get(stageId)?.length ?? 0) > WAVE_PLAN_DAG_V2_LIMITS.maxFanIn) {
      reject("fan_in_limit_exceeded", `fan-in exceeds 8 at ${stageId}`);
    }
    if ((outgoing.get(stageId)?.length ?? 0) > WAVE_PLAN_DAG_V2_LIMITS.maxFanOut) {
      reject("fan_out_limit_exceeded", `fan-out exceeds 8 at ${stageId}`);
    }
  }

  const roots = stageIds.filter((stageId) => (incoming.get(stageId)?.length ?? 0) === 0);
  if (roots.length !== 1) reject("root_count_invalid", "graph must have exactly one root");
  const root = roots[0];
  if (!stageIds.some((stageId) => (outgoing.get(stageId)?.length ?? 0) === 0)) {
    reject("manifest_malformed", "graph must have at least one leaf");
  }
  for (const stageId of stageIds) {
    const stage = stagesById.get(stageId);
    const expectedJoin = stageId === root ? "root" : null;
    if ((expectedJoin !== null && stage?.joinPolicy !== expectedJoin)
      || (expectedJoin === null && stage?.joinPolicy === "root")) {
      reject("manifest_malformed", "root joinPolicy must match structural root");
    }
  }

  const reachable = new Set<string>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const stageId = queue.shift() as string;
    for (const edge of outgoing.get(stageId) ?? []) {
      if (!reachable.has(edge.toStageId)) {
        reachable.add(edge.toStageId);
        queue.push(edge.toStageId);
      }
    }
  }
  if (reachable.size !== stageIds.length) {
    reject("unreachable_stage", "every stage must be reachable from root");
  }

  const indegree = new Map(stageIds.map((stageId) => [stageId, incoming.get(stageId)?.length ?? 0]));
  const topology = topologicalOrder(stageIds, outgoing, indegree);
  if (topology.length !== stageIds.length) {
    reject("cycle_detected", "graph must be acyclic");
  }

  const depthByStage = new Map(stageIds.map((stageId) => [stageId, 0]));
  for (const stageId of topology) {
    for (const edge of outgoing.get(stageId) ?? []) {
      depthByStage.set(edge.toStageId, Math.max(depthByStage.get(edge.toStageId) ?? 0, (depthByStage.get(stageId) ?? 0) + 1));
    }
  }
  if (Math.max(...depthByStage.values()) > WAVE_PLAN_DAG_V2_LIMITS.maxDepth) {
    reject("depth_limit_exceeded", "longest root path exceeds 8 edges");
  }

  const expectedDigest = computeWavePlanDagManifestV2Digest(manifest);
  if (manifest.manifestDigest !== expectedDigest) {
    reject("manifest_digest_mismatch", `manifest digest mismatch: expected ${expectedDigest}`);
  }

  for (const edges of incoming.values()) edges.sort((a, b) => compareAscii(edgeTuple(a), edgeTuple(b)));
  for (const edges of outgoing.values()) edges.sort((a, b) => compareAscii(edgeTuple(a), edgeTuple(b)));

  return {
    manifest,
    graph: { root, stagesById, incoming, outgoing, topology, depthByStage },
  };
}

export interface WavePlanDagManifestAdmissionOkV2 {
  ok: true;
  manifest: WavePlanDagManifestV2;
  graph: ValidatedWavePlanDagGraphV2;
}
export interface WavePlanDagManifestAdmissionFailedV2 extends WavePlanDagV2Rejection {
  ok: false;
}

export type WavePlanDagManifestAdmissionV2 = WavePlanDagManifestAdmissionOkV2 | WavePlanDagManifestAdmissionFailedV2;

/**
 * Admits or rejects a V2 manifest proposal. Input is untrusted: a malformed,
 * limit-violating, cyclic, unreachable, digest-mismatched, or
 * authority-granting manifest is rejected with the exact §5 reason and never
 * partially returned.
 */
export function admitWavePlanDagManifestV2(input: unknown): WavePlanDagManifestAdmissionV2 {
  try {
    return { ok: true, ...validateManifestOrThrow(input) };
  } catch (error) {
    if (error instanceof Error && "reason" in error) {
      const reason = (error as { reason?: string }).reason;
      if (typeof reason === "string") {
        return wavePlanDagV2Rejection(
          reason as Parameters<typeof wavePlanDagV2Rejection>[0],
          error.message,
        );
      }
    }
    throw error;
  }
}
