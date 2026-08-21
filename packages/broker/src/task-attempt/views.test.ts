import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryA2ABroker } from "../core/broker.js";
import { canonicalTaskAttemptJson } from "./record.js";
import { TaskAttemptRecordStore } from "./store.js";
import { recordBrokerTerminalAttempt, type TaskAttemptStoreSurface } from "./producer.js";
import {
  buildFailureChannelProjection,
  buildTaskAttemptHistoryPreflight,
  compareFailureProjectionEntries,
  FAILURE_CHANNEL_MAX_ENTRIES,
  isFailureChannelEligible,
  PREFLIGHT_MAX_PRIOR_FAILURES,
  projectFailureEntry,
  validateTaskAttemptHistoryQuery,
  type TaskAttemptHistoryQueryV1,
} from "./views.js";

/**
 * #1799 slice 2 — spec §7/§8 advisory views.
 *
 * The load-bearing tests here are the two golden cross-validations: the
 * runtime builders must reproduce `fixtures/contract/task-attempt-failure-sharing.json`
 * byte-for-byte under canonical encoding. That fixture is what
 * `test/conformance/check-task-attempt-failure-sharing.mjs` validates, so
 * pinning both against it is what stops the runtime and the conformance
 * checker drifting apart silently — the same guarantee slice 1 established
 * for records and digest vectors.
 */

const FIXTURE = JSON.parse(
  readFileSync(
    join(process.cwd(), "..", "..", "fixtures", "contract", "task-attempt-failure-sharing.json"),
    "utf8",
  ),
) as {
  records: unknown[];
  failureChannelProjection: unknown;
  dispatcherPreflight: { query: TaskAttemptHistoryQueryV1 } & Record<string, unknown>;
};

test("failure-channel projection reproduces the golden fixture exactly (#1799 slice 2)", () => {
  const { projection, diagnostics } = buildFailureChannelProjection(FIXTURE.records);

  assert.equal(
    canonicalTaskAttemptJson(projection),
    canonicalTaskAttemptJson(FIXTURE.failureChannelProjection),
    "the runtime projection must match the conformance golden under canonical encoding",
  );
  assert.deepEqual(diagnostics, { unusableRecords: 0, truncatedEntries: 0 });
});

test("dispatcher preflight reproduces the golden fixture exactly (#1799 slice 2)", () => {
  const parsed = validateTaskAttemptHistoryQuery(FIXTURE.dispatcherPreflight.query);
  assert.ok(parsed.ok, "the golden query must validate");
  if (!parsed.ok) return;

  const { preflight, diagnostics } = buildTaskAttemptHistoryPreflight(FIXTURE.records, parsed.query);

  assert.equal(
    canonicalTaskAttemptJson(preflight),
    canonicalTaskAttemptJson(FIXTURE.dispatcherPreflight),
    "the runtime preflight must match the conformance golden under canonical encoding",
  );
  assert.deepEqual(diagnostics, { unusableRecords: 0, truncatedEntries: 0 });
});

test("the preflight never carries denial, authority, verdict, or success signals", () => {
  const parsed = validateTaskAttemptHistoryQuery(FIXTURE.dispatcherPreflight.query);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const { preflight } = buildTaskAttemptHistoryPreflight(FIXTURE.records, parsed.query);

  // spec §8 pins all five. A consumer that reads a prior failure must still
  // not be handed anything that looks like a decision.
  assert.equal(preflight.automaticDeny, false);
  assert.equal(preflight.retryAuthority, "not_provided");
  assert.equal(preflight.finalizerVerdict, "not_provided");
  assert.equal(preflight.successEvidence, false);
  assert.equal(preflight.automaticDispatchPolicy, "none");
  assert.ok(preflight.priorFailures.length > 0, "the golden case returns a prior failure");
});

