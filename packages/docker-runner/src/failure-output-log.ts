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

import { readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { redactSecrets } from "./redaction.js";

export const FAILURE_OUTPUT_LOG_FILENAME = "failure-output.log";
export const DEFAULT_FAILURE_LOG_MAX_BYTES = 256 * 1024;
export const DEFAULT_FAILURE_LOG_KEEP = 20;

function boundUtf8Tail(value: string, maxBytes: number): string {
  const limit = Math.max(0, Math.floor(maxBytes));
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  const marker = `<truncated to last ${limit} bytes>\n`;
  const budget = Math.max(0, limit - Buffer.byteLength(marker, "utf8"));
  let output = "";
  let used = 0;
  const codePoints = [...value];
  for (let index = codePoints.length - 1; index >= 0; index -= 1) {
    const bytes = Buffer.byteLength(codePoints[index], "utf8");
    if (used + bytes > budget) break;
    output = codePoints[index] + output;
    used += bytes;
  }
  return `${marker}${output}`;
}

export async function writeFailureOutputLog(
  workDir: string,
  options: { stdout: string; stderr: string; maxBytes?: number },
): Promise<string | undefined> {
  const maxBytes = options.maxBytes ?? DEFAULT_FAILURE_LOG_MAX_BYTES;
  const combined = redactSecrets([options.stderr, options.stdout].filter(Boolean).join("\n")).trim();
  if (!combined) return undefined;
  const bounded = boundUtf8Tail(combined, maxBytes);
  const path = join(workDir, FAILURE_OUTPUT_LOG_FILENAME);
  await writeFile(path, `${bounded}\n`, { mode: 0o600 });
  return path;
}

export async function pruneFailureOutputLogs(rootDir: string, keep = DEFAULT_FAILURE_LOG_KEEP): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(rootDir);
  } catch {
    return 0;
  }
  const logs: { path: string; mtimeMs: number }[] = [];
  for (const taskEntry of entries) {
    const taskDir = join(rootDir, taskEntry);
    let runEntries: string[];
    try {
      runEntries = await readdir(taskDir);
    } catch {
      continue;
    }
    for (const runEntry of runEntries) {
      const candidate = join(taskDir, runEntry, FAILURE_OUTPUT_LOG_FILENAME);
      try {
        const info = await stat(candidate);
        if (info.isFile()) logs.push({ path: candidate, mtimeMs: info.mtimeMs });
      } catch {
        // not present — most runs succeed and have no failure log
      }
    }
  }
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
