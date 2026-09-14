import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { admitWavePlanDagManifestV2, computeWavePlanDagManifestV2Digest, type WavePlanDagManifestAdmissionV2 } from "./manifest.js";
import { runWavePlanDagDryRunV2, type WavePlanDagDryRunReceiptV2 } from "./dry-run.js";
import {
  createWavePlanDagV2RecordStore,
  WavePlanDagV2RecordStore,
  wavePlanDagV2ManifestAdmissionEntry,
  wavePlanDagV2ReceiptPayloadEntry,
  wavePlanDagV2RehearsalOutcomeEntry,
  wavePlanDagV2StageBindingEntry,
  type WavePlanDagV2StoredEntry,
} from "./record-store.js";
import {
  planWavePlanDagV2StageBinding,
  wavePlanDagStageFollowUpCheckV1,
  wavePlanDagStageFrontierProjectionV1,
  WAVE_PLAN_DAG_V2_BINDING_COUNT_CAP,
  WAVE_PLAN_DAG_V2_STAGE_FOLLOW_UP_CHECK_KIND,
  WAVE_PLAN_DAG_V2_STAGE_FRONTIER_PROJECTION_KIND,
  WAVE_PLAN_DAG_V2_STAGE_FRONTIER_PUBLIC_KIND,
  type WavePlanDagV2BoundTaskStatusV1,
  type WavePlanDagV2ReceiptEvidenceV1,
} from "./stage-task-binding.js";
import { InMemoryA2ABroker } from "../core/broker.js";
import { BrokerError } from "../core/broker-error.js";
import { classifyWavePlanIntake } from "./dispatch-boundary.js";
import { handleWavePlanDagV2RoutesIfMatched } from "../http/wave-plan-dag-v2-routes.js";