test("succeeded and keep records are not failure-channel entries", () => {
  const records = FIXTURE.records as Array<Record<string, unknown>>;
  const succeeded = records.filter((r) => r.brokerOutcome === "succeeded");
  const kept = records.filter((r) => r.experimentDisposition === "keep");
  assert.ok(succeeded.length > 0, "fixture should contain a succeeded record");
  assert.ok(kept.length > 0, "fixture should contain a kept experiment record");

  const { projection } = buildFailureChannelProjection(FIXTURE.records);
  const projectedKeys = new Set(projection.entries.map((entry) => entry.recordKey));
  for (const record of [...succeeded, ...kept]) {
    assert.equal(
      projectedKeys.has(record.recordKey as string),
      false,
      "a non-failure outcome must never reach the failure channel",
    );
  }
});

test("unusable records are excluded and counted, not thrown (spec §9)", () => {
  const corrupted = [
    ...FIXTURE.records,
    { kind: "TaskAttemptRecordV1", version: 1, producerKind: "nonsense" },
    null,
    "not-a-record",
    { kind: "TaskAttemptRecordV1", version: 2 },
  ];

  const { projection, diagnostics } = buildFailureChannelProjection(corrupted);

  // The good entries survive: one bad row must not take down a dispatcher read.
  assert.equal(
    canonicalTaskAttemptJson(projection),
    canonicalTaskAttemptJson(FIXTURE.failureChannelProjection),
    "valid entries must be unaffected by neighbouring corruption",
  );
  assert.equal(diagnostics.unusableRecords, 4, "every unusable row must be counted");
});

test("entries beyond the closed bound are truncated deterministically and reported", () => {
  const eligible = (FIXTURE.records as Array<Record<string, unknown>>).filter((record) => {
    const validated = record as { brokerOutcome?: string; experimentDisposition?: string };
    return (
      ["failed", "canceled", "superseded"].includes(validated.brokerOutcome ?? "") ||
      ["discard", "crash"].includes(validated.experimentDisposition ?? "")
    );
  });
  assert.ok(eligible.length >= 3, "fixture should provide several eligible records");

  // Fabricate an over-bound set by repeating the eligible records with distinct
  // retry roots so each projects to a distinct entry.
  const many: unknown[] = [];
  for (let index = 0; index < 30; index += 1) {
    for (const record of eligible) many.push(record);
  }
  const { projection, diagnostics } = buildFailureChannelProjection(many);

  assert.ok(
    projection.entries.length <= FAILURE_CHANNEL_MAX_ENTRIES,
    "the projection must never exceed its closed bound",
  );
  assert.ok(diagnostics.truncatedEntries > 0, "truncation must be reported, never silent");

  // Deterministic: the kept slice is the canonically-first N, so a second build
  // over the same input returns the same entries.
  const again = buildFailureChannelProjection(many);
  assert.equal(
    canonicalTaskAttemptJson(projection),
    canonicalTaskAttemptJson(again.projection),
    "truncation must be deterministic across reads",
  );
});

test("canonical ordering follows the spec ASCII tuple, ordinal compared numerically", () => {
  const base = {
    kind: "TaskAttemptFailureProjectionEntryV1" as const,
    version: 1 as const,
    producerKind: "broker_execution" as const,
    producerContract: "a2a.broker-execution.v1",
    brokerOfRecord: "brk_a1b2c3d4e5f60718",
    retryRootTaskId: "tsk_11111111111111111111111111111111",
    recordKey: "sha256:" + "a".repeat(64),
    fingerprint: "sha256:" + "b".repeat(64),
    brokerOutcome: "failed" as const,
    reasonClass: "dependency_failure",
    reasonCode: "dependency_unavailable",
  };
  const ordinal2 = { ...base, taskId: "tsk_" + "2".repeat(32), attemptOrdinal: 2 };
  const ordinal10 = { ...base, taskId: "tsk_" + "3".repeat(32), attemptOrdinal: 10 };

  // Zero-padding is the point: a naive string compare would put "10" before "2".
  assert.ok(
    compareFailureProjectionEntries(ordinal2, ordinal10) < 0,
    "ordinal 2 must sort before ordinal 10",
  );

  // bounded_experiment sorts before broker_execution: ASCII 'o' < 'r' at index 1.
  const experimentEntry = {
    ...base,
    taskId: "tsk_" + "4".repeat(32),
    attemptOrdinal: 1,
    producerKind: "bounded_experiment" as const,
    producerContract: "a2a.bounded-experiment.v1",
  };
  assert.ok(
    compareFailureProjectionEntries(experimentEntry, ordinal2) < 0,
    "bounded_experiment must sort before broker_execution",
  );
});

