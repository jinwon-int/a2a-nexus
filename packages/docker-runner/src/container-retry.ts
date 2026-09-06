/**
 * Container Retry Harness
 *
 * Transient-failure retry with exponential backoff and jitter for embedded
 * container execution.  Distinguishes transient errors (name conflicts,
 * network glitches, engine restarts) from permanent errors (missing engine,
 * invalid image, auth failures) and retries only the former.
 *
 * Parent: a2a-broker#838
 */

import { spawn } from "node:child_process";
import { redactSecrets } from "./redaction.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RetryConfig {
  /** Maximum number of spawn attempts (including the first). */
  maxAttempts: number;
  /** Base delay in ms before the first retry. */
  baseDelayMs: number;
  /** Maximum delay cap in ms. */
  maxDelayMs: number;
  /** Exponential backoff multiplier (e.g. 2 = doubles each attempt). */
  backoffFactor: number;
  /** Jitter fraction; actual delay = computed_delay * (1 ± jitterFactor). */
  jitterFactor: number;
  /**
   * Absolute wall-clock budget in ms for the whole retry sequence (BUG-B3).
   *
   * Without it, `maxAttempts` retries each get a fresh `timeoutMs`, so the
   * worst-case wall clock is `maxAttempts × timeoutMs` (3× the declared task
   * timeout with the defaults) — the broker/operator budget is silently
   * multiplied. When omitted, `runContainerWithRetry` defaults the budget to
   * the per-attempt `timeoutMs`, i.e. the declared timeout is the *total*
   * budget: each attempt's timeout is clamped to the remaining budget and
   * retries stop once the budget is spent.
   */
  totalBudgetMs?: number;
}

export interface RetryAttemptRecord {
  attempt: number;                // 1-based
  startedAt: number;              // Unix ms
  elapsedMs: number;
  outcome: "spawn_error" | "container_exit" | "timeout";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  errorCode?: string;
  errorMessage?: string;
}

export interface ContainerRetryEvidence {
  schemaVersion: "a2a.runner.container-retry-evidence.v1";
  config: RetryConfig;
  attempts: RetryAttemptRecord[];
  totalAttempts: number;
  succeededOnAttempt: number;
  /** Absolute wall-clock budget applied to the whole retry sequence (ms). */
  totalBudgetMs?: number;
  /** True when retries stopped because the absolute budget was exhausted. */
  budgetExhausted?: boolean;
}

// ─── Internal SpawnResult (mirrors runner.ts interface) ─────────────────────

interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  errorCode?: string;
  elapsedMs?: number;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

export function defaultRetryConfig(): RetryConfig {
  return {
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 8000,
    backoffFactor: 2,
    jitterFactor: 0.2,
  };
}

// ─── Transient Error Classification ─────────────────────────────────────────

/**
 * Classify a container spawn/execution result as transient (retryable).
 *
 * Transient failures are those likely to resolve without human intervention:
 * name collisions, engine restart races, transient network failures.
 * Permanent failures (ENOENT, auth, invalid image) are not retryable.
 */
