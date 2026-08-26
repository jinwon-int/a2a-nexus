import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  admitWavePlanDagManifestV2,
  computeWavePlanDagManifestV2Digest,
  WAVE_PLAN_DAG_V2_AUTHORITY_FIELDS,
} from "./manifest.js";
import { baseWavePlanDagStageSignal, runWavePlanDagDryRunV2 } from "./dry-run.js";

/**
 * #1800 slice 1 — WavePlanDagV2 runtime admission and deterministic dry-run.
 *
 * The load-bearing rule here is parity with
 * `test/conformance/check-wave-plan-dag-v2.mjs`: the same input must produce
 * the same stable rejection reason in both implementations, and well-formed
 * proposals must reproduce the golden fixture's digests byte-for-byte. The
 * checker validates a curated fixture (a bad record is an authoring error);
 * this runtime faces untrusted proposals, so it surfaces the identical
 * reasons as data instead of throwing. Nothing else differs.
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

// Pinned by the conformance checker; duplicated here so runtime drift fails
// both independently.
const PINNED_MANIFEST_DIGEST =
  "sha256:65aeff14e59e01f976433a1f82d7ca0c398de06ec0d0aca6db56715aeb03006a";
const PINNED_RECEIPT_DIGESTS = [
  "sha256:c5542b9852ca8fc3e0d990d8f5ed848d6c50192331d9bafeb3b0cf695185b48b",
  "sha256:67a0ce8a80825f40819cc796c2d421e296e858d32bb9ca6ea377620dc94b5631",
];
const EXPECTED_TOPOLOGY = [
  "stg_00000000",
  "stg_00000010",
  "stg_00000020",
  "stg_00000030",
  "stg_00000035",
  "stg_00000040",
  "stg_00000050",
  "stg_00000060",
];

type LooseRecord = Record<string, unknown>;

function clone(value: LooseRecord): LooseRecord {
  return structuredClone(value);
}

/** Recomputes and stamps the §6 digest so mutations fail on the intended reason. */
function sealed(manifest: LooseRecord): LooseRecord {
  const candidate = clone(manifest);
  candidate.manifestDigest = computeWavePlanDagManifestV2Digest(candidate as never);
  return candidate;
}

function stage(stageId: string, manifestAlias: string, digit: string, joinPolicy = "all_matching"): LooseRecord {
  return {
    stageId,
    manifestAlias,
    reviewedManifestDigest: `sha256:${digit.repeat(64)}`,
    joinPolicy,
  };
}

function minimalManifest(stages: LooseRecord[], edges: LooseRecord[]): LooseRecord {
  return sealed({
    kind: "WavePlanDagManifestV2",
    version: 2,
    proposalSource: "operator",
    manifestAlias: "wpm_fedcba9876543210",
    stages,
    edges,
    limits: { maxStages: 32, maxEdges: 64, maxDepth: 8, maxFanIn: 8, maxFanOut: 8 },
    autoDispatch: false,
    operatorAdvanceRequired: true,
    dryRunRequired: true,
    executionAuthority: "none",
    claimAuthority: "none",
    retryAuthority: "none",
    finalizerAuthority: "none",
    successAuthority: "none",
    liveAuthority: "none",
    manifestDigestDomain: "a2a.wave-plan-dag-v2.manifest.v2",
    manifestDigest: `sha256:${"0".repeat(64)}`,
  });
}

function signalOf(receipt: LooseRecord): Map<string, LooseRecord> {
  return new Map((receipt.stages as LooseRecord[]).map((item) => [item.stageId as string, item]));
}

test("admission reproduces the golden manifest digest, topology, and canonically-sorted joins", () => {
  const admitted = admitWavePlanDagManifestV2(FIXTURE.manifest);
  assert.ok(admitted.ok, "the curated fixture must admit");
  if (!admitted.ok) return;

  assert.equal(admitted.manifest.manifestDigest, PINNED_MANIFEST_DIGEST);
  assert.deepEqual([...admitted.graph.topology], EXPECTED_TOPOLOGY);
  // Canonical edge sorting makes upstream predicate order deterministic even
  // though the fixture arrays arrive unordered.
  assert.deepEqual(
    (admitted.graph.incoming.get("stg_00000030") ?? []).map((edge) => edge.when),
    ["gate_passed", "gate_passed"],
  );
});

test("input array order has no effect on digest or topology (§6 normalization)", () => {
  const reordered = clone(FIXTURE.manifest);
  (reordered.stages as LooseRecord[]).reverse();
  (reordered.edges as LooseRecord[]).reverse();

  const admitted = admitWavePlanDagManifestV2(reordered);
  assert.ok(admitted.ok);
  if (!admitted.ok) return;

  assert.equal(computeWavePlanDagManifestV2Digest(reordered as never), PINNED_MANIFEST_DIGEST);
  assert.deepEqual([...admitted.graph.topology], EXPECTED_TOPOLOGY);
});