test("a crash record keeps a class-only reason without materializing reasonCode", () => {
  const crash = (FIXTURE.records as Array<Record<string, unknown>>).find(
    (record) => record.experimentDisposition === "crash",
  );
  assert.ok(crash, "fixture should contain a class-only crash record");

  const entry = projectFailureEntry(crash as never);

  assert.equal(entry.reasonClass, "resource_exhaustion");
  assert.equal(
    Object.hasOwn(entry, "reasonCode"),
    false,
    "an absent reasonCode must stay absent, not become an undefined key",
  );
  assert.equal(isFailureChannelEligible(crash as never), true);
});

test("preflight query validation fails closed on malformed input", () => {
  const valid = FIXTURE.dispatcherPreflight.query;

  const cases: Array<[string, unknown, string]> = [
    ["not an object", "nope", "not_an_object"],
    ["wrong kind", { ...valid, kind: "Other" }, "kind_mismatch"],
    ["wrong version", { ...valid, version: 2 }, "version_mismatch"],
    ["unknown producer", { ...valid, producerKind: "other" }, "unknown_producer_kind"],
    [
      "mismatched contract",
      { ...valid, producerContract: "a2a.broker-execution.v1" },
      "producer_binding_mismatch",
    ],
    ["bad broker alias", { ...valid, brokerOfRecord: "brk_zzz" }, "invalid_broker_of_record"],
    ["ordinal 0", { ...valid, candidateAttemptOrdinal: 0 }, "invalid_candidate_attempt_ordinal"],
    ["ordinal 1025", { ...valid, candidateAttemptOrdinal: 1025 }, "invalid_candidate_attempt_ordinal"],
    ["extra field", { ...valid, extra: 1 }, "unknown_field:extra"],
  ];

  for (const [label, input, reason] of cases) {
    const result = validateTaskAttemptHistoryQuery(input);
    assert.equal(result.ok, false, `${label} must be rejected`);
    if (!result.ok) assert.equal(result.reason, reason, `${label} reason`);
  }
});

test("an experiment query requires both identifiers; a broker query carries neither", () => {
  const experimentQuery = FIXTURE.dispatcherPreflight.query;

  const missingHypothesis = { ...experimentQuery } as Record<string, unknown>;
  delete missingHypothesis.hypothesisId;
  const missing = validateTaskAttemptHistoryQuery(missingHypothesis);
  assert.equal(missing.ok, false, "an experiment query without a hypothesis must fail closed");

  // spec §8: "A broker query does not infer a hypothesis." Carrying one is a
  // contract error, not a harmless extra — inferring would let a broker retry
  // masquerade as semantic hypothesis equality (spec §4 rule 5).
  const brokerWithHypothesis = validateTaskAttemptHistoryQuery({
    kind: "TaskAttemptHistoryQueryV1",
    version: 1,
    producerKind: "broker_execution",
    producerContract: "a2a.broker-execution.v1",
    brokerOfRecord: "brk_a1b2c3d4e5f60718",
    retryRootTaskId: "tsk_11111111111111111111111111111111",
    hypothesisId: "hyp_0123456789abcdef0123456789abcdef",
    candidateAttemptOrdinal: 2,
  });
  assert.equal(brokerWithHypothesis.ok, false);
  if (!brokerWithHypothesis.ok) {
    assert.equal(brokerWithHypothesis.reason, "broker_query_carries_experiment_identity");
  }
});

