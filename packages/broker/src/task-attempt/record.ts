/**
 * TaskAttemptRecordV1 runtime contract implementation (#1799 slice 1).
 *
 * Mirrors the frozen source-only contract in
 * docs/specs/task-attempt-failure-sharing/spec.md exactly: closed record
 * shapes, public-safe identifier grammars, outcome/disposition reason
 * vocabularies, canonical JSON encoding, and the A2A-TAFS-FRAME-V1 framed
 * digests (recordKey / fingerprint). The golden conformance fixture
 * (fixtures/contract/task-attempt-failure-sharing.json) pins the same rules;
 * the runtime test suite cross-checks this module against that fixture so the
 * two implementations cannot drift silently.
 *
 * Contract boundary only: validation failure is `contract_rejected` data — it
 * never carries task-execution authority (spec §6, §9).
 */

import { createHash } from "node:crypto";

export type TaskAttemptProducerKind = "broker_execution" | "bounded_experiment";
export type BrokerAttemptOutcome = "succeeded" | "failed" | "canceled" | "superseded";
export type ExperimentDisposition = "keep" | "discard" | "crash";

export interface TaskAttemptRecordV1 {
  kind: "TaskAttemptRecordV1";
  version: 1;
  producerKind: TaskAttemptProducerKind;
  producerContract: string;
  brokerOfRecord: string;
  taskId: string;
  retryRootTaskId: string;
  attemptOrdinal: number;
  brokerOutcome?: BrokerAttemptOutcome;
  experimentId?: string;
  hypothesisId?: string;
  experimentDisposition?: ExperimentDisposition;
  reasonClass?: string;
  reasonCode?: string;
  identityDigestDomain: string;
  fingerprintDigestDomain: string;
  recordKey: string;
  fingerprint: string;
}

export const TASK_ATTEMPT_PRODUCERS = Object.freeze({
  broker_execution: Object.freeze({
    producerContract: "a2a.broker-execution.v1",
    identityDigestDomain: "a2a.task-attempt-record.v1.identity.broker-execution",
    fingerprintDigestDomain: "a2a.task-attempt-record.v1.fingerprint.broker-execution",
  }),
  bounded_experiment: Object.freeze({
    producerContract: "a2a.bounded-experiment.v1",
    identityDigestDomain: "a2a.task-attempt-record.v1.identity.bounded-experiment",
    fingerprintDigestDomain: "a2a.task-attempt-record.v1.fingerprint.bounded-experiment",
  }),
} as const);

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const BROKER_ID_PATTERN = /^brk_[0-9a-f]{16}$/;
const TASK_ID_PATTERN = /^tsk_[0-9a-f]{32}$/;
const EXPERIMENT_ID_PATTERN = /^exp_[0-9a-f]{32}$/;
const HYPOTHESIS_ID_PATTERN = /^hyp_[0-9a-f]{32}$/;
const FRAME_HEADER = Buffer.from("A2A-TAFS-FRAME-V1\0", "ascii");

/** Closed reason vocabulary per broker outcome (spec §3.2). */
const BROKER_REASONS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = Object.freeze({
  failed: Object.freeze({
    execution_failure: Object.freeze(["producer_reported_failure"]),
    dependency_failure: Object.freeze(["dependency_unavailable"]),
    resource_exhaustion: Object.freeze(["limit_exceeded"]),
    contract_rejection: Object.freeze(["invalid_request"]),
  }),
  canceled: Object.freeze({
    cancellation: Object.freeze(["before_start", "during_execution"]),
  }),
  superseded: Object.freeze({
    supersession: Object.freeze(["newer_attempt"]),
  }),
});

/** Closed reason vocabulary per experiment disposition (spec §3.3). */
const EXPERIMENT_REASONS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = Object.freeze({
  discard: Object.freeze({
    measurement_result: Object.freeze(["no_improvement", "regression"]),
    measurement_validity: Object.freeze(["invalid_measurement"]),
  }),
  crash: Object.freeze({
    execution_crash: Object.freeze(["process_exit"]),
    resource_exhaustion: Object.freeze(["limit_exceeded"]),
    dependency_failure: Object.freeze(["dependency_unavailable"]),
  }),
});

const COMMON_FIELDS = [
  "kind",
  "version",
  "producerKind",
  "producerContract",
  "brokerOfRecord",
  "taskId",
  "retryRootTaskId",
  "attemptOrdinal",
  "identityDigestDomain",
  "fingerprintDigestDomain",
  "recordKey",
  "fingerprint",
] as const;

/**
 * Canonical JSON per spec §5: ASCII-sorted keys, minimal integers, no
 * whitespace. null, floats, and non-ASCII strings are contract violations —
 * throw so callers surface `contract_rejected` instead of a wrong digest.
 */
