/**
 * Container Retry Harness Tests
 *
 * Tests the synchronous building blocks (error classification, backoff, config)
 * and the retry harness via single-attempt subprocess calls.  Multi-attempt
 * retry is verified through the composable synchronous functions.
 *
 * Parent: a2a-broker#838
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appendBoundedOutput,
  argsForAttempt,
  computeRetryDelay,
  containerNameFromArgs,
  defaultRetryConfig,
  isTransientContainerError,
  reapContainer,
  runContainerWithRetry,
  STDIO_DRAIN_GRACE_MS,
} from "./container-retry.js";
import type { RetryConfig } from "./container-retry.js";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ─── argsForAttempt: unique container name per retry ─────────────────────────

describe("argsForAttempt", () => {
  const base = ["run", "--rm", "--name", "a2a-task-tok", "--network", "bridge"];

  it("leaves the first attempt's args unchanged", () => {
    assert.deepEqual(argsForAttempt(base, 1), base);
  });

  it("suffixes the container name on retries so a leftover does not block", () => {
    assert.deepEqual(
      argsForAttempt(base, 2),
      ["run", "--rm", "--name", "a2a-task-tok-r2", "--network", "bridge"],
    );
    assert.deepEqual(
      argsForAttempt(base, 3),
      ["run", "--rm", "--name", "a2a-task-tok-r3", "--network", "bridge"],
    );
  });

  it("does not mutate the input args array", () => {
    const copy = [...base];
    argsForAttempt(base, 2);
    assert.deepEqual(base, copy);
  });

  it("is a no-op when there is no --name flag", () => {
    const noName = ["run", "--rm", "--network", "bridge"];
    assert.deepEqual(argsForAttempt(noName, 2), noName);
  });
});

// ─── isTransientContainerError ──────────────────────────────────────────────

describe("isTransientContainerError", () => {
  it("returns false for ENOENT (engine not installed)", () => {
    assert.equal(isTransientContainerError({
      code: null, signal: null, stdout: "", stderr: "ENOENT: docker not found",
      timedOut: false, errorCode: "ENOENT",
    }), false);
  });

  it("returns false for pull access denied (auth failure)", () => {
    assert.equal(isTransientContainerError({
      code: 1, signal: null, stdout: "",
      stderr: "Error response from daemon: pull access denied for private/image",
      timedOut: false,
    }), false);
  });

  it("returns false for manifest not found (invalid image)", () => {
    assert.equal(isTransientContainerError({
      code: 1, signal: null, stdout: "",
      stderr: "manifest for nope/nope:latest not found: manifest unknown",
      timedOut: false,
    }), false);
  });

  it("returns false for unauthorized", () => {
    assert.equal(isTransientContainerError({
      code: 1, signal: null, stdout: "", stderr: "unauthorized: authentication required",
      timedOut: false,
    }), false);
  });

  it("returns true for container name conflict", () => {
    assert.equal(isTransientContainerError({
      code: 1, signal: null, stdout: "",
      stderr: 'Conflict. The container name "/a2a-runner-xxx" is already in use',
      timedOut: false,
    }), true);
  });

  it("returns true for OOM (exit 137)", () => {
    assert.equal(isTransientContainerError({
      code: 137, signal: null, stdout: "", stderr: "", timedOut: false,
    }), true);
  });

  it("returns true for daemon timeout", () => {
    assert.equal(isTransientContainerError({
      code: 1, signal: null, stdout: "",
      stderr: "Error response from daemon: timeout waiting for container",
      timedOut: false,
    }), true);
  });

  it("returns true for daemon connection error", () => {
    assert.equal(isTransientContainerError({
      code: 1, signal: null, stdout: "",
      stderr: "Cannot connect to the Docker daemon. Is the docker daemon running?",
      timedOut: false,
    }), true);
  });

  it("returns true for generic daemon error response", () => {
    assert.equal(isTransientContainerError({
      code: 125, signal: null, stdout: "",
      stderr: "Error response from daemon: connection reset",
      timedOut: false,
    }), true);
  });

  it("returns false for timed out results (retrying only multiplies wall-clock)", () => {
    assert.equal(isTransientContainerError({
      code: null, signal: "SIGTERM", stdout: "", stderr: "", timedOut: true,
    }), false);
  });

  it("does not retry a timeout even when stderr would otherwise look transient", () => {
    assert.equal(isTransientContainerError({
      code: null, signal: "SIGTERM", stdout: "",
      stderr: "Error response from daemon: timeout",
      timedOut: true,
    }), false);
  });

  it("returns false for unknown non-zero exit", () => {
    assert.equal(isTransientContainerError({
      code: 2, signal: null, stdout: "", stderr: "command not found", timedOut: false,
    }), false);
  });

  it("returns false for exit 0 with errors in stderr (no transient match)", () => {
    // Exit 0 is not an error; the retry harness never calls isTransientContainerError for code 0.
    // But the function itself should not incorrectly classify it.
    assert.equal(isTransientContainerError({
      code: 0, signal: null, stdout: "ok",
      stderr: "WARN: something advisory",
      timedOut: false,
    }), false);
  });
});

// ─── computeRetryDelay ──────────────────────────────────────────────────────

describe("computeRetryDelay", () => {
  const config: RetryConfig = {
    maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2, jitterFactor: 0,
  };

  it("returns 0 for attempt 0 (invalid)", () => {
    assert.equal(computeRetryDelay(0, config), 0);
  });

  it("returns 0 for final attempt (no delay needed)", () => {
    assert.equal(computeRetryDelay(5, config), 0);
  });

  it("returns base delay for first retry (attempt 1)", () => {
    assert.equal(computeRetryDelay(1, { ...config, jitterFactor: 0 }), 1000);
  });

  it("doubles for attempt 2", () => {
    assert.equal(computeRetryDelay(2, { ...config, jitterFactor: 0 }), 2000);
  });

  it("quadruples for attempt 3", () => {
    assert.equal(computeRetryDelay(3, { ...config, jitterFactor: 0 }), 4000);
  });

  it("caps at maxDelayMs", () => {
    assert.equal(computeRetryDelay(4, { ...config, jitterFactor: 0 }), 8000);
  });

  it("applies jitter within bounded range", () => {
    const jc: RetryConfig = { ...config, jitterFactor: 0.5 };
    for (let i = 0; i < 200; i++) {
      const d = computeRetryDelay(1, jc);
      assert.ok(d >= 500 && d <= 1500, `delay ${d} out of [500, 1500]`);
    }
  });

  it("jitter does not exceed maxDelay", () => {
    const cc: RetryConfig = { ...config, maxDelayMs: 2000, jitterFactor: 0.5 };
    for (let i = 0; i < 200; i++) {
      assert.ok(computeRetryDelay(4, cc) <= 3000);
    }
  });
});

describe("appendBoundedOutput", () => {
  it("caps retained output while continuing to accept drained chunks", () => {
    const first = appendBoundedOutput("1234", "567890", 8);
    assert.match(first, /^12345678\n<output truncated:/);
    assert.equal(appendBoundedOutput(first, "discarded", 8), first);
  });
});

// ─── runContainerWithRetry — single-attempt tests ──────────────────────────

describe("runContainerWithRetry (single attempt)", () => {
  const baseCfg = { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 100, backoffFactor: 2, jitterFactor: 0 };

  it("succeeds on 'true'", async () => {
    const { result, retryEvidence } = await runContainerWithRetry("true", [], 5000, baseCfg);
    assert.equal(result.code, 0);
    assert.equal(retryEvidence.totalAttempts, 1);
    assert.equal(retryEvidence.succeededOnAttempt, 1);
  });

  it("does not retry ENOENT", async () => {
    const { result, retryEvidence } = await runContainerWithRetry("cmd-not-exist-xyz", [], 5000, {
      ...baseCfg, maxAttempts: 3,
    });
    assert.equal(retryEvidence.totalAttempts, 1);
    assert.equal(retryEvidence.succeededOnAttempt, 0);
    assert.equal(result.errorCode, "ENOENT");
  });

  it("captures schema version", async () => {
    const { retryEvidence } = await runContainerWithRetry("true", [], 5000, baseCfg);
    assert.equal(retryEvidence.schemaVersion, "a2a.runner.container-retry-evidence.v1");
  });

  it("captures per-attempt record", async () => {
    const { retryEvidence } = await runContainerWithRetry("true", [], 5000, baseCfg);
    assert.equal(retryEvidence.attempts.length, 1);
    assert.equal(retryEvidence.attempts[0].attempt, 1);
    assert.equal(retryEvidence.attempts[0].outcome, "container_exit");
    assert.equal(retryEvidence.attempts[0].exitCode, 0);
  });

  it("captures config in evidence", async () => {
    const cfg = { ...baseCfg, maxAttempts: 5, baseDelayMs: 250, maxDelayMs: 2000 };
    const { retryEvidence } = await runContainerWithRetry("true", [], 5000, cfg);
    assert.equal(retryEvidence.config.maxAttempts, 5);
    assert.equal(retryEvidence.config.baseDelayMs, 250);
    assert.equal(retryEvidence.config.maxDelayMs, 2000);
  });

  it("redacts secrets from stdout and stderr before returning retry output", async () => {
    const token = `ghp_${"a".repeat(40)}`;
    const key = `sk-${"b".repeat(40)}`;
    const script = `printf 'token=${token}\\n'; printf 'api_key=${key}\\n' >&2; exit 2`;
    const { result, retryEvidence } = await runContainerWithRetry("bash", ["-lc", script], 5000, baseCfg);

    assert.equal(result.code, 2);
    assert.equal(retryEvidence.totalAttempts, 1);
    assert.match(result.stdout, /token=<redacted-github-token>/);
    assert.match(result.stderr, /api_key=<redacted-api-key>/);
    assert.doesNotMatch(result.stdout, new RegExp(token));
    assert.doesNotMatch(result.stderr, new RegExp(key));
    assert.doesNotMatch(retryEvidence.attempts[0].errorMessage ?? "", new RegExp(key));
  });
});

// ─── BUG-B2: timed-out containers are reaped by name ───────────────────────

function makeFakeEngine(body: string): { enginePath: string; dir: string } {
  const executableTmpDir = fileURLToPath(new URL("../tmp/", import.meta.url));
  mkdirSync(executableTmpDir, { recursive: true });
  const dir = mkdtempSync(join(executableTmpDir, "retry-engine-"));
  const enginePath = join(dir, "fake-engine.sh");
  writeFileSync(enginePath, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(enginePath, 0o700);
  return { enginePath, dir };
}

describe("containerNameFromArgs", () => {
  it("extracts the deterministic --name assigned by buildRunArgs", () => {
    assert.equal(
      containerNameFromArgs(["run", "--rm", "--init", "--name", "a2a-task-tok", "--network", "bridge"]),
      "a2a-task-tok",
    );
  });

  it("returns undefined when --name is absent, trailing, or flag-like", () => {
    assert.equal(containerNameFromArgs(["run", "--rm"]), undefined);
    assert.equal(containerNameFromArgs(["run", "--name"]), undefined);
    assert.equal(containerNameFromArgs(["run", "--name", "--network"]), undefined);
  });
});

describe("reapContainer", () => {
  it("invokes '<engine> rm -f <name>' for the leaked container", async () => {
    const { enginePath, dir } = makeFakeEngine(`printf '%s ' "$@" > "$(dirname "$0")/reap-argv"`);
    await reapContainer(enginePath, "a2a-leaked-container");
    assert.equal(readFileSync(join(dir, "reap-argv"), "utf8").trim(), "rm -f a2a-leaked-container");
  });

  it("never throws when the engine is missing or fails", async () => {
    await reapContainer("engine-does-not-exist-xyz", "a2a-leaked-container");
    const { enginePath } = makeFakeEngine("exit 3");
    await reapContainer(enginePath, "a2a-leaked-container");
  });
});

describe("runContainerWithRetry (timeout reap)", () => {
  const baseCfg: RetryConfig = { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 100, backoffFactor: 2, jitterFactor: 0 };

  it("force-removes the container by name after a timeout kills the CLI", async () => {
    // `run` hangs past the timeout (the real CLI's container keeps running
    // detached); `rm` records that the reap happened.
    const { enginePath, dir } = makeFakeEngine(`
if [ "$1" = "rm" ]; then printf '%s ' "$@" > "$(dirname "$0")/reap-argv"; exit 0; fi
exec sleep 30
`);
    const args = ["run", "--rm", "--init", "--name", "a2a-timeout-victim", "image"];
    const { result } = await runContainerWithRetry(enginePath, args, 300, baseCfg);

    assert.equal(result.timedOut, true);
    assert.ok(existsSync(join(dir, "reap-argv")), "timed-out run must be reaped");
    assert.equal(readFileSync(join(dir, "reap-argv"), "utf8").trim(), "rm -f a2a-timeout-victim");
  });

  it("does not reap when the attempt exits normally", async () => {
    const { enginePath, dir } = makeFakeEngine(`
if [ "$1" = "rm" ]; then printf '%s ' "$@" > "$(dirname "$0")/reap-argv"; exit 0; fi
exit 0
`);
    const { result } = await runContainerWithRetry(
      enginePath,
      ["run", "--rm", "--name", "a2a-clean-exit", "image"],
      5000,
      baseCfg,
    );
    assert.equal(result.code, 0);
    assert.equal(existsSync(join(dir, "reap-argv")), false);
  });
});

// ─── #2052: a leaked stdio pipe must not extend the attempt ────────────────

describe("runContainerWithRetry (grandchild holds the stdio pipes)", () => {
  const baseCfg: RetryConfig = { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 100, backoffFactor: 2, jitterFactor: 0 };

  it("resolves a timed-out attempt on child exit even while a grandchild keeps the pipes open", async () => {
    // The engine forks a long-lived grandchild that inherits stdout/stderr and
    // then execs the foreground process, so SIGTERM kills the direct child but
    // the pipes stay open for 10s. Resolving on `close` would make this
    // attempt outlast its 300ms timeout by ~10s (#2052).
    const { enginePath } = makeFakeEngine(`
if [ "$1" = "rm" ]; then exit 0; fi
sleep 10 &
exec sleep 10
`);
    const startedAt = Date.now();
    const { result } = await runContainerWithRetry(
      enginePath,
      ["run", "--rm", "--name", "a2a-pipe-holder", "image"],
      300,
      baseCfg,
    );
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.timedOut, true);
    assert.ok(
      elapsedMs < 3000,
      `timeout must not be contingent on pipe closure, resolved in ${elapsedMs}ms (grandchild holds pipes for 10000ms)`,
    );
  });

  it("keeps stdout/stderr written before exit when a grandchild holds the pipes open", async () => {
    // The child writes, exits 7 immediately; the grandchild keeps the pipes
    // open. The result must arrive promptly AND carry the output — dropping it
    // would trade a hang for lost diagnostic evidence.
    const { enginePath } = makeFakeEngine(`
if [ "$1" = "rm" ]; then exit 0; fi
sleep 10 &
printf 'evidence-on-stdout\\n'
printf 'evidence-on-stderr\\n' >&2
exit 7
`);
    const startedAt = Date.now();
    const { result, retryEvidence } = await runContainerWithRetry(enginePath, ["run"], 30_000, baseCfg);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.code, 7);
    assert.equal(result.timedOut, false);
    assert.match(result.stdout, /evidence-on-stdout/);
    assert.match(result.stderr, /evidence-on-stderr/);
    assert.equal(retryEvidence.attempts[0].outcome, "container_exit");
    assert.ok(
      elapsedMs < 3000,
      `exit must settle the attempt without waiting for the leaked pipes, took ${elapsedMs}ms`,
    );
  });

  it("adds no drain latency to a normally terminating child", async () => {
    const startedAt = Date.now();
    const { result } = await runContainerWithRetry("printf", ["fast\\n"], 5000, baseCfg);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.code, 0);
    assert.match(result.stdout, /fast/);
    assert.ok(elapsedMs < STDIO_DRAIN_GRACE_MS, `clean exit must not wait for the drain grace, took ${elapsedMs}ms`);
  });
});

// ─── BUG-B3: absolute retry budget ─────────────────────────────────────────

describe("runContainerWithRetry (absolute budget)", () => {
  it("defaults the total budget to the per-attempt timeout and records it", async () => {
    const { retryEvidence } = await runContainerWithRetry("true", [], 5000, {
      maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, backoffFactor: 2, jitterFactor: 0,
    });
    assert.equal(retryEvidence.totalBudgetMs, 5000);
    assert.equal(retryEvidence.budgetExhausted, false);
  });

  it("honours an explicit totalBudgetMs", async () => {
    const { retryEvidence } = await runContainerWithRetry("true", [], 5000, {
      maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, backoffFactor: 2, jitterFactor: 0,
      totalBudgetMs: 12_000,
    });
    assert.equal(retryEvidence.totalBudgetMs, 12_000);
  });

  it("stops retrying transient failures once the absolute budget is spent", async () => {
    // Each attempt burns ~400ms and fails transiently; a 900ms total budget
    // funds two attempts at most, not the configured five.
    const { enginePath } = makeFakeEngine(`
if [ "$1" = "rm" ]; then exit 0; fi
sleep 0.4
echo "Error response from daemon: connection reset" >&2
exit 125
`);
    const startedAt = Date.now();
    const { retryEvidence } = await runContainerWithRetry(enginePath, ["run"], 5000, {
      maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 20, backoffFactor: 2, jitterFactor: 0,
      totalBudgetMs: 900,
    });
    const elapsedMs = Date.now() - startedAt;

    assert.ok(retryEvidence.totalAttempts < 5, `budget must cut retries short, got ${retryEvidence.totalAttempts}`);
    assert.equal(retryEvidence.budgetExhausted, true);
    assert.equal(retryEvidence.succeededOnAttempt, 0);
    // Without the deadline this would be 5 × ~400ms ≈ 2s.
    assert.ok(elapsedMs < 1800, `total wall clock must stay near the budget, got ${elapsedMs}ms`);
  });

  it("clamps a retry's timeout to the remaining budget instead of granting a fresh one", async () => {
    // Attempt 1 burns most of a 1500ms budget, then hangs on retry: the retry
    // must time out against the ~1s remainder, not a fresh 5000ms timeout.
    const { enginePath, dir } = makeFakeEngine(`
if [ "$1" = "rm" ]; then exit 0; fi
n=$(cat "$(dirname "$0")/count" 2>/dev/null || echo 0)
echo $((n + 1)) > "$(dirname "$0")/count"
if [ "$n" = "0" ]; then
  sleep 0.3
  echo "Error response from daemon: connection reset" >&2
  exit 125
fi
exec sleep 30
`);
    writeFileSync(join(dir, "count"), "0");
    const startedAt = Date.now();
    const { result, retryEvidence } = await runContainerWithRetry(
      enginePath,
      ["run", "--name", "a2a-budget-clamp"],
      5000,
      {
        maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 20, backoffFactor: 2, jitterFactor: 0,
        totalBudgetMs: 1500,
      },
    );
    const elapsedMs = Date.now() - startedAt;

    assert.equal(retryEvidence.totalAttempts, 2);
    assert.equal(result.timedOut, true);
    assert.ok(elapsedMs < 4000, `retry must be clamped to the remaining budget, got ${elapsedMs}ms`);
  });
});

// ─── defaultRetryConfig ────────────────────────────────────────────────────

describe("defaultRetryConfig", () => {
  it("returns sensible defaults", () => {
    const c = defaultRetryConfig();
    assert.equal(c.maxAttempts, 3);
    assert.equal(c.baseDelayMs, 1000);
    assert.equal(c.maxDelayMs, 8000);
    assert.equal(c.backoffFactor, 2);
    assert.ok(c.jitterFactor > 0 && c.jitterFactor < 1);
  });
});