test("preflight selects strictly lower ordinals in the same retry identity", () => {
  const brokerQuery: TaskAttemptHistoryQueryV1 = {
    kind: "TaskAttemptHistoryQueryV1",
    version: 1,
    producerKind: "broker_execution",
    producerContract: "a2a.broker-execution.v1",
    brokerOfRecord: "brk_a1b2c3d4e5f60718",
    retryRootTaskId: "tsk_11111111111111111111111111111111",
    candidateAttemptOrdinal: 1,
  };

  // Candidate ordinal 1 has nothing below it.
  const first = buildTaskAttemptHistoryPreflight(FIXTURE.records, brokerQuery);
  assert.deepEqual(first.preflight.priorFailures, []);

  // Ordinal 2 sees the ordinal-1 failure in the same lineage.
  const second = buildTaskAttemptHistoryPreflight(FIXTURE.records, {
    ...brokerQuery,
    candidateAttemptOrdinal: 2,
  });
  assert.equal(second.preflight.priorFailures.length, 1);
  assert.equal(second.preflight.priorFailures[0].attemptOrdinal, 1);
  assert.equal(second.preflight.priorFailures[0].retryRootTaskId, brokerQuery.retryRootTaskId);

  // A different retry root shares nothing.
  const otherRoot = buildTaskAttemptHistoryPreflight(FIXTURE.records, {
    ...brokerQuery,
    retryRootTaskId: "tsk_" + "9".repeat(32),
    candidateAttemptOrdinal: 1024,
  });
  assert.deepEqual(otherRoot.preflight.priorFailures, []);
  assert.ok(PREFLIGHT_MAX_PRIOR_FAILURES === 32);
});

// ---------------------------------------------------------------------------
// Broker read path (#1799 slice 2) — default-off, advisory, fail-open
// ---------------------------------------------------------------------------

function tempStore(): { store: TaskAttemptRecordStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "task-attempt-views-"));
  return { store: new TaskAttemptRecordStore(join(dir, "records.sqlite")), dir };
}

function brokerQueryFor(brokerOfRecord: string, retryRootTaskId: string, ordinal: number) {
  return {
    kind: "TaskAttemptHistoryQueryV1",
    version: 1,
    producerKind: "broker_execution",
    producerContract: "a2a.broker-execution.v1",
    brokerOfRecord,
    retryRootTaskId,
    candidateAttemptOrdinal: ordinal,
  };
}

test("broker preflight is fully absent by default (#1799 slice 2)", () => {
  const broker = new InMemoryA2ABroker();

  const diagnostics = broker.taskAttemptReadDiagnostics();
  assert.equal(diagnostics.enabled, false, "no store injected means the surface is off");
  assert.equal(
    broker.taskAttemptHistoryPreflight(
      brokerQueryFor("brk_a1b2c3d4e5f60718", "tsk_" + "1".repeat(32), 2),
    ),
    undefined,
    "the default broker must expose no view at all",
  );
  assert.equal(diagnostics.served, 0);
});

