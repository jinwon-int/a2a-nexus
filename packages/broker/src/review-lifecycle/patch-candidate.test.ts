import test from "node:test";
import assert from "node:assert/strict";

import { diffHash, findingSignature, intentHash } from "./canonical-json.js";
import { applyEvent, createLineage } from "./lifecycle.js";
import {
  acceptPatchCandidate,
  createPatchCandidate,
  validatePatchCandidate,
  type PatchCandidateAcceptanceV1,
  type PatchCandidateInput,
  type PatchCandidateV1,
} from "./patch-candidate.js";
import type {
  FindingV1,
  IntentContractV1,
  ReviewLineageRecord,
  ReviewReceiptV1,
} from "./types.js";

const T0 = "2026-07-23T00:00:00Z";
const T1 = "2026-07-23T01:00:00Z";
const T2 = "2026-07-23T02:00:00Z";

function makeContract(): IntentContractV1 {
  const base = {
    kind: "IntentContractV1" as const,
    lineageId: "phase5-patch",
    goal: "isolate a fixer patch proposal",
    nonGoals: ["no auto-push"],
    invariants: ["original author head remains immutable"],
    acceptanceCriteria: [{ id: "AC-1", text: "proposal-only candidate" }],
    declaredPaths: {
      allowed: ["packages/broker/src/**"],
      forbidden: [".github/**"],
    },
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    createdAt: T0,
  };
  return { ...base, intentHash: intentHash(base) };
}

function makeFinding(contract: IntentContractV1): FindingV1 {
  const base = {
    findingId: "F-1",
    criterionRef: "AC-1",
    evidenceRefs: ["packages/broker/src/example.ts:1"],
    severity: "major" as const,
    category: "correctness" as const,
    blocking: true,
    introducedAtHead: contract.headSha,
    firstSeenAtHead: contract.headSha,
    resolvedAtHead: null,
    disposition: "open" as const,
  };
  return { ...base, signature: findingSignature(base) };
}

function correctionPendingRecord(): ReviewLineageRecord {
  const contract = makeContract();
  const originalDiffHash = diffHash("original");
  const initial = createLineage({
    contract,
    at: T0,
    diffHash: originalDiffHash,
  });
  const receipt: ReviewReceiptV1 = {
    kind: "ReviewReceiptV1",
    reviewerNodeId: "reviewer-one",
    verdict: "fail",
    note: "blocking finding",
    headSha: contract.headSha,
    diffHash: originalDiffHash,
    intentHash: contract.intentHash,
    findingLedgerRef: initial.ledger.ledgerId,
  };
  return applyEvent(initial, {
    type: "review_report",
    at: T1,
    receipt,
    newFindings: [makeFinding(contract)],
  }).record;
}

function candidateInput(
  record: ReviewLineageRecord,
  patch: Partial<PatchCandidateInput> = {},
): PatchCandidateInput {
  return {
    kind: "PatchCandidateV1",
    candidateId: "C-1",
    lineageId: record.lineageId,
    generationKind: "additive_child",
    parentOriginalHeadSha: record.contract.headSha,
    baseDiffHash: record.currentDiffHash!,
    intentHash: record.contract.intentHash,
    producerId: "fixer-one",
    producerRole: "fixer",
    authority: "propose_only",
    pathsChanged: ["packages/broker/src/example.ts"],
    patchDigest: diffHash("candidate patch"),
    createdAt: T2,
    ...patch,
  };
}

function acceptance(
  record: ReviewLineageRecord,
  candidate: PatchCandidateV1,
  patch: Partial<PatchCandidateAcceptanceV1> = {},
): PatchCandidateAcceptanceV1 {
  return {
    kind: "PatchCandidateAcceptanceV1",
    acceptanceId: "A-1",
    candidateId: candidate.candidateId,
    candidateHash: candidate.candidateHash,
    lineageId: record.lineageId,
    expectedOriginalHeadSha: record.contract.headSha,
    expectedBaseDiffHash: record.currentDiffHash!,
    expectedIntentHash: record.contract.intentHash,
    acceptedBy: "operator-one",
    accepterRole: "operator",
    acceptedAt: T2,
    ...patch,
  };
}

test("patch candidate: valid fixer output is proposal-only and leaves the original HEAD immutable", () => {
  const record = correctionPendingRecord();
  const before = structuredClone(record);
  const candidate = createPatchCandidate(candidateInput(record));
  const result = validatePatchCandidate(record, candidate);

  assert.equal(result.ok, true);
  assert.deepEqual(record, before);
  assert.equal(record.currentHeadSha, record.contract.headSha);
  assert.equal(candidate.authority, "propose_only");
  assert.equal(candidate.generationKind, "additive_child");
  assert.equal("headSha" in candidate, false);
});

test("patch candidate: metadata hash detects path and patch-digest tampering", () => {
  const record = correctionPendingRecord();
  const candidate = createPatchCandidate(candidateInput(record));

  for (const tampered of [
    {
      ...candidate,
      pathsChanged: ["packages/broker/src/tampered.ts"],
    },
    { ...candidate, patchDigest: diffHash("tampered patch") },
  ]) {
    const result = validatePatchCandidate(record, tampered);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.code, "candidate_hash_mismatch");
  }
});

test("patch candidate: strict schema rejects write authority and auto-push fields", () => {
  const record = correctionPendingRecord();
  const valid = createPatchCandidate(candidateInput(record));

  for (const malformed of [
    { ...valid, authority: "push" },
    { ...valid, producerRole: "author" },
    { ...valid, pushCommand: "git push" },
  ]) {
    const result = validatePatchCandidate(record, malformed);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.code, "invalid_candidate");
  }
});