export function canonicalTaskAttemptJson(value: unknown): string {
  if (typeof value === "string") {
    // eslint-disable-next-line no-control-regex
    if (!/^[\x00-\x7F]*$/.test(value)) throw new Error("non-ASCII string in canonical payload");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("non-integer number in canonical payload");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return "[" + value.map(canonicalTaskAttemptJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return (
      "{" +
      keys
        .map((k) => JSON.stringify(k) + ":" + canonicalTaskAttemptJson((value as Record<string, unknown>)[k]))
        .join(",") +
      "}"
    );
  }
  throw new Error("invalid canonical payload value");
}

/** A2A-TAFS-FRAME-V1 framed digest (spec §5). */
export function framedTaskAttemptDigest(domain: string, canonicalPayload: string): string {
  const domainBytes = Buffer.from(domain, "utf8");
  const payloadBytes = Buffer.from(canonicalPayload, "utf8");
  const domainLen = Buffer.alloc(4);
  domainLen.writeUInt32BE(domainBytes.length);
  const payloadLen = Buffer.alloc(4);
  payloadLen.writeUInt32BE(payloadBytes.length);
  const digest = createHash("sha256")
    .update(Buffer.concat([FRAME_HEADER, domainLen, domainBytes, payloadLen, payloadBytes]))
    .digest("hex");
  return "sha256:" + digest;
}

/** Canonical identity payload (spec §4) for recordKey computation. */
function identityPayload(record: Record<string, unknown>): Record<string, unknown> {
  const identity: Record<string, unknown> = {
    kind: record.kind,
    version: record.version,
    producerKind: record.producerKind,
    producerContract: record.producerContract,
    brokerOfRecord: record.brokerOfRecord,
    taskId: record.taskId,
    retryRootTaskId: record.retryRootTaskId,
    attemptOrdinal: record.attemptOrdinal,
  };
  if (record.producerKind === "bounded_experiment") {
    identity.experimentId = record.experimentId;
    identity.hypothesisId = record.hypothesisId;
  }
  return identity;
}

export function computeTaskAttemptRecordKey(record: Record<string, unknown>): string {
  return framedTaskAttemptDigest(
    String(record.identityDigestDomain),
    canonicalTaskAttemptJson(identityPayload(record)),
  );
}

export function computeTaskAttemptFingerprint(record: Record<string, unknown>): string {
  const withoutFingerprint: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k !== "fingerprint") withoutFingerprint[k] = v;
  }
  return framedTaskAttemptDigest(
    String(record.fingerprintDigestDomain),
    canonicalTaskAttemptJson(withoutFingerprint),
  );
}

export type TaskAttemptValidation =
  | { ok: true; record: TaskAttemptRecordV1 }
  | { ok: false; reason: string };

function reject(reason: string): TaskAttemptValidation {
  return { ok: false, reason };
}

/**
 * Full closed-record validation (spec §2-§5). Returns a typed record or a
 * stable machine-readable rejection reason. Never throws on foreign input.
 */
