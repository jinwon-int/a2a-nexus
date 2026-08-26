/**
 * Bounded failed-run output logs (#1610 item 2).
 *
 * Runner containers are created with --rm and vanish on exit, so a failed
 * run used to leave no operator-inspectable output on the worker host. On
 * failure (and only on failure) the runner now writes the captured
 * stdout/stderr into the run's workDir as `failure-output.log`, redacted and
 * tail-bounded, and prunes old failure logs across the task root to keep the
 * volume bounded.
 */

import type { Dirent } from "node:fs";
import { readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { redactSecrets } from "./redaction.js";

export const FAILURE_OUTPUT_LOG_FILENAME = "failure-output.log";
export const DEFAULT_FAILURE_LOG_MAX_BYTES = 256 * 1024;
export const DEFAULT_FAILURE_LOG_KEEP = 20;

function boundUtf8Tail(value: string, maxBytes: number): string {
  const limit = Math.max(0, Math.floor(maxBytes));
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= limit) return value;
  const marker = `<truncated to last ${limit} bytes>\n`;
  const budget = Math.max(0, limit - Buffer.byteLength(marker, "utf8"));
  let start = bytes.length - budget;
  // Never split a code point: skip UTF-8 continuation bytes at the cut.
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return `${marker}${bytes.subarray(start).toString("utf8")}`;
}

export async function writeFailureOutputLog(
  workDir: string,
  options: { stdout: string; stderr: string; maxBytes?: number } | { redactedCombined: string; maxBytes?: number },
): Promise<string | undefined> {
  const maxBytes = options.maxBytes ?? DEFAULT_FAILURE_LOG_MAX_BYTES;
  // redactedCombined callers (runTask) pass streams that redactSecrets already
  // covered at capture time in container-retry, so the full-stream redaction
  // pass is not repeated here.
  const combined = "redactedCombined" in options
    ? options.redactedCombined.trim()
    : redactSecrets([options.stderr, options.stdout].filter(Boolean).join("\n")).trim();
  if (!combined) return undefined;
  const bounded = boundUtf8Tail(combined, maxBytes);
  const path = join(workDir, FAILURE_OUTPUT_LOG_FILENAME);
  await writeFile(path, `${bounded}\n`, { mode: 0o600 });
  return path;
}

export async function pruneFailureOutputLogs(rootDir: string, keep = DEFAULT_FAILURE_LOG_KEEP): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const taskDirs = entries
    .filter((taskEntry) => taskEntry.isDirectory() || taskEntry.isSymbolicLink())
    .map((taskEntry) => join(rootDir, taskEntry.name));
  const runLists = await Promise.all(taskDirs.map(async (taskDir) => {
    try {
      return await readdir(taskDir, { withFileTypes: true });
    } catch {
      return [];
    }
  }));
  const candidates: string[] = [];
  taskDirs.forEach((taskDir, index) => {
    for (const runEntry of runLists[index]) {
      if (!runEntry.isDirectory() && !runEntry.isSymbolicLink()) continue;
      candidates.push(join(taskDir, runEntry.name, FAILURE_OUTPUT_LOG_FILENAME));
    }
  });
  const logs = (await Promise.all(candidates.map(async (candidate) => {
    try {
      const info = await stat(candidate);
      return info.isFile() ? { path: candidate, mtimeMs: info.mtimeMs } : undefined;
    } catch {
      // not present — most runs succeed and have no failure log
      return undefined;
    }
  }))).filter((log): log is { path: string; mtimeMs: number } => log !== undefined);
  logs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let pruned = 0;
  for (const log of logs.slice(Math.max(0, keep))) {
    try {
      await unlink(log.path);
      pruned += 1;
    } catch {
      // already gone
    }
  }
  return pruned;
}
