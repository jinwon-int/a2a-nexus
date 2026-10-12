import { spawn } from "node:child_process";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  claudeHostRefreshStatePath,
  evaluateClaudeCredentialWindow,
  readClaudeHostRefreshState,
  resolveClaudeCredentialLocation,
  type ClaudeHostRefreshState,
} from "./ops.js";
import type { RunnerConfig } from "./types.js";

/**
 * #2373 option 1: opt-in HOST-side Claude credential refresh trigger.
 *
 * The container can never refresh the Claude OAuth credential (#2234 strips the
 * refresh token), and the host Claude Code CLI only rewrites its
 * `.credentials.json` lazily when a host session runs. When the
 * claude_credential_window gate would defer a task, this spawns the operator's
 * configured argv ON THE HOST (no shell, never inside the container) so the
 * host CLI gets a chance to refresh, then re-evaluates the window.
 *
 * The child's stdout/stderr are discarded — never logged or stored — because
 * they can carry model text or credential error bodies. Only
 * `claudeAiOauth.expiresAt` is compared; token values are never read.
 */

export type ClaudeHostRefreshSkippedReason = "not_configured" | "not_file_mount" | "rate_limited" | "not_blocked";

export interface ClaudeHostRefreshResult {
  attempted: boolean;
  skippedReason?: ClaudeHostRefreshSkippedReason;
  /** Child exit code; absent when the child was killed by a signal or could not be spawned. */
  exitCode?: number;
  timedOut?: boolean;
  /** Spawn failure code only (e.g. ENOENT); never the error message. */
  spawnError?: string;
  /** True only when expiresAt changed AND the re-evaluated window is no longer blocked. */
  refreshed: boolean;
  expiresAtBefore?: string;
  expiresAtAfter?: string;
}

export interface ClaudeHostRefreshWindow {
  blocked: boolean;
  expiresAt?: string;
  requiredUntil: string;
  /** Task timeout the window was evaluated with; reused for the re-evaluation. */
  taskTimeoutMs: number;
}

export async function maybeRefreshClaudeCredentialOnHost(
  config: RunnerConfig,
  window: ClaudeHostRefreshWindow,
  nowMs?: number,
): Promise<ClaudeHostRefreshResult> {
  const expiresAtBefore = window.expiresAt;
  const skipped = (skippedReason: ClaudeHostRefreshSkippedReason): ClaudeHostRefreshResult => ({
    attempted: false,
    skippedReason,
    refreshed: false,
    ...(expiresAtBefore !== undefined ? { expiresAtBefore } : {}),
  });
  if (!window.blocked) return skipped("not_blocked");
  const hostRefresh = config.claudeHostRefresh;
  if (!hostRefresh) return skipped("not_configured");
  if (resolveClaudeCredentialLocation(config).source !== "credentials_file_mount") return skipped("not_file_mount");

  const attemptMs = nowMs ?? Date.now();
  const previous = await readClaudeHostRefreshState(config);
  if (previous?.lastAttemptAt !== undefined) {
    const elapsedMs = attemptMs - Date.parse(previous.lastAttemptAt);
    if (elapsedMs >= 0 && elapsedMs < hostRefresh.minIntervalMs) return skipped("rate_limited");
  }
  // Record the attempt before spawning so concurrent task starts are rate-limited too.
  const lastAttemptAt = new Date(attemptMs).toISOString();
  await writeClaudeHostRefreshState(config, { lastAttemptAt });

  const outcome = await runHostRefreshCommand(hostRefresh.argv, hostRefresh.timeoutMs);
  const after = await evaluateClaudeCredentialWindow(config, window.taskTimeoutMs, nowMs ?? Date.now());
  const expiresAtAfter = after.expiresAt;
  const refreshed = expiresAtAfter !== undefined && expiresAtAfter !== expiresAtBefore && !after.blocked;
  await writeClaudeHostRefreshState(config, {
    lastAttemptAt,
    lastExitCode: outcome.exitCode ?? null,
    lastRefreshed: refreshed,
  });
  return {
    attempted: true,
    ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
    timedOut: outcome.timedOut,
    ...(outcome.spawnError !== undefined ? { spawnError: outcome.spawnError } : {}),
    refreshed,
    ...(expiresAtBefore !== undefined ? { expiresAtBefore } : {}),
    ...(expiresAtAfter !== undefined ? { expiresAtAfter } : {}),
  };
}

/** One-line summary for the block result: `host_refresh=<skipped:<reason>|attempted exit=<code> timed_out=<bool> refreshed=<bool>>`. */
export function formatClaudeHostRefreshSummary(result: ClaudeHostRefreshResult): string {
  if (!result.attempted) return `host_refresh=skipped:${result.skippedReason ?? "not_configured"}`;
  const exit = result.exitCode !== undefined ? String(result.exitCode) : result.spawnError ? `spawn_error:${result.spawnError}` : "none";
  return `host_refresh=attempted exit=${exit} timed_out=${result.timedOut === true} refreshed=${result.refreshed}`;
}

async function runHostRefreshCommand(
  argv: string[],
  timeoutMs: number,
): Promise<{ exitCode?: number; timedOut: boolean; spawnError?: string }> {
  const [command, ...args] = argv;
  // Only HOME and PATH are inherited: the runner's other env (GitHub token
  // file paths, proof keys, …) has no business in the host CLI invocation.
  const env: NodeJS.ProcessEnv = {};
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  return await new Promise((resolvePromise) => {
    let timedOut = false;
    let settled = false;
    const settle = (value: { exitCode?: number; timedOut: boolean; spawnError?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command!, args, { env, shell: false, stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
    } catch (error) {
      resolvePromise({ timedOut: false, spawnError: errorCode(error) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (error) => settle({ timedOut, spawnError: errorCode(error) }));
    child.once("close", (code) => settle({ ...(code !== null ? { exitCode: code } : {}), timedOut }));
  });
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "spawn_failed";
}

async function writeClaudeHostRefreshState(config: RunnerConfig, state: ClaudeHostRefreshState): Promise<void> {
  const path = claudeHostRefreshStatePath(config);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}