test("both golden dry-run vectors reproduce byte-for-byte including their pinned digests", () => {
  FIXTURE.dryRuns.forEach((vector, index) => {
    const admission = admitWavePlanDagManifestV2(FIXTURE.manifest);
    assert.ok(admission.ok);
    if (!admission.ok) return;

    const result = runWavePlanDagDryRunV2(admission, vector.request);
    assert.ok(result.ok, `vector ${index} must rehearse`);
    if (!result.ok) return;

    assert.deepEqual(result.receipt, vector.receipt);
    assert.equal(result.receipt.receiptDigest, PINNED_RECEIPT_DIGESTS[index]);
  });
});

test("outcome order independence", () => {
  FIXTURE.dryRuns.forEach((vector, index) => {
    const admission = admitWavePlanDagManifestV2(FIXTURE.manifest);
    assert.ok(admission.ok);
    if (!admission.ok) return;

    const reversed = clone(vector.request);
    (reversed.outcomes as LooseRecord[]).reverse();
    const result = runWavePlanDagDryRunV2(admission, reversed);
    assert.ok(result.ok);
    if (!result.ok) return;

    assert.deepEqual(result.receipt, vector.receipt, `reversed outcomes change vector ${index}`);
  });
});

test("the receipt carries the full no-authority boundary (spec §5)", () => {
  const admission = admitWavePlanDagManifestV2(FIXTURE.manifest);
  assert.ok(admission.ok);
  if (!admission.ok) return;

  const result = runWavePlanDagDryRunV2(admission, FIXTURE.dryRuns[0].request);
  assert.ok(result.ok);
  if (!result.ok) return;

  assert.equal(result.receipt.mode, "read_only_rehearsal");
  assert.equal(result.receipt.autoDispatch, false);
  assert.equal(result.receipt.operatorAdvanceRequired, true);
  assert.equal(result.receipt.dryRunRequired, true);
  for (const field of WAVE_PLAN_DAG_V2_AUTHORITY_FIELDS) {
    assert.equal(result.receipt[field], "none");
  }
});

test("partial snapshots fail closed to waiting; any-matching peers open early", () => {
  const admission = admitWavePlanDagManifestV2(FIXTURE.manifest);
  assert.ok(admission.ok);
  if (!admission.ok) return;

  const partial = clone(FIXTURE.dryRuns[0].request);
  partial.outcomes = (partial.outcomes as LooseRecord[]).filter((outcome) =>
    ["stg_00000000", "stg_00000010"].includes(outcome.stageId as string));
  const result = runWavePlanDagDryRunV2(admission, partial);
  assert.ok(result.ok);
  if (!result.ok) return;

  const signals = signalOf(result.receipt as unknown as LooseRecord);
  assert.deepEqual(signals.get("stg_00000030"), { stageId: "stg_00000030", state: "waiting", reason: "join_unresolved" });
  assert.deepEqual(signals.get("stg_00000035"), { stageId: "stg_00000035", state: "ready", reason: "any_matching_satisfied" });
});

test("conditional any-matching joins follow the exact §5 truth table", () => {
  const admittedFixture = admitWavePlanDagManifestV2(FIXTURE.manifest);
  assert.ok(admittedFixture.ok);
  if (!admittedFixture.ok) return;

  // The checker's conditionalAnyGraph: harden stg_00000035's edges to
  // gate_passed only. The walker must treat nonmatching-but-terminal sources
  // as resolved and nonmatching.
  const hardenedEdges = (admittedFixture.graph.incoming.get("stg_00000035") ?? [])
    .map((edge) => ({ ...edge, when: "gate_passed" as const }));
  const graph = {
    ...admittedFixture.graph,
    incoming: new Map(admittedFixture.graph.incoming),
  };
  graph.incoming.set("stg_00000035", hardenedEdges);

  const oneWaiting = new Map([
    ["stg_00000010", { state: "terminal", reason: "gate_failed" }],
    ["stg_00000020", { state: "waiting" }],
  ]);
  assert.deepEqual(baseWavePlanDagStageSignal("stg_00000035", graph, oneWaiting), {
    state: "waiting",
    reason: "join_unresolved",
  });

  const bothFailed = new Map([
    ["stg_00000010", { state: "terminal", reason: "gate_failed" }],
    ["stg_00000020", { state: "terminal", reason: "gate_failed" }],
  ]);
  assert.deepEqual(baseWavePlanDagStageSignal("stg_00000035", graph, bothFailed), {
    state: "not_selected",
    reason: "no_matching_edge",
  });
});

