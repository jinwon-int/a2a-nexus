import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalize,
  findingSignature,
  intentHash,
} from "./canonical-json.js";
import {
  ObservationValidationError,
  parseReviewLineageObservation,
  parseReviewLineageObservationBatch,
} from "./observation.js";
import type {
  FindingV1,
  IntentContractV1,
  ReviewLineageBudgetV1,
  ReviewReceiptV1,
} from "./types.js";

const BASE_SHA = "0".repeat(40);
const HEAD_SHA = "1".repeat(40);
const NEXT_HEAD_SHA = "2".repeat(40);
const DIFF_HASH = `sha256:${"a".repeat(64)}`;
const NEXT_DIFF_HASH = `sha256:${"b".repeat(64)}`;

function contract(): IntentContractV1 {
  const partial = {
    kind: "IntentContractV1" as const,
    lineageId: "pr-1518-observation-1",
    goal: "Record bounded review evidence without inference.",
    nonGoals: ["No live task-completion hook."],
    invariants: ["Runtime mode stays record-only."],
    acceptanceCriteria: [
      { id: "AC-1", text: "Observation replay is deterministic." },
    ],
    declaredPaths: {
      allowed: ["packages/broker/src/review-lifecycle/**"],
      forbidden: ["packages/broker/src/server.ts"],
    },
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    createdAt: "2026-07-23T12:00:00Z",
  };
  return {
    ...partial,
    intentHash: intentHash(partial as unknown as Record<string, unknown>),
  };
}

function budget(): ReviewLineageBudgetV1 {
  return {
    kind: "ReviewLineageBudgetV1",
    maxWallClockSeconds: 21600,
    maxCorrectionGenerations: 1,
    maxReviewerRuns: 2,
    maxReviewerReplacements: 1,
    repeatedFindingThreshold: 2,
    onExhaustion: "blocked_needs_operator",
  };
}

function binding(headSha = HEAD_SHA, diffHash = DIFF_HASH) {
  return {
    intentHash: contract().intentHash,
    headSha,
    diffHash,
  };
}

function createEnvelope(): Record<string, unknown> {
  return {
    kind: "a2a.review-lineage-observation.v1",
    producerId: "dispatcher-seoseo",
    sourceEventId: "github:pr-1518:freeze:1",
    lineageId: contract().lineageId,
    observedAt: "2026-07-23T12:01:00Z",
    binding: binding(),
    observation: {
      kind: "lineage_create",
      mode: "record",
      contract: contract(),
      budget: budget(),
    },
  };
}

function receipt(): ReviewReceiptV1 {
  return {
    kind: "ReviewReceiptV1",
    reviewerNodeId: "yukson",
    verdict: "fail",
    note: "One concrete regression remains.",
    headSha: HEAD_SHA,
    diffHash: DIFF_HASH,
    intentHash: contract().intentHash,
    findingLedgerRef: `ledger-${contract().lineageId}`,
    authorWorkerId: "bangtong",
    submittedAt: "2026-07-23T12:02:00Z",
  };
}

function finding(): FindingV1 {
  const signable = {
    criterionRef: "AC-1",
    category: "regression" as const,
    evidenceRefs: ["test:observation-red"],
  };
  return {
    findingId: "F-1",
    ...signable,
    severity: "major",
    blocking: true,
    introducedAtHead: HEAD_SHA,
    firstSeenAtHead: HEAD_SHA,
    resolvedAtHead: null,
    disposition: "open",
    signature: findingSignature(signable),
  };
}

function eventEnvelope(
  sourceEventId: string,
  observation: Record<string, unknown>,
  subject = binding(),
): Record<string, unknown> {
  return {
    kind: "a2a.review-lineage-observation.v1",
    producerId: "dispatcher-seoseo",
    sourceEventId,
    lineageId: contract().lineageId,
    observedAt: "2026-07-23T12:03:00Z",
    binding: subject,
    observation,
  };
}

function expectValidation(
  mutate: (value: Record<string, unknown>) => void,
  code: string,
  path: string,
): void {
  const input = createEnvelope();
  mutate(input);
  assert.throws(
    () => parseReviewLineageObservation(input),
    (error: unknown) =>
      error instanceof ObservationValidationError
      && error.code === code
      && error.path === path,
  );
}

