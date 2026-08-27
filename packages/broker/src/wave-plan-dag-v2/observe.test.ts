import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  observeWavePlanDagV2Operator,
  observeWavePlanDagV2Public,
  WAVE_PLAN_DAG_V2_DEFAULT_OBSERVATION_MODE,
  WAVE_PLAN_DAG_V2_OBSERVATION_COUNT_CAP,
  WAVE_PLAN_DAG_V2_OBSERVATION_MAX_MESSAGE_CHARS,
} from "./observe.js";
import {
  admitWavePlanDagManifestV2,
  computeWavePlanDagManifestV2Digest,
  type WavePlanDagManifestAdmissionOkV2,
} from "./manifest.js";
import { runWavePlanDagDryRunV2 } from "./dry-run.js";
import { canonicalizeWavePlanDagV2Json } from "./digest.js";

/**
 * #1800 slice 2 — record-only observation mode + bounded diagnostics
 * (issue item 6) and the pure replay-determinism subset of item 7.
 *
 * Load-bearing properties:
 * 1. default-off: `off` observes nothing, `record_only` is the only way in,
 *    and there is no acting variant anywhere in this module;
 * 2. boundedness: public projections stay closed-field, enum-valued, and
 *    count-clamped even for garbage-shaped input;
 * 3. determinism/isolation (item 7 pure subset): identical inputs reproduce
 *    identical observations and receipts, and post-hoc input mutation cannot
 *    change an already-built observation.
 */

const FIXTURE = JSON.parse(
  readFileSync(
    join(process.cwd(), "..", "..", "fixtures", "contract", "wave-plan-dag-v2.json"),
    "utf8",
  ),
) as {
  manifest: Record<string, unknown>;
  dryRuns: Array<{ request: Record<string, unknown>; receipt: Record<string, unknown> }>;
};

type LooseRecord = Record<string, unknown>;

function clone(value: LooseRecord): LooseRecord {
  return structuredClone(value);
}

function okAdmission(value: unknown): asserts value is WavePlanDagManifestAdmissionOkV2 {
  assert.ok((value as WavePlanDagManifestAdmissionOkV2).ok === true);
}

type OperatorResult = ReturnType<typeof observeWavePlanDagV2Operator>;
type AdmittedOperatorResult = Extract<OperatorResult, { observed: true; proposalAdmitted: true }>;
type RejectedOperatorResult = Extract<OperatorResult, { observed: true; proposalAdmitted: false }>;

function admittedOperator(outcome: OperatorResult): AdmittedOperatorResult {
  if (!(outcome.observed && outcome.proposalAdmitted)) throw new Error("expected admitted operator observation");
  return outcome;
}

function rejectedOperator(outcome: OperatorResult): RejectedOperatorResult {
  if (!(outcome.observed && !outcome.proposalAdmitted)) throw new Error("expected rejected operator observation");
  return outcome;
}

test("default mode is off and off-mode observes nothing even for a valid proposal", () => {
  assert.equal(WAVE_PLAN_DAG_V2_DEFAULT_OBSERVATION_MODE, "off");

  const publicObservation = observeWavePlanDagV2Public("off", clone(FIXTURE.manifest));
  assert.deepEqual(publicObservation, { kind: "WavePlanDagV2PublicObservation", version: 2, observed: false });

  const operatorObservation = observeWavePlanDagV2Operator(
    WAVE_PLAN_DAG_V2_DEFAULT_OBSERVATION_MODE,
    clone(FIXTURE.manifest),
    FIXTURE.dryRuns[0].request,
  );
  assert.deepEqual(operatorObservation, { kind: "WavePlanDagV2OperatorObservation", version: 2, observed: false });
});

test("record_only without a request reports admission plus bounded counts only", () => {
  const observation = observeWavePlanDagV2Public("record_only", clone(FIXTURE.manifest));
  assert.ok(observation.observed === true && observation.proposalAdmitted === true);

  assert.equal(observation.stageCount, 8);
  assert.equal(observation.edgeCount, 9);
  assert.equal(observation.requestExamined, false);
  assert.equal(observation.dryRunIssued, false);
  assert.equal("rejectionReason" in observation, false);
});

