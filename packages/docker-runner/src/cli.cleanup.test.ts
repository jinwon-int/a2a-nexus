import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("./cli.js", import.meta.url));

interface CleanupOutput {
  ok: boolean;
  dryRun: boolean;
  rootDir: string;
  candidates: string[];
  removed: string[];
}

/**
 * #2267 reproduction: a fleet node's stale CLI-default env file carried a
 * hermes profile with an EXTRA_MOUNTS_JSON that fails profile/mount
 * validation. `cleanup` used to route through loadConfig and die with
 * "hermes patch profile requires a /run/secrets/hermes-dir mount" even though
 * pruning only needs the task root.
 */
const STALE_ENV_BODY = [
  "A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=hermes",
  'A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON=[{"source":"/nonexistent/host/path","target":"/mnt/data","readOnly":true}]',
].join("\n");

async function seedExpiredRun(rootDir: string): Promise<string> {
  const runDir = join(rootDir, "task-old", "20260601T000000-run1");
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "run.json"), JSON.stringify({ createdAt: "2026-06-01T00:00:00Z" }), "utf8");
  const old = new Date("2026-06-01T00:00:00Z");
  await utimes(runDir, old, old);
  return runDir;
}

async function runCleanup(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.A2A_DOCKER_RUNNER_ROOT;
  delete childEnv.A2A_DOCKER_RUNNER_ENV_FILE;
  Object.assign(childEnv, env);
  return execFileAsync(process.execPath, [CLI, "cleanup", ...args], { env: childEnv, timeout: 60_000 });
}

test("#2267 cleanup --dry-run succeeds with an env file that fails full runner config validation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "a2a-cleanup-cli-"));
  try {
    const rootDir = join(dir, "tasks");
    const runDir = await seedExpiredRun(rootDir);
    const envFile = join(dir, "stale.env");
    await writeFile(envFile, `${STALE_ENV_BODY}\nA2A_DOCKER_RUNNER_ROOT=${rootDir}\n`, "utf8");

    const { stdout } = await runCleanup(["--env-file", envFile, "--ttl", "7d", "--dry-run"], {});
    const report = JSON.parse(stdout) as CleanupOutput;
    assert.equal(report.dryRun, true);
    assert.equal(report.rootDir, rootDir);
    assert.ok(report.candidates.includes(runDir), JSON.stringify(report.candidates));
    assert.deepEqual(report.removed, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#2267 cleanup --root overrides the env file task root and reports a missing env file on stderr", async () => {
  const dir = await mkdtemp(join(tmpdir(), "a2a-cleanup-cli-"));
  try {
    const rootDir = join(dir, "tasks");
    await seedExpiredRun(rootDir);
    const envFile = join(dir, "missing.env");

    // Node 22 itself aborts on `--env-file <missing>` even after the script path
    // (exit 9, "node: <path>: not found"), so a missing file can only be
    // exercised through the env var.
    const { stdout, stderr } = await runCleanup(["--root", rootDir, "--ttl", "7d", "--dry-run"], {
      A2A_DOCKER_RUNNER_ENV_FILE: envFile,
    });
    const report = JSON.parse(stdout) as CleanupOutput;
    assert.equal(report.rootDir, rootDir);
    assert.equal(report.candidates.length, 2, JSON.stringify(report.candidates)); // run dir + empty task root
    assert.match(stderr, /warning: service env file not found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#2267 cleanup rejects a relative --root", async () => {
  await assert.rejects(
    runCleanup(["--root", "relative/tasks", "--dry-run"], { A2A_DOCKER_RUNNER_ENV_FILE: "/nonexistent/env" }),
    (error: { stderr?: string }) => /invalid task root: relative\/tasks/.test(error.stderr ?? ""),
  );
});