test("patch candidate: frozen lineage subject mismatches fail closed", () => {
  const record = correctionPendingRecord();
  const cases: Array<
    [Partial<PatchCandidateInput>, string]
  > = [
    [{ lineageId: "other-lineage" }, "lineage_mismatch"],
    [{ parentOriginalHeadSha: "d".repeat(40) }, "original_head_mismatch"],
    [{ baseDiffHash: diffHash("other base") }, "base_diff_hash_mismatch"],
    [
      { intentHash: "sha256:" + "f".repeat(64) },
      "intent_hash_mismatch",
    ],
  ];

  for (const [patch, expectedCode] of cases) {
    const candidate = createPatchCandidate(candidateInput(record, patch));
    const result = validatePatchCandidate(record, candidate);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.code, expectedCode);
  }
});

test("patch candidate: forbidden, out-of-scope, traversal, and duplicate paths fail closed", () => {
  const record = correctionPendingRecord();
  const cases: Array<[string[], string]> = [
    [[".github/workflows/ci.yml"], "forbidden_path"],
    [["README.md"], "scope_drift"],
    [["packages/broker/src/../package.json"], "scope_drift"],
    [
      [
        "packages/broker/src/example.ts",
        "packages/broker/src/example.ts",
      ],
      "duplicate_path",
    ],
  ];

  for (const [pathsChanged, expectedCode] of cases) {
    const candidate = createPatchCandidate(
      candidateInput(record, { pathsChanged }),
    );
    const result = validatePatchCandidate(record, candidate);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.code, expectedCode);
  }
});

test("patch candidate: proposal validation is unavailable outside correction_pending", () => {
  const correctionPending = correctionPendingRecord();
  const candidate = createPatchCandidate(candidateInput(correctionPending));
  const record = { ...correctionPending, state: "reviewing_resolution" as const };
  const result = validatePatchCandidate(record, candidate);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "state_not_correction_pending");
});

test("patch candidate: candidate creation after the author HEAD moved is rejected", () => {
  const record = correctionPendingRecord();
  const candidate = createPatchCandidate(candidateInput(record));
  const moved = { ...record, currentHeadSha: "c".repeat(40) };
  const result = validatePatchCandidate(moved, candidate);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "original_head_not_current");
});

test("patch candidate: explicit independent operator acceptance is contract-only", () => {
  const record = correctionPendingRecord();
  const before = structuredClone(record);
  const candidate = createPatchCandidate(candidateInput(record));
  const result = acceptPatchCandidate(
    record,
    candidate,
    acceptance(record, candidate),
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.strictEqual(result.record, record);
  assert.deepEqual(result.record, before);
  assert.equal(result.acceptance.effect, "contract_only_no_apply");
  assert.equal(result.record.counters.correctionGenerations, 0);
  assert.equal(result.record.currentHeadSha, result.record.contract.headSha);
});

test("patch candidate: fixer cannot accept its own proposal", () => {
  const record = correctionPendingRecord();
  const candidate = createPatchCandidate(candidateInput(record));
  const result = acceptPatchCandidate(
    record,
    candidate,
    acceptance(record, candidate, { acceptedBy: candidate.producerId }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "acceptance_actor_not_independent");
});

test("patch candidate: acceptance rebinds candidate and frozen subject exactly", () => {
  const record = correctionPendingRecord();
  const candidate = createPatchCandidate(candidateInput(record));
  const cases: Array<
    [Partial<PatchCandidateAcceptanceV1>, string]
  > = [
    [{ candidateId: "C-other" }, "acceptance_candidate_mismatch"],
    [
      { candidateHash: "sha256:" + "0".repeat(64) },
      "acceptance_candidate_mismatch",
    ],
    [{ lineageId: "other-lineage" }, "acceptance_subject_mismatch"],
    [
      { expectedOriginalHeadSha: "d".repeat(40) },
      "acceptance_subject_mismatch",
    ],
    [
      { expectedBaseDiffHash: diffHash("other base") },
      "acceptance_subject_mismatch",
    ],
    [
      { expectedIntentHash: "sha256:" + "f".repeat(64) },
      "acceptance_subject_mismatch",
    ],
  ];

  for (const [patch, expectedCode] of cases) {
    const result = acceptPatchCandidate(
      record,
      candidate,
      acceptance(record, candidate, patch),
    );
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.code, expectedCode);
    assert.strictEqual(result.record, record);
  }
});

test("patch candidate: strict and monotonic candidate/acceptance timestamps fail closed", () => {
  const record = correctionPendingRecord();
  assert.throws(
    () =>
      createPatchCandidate(
        candidateInput(record, { createdAt: "2026-02-30T02:00:00Z" }),
      ),
    /valid calendar instant/,
  );

  const staleCandidate = createPatchCandidate(
    candidateInput(record, { createdAt: T0 }),
  );
  const staleValidation = validatePatchCandidate(record, staleCandidate);
  assert.equal(staleValidation.ok, false);
  if (!staleValidation.ok) {
    assert.equal(staleValidation.code, "candidate_time_out_of_order");
  }

  const candidate = createPatchCandidate(candidateInput(record));
  const malformedAcceptance = acceptPatchCandidate(
    record,
    candidate,
    acceptance(record, candidate, {
      acceptedAt: "2026-07-23 03:00:00Z",
    }),
  );
  assert.equal(malformedAcceptance.ok, false);
  if (!malformedAcceptance.ok) {
    assert.equal(malformedAcceptance.code, "invalid_acceptance");
  }

  const staleAcceptance = acceptPatchCandidate(
    record,
    candidate,
    acceptance(record, candidate, { acceptedAt: T1 }),
  );
  assert.equal(staleAcceptance.ok, false);
  if (!staleAcceptance.ok) {
    assert.equal(staleAcceptance.code, "acceptance_time_out_of_order");
  }
});
