import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
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

test("#2267 R2 cleanup takes its TTL from A2A_DOCKER_RUNNER_WORKDIR_TTL in the env file, --ttl still wins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "a2a-cleanup-cli-"));
  try {
    const rootDir = join(dir, "tasks");
    await seedExpiredRun(rootDir);
    const envFile = join(dir, "runner.env");
    // A run created 2026-06-01 is expired under 14d but the legacy 24h default
    // would also expire it; use a huge TTL to prove the env value is honoured.
    await writeFile(envFile, `A2A_DOCKER_RUNNER_ROOT=${rootDir}\nA2A_DOCKER_RUNNER_WORKDIR_TTL=36500d\n`, "utf8");

    const fromEnv = JSON.parse((await runCleanup(["--env-file", envFile, "--dry-run"], {})).stdout) as CleanupOutput & { ttlMs: number };
    assert.equal(fromEnv.ttlMs, 36500 * 86_400_000);
    assert.deepEqual(fromEnv.candidates, []);

    const fromFlag = JSON.parse((await runCleanup(["--env-file", envFile, "--ttl", "7d", "--dry-run"], {})).stdout) as CleanupOutput & { ttlMs: number };
    assert.equal(fromFlag.ttlMs, 7 * 86_400_000);
    assert.equal(fromFlag.candidates.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

interface InstallOutput {
  ok: boolean;
  cleanupTimer?: { unitName: string; service: string; timer: string; ttl: string; changed: string[]; nextSteps: string[] };
}

test("#2267 R2 install --cleanup-timer writes units into --unit-dir and reports operator next steps", async () => {
  const dir = await mkdtemp(join(tmpdir(), "a2a-install-cli-"));
  try {
    const rootDir = join(dir, "tasks");
    const unitDir = join(dir, "units");
    const envFile = join(dir, "runner.env");
    await writeFile(envFile, `A2A_DOCKER_RUNNER_ROOT=${rootDir}\nA2A_DOCKER_RUNNER_WORKDIR_TTL=14d\n`, "utf8");
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv.A2A_DOCKER_RUNNER_ROOT;
    delete childEnv.A2A_DOCKER_RUNNER_ENV_FILE;

    const { stdout } = await execFileAsync(
      process.execPath,
      [CLI, "install", "--env-file", envFile, "--cleanup-timer", "--unit-dir", unitDir],
      { env: childEnv, timeout: 60_000 },
    );
    const report = JSON.parse(stdout) as InstallOutput;
    assert.equal(report.ok, true);
    assert.ok(report.cleanupTimer, "cleanupTimer missing from install output");
    assert.equal(report.cleanupTimer.ttl, "14d");
    assert.equal(report.cleanupTimer.service, join(unitDir, "a2a-docker-runner-cleanup.service"));
    assert.deepEqual(report.cleanupTimer.changed, [report.cleanupTimer.service, report.cleanupTimer.timer]);
    const service = await readFile(report.cleanupTimer.service, "utf8");
    assert.match(service, new RegExp(`^ExecStart=.* ${CLI.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} cleanup --env-file ${envFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} --ttl 14d$`, "m"));
    assert.ok(report.cleanupTimer.nextSteps.some((step) => /systemctl enable --now/.test(step)));

    // Without a TTL anywhere the flag fails loudly instead of writing a broken unit.
    await writeFile(envFile, `A2A_DOCKER_RUNNER_ROOT=${rootDir}\n`, "utf8");
    await assert.rejects(
      execFileAsync(process.execPath, [CLI, "install", "--env-file", envFile, "--cleanup-timer", "--unit-dir", unitDir], { env: childEnv, timeout: 60_000 }),
      (error: { stderr?: string }) => /--cleanup-timer needs --ttl/.test(error.stderr ?? ""),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
