import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("./cli.js", import.meta.url));
const DAY = 86_400_000;

interface RotationOutput {
  dryRun: boolean;
  total: number;
  retained: string[];
  pruned: string[];
  broadPerms: string[];
}
interface CreateOutput {
  backup: string;
  rotation: RotationOutput;
}
interface DoctorOutput {
  serviceEnvBackups: { status: string; message: string };
}

async function fixture(): Promise<{ dir: string; envFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), "a2a-env-backups-cli-"));
  const envFile = join(dir, "runner.env");
  await writeFile(envFile, "A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=claude-code\n", { mode: 0o600 });
  for (let i = 1; i <= 8; i += 1) {
    const path = join(dir, `runner.env.bak-old-${i}`);
    await writeFile(path, "SECRET=x\n", { mode: 0o600 });
    await chmod(path, 0o600);
    const t = new Date(Date.now() - i * 20 * DAY); // 20d … 160d old
    await utimes(path, t, t);
  }
  return { dir, envFile };
}

function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.A2A_DOCKER_RUNNER_ENV_FILE;
  return execFileAsync(process.execPath, [CLI, ...args], { env, timeout: 60_000 });
}

test("#2268 env-backups is dry-run by default, --prune deletes per plan, --create adds a 0600 copy", async () => {
  const { envFile } = await fixture();
  try {
    const dry = JSON.parse((await run(["env-backups", "--env-file", envFile, "--keep", "3", "--max-age", "30d"])).stdout) as RotationOutput;
    assert.equal(dry.dryRun, true);
    assert.equal(dry.total, 8);
    // keep newest 3 (20d,40d,60d); of the rest (80d…160d) all are > 30d → 5 pruned
    assert.equal(dry.pruned.length, 5);
    for (const path of dry.pruned) await stat(path);

    const pruned = JSON.parse((await run(["env-backups", "--env-file", envFile, "--keep", "3", "--max-age", "30d", "--prune"])).stdout) as RotationOutput;
    assert.equal(pruned.dryRun, false);
    assert.deepEqual(pruned.pruned, dry.pruned);
    for (const path of pruned.pruned) await assert.rejects(stat(path));

    const created = JSON.parse((await run(["env-backups", "--env-file", envFile, "--create", "pr-2268", "--keep", "3", "--max-age", "0", "--prune"])).stdout) as CreateOutput;
    assert.match(created.backup, /runner\.env\.bak-pr-2268-\d{8}T\d{6}Z$/);
    assert.equal((await stat(created.backup)).mode & 0o777, 0o600);
    assert.equal(created.rotation.total, 4); // 3 survivors + the new copy
    assert.equal(created.rotation.pruned.length, 1); // keep 3, max-age 0 → oldest survivor pruned
    assert.ok(created.rotation.retained.includes(created.backup));
  } finally {
    await rm(envFile.replace(/\/runner\.env$/, ""), { recursive: true, force: true });
  }
});

test("#2268 env-backups rejects a bad --keep and a --create without tag", async () => {
  const { dir, envFile } = await fixture();
  try {
    await assert.rejects(run(["env-backups", "--env-file", envFile, "--keep", "-1"]), (e: { stderr?: string }) => /invalid --keep/.test(e.stderr ?? ""));
    await assert.rejects(run(["env-backups", "--env-file", envFile, "--create"]), (e: { stderr?: string }) => /--create needs a <tag>/.test(e.stderr ?? ""));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#2268 doctor reports serviceEnvBackups for the env file it read", async () => {
  const { dir, envFile } = await fixture();
  try {
    const { stdout } = await run(["doctor", "--env-file", envFile]);
    const report = JSON.parse(stdout) as DoctorOutput;
    assert.equal(report.serviceEnvBackups.status, "warn", report.serviceEnvBackups.message);
    assert.match(report.serviceEnvBackups.message, /8 service env backups \(> 5\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
