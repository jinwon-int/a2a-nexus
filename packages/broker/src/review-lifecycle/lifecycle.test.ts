import test from "node:test";
import assert from "node:assert/strict";

import { diffHash, findingSignature, intentHash } from "./canonical-json.js";
import { applyEvent, createLineage } from "./lifecycle.js";
import {
  DEFAULT_LINEAGE_BUDGET,
  type FindingV1,
  type IntentContractV1,
  type ReviewLineageBudgetV1,
  type ReviewReceiptV1,
} from "./types.js";

const T0 = "2026-07-20T00:00:00Z";
const T1 = "2026-07-20T01:00:00Z";
const T2 = "2026-07-20T02:00:00Z";
const T3 = "2026-07-20T03:00:00Z";

function makeContract(overrides: Partial<IntentContractV1> = {}): IntentContractV1 {
  const base = {
    kind: "IntentContractV1" as const,
    lineageId: "pr-lineage-test-1",
    goal: "test goal",
    nonGoals: ["no gate weakening"],
    invariants: ["fail-closed preserved"],
    acceptanceCriteria: [
      { id: "AC-1", text: "first criterion" },
      { id: "AC-2", text: "second criterion" },
    ],
    declaredPaths: { allowed: ["packages/broker/src/**"], forbidden: [".github/**"] },
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    createdAt: T0,
  };
  const contract = { ...base, ...overrides };
  return { ...contract, intentHash: intentHash(contract) } as IntentContractV1;
}

function makeReceipt(contract: IntentContractV1, overrides: Partial<ReviewReceiptV1> = {}): ReviewReceiptV1 {
  return {
    kind: "ReviewReceiptV1",
    reviewerNodeId: "reviewer-b",
    verdict: "pass",
    note: "reviewed",
    headSha: contract.headSha,
    diffHash: diffHash("patch"),
    intentHash: contract.intentHash,
    findingLedgerRef: `ledger-${contract.lineageId}`,
    ...overrides,
  };
}

function makeFinding(overrides: Partial<FindingV1> = {}): FindingV1 {
  const base: FindingV1 = {
    findingId: "F-1",
    criterionRef: "AC-1",
    evidenceRefs: ["packages/broker/src/worker-review.ts:69"],
    severity: "major",
    category: "correctness",
    blocking: true,
    introducedAtHead: "b".repeat(40),
    firstSeenAtHead: "b".repeat(40),
    resolvedAtHead: null,
    disposition: "open",
    signature: "",
    ...overrides,
  };
  return { ...base, signature: base.signature || findingSignature(base) };
}

function budgetWith(patch: Partial<ReviewLineageBudgetV1>): ReviewLineageBudgetV1 {
  return { ...DEFAULT_LINEAGE_BUDGET, ...patch };
}

test("lifecycle: createLineage rejects a contract whose intentHash does not match", () => {
  const contract = { ...makeContract(), intentHash: "sha256:" + "0".repeat(64) };
  assert.throws(() => createLineage({ contract, at: T0 }), /hash mismatch/);
});

test("lifecycle: resolution review rejects a new blocking correctness finding without justification", () => {
  const contract = makeContract();
  let record = createLineage({ contract, at: T0 });

  let applied = applyEvent(record, { type: "review_report", at: T1, receipt: makeReceipt(contract, { verdict: "fail", note: "blocker" }), newFindings: [makeFinding()] });
  record = applied.record;
  applied = applyEvent(record, {
    type: "correction_generation",
    at: T2,
    headSha: "c".repeat(40),
    diffHash: diffHash("correction"),
    intentHash: contract.intentHash,
    pathsChanged: ["packages/broker/src/worker-review.ts"],
  });
  record = applied.record;

  applied = applyEvent(record, {
    type: "review_report",
    at: T3,
    receipt: makeReceipt(contract, { headSha: "c".repeat(40), diffHash: diffHash("correction") }),
    resolvedFindingIds: ["F-1"],
    newFindings: [makeFinding({ findingId: "F-2", category: "correctness", blocking: true, criterionRef: "AC-2", evidenceRefs: ["packages/broker/src/other.ts:1"] })],
  });
  record = applied.record;
  assert.equal(record.state, "passed");
  assert.equal(record.counters.goalpostRejections, 1);
  assert.ok(applied.effects.includes("goalpost_rejected:F-2"));
  assert.equal(record.ledger.findings.some((finding) => finding.findingId === "F-2"), false);
});

