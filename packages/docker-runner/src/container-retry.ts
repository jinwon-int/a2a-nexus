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

  // We accumulate output from all attempts so no evidence is lost.
  let accumulatedStdout = "";
  let accumulatedStderr = "";
  const sep = "\n--- retry boundary ---\n";

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    const startedAt = Date.now();
    const attemptResult = await spawnWithTimeout(command, argsForAttempt(args, attempt), timeoutMs, attempt, config.maxAttempts);

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
        retryEvidence: buildRetryEvidence(config, attempts, succeededOnAttempt),
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
        retryEvidence: buildRetryEvidence(config, attempts, succeededOnAttempt),
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
        retryEvidence: buildRetryEvidence(config, attempts, 0),
      };
    }

    // Transient failure: compute backoff delay and wait.
    if (attempt < config.maxAttempts) {
      const delayMs = computeRetryDelay(attempt, config);
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
    retryEvidence: buildRetryEvidence(config, attempts, 0),
  };
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function buildRetryEvidence(
  config: RetryConfig,
  attempts: RetryAttemptRecord[],
  succeededOnAttempt: number,
): ContainerRetryEvidence {
  return {
    schemaVersion: "a2a.runner.container-retry-evidence.v1",
    config: { ...config },
    attempts,
    totalAttempts: attempts.length,
    succeededOnAttempt,
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
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = appendBoundedOutput(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendBoundedOutput(stderr, chunk); });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolvePromise({
        code: null,
        signal: null,
        stdout: "",
        stderr: redactSecrets(stderr || error.message),
        timedOut,
        errorCode: error.code,
        elapsedMs: Date.now() - startMs,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        code,
        signal,
        stdout: redactSecrets(stdout),
        stderr: redactSecrets(stderr),
        timedOut,
        elapsedMs: Date.now() - startMs,
      });
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
