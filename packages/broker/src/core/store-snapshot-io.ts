import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  CURRENT_BROKER_STATE_VERSION,
  DEFAULT_BROKER_STATE_MAX_BYTES,
  type BrokerPersistenceInfo,
  type BrokerSnapshot,
  type BrokerStateSaveHints,
  type BrokerStateStore,
  type JsonFileBrokerStateStoreOptions,
} from "./store-contracts.js";
import { SNAPSHOT_RECORD_SCHEMAS, brokerSnapshotSchema } from "./store-schemas.js";

export class JsonFileBrokerStateStore implements BrokerStateStore {
  private readonly maxBytes: number;

  constructor(
    private readonly filePath: string,
    options: JsonFileBrokerStateStoreOptions = {},
  ) {
    this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_BROKER_STATE_MAX_BYTES);
  }

  load(): BrokerSnapshot {
    try {
      return readBrokerSnapshotFile(this.filePath, this.maxBytes);
    } catch (error) {
      if (isMissingFileError(error)) {
        return emptySnapshot();
      }
      const backupPath = brokerSnapshotBackupPath(this.filePath);
      if (existsSync(backupPath)) {
        return readBrokerSnapshotFile(backupPath, this.maxBytes);
      }
      throw error;
    }
  }

  save(snapshot: BrokerSnapshot, _hints?: BrokerStateSaveHints): void {
    writeBrokerSnapshotFile(this.filePath, snapshot, this.maxBytes);
  }

  getPersistenceInfo(): BrokerPersistenceInfo {
    return {
      kind: "json-file",
      stateFile: this.filePath,
      stateVersion: CURRENT_BROKER_STATE_VERSION,
    };
  }
}

export function emptySnapshot(): BrokerSnapshot {
  return {
    version: CURRENT_BROKER_STATE_VERSION,
    exchanges: [],
    exchangeMessages: [],
    proposals: [],
    artifacts: [],
    validations: [],
    auditEvents: [],
    workers: [],
    tasks: [],
    tombstones: [],
    terminalOutbox: [],
    crossBrokerTerminalBriefs: [],
    wavePlans: [],
    reviewLineages: [],
  };
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export function serializeBrokerSnapshot(
  snapshot: BrokerSnapshot,
  maxBytes: number = DEFAULT_BROKER_STATE_MAX_BYTES,
): string {
  // Compact serialization: the json-file store rewrites the whole snapshot
  // on every full persist, and indentation added 20-30% bytes to each write
  // (and to the SQLite canonical row) for no reader — loads JSON.parse it.
  const payload = JSON.stringify({
    ...snapshot,
    version: CURRENT_BROKER_STATE_VERSION,
  });
  const bytes = Buffer.byteLength(payload, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`broker snapshot exceeds max size (${bytes} > ${maxBytes} bytes)`);
  }
  return payload;
}

export function writeBrokerSnapshotFile(
  filePath: string,
  snapshot: BrokerSnapshot,
  maxBytes: number = DEFAULT_BROKER_STATE_MAX_BYTES,
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  const backupPath = brokerSnapshotBackupPath(filePath);
  const payload = serializeBrokerSnapshot(snapshot, maxBytes);
  writeFileSync(tempPath, payload, "utf8");
  fsyncFile(tempPath);
  if (existsSync(filePath)) {
    copyFileSync(filePath, backupPath);
    fsyncFile(backupPath);
  }
  renameSync(tempPath, filePath);
  fsyncDirectory(dirname(filePath));
}

function brokerSnapshotBackupPath(filePath: string): string {
  return `${filePath}.bak`;
}

function readBrokerSnapshotFile(filePath: string, maxBytes: number): BrokerSnapshot {
  const stat = statSync(filePath);
  if (stat.size > maxBytes) {
    throw new Error(
      `broker snapshot exceeds max size (${stat.size} > ${maxBytes} bytes): ${filePath}`,
    );
  }
  return parseSnapshotPayload(readFileSync(filePath, "utf8"), filePath, maxBytes);
}