export function validateTaskAttemptRecord(input: unknown): TaskAttemptValidation {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return reject("not_an_object");
  }
  const raw = input as Record<string, unknown>;
  if (raw.kind !== "TaskAttemptRecordV1") return reject("kind_mismatch");
  if (raw.version !== 1) return reject("unknown_version");
  const producerKind = raw.producerKind;
  if (producerKind !== "broker_execution" && producerKind !== "bounded_experiment") {
    return reject("unknown_producer_kind");
  }
  const constants = TASK_ATTEMPT_PRODUCERS[producerKind];
  if (raw.producerContract !== constants.producerContract) return reject("producer_contract_mismatch");
  if (raw.identityDigestDomain !== constants.identityDigestDomain) return reject("identity_domain_mismatch");
  if (raw.fingerprintDigestDomain !== constants.fingerprintDigestDomain) {
    return reject("fingerprint_domain_mismatch");
  }
  if (typeof raw.brokerOfRecord !== "string" || !BROKER_ID_PATTERN.test(raw.brokerOfRecord)) {
    return reject("broker_of_record_grammar");
  }
  if (typeof raw.taskId !== "string" || !TASK_ID_PATTERN.test(raw.taskId)) return reject("task_id_grammar");
  if (typeof raw.retryRootTaskId !== "string" || !TASK_ID_PATTERN.test(raw.retryRootTaskId)) {
    return reject("retry_root_grammar");
  }
  const ordinal = raw.attemptOrdinal;
  if (typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 1024) {
    return reject("attempt_ordinal_bounds");
  }
  if (ordinal === 1 && raw.taskId !== raw.retryRootTaskId) return reject("ordinal_one_root_mismatch");
  if (typeof raw.recordKey !== "string" || !DIGEST_PATTERN.test(raw.recordKey)) return reject("record_key_grammar");
  if (typeof raw.fingerprint !== "string" || !DIGEST_PATTERN.test(raw.fingerprint)) {
    return reject("fingerprint_grammar");
  }

  const allowed = new Set<string>(COMMON_FIELDS);
  let reasonTable: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
  let resultValue: string;
  if (producerKind === "broker_execution") {
    allowed.add("brokerOutcome");
    const outcome = raw.brokerOutcome;
    if (outcome !== "succeeded" && outcome !== "failed" && outcome !== "canceled" && outcome !== "superseded") {
      return reject("broker_outcome_vocabulary");
    }
    if (raw.experimentId !== undefined || raw.hypothesisId !== undefined || raw.experimentDisposition !== undefined) {
      return reject("cross_producer_fields");
    }
    reasonTable = BROKER_REASONS;
    resultValue = outcome;
  } else {
    allowed.add("experimentId");
    allowed.add("hypothesisId");
    allowed.add("experimentDisposition");
    if (typeof raw.experimentId !== "string" || !EXPERIMENT_ID_PATTERN.test(raw.experimentId)) {
      return reject("experiment_id_grammar");
    }
    if (typeof raw.hypothesisId !== "string" || !HYPOTHESIS_ID_PATTERN.test(raw.hypothesisId)) {
      return reject("hypothesis_id_grammar");
    }
    const disposition = raw.experimentDisposition;
    if (disposition !== "keep" && disposition !== "discard" && disposition !== "crash") {
      return reject("experiment_disposition_vocabulary");
    }
    if (raw.brokerOutcome !== undefined) return reject("cross_producer_fields");
    reasonTable = EXPERIMENT_REASONS;
    resultValue = disposition;
  }

  const reasonClasses = reasonTable[resultValue];
  if (reasonClasses === undefined) {
    // succeeded / keep: structured reason must be absent.
    if (raw.reasonClass !== undefined || raw.reasonCode !== undefined) return reject("reason_forbidden");
  } else {
    allowed.add("reasonClass");
    allowed.add("reasonCode");
    const klass = raw.reasonClass;
    if (typeof klass !== "string" || reasonClasses[klass] === undefined) {
      // crash requires a class; broker failed/canceled/superseded require the pair.
      return reject("reason_class_vocabulary");
    }
    const code = raw.reasonCode;
    const experimentCrash = producerKind === "bounded_experiment" && resultValue === "crash";
    if (code === undefined) {
      // Only the experiment crash code is optional (spec §3.3).
      if (!experimentCrash) return reject("reason_code_required");
    } else if (typeof code !== "string" || !reasonClasses[klass].includes(code)) {
      return reject("reason_code_vocabulary");
    }
  }

  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) return reject("closed_field_violation");
  }

  let expectedKey: string;
  let expectedFingerprint: string;
  try {
    expectedKey = computeTaskAttemptRecordKey(raw);
    expectedFingerprint = computeTaskAttemptFingerprint(raw);
  } catch {
    return reject("canonical_encoding_failure");
  }
  if (raw.recordKey !== expectedKey) return reject("record_key_digest_mismatch");
  if (raw.fingerprint !== expectedFingerprint) return reject("fingerprint_digest_mismatch");

  return { ok: true, record: raw as unknown as TaskAttemptRecordV1 };
}

export interface BrokerExecutionAttemptInput {
  brokerOfRecord: string;
  taskId: string;
  retryRootTaskId: string;
  attemptOrdinal: number;
  brokerOutcome: BrokerAttemptOutcome;
  reasonClass?: string;
  reasonCode?: string;
}

/**
 * Build and fully validate a broker-execution record. Digest fields are
 * computed here, so callers supply only the closed identity and result
 * fields. Returns the validation result — an invalid input (out-of-vocabulary
 * reason, grammar violation) yields `ok:false` rather than throwing, because
 * per spec §3.2 a producer that cannot select a closed value must not emit.
 */
export function buildBrokerExecutionAttemptRecord(input: BrokerExecutionAttemptInput): TaskAttemptValidation {
  const constants = TASK_ATTEMPT_PRODUCERS.broker_execution;
  const draft: Record<string, unknown> = {
    kind: "TaskAttemptRecordV1",
    version: 1,
    producerKind: "broker_execution",
    producerContract: constants.producerContract,
    brokerOfRecord: input.brokerOfRecord,
    taskId: input.taskId,
    retryRootTaskId: input.retryRootTaskId,
    attemptOrdinal: input.attemptOrdinal,
    brokerOutcome: input.brokerOutcome,
    identityDigestDomain: constants.identityDigestDomain,
    fingerprintDigestDomain: constants.fingerprintDigestDomain,
  };
  if (input.reasonClass !== undefined) draft.reasonClass = input.reasonClass;
  if (input.reasonCode !== undefined) draft.reasonCode = input.reasonCode;
  try {
    draft.recordKey = computeTaskAttemptRecordKey(draft);
    draft.fingerprint = computeTaskAttemptFingerprint(draft);
  } catch {
    return { ok: false, reason: "canonical_encoding_failure" };
  }
  return validateTaskAttemptRecord(draft);
}
