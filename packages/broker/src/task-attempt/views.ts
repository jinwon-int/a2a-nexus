/**
 * TaskAttemptRecordV1 read-only advisory views (#1799 slice 2).
 *
 * Implements the two views the frozen contract defines but slice 1
 * deliberately left unbuilt:
 *
 * - spec §7 `TaskAttemptFailureChannelProjectionV1`
 * - spec §8 `TaskAttemptHistoryPreflightResponseV1`
 *
 * Both are **advisory**. Per §7/§8 a consumer MUST NOT turn presence, absence,
 * count, class, or code into automatic denial, retry, finalization, success,
 * or dispatch behavior — hence the pinned `automaticDeny=false`,
 * `retryAuthority=not_provided`, `finalizerVerdict=not_provided`,
 * `successEvidence=false`, `automaticDispatchPolicy=none` constants.
 *
 * ## Fail-closed data, fail-open execution (spec §9)
 *
 * §9 says malformed/unknown input is "treated as no usable TaskAttemptRecordV1
 * data" and that failing closed "leaves existing task execution unchanged".
 * These two requirements together mean a bad row must be **excluded from the
 * view**, not thrown out of the read: a single corrupted record cannot be
 * allowed to take down a dispatcher's preflight. Every builder here therefore
 * drops unusable records and reports the count in {@link TaskAttemptViewDiagnostics}
 * rather than raising.
 *
 * This is the one place where the runtime deliberately diverges from
 * `test/conformance/check-task-attempt-failure-sharing.mjs`, which *rejects*
 * on malformed input. That checker validates a curated fixture, where a bad
 * record is an authoring error; here the input is a live store, where a bad
 * row is an operational fact to be survived. The shapes both produce for
 * well-formed input are byte-identical, and views.test.ts pins that against
 * the same golden fixture.
 *
 * ## Bounds
 *
 * §7 caps entries at 64, §8 caps `priorFailures` at 32. A view carrying more
 * is malformed, so the builders truncate after the canonical sort (keeping the
 * canonically-first N, which is deterministic) and report `truncated` in the
 * diagnostics. The bound is never reported inside the closed view itself —
 * the view has no field for it and must stay closed.
 */
import {
  validateTaskAttemptRecord,
  type BrokerAttemptOutcome,
  type ExperimentDisposition,
  type TaskAttemptProducerKind,
  type TaskAttemptRecordV1,
} from "./record.js";

/** spec §7: the projection carries at most 64 entries. */
export const FAILURE_CHANNEL_MAX_ENTRIES = 64;
/** spec §8: the preflight carries at most 32 prior failures. */
export const PREFLIGHT_MAX_PRIOR_FAILURES = 32;

/** Broker outcomes that belong to the failure channel (spec §7). */
const ELIGIBLE_BROKER_OUTCOMES: readonly BrokerAttemptOutcome[] = ["failed", "canceled", "superseded"];
/** Experiment dispositions that belong to the failure channel (spec §7). */
const ELIGIBLE_EXPERIMENT_DISPOSITIONS: readonly ExperimentDisposition[] = ["discard", "crash"];

export interface TaskAttemptFailureProjectionEntryV1 {
  kind: "TaskAttemptFailureProjectionEntryV1";
  version: 1;
  producerKind: TaskAttemptProducerKind;
  producerContract: string;
  brokerOfRecord: string;
  taskId: string;
  retryRootTaskId: string;
  attemptOrdinal: number;
  recordKey: string;
  fingerprint: string;
  brokerOutcome?: BrokerAttemptOutcome;
  experimentId?: string;
  hypothesisId?: string;
  experimentDisposition?: ExperimentDisposition;
  reasonClass?: string;
  reasonCode?: string;
}

export interface TaskAttemptFailureChannelProjectionV1 {
  kind: "TaskAttemptFailureChannelProjectionV1";
  version: 1;
  viewMode: "read_only_advisory";
  entries: TaskAttemptFailureProjectionEntryV1[];
}