function fsyncFile(filePath: string): void {
  const fd = openSync(filePath, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(dirPath: string): void {
  try {
    const fd = openSync(dirPath, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

export function parseSnapshotPayload(payload: string, source: string, maxBytes: number): BrokerSnapshot {
  const bytes = Buffer.byteLength(payload, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`broker snapshot exceeds max size (${bytes} > ${maxBytes} bytes): ${source}`);
  }
  const raw = JSON.parse(payload);
  const parsed = brokerSnapshotSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data as BrokerSnapshot;
  }

  // Fail-open on individual records, fail-closed on the envelope (#1504/#1725
  // class of failure): one request-accepted but store-rejected row used to make
  // the whole load throw, so the broker could not restart at all — and the next
  // save copied the same poison into `.bak`. Quarantine the offending records,
  // keep everything else, and only rethrow if the snapshot is still unusable
  // (a structurally broken envelope, not a bad row).
  const recovery = dropInvalidSnapshotRecords(raw);
  if (recovery.dropped.length > 0) {
    const recovered = brokerSnapshotSchema.safeParse(recovery.value);
    if (recovered.success) {
      snapshotQuarantineStats.recordsDropped += recovery.dropped.length;
      snapshotQuarantineStats.loadsRecovered += 1;
      const quarantinePath = writeQuarantineFile(source, recovery.dropped);
      for (const dropped of recovery.dropped) {
        console.warn(
          JSON.stringify({
            event: "broker.snapshot.record_quarantined",
            source,
            collection: dropped.collection,
            index: dropped.index,
            recordId: dropped.recordId,
            issues: dropped.issues,
            quarantineFile: quarantinePath,
          }),
        );
      }
      console.warn(
        JSON.stringify({
          event: "broker.snapshot.load_recovered",
          source,
          droppedRecords: recovery.dropped.length,
          quarantineFile: quarantinePath,
        }),
      );
      return recovered.data as BrokerSnapshot;
    }
  }

  snapshotQuarantineStats.loadsFailed += 1;
  throw new Error(
    `invalid broker snapshot at ${source}: ${parsed.error.issues[0]?.message ?? "unknown schema error"}`,
  );
}

/** One record dropped by {@link parseSnapshotPayload} during recovery. */
export interface QuarantinedSnapshotRecord {
  collection: string;
  index: number;
  recordId?: string;
  issues: string[];
  record: unknown;
}

interface SnapshotQuarantineStats {
  /** Records skipped across all recovered loads. */
  recordsDropped: number;
  /** Loads that succeeded only after dropping records. */
  loadsRecovered: number;
  /** Loads that still failed after the recovery attempt. */
  loadsFailed: number;
  /** Quarantine files successfully written. */
  quarantineFilesWritten: number;
  /** Quarantine files that could not be written (best-effort persistence). */
  quarantineWriteFailures: number;
}

const snapshotQuarantineStats: SnapshotQuarantineStats = {
  recordsDropped: 0,
  loadsRecovered: 0,
  loadsFailed: 0,
  quarantineFilesWritten: 0,
  quarantineWriteFailures: 0,
};

/** Process-wide counters for snapshot record quarantine (diagnostics/tests). */
export function getSnapshotQuarantineStats(): Readonly<SnapshotQuarantineStats> {
  return { ...snapshotQuarantineStats };
}

/** Reset the quarantine counters. Test-only helper. */
export function resetSnapshotQuarantineStats(): void {
  snapshotQuarantineStats.recordsDropped = 0;
  snapshotQuarantineStats.loadsRecovered = 0;
  snapshotQuarantineStats.loadsFailed = 0;
  snapshotQuarantineStats.quarantineFilesWritten = 0;
  snapshotQuarantineStats.quarantineWriteFailures = 0;
}

/**
 * Validate every known record collection element-by-element and return a copy
 * of the snapshot object with the invalid elements removed.
 */
function dropInvalidSnapshotRecords(raw: unknown): {
  value: unknown;
  dropped: QuarantinedSnapshotRecord[];
} {
  const dropped: QuarantinedSnapshotRecord[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { value: raw, dropped };
  }
  const source = raw as Record<string, unknown>;
  const value: Record<string, unknown> = { ...source };
  for (const [collection, schema] of Object.entries(SNAPSHOT_RECORD_SCHEMAS)) {
    const records = source[collection];
    if (!Array.isArray(records)) continue;
    const kept: unknown[] = [];
    for (const [index, record] of records.entries()) {
      const parsed = schema.safeParse(record);
      if (parsed.success) {
        kept.push(record);
        continue;
      }
      dropped.push({
        collection,
        index,
        recordId: readRecordId(record),
        issues: parsed.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
        record,
      });
    }
    if (kept.length !== records.length) {
      value[collection] = kept;
    }
  }
  return { value, dropped };
}

function readRecordId(record: unknown): string | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  const id = (record as Record<string, unknown>)["id"];
  return typeof id === "string" ? id : undefined;
}

/**
 * Persist the quarantined records next to the snapshot so nothing is silently
 * lost. Best effort: a failure here must never keep the broker from starting.
 */
function writeQuarantineFile(
  source: string,
  dropped: QuarantinedSnapshotRecord[],
): string | undefined {
  // `source` is normally the snapshot file path, but callers (tests, SQLite
  // canonical rows) may pass a non-filesystem label — never materialize a
  // directory for those.
  if (!source.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(source)) return undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `${source}.quarantine-${stamp}.json`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ source, quarantinedAt: new Date().toISOString(), dropped }, null, 2),
      "utf8",
    );
    snapshotQuarantineStats.quarantineFilesWritten += 1;
    return path;
  } catch (error) {
    snapshotQuarantineStats.quarantineWriteFailures += 1;
    console.warn(
      JSON.stringify({
        event: "broker.snapshot.quarantine_write_failed",
        source,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return undefined;
  }
}