export function isTransientContainerError(completed: SpawnResult): boolean {
  const stderr = completed.stderr ?? "";
  const stdout = completed.stdout ?? "";
  const combined = `${stderr}\n${stdout}`;

  // Terminal: a timeout consumed the full per-attempt budget. Retrying only
  // multiplies wall-clock (3× with the default 1h timeout) with no reason to
  // expect a faster run. Checked first so a timed-out container is never
  // retried regardless of any incidental stderr noise.
  if (completed.timedOut) return false;

  // Permanent: engine not installed or not executable.
  if (completed.errorCode === "ENOENT") return false;

  // Permanent: known auth / image-not-found patterns.
  if (
    /Error response from daemon:.*pull access denied/.test(stderr) ||
    /manifest for.*not found/.test(stderr) ||
    /no such image: /.test(stderr) ||
    /repository does not exist/.test(stderr) ||
    /unauthorized: /.test(stderr)
  ) return false;

  // Permanent: permission errors on daemon socket (config, not transient).
  if (
    /permission denied.*docker.*socket/.test(combined) ||
    /cannot connect to the docker daemon.*permission denied/.test(combined)
  ) return false;

  // Permanent: known OS-level resource exhaustion that won't resolve on retry
  // without config change (e.g. disk full, read-only FS).
  if (
    /read-only file system|no space left on device/i.test(combined)
  ) return false;

  // All other engine spawn errors are transient (e.g. daemon restarting,
  // socket timeout, temporary resource contention).
  if (completed.errorCode) return true;

  // Container name conflicts are transient (zombie container being cleaned up).
  if (
    /Conflict\.? The container name/.test(stderr) ||
    /container name .* is already in use/.test(stderr) ||
    /name is already in use/.test(stderr)
  ) return true;

  // OOM (exit 137) is treated as transient — the same container may succeed
  // on retry if competing workloads have freed memory.  The operator should
  // also consider raising --memory, but a single retry is harmless.
  if (completed.code === 137 || /out of memory|OOMKill|oom-kill/i.test(stderr)) {
    return true;
  }

  // Engine connection / timeout errors are transient.
  if (
    /Error response from daemon:.*connection/i.test(stderr) ||
    /Error response from daemon:.*timeout/i.test(stderr) ||
    /Cannot connect to the Docker daemon/i.test(stderr) ||
    /error during connect/i.test(stderr)
  ) return true;

  // Generic engine errors not matched above — conservative: treat as transient
  // so the retry harness handles unexpected engine-side flakes.
  if (stderr.toLowerCase().includes("error response from daemon")) return true;

  // Unknown spawn/process error with no stderr match — do NOT retry.
  return false;
}

// ─── Backoff with Jitter ────────────────────────────────────────────────────

/**
 * Compute the delay in ms before the n-th retry attempt (1-based).
 *
 * delay = min(baseDelay × backoffFactor^(attempt-1), maxDelay)
 * final = delay × (1 + jitterFactor × (random - 0.5) × 2)
 */
export function computeRetryDelay(attempt: number, config: RetryConfig): number {
  if (attempt < 1 || config.maxAttempts < 1) return 0;
  if (attempt >= config.maxAttempts) return 0; // no delay for the final attempt
  // exponent = attempt-1 => base*2^0=base for first retry, base*2^1=2*base for second, etc.
  const exponent = Math.max(0, attempt - 1);
  const delay = Math.min(config.baseDelayMs * Math.pow(config.backoffFactor, exponent), config.maxDelayMs);
  const jitter = 1 + config.jitterFactor * (Math.random() - 0.5) * 2;
  return Math.round(delay * jitter);
}

// ─── Retry Harness ──────────────────────────────────────────────────────────

/**
 * Floor for a budget-clamped attempt timeout.
 *
 * A retry funded with a few hundred ms is worthless (it cannot even pull the
 * engine socket), and a 0 ms timeout would make the attempt "time out"
 * instantly, so the harness stops retrying instead of burning an attempt.
 */
export const MIN_ATTEMPT_TIMEOUT_MS = 1000;

/**
 * Run a container command with transient-failure retry and backoff.
 *
 * Returns the final spawn result and a structured retry evidence record.
 * Only the *last* attempt result is returned; all attempt records are
 * preserved in the evidence.  The stdout/stderr of failed attempts are
 * concatenated into the final output so no diagnostic data is lost.
 */