test("broker preflight returns prior failures without denying (#1799 slice 2)", () => {
  const { store, dir } = tempStore();
  try {
    const broker = new InMemoryA2ABroker(undefined, undefined, { taskAttemptRecordStore: store });

    // Seed one explicit retry lineage through the slice-1 producer: two failed
    // attempts under a shared root. Driving the producer directly keeps this
    // test about the READ path rather than about task lifecycle plumbing.
    assert.equal(
      recordBrokerTerminalAttempt(store, {
        localTaskId: "t-root",
        localBrokerId: "broker-local",
        status: "failed",
        everClaimed: true,
      }).status,
      "accepted",
    );
    assert.equal(
      recordBrokerTerminalAttempt(store, {
        localTaskId: "t-retry",
        localBrokerId: "broker-local",
        status: "failed",
        everClaimed: true,
        retryOfLocalTaskId: "t-root",
      }).status,
      "accepted",
    );

    const brokerAlias = store.aliasFor("broker", "broker-local");
    const rootAlias = store.aliasFor("task", "t-root");

    const preflight = broker.taskAttemptHistoryPreflight(brokerQueryFor(brokerAlias, rootAlias, 3));
    assert.ok(preflight, "an injected store must serve the view");
    if (!preflight) return;

    assert.equal(preflight.priorFailures.length, 2, "both prior failed attempts are advisory input");
    assert.deepEqual(
      preflight.priorFailures.map((entry) => entry.attemptOrdinal),
      [1, 2],
      "prior failures arrive in canonical ordinal order",
    );
    // The whole point: it reports history and grants nothing.
    assert.equal(preflight.automaticDeny, false);
    assert.equal(preflight.retryAuthority, "not_provided");
    assert.equal(preflight.successEvidence, false);

    const diagnostics = broker.taskAttemptReadDiagnostics();
    assert.equal(diagnostics.served, 1);
    assert.equal(diagnostics.unusableRecords, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unusable query yields no view, distinctly from an empty one (#1799 slice 2)", () => {
  const { store, dir } = tempStore();
  try {
    const broker = new InMemoryA2ABroker(undefined, undefined, { taskAttemptRecordStore: store });

    assert.equal(broker.taskAttemptHistoryPreflight({ kind: "wrong" }), undefined);
    const rejected = broker.taskAttemptReadDiagnostics();
    assert.equal(rejected.rejectedQueries, 1);
    assert.equal(rejected.lastRejectReason, "kind_mismatch");

    // A well-formed query against an empty lineage returns a real view with an
    // empty list — "asked and found nothing", not "could not ask".
    const empty = broker.taskAttemptHistoryPreflight(
      brokerQueryFor("brk_a1b2c3d4e5f60718", "tsk_" + "7".repeat(32), 2),
    );
    assert.ok(empty, "a valid query over no records still yields a view");
    assert.deepEqual(empty?.priorFailures, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a throwing store never breaks the read path (fail-open, spec §9)", () => {
  const throwing: TaskAttemptStoreSurface = {
    aliasFor() {
      throw new Error("alias boom");
    },
    listByRetryRoot() {
      throw new Error("read boom");
    },
    submit() {
      throw new Error("write boom");
    },
  };
  const broker = new InMemoryA2ABroker(undefined, undefined, { taskAttemptRecordStore: throwing });

  const preflight = broker.taskAttemptHistoryPreflight(
    brokerQueryFor("brk_a1b2c3d4e5f60718", "tsk_" + "1".repeat(32), 2),
  );

  assert.equal(preflight, undefined, "a failed read yields no view rather than propagating");
  const diagnostics = broker.taskAttemptReadDiagnostics();
  assert.equal(diagnostics.readErrors, 1);
  assert.ok(diagnostics.lastRejectReason?.startsWith("read_error:"));
});

test("the public view carries no operator diagnostics (projection split, #1799 slice 2)", () => {
  const parsed = validateTaskAttemptHistoryQuery(FIXTURE.dispatcherPreflight.query);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const { preflight } = buildTaskAttemptHistoryPreflight(FIXTURE.records, parsed.query);

  // The closed field set is exactly spec §8 — no store health leaks into it.
  assert.deepEqual(
    Object.keys(preflight).sort(),
    [
      "automaticDeny",
      "automaticDispatchPolicy",
      "finalizerVerdict",
      "kind",
      "priorFailures",
      "query",
      "retryAuthority",
      "successEvidence",
      "version",
      "viewMode",
    ],
    "the public preflight must stay closed to the spec §8 field set",
  );
  const serialized = JSON.stringify(preflight);
  for (const operatorOnly of ["unusableRecords", "truncatedEntries", "readErrors", "served"]) {
    assert.equal(
      serialized.includes(operatorOnly),
      false,
      `operator diagnostic ${operatorOnly} must never appear in the public view`,
    );
  }
});
