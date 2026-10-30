import test from "node:test";
import assert from "node:assert/strict";

import { diffHash, findingSignature, intentHash } from "./canonical-json.js";
import {
  applyFinalizerDisposition,
  requestFindingAppeal,
} from "./appeal.js";
import { applyEvent, createLineage } from "./lifecycle.js";
import type {
  AppealRequestV1,
  FinalizerDispositionV1,
  FindingV1,
  IntentContractV1,
  ReviewLineageRecord,
  ReviewReceiptV1,
} from "./types.js";

const T0 = "2026-07-23T00:00:00Z";
const T1 = "2026-07-23T01:00:00Z";
const T2 = "2026-07-23T02:00:00Z";
const T3 = "2026-07-23T03:00:00Z";
const T4 = "2026-07-23T04:00:00Z";

function makeContract(): IntentContractV1 {
  const base = {
    kind: "IntentContractV1" as const,
    lineageId: "phase5-appeal",
    goal: "bound one appeal finalizer",
    nonGoals: ["no runtime finalizer integration"],
    invariants: ["signed finalizer gate remains unchanged"],
    acceptanceCriteria: [{ id: "AC-1", text: "one disposition per finding" }],
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

function makeReceipt(
  record: ReviewLineageRecord,
  verdict: "pass" | "fail",
): ReviewReceiptV1 {
  return {
    kind: "ReviewReceiptV1",
    reviewerNodeId: "reviewer-one",
    verdict,
    note: "resolution review",
    headSha: record.currentHeadSha,
    diffHash: record.currentDiffHash ?? diffHash("original"),
    intentHash: record.contract.intentHash,
    findingLedgerRef: record.ledger.ledgerId,
  };
}

function correctionPendingRecord(): ReviewLineageRecord {
  const contract = makeContract();
  const initial = createLineage({
    contract,
    at: T0,
    diffHash: diffHash("original"),
  });
  return applyEvent(initial, {
    type: "review_report",
    at: T1,
    receipt: makeReceipt(initial, "fail"),
    newFindings: [makeFinding(contract)],
  }).record;
}

function appealRequest(
  patch: Partial<AppealRequestV1> = {},
): AppealRequestV1 {
  return {
    kind: "AppealRequestV1",
    appealId: "A-1",
    lineageId: "phase5-appeal",
    findingId: "F-1",
    requestedBy: "author-one",
    requesterRole: "author",
    reason: "the cited evidence does not demonstrate this finding",
    requestedAt: T2,
    ...patch,
  };
}

function disposition(
  patch: Partial<FinalizerDispositionV1> = {},
): FinalizerDispositionV1 {
  return {
    kind: "FinalizerDispositionV1",
    dispositionId: "D-1",
    appealId: "A-1",
    lineageId: "phase5-appeal",
    findingId: "F-1",
    finalizerId: "finalizer-one",
    disposition: "overruled_by_finalizer",
    justification: "evidence does not demonstrate the reported defect",
    decidedAt: T3,
    ...patch,
  };
}

function withRecordedAppeal(
  record: ReviewLineageRecord,
  request: AppealRequestV1 = appealRequest(),
): ReviewLineageRecord {
  const result = requestFindingAppeal(record, request);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("appeal request unexpectedly failed");
  return result.record;
}

test("appeal: createLineage embeds an empty durable appeal ledger", () => {
  const record = correctionPendingRecord();
  assert.deepEqual(record.appeal, {
    kind: "AppealDispositionStateV1",
    lineageId: record.lineageId,
    finalizerOwnerId: null,
    requests: [],
    dispositions: [],
  });
});

test("appeal: a finding must have a recorded appeal before finalizer disposition", () => {
  const record = correctionPendingRecord();
  const result = applyFinalizerDisposition(record, disposition());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "appeal_not_found");
  assert.equal(result.record.appeal.finalizerOwnerId, null);
});

test("appeal: request is strict, finding-bound, and idempotent", () => {
  const record = correctionPendingRecord();
  const first = requestFindingAppeal(record, appealRequest());
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.record.appeal.requests.length, 1);
  assert.equal(first.record.appeal.finalizerOwnerId, null);

  const retry = requestFindingAppeal(first.record, appealRequest());
  assert.equal(retry.ok, true);
  if (!retry.ok) return;
  assert.equal(retry.idempotent, true);
  assert.strictEqual(retry.record, first.record);

  const unknown = requestFindingAppeal(
    record,
    appealRequest({ appealId: "A-404", findingId: "F-404" }),
  );
  assert.equal(unknown.ok, false);
  if (unknown.ok) return;
  assert.equal(unknown.code, "finding_not_found");

  const writeCapable = requestFindingAppeal(record, {
    ...appealRequest(),
    execute: "git push",
  });
  assert.equal(writeCapable.ok, false);
  if (writeCapable.ok) return;
  assert.equal(writeCapable.code, "invalid_appeal_request");
});