/**
 * #1800 B-2 — stage-to-task binding contract (adopted by operator ruling
 * 2026-09-14), docs/specs/wave-plan-dag-v2/stage-task-binding.md §4–§9.
 *
 * Pins (contract §9):
 * 1. Ledger: idempotent redelivery, `duplicate_conflict` on bindingSource
 *    mismatch, `manifest_not_known` before admission, `unknown_stage`,
 *    `task_unknown`, `task_not_open`, `duplicate_open_binding`, batch
 *    all-or-nothing, restore corruption → `snapshot_corrupt`, timestamp-free
 *    restart determinism.
 * 2. Follow-up check: all five states plus count clamping; the mandatory
 *    refusal exercised end-to-end at the write path.
 * 3. Frontier projection: aligned/divergent rows, `bound_task_missing`,
 *    `leaf_unbound` on a hand-built branch/rejoin/orphan DAG,
 *    `receipt_stale` refusal, `receipt_missing`, and the §11.1.3
 *    `receipt_payload_not_retained` refusal with the retained payload as the
 *    ledger-driven evidence source.
 * 4. Non-interference: classifier verdicts and frozen manifest digests are
 *    unchanged; public projections never carry task ids or digests.
 *
 * Default-off posture: every broker surface here is gated on explicit
 * `wavePlanDagV2Mode: "record"`; nothing invokes the write entry implicitly.
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

const FIXTURE_DIGEST = (FIXTURE.manifest as { manifestDigest: string }).manifestDigest;
const ROOT_STAGE = "stg_00000000";

function fixtureAdmission(): Extract<WavePlanDagManifestAdmissionV2, { ok: true }> {
  const admission = admitWavePlanDagManifestV2(structuredClone(FIXTURE.manifest));
  if (!admission.ok) throw new Error("fixture must admit");
  return admission;
}

function admittedStore(): ReturnType<typeof createWavePlanDagV2RecordStore> {
  const store = createWavePlanDagV2RecordStore();
  const appended = store.append([wavePlanDagV2ManifestAdmissionEntry(fixtureAdmission())]);
  assert.ok(appended.ok);
  return store;
}

function bindingEntry(
  manifestDigest: string,
  stageId: string,
  taskId: string,
  bindingSource: "operator" | "hub" = "operator",
): WavePlanDagV2StoredEntry {
  return wavePlanDagV2StageBindingEntry({ manifestDigest, stageId, taskId, bindingSource });
}

function statusLookup(statuses: Record<string, string | null>) {
  return (taskId: string): WavePlanDagV2BoundTaskStatusV1 | null => {
    const status = statuses[taskId];
    return status === undefined ? null : (status as WavePlanDagV2BoundTaskStatusV1);
  };
}

// ---------------------------------------------------------------------------
// §9.1 — ledger pins
// ---------------------------------------------------------------------------

test("binding entries commit only over an admitted manifest and dedupe identically", () => {
  const store = admittedStore();

  const first = store.append([bindingEntry(FIXTURE_DIGEST, ROOT_STAGE, "task-1")]);
  assert.deepEqual(first, { ok: true, committed: 1, skippedDuplicates: 0 });

  // §4.3: identical redelivery is a counted no-op.
  const replay = store.append([bindingEntry(FIXTURE_DIGEST, ROOT_STAGE, "task-1")]);
  assert.deepEqual(replay, { ok: true, committed: 0, skippedDuplicates: 1 });

  // §4.3: same triple with a different bindingSource is a duplicate_conflict.
  const conflict = store.append([bindingEntry(FIXTURE_DIGEST, ROOT_STAGE, "task-1", "hub")]);
  assert.ok(!conflict.ok && conflict.reason === "duplicate_conflict");

  // Multiple tasks MAY be bound to one stage over time; every row stays visible.
  const second = store.append([bindingEntry(FIXTURE_DIGEST, ROOT_STAGE, "task-2")]);
  assert.ok(second.ok && second.committed === 1);
  assert.equal(store.bindingsOf(FIXTURE_DIGEST).length, 2);
});

test("bindings enforce flow ordering: no admission, no binding", () => {
  const store = createWavePlanDagV2RecordStore();
  const result = store.append([bindingEntry(FIXTURE_DIGEST, ROOT_STAGE, "task-1")]);
  assert.ok(!result.ok && result.reason === "manifest_not_known");
  assert.equal(store.bindingsOf(FIXTURE_DIGEST).length, 0);
});

test("batch all-or-nothing: one inadmissible binding rejects the whole batch", () => {
  const store = admittedStore();
  const unknownDigest = `sha256:${"b".repeat(64)}`;
  const result = store.append([
    bindingEntry(FIXTURE_DIGEST, ROOT_STAGE, "task-1"),
    bindingEntry(unknownDigest, ROOT_STAGE, "task-2"),
  ]);
  assert.ok(!result.ok && result.reason === "manifest_not_known");
  assert.equal(store.bindingsOf(FIXTURE_DIGEST).length, 0, "nothing from the batch may commit");
});

test("malformed binding rows are rejected and corrupt snapshots restore fail-closed", () => {
  const store = admittedStore();
  const malformed = bindingEntry(FIXTURE_DIGEST, ROOT_STAGE, "task-1") as unknown as Record<string, unknown>;
  malformed.extraField = "forbidden";
  const result = store.append([malformed]);
  assert.ok(!result.ok && result.reason === "entry_malformed");

  assert.ok(store.append([bindingEntry(FIXTURE_DIGEST, ROOT_STAGE, "task-1")]).ok);
  const snapshot = store.snapshot();

  const restored = WavePlanDagV2RecordStore.restore(snapshot);
  assert.ok(restored.ok);

  const tampered = structuredClone(snapshot) as unknown as Array<Record<string, unknown>>;
  const bindingRow = tampered.find((row) => row.entryType === "stage_task_binding_recorded");
  assert.ok(bindingRow);
  (bindingRow as Record<string, unknown>).taskId = "has space";
  const corrupt = WavePlanDagV2RecordStore.restore(tampered);
  assert.ok(!corrupt.ok && corrupt.reason === "snapshot_corrupt");
});

test("timestamp-free restart determinism for binding ledgers", () => {
  const buildStore = () => {
    const store = admittedStore();
    assert.ok(store.append([
      bindingEntry(FIXTURE_DIGEST, ROOT_STAGE, "task-1"),
      bindingEntry(FIXTURE_DIGEST, ROOT_STAGE, "task-2", "hub"),
    ]).ok);
    return store;
  };
  const first = buildStore();
  const second = buildStore();
  assert.deepEqual(first.snapshot(), second.snapshot());

  const restored = WavePlanDagV2RecordStore.restore(first.snapshot());
  assert.ok(restored.ok);
  assert.deepEqual(restored.ok ? restored.store.snapshot() : null, first.snapshot());
});

test("binding rows stay out of rehearsal listings and appear in bindingsOf", () => {
  const store = admittedStore();
  const run = runWavePlanDagDryRunV2(fixtureAdmission(), structuredClone(FIXTURE.dryRuns[0].request));
  assert.ok(run.ok);
  assert.ok(store.append([
    wavePlanDagV2RehearsalOutcomeEntry(run, FIXTURE_DIGEST),
    bindingEntry(FIXTURE_DIGEST, ROOT_STAGE, "task-1"),
  ]).ok);

  const rehearsals = store.rehearsalsOf(FIXTURE_DIGEST);
  assert.equal(rehearsals.length, 1);
  assert.ok(rehearsals.every((row) => row.entryType === "rehearsal_receipt_recorded"));
  const bindings = store.bindingsOf(FIXTURE_DIGEST);
  assert.equal(bindings.length, 1);
  assert.ok(bindings.every((row) => row.entryType === "stage_task_binding_recorded"));
});

// ---------------------------------------------------------------------------
// §11.1.3 — retained receipt payloads (fifth closed store union member)
// ---------------------------------------------------------------------------

function fixtureReceipt(vectorIndex: number) {
  const run = runWavePlanDagDryRunV2(fixtureAdmission(), structuredClone(FIXTURE.dryRuns[vectorIndex].request));
  assert.ok(run.ok);
  if (!run.ok) throw new Error("fixture vector must rehearse");
  return run.receipt;
}

test("receipt payload entries derive from typed receipts and dedupe by receiptDigest", () => {
  const store = admittedStore();
  const receipt = fixtureReceipt(0);
  const entry = wavePlanDagV2ReceiptPayloadEntry(receipt);
  assert.equal(entry.entryType, "rehearsal_receipt_payload_recorded");
  assert.equal(entry.manifestDigest, FIXTURE_DIGEST);
  assert.equal(entry.manifestAlias, receipt.manifestAlias);
  assert.equal(entry.receiptDigest, FIXTURE.dryRuns[0].receipt.receiptDigest);
  assert.deepEqual(entry.stages, receipt.stages.map((signal) => ({ ...signal })));

  const first = store.append([entry]);
  assert.deepEqual(first, { ok: true, committed: 1, skippedDuplicates: 0 });

  // §11.1.3: receiptDigest-keyed idempotent redelivery is a counted no-op.
  const replay = store.append([wavePlanDagV2ReceiptPayloadEntry(receipt)]);
  assert.deepEqual(replay, { ok: true, committed: 0, skippedDuplicates: 1 });

  // Same digest with a DIFFERENT payload is a duplicate_conflict rejecting
  // the whole batch.
  const conflicting = wavePlanDagV2ReceiptPayloadEntry(receipt) as unknown as Record<string, unknown>;
  conflicting.stages = [{ stageId: ROOT_STAGE, state: "ready", reason: "root_stage" }];
  const conflict = store.append([conflicting as unknown as WavePlanDagV2StoredEntry]);
  assert.ok(!conflict.ok && conflict.reason === "duplicate_conflict");
  assert.equal(store.receiptPayloadsOf(FIXTURE_DIGEST).length, 1, "failed batch must leave the store untouched");

  // Flow ordering: no admission, no retained payload.
  const orphan = createWavePlanDagV2RecordStore();
  const flow = orphan.append([wavePlanDagV2ReceiptPayloadEntry(receipt)]);
  assert.ok(!flow.ok && flow.reason === "manifest_not_known");

  // Distinct rehearsal outcomes are distinct evidence; both stay visible and
  // the latest accessor tracks commit order.
  const other = wavePlanDagV2ReceiptPayloadEntry(fixtureReceipt(1));
  assert.ok(store.append([other]).ok);
  assert.equal(store.receiptPayloadsOf(FIXTURE_DIGEST).length, 2);
  assert.equal(store.latestReceiptPayloadOf(FIXTURE_DIGEST)?.receiptDigest, FIXTURE.dryRuns[1].receipt.receiptDigest);
});

test("receipt payload rows reject malformed shapes and restore fail-closed", () => {
  const store = admittedStore();
  const receipt = fixtureReceipt(0);
  const entry = wavePlanDagV2ReceiptPayloadEntry(receipt);

  const malformed: Array<[WavePlanDagV2StoredEntry, string]> = [
    [{ ...entry, extraField: "forbidden" } as unknown as WavePlanDagV2StoredEntry, "extra field"],
    [{ ...entry, stages: [{ stageId: ROOT_STAGE, state: "ready", reason: "gate_passed" }] } as unknown as WavePlanDagV2StoredEntry, "state/reason pair not closed"],
    [{ ...entry, stages: [{ stageId: ROOT_STAGE, state: "archived", reason: "root_stage" }] } as unknown as WavePlanDagV2StoredEntry, "state not closed"],
    [{ ...entry, stages: [] } as unknown as WavePlanDagV2StoredEntry, "empty stage list"],
    [{ ...entry, stages: Array.from({ length: 33 }, () => ({ stageId: ROOT_STAGE, state: "ready", reason: "root_stage" })) } as unknown as WavePlanDagV2StoredEntry, "stage list over 32"],
    [{ ...entry, manifestAlias: "wpm_short" } as unknown as WavePlanDagV2StoredEntry, "bad manifestAlias"],
  ];
  for (const [candidate, label] of malformed) {
    const result = store.append([candidate]);
    assert.ok(!result.ok && result.reason === "entry_malformed", label);
  }

  assert.ok(store.append([entry]).ok);

  // Restore detects a tampered stage signal and refuses the whole snapshot.
  const tampered = structuredClone(store.snapshot()) as unknown as Array<Record<string, unknown>>;
  const payloadRow = tampered.find((row) => row.entryType === "rehearsal_receipt_payload_recorded");
  assert.ok(payloadRow);
  const stages = payloadRow.stages as Array<Record<string, unknown>>;
  stages[0].state = "waiting"; // terminal/gate_passed facts rewritten → invalid pair
  const corrupt = WavePlanDagV2RecordStore.restore(tampered);
  assert.ok(!corrupt.ok && corrupt.reason === "snapshot_corrupt");

  // Accessors hand out deep copies: mutations never reach the store.
  const copy = store.latestReceiptPayloadOf(FIXTURE_DIGEST);
  assert.ok(copy);
  (copy.stages[0] as unknown as Record<string, unknown>).reason = "tampered";
  assert.equal(store.latestReceiptPayloadOf(FIXTURE_DIGEST)?.stages[0].reason, receipt.stages[0].reason);

  // Timestamp-free determinism holds for payload rows too.
  const buildStore = () => {
    const fresh = admittedStore();
    assert.ok(fresh.append([wavePlanDagV2ReceiptPayloadEntry(receipt)]).ok);
    return fresh.snapshot();
  };
  assert.deepEqual(buildStore(), buildStore());
});

// ---------------------------------------------------------------------------
// §4.2 — write-path preconditions (planner)
// ---------------------------------------------------------------------------

interface PlannerArgs {
  request: unknown;
  admission: WavePlanDagManifestAdmissionV2;
  manifestAdmittedOnLedger: boolean;
  boundTaskIds: readonly string[];
  taskStatusOf: (taskId: string) => WavePlanDagV2BoundTaskStatusV1 | null;
}

function plannerInput(overrides?: Partial<PlannerArgs>): PlannerArgs {
  const admission = fixtureAdmission();
  return {
    request: {
      manifestDigest: admission.manifest.manifestDigest,
      stageId: ROOT_STAGE,
      taskId: "task-1",
      bindingSource: "operator",
    },
    admission,
    manifestAdmittedOnLedger: true,
    boundTaskIds: [],
    taskStatusOf: statusLookup({ "task-1": "queued" }),
    ...overrides,
  };
}

test("planner enforces §4.2 order: malformed → not known → unknown stage → task gates → duplicate guard", () => {
  // Structural first.
  const malformed = planWavePlanDagV2StageBinding(plannerInput({
    request: { manifestDigest: "sha256:nope", stageId: ROOT_STAGE, taskId: "task-1", bindingSource: "operator" },
  }));
  assert.ok(!malformed.ok && malformed.reason === "entry_malformed");

  // Ledger admission gate before stage membership.
  const admission = fixtureAdmission();
  const notKnown = planWavePlanDagV2StageBinding(plannerInput({
    manifestAdmittedOnLedger: false,
  }));
  assert.ok(!notKnown.ok && notKnown.reason === "manifest_not_known");

  const digestMismatch = planWavePlanDagV2StageBinding(plannerInput({
    request: {
      manifestDigest: `sha256:${"c".repeat(64)}`,
      stageId: ROOT_STAGE,
      taskId: "task-1",
      bindingSource: "operator",
    },
    admission,
    manifestAdmittedOnLedger: true,
  }));
  assert.ok(!digestMismatch.ok && digestMismatch.reason === "manifest_not_known");

  // Stage membership before task resolution.
  const unknownStage = planWavePlanDagV2StageBinding(plannerInput({
    request: {
      manifestDigest: admission.manifest.manifestDigest,
      stageId: "stg_ffffffff",
      taskId: "unresolvable-task",
      bindingSource: "operator",
    },
    taskStatusOf: () => null,
  }));
  assert.ok(!unknownStage.ok && unknownStage.reason === "unknown_stage");

  // Task resolution: unresolvable first, then terminal.
  const unknownTask = planWavePlanDagV2StageBinding(plannerInput({
    taskStatusOf: () => null,
  }));
  assert.ok(!unknownTask.ok && unknownTask.reason === "task_unknown");

  const terminalTask = planWavePlanDagV2StageBinding(plannerInput({
    taskStatusOf: statusLookup({ "task-1": "succeeded" }),
  }));
  assert.ok(!terminalTask.ok && terminalTask.reason === "task_not_open");

  // Mandatory refusal (§5) at the write path.
  const openDuplicate = planWavePlanDagV2StageBinding(plannerInput({
    boundTaskIds: ["task-0"],
    taskStatusOf: statusLookup({ "task-0": "running", "task-1": "queued" }),
  }));
  assert.ok(!openDuplicate.ok && openDuplicate.reason === "duplicate_open_binding");

  // Re-work over a terminal prior binding is admissible (§4.2 step 4).
  const rework = planWavePlanDagV2StageBinding(plannerInput({
    boundTaskIds: ["task-0"],
    taskStatusOf: statusLookup({ "task-0": "failed", "task-1": "queued" }),
  }));
  assert.ok(rework.ok && rework.entry.entryType === "stage_task_binding_recorded");
  assert.equal(rework.ok ? rework.followUp.state : "", "prior_binding_terminal");
});

test("planner validates the closed request shape fail-closed", () => {
  const digest = fixtureAdmission().manifest.manifestDigest;
  const cases: Array<[unknown, string]> = [
    [{ stageId: ROOT_STAGE, taskId: "task-1", bindingSource: "operator" }, "missing field"],
    [{ manifestDigest: digest, stageId: ROOT_STAGE, taskId: "task-1", bindingSource: "operator", extra: true }, "extra field"],
    [{ manifestDigest: digest, stageId: "stg_short", taskId: "task-1", bindingSource: "operator" }, "bad stageId"],
    [{ manifestDigest: digest, stageId: ROOT_STAGE, taskId: "has space", bindingSource: "operator" }, "taskId whitespace"],
    [{ manifestDigest: digest, stageId: ROOT_STAGE, taskId: "t".repeat(129), bindingSource: "operator" }, "taskId too long"],
    [{ manifestDigest: digest, stageId: ROOT_STAGE, taskId: "task-1", bindingSource: "dispatcher" }, "bindingSource not closed"],
  ];
  for (const [request, label] of cases) {
    const plan = planWavePlanDagV2StageBinding(plannerInput({ request }));
    assert.ok(!plan.ok && plan.reason === "entry_malformed", label);
  }
});

// ---------------------------------------------------------------------------
// §9.2 — follow-up check states + clamping
// ---------------------------------------------------------------------------

test("follow-up check reports all five closed states", () => {
  const admission = fixtureAdmission();
  const base = { admission, manifestDigest: admission.manifest.manifestDigest, stageId: ROOT_STAGE };

  const none = wavePlanDagStageFollowUpCheckV1({ ...base, boundTaskIds: [], taskStatusOf: () => null });
  assert.equal(none.state, "no_prior_binding");
  assert.equal(none.kind, WAVE_PLAN_DAG_V2_STAGE_FOLLOW_UP_CHECK_KIND);
  assert.equal(none.version, 1);

  const open = wavePlanDagStageFollowUpCheckV1({
    ...base,
    boundTaskIds: ["task-1", "task-2"],
    taskStatusOf: statusLookup({ "task-1": "queued", "task-2": "blocked" }),
  });
  assert.equal(open.state, "prior_binding_open");
  assert.equal(open.openBoundTaskCount, 2);
  assert.equal(open.terminalBoundTaskCount, 0);

  const terminal = wavePlanDagStageFollowUpCheckV1({
    ...base,
    boundTaskIds: ["task-1", "task-2"],
    taskStatusOf: statusLookup({ "task-1": "succeeded", "task-2": "canceled" }),
  });
  assert.equal(terminal.state, "prior_binding_terminal");
  assert.equal(terminal.terminalBoundTaskCount, 2);

  const lineageMissing = wavePlanDagStageFollowUpCheckV1({
    ...base,
    boundTaskIds: ["task-1", "task-2"],
    taskStatusOf: statusLookup({ "task-1": "succeeded" }),
  });
  assert.equal(lineageMissing.state, "lineage_unavailable", "the check refuses rather than guessing");

  const notAdmitted = wavePlanDagStageFollowUpCheckV1({
    admission: { ok: false, reason: "manifest_malformed", message: "x" },
    manifestDigest: base.manifestDigest,
    stageId: ROOT_STAGE,
    boundTaskIds: [],
    taskStatusOf: () => null,
  });
  assert.equal(notAdmitted.state, "unknown_binding_target");

  const notMember = wavePlanDagStageFollowUpCheckV1({
    ...base,
    stageId: "stg_ffffffff",
    boundTaskIds: [],
    taskStatusOf: () => null,
  });
  assert.equal(notMember.state, "unknown_binding_target");

  const digestMismatch = wavePlanDagStageFollowUpCheckV1({
    ...base,
    manifestDigest: `sha256:${"d".repeat(64)}`,
    boundTaskIds: [],
    taskStatusOf: () => null,
  });
  assert.equal(digestMismatch.state, "unknown_binding_target");
});

test("follow-up check counts clamp at the contract cap with reached flags", () => {
  const admission = fixtureAdmission();
  const statuses: Record<string, string> = {};
  const bound: string[] = [];
  for (let i = 0; i < WAVE_PLAN_DAG_V2_BINDING_COUNT_CAP + 16; i += 1) {
    const taskId = `task-${i}`;
    bound.push(taskId);
    statuses[taskId] = i % 8 === 0 ? "succeeded" : "queued";
  }
  const check = wavePlanDagStageFollowUpCheckV1({
    admission,
    manifestDigest: admission.manifest.manifestDigest,
    stageId: ROOT_STAGE,
    boundTaskIds: bound,
    taskStatusOf: statusLookup(statuses),
  });
  assert.equal(check.state, "prior_binding_open");
  assert.equal(check.openBoundTaskCount, WAVE_PLAN_DAG_V2_BINDING_COUNT_CAP);
  assert.equal(check.openBoundTaskCountCollapsedAtCap, true);
  const terminalTotal = bound.filter((taskId) => statuses[taskId] === "succeeded").length;
  assert.equal(check.terminalBoundTaskCount, terminalTotal);
  assert.equal(check.terminalBoundTaskCountCollapsedAtCap, false);
});

// ---------------------------------------------------------------------------
// §9.3 — frontier projection
// ---------------------------------------------------------------------------

/** Two-stage manifest: root → child, so receipts are cheap to build. */
function twoStageManifest(): Record<string, unknown> {
  const stage = (stageId: string, alias: string, joinPolicy: string, digit: string) => ({
    stageId,
    manifestAlias: alias,
    reviewedManifestDigest: `sha256:${digit.repeat(64)}`,
    joinPolicy,
  });
  const manifest = {
    kind: "WavePlanDagManifestV2",
    version: 2,
    proposalSource: "operator",
    manifestAlias: "wpm_1111111111111111",
    stages: [
      stage("stg_aaaaaaaa", "mft_aaaaaaaaaaaaaaaa", "root", "1"),
      stage("stg_bbbbbbbb", "mft_bbbbbbbbbbbbbbbb", "all_matching", "2"),
    ],
    edges: [{ fromStageId: "stg_aaaaaaaa", toStageId: "stg_bbbbbbbb", when: "any_terminal" }],
    limits: { maxStages: 32, maxEdges: 64, maxDepth: 8, maxFanIn: 8, maxFanOut: 8 },
    autoDispatch: false,
    operatorAdvanceRequired: true,
    dryRunRequired: true,
    claimAuthority: "none",
    executionAuthority: "none",
    retryAuthority: "none",
    finalizerAuthority: "none",
    successAuthority: "none",
    liveAuthority: "none",
    manifestDigestDomain: "a2a.wave-plan-dag-v2.manifest.v2",
    manifestDigest: `sha256:${"0".repeat(64)}`,
  };
  return { ...manifest, manifestDigest: computeWavePlanDagManifestV2Digest(manifest as never) };
}

