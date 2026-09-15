/**
 * #2129: the T1 crash-loop incident was invisible from the broker's own logs
 * — nothing recorded how long a shutdown actually took, so operators
 * could not tell after the fact whether `stop_grace_period` had been
 * exceeded before Compose sent SIGKILL. `server-lifecycle.ts` now times the
 * shutdown from the FIRST shutdown signal — including any
 * `A2A_SHUTDOWN_DRAIN_MS` pre-close drain, which the pre-fix code omitted by
 * anchoring the timer inside `closeServer` after that drain had already run —
 * through `closeWorkerPersistence` resolving, which is when the shared-state
 * serving fence is released, and logs it in a greppable, budget-aware line.
 * This spawns the
 * `server-lifecycle-drain-log-child.ts` helper — a minimal fake runtime, not
 * a full broker — so the assertions exercise the real timing/logging code in
 * `server-lifecycle.ts` end to end through a real SIGTERM.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

function childModulePath(): string {
  const here = fileURLToPath(import.meta.url);
  if (here.endsWith(".ts")) {
    return here.replace(
      /server-lifecycle-drain-log\.test\.ts$/,
      "server-lifecycle-drain-log-child.ts",
    );
  }
  return here.replace(
    /server-lifecycle-drain-log\.test\.js$/,
    "server-lifecycle-drain-log-child.js",
  );
}

function spawnChild(env: NodeJS.ProcessEnv) {
  const modulePath = childModulePath();
  const fullEnv = { ...process.env, ...env };
  const child = modulePath.endsWith(".ts")
    ? spawn("npm", ["exec", "--yes=false", "--", "tsx", modulePath], {
      env: fullEnv,
      stdio: ["ignore", "pipe", "pipe"],
    })
    : spawn(process.execPath, [modulePath], {
      env: fullEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
  child.unref();
  return child;
}

function waitForLine(
  stream: NodeJS.ReadableStream,
  predicate: (line: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for matching line: ${buffer}`));
    }, timeoutMs);
    stream.on("data", (chunk: Buffer | string) => {
      buffer += String(chunk);
      let newline: number;
      // eslint-disable-next-line no-cond-assign
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (predicate(line)) {
          clearTimeout(timer);
          resolve(line);
          return;
        }
      }
    });
  });
}

function waitExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out waiting for child exit"));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/** Full-stream buffer attached at spawn time; lets tests count occurrences. */
function collectLines(stream: NodeJS.ReadableStream): { text: () => string } {
  const chunks: string[] = [];
  stream.on("data", (chunk: Buffer | string) => chunks.push(String(chunk)));
  return { text: () => chunks.join("") };
}