export async function runContainerWithRetry(
  command: string,
  args: string[],
  timeoutMs: number,
  config: RetryConfig = defaultRetryConfig(),
): Promise<{ result: SpawnResult; retryEvidence: ContainerRetryEvidence }> {
  const attempts: RetryAttemptRecord[] = [];
  let succeededOnAttempt = 0;

  // Absolute wall-clock budget for the whole sequence (BUG-B3). Retries reuse
  // the per-attempt timeout, so without a deadline `maxAttempts` failures cost
  // up to `maxAttempts × timeoutMs`. The declared timeout is the total budget
  // unless the caller opts into a wider one.
  const totalBudgetMs = config.totalBudgetMs !== undefined && config.totalBudgetMs > 0
    ? config.totalBudgetMs
    : timeoutMs;
  const deadline = Date.now() + totalBudgetMs;
  const remainingBudgetMs = (): number => deadline - Date.now();
  let budgetExhausted = false;
  const budgetEvidence = (): { totalBudgetMs: number; budgetExhausted: boolean } =>
    ({ totalBudgetMs, budgetExhausted });

  // We accumulate output from all attempts so no evidence is lost.
  let accumulatedStdout = "";
  let accumulatedStderr = "";
  const sep = "\n--- retry boundary ---\n";

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    const startedAt = Date.now();
    // Clamp each attempt to what is left of the absolute budget. The first
    // attempt always gets at least MIN_ATTEMPT_TIMEOUT_MS so a degenerate
    // budget can never produce a 0 ms (instantly timing out) run.
    const attemptTimeoutMs = attempt === 1
      ? Math.min(timeoutMs, Math.max(remainingBudgetMs(), MIN_ATTEMPT_TIMEOUT_MS))
      : Math.min(timeoutMs, remainingBudgetMs());
    const attemptResult = await spawnWithTimeout(command, argsForAttempt(args, attempt), attemptTimeoutMs, attempt, config.maxAttempts);

    const elapsedMs = Date.now() - startedAt;

    attempts.push({
      attempt,
      startedAt,
      elapsedMs,
      outcome: attemptResult.errorCode
        ? "spawn_error"
        : attemptResult.timedOut
          ? "timeout"
          : "container_exit",
      exitCode: attemptResult.code,
      signal: attemptResult.signal,
      errorCode: attemptResult.errorCode,
      errorMessage: attemptResult.stderr.slice(0, 300),
    });

    accumulatedStdout += (accumulatedStdout ? sep : "") + (attemptResult.stdout ?? "");
    accumulatedStderr += (accumulatedStderr ? sep : "") + (attemptResult.stderr ?? "");

    // Success: clean exit, not timed out.
    if (attemptResult.code === 0 && !attemptResult.timedOut) {
      succeededOnAttempt = attempt;
      return {
        result: {
          code: attemptResult.code,
          signal: attemptResult.signal,
          stdout: accumulatedStdout,
          stderr: accumulatedStderr,
          timedOut: false,
          elapsedMs: Date.now() - startedAt,
        },
        retryEvidence: buildRetryEvidence(config, attempts, succeededOnAttempt, budgetEvidence()),
      };
    }

    // PR URL recovery: non-zero exit but PR URL in stdout — treat as success.
    if (attemptResult.code !== 0 && !attemptResult.timedOut && extractPrUrl(attemptResult.stdout)) {
      succeededOnAttempt = attempt;
      return {
        result: {
          code: attemptResult.code,
          signal: attemptResult.signal,
          stdout: accumulatedStdout,
          stderr: accumulatedStderr,
          timedOut: false,
          elapsedMs: Date.now() - startedAt,
        },
        retryEvidence: buildRetryEvidence(config, attempts, succeededOnAttempt, budgetEvidence()),
      };
    }

    // Permanent failure: do not retry.
    if (isTransientContainerError(attemptResult) === false) {
      return {
        result: {
          code: attemptResult.code,
          signal: attemptResult.signal,
          stdout: accumulatedStdout,
          stderr: accumulatedStderr,
          timedOut: attemptResult.timedOut,
          errorCode: attemptResult.errorCode,
          elapsedMs: Date.now() - startedAt,
        },
        retryEvidence: buildRetryEvidence(config, attempts, 0, budgetEvidence()),
      };
    }

    // Transient failure: compute backoff delay and wait — unless the absolute
    // budget cannot fund the backoff plus a meaningful next attempt (BUG-B3).
    if (attempt < config.maxAttempts) {
      const delayMs = computeRetryDelay(attempt, config);
      if (remainingBudgetMs() - delayMs < MIN_ATTEMPT_TIMEOUT_MS) {
        budgetExhausted = true;
        break;
      }
      await sleep(delayMs);
    }
  }

  // All attempts exhausted.
  return {
    result: {
      code: attempts[attempts.length - 1]?.exitCode ?? null,
      signal: attempts[attempts.length - 1]?.signal ?? null,
      stdout: accumulatedStdout,
      stderr: accumulatedStderr,
      timedOut: attempts.some((a) => a.outcome === "timeout"),
      elapsedMs: Date.now() - (attempts[0]?.startedAt ?? Date.now()),
    },
    retryEvidence: buildRetryEvidence(config, attempts, 0, budgetEvidence()),
  };
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function buildRetryEvidence(
  config: RetryConfig,
  attempts: RetryAttemptRecord[],
  succeededOnAttempt: number,
  budget?: { totalBudgetMs: number; budgetExhausted: boolean },
): ContainerRetryEvidence {
  return {
    schemaVersion: "a2a.runner.container-retry-evidence.v1",
    config: { ...config },
    attempts,
    totalAttempts: attempts.length,
    succeededOnAttempt,
    ...(budget
      ? { totalBudgetMs: budget.totalBudgetMs, budgetExhausted: budget.budgetExhausted }
      : {}),
  };
}