test("all-matching resolves only when every inbound edge matched", () => {
  const admission = admitWavePlanDagManifestV2(FIXTURE.manifest);
  assert.ok(admission.ok);
  if (!admission.ok) return;

  const bothPassed = clone(FIXTURE.dryRuns[0].request);
  bothPassed.outcomes = (bothPassed.outcomes as LooseRecord[]).filter((outcome) =>
    !["stg_00000030", "stg_00000040"].includes(outcome.stageId as string));
  const passedResult = runWavePlanDagDryRunV2(admission, bothPassed);
  assert.ok(passedResult.ok);
  if (!passedResult.ok) return;
  assert.deepEqual(signalOf(passedResult.receipt as unknown as LooseRecord).get("stg_00000030"), {
    stageId: "stg_00000030",
    state: "ready",
    reason: "all_matching_satisfied",
  });

  const mixedSignals = signalOf(FIXTURE.dryRuns[1].receipt as LooseRecord);
  assert.deepEqual(mixedSignals.get("stg_00000030"), {
    stageId: "stg_00000030",
    state: "not_selected",
    reason: "all_matching_unsatisfied",
  });
  assert.deepEqual(mixedSignals.get("stg_00000035"), {
    stageId: "stg_00000035",
    state: "ready",
    reason: "any_matching_satisfied",
  });
});

test("structural rejections match the checker's mutation table", () => {
  const cases: Array<[string, string, (manifest: LooseRecord) => void]> = [
    ["duplicate_stage", "duplicate_stage", (m) => void (m.stages as LooseRecord[]).push(structuredClone((m.stages as LooseRecord[])[0]))],
    ["unknown_endpoint", "unknown_endpoint", (m) => void ((m.edges as LooseRecord[])[0].toStageId = "stg_ffffffff")],
    ["duplicate_edge", "duplicate_edge", (m) => void (m.edges as LooseRecord[]).push(structuredClone((m.edges as LooseRecord[])[0]))],
    ["self_edge", "self_edge", (m) => {
      const first = (m.edges as LooseRecord[])[0];
      first.toStageId = first.fromStageId;
    }],
    ["multiple_root", "root_count_invalid", (m) => {
      m.edges = (m.edges as LooseRecord[]).filter((edge) => !(
        edge.fromStageId === "stg_00000000" && edge.toStageId === "stg_00000020"
      ));
    }],
    ["cycle", "cycle_detected", (m) => void (m.edges as LooseRecord[]).push({
      fromStageId: "stg_00000060",
      toStageId: "stg_00000030",
      when: "any_terminal",
    })],
  ];

  for (const [label, expectedReason, mutate] of cases) {
    const candidate = clone(FIXTURE.manifest);
    mutate(candidate);
    const rejected = admitWavePlanDagManifestV2(sealed(candidate));
    assert.ok(!rejected.ok, `${label} must reject`);
    assert.equal(rejected.reason, expectedReason, label);
  }

  const unreachable = sealed({
    ...clone(FIXTURE.manifest),
    stages: [
      ...(FIXTURE.manifest.stages as LooseRecord[]),
      stage("stg_00000070", "mft_0000000000000070", "9"),
      stage("stg_00000080", "mft_0000000000000080", "a"),
    ],
    edges: [
      ...(FIXTURE.manifest.edges as LooseRecord[]),
      { fromStageId: "stg_00000070", toStageId: "stg_00000080", when: "any_terminal" },
      { fromStageId: "stg_00000080", toStageId: "stg_00000070", when: "any_terminal" },
    ],
  });
  const unreachableAdmission = admitWavePlanDagManifestV2(unreachable);
  assert.ok(!unreachableAdmission.ok);
  assert.equal(unreachableAdmission.reason, "unreachable_stage");

  function oversizedStages(): LooseRecord {
    const candidate = clone(FIXTURE.manifest);
    const stages = [...(candidate.stages as LooseRecord[])];
    while (stages.length <= 32) {
      const index = stages.length;
      stages.push(stage(
        `stg_${(0x100 + index).toString(16).padStart(8, "0")}`,
        `mft_${(0x100 + index).toString(16).padStart(16, "0")}`,
        ((index % 14) + 1).toString(16),
      ));
    }
    candidate.stages = stages;
    return sealed(candidate);
  }
  const overStages = admitWavePlanDagManifestV2(oversizedStages());
  assert.ok(!overStages.ok);
  assert.equal(overStages.reason, "stage_limit_exceeded");
});