export interface TaskAttemptHistoryQueryV1 {
  kind: "TaskAttemptHistoryQueryV1";
  version: 1;
  producerKind: TaskAttemptProducerKind;
  producerContract: string;
  brokerOfRecord: string;
  retryRootTaskId: string;
  experimentId?: string;
  hypothesisId?: string;
  candidateAttemptOrdinal: number;
}

export interface TaskAttemptHistoryPreflightResponseV1 {
  kind: "TaskAttemptHistoryPreflightResponseV1";
  version: 1;
  viewMode: "read_only_advisory";
  query: TaskAttemptHistoryQueryV1;
  priorFailures: TaskAttemptFailureProjectionEntryV1[];
  /** Pinned false: this view never denies (spec §8). */
  automaticDeny: false;
  retryAuthority: "not_provided";
  finalizerVerdict: "not_provided";
  successEvidence: false;
  automaticDispatchPolicy: "none";
}

export interface TaskAttemptViewDiagnostics {
  /** Source rows that failed re-validation and were excluded (spec §9). */
  unusableRecords: number;
  /** Eligible entries dropped to stay inside the closed bound. */
  truncatedEntries: number;
}

/** spec §7: `succeeded` and `keep` are not failure-channel entries. */
export function isFailureChannelEligible(record: TaskAttemptRecordV1): boolean {
  if (record.producerKind === "broker_execution") {
    return (
      record.brokerOutcome !== undefined &&
      ELIGIBLE_BROKER_OUTCOMES.includes(record.brokerOutcome)
    );
  }
  return (
    record.experimentDisposition !== undefined &&
    ELIGIBLE_EXPERIMENT_DISPOSITIONS.includes(record.experimentDisposition)
  );
}

/**
 * Project one eligible record into a closed entry.
 *
 * Field order matters for nothing here (the canonical encoder sorts keys), but
 * field *presence* does: `reasonCode` is copied only when the source record
 * carries it, because the `crash` disposition permits a class without a code
 * and a materialized `reasonCode: undefined` would break the closed-field
 * check on the consuming side.
 */
export function projectFailureEntry(record: TaskAttemptRecordV1): TaskAttemptFailureProjectionEntryV1 {
  const common = {
    kind: "TaskAttemptFailureProjectionEntryV1",
    version: 1,
    producerKind: record.producerKind,
    producerContract: record.producerContract,
    brokerOfRecord: record.brokerOfRecord,
    taskId: record.taskId,
    retryRootTaskId: record.retryRootTaskId,
    attemptOrdinal: record.attemptOrdinal,
    recordKey: record.recordKey,
    fingerprint: record.fingerprint,
  } as const;
  const variant =
    record.producerKind === "broker_execution"
      ? { brokerOutcome: record.brokerOutcome }
      : {
          experimentId: record.experimentId,
          hypothesisId: record.hypothesisId,
          experimentDisposition: record.experimentDisposition,
        };
  return {
    ...common,
    ...variant,
    reasonClass: record.reasonClass,
    ...(record.reasonCode !== undefined ? { reasonCode: record.reasonCode } : {}),
  };
}

/**
 * spec §7 canonical order: the ASCII tuple
 * `producerKind, brokerOfRecord, retryRootTaskId, experimentId-or-empty,
 * hypothesisId-or-empty, attemptOrdinal, recordKey`.
 *
 * The ordinal is zero-padded to four digits so it compares as a number under
 * ASCII string ordering (`0002` before `0010`); 1024 is the contract maximum,
 * so four digits always suffice. NUL joins the parts so a value containing the
 * separator cannot forge a different tuple — the closed grammars exclude NUL,
 * which is exactly why it is safe to use.
 */
function entrySortTuple(entry: TaskAttemptFailureProjectionEntryV1): string {
  return [
    entry.producerKind,
    entry.brokerOfRecord,
    entry.retryRootTaskId,
    entry.experimentId ?? "",
    entry.hypothesisId ?? "",
    String(entry.attemptOrdinal).padStart(4, "0"),
    entry.recordKey,
  ].join("\0");
}

