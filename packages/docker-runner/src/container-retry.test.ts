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
  defaultRetryConfig,
  isTransientContainerError,
  runContainerWithRetry,
} from "./container-retry.js";
import type { RetryConfig } from "./container-retry.js";

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
