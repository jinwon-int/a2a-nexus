/**
 * #2129: the T1 crash-loop incident was invisible from the broker's own logs
 * — nothing recorded how long a shutdown drain actually took, so operators
 * could not tell after the fact whether `stop_grace_period` had been
 * exceeded before Compose sent SIGKILL. `server-lifecycle.ts`'s `closeServer`
 * now times the drain (server close through `closeWorkerPersistence`
 * resolving, which is when the shared-state serving fence is released) and
 * logs it in a greppable, budget-aware line. This spawns the
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