function twoStageAdmission(): Extract<WavePlanDagManifestAdmissionV2, { ok: true }> {
  const admission = admitWavePlanDagManifestV2(structuredClone(twoStageManifest()));
  if (!admission.ok) throw new Error("two-stage manifest must admit");
  return admission;
}

const TWO_STAGE_DIGEST = twoStageAdmission().manifest.manifestDigest;

function receiptFor(outcomes: Array<{ stageId: string; outcome: "gate_passed" | "gate_failed" }>): WavePlanDagDryRunReceiptV2 {
  const admission = twoStageAdmission();
  const run = runWavePlanDagDryRunV2(admission, {
    kind: "WavePlanDagDryRunRequestV2",
    version: 2,
    manifestAlias: admission.manifest.manifestAlias,
    manifestDigest: admission.manifest.manifestDigest,
    outcomes: outcomes.map((outcome) => ({ kind: "WavePlanDagStageOutcomeV2", version: 2, ...outcome })),
  });
  if (!run.ok) throw new Error(`receipt scenario rejected: ${run.reason}`);
  return run.receipt;
}

const RECEIPT_NONE = () => receiptFor([]);
const RECEIPT_BOTH_PASSED = () => receiptFor([
  { stageId: "stg_aaaaaaaa", outcome: "gate_passed" },
  { stageId: "stg_bbbbbbbb", outcome: "gate_passed" },
]);
const RECEIPT_BOTH_FAILED = () => receiptFor([
  { stageId: "stg_aaaaaaaa", outcome: "gate_failed" },
  { stageId: "stg_bbbbbbbb", outcome: "gate_failed" },
]);