test("public observation of the golden pair reports receipt facts without leaking content", () => {
  const observation = observeWavePlanDagV2Public(
    "record_only",
    clone(FIXTURE.manifest),
    clone(FIXTURE.dryRuns[0].request),
  );
  assert.ok(observation.observed === true && observation.proposalAdmitted === true);
  assert.equal(observation.requestExamined, true);
  assert.equal(observation.dryRunIssued, true);

  // The encoded public view must not contain any stage id or digest string.
  const encoded = canonicalizeWavePlanDagV2Json(observation as never);
  for (const forbidden of ["stg_", "wpm_", "mft_", "sha256:", "gate_passed"]) {
    assert.ok(!encoded.includes(forbidden), `public projection leaked ${forbidden}`);
  }
  assert.ok(encoded.includes('"topologyLength":8'), encoded);
});

test("operator observation adds digests and topological order, and no message on success", () => {
  const observation = observeWavePlanDagV2Operator(
    "record_only",
    clone(FIXTURE.manifest),
    clone(FIXTURE.dryRuns[0].request),
  );
  assert.ok(observation.observed === true && observation.proposalAdmitted === true);

  assert.equal(observation.manifestDigest, FIXTURE.manifest.manifestDigest);
  assert.equal(observation.receiptDigest, FIXTURE.dryRuns[0].receipt.receiptDigest);
  assert.deepEqual(observation.topologicalOrder, FIXTURE.dryRuns[0].receipt.topologicalOrder);
  assert.equal(observation.message, undefined);
});

test("malformed proposals project as closed rejection reasons with bounded counts", () => {
  const candidate = { ...clone(FIXTURE.manifest), prompt: "forbidden" };
  const observation = observeWavePlanDagV2Public("record_only", candidate);
  assert.ok(observation.observed === true && observation.proposalAdmitted === false);

  assert.equal(observation.rejectionReason, "manifest_malformed");
  assert.equal(observation.requestExamined, false);
  assert.equal(observation.stageCount, 8);

  const operatorView = observeWavePlanDagV2Operator("record_only", candidate);
  assert.ok(operatorView.observed === true && operatorView.proposalAdmitted === false);
  const message = operatorView.message ?? "";
  assert.ok(message.length > 0);
  assert.ok(message.length <= WAVE_PLAN_DAG_V2_OBSERVATION_MAX_MESSAGE_CHARS + 1);
});

test("oversized rejected proposals surface clamped counts (cap enforced on raw input)", () => {
  // Far beyond both the spec cap (32) and the projection cap (64): admission
  // fails with stage_limit_exceeded while the observation still reports the
  // raw size collapsed to 64 with its collapse flag set.
  const candidate = clone(FIXTURE.manifest);
  candidate.stages = Array.from({ length: WAVE_PLAN_DAG_V2_OBSERVATION_COUNT_CAP + 50 }, (_, index) => ({
    stageId: `stg_${(index + 1).toString(16).padStart(8, "0")}`,
    manifestAlias: `mft_${(index + 1).toString(16).padStart(16, "0")}`,
    reviewedManifestDigest: `sha256:${index.toString(16).padStart(64, "0")}`,
    joinPolicy: "all_matching",
  }));

  const publicView = observeWavePlanDagV2Public("record_only", candidate);
  assert.ok(publicView.observed === true && publicView.proposalAdmitted === false);
  assert.equal(publicView.rejectionReason, "stage_limit_exceeded");
  assert.equal(publicView.stageCount, WAVE_PLAN_DAG_V2_OBSERVATION_COUNT_CAP);
  assert.equal(publicView.stageCountCollapsedAtCap, true);

  const operatorView = rejectedOperator(observeWavePlanDagV2Operator("record_only", candidate));
  assert.equal(operatorView.rejectionReason, "stage_limit_exceeded");
  assert.equal(operatorView.stageCountCollapsedAtCap, true);
  void operatorView;
});

test("non-array stage/edge garbage counts as zero in the bounded projection", () => {
  const candidate = { ...clone(FIXTURE.manifest), stages: null, edges: null };
  const view = observeWavePlanDagV2Public("record_only", candidate);
  // stages non-array → the malformed-array guard fires before the count check.
  assert.ok(view.observed === true && view.proposalAdmitted === false);
  assert.equal(view.rejectionReason, "manifest_malformed");
  assert.equal(view.stageCount, 0);
  assert.equal(view.edgeCount, 0);
  assert.equal(view.stageCountCollapsedAtCap, false);
  assert.equal(view.edgeCountCollapsedAtCap, false);
});