test("lifecycle: resolution review admits an introduced-regression blocker with justification", () => {
  const contract = makeContract();
  let record = createLineage({ contract, at: T0 });
  const correctionHead = "c".repeat(40);

  let applied = applyEvent(record, { type: "review_report", at: T1, receipt: makeReceipt(contract, { verdict: "fail", note: "blocker" }), newFindings: [makeFinding()] });
  record = applied.record;
  applied = applyEvent(record, {
    type: "correction_generation",
    at: T2,
    headSha: correctionHead,
    diffHash: diffHash("correction"),
    intentHash: contract.intentHash,
    pathsChanged: ["packages/broker/src/worker-review.ts"],
  });
  record = applied.record;

  applied = applyEvent(record, {
    type: "review_report",
    at: T3,
    receipt: makeReceipt(contract, { verdict: "fail", note: "correction regressed", headSha: correctionHead, diffHash: diffHash("correction") }),
    resolvedFindingIds: ["F-1"],
    newFindings: [
      {
        ...makeFinding({ findingId: "F-2", category: "regression", introducedAtHead: correctionHead, firstSeenAtHead: correctionHead, criterionRef: "AC-2" }),
        justification: { kind: "introduced_regression" as const, detail: "regression introduced by the correction patch" },
      },
    ],
  });
  record = applied.record;
  assert.ok(applied.effects.some((effect) => effect === "new_blocker_admitted:F-2:introduced_regression"));
  // F-2 is a real blocker now; the generation budget is exhausted, so the lineage terminates.
  assert.equal(record.state, "blocked_needs_operator");
  assert.equal(record.terminalReason, "budget_correction_generations");
});

test("lifecycle: forbidden path correction is rejected as a security boundary", () => {
  const contract = makeContract();
  let record = createLineage({ contract, at: T0 });
  let applied = applyEvent(record, { type: "review_report", at: T1, receipt: makeReceipt(contract, { verdict: "fail", note: "blocker" }), newFindings: [makeFinding()] });
  record = applied.record;
  applied = applyEvent(record, {
    type: "correction_generation",
    at: T2,
    headSha: "e".repeat(40),
    diffHash: diffHash("forbidden patch"),
    intentHash: contract.intentHash,
    pathsChanged: [".github/workflows/ci.yml"],
  });
  record = applied.record;
  assert.equal(record.state, "correction_pending");
  assert.equal(record.counters.correctionGenerations, 0);
  assert.ok(applied.effects.some((effect) => effect.startsWith("forbidden_path_rejected:")));
});

test("lifecycle: correction changing the frozen intent transitions to intent_conflict", () => {
  const contract = makeContract();
  let record = createLineage({ contract, at: T0 });
  let applied = applyEvent(record, { type: "review_report", at: T1, receipt: makeReceipt(contract, { verdict: "fail", note: "blocker" }), newFindings: [makeFinding()] });
  record = applied.record;
  applied = applyEvent(record, {
    type: "correction_generation",
    at: T2,
    headSha: "c".repeat(40),
    diffHash: diffHash("correction"),
    intentHash: "sha256:" + "9".repeat(64),
    pathsChanged: ["packages/broker/src/worker-review.ts"],
  });
  record = applied.record;
  assert.equal(record.state, "intent_conflict");
  assert.equal(record.terminalReason, "intent_drift");
});

test("lifecycle: wall-clock exhaustion terminates blocked_needs_operator, never running", () => {
  const contract = makeContract();
  const budget = budgetWith({ maxWallClockSeconds: 3600 });
  let record = createLineage({ contract, budget, at: T0 });
  const applied = applyEvent(record, {
    type: "review_report",
    at: "2026-07-20T02:00:01Z",
    receipt: makeReceipt(contract),
  });
  assert.equal(applied.record.state, "blocked_needs_operator");
  assert.equal(applied.record.terminalReason, "budget_wall_clock");
});

