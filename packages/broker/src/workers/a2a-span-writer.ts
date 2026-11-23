/**
 * Worker-side `kind=a2a` spans for the node span ledger (ccc-node#2858 item 3).
 *
 * The worker writes one body-free span per lifecycle step it owns —
 * `a2a.claim`, `a2a.dispatch` (the task handler run) and `a2a.receipt` (the
 * complete/fail report to the broker) — into the node's ccc-node span ledger
 * (`<project>/.telegram_bot/spans/YYYY-MM-DD.jsonl`). The nightly ccc-node
 * rollup (`scripts/spans-rollup.py` `aggregate_a2a`) counts them: `status`
 * decides ok vs failed and the failure class is `error.type`, else
 * `ccc.outcome`, else `status`. Broker-internal spans are out of scope.
 *
 * The line format mirrors ccc-node `bridge/core/span_ledger.py` (the format
 * owner) so `sanitize_span` keeps every key written here:
 *
 * - **Off by default.** Only `A2A_WORKER_SPANS_DIR` turns it on.
 * - **Body-free by construction.** Only the keys in `A2A_SPAN_KEYS` are
 *   written. Task payloads and handler results are reduced to a UTF-8 byte
 *   length and a 16-hex sha256 prefix; error messages are never written, only
 *   a code-shaped `error.type`; the task id becomes a salted hash ref.
 * - **Concurrent-writer safe.** One `O_APPEND` write of one complete line per
 *   span (the bridge writes the same day file).
 * - **Owner-only, no symlinks.** Directory `0700`, file `0600`, the day file
 *   is opened `O_NOFOLLOW` and a symlinked spans directory is refused.
 * - **Never throws.** A span failure must never change task handling. No
 *   prune here: the bridge's ledger owns retention for the directory.
 */
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join as joinPath } from "node:path";

export type A2ASpanOperation = "a2a.claim" | "a2a.dispatch" | "a2a.receipt";
export type A2ASpanStatus = "ok" | "error" | "timeout";

/** Keys this writer may emit; each must also be allow-listed in ccc-node. */
export const A2A_SPAN_KEYS = [
  "kind",
  "status",
  "start_ts",
  "duration_ms",
  "error.type",
  "gen_ai.operation.name",
  "ccc.node",
  "ccc.outcome",
  "ccc.a2a.task_ref",
  "ccc.a2a.payload_bytes",
  "ccc.a2a.payload_sha256",
  "ccc.a2a.result_bytes",
  "ccc.a2a.result_sha256",
] as const;

/** Same bound as ccc-node MAX_LINE_BYTES. */
const MAX_LINE_BYTES = 4096;
const MAX_DURATION_MS = 10 ** 10;
/** ccc-node `_IDENTIFIER_RE`, capped at MAX_STRING_CHARS (128). */
const IDENTIFIER_RE = /^[A-Za-z0-9._:/@+\-[\]]{1,128}$/;
/**
 * `error.type` is stricter than the ledger's identifier rule: handler and
 * broker codes are lower-case snake/kebab words, so anything else (a token,
 * a path, a mixed-case blob from a broken handler) collapses to one class.
 */
const ERROR_CODE_RE = /^[a-z][a-z0-9_.:-]{0,63}$/;
export const UNCLASSIFIED_ERROR = "unclassified";

export interface A2ASpanInput {
  operation: A2ASpanOperation;
  status: A2ASpanStatus;
  /** Epoch milliseconds when the step started. */
  startedAtMs: number;
  /** Epoch milliseconds when the step ended. */
  endedAtMs: number;
  taskId?: string;
  errorType?: string;
  outcome?: string;
  payload?: unknown;
  result?: unknown;
}

/** Opaque task ref: salted sha256 prefix, never the raw id. */
export function a2aTaskRef(taskId: string): string {
  return createHash("sha256").update(`ccc-span:a2a-task:${taskId}`, "utf8").digest("hex").slice(0, 16);
}

/** UTF-8 length + 16-hex sha256 prefix of a JSON body; the body itself is dropped. */
export function bodyDigest(value: unknown): { bytes: number; sha256: string } | undefined {
  if (value === undefined) return undefined;
  let text: string | undefined;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (text === undefined) return undefined;
  const buffer = Buffer.from(text, "utf8");
  return { bytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex").slice(0, 16) };
}

export function a2aErrorType(code: unknown): string {
  return typeof code === "string" && ERROR_CODE_RE.test(code) ? code : UNCLASSIFIED_ERROR;
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && IDENTIFIER_RE.test(value) ? value : undefined;
}

/** Build the allow-listed span object (exported for tests). Never throws. */
export function buildA2ASpan(input: A2ASpanInput, node?: string): Record<string, string | number> | undefined {
  try {
    const span: Record<string, string | number> = {
      kind: "a2a",
      status: input.status,
      "gen_ai.operation.name": input.operation,
      start_ts: Math.round(input.startedAtMs) / 1000,
      duration_ms: Math.min(MAX_DURATION_MS, Math.max(0, Math.round(input.endedAtMs - input.startedAtMs))),
    };
    const nodeId = identifier(node);
    if (nodeId) span["ccc.node"] = nodeId;
    if (input.status !== "ok") span["error.type"] = a2aErrorType(input.errorType);
    const outcome = identifier(input.outcome);
    if (outcome) span["ccc.outcome"] = outcome;
    if (typeof input.taskId === "string" && input.taskId) span["ccc.a2a.task_ref"] = a2aTaskRef(input.taskId);
    const payload = bodyDigest(input.payload);
    if (payload) {
      span["ccc.a2a.payload_bytes"] = payload.bytes;
      span["ccc.a2a.payload_sha256"] = payload.sha256;
    }
    const result = bodyDigest(input.result);
    if (result) {
      span["ccc.a2a.result_bytes"] = result.bytes;
      span["ccc.a2a.result_sha256"] = result.sha256;
    }
    if (!Number.isFinite(span.start_ts as number) || (span.start_ts as number) < 0) return undefined;
    return span;
  } catch {
    return undefined;
  }
}

function utcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export interface A2ASpanWriterOptions {
  dir: string;
  node?: string;
  now?: () => number;
}

export class A2ASpanWriter {
  private readonly dir: string;
  private readonly node?: string;
  private readonly now: () => number;

  constructor(options: A2ASpanWriterOptions) {
    this.dir = options.dir;
    this.node = options.node;
    this.now = options.now ?? Date.now;
  }

  /** Append one span; `true` when a line was written. Never throws. */
  record(input: A2ASpanInput): boolean {
    try {
      const span = buildA2ASpan(input, this.node);
      if (!span) return false;
      const line = Buffer.from(`${JSON.stringify(span)}\n`, "utf8");
      if (line.length > MAX_LINE_BYTES) return false;
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const dirStat = lstatSync(this.dir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return false;
      const flags =
        fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0);
      const fd = openSync(joinPath(this.dir, `${utcDay(this.now())}.jsonl`), flags, 0o600);
      try {
        // One write of one complete line on O_APPEND (see module doc).
        return writeSync(fd, line) === line.length;
      } finally {
        closeSync(fd);
      }
    } catch {
      return false;
    }
  }
}

/** `A2A_WORKER_SPANS_DIR` set (non-blank) → a writer; otherwise spans stay off. */
export function createA2ASpanWriterFromEnv(
  env: NodeJS.ProcessEnv,
  node?: string,
): A2ASpanWriter | undefined {
  const dir = env.A2A_WORKER_SPANS_DIR?.trim();
  return dir ? new A2ASpanWriter({ dir, node }) : undefined;
}