test("appeal: first valid disposition binds one finalizer and overrules one finding", () => {
  const appealed = withRecordedAppeal(correctionPendingRecord());
  const originalHead = appealed.currentHeadSha;
  const originalState = appealed.state;
  const result = applyFinalizerDisposition(appealed, disposition());

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.idempotent, false);
  assert.equal(result.record.appeal.finalizerOwnerId, "finalizer-one");
  assert.equal(result.record.appeal.dispositions.length, 1);
  assert.equal(
    result.record.ledger.findings[0]?.disposition,
    "overruled_by_finalizer",
  );
  assert.equal(result.record.currentHeadSha, originalHead);
  assert.equal(result.record.state, originalState);
  assert.equal(
    result.record.unresolvedSignatures[
      appealed.ledger.findings[0]!.signature
    ],
    undefined,
  );
});

test("appeal: exact disposition retry is idempotent but a changed payload with the same ID fails closed", () => {
  const appealed = withRecordedAppeal(correctionPendingRecord());
  const first = applyFinalizerDisposition(appealed, disposition());
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const retry = applyFinalizerDisposition(first.record, disposition());
  assert.equal(retry.ok, true);
  if (!retry.ok) return;
  assert.equal(retry.idempotent, true);
  assert.strictEqual(retry.record, first.record);

  const conflict = applyFinalizerDisposition(
    first.record,
    disposition({ justification: "different payload" }),
  );
  assert.equal(conflict.ok, false);
  if (conflict.ok) return;
  assert.equal(conflict.code, "disposition_id_conflict");
});

test("appeal: an upheld disposition remains in the record and cannot be bypassed by recreating side state", () => {
  const appealed = withRecordedAppeal(correctionPendingRecord());
  const first = applyFinalizerDisposition(
    appealed,
    disposition({ disposition: "upheld" }),
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.record.appeal.dispositions.length, 1);
  assert.equal(
    first.record.appeal.dispositions[0]?.disposition,
    "upheld",
  );

  const duplicate = applyFinalizerDisposition(
    first.record,
    disposition({
      dispositionId: "D-2",
      finalizerId: "finalizer-two",
      disposition: "overruled_by_finalizer",
      decidedAt: T4,
    }),
  );
  assert.equal(duplicate.ok, false);
  if (duplicate.ok) return;
  assert.equal(duplicate.code, "finalizer_owner_conflict");
  assert.equal(duplicate.record.appeal.dispositions.length, 1);
});