test("drain-duration log line reports elapsed ms and the configured budget on a normal-speed drain", {
  timeout: 20_000,
}, async () => {
  const child = spawnChild({
    TEST_CLOSE_WORKER_PERSISTENCE_DELAY_MS: "10",
  });
  try {
    await waitForLine(child.stdout!, (line) => line === "ready", 8_000);
    child.kill("SIGTERM");
    const stdoutLine = await waitForLine(
      child.stdout!,
      (line) => /drain completed in \d+ms/.test(line),
      8_000,
    );
    assert.match(
      stdoutLine,
      /^\[a2a-broker\] drain completed in \d+ms \(stop_grace_period budget: 60000ms\)$/,
    );
    const exitCode = await waitExit(child, 8_000);
    assert.equal(exitCode, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("drain-duration log line escalates to a WARN on stderr once the drain nears the configured budget", {
  timeout: 20_000,
}, async () => {
  const child = spawnChild({
    A2A_STOP_GRACE_PERIOD_HINT_MS: "50",
    TEST_CLOSE_WORKER_PERSISTENCE_DELAY_MS: "80",
  });
  try {
    await waitForLine(child.stdout!, (line) => line === "ready", 8_000);
    child.kill("SIGTERM");
    const stderrLine = await waitForLine(
      child.stderr!,
      (line) => /drain completed in \d+ms/.test(line),
      8_000,
    );
    assert.match(
      stderrLine,
      /^\[a2a-broker\] drain completed in \d+ms \(stop_grace_period budget: 50ms\)$/,
    );
    const exitCode = await waitExit(child, 8_000);
    assert.equal(exitCode, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("#2129: reported elapsed includes the A2A_SHUTDOWN_DRAIN_MS pre-close drain and its WARN threshold", {
  timeout: 20_000,
}, async () => {
  const preDrainMs = 400;
  const closeDelayMs = 100;
  const child = spawnChild({
    A2A_SHUTDOWN_DRAIN_MS: String(preDrainMs),
    A2A_STOP_GRACE_PERIOD_HINT_MS: "600",
    TEST_CLOSE_WORKER_PERSISTENCE_DELAY_MS: String(closeDelayMs),
  });
  try {
    await waitForLine(child.stdout!, (line) => line === "ready", 8_000);
    child.kill("SIGTERM");
    // The signal takes the pre-drain path: beginDrain runs, close starts only
    // after the configured drain window.
    await waitForLine(
      child.stdout!,
      (line) => line === `[a2a-broker] received SIGTERM, draining for ${preDrainMs}ms before close`,
      8_000,
    );
    // preDrainMs + closeDelayMs = 500ms measured against the 600ms hint
    // crosses the 80% WARN threshold, so the line must land on stderr.
    const stderrLine = await waitForLine(
      child.stderr!,
      (line) => /drain completed in \d+ms/.test(line),
      8_000,
    );
    const match = /drain completed in (\d+)ms \(stop_grace_period budget: 600ms\)/.exec(stderrLine);
    assert.ok(match, `unexpected drain log line: ${stderrLine}`);
    const elapsedMs = Number(match[1]);
    // The pre-fix code anchored the timer inside closeServer, i.e. after the
    // pre-drain, and would have reported ~closeDelayMs here. Elapsed must
    // cover the whole window: first signal → pre-drain → close → persistence
    // close. setTimeout never fires early and performance.now() is monotonic,
    // so the lower bound is exact.
    assert.ok(
      elapsedMs >= preDrainMs + closeDelayMs,
      `expected elapsed >= ${preDrainMs + closeDelayMs}ms (pre-drain included), got ${elapsedMs}ms`,
    );
    assert.ok(
      elapsedMs < preDrainMs + closeDelayMs + 5_000,
      `implausible elapsed: ${elapsedMs}ms`,
    );
    const exitCode = await waitExit(child, 8_000);
    assert.equal(exitCode, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

for (const [firstSignal, secondSignal] of [["SIGTERM", "SIGINT"], ["SIGTERM", "SIGTERM"], ["SIGINT", "SIGINT"]] as const) {
test(`#2129: ${firstSignal} then ${secondSignal} does not restart timing or run close twice`, {
  timeout: 20_000,
}, async () => {
  const preDrainMs = 300;
  const closeDelayMs = 20;
  const child = spawnChild({
    A2A_SHUTDOWN_DRAIN_MS: String(preDrainMs),
    TEST_CLOSE_WORKER_PERSISTENCE_DELAY_MS: String(closeDelayMs),
  });
  const stdout = collectLines(child.stdout!);
  try {
    await waitForLine(child.stdout!, (line) => line === "ready", 8_000);
    child.kill(firstSignal);
    await waitForLine(
      child.stdout!,
      (line) => line === `[a2a-broker] received ${firstSignal}, draining for ${preDrainMs}ms before close`,
      8_000,
    );
    // Both repeated and mixed signals must retain the graceful shutdown handler.
    setTimeout(() => child.kill(secondSignal), 100);
    await waitForLine(
      child.stdout!,
      (line) => line.startsWith(`[a2a-broker] ${secondSignal}: shutdown already in progress`),
      8_000,
    );
    const finalLine = await waitForLine(
      child.stdout!,
      (line) => /drain completed in \d+ms/.test(line),
      8_000,
    );
    const elapsedMs = Number(/drain completed in (\d+)ms/.exec(finalLine)![1]);
    assert.ok(
      elapsedMs >= preDrainMs + closeDelayMs,
      `duplicate signal must not shorten the measured shutdown: got ${elapsedMs}ms`,
    );
    const exitCode = await waitExit(child, 8_000);
    assert.equal(exitCode, 0);
    // Exactly one close sequence and one budget-aware final line.
    assert.equal((stdout.text().match(/drain completed in \d+ms/g) ?? []).length, 1);
    assert.equal((stdout.text().match(/stopping stale reaper and closing server/g) ?? []).length, 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
}

test("#2129: persistence failure reports honest shutdown wording (not 'drain completed') and exits nonzero", {
  timeout: 20_000,
}, async () => {
  const preDrainMs = 100;
  const closeDelayMs = 10;
  const child = spawnChild({
    A2A_SHUTDOWN_DRAIN_MS: String(preDrainMs),
    TEST_CLOSE_WORKER_PERSISTENCE_DELAY_MS: String(closeDelayMs),
    TEST_CLOSE_WORKER_PERSISTENCE_FAIL: "1",
  });
  try {
    await waitForLine(child.stdout!, (line) => line === "ready", 8_000);
    child.kill("SIGTERM");
    const stderrLine = await waitForLine(
      child.stderr!,
      (line) => /shutdown ended after persistence failure in \d+ms/.test(line),
      8_000,
    );
    assert.match(
      stderrLine,
      /^\[a2a-broker\] shutdown ended after persistence failure in \d+ms \(stop_grace_period budget: 60000ms\)$/,
    );
    const elapsedMs = Number(/in (\d+)ms/.exec(stderrLine)![1]);
    assert.ok(elapsedMs >= preDrainMs + closeDelayMs, `elapsed must include pre-drain: got ${elapsedMs}ms`);
    assert.ok(!/drain completed/.test(stderrLine), "failure path must not claim drain completed");
    const exitCode = await waitExit(child, 8_000);
    assert.equal(exitCode, 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