function frontierInput(overrides?: Partial<Parameters<typeof wavePlanDagStageFrontierProjectionV1>[0]>) {
  return {
    manifestDigest: TWO_STAGE_DIGEST,
    bindings: [bindingEntry(TWO_STAGE_DIGEST, "stg_aaaaaaaa", "task-1")] as readonly WavePlanDagV2StoredEntry[],
    presentedReceipt: null as WavePlanDagV2ReceiptEvidenceV1 | null,
    latestReceiptDigest: null as string | null,
    taskStatusOf: statusLookup({ "task-1": "queued" }),
    subtreeLeafTaskIds: (_taskId: string) => [] as string[],
    ...overrides,
  };
}

test("frontier: receipt_missing makes no frontier claims", () => {
  const projection = wavePlanDagStageFrontierProjectionV1(frontierInput());
  assert.equal(projection.operator.receiptBasis, "receipt_missing");
  assert.deepEqual(projection.operator.stageFrontiers, []);
  assert.equal(projection.operator.alignedOpenCount, 0);
  assert.equal(projection.public.receiptBasis, "receipt_missing");
  assert.equal(projection.operator.kind, WAVE_PLAN_DAG_V2_STAGE_FRONTIER_PROJECTION_KIND);
  assert.equal(projection.public.kind, WAVE_PLAN_DAG_V2_STAGE_FRONTIER_PUBLIC_KIND);
});

test("frontier: receipt_stale refuses unless the presented receipt is the latest", () => {
  const latest = RECEIPT_BOTH_PASSED();
  const older = receiptFor([{ stageId: "stg_aaaaaaaa", outcome: "gate_passed" }]);

  const stale = wavePlanDagStageFrontierProjectionV1(frontierInput({
    presentedReceipt: older,
    latestReceiptDigest: latest.receiptDigest,
  }));
  assert.equal(stale.operator.receiptBasis, "receipt_stale");
  assert.deepEqual(stale.operator.stageFrontiers, []);

  const absentEvidence = wavePlanDagStageFrontierProjectionV1(frontierInput({
    presentedReceipt: null,
    latestReceiptDigest: latest.receiptDigest,
  }));
  assert.equal(absentEvidence.operator.receiptBasis, "receipt_stale",
    "evidence selection is not optional: presenting nothing refuses too");

  // The store's own latest receipt is the valid basis.
  const current = wavePlanDagStageFrontierProjectionV1(frontierInput({
    presentedReceipt: latest,
    latestReceiptDigest: latest.receiptDigest,
  }));
  assert.equal(current.operator.receiptBasis, "receipt_current");
  assert.equal(current.operator.receiptDigest, latest.receiptDigest);
});

test("frontier: receipt_payload_not_retained refuses instead of guessing", () => {
  const latest = RECEIPT_BOTH_PASSED();

  // §11.1.3: a recorded latest rehearsal whose payload the store does not
  // retain refuses as its own closed basis (never an inferred projection).
  const refused = wavePlanDagStageFrontierProjectionV1(frontierInput({
    presentedReceipt: null,
    latestReceiptDigest: latest.receiptDigest,
    latestReceiptPayloadRetained: false,
  }));
  assert.equal(refused.operator.receiptBasis, "receipt_payload_not_retained");
  assert.equal(refused.public.receiptBasis, "receipt_payload_not_retained");
  assert.deepEqual(refused.operator.stageFrontiers, []);
  assert.equal(refused.operator.boundStageCount, 1, "ledger counts stay visible in the refusal");
  assert.equal(refused.operator.boundTaskCount, 1);
});

test("frontier: the retained payload subset is valid receipt evidence", () => {
  const receipt = RECEIPT_NONE();
  const evidence: WavePlanDagV2ReceiptEvidenceV1 = {
    manifestDigest: receipt.manifestDigest,
    receiptDigest: receipt.receiptDigest,
    stages: receipt.stages,
  };
  const projection = wavePlanDagStageFrontierProjectionV1(frontierInput({
    presentedReceipt: evidence,
    latestReceiptDigest: receipt.receiptDigest,
    latestReceiptPayloadRetained: true,
  }));
  assert.equal(projection.operator.receiptBasis, "receipt_current");
  assert.equal(projection.operator.receiptDigest, receipt.receiptDigest);
  assert.equal(projection.operator.alignedOpenCount, 1);
  assert.equal(projection.public.receiptBasis, "receipt_current");
});

test("frontier: a receipt for another manifest refuses as stale (fail-closed pairing)", () => {
  const fixtureRun = runWavePlanDagDryRunV2(fixtureAdmission(), structuredClone(FIXTURE.dryRuns[0].request));
  assert.ok(fixtureRun.ok);
  if (!fixtureRun.ok) return;
  const projection = wavePlanDagStageFrontierProjectionV1(frontierInput({
    presentedReceipt: fixtureRun.receipt,
    latestReceiptDigest: fixtureRun.receipt.receiptDigest,
  }));
  assert.equal(projection.operator.receiptBasis, "receipt_stale");
});