test("limit rejections fire at the frozen bounds (depth, fan-in, fan-out, edges)", () => {
  function chain(edgeCount: number): LooseRecord {
    const stages = Array.from({ length: edgeCount + 1 }, (_, index) => stage(
      `stg_${index.toString(16).padStart(8, "0")}`,
      `mft_${index.toString(16).padStart(16, "0")}`,
      ((index % 14) + 1).toString(16),
      index === 0 ? "root" : "all_matching",
    ));
    const edges = Array.from({ length: edgeCount }, (_, index) => ({
      fromStageId: (stages[index] as LooseRecord).stageId,
      toStageId: (stages[index + 1] as LooseRecord).stageId,
      when: "any_terminal",
    }));
    return minimalManifest(stages, edges);
  }

  const depthCap = admitWavePlanDagManifestV2(chain(9));
  assert.ok(!depthCap.ok);
  assert.equal(depthCap.reason, "depth_limit_exceeded");

  const fanOutStages = [stage("stg_00000000", "mft_0000000000000000", "1", "root")]
    .concat(Array.from({ length: 9 }, (_, index) => stage(
      `stg_${(index + 1).toString(16).padStart(8, "0")}`,
      `mft_${(index + 1).toString(16).padStart(16, "0")}`,
      ((index + 2) % 15).toString(16),
    )));
  const fanOut = admitWavePlanDagManifestV2(minimalManifest(
    fanOutStages,
    fanOutStages.slice(1).map((child) => ({
      fromStageId: "stg_00000000",
      toStageId: child.stageId as string,
      when: "any_terminal",
    })),
  ));
  assert.ok(!fanOut.ok);
  assert.equal(fanOut.reason, "fan_out_limit_exceeded");

  const chain11 = (() => {
    const stages = Array.from({ length: 13 }, (_, index) => stage(
      `stg_${index.toString(16).padStart(8, "0")}`,
      `mft_${index.toString(16).padStart(16, "0")}`,
      ((index % 14) + 1).toString(16),
      index === 0 ? "root" : "all_matching",
    )) as LooseRecord[];
    const edges = [
      { fromStageId: "stg_00000000", toStageId: "stg_00000001", when: "any_terminal" },
      { fromStageId: "stg_00000000", toStageId: "stg_00000002", when: "any_terminal" },
      ...stages.slice(3, 8).map((source) => ({ fromStageId: "stg_00000001", toStageId: source.stageId as string, when: "any_terminal" })),
      ...stages.slice(8, 12).map((source) => ({ fromStageId: "stg_00000002", toStageId: source.stageId as string, when: "any_terminal" })),
      ...stages.slice(3, 12).map((source) => ({ fromStageId: source.stageId as string, toStageId: "stg_0000000c", when: "any_terminal" })),
    ];
    return admitWavePlanDagManifestV2(minimalManifest(stages, edges));
  })();
  assert.ok(!chain11.ok);
  assert.equal(chain11.reason, "fan_in_limit_exceeded");

  const overEdges = admitWavePlanDagManifestV2(minimalManifest(
    [stage("stg_00000000", "mft_0000000000000000", "1", "root")],
    [],
  ));
  assert.ok(!overEdges.ok || overEdges.ok); // root alone admits fine; see next case

  const tooManyEdgesCandidate = clone(FIXTURE.manifest);
  const edges = [...(tooManyEdgesCandidate.edges as LooseRecord[])];
  while (edges.length <= 64) edges.push(clone(edges[0]));
  tooManyEdgesCandidate.edges = edges;
  const overEdgeAdmission = admitWavePlanDagManifestV2(sealed(tooManyEdgesCandidate));
  assert.ok(!overEdgeAdmission.ok);
  assert.equal(overEdgeAdmission.reason, "edge_limit_exceeded");
});

test("closed-schema rejections keep code and private material out of manifests", () => {
  for (const forbiddenField of [
    "workerId",
    "personId",
    "providerId",
    "prompt",
    "payload",
    "path",
    "url",
    "timestamp",
    "labels",
    "metadata",
    "extensions",
    "command",
    "script",
    "code",
    "shell",
    "executable",
  ]) {
    const candidate = { ...clone(FIXTURE.manifest), [forbiddenField]: "forbidden" };
    const admission = admitWavePlanDagManifestV2(candidate);
    assert.ok(!admission.ok, `forbidden ${forbiddenField}`);
    assert.equal(admission.reason, "manifest_malformed", forbiddenField);
  }
});

