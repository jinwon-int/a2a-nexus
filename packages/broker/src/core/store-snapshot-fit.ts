import { isTerminalTaskStatus } from "./broker-status-predicates.js";
import { serializeBrokerSnapshot } from "./store-snapshot-io.js";
import { CURRENT_BROKER_STATE_VERSION, type BrokerSnapshot } from "./store-contracts.js";

/**
 * Canonical-snapshot budget fitting (#1578/#1579).
 *
 * The canonical snapshot row is a compatibility mirror plus the carrier for
 * snapshot-only sidecars (push configs, wave plans, terminal-brief
 * projections); the hot entity tables are authoritative for runtime state.
 * When the full snapshot exceeds the byte budget the writer must therefore
 * degrade the *mirror* — shed oldest terminal tasks — instead of refusing to
 * persist anything at all (which previously also rolled back the hot tables
 * and left two production brokers silently unpersisted for days/weeks).
 *
 * Only terminal tasks are ever shed. Non-terminal tasks, tombstones, outbox
 * events, and sidecar fields are never dropped here. If even the
 * terminal-free remainder exceeds the budget, SnapshotOverflowError is thrown
 * so the caller can degrade visibly while still persisting hot tables.
 */
export class SnapshotOverflowError extends Error {
  readonly bytes: number;
  readonly maxBytes: number;

  constructor(bytes: number, maxBytes: number) {
    super(`broker snapshot exceeds max size (${bytes} > ${maxBytes} bytes)`);
    this.name = "SnapshotOverflowError";
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

export interface SnapshotFitResult {
  /** The snapshot actually written (input when it already fits). */
  snapshot: BrokerSnapshot;
  /** Serialized payload guaranteed to be within budget. */
  payload: string;
  /** Number of oldest terminal tasks shed from the canonical mirror. */
  shedTerminalTasks: number;
}

function measureSnapshotBytes(snapshot: BrokerSnapshot): number {
  return Buffer.byteLength(
    JSON.stringify({ ...snapshot, version: CURRENT_BROKER_STATE_VERSION }, null, 2),
    "utf8",
  );
}

function trySerialize(snapshot: BrokerSnapshot, maxBytes: number): string | undefined {
  try {
    return serializeBrokerSnapshot(snapshot, maxBytes);
  } catch {
    return undefined;
  }
}

function terminalSortKey(task: BrokerSnapshot["tasks"][number]): string {
  return task.completedAt ?? task.updatedAt;
}

/**
 * Return a budget-fitting snapshot, shedding oldest terminal tasks when
 * needed. Throws SnapshotOverflowError when even the terminal-free remainder
 * exceeds maxBytes.
 */
export function fitSnapshotToBudget(
  snapshot: BrokerSnapshot,
  maxBytes: number,
): SnapshotFitResult {
  const direct = trySerialize(snapshot, maxBytes);
  if (direct !== undefined) {
    return { snapshot, payload: direct, shedTerminalTasks: 0 };
  }

  const terminalOldestFirst = snapshot.tasks
    .filter((task) => isTerminalTaskStatus(task.status))
    .sort((a, b) => terminalSortKey(a).localeCompare(terminalSortKey(b)));
  if (terminalOldestFirst.length === 0) {
    throw new SnapshotOverflowError(measureSnapshotBytes(snapshot), maxBytes);
  }

  // Halving search: at most ~log2(terminal count) serializations.
  let shedCount = 0;
  let remaining = terminalOldestFirst.length;
  while (remaining > 0) {
    const shedNow = Math.max(1, Math.ceil(remaining / 2));
    shedCount += shedNow;
    remaining -= shedNow;
    const shedIds = new Set(
      terminalOldestFirst.slice(0, shedCount).map((task) => task.id),
    );
    const fitted: BrokerSnapshot = {
      ...snapshot,
      tasks: snapshot.tasks.filter((task) => !shedIds.has(task.id)),
    };
    const payload = trySerialize(fitted, maxBytes);
    if (payload !== undefined) {
      return { snapshot: fitted, payload, shedTerminalTasks: shedCount };
    }
  }

  const terminalFree: BrokerSnapshot = {
    ...snapshot,
    tasks: snapshot.tasks.filter((task) => !isTerminalTaskStatus(task.status)),
  };
  throw new SnapshotOverflowError(measureSnapshotBytes(terminalFree), maxBytes);
}