test("frontier: aligned and divergent per-bound-task states", () => {
  const rootReceiptOpen = RECEIPT_NONE(); // root ready, nothing terminal

  const alignedOpen = wavePlanDagStageFrontierProjectionV1(frontierInput({
    presentedReceipt: rootReceiptOpen,
    latestReceiptDigest: rootReceiptOpen.receiptDigest,
  }));
  assert.deepEqual(alignedOpen.operator.stageFrontiers, [
    { stageId: "stg_aaaaaaaa", boundTasks: [{ taskId: "task-1", frontierState: "aligned_open" }] },
  ]);
  assert.equal(alignedOpen.operator.alignedOpenCount, 1);
  assert.equal(alignedOpen.public.alignedOpenCount, 1);

  // succeeded expects gate_passed on the receipt.
  const passed = RECEIPT_BOTH_PASSED();
  const alignedTerminal = wavePlanDagStageFrontierProjectionV1(frontierInput({
    presentedReceipt: passed,
    latestReceiptDigest: passed.receiptDigest,
    taskStatusOf: statusLookup({ "task-1": "succeeded" }),
  }));
  assert.equal(alignedTerminal.operator.stageFrontiers[0]?.boundTasks[0]?.frontierState, "aligned_terminal");
  assert.equal(alignedTerminal.operator.alignedTerminalCount, 1);

  // canceled accepts any terminal receipt state — even gate_failed.
  const failedReceipt = RECEIPT_BOTH_FAILED();
  const canceledAligned = wavePlanDagStageFrontierProjectionV1(frontierInput({
    presentedReceipt: failedReceipt,
    latestReceiptDigest: failedReceipt.receiptDigest,
    taskStatusOf: statusLookup({ "task-1": "canceled" }),
  }));
  assert.equal(canceledAligned.operator.stageFrontiers[0]?.boundTasks[0]?.frontierState, "aligned_terminal");

  // failed against a gate_passed receipt diverges.
  const taskTerminalReceiptMismatch = wavePlanDagStageFrontierProjectionV1(frontierInput({
    presentedReceipt: passed,
    latestReceiptDigest: passed.receiptDigest,
    taskStatusOf: statusLookup({ "task-1": "failed" }),
  }));
  assert.equal(
    taskTerminalReceiptMismatch.operator.stageFrontiers[0]?.boundTasks[0]?.frontierState,
    "divergence_task_terminal_receipt_open",
  );

  // succeeded while the receipt never reached terminality diverges too.
  const staleRehearsal = wavePlanDagStageFrontierProjectionV1(frontierInput({
    presentedReceipt: rootReceiptOpen,
    latestReceiptDigest: rootReceiptOpen.receiptDigest,
    taskStatusOf: statusLookup({ "task-1": "succeeded" }),
  }));
  assert.equal(
    staleRehearsal.operator.stageFrontiers[0]?.boundTasks[0]?.frontierState,
    "divergence_task_terminal_receipt_open",
  );

  // Receipt terminal while the task is still open: stuck or never dispatched.
  const receiptTerminalTaskOpen = wavePlanDagStageFrontierProjectionV1(frontierInput({
    presentedReceipt: passed,
    latestReceiptDigest: passed.receiptDigest,
  }));
  assert.equal(
    receiptTerminalTaskOpen.operator.stageFrontiers[0]?.boundTasks[0]?.frontierState,
    "divergence_receipt_terminal_task_open",
  );

  // Bound task no longer resolves.
  const missing = wavePlanDagStageFrontierProjectionV1(frontierInput({
    bindings: [bindingEntry(TWO_STAGE_DIGEST, "stg_aaaaaaaa", "task-gone")],
    presentedReceipt: rootReceiptOpen,
    latestReceiptDigest: rootReceiptOpen.receiptDigest,
    taskStatusOf: () => null,
  }));
  assert.equal(missing.operator.stageFrontiers[0]?.boundTasks[0]?.frontierState, "bound_task_missing");
  assert.equal(missing.operator.boundTaskMissingCount, 1);
});

test("frontier: leaf_unbound counts distinct unbound leaves on a branch/rejoin/orphan DAG", () => {
  // task-t1 (bound to the root stage)
  //   ├── task-t2 ── task-t4 (leaf, bound to the child stage)
  //   └── task-t3 ── task-t5 (leaf, unbound orphan)
  const leavesOf: Record<string, string[]> = {
    "task-t1": ["task-t4", "task-t5"],
    "task-t2": ["task-t4"],
    "task-t3": ["task-t5"],
  };
  const receipt = RECEIPT_NONE();
  const projection = wavePlanDagStageFrontierProjectionV1(frontierInput({
    bindings: [
      bindingEntry(TWO_STAGE_DIGEST, "stg_aaaaaaaa", "task-t1"),
      bindingEntry(TWO_STAGE_DIGEST, "stg_bbbbbbbb", "task-t4"),
    ],
    presentedReceipt: receipt,
    latestReceiptDigest: receipt.receiptDigest,
    taskStatusOf: statusLookup({ "task-t1": "queued", "task-t4": "queued" }),
    subtreeLeafTaskIds: (taskId) => leavesOf[taskId] ?? [],
  }));
  assert.equal(projection.operator.receiptBasis, "receipt_current");
  assert.deepEqual(projection.operator.unboundLeafTaskIds, ["task-t5"]);
  assert.equal(projection.operator.unboundLeafCount, 1);
  assert.equal(projection.operator.boundTaskCount, 2);
});

test("frontier: public projection carries closed enums and counts only", () => {
  const receipt = RECEIPT_NONE();
  const projection = wavePlanDagStageFrontierProjectionV1(frontierInput({
    bindings: [bindingEntry(TWO_STAGE_DIGEST, "stg_aaaaaaaa", "task-secret-id")],
    presentedReceipt: receipt,
    latestReceiptDigest: receipt.receiptDigest,
    subtreeLeafTaskIds: () => ["task-leaf-secret"],
  }));
  assert.equal(projection.public.kind, WAVE_PLAN_DAG_V2_STAGE_FRONTIER_PUBLIC_KIND);
  const encoded = JSON.stringify(projection.public);
  assert.ok(!encoded.includes("task-"), "no task ids may reach the public surface");
  assert.ok(!encoded.includes("stg_"), "no stage ids may reach the public surface");
  assert.ok(!encoded.includes("sha256:"), "no digests may reach the public surface");
  assert.ok(JSON.stringify(projection.operator).includes("task-secret-id"));
  assert.equal(projection.operator.alignedOpenCount, projection.public.alignedOpenCount);
});

test("frontier: unbound leaf counts clamp at the contract cap", () => {
  const receipt = RECEIPT_NONE();
  const manyLeaves = Array.from({ length: WAVE_PLAN_DAG_V2_BINDING_COUNT_CAP + 5 }, (_, i) => `leaf-${i}`);
  const projection = wavePlanDagStageFrontierProjectionV1(frontierInput({
    presentedReceipt: receipt,
    latestReceiptDigest: receipt.receiptDigest,
    subtreeLeafTaskIds: () => manyLeaves,
  }));
  assert.equal(projection.operator.unboundLeafCount, WAVE_PLAN_DAG_V2_BINDING_COUNT_CAP);
  assert.equal(projection.operator.unboundLeafCountCollapsedAtCap, true);
  assert.equal(projection.operator.unboundLeafTaskIds.length, WAVE_PLAN_DAG_V2_BINDING_COUNT_CAP);
});

// ---------------------------------------------------------------------------
// §9.2/§7 — broker write path (default-off, single explicit entry point)
// ---------------------------------------------------------------------------

function recordBroker() {
  return new InMemoryA2ABroker(undefined, undefined, { wavePlanDagV2Mode: "record" });
}

function createOpenTask(broker: InMemoryA2ABroker, taskId?: string, parentTaskId?: string) {
  // createTask resolves the target against registered workers.
  broker.registerWorker({
    nodeId: "worker-a",
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["ws1"],
      environments: ["research"],
    },
    metadata: {},
  });
  return broker.createTask({
    ...(taskId ? { id: taskId } : {}),
    ...(parentTaskId ? { parentTaskId } : {}),
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
  });
}

function completeTaskViaWorker(broker: InMemoryA2ABroker, taskId: string, status: "succeeded" | "failed" | "canceled") {
  broker.registerWorker({
    nodeId: "worker-a",
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["ws1"],
      environments: ["research"],
    },
    metadata: {},
  });
  broker.claimTask(taskId, "worker-a");
  broker.startTask(taskId, "worker-a");
  if (status === "succeeded") broker.completeTask(taskId, "worker-a", { summary: "done" });
  else if (status === "failed") broker.failTask(taskId, "worker-a", { message: "boom" });
  else broker.cancelTask(taskId, { actor: { id: "op", kind: "node", role: "operator" }, reason: "stop" });
}