export function compareFailureProjectionEntries(
  left: TaskAttemptFailureProjectionEntryV1,
  right: TaskAttemptFailureProjectionEntryV1,
): number {
  const leftTuple = entrySortTuple(left);
  const rightTuple = entrySortTuple(right);
  if (leftTuple === rightTuple) return 0;
  return leftTuple < rightTuple ? -1 : 1;
}

/**
 * Re-validate foreign rows, keep the failure-channel-eligible ones, project
 * and canonically order them. Unusable rows are counted, never thrown.
 */
function collectEntries(
  records: readonly unknown[],
  limit: number,
  extraFilter?: (record: TaskAttemptRecordV1) => boolean,
): { entries: TaskAttemptFailureProjectionEntryV1[]; diagnostics: TaskAttemptViewDiagnostics } {
  let unusableRecords = 0;
  const eligible: TaskAttemptFailureProjectionEntryV1[] = [];
  for (const candidate of records) {
    const validation = validateTaskAttemptRecord(candidate);
    if (!validation.ok) {
      unusableRecords += 1;
      continue;
    }
    const record = validation.record;
    if (extraFilter !== undefined && !extraFilter(record)) continue;
    if (!isFailureChannelEligible(record)) continue;
    eligible.push(projectFailureEntry(record));
  }
  eligible.sort(compareFailureProjectionEntries);
  const entries = eligible.slice(0, limit);
  return {
    entries,
    diagnostics: { unusableRecords, truncatedEntries: eligible.length - entries.length },
  };
}

/** spec §7 failure-channel projection over an arbitrary record set. */
export function buildFailureChannelProjection(records: readonly unknown[]): {
  projection: TaskAttemptFailureChannelProjectionV1;
  diagnostics: TaskAttemptViewDiagnostics;
} {
  const { entries, diagnostics } = collectEntries(records, FAILURE_CHANNEL_MAX_ENTRIES);
  return {
    projection: {
      kind: "TaskAttemptFailureChannelProjectionV1",
      version: 1,
      viewMode: "read_only_advisory",
      entries,
    },
    diagnostics,
  };
}

const BROKER_ID_PATTERN = /^brk_[0-9a-f]{16}$/;
const TASK_ID_PATTERN = /^tsk_[0-9a-f]{32}$/;
const EXPERIMENT_ID_PATTERN = /^exp_[0-9a-f]{32}$/;
const HYPOTHESIS_ID_PATTERN = /^hyp_[0-9a-f]{32}$/;

const PRODUCER_CONTRACTS: Record<TaskAttemptProducerKind, string> = {
  broker_execution: "a2a.broker-execution.v1",
  bounded_experiment: "a2a.bounded-experiment.v1",
};

/**
 * Validate a caller-supplied preflight query fail-closed.
 *
 * A malformed query yields no view at all rather than an empty one: an empty
 * `priorFailures` reads as "no prior failures", which is a materially
 * different claim from "the question could not be asked". Conflating them is
 * how an advisory view starts lying.
 */