test("lifecycle: reviewer-run budget exhaustion is terminal", () => {
  const contract = makeContract();
  const budget = budgetWith({ maxReviewerRuns: 1 });
  let record = createLineage({ contract, budget, at: T0 });
  let applied = applyEvent(record, { type: "review_report", at: T1, receipt: makeReceipt(contract, { verdict: "fail", note: "blocker" }), newFindings: [makeFinding()] });
  record = applied.record;
  assert.equal(record.state, "correction_pending");
  applied = applyEvent(record, {
    type: "correction_generation",
    at: T2,
    headSha: "c".repeat(40),
    diffHash: diffHash("correction"),
    intentHash: contract.intentHash,
    pathsChanged: ["packages/broker/src/worker-review.ts"],
  });
  record = applied.record;
  applied = applyEvent(record, { type: "review_report", at: T3, receipt: makeReceipt(contract, { headSha: "c".repeat(40), diffHash: diffHash("correction") }), resolvedFindingIds: ["F-1"] });
  assert.equal(applied.record.state, "blocked_needs_operator");
  assert.equal(applied.record.terminalReason, "budget_reviewer_runs");
});

test("lifecycle: style/preference/design findings are normalized to non-blocking", () => {
  const contract = makeContract();
  let record = createLineage({ contract, at: T0 });
  const applied = applyEvent(record, {
    type: "review_report",
    at: T1,
    receipt: makeReceipt(contract),
    newFindings: [makeFinding({ findingId: "F-9", category: "style", blocking: true, severity: "minor" })],
  });
  record = applied.record;
  assert.ok(applied.effects.includes("nonblocking_category_normalized:F-9"));
  const finding = record.ledger.findings.find((f) => f.findingId === "F-9");
  assert.equal(finding?.blocking, false);
  assert.equal(record.state, "passed");
});

test("lifecycle: receipt bound to a different intentHash is rejected without state change", () => {
  const contract = makeContract();
  const record = createLineage({ contract, at: T0 });
  const applied = applyEvent(record, {
    type: "review_report",
    at: T1,
    receipt: makeReceipt(contract, { intentHash: "sha256:" + "0".repeat(64) }),
  });
  assert.equal(applied.record.state, "reviewing_initial");
  assert.equal(applied.record.counters.reviewerRuns, 0);
  assert.ok(applied.effects[0].startsWith("receipt_rejected:intent_hash_mismatch"));
});

test("lifecycle: reviewer replacement is infra-only, bounded, and never resets the budget", () => {
  const contract = makeContract();
  let record = createLineage({ contract, at: T0 });
  let applied = applyEvent(record, { type: "reviewer_replacement", at: T1, reason: "other" });
  assert.equal(applied.record.counters.reviewerReplacements, 0);
  assert.ok(applied.effects[0].startsWith("replacement_rejected"));

  applied = applyEvent(record, { type: "reviewer_replacement", at: T1, reason: "infrastructure_failure" });
  record = applied.record;
  assert.equal(record.counters.reviewerReplacements, 1);
  assert.equal(record.state, "reviewing_initial", "replacement never changes review state");

  applied = applyEvent(record, { type: "reviewer_replacement", at: T2, reason: "infrastructure_failure" });
  assert.equal(applied.record.state, "blocked_needs_operator");
  assert.equal(applied.record.terminalReason, "budget_reviewer_runs");
});

test("lifecycle: operator cancel is terminal", () => {
  const contract = makeContract();
  const record = createLineage({ contract, at: T0 });
  const applied = applyEvent(record, { type: "operator_cancel", at: T1, detail: "superseded" });
  assert.equal(applied.record.state, "canceled");
  assert.equal(applied.record.terminalReason, "operator_cancel");
});

test("lifecycle: stale-head receipt in resolution review is rejected without state change", () => {
  const contract = makeContract();
  let record = createLineage({ contract, at: T0 });
  let applied = applyEvent(record, { type: "review_report", at: T1, receipt: makeReceipt(contract, { verdict: "fail", note: "blocker" }), newFindings: [makeFinding()] });
  record = applied.record;
  applied = applyEvent(record, {
    type: "correction_generation",
    at: T2,
    headSha: "c".repeat(40),
    diffHash: diffHash("correction"),
    intentHash: contract.intentHash,
    pathsChanged: ["packages/broker/src/worker-review.ts"],
  });
  record = applied.record;

  // Receipt still bound to the ORIGINAL head while the lineage moved to the correction head.
  applied = applyEvent(record, { type: "review_report", at: T3, receipt: makeReceipt(contract) });
  assert.equal(applied.record.state, "reviewing_resolution");
  assert.equal(applied.record.counters.reviewerRuns, 1, "rejected receipt does not consume a reviewer run");
  assert.ok(applied.effects[0].startsWith("receipt_rejected:head_sha_mismatch"));
});