// Hard cap on captured output per stream. A task that floods stdout/stderr
// (`yes`, a chatty agent, an accidental binary dump) would otherwise grow these
// strings until the runner host process OOMs, since redaction/bounding only run
// after full accumulation. We keep draining the pipe (so the child never blocks
// on a full OS buffer) but discard bytes past the cap (BUG-05).
const MAX_CAPTURED_OUTPUT_CHARS = 16 * 1024 * 1024;
const OUTPUT_TRUNCATION_MARKER = "\n<output truncated: exceeded capture limit>\n";

export function appendBoundedOutput(
  buffer: string,
  chunk: string,
  maxChars = MAX_CAPTURED_OUTPUT_CHARS,
): string {
  if (buffer.length >= maxChars) return buffer;
  const next = buffer + chunk;
  if (next.length <= maxChars) return next;
  return next.slice(0, maxChars) + OUTPUT_TRUNCATION_MARKER;
}

/**
 * Extract the `--name` value baked into the `docker run` argv.
 *
 * `buildRunArgs` always assigns a deterministic `a2a-<taskId>-<runToken>`
 * container name (and `argsForAttempt` suffixes it per retry), so the exact
 * container a timed-out attempt left behind is always addressable.
 */
export function containerNameFromArgs(args: string[]): string | undefined {
  const idx = args.indexOf("--name");
  if (idx < 0 || idx + 1 >= args.length) return undefined;
  const name = args[idx + 1];
  return name && !name.startsWith("-") ? name : undefined;
}

/** Wall-clock cap for the best-effort `docker rm -f` reap of a timed-out run. */
const REAP_TIMEOUT_MS = 15_000;

/**
 * Force-remove a container left behind by a timed-out attempt (BUG-B2).
 *
 * Killing the `docker run` CLI does NOT stop the container: the engine keeps
 * the workload running detached, so without this reap a timed-out task leaks a
 * container (holding its memory/CPU/pids reservation and the mounted work dir)
 * until an operator notices. Failures are swallowed — the container may already
 * be gone via `--rm`, and reaping must never mask the real timeout result.
 */
export function reapContainer(command: string, containerName: string): Promise<void> {
  return new Promise((resolveReap) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolveReap();
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, ["rm", "-f", containerName], { stdio: ["ignore", "ignore", "ignore"] });
    } catch {
      resolveReap();
      return;
    }
    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
      done();
    }, REAP_TIMEOUT_MS);
    killTimer.unref();
    child.on("error", done);
    child.on("close", done);
  });
}

