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
import { brokerSnapshotSchema } from "./store-schemas.js";

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
  const payload = JSON.stringify(
    {
      ...snapshot,
      version: CURRENT_BROKER_STATE_VERSION,
    },
    null,
    2,
  );
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
  const parsed = brokerSnapshotSchema.safeParse(JSON.parse(payload));
  if (!parsed.success) {
    throw new Error(
      `invalid broker snapshot at ${source}: ${parsed.error.issues[0]?.message ?? "unknown schema error"}`,
    );
  }
  return parsed.data as BrokerSnapshot;
}