test("lifecycle: diffHash-mismatched receipt is rejected once the current diff is known", () => {
  const contract = makeContract();
  let record = createLineage({ contract, at: T0 });
  let applied = applyEvent(record, { type: "review_report", at: T1, receipt: makeReceipt(contract, { verdict: "fail", note: "blocker" }), newFindings: [makeFinding()] });
  record = applied.record;
  applied = applyEvent(record, {
    type: "correction_generation",
    at: T2,
    headSha: "c".repeat(40),
    diffHash: diffHash("correction"),
    intentHash: contract.intentHash,
    pathsChanged: ["packages/broker/src/worker-review.ts"],
  });
  record = applied.record;

  applied = applyEvent(record, {
    type: "review_report",
    at: T3,
    receipt: makeReceipt(contract, { headSha: "c".repeat(40), diffHash: diffHash("some other diff") }),
  });
  assert.equal(applied.record.state, "reviewing_resolution");
  assert.ok(applied.effects[0].startsWith("receipt_rejected:diff_hash_mismatch"));
});

test("lifecycle: review report in correction_pending is out of state and changes nothing", () => {
  const contract = makeContract();
  let record = createLineage({ contract, at: T0 });
  let applied = applyEvent(record, { type: "review_report", at: T1, receipt: makeReceipt(contract, { verdict: "fail", note: "blocker" }), newFindings: [makeFinding()] });
  record = applied.record;
  assert.equal(record.state, "correction_pending");

  applied = applyEvent(record, { type: "review_report", at: T2, receipt: makeReceipt(contract), resolvedFindingIds: ["F-1"] });
  assert.equal(applied.record.state, "correction_pending");
  assert.equal(applied.record.counters.reviewerRuns, 1);
  assert.equal(applied.record.counters.findingsResolved, 0);
  assert.ok(applied.effects.includes("report_out_of_state:correction_pending"));
});

test("lifecycle: two findings sharing one signature in a single run do not double-count the early stop", () => {
  const contract = makeContract();
  let record = createLineage({ contract, at: T0 });
  const shared = makeFinding();
  const twin = makeFinding({ findingId: "F-2", criterionRef: "AC-2" });
  const twinWithSharedSignature = { ...twin, signature: shared.signature };
  const applied = applyEvent(record, {
    type: "review_report",
    at: T1,
    receipt: makeReceipt(contract, { verdict: "fail", note: "two blockers" }),
    newFindings: [shared, twinWithSharedSignature],
  });
  record = applied.record;
  assert.equal(record.state, "correction_pending", "one signature seen once must not stop at threshold 2");
  assert.equal(record.unresolvedSignatures[shared.signature], 1);
});

test("lifecycle: receipt bound to a foreign ledger is rejected without state change", () => {
  const contract = makeContract();
  const record = createLineage({ contract, at: T0 });
  const applied = applyEvent(record, {
    type: "review_report",
    at: T1,
    receipt: makeReceipt(contract, { findingLedgerRef: "ledger-somewhere-else" }),
  });
  assert.equal(applied.record.state, "reviewing_initial");
  assert.equal(applied.record.counters.reviewerRuns, 0);
  assert.ok(applied.effects[0].startsWith("receipt_rejected:ledger_ref_mismatch"));
});

test("lifecycle: correction generation outside correction_pending is ignored", () => {
  const contract = makeContract();
  const record = createLineage({ contract, at: T0 });
  const applied = applyEvent(record, {
    type: "correction_generation",
    at: T1,
    headSha: "c".repeat(40),
    diffHash: diffHash("correction"),
    intentHash: contract.intentHash,
    pathsChanged: ["packages/broker/src/worker-review.ts"],
  });
  assert.equal(applied.record.state, "reviewing_initial");
  assert.equal(applied.record.counters.correctionGenerations, 0);
  assert.ok(applied.effects[0].startsWith("generation_out_of_state:reviewing_initial"));
});

