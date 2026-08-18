/**
 * Broker-execution TaskAttemptRecordV1 producer (#1799 slice 1).
 *
 * Maps one terminal broker task snapshot to a public-safe attempt record and
 * submits it to the durable store. Every path is fail-open by construction:
 * a snapshot the closed vocabulary cannot honestly express is skipped, and
 * store/internal errors are returned as `skipped` — recording can never
 * affect task execution (spec §6, §9; issue #1799 acceptance).
 *
 * Honesty rules implemented here:
 *  - identifiers are store-assigned random aliases; no broker-local id,
 *    free-form text, or digest of private data enters a record (spec §2);
 *  - `failed` maps to `execution_failure/producer_reported_failure` only —
 *    the broker knows the worker reported failure, and claims nothing more;
 *  - cancellation maps to `superseded/…` only when the broker recorded an
 *    explicit supersession; otherwise `cancellation/before_start` or
 *    `cancellation/during_execution` from the claim history;
 *  - `attemptOrdinal` comes from the explicit `retryOfTaskId` lineage: a
 *    root task is ordinal 1; a retry gets the next ordinal after the records
 *    already durable under its root. Ordinals are never taken from broker
 *    retry counters or timestamps (spec §4).
 */

import {
  buildBrokerExecutionAttemptRecord,
  type BrokerAttemptOutcome,
  type TaskAttemptRecordV1,
} from "./record.js";
import type { TaskAttemptSubmitResult } from "./store.js";

/**
 * Structural store surface the producer (and the broker wiring) consumes, so
 * broker contracts depend on this shape rather than the SQLite class.
 */
export interface TaskAttemptStoreSurface {
  aliasFor(scope: "task" | "broker", localId: string): string;
  listByRetryRoot(brokerOfRecord: string, retryRootTaskId: string): TaskAttemptRecordV1[];
  submit(input: unknown): TaskAttemptSubmitResult;
}

export interface BrokerTerminalAttemptSnapshot {
  /** Broker-local task id (never enters the record; aliased). */
  localTaskId: string;
  /** Broker-local broker identity (never enters the record; aliased). */
  localBrokerId: string;
  status: "succeeded" | "failed" | "canceled";
  /** Set when the broker recorded an explicit cancellation kind. */
  cancellationKind?: "operator_cancel" | "superseded";
  /** True when the task had been claimed before reaching the terminal state. */
  everClaimed: boolean;
  /** Explicit retry lineage root, when this task is a retry (broker-local id). */
  retryOfLocalTaskId?: string;
}

export type BrokerTerminalAttemptResult =
  | TaskAttemptSubmitResult
  | { status: "skipped"; reason: string };

function mapOutcome(snapshot: BrokerTerminalAttemptSnapshot): {
  brokerOutcome: BrokerAttemptOutcome;
  reasonClass?: string;
  reasonCode?: string;
} | undefined {
  switch (snapshot.status) {
    case "succeeded":
      return { brokerOutcome: "succeeded" };
    case "failed":
      return {
        brokerOutcome: "failed",
        reasonClass: "execution_failure",
        reasonCode: "producer_reported_failure",
      };
    case "canceled":
      if (snapshot.cancellationKind === "superseded") {
        return { brokerOutcome: "superseded", reasonClass: "supersession", reasonCode: "newer_attempt" };
      }
      return {
        brokerOutcome: "canceled",
        reasonClass: "cancellation",
        reasonCode: snapshot.everClaimed ? "during_execution" : "before_start",
      };
    default:
      return undefined;
  }
}

/**
 * Record one terminal broker attempt. Idempotent per task: re-emission for the
 * same local task reproduces the same aliases and ordinal, so the store
 * answers `idempotent_replay`.
 */
export function recordBrokerTerminalAttempt(
  store: TaskAttemptStoreSurface,
  snapshot: BrokerTerminalAttemptSnapshot,
): BrokerTerminalAttemptResult {
  try {
    const mapped = mapOutcome(snapshot);
    if (mapped === undefined) {
      return { status: "skipped", reason: "unmappable_status" };
    }
    const brokerOfRecord = store.aliasFor("broker", snapshot.localBrokerId);
    const taskId = store.aliasFor("task", snapshot.localTaskId);
    const rootLocalId = snapshot.retryOfLocalTaskId ?? snapshot.localTaskId;
    const retryRootTaskId = store.aliasFor("task", rootLocalId);

    let attemptOrdinal: number;
    if (rootLocalId === snapshot.localTaskId) {
      attemptOrdinal = 1;
    } else {
      const prior = store.listByRetryRoot(brokerOfRecord, retryRootTaskId);
      const existing = prior.find((record) => record.taskId === taskId);
      attemptOrdinal =
        existing?.attemptOrdinal ??
        prior.reduce((max, record) => Math.max(max, record.attemptOrdinal), 1) + 1;
    }

    const built = buildBrokerExecutionAttemptRecord({
      brokerOfRecord,
      taskId,
      retryRootTaskId,
      attemptOrdinal,
      ...mapped,
    });
    if (!built.ok) {
      // Closed vocabulary could not express this attempt: do not emit (§3.2).
      return { status: "skipped", reason: built.reason };
    }
    return store.submit(built.record);
  } catch (error) {
    return { status: "skipped", reason: "producer_error:" + String((error as Error)?.message ?? error) };
  }
}