test("broker binding surface is absent by default and off-mode writes return undefined", () => {
  const broker = new InMemoryA2ABroker();
  assert.equal(broker.recordWavePlanDagV2StageBinding({
    manifest: structuredClone(FIXTURE.manifest),
    manifestDigest: FIXTURE_DIGEST,
    stageId: ROOT_STAGE,
    taskId: "task-1",
    bindingSource: "operator",
  }), undefined);
  assert.deepEqual(broker.listWavePlanDagV2StageBindings(FIXTURE_DIGEST), []);
  assert.equal(broker.wavePlanDagV2StageFrontierProjection(FIXTURE_DIGEST, null), undefined);
});

test("broker write path: bind an open task end-to-end, then the mandatory refusal fires", () => {
  const broker = recordBroker();
  const intake = broker.recordWavePlanDagV2Intake(
    structuredClone(FIXTURE.manifest),
    structuredClone(FIXTURE.dryRuns[0].request),
  );
  assert.ok(Array.isArray(intake));

  const task = createOpenTask(broker, "task-open-1");
  const bound = broker.recordWavePlanDagV2StageBinding({
    manifest: structuredClone(FIXTURE.manifest),
    manifestDigest: FIXTURE_DIGEST,
    stageId: ROOT_STAGE,
    taskId: task.id,
    bindingSource: "operator",
  });
  assert.ok(bound && bound.ok);
  if (bound.ok) {
    assert.equal(bound.entry.entryType, "stage_task_binding_recorded");
    assert.equal(bound.followUp.state, "no_prior_binding");
    assert.equal(bound.duplicated, false);
  }
  assert.equal(broker.listWavePlanDagV2StageBindings(FIXTURE_DIGEST).length, 1);

  // §4.2 step 4 is literal at the write path: the stage's bound set contains
  // an open task, so even an identical redelivery of that binding is refused
  // here. Idempotent collapse (skippedDuplicates) is the LEDGER pin (§4.3,
  // §9.1) and stays reachable at the store layer and over terminal stages.
  const replay = broker.recordWavePlanDagV2StageBinding({
    manifest: structuredClone(FIXTURE.manifest),
    manifestDigest: FIXTURE_DIGEST,
    stageId: ROOT_STAGE,
    taskId: task.id,
    bindingSource: "operator",
  });
  assert.ok(replay && !replay.ok && replay.reason === "duplicate_open_binding");

  // §5 mandatory refusal: a second open task must not bind while the first is open.
  const second = createOpenTask(broker, "task-open-2");
  const refused = broker.recordWavePlanDagV2StageBinding({
    manifest: structuredClone(FIXTURE.manifest),
    manifestDigest: FIXTURE_DIGEST,
    stageId: ROOT_STAGE,
    taskId: second.id,
    bindingSource: "operator",
  });
  assert.ok(refused && !refused.ok && refused.reason === "duplicate_open_binding");
  assert.equal(broker.listWavePlanDagV2StageBindings(FIXTURE_DIGEST).length, 1);
  assert.equal(broker.wavePlanDagV2RecordDiagnostics().rejected, 2);

  // bindingSource conflict on the same triple rejects at the store layer once
  // the §4.2 gate passes (the bound task has gone terminal by then, below).

  // Re-work: after the bound task goes terminal, re-binding is admissible,
  // counted, and every row stays visible (§4.2 step 4, §4.3).
  completeTaskViaWorker(broker, task.id, "succeeded");

  // §4.2 order pin: step 3 (task gates) runs before the §5 gate, so a
  // re-presentation of the now-terminal task's binding is `task_not_open` —
  // write-path redelivery is governed by the precondition order, while
  // ledger-level idempotent collapse (skippedDuplicates) stays the §4.3/§9.1
  // store pin (exercised in the ledger tests above).
  const terminalRedelivery = broker.recordWavePlanDagV2StageBinding({
    manifest: structuredClone(FIXTURE.manifest),
    manifestDigest: FIXTURE_DIGEST,
    stageId: ROOT_STAGE,
    taskId: task.id,
    bindingSource: "operator",
  });
  assert.ok(terminalRedelivery && !terminalRedelivery.ok && terminalRedelivery.reason === "task_not_open");

  const rework = broker.recordWavePlanDagV2StageBinding({
    manifest: structuredClone(FIXTURE.manifest),
    manifestDigest: FIXTURE_DIGEST,
    stageId: ROOT_STAGE,
    taskId: second.id,
    bindingSource: "operator",
  });
  assert.ok(rework && rework.ok && rework.followUp.state === "prior_binding_terminal");
  const rows = broker.listWavePlanDagV2StageBindings(FIXTURE_DIGEST);
  assert.equal(rows.length, 2, "every re-binding stays visible");
  assert.ok(rows.every((row) => row.entryType === "stage_task_binding_recorded"));
});

test("broker write path: unknown manifest, unknown stage, and unknown task refusals", () => {
  const broker = recordBroker();

  // Manifest never admitted on this ledger.
  const neverAdmitted = broker.recordWavePlanDagV2StageBinding({
    manifest: structuredClone(FIXTURE.manifest),
    manifestDigest: FIXTURE_DIGEST,
    stageId: ROOT_STAGE,
    taskId: "task-1",
    bindingSource: "operator",
  });
  assert.ok(neverAdmitted && !neverAdmitted.ok && neverAdmitted.reason === "manifest_not_known");

  // Admitted, but the requested digest does not match the presented payload.
  broker.recordWavePlanDagV2Intake(structuredClone(FIXTURE.manifest));
  const wrongDigest = broker.recordWavePlanDagV2StageBinding({
    manifest: structuredClone(FIXTURE.manifest),
    manifestDigest: `sha256:${"e".repeat(64)}`,
    stageId: ROOT_STAGE,
    taskId: "task-1",
    bindingSource: "operator",
  });
  assert.ok(wrongDigest && !wrongDigest.ok && wrongDigest.reason === "manifest_not_known");

  const task = createOpenTask(broker, "task-1");
  const unknownStage = broker.recordWavePlanDagV2StageBinding({
    manifest: structuredClone(FIXTURE.manifest),
    manifestDigest: FIXTURE_DIGEST,
    stageId: "stg_ffffffff",
    taskId: task.id,
    bindingSource: "operator",
  });
  assert.ok(unknownStage && !unknownStage.ok && unknownStage.reason === "unknown_stage");

  const unknownTask = broker.recordWavePlanDagV2StageBinding({
    manifest: structuredClone(FIXTURE.manifest),
    manifestDigest: FIXTURE_DIGEST,
    stageId: ROOT_STAGE,
    taskId: "task-never-created",
    bindingSource: "operator",
  });
  assert.ok(unknownTask && !unknownTask.ok && unknownTask.reason === "task_unknown");

  completeTaskViaWorker(broker, task.id, "failed");
  const notOpen = broker.recordWavePlanDagV2StageBinding({
    manifest: structuredClone(FIXTURE.manifest),
    manifestDigest: FIXTURE_DIGEST,
    stageId: ROOT_STAGE,
    taskId: task.id,
    bindingSource: "operator",
  });
  assert.ok(notOpen && !notOpen.ok && notOpen.reason === "task_not_open");
});