test("lifecycle: resolution review admits critical-security and unavailable-evidence blockers with justification", () => {
  const contract = makeContract();
  let record = createLineage({ contract, at: T0 });
  const correctionHead = "c".repeat(40);
  let applied = applyEvent(record, { type: "review_report", at: T1, receipt: makeReceipt(contract, { verdict: "fail", note: "blocker" }), newFindings: [makeFinding()] });
  record = applied.record;
  applied = applyEvent(record, {
    type: "correction_generation",
    at: T2,
    headSha: correctionHead,
    diffHash: diffHash("correction"),
    intentHash: contract.intentHash,
    pathsChanged: ["packages/broker/src/worker-review.ts"],
  });
  record = applied.record;

  applied = applyEvent(record, {
    type: "review_report",
    at: T3,
    receipt: makeReceipt(contract, { verdict: "fail", note: "new exposures", headSha: correctionHead, diffHash: diffHash("correction") }),
    resolvedFindingIds: ["F-1"],
    newFindings: [
      {
        ...makeFinding({ findingId: "F-2", category: "security", severity: "critical", criterionRef: "AC-2" }),
        justification: { kind: "critical_security" as const, detail: "newly exposed token leak in diff" },
      },
      {
        ...makeFinding({ findingId: "F-3", category: "correctness", criterionRef: "AC-1", evidenceRefs: ["packages/broker/src/hidden.ts:9"] }),
        justification: { kind: "unavailable_evidence" as const, detail: "artifact was not published at the first pass" },
      },
    ],
  });
  record = applied.record;
  assert.ok(applied.effects.includes("new_blocker_admitted:F-2:critical_security"));
  assert.ok(applied.effects.includes("new_blocker_admitted:F-3:unavailable_evidence"));
  assert.equal(record.ledger.findings.filter((finding) => finding.findingId === "F-2" || finding.findingId === "F-3").length, 2);
});

test("lifecycle: critical-security justification does not admit a non-critical finding", () => {
  const contract = makeContract();
  let record = createLineage({ contract, at: T0 });
  const correctionHead = "c".repeat(40);
  let applied = applyEvent(record, { type: "review_report", at: T1, receipt: makeReceipt(contract, { verdict: "fail", note: "blocker" }), newFindings: [makeFinding()] });
  record = applied.record;
  applied = applyEvent(record, {
    type: "correction_generation",
    at: T2,
    headSha: correctionHead,
    diffHash: diffHash("correction"),
    intentHash: contract.intentHash,
    pathsChanged: ["packages/broker/src/worker-review.ts"],
  });
  record = applied.record;
  applied = applyEvent(record, {
    type: "review_report",
    at: T3,
    receipt: makeReceipt(contract, { headSha: correctionHead, diffHash: diffHash("correction") }),
    resolvedFindingIds: ["F-1"],
    newFindings: [
      {
        ...makeFinding({ findingId: "F-2", category: "security", severity: "minor", criterionRef: "AC-2" }),
        justification: { kind: "critical_security" as const, detail: "claimed critical but severity is minor" },
      },
    ],
  });
  assert.ok(applied.effects.includes("goalpost_rejected:F-2"));
});

test("lifecycle: traversal paths in a correction are rejected as scope drift", () => {
  const contract = makeContract();
  let record = createLineage({ contract, at: T0 });
  let applied = applyEvent(record, { type: "review_report", at: T1, receipt: makeReceipt(contract, { verdict: "fail", note: "blocker" }), newFindings: [makeFinding()] });
  record = applied.record;
  applied = applyEvent(record, {
    type: "correction_generation",
    at: T2,
    headSha: "e".repeat(40),
    diffHash: diffHash("traversal patch"),
    intentHash: contract.intentHash,
    pathsChanged: ["packages/broker/src/../../.github/workflows/ci.yml"],
  });
  record = applied.record;
  assert.equal(record.state, "correction_pending");
  assert.equal(record.counters.correctionGenerations, 0);
  assert.ok(applied.effects.some((effect) => effect.startsWith("scope_drift_rejected:")));
});