test("operator diagnostics keep the dry-run rejection reason flow", () => {
  const mismatchedRequest = clone(FIXTURE.dryRuns[0].request);
  mismatchedRequest.manifestDigest = `sha256:${"e".repeat(64)}`;
  const view = observeWavePlanDagV2Operator("record_only", clone(FIXTURE.manifest), mismatchedRequest);
  assert.ok(view.observed === true && view.proposalAdmitted === true);

  assert.equal(view.dryRunIssued, false);
  assert.equal(view.dryRunRejectionReason, "manifest_digest_mismatch");
  assert.equal(view.receiptDigest, undefined);
  const message = view.message ?? "";
  assert.match(message, /manifest_digest_mismatch/);
  assert.ok(message.length <= WAVE_PLAN_DAG_V2_OBSERVATION_MAX_MESSAGE_CHARS + 1);
});

test("outcome_join_mismatch flows through both projections unchanged", () => {
  const waitingTarget = clone(FIXTURE.dryRuns[0].request);
  waitingTarget.outcomes = (waitingTarget.outcomes as LooseRecord[]).filter((outcome) =>
    ["stg_00000000", "stg_00000010"].includes(outcome.stageId as string));
  (waitingTarget.outcomes as LooseRecord[]).push({
    kind: "WavePlanDagStageOutcomeV2",
    version: 2,
    stageId: "stg_00000030",
    outcome: "gate_passed",
  });

  const publicView = observeWavePlanDagV2Public("record_only", clone(FIXTURE.manifest), waitingTarget);
  assert.ok(publicView.observed === true && publicView.proposalAdmitted === true);
  assert.equal(publicView.dryRunIssued, false);
  assert.equal(publicView.dryRunRejectionReason, "outcome_join_mismatch");

  const operatorView = admittedOperator(
    observeWavePlanDagV2Operator("record_only", clone(FIXTURE.manifest), waitingTarget),
  );
  assert.match(operatorView.message ?? "", /outcome_join_mismatch/);
});

test("observing never mutates inputs, and later mutation cannot change an earlier observation", () => {
  const proposal = clone(FIXTURE.manifest);
  const before = observeWavePlanDagV2Operator("record_only", proposal, clone(FIXTURE.dryRuns[0].request));
  assert.ok(before.observed === true && before.proposalAdmitted === true);
  const topologyBefore = JSON.stringify(before.topologicalOrder);

  // Mutate the caller's object afterwards — the built observation must hold.
  (proposal.stages as LooseRecord[]).pop();
  (proposal.edges as LooseRecord[]).pop();

  assert.equal(JSON.stringify(before.topologicalOrder), topologyBefore);
  assert.equal(before.manifestDigest, FIXTURE.manifest.manifestDigest);
  assert.equal(before.receiptDigest, FIXTURE.dryRuns[0].receipt.receiptDigest);
});

test("determinism: repeated observations of identical inputs are deeply equal", () => {
  const first = observeWavePlanDagV2Operator("record_only", clone(FIXTURE.manifest), clone(FIXTURE.dryRuns[1].request));
  const second = observeWavePlanDagV2Operator("record_only", clone(FIXTURE.manifest), clone(FIXTURE.dryRuns[1].request));
  assert.deepEqual(first, second);
});

test("pure replay pins (#1800 item 7 pure subset): builders are idempotent producers", () => {
  const admissionA = admitWavePlanDagManifestV2(clone(FIXTURE.manifest));
  const admissionB = admitWavePlanDagManifestV2(clone(FIXTURE.manifest));
  assert.deepEqual(admissionA, admissionB, "admission must be a pure function of its input");
  okAdmission(admissionA);
  okAdmission(admissionB);

  for (const vector of FIXTURE.dryRuns) {
    const runA = runWavePlanDagDryRunV2(admissionA, vector.request);
    const runB = runWavePlanDagDryRunV2(admissionB, vector.request);
    assert.deepEqual(runA, runB);
    if (!(runA as { ok?: boolean }).ok) continue;
    const receiptA = (runA as { ok: true; receipt: { receiptDigest: string } }).receipt;
    // Replaying the same rehearsal bytes reproduces the same signed boundary.
    assert.equal(receiptA.receiptDigest, vector.receipt.receiptDigest);
  }
});

test("input-array order does not affect the digest the observation reports", () => {
  const reordered = structuredClone(FIXTURE.manifest);
  (reordered.stages as LooseRecord[]).reverse();
  const admission = admitWavePlanDagManifestV2(reordered);
  okAdmission(admission);
  assert.equal(computeWavePlanDagManifestV2Digest(reordered as never), FIXTURE.manifest.manifestDigest);
});