test("observation: lineage_create projects an exact record-mode command", () => {
  const projected = parseReviewLineageObservation(createEnvelope());

  assert.equal(
    projected.kind,
    "a2a.review-lineage-observation-command.v1",
  );
  assert.match(projected.idempotencyKey, /^sha256:[0-9a-f]{64}$/);
  assert.match(projected.payloadFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(projected.expectedSubject, binding());
  assert.deepEqual(projected.command, {
    kind: "create_lineage",
    input: {
      contract: contract(),
      budget: budget(),
      at: "2026-07-23T12:01:00Z",
      diffHash: DIFF_HASH,
    },
  });
});

test("observation: equivalent key order has a stable fingerprint and command", () => {
  const original = createEnvelope();
  const reordered = JSON.parse(canonicalize(original)) as Record<string, unknown>;

  const a = parseReviewLineageObservation(original);
  const b = parseReviewLineageObservation(reordered);

  assert.equal(a.idempotencyKey, b.idempotencyKey);
  assert.equal(a.payloadFingerprint, b.payloadFingerprint);
  assert.deepEqual(a, b);
});

test("observation: review_report maps the complete explicit finding transition", () => {
  const input = eventEnvelope("github:pr-1518:review:1", {
    kind: "review_report",
    receipt: receipt(),
    resolvedFindingIds: [],
    reopenedFindingIds: [],
    newFindings: [finding()],
  });

  const projected = parseReviewLineageObservation(input);
  assert.deepEqual(projected.command, {
    kind: "record_event",
    lineageId: contract().lineageId,
    event: {
      type: "review_report",
      at: "2026-07-23T12:03:00Z",
      receipt: receipt(),
      resolvedFindingIds: [],
      reopenedFindingIds: [],
      newFindings: [finding()],
    },
  });
});

test("observation: correction_generation preserves current CAS binding and next subject", () => {
  const input = eventEnvelope("github:pr-1518:correction:1", {
    kind: "correction_generation",
    headSha: NEXT_HEAD_SHA,
    diffHash: NEXT_DIFF_HASH,
    intentHash: contract().intentHash,
    pathsChanged: ["packages/broker/src/review-lifecycle/observation.ts"],
  });

  const projected = parseReviewLineageObservation(input);
  assert.deepEqual(projected.expectedSubject, binding());
  assert.deepEqual(projected.command, {
    kind: "record_event",
    lineageId: contract().lineageId,
    event: {
      type: "correction_generation",
      at: "2026-07-23T12:03:00Z",
      headSha: NEXT_HEAD_SHA,
      diffHash: NEXT_DIFF_HASH,
      intentHash: contract().intentHash,
      pathsChanged: [
        "packages/broker/src/review-lifecycle/observation.ts",
      ],
    },
  });
});

test("observation: replacement and cancel map one-to-one without new semantics", () => {
  const replacement = parseReviewLineageObservation(
    eventEnvelope("worker:yukson:replacement:1", {
      kind: "reviewer_replacement",
      reason: "infrastructure_failure",
      detail: "Worker lease expired.",
    }),
  );
  assert.deepEqual(replacement.command, {
    kind: "record_event",
    lineageId: contract().lineageId,
    event: {
      type: "reviewer_replacement",
      at: "2026-07-23T12:03:00Z",
      reason: "infrastructure_failure",
      detail: "Worker lease expired.",
    },
  });

  const cancel = parseReviewLineageObservation(
    eventEnvelope("operator:cancel:1", {
      kind: "operator_cancel",
      detail: "Operator ended the lineage.",
    }),
  );
  assert.deepEqual(cancel.command, {
    kind: "record_event",
    lineageId: contract().lineageId,
    event: {
      type: "operator_cancel",
      at: "2026-07-23T12:03:00Z",
      detail: "Operator ended the lineage.",
    },
  });
});

test("observation: batch deduplicates same-key same-payload and sorts commands", () => {
  const create = createEnvelope();
  const cancel = eventEnvelope("operator:cancel:1", {
    kind: "operator_cancel",
  });
  const result = parseReviewLineageObservationBatch([
    cancel,
    create,
    structuredClone(create),
  ]);

  assert.equal(result.duplicateCount, 1);
  assert.equal(result.commands.length, 2);
  assert.deepEqual(
    result.commands.map((item) => item.idempotencyKey),
    [...result.commands.map((item) => item.idempotencyKey)].sort(),
  );
});

test("observation: same idempotency key with a different payload fails closed", () => {
  const first = createEnvelope();
  const conflicting = structuredClone(first);
  conflicting.observedAt = "2026-07-23T12:01:01Z";

  assert.throws(
    () => parseReviewLineageObservationBatch([first, conflicting]),
    (error: unknown) =>
      error instanceof ObservationValidationError
      && error.code === "idempotency_conflict"
      && error.path === "$[1]",
  );
});

test("observation: parsing never mutates the caller input", () => {
  const input = eventEnvelope("github:pr-1518:review:1", {
    kind: "review_report",
    receipt: receipt(),
    resolvedFindingIds: [],
    reopenedFindingIds: [],
    newFindings: [finding()],
  });
  const before = structuredClone(input);
  parseReviewLineageObservation(input);
  assert.deepEqual(input, before);
});

test("observation: strict envelope rejects unknown fields and versions", () => {
  expectValidation(
    (value) => {
      value.rawPrompt = "secret prompt content";
    },
    "unexpected_field",
    "$.rawPrompt",
  );
  expectValidation(
    (value) => {
      value.kind = "a2a.review-lineage-observation.v2";
    },
    "unsupported_version",
    "$.kind",
  );
});

test("observation: strict subject fields reject missing or malformed values", () => {
  expectValidation(
    (value) => {
      delete (value.binding as Record<string, unknown>).diffHash;
    },
    "invalid_hash",
    "$.binding.diffHash",
  );
  expectValidation(
    (value) => {
      (value.binding as Record<string, unknown>).headSha = "HEAD";
    },
    "invalid_sha",
    "$.binding.headSha",
  );
  expectValidation(
    (value) => {
      value.observedAt = "2026-07-23T21:01:00+09:00";
    },
    "invalid_timestamp",
    "$.observedAt",
  );
});

test("observation: create rejects enforce mode, contract hash drift, and binding drift", () => {
  expectValidation(
    (value) => {
      (value.observation as Record<string, unknown>).mode = "enforce";
    },
    "unsupported_mode",
    "$.observation.mode",
  );
  expectValidation(
    (value) => {
      const observation = value.observation as Record<string, unknown>;
      (observation.contract as Record<string, unknown>).goal = "Changed goal";
    },
    "intent_hash_mismatch",
    "$.observation.contract.intentHash",
  );
  expectValidation(
    (value) => {
      (value.binding as Record<string, unknown>).headSha = NEXT_HEAD_SHA;
    },
    "binding_mismatch",
    "$.binding.headSha",
  );
});

test("observation: review receipt must match the outer exact subject", () => {
  const input = eventEnvelope("github:pr-1518:review:1", {
    kind: "review_report",
    receipt: { ...receipt(), diffHash: NEXT_DIFF_HASH },
    resolvedFindingIds: [],
    reopenedFindingIds: [],
    newFindings: [],
  });
  assert.throws(
    () => parseReviewLineageObservation(input),
    (error: unknown) =>
      error instanceof ObservationValidationError
      && error.code === "binding_mismatch"
      && error.path === "$.observation.receipt.diffHash",
  );
});

test("observation: review transition ids are unique and disjoint", () => {
  const duplicate = eventEnvelope("github:pr-1518:review:1", {
    kind: "review_report",
    receipt: receipt(),
    resolvedFindingIds: ["F-1", "F-1"],
    reopenedFindingIds: [],
    newFindings: [],
  });
  assert.throws(
    () => parseReviewLineageObservation(duplicate),
    (error: unknown) =>
      error instanceof ObservationValidationError
      && error.code === "duplicate_value"
      && error.path === "$.observation.resolvedFindingIds[1]",
  );

  const overlap = eventEnvelope("github:pr-1518:review:2", {
    kind: "review_report",
    receipt: receipt(),
    resolvedFindingIds: ["F-1"],
    reopenedFindingIds: ["F-1"],
    newFindings: [],
  });
  assert.throws(
    () => parseReviewLineageObservation(overlap),
    (error: unknown) =>
      error instanceof ObservationValidationError
      && error.code === "transition_conflict"
      && error.path === "$.observation.reopenedFindingIds[0]",
  );
});

test("observation: correction must preserve frozen intent and change the subject", () => {
  const drift = eventEnvelope("github:pr-1518:correction:1", {
    kind: "correction_generation",
    headSha: NEXT_HEAD_SHA,
    diffHash: NEXT_DIFF_HASH,
    intentHash: `sha256:${"c".repeat(64)}`,
    pathsChanged: ["packages/broker/src/review-lifecycle/observation.ts"],
  });
  assert.throws(
    () => parseReviewLineageObservation(drift),
    (error: unknown) =>
      error instanceof ObservationValidationError
      && error.code === "binding_mismatch"
      && error.path === "$.observation.intentHash",
  );

  const unchanged = eventEnvelope("github:pr-1518:correction:2", {
    kind: "correction_generation",
    headSha: HEAD_SHA,
    diffHash: DIFF_HASH,
    intentHash: contract().intentHash,
    pathsChanged: ["packages/broker/src/review-lifecycle/observation.ts"],
  });
  assert.throws(
    () => parseReviewLineageObservation(unchanged),
    (error: unknown) =>
      error instanceof ObservationValidationError
      && error.code === "subject_not_changed"
      && error.path === "$.observation",
  );
});

test("observation: validation errors disclose only code and path", () => {
  const secret = "never-echo-this-provider-output";
  const input = createEnvelope();
  input.unexpectedProviderOutput = secret;

  let caught: unknown;
  try {
    parseReviewLineageObservation(input);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ObservationValidationError);
  assert.equal(caught.message, "unexpected_field at $.unexpectedProviderOutput");
  assert.equal(caught.message.includes(secret), false);
  assert.deepEqual(Object.keys(caught).sort(), ["code", "path"]);
});
