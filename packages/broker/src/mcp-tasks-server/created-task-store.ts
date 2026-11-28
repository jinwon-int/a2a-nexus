/**
 * The set of task ids this server created (a2a-nexus #2591 design §4.3 item 2,
 * open question Q4).
 *
 * The server rejects any `taskId` outside this set with `-32602` before it
 * calls the broker. Q4 (owner decision 2026-11-28): the set is persisted per
 * client session in a mode-0600 file under a mode-0700 directory, so that
 * `claude --resume` can keep polling after a server restart. The file holds
 * task ids only — no task text, no identity, no credential.
 */
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

import { isValidMcpTaskId } from "../a2a/mcp-tasks-facade.js";

export const CREATED_TASK_STORE_SCHEMA = "a2a.mcp-tasks.created-tasks.v1";
export const CREATED_TASK_STORE_MAX_IDS = 1_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export interface CreatedTaskStore {
  has(taskId: string): boolean;
  add(taskId: string): void;
}

export class CreatedTaskStoreError extends Error {
  constructor(reason: string) {
    super(`created-task store refused: ${reason}`);
    this.name = "CreatedTaskStoreError";
  }
}

/** Process-local set. Used by tests and by a caller that opts out of persistence. */
export class InMemoryCreatedTaskStore implements CreatedTaskStore {
  private readonly ids = new Set<string>();
  has(taskId: string): boolean {
    return this.ids.has(taskId);
  }
  add(taskId: string): void {
    if (!isValidMcpTaskId(taskId)) throw new CreatedTaskStoreError("not a broker-assigned task id");
    this.ids.add(taskId);
  }
}

function euid(): number | undefined {
  return typeof process.geteuid === "function" ? process.geteuid() : undefined;
}

/** Refuses a path that is a symlink, not owned by this user, or reachable by group/other. */
function assertPrivate(path: string, kind: "dir" | "file", allowedBits: number): void {
  const meta = lstatSync(path);
  if (meta.isSymbolicLink()) throw new CreatedTaskStoreError(`${kind} is a symlink`);
  if (kind === "dir" ? !meta.isDirectory() : !meta.isFile()) throw new CreatedTaskStoreError(`${kind} has the wrong type`);
  const uid = euid();
  if (uid !== undefined && meta.uid !== uid) throw new CreatedTaskStoreError(`${kind} is not owned by this user`);
  if ((meta.mode & 0o777 & ~allowedBits) !== 0) throw new CreatedTaskStoreError(`${kind} is accessible by group or other`);
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Q4: one file per client session, `<stateDir>/mcp-tasks/<sessionId>.json`.
 * Fails closed on an insecure directory or file instead of trusting it, and
 * on a malformed file instead of starting empty (which would silently drop
 * the tasks a resumed client still polls).
 */
export class FileCreatedTaskStore implements CreatedTaskStore {
  readonly path: string;
  private readonly sessionId: string;
  private readonly ids: string[];

  constructor(stateDir: string, sessionId: string) {
    if (!SESSION_ID_PATTERN.test(sessionId)) throw new CreatedTaskStoreError("session id must be 1..128 of [A-Za-z0-9._-]");
    const dir = join(stateDir, "mcp-tasks");
    if (!exists(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    assertPrivate(dir, "dir", 0o700);
    this.sessionId = sessionId;
    this.path = join(dir, `${sessionId}.json`);
    this.ids = exists(this.path) ? FileCreatedTaskStore.read(this.path, sessionId) : [];
  }

  private static read(path: string, sessionId: string): string[] {
    assertPrivate(path, "file", 0o600);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new CreatedTaskStoreError("file is not valid JSON");
    }
    const record = parsed as { schema?: unknown; sessionId?: unknown; taskIds?: unknown };
    if (record?.schema !== CREATED_TASK_STORE_SCHEMA || record.sessionId !== sessionId || !Array.isArray(record.taskIds)) {
      throw new CreatedTaskStoreError("file has the wrong schema or session");
    }
    if (!record.taskIds.every(isValidMcpTaskId)) throw new CreatedTaskStoreError("file holds an invalid task id");
    return [...new Set(record.taskIds as string[])].slice(-CREATED_TASK_STORE_MAX_IDS);
  }

  has(taskId: string): boolean {
    return this.ids.includes(taskId);
  }

  add(taskId: string): void {
    if (!isValidMcpTaskId(taskId)) throw new CreatedTaskStoreError("not a broker-assigned task id");
    if (this.ids.includes(taskId)) return;
    this.ids.push(taskId);
    if (this.ids.length > CREATED_TASK_STORE_MAX_IDS) this.ids.splice(0, this.ids.length - CREATED_TASK_STORE_MAX_IDS);
    this.write();
  }

  /** Atomic replace: exclusive 0600 temp file, fsync, rename. */
  private write(): void {
    const body = `${JSON.stringify({ schema: CREATED_TASK_STORE_SCHEMA, sessionId: this.sessionId, taskIds: this.ids })}\n`;
    const tmp = `${this.path}.${process.pid}.tmp`;
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, this.path);
    } catch (error) {
      unlinkSync(tmp);
      throw error;
    }
  }
}