test("broker frontier projection reads the ledger basis and live lineage", () => {
  const broker = recordBroker();
  broker.recordWavePlanDagV2Intake(structuredClone(FIXTURE.manifest));

  // Parent + two children; one child carries a stage binding of its own.
  createOpenTask(broker, "task-parent");
  createOpenTask(broker, "task-child-bound", "task-parent");
  createOpenTask(broker, "task-child-orphan", "task-parent");
  const boundChild = broker.getTask("task-child-bound");
  assert.ok(boundChild);
  broker.cancelTask(boundChild.id, { actor: { id: "op", kind: "node", role: "operator" }, reason: "rebind" });

  const admission = broker.recordWavePlanDagV2StageBinding({
    manifest: structuredClone(FIXTURE.manifest),
    manifestDigest: FIXTURE_DIGEST,
    stageId: ROOT_STAGE,
    taskId: "task-parent",
    bindingSource: "operator",
  });
  assert.ok(admission && admission.ok);

  // No rehearsal receipt recorded on this manifest → receipt_missing.
  const projection = broker.wavePlanDagV2StageFrontierProjection(FIXTURE_DIGEST, null);
  assert.ok(projection);
  assert.equal(projection ? projection.operator.receiptBasis : "", "receipt_missing");

  // Rehearse (records the receipt row), then present the receipt → current
  // basis. Fixture vector 0 marks the root stage terminal (gate_passed) while
  // the bound task is still open: the stuck/never-dispatched divergence.
  broker.recordWavePlanDagV2Intake(
    structuredClone(FIXTURE.manifest),
    structuredClone(FIXTURE.dryRuns[0].request),
  );
  const run = runWavePlanDagDryRunV2(fixtureAdmission(), structuredClone(FIXTURE.dryRuns[0].request));
  assert.ok(run.ok);
  if (!run.ok) return;

  // Bind a second open task to a stage the receipt does NOT hold terminal →
  // plan and reality agree work is in flight. task-child-orphan doubles as
  // the subtree's bound leaf, sharpening the unbound-leaf count below.
  const openStage = run.receipt.stages.find((signal) => signal.state !== "terminal");
  assert.ok(openStage);
  createOpenTask(broker, "task-child-orphan");
  const openStageBound = broker.recordWavePlanDagV2StageBinding({
    manifest: structuredClone(FIXTURE.manifest),
    manifestDigest: FIXTURE_DIGEST,
    stageId: openStage.stageId,
    taskId: "task-child-orphan",
    bindingSource: "operator",
  });
  assert.ok(openStageBound && openStageBound.ok);

  const afterReceipt = broker.wavePlanDagV2StageFrontierProjection(FIXTURE_DIGEST, run.receipt);
  assert.ok(afterReceipt && afterReceipt.operator.receiptBasis === "receipt_current");
  const stuckRow = afterReceipt.operator.stageFrontiers.find((stage) => stage.stageId === ROOT_STAGE);
  assert.equal(stuckRow?.boundTasks[0]?.taskId, "task-parent");
  assert.equal(stuckRow?.boundTasks[0]?.frontierState, "divergence_receipt_terminal_task_open");
  const alignedRow = afterReceipt.operator.stageFrontiers.find((stage) => stage.stageId === openStage.stageId);
  assert.equal(alignedRow?.boundTasks[0]?.taskId, "task-child-orphan");
  assert.equal(alignedRow?.boundTasks[0]?.frontierState, "aligned_open");
  // Real parentTaskId leaf walk: task-parent's subtree leaves are the two
  // child tasks; only task-child-bound carries no stage binding.
  assert.deepEqual(afterReceipt.operator.unboundLeafTaskIds, ["task-child-bound"]);
  assert.equal(afterReceipt.operator.unboundLeafCount, 1);
  assert.ok(afterReceipt.public.unboundLeafCount === 1);
});

test("broker receipt-payload retention is an explicit, off-absent, idempotent write entry", () => {
  const offBroker = new InMemoryA2ABroker();
  assert.equal(
    offBroker.recordWavePlanDagV2ReceiptPayload(structuredClone(FIXTURE.manifest), structuredClone(FIXTURE.dryRuns[0].request)),
    undefined,
  );

  const broker = recordBroker();
  broker.recordWavePlanDagV2Intake(structuredClone(FIXTURE.manifest));
  const first = broker.recordWavePlanDagV2ReceiptPayload(
    structuredClone(FIXTURE.manifest),
    structuredClone(FIXTURE.dryRuns[0].request),
  );
  assert.ok(first && first.ok);
  if (first.ok) {
    assert.equal(first.entry.entryType, "rehearsal_receipt_payload_recorded");
    assert.equal(first.entry.receiptDigest, FIXTURE.dryRuns[0].receipt.receiptDigest);
    assert.equal(first.duplicated, false);
  }

  // Idempotent replay collapses with a counted duplicate.
  const replay = broker.recordWavePlanDagV2ReceiptPayload(
    structuredClone(FIXTURE.manifest),
    structuredClone(FIXTURE.dryRuns[0].request),
  );
  assert.ok(replay && replay.ok && replay.duplicated);
  const diagnostics = broker.wavePlanDagV2RecordDiagnostics();
  assert.equal(diagnostics.appends, 2);
  assert.equal(diagnostics.duplicates, 1);
  assert.equal(diagnostics.rejected, 0);

  // Flow ordering at the write path: no admission on the ledger, no
  // retention (§4.2 step 1 posture).
  const otherBroker = recordBroker();
  const neverAdmitted = otherBroker.recordWavePlanDagV2ReceiptPayload(
    structuredClone(FIXTURE.manifest),
    structuredClone(FIXTURE.dryRuns[0].request),
  );
  assert.ok(neverAdmitted && !neverAdmitted.ok && neverAdmitted.reason === "manifest_not_known");

  // A rejected rehearsal is counted, never stored.
  const badRequest = structuredClone(FIXTURE.dryRuns[0].request) as Record<string, unknown>;
  (badRequest.outcomes as Array<Record<string, unknown>>)[0].outcome = "completed";
  const rejected = broker.recordWavePlanDagV2ReceiptPayload(structuredClone(FIXTURE.manifest), badRequest);
  assert.ok(rejected && !rejected.ok && rejected.reason === "unknown_outcome");

  // Non-admittable manifests are counted, never stored.
  const broken = { ...structuredClone(FIXTURE.manifest), prompt: "forbidden" };
  const notAdmitted = broker.recordWavePlanDagV2ReceiptPayload(broken, structuredClone(FIXTURE.dryRuns[0].request));
  assert.ok(notAdmitted && !notAdmitted.ok && notAdmitted.reason === "manifest_malformed");
  assert.equal(broker.wavePlanDagV2RecordDiagnostics().rejected, 2);
});

test("broker stage-frontier from the ledger: missing → not-retained → current", () => {
  const broker = recordBroker();
  broker.recordWavePlanDagV2Intake(structuredClone(FIXTURE.manifest));

  // Admitted-unrehearsed: no frontier claims.
  const missing = broker.wavePlanDagV2StageFrontierProjectionFromLedger(FIXTURE_DIGEST);
  assert.ok(missing && missing.operator.receiptBasis === "receipt_missing");

  // The intake rehearsal records a digest-only receipt row; without explicit
  // retention the ledger-driven projection refuses instead of guessing.
  broker.recordWavePlanDagV2Intake(
    structuredClone(FIXTURE.manifest),
    structuredClone(FIXTURE.dryRuns[0].request),
  );
  const notRetained = broker.wavePlanDagV2StageFrontierProjectionFromLedger(FIXTURE_DIGEST);
  assert.ok(notRetained && notRetained.operator.receiptBasis === "receipt_payload_not_retained");
  assert.deepEqual(notRetained ? notRetained.operator.stageFrontiers : [], []);

  // Retention completes the §11.1.3 chain: the ledger now carries the
  // payload of the latest recorded rehearsal.
  const retained = broker.recordWavePlanDagV2ReceiptPayload(
    structuredClone(FIXTURE.manifest),
    structuredClone(FIXTURE.dryRuns[0].request),
  );
  assert.ok(retained && retained.ok);
  const current = broker.wavePlanDagV2StageFrontierProjectionFromLedger(FIXTURE_DIGEST);
  assert.ok(current && current.operator.receiptBasis === "receipt_current");
  assert.equal(current ? current.operator.receiptDigest : "", FIXTURE.dryRuns[0].receipt.receiptDigest);
  // Fixture vector 0 holds the root stage terminal/gate_passed; with no
  // bindings the operator surface simply has no stage rows yet.
  assert.deepEqual(current ? current.operator.stageFrontiers : [], []);
});

test("broker stage-frontier from the ledger: a retained older payload is not the latest basis", () => {
  const broker = recordBroker();
  broker.recordWavePlanDagV2Intake(
    structuredClone(FIXTURE.manifest),
    structuredClone(FIXTURE.dryRuns[0].request),
  );
  assert.ok(
    broker.recordWavePlanDagV2ReceiptPayload(structuredClone(FIXTURE.manifest), structuredClone(FIXTURE.dryRuns[0].request))?.ok,
  );

  // A second rehearsal supersedes the retained payload; that newer receipt's
  // own payload was never retained, so the projection refuses.
  const second = broker.recordWavePlanDagV2Intake(
    structuredClone(FIXTURE.manifest),
    structuredClone(FIXTURE.dryRuns[1].request),
  );
  assert.ok(Array.isArray(second));
  const projection = broker.wavePlanDagV2StageFrontierProjectionFromLedger(FIXTURE_DIGEST);
  assert.ok(projection && projection.operator.receiptBasis === "receipt_payload_not_retained");
});

// ---------------------------------------------------------------------------
// §7 — read-only GETs (mode-gated). Per §11.1.3 (operator ruling,
// 2026-09-14) BOTH read surfaces ship: `bindings` and `stage-frontier`, the
// latter driven by the ledger's latest retained receipt payload.
// ---------------------------------------------------------------------------