test("appeal: one finalizer owner is enforced across different appealed findings", () => {
  const record = correctionPendingRecord();
  const secondFinding: FindingV1 = {
    ...makeFinding(record.contract),
    findingId: "F-2",
  };
  let current = {
    ...record,
    ledger: {
      ...record.ledger,
      findings: [...record.ledger.findings, secondFinding],
    },
  };
  current = withRecordedAppeal(current);
  const first = applyFinalizerDisposition(
    current,
    disposition({ disposition: "upheld" }),
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const secondAppeal = requestFindingAppeal(
    first.record,
    appealRequest({
      appealId: "A-2",
      findingId: "F-2",
      requestedAt: T4,
    }),
  );
  assert.equal(secondAppeal.ok, true);
  if (!secondAppeal.ok) return;
  const takeover = applyFinalizerDisposition(
    secondAppeal.record,
    disposition({
      dispositionId: "D-2",
      appealId: "A-2",
      findingId: "F-2",
      finalizerId: "finalizer-two",
      disposition: "upheld",
      decidedAt: T4,
    }),
  );
  assert.equal(takeover.ok, false);
  if (takeover.ok) return;
  assert.equal(takeover.code, "finalizer_owner_conflict");
});

test("appeal: overrule preserves repeated-signature history while another blocker with that signature remains open", () => {
  let record = correctionPendingRecord();
  const firstFinding = record.ledger.findings[0]!;
  record = {
    ...record,
    ledger: {
      ...record.ledger,
      findings: [
        firstFinding,
        { ...firstFinding, findingId: "F-2" },
      ],
    },
  };
  record = applyEvent(record, {
    type: "correction_generation",
    at: T2,
    headSha: "c".repeat(40),
    diffHash: diffHash("correction"),
    intentHash: record.contract.intentHash,
    pathsChanged: ["packages/broker/src/example.ts"],
  }).record;
  record = withRecordedAppeal(
    record,
    appealRequest({ requestedAt: T2 }),
  );
  const overruled = applyFinalizerDisposition(
    record,
    disposition({ decidedAt: T2 }),
  );
  assert.equal(overruled.ok, true);
  if (!overruled.ok) return;
  assert.equal(
    overruled.record.unresolvedSignatures[firstFinding.signature],
    1,
  );

  const reviewed = applyEvent(overruled.record, {
    type: "review_report",
    at: T3,
    receipt: makeReceipt(overruled.record, "fail"),
  });
  assert.equal(reviewed.record.state, "blocked_needs_operator");
  assert.equal(reviewed.record.terminalReason, "repeated_findings");
});

test("appeal: an overruled finding ID cannot be reopened by the resolution reviewer", () => {
  let record = correctionPendingRecord();
  record = applyEvent(record, {
    type: "correction_generation",
    at: T2,
    headSha: "c".repeat(40),
    diffHash: diffHash("correction"),
    intentHash: record.contract.intentHash,
    pathsChanged: ["packages/broker/src/example.ts"],
  }).record;
  assert.equal(record.state, "reviewing_resolution");

  record = withRecordedAppeal(
    record,
    appealRequest({ requestedAt: T2 }),
  );
  const appealed = applyFinalizerDisposition(
    record,
    disposition({ decidedAt: T2 }),
  );
  assert.equal(appealed.ok, true);
  if (!appealed.ok) return;

  const reviewed = applyEvent(appealed.record, {
    type: "review_report",
    at: T3,
    receipt: makeReceipt(appealed.record, "pass"),
    reopenedFindingIds: ["F-1"],
  });
  assert.equal(
    reviewed.record.ledger.findings[0]?.disposition,
    "overruled_by_finalizer",
  );
  assert.equal(reviewed.record.state, "passed");
});

test("appeal: strict timestamps reject non-ISO, impossible, and out-of-order instants", () => {
  const record = correctionPendingRecord();
  for (const requestedAt of [
    "2026-07-23 02:00:00Z",
    "2026-02-30T02:00:00Z",
    T0,
  ]) {
    const result = requestFindingAppeal(
      record,
      appealRequest({ requestedAt }),
    );
    assert.equal(result.ok, false);
  }

  const appealed = withRecordedAppeal(record);
  const result = applyFinalizerDisposition(
    appealed,
    disposition({ decidedAt: T1 }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "disposition_time_out_of_order");
});

test("appeal: strict disposition input rejects execution-authority fields", () => {
  const record = withRecordedAppeal(correctionPendingRecord());
  const result = applyFinalizerDisposition(record, {
    ...disposition(),
    pushCommand: "git push",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "invalid_disposition");
});