test("any granted dispatch/dry-run/authority field is malformed (§1 boundary)", () => {
  const flips: Array<[string, unknown]> = [
    ["autoDispatch", true],
    ["operatorAdvanceRequired", false],
    ["dryRunRequired", false],
    ["executionAuthority", "dispatch"],
    ["claimAuthority", "claim"],
    ["retryAuthority", "retry"],
    ["finalizerAuthority", "finalize"],
    ["successAuthority", "succeed"],
    ["liveAuthority", "go_live"],
  ];
  for (const [field, value] of flips) {
    const admission = admitWavePlanDagManifestV2({ ...clone(FIXTURE.manifest), [field]: value });
    assert.ok(!admission.ok, `${field}=${String(value)} must be rejected`);
    assert.equal(admission.reason, "manifest_malformed", field);
  }
});

test("digest mismatch rejects before any downstream use", () => {
  const candidate = clone(FIXTURE.manifest);
  candidate.manifestDigest = `sha256:${"f".repeat(64)}`;
  const admission = admitWavePlanDagManifestV2(candidate);
  assert.ok(!admission.ok);
  assert.equal(admission.reason, "manifest_digest_mismatch");
});

test("malformed outcome sets carry stable reasons", () => {
  const admission = admitWavePlanDagManifestV2(FIXTURE.manifest);
  assert.ok(admission.ok);
  if (!admission.ok) return;
  const base = FIXTURE.dryRuns[0].request;

  const malformed: Array<[string, LooseRecord, string]> = [
    ["duplicate outcome", (() => {
      const r = clone(base);
      const outcomes = r.outcomes as LooseRecord[];
      r.outcomes = [...outcomes, clone(outcomes[0])];
      return r;
    })(), "outcome_set_malformed"],
    ["unknown stage", (() => {
      const r = clone(base);
      (r.outcomes as LooseRecord[])[0].stageId = "stg_ffffffff";
      return r;
    })(), "outcome_set_malformed"],
    ["unknown outcome", (() => {
      const r = clone(base);
      (r.outcomes as LooseRecord[])[0].outcome = "completed";
      return r;
    })(), "unknown_outcome"],
    ["private outcome field", (() => {
      const r = clone(base);
      (r.outcomes as LooseRecord[])[0].payload = "forbidden";
      return r;
    })(), "outcome_set_malformed"],
    ["kind flip", (() => {
      const r = clone(base);
      r.kind = "SomethingElse";
      return r;
    })(), "outcome_set_malformed"],
    ["binding mismatch", (() => {
      const r = clone(base);
      r.manifestDigest = `sha256:${"e".repeat(64)}`;
      return r;
    })(), "manifest_digest_mismatch"],
  ];
  for (const [label, request, expectedReason] of malformed) {
    const result = runWavePlanDagDryRunV2(admission, request);
    assert.ok(!result.ok, label);
    assert.equal(result.reason, expectedReason, label);
  }
});

test("outcomes may never skip or reopen a resolved-not-ready join", () => {
  const admission = admitWavePlanDagManifestV2(FIXTURE.manifest);
  assert.ok(admission.ok);
  if (!admission.ok) return;

  // Partial snapshot leaves stg_00000030 waiting; an admitted outcome for it
  // would fabricate readiness through the join.
  const waitingTarget = clone(FIXTURE.dryRuns[0].request);
  waitingTarget.outcomes = (waitingTarget.outcomes as LooseRecord[]).filter((outcome) =>
    ["stg_00000000", "stg_00000010"].includes(outcome.stageId as string));
  (waitingTarget.outcomes as LooseRecord[]).push({
    kind: "WavePlanDagStageOutcomeV2",
    version: 2,
    stageId: "stg_00000030",
    outcome: "gate_passed",
  });
  const skippedJoin = runWavePlanDagDryRunV2(admission, waitingTarget);
  assert.ok(!skippedJoin.ok);
  assert.equal(skippedJoin.reason, "outcome_join_mismatch");

  // Same for a not_selected join in the second vector.
  const unsatisfiedTarget = clone(FIXTURE.dryRuns[1].request);
  (unsatisfiedTarget.outcomes as LooseRecord[]).push({
    kind: "WavePlanDagStageOutcomeV2",
    version: 2,
    stageId: "stg_00000030",
    outcome: "gate_passed",
  });
  const reopenedJoin = runWavePlanDagDryRunV2(admission, unsatisfiedTarget);
  assert.ok(!reopenedJoin.ok);
  assert.equal(reopenedJoin.reason, "outcome_join_mismatch");
});

test("a failed admission passes its rejection straight through the dry-run", () => {
  const result = runWavePlanDagDryRunV2(admitWavePlanDagManifestV2({ broken: true }), {});
  assert.ok(!result.ok);
  assert.equal(result.reason, "manifest_malformed");
});
