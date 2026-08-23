/**
 * Child-process proof that two broker processes cannot both hold the
 * serving fence. `/readyz` and loss-after-listen are out of scope.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

function childModulePath(): string {
  const here = fileURLToPath(import.meta.url);
  if (here.endsWith(".ts")) {
    return here.replace(
      /shared-state-serving-fence-startup-v1\.test\.ts$/,
      "shared-state-serving-fence-child-v1.ts",
    );
  }
  return here.replace(
    /shared-state-serving-fence-startup-v1\.test\.js$/,
    "shared-state-serving-fence-child-v1.js",
  );
}

function spawnFenceChild(sharedStateFile: string) {
  const modulePath = childModulePath();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BROKER_SHARED_STATE_FILE: sharedStateFile,
  };
  delete env.BROKER_DEPLOYMENT_GRADE;
  delete env.BROKER_EXPECTED_PROCESS_COUNT;
  const brokerRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  if (modulePath.endsWith(".ts")) {
    return spawn("npm", ["exec", "--yes=false", "--", "tsx", modulePath], {
      cwd: brokerRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
  }
  return spawn(process.execPath, [modulePath], {
    cwd: brokerRoot,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function readLine(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for child output: ${buffer}`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timer);
        resolve(buffer.slice(0, newline));
      }
    });
    child.once("exit", (code) => {
      if (buffer.includes("\n")) return;
      clearTimeout(timer);
      reject(new Error(`child exited ${code} before a line: ${buffer}`));
    });
  });
}

function killChild(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  }
}

function waitExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      killChild(child, "SIGKILL");
      reject(new Error("timed out waiting for child exit"));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

test("two child processes cannot both acquire the same serving fence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "a2a-serving-fence-child-"));
  const sharedStateFile = join(directory, "fence.sqlite");
  const holder = spawnFenceChild(sharedStateFile);
  try {
    const firstLine = await readLine(holder, 15_000);
    assert.equal(firstLine, "acquired");

    const contender = spawnFenceChild(sharedStateFile);
    const [contenderLine, contenderStatus] = await Promise.all([
      readLine(contender, 15_000).catch((error: Error) => error.message),
      waitExit(contender, 15_000),
    ]);
    assert.equal(contenderStatus, 1);
    assert.match(
      String(contenderLine),
      /shared-state serving fence rejected: ownership_conflict/,
    );

    killChild(holder, "SIGTERM");
    const holderStatus = await waitExit(holder, 15_000);
    assert.equal(holderStatus, 0);

    const successor = spawnFenceChild(sharedStateFile);
    try {
      const successorLine = await readLine(successor, 15_000);
      assert.equal(successorLine, "acquired");
    } finally {
      killChild(successor, "SIGTERM");
      await waitExit(successor, 15_000);
    }
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) {
      killChild(holder, "SIGKILL");
      await waitExit(holder, 5_000).catch(() => undefined);
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