function routeContext(broker: InMemoryA2ABroker, method: string, path: string, search = "") {
  return {
    ctx: {
      method,
      path,
      req: {} as import("node:http").IncomingMessage,
      res: null as unknown as import("node:http").ServerResponse,
      broker,
      enforceRequesterIdentity: false,
      requesterIdentity: null,
    },
    url: new URL(`http://broker.test${path}${search}`),
  };
}

function captureResponse() {
  let body = "";
  const res = {
    writeHead() { return res; },
    setHeader() {},
    write(chunk?: string | Uint8Array) {
      if (chunk !== undefined) body += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
    end(chunk?: string | Uint8Array) {
      if (chunk !== undefined) body += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    },
  } as unknown as import("node:http").ServerResponse;
  return { res, body: () => body };
}

test("bindings GET serves ledger rows in record mode and is absent when off", async () => {
  const broker = recordBroker();
  broker.recordWavePlanDagV2Intake(structuredClone(FIXTURE.manifest));
  const task = createOpenTask(broker, "task-route-1");
  assert.ok(broker.recordWavePlanDagV2StageBinding({
    manifest: structuredClone(FIXTURE.manifest),
    manifestDigest: FIXTURE_DIGEST,
    stageId: ROOT_STAGE,
    taskId: task.id,
    bindingSource: "operator",
  })?.ok);

  const get = routeContext(broker, "GET", "/wave-plan-dag-v2/bindings", `?manifestDigest=${encodeURIComponent(FIXTURE_DIGEST)}`);
  const captured = captureResponse();
  get.ctx.res = captured.res;
  assert.equal(await handleWavePlanDagV2RoutesIfMatched(get.ctx, get.url), true);
  const parsed = JSON.parse(captured.body());
  assert.equal(parsed.kind, "wave-plan-dag-v2-bindings");
  assert.equal(parsed.mode, "record");
  assert.equal(parsed.count, 1);
  assert.equal(parsed.bindings[0].taskId, "task-route-1");
  assert.equal(parsed.bindings[0].stageId, ROOT_STAGE);

  // Off mode: the binding surface is absent — the route falls through.
  const offBroker = new InMemoryA2ABroker();
  const off = routeContext(offBroker, "GET", "/wave-plan-dag-v2/bindings", `?manifestDigest=${encodeURIComponent(FIXTURE_DIGEST)}`);
  assert.equal(await handleWavePlanDagV2RoutesIfMatched(off.ctx, off.url), false);

  // Fail-closed query validation.
  const bad = routeContext(broker, "GET", "/wave-plan-dag-v2/bindings", "?manifestDigest=nope");
  await assert.rejects(
    () => handleWavePlanDagV2RoutesIfMatched(bad.ctx, bad.url),
    (error) => error instanceof BrokerError && error.code === "bad_request",
  );
});

test("stage-frontier GET serves the ledger-driven projection and is absent when off", async () => {
  const broker = recordBroker();
  broker.recordWavePlanDagV2Intake(
    structuredClone(FIXTURE.manifest),
    structuredClone(FIXTURE.dryRuns[0].request),
  );
  const task = createOpenTask(broker, "task-frontier-1");
  assert.ok(broker.recordWavePlanDagV2StageBinding({
    manifest: structuredClone(FIXTURE.manifest),
    manifestDigest: FIXTURE_DIGEST,
    stageId: ROOT_STAGE,
    taskId: task.id,
    bindingSource: "operator",
  })?.ok);

  // Without explicit retention the GET reports the §11.1.3 refusal basis.
  const beforeRetention = routeContext(broker, "GET", "/wave-plan-dag-v2/stage-frontier", `?manifestDigest=${encodeURIComponent(FIXTURE_DIGEST)}`);
  const beforeCapture = captureResponse();
  beforeRetention.ctx.res = beforeCapture.res;
  assert.equal(await handleWavePlanDagV2RoutesIfMatched(beforeRetention.ctx, beforeRetention.url), true);
  const before = JSON.parse(beforeCapture.body());
  assert.equal(before.kind, "wave-plan-dag-v2-stage-frontier");
  assert.equal(before.mode, "record");
  assert.equal(before.public.receiptBasis, "receipt_payload_not_retained");
  assert.deepEqual(before.operator.stageFrontiers, []);

  // Retention completes the chain: receipt_current with the §6 divergence
  // (fixture vector 0 holds the root stage terminal/gate_passed while the
  // bound task is still open) and the §6 surface split intact.
  assert.ok(
    broker.recordWavePlanDagV2ReceiptPayload(structuredClone(FIXTURE.manifest), structuredClone(FIXTURE.dryRuns[0].request))?.ok,
  );
  const get = routeContext(broker, "GET", "/wave-plan-dag-v2/stage-frontier", `?manifestDigest=${encodeURIComponent(FIXTURE_DIGEST)}`);
  const captured = captureResponse();
  get.ctx.res = captured.res;
  assert.equal(await handleWavePlanDagV2RoutesIfMatched(get.ctx, get.url), true);
  const parsed = JSON.parse(captured.body());
  assert.equal(parsed.kind, "wave-plan-dag-v2-stage-frontier");
  assert.equal(parsed.mode, "record");
  assert.equal(parsed.manifestDigest, FIXTURE_DIGEST);
  assert.equal(parsed.public.receiptBasis, "receipt_current");
  assert.equal(parsed.operator.receiptDigest, FIXTURE.dryRuns[0].receipt.receiptDigest);
  assert.equal(parsed.operator.stageFrontiers[0].stageId, ROOT_STAGE);
  assert.equal(parsed.operator.stageFrontiers[0].boundTasks[0].taskId, "task-frontier-1");
  assert.equal(
    parsed.operator.stageFrontiers[0].boundTasks[0].frontierState,
    "divergence_receipt_terminal_task_open",
  );
  assert.equal(parsed.public.boundTaskCount, 1);
  assert.equal(parsed.public.divergenceReceiptTerminalTaskOpenCount, 1);
  assert.ok(!JSON.stringify(parsed.public).includes("task-"), "no task ids may reach the public surface");
  assert.ok(!JSON.stringify(parsed.public).includes("stg_"), "no stage ids may reach the public surface");
  assert.ok(!JSON.stringify(parsed.public).includes("sha256:"), "no digests may reach the public surface");
  assert.ok(JSON.stringify(parsed.operator).includes("task-frontier-1"));

  // Off mode: the frontier surface is absent — the route falls through.
  const offBroker = new InMemoryA2ABroker();
  const off = routeContext(offBroker, "GET", "/wave-plan-dag-v2/stage-frontier", `?manifestDigest=${encodeURIComponent(FIXTURE_DIGEST)}`);
  assert.equal(await handleWavePlanDagV2RoutesIfMatched(off.ctx, off.url), false);

  // Fail-closed query validation.
  const badQuery = routeContext(broker, "GET", "/wave-plan-dag-v2/stage-frontier", "?manifestDigest=nope");
  await assert.rejects(
    () => handleWavePlanDagV2RoutesIfMatched(badQuery.ctx, badQuery.url),
    (error) => error instanceof BrokerError && error.code === "bad_request",
  );
});

// ---------------------------------------------------------------------------
// §9.4 — non-interference pins
// ---------------------------------------------------------------------------

test("classifier verdicts and frozen manifest digest are unchanged by the binding slice", () => {
  const v1Record = classifyWavePlanIntake({ wavePlanId: "w1", stages: [{ id: "s", gate: { type: "manual" } }] });
  assert.deepEqual(v1Record, {
    kind: "WavePlanDagV2IntakeRecordV1",
    version: 1,
    routesTo: "v1_wave_plan_spec",
    observedKind: null,
  });

  const v2Record = classifyWavePlanIntake(structuredClone(FIXTURE.manifest));
  assert.ok(v2Record.routesTo === "v2_rehearsal_candidate");
  if (v2Record.routesTo === "v2_rehearsal_candidate") {
    assert.equal(v2Record.manifestDigest, FIXTURE_DIGEST);
    assert.equal(v2Record.stageCount, 8);
  }

  assert.equal(fixtureAdmission().manifest.manifestDigest, FIXTURE_DIGEST,
    "frozen manifest schema and digest unchanged");
});