/**
 * Bounded best-effort wait for the child's stdio pipes to close after it has
 * already exited (#2052).
 *
 * `close` only fires once every writer of the pipes is gone. A grandchild that
 * inherited them keeps them open long after the direct child is dead, so making
 * the attempt result contingent on `close` lets the promise outlive its own
 * timeout by an unbounded amount. We therefore settle on `exit` and give the
 * pipes only this grace window to deliver whatever is still buffered — long
 * enough that a normally-terminating child never loses output (its `close`
 * follows `exit` within a tick), short enough that a leaked pipe cannot extend
 * the attempt materially.
 */
export const STDIO_DRAIN_GRACE_MS = 500;

function spawnWithTimeout(
  command: string,
  args: string[],
  timeoutMs: number,
  _attempt: number,
  _maxAttempts: number,
): Promise<SpawnResult> {
  const startMs = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
    timer.unref();
    // On timeout the container outlives the killed CLI, so reap it by name
    // before reporting the attempt result (BUG-B2).
    const settle = (result: SpawnResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const containerName = result.timedOut ? containerNameFromArgs(args) : undefined;
      if (!containerName) {
        resolvePromise(result);
        return;
      }
      void reapContainer(command, containerName).then(() => resolvePromise(result));
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = appendBoundedOutput(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendBoundedOutput(stderr, chunk); });
    child.on("error", (error: NodeJS.ErrnoException) => {
      settle({
        code: null,
        signal: null,
        stdout: "",
        stderr: redactSecrets(stderr || error.message),
        timedOut,
        errorCode: error.code,
        elapsedMs: Date.now() - startMs,
      });
    });

    // `close` may fire before or after `exit`. Record it either way: if it has
    // already landed when `exit` arrives, the pipes are drained and we settle
    // immediately with no grace wait at all (the common, fast path).
    let closed = false;
    let drainTimer: NodeJS.Timeout | undefined;
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (drainTimer) clearTimeout(drainTimer);
      // Past the grace window the pipes belong to something we no longer wait
      // for; release our read side so the event loop is not held open by it.
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle({
        code,
        signal,
        stdout: redactSecrets(stdout),
        stderr: redactSecrets(stderr),
        timedOut,
        elapsedMs: Date.now() - startMs,
      });
    };
    child.on("close", () => { closed = true; });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (closed) {
        finish(code, signal);
        return;
      }
      // Best-effort drain with its own cap: anything the pipes deliver inside
      // the window is kept, and a pipe held open by a grandchild can delay the
      // result by at most STDIO_DRAIN_GRACE_MS.
      drainTimer = setTimeout(() => finish(code, signal), STDIO_DRAIN_GRACE_MS);
      drainTimer.unref();
      child.once("close", () => finish(code, signal));
    });
  });
}

/**
 * Give each retry attempt a distinct container name.
 *
 * The caller bakes a fixed `--name` into args. If a prior attempt left a
 * container behind (e.g. a SIGKILLed engine CLI while the container kept
 * running detached), reusing the same name makes every retry fail with
 * "container name already in use" — which this harness classifies as
 * transient, producing a guaranteed-failing retry loop. Suffixing the name
 * with the attempt number lets the retry start cleanly. The first attempt is
 * left untouched.
 */
export function argsForAttempt(args: string[], attempt: number): string[] {
  if (attempt <= 1) return args;
  const nameIdx = args.indexOf("--name");
  if (nameIdx < 0 || nameIdx + 1 >= args.length) return args;
  const next = [...args];
  next[nameIdx + 1] = `${next[nameIdx + 1]}-r${attempt}`.slice(0, 128);
  return next;
}

function extractPrUrl(stdout: string): string | undefined {
  // owner/repo are single path segments — using [^\s]+ for them let the match
  // greedily span two adjacent URLs (e.g. "...repo/pull/5#https://.../pull/9")
  // and capture a wrong PR, which can flip a failed run to "completed".
  return stdout.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/)?.[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