export function validateTaskAttemptHistoryQuery(
  input: unknown,
): { ok: true; query: TaskAttemptHistoryQueryV1 } | { ok: false; reason: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "not_an_object" };
  }
  const candidate = input as Record<string, unknown>;
  if (candidate.kind !== "TaskAttemptHistoryQueryV1") return { ok: false, reason: "kind_mismatch" };
  if (candidate.version !== 1) return { ok: false, reason: "version_mismatch" };

  const producerKind = candidate.producerKind;
  if (producerKind !== "broker_execution" && producerKind !== "bounded_experiment") {
    return { ok: false, reason: "unknown_producer_kind" };
  }
  if (candidate.producerContract !== PRODUCER_CONTRACTS[producerKind]) {
    return { ok: false, reason: "producer_binding_mismatch" };
  }
  if (typeof candidate.brokerOfRecord !== "string" || !BROKER_ID_PATTERN.test(candidate.brokerOfRecord)) {
    return { ok: false, reason: "invalid_broker_of_record" };
  }
  if (typeof candidate.retryRootTaskId !== "string" || !TASK_ID_PATTERN.test(candidate.retryRootTaskId)) {
    return { ok: false, reason: "invalid_retry_root_task_id" };
  }
  const ordinal = candidate.candidateAttemptOrdinal;
  if (typeof ordinal !== "number" || !Number.isInteger(ordinal) || ordinal < 1 || ordinal > 1024) {
    return { ok: false, reason: "invalid_candidate_attempt_ordinal" };
  }

  const isExperiment = producerKind === "bounded_experiment";
  if (isExperiment) {
    // spec §8: an experiment query REQUIRES both explicit identifiers. A broker
    // query does not infer a hypothesis, so carrying one is a contract error
    // rather than a harmless extra.
    if (typeof candidate.experimentId !== "string" || !EXPERIMENT_ID_PATTERN.test(candidate.experimentId)) {
      return { ok: false, reason: "invalid_experiment_id" };
    }
    if (typeof candidate.hypothesisId !== "string" || !HYPOTHESIS_ID_PATTERN.test(candidate.hypothesisId)) {
      return { ok: false, reason: "invalid_hypothesis_id" };
    }
  } else if (candidate.experimentId !== undefined || candidate.hypothesisId !== undefined) {
    return { ok: false, reason: "broker_query_carries_experiment_identity" };
  }

  const allowed = new Set([
    "kind",
    "version",
    "producerKind",
    "producerContract",
    "brokerOfRecord",
    "retryRootTaskId",
    "candidateAttemptOrdinal",
    ...(isExperiment ? ["experimentId", "hypothesisId"] : []),
  ]);
  for (const key of Object.keys(candidate)) {
    if (!allowed.has(key)) return { ok: false, reason: "unknown_field:" + key };
  }

  const query: TaskAttemptHistoryQueryV1 = {
    kind: "TaskAttemptHistoryQueryV1",
    version: 1,
    producerKind,
    producerContract: candidate.producerContract as string,
    brokerOfRecord: candidate.brokerOfRecord,
    retryRootTaskId: candidate.retryRootTaskId,
    ...(isExperiment
      ? {
          experimentId: candidate.experimentId as string,
          hypothesisId: candidate.hypothesisId as string,
        }
      : {}),
    candidateAttemptOrdinal: ordinal,
  };
  return { ok: true, query };
}

/**
 * spec §8 dispatcher same-attempt-history preflight.
 *
 * Selects records sharing the producer/broker/retry-root binding with an
 * ordinal strictly below the candidate. An experiment query additionally
 * requires the same explicit experiment and hypothesis; a broker query never
 * infers a hypothesis.
 */
export function buildTaskAttemptHistoryPreflight(
  records: readonly unknown[],
  query: TaskAttemptHistoryQueryV1,
): {
  preflight: TaskAttemptHistoryPreflightResponseV1;
  diagnostics: TaskAttemptViewDiagnostics;
} {
  const isExperiment = query.producerKind === "bounded_experiment";
  const { entries, diagnostics } = collectEntries(
    records,
    PREFLIGHT_MAX_PRIOR_FAILURES,
    (record) =>
      record.producerKind === query.producerKind &&
      record.producerContract === query.producerContract &&
      record.brokerOfRecord === query.brokerOfRecord &&
      record.retryRootTaskId === query.retryRootTaskId &&
      record.attemptOrdinal < query.candidateAttemptOrdinal &&
      (!isExperiment ||
        (record.experimentId === query.experimentId && record.hypothesisId === query.hypothesisId)),
  );
  return {
    preflight: {
      kind: "TaskAttemptHistoryPreflightResponseV1",
      version: 1,
      viewMode: "read_only_advisory",
      query,
      priorFailures: entries,
      automaticDeny: false,
      retryAuthority: "not_provided",
      finalizerVerdict: "not_provided",
      successEvidence: false,
      automaticDispatchPolicy: "none",
    },
    diagnostics,
  };
}
