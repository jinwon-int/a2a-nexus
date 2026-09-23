import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("./cli.js", import.meta.url));

interface DoctorOutput {
  githubPatch: { detail: { claudeEffort?: { configured: string | null; source: string } } };
}

/** Run the built CLI doctor with A2A_CLAUDE_EFFORT present only in the env file. */
async function runDoctor(envFileBody: string): Promise<DoctorOutput> {
  const dir = await mkdtemp(`${tmpdir()}/a2a-doctor-cli-`);
  try {
    const envFile = `${dir}/runner.env`;
    await writeFile(envFile, envFileBody, "utf8");
    // Reproduce the deployment shape: the service env file carries the value,
    // the process env does not. mergeRunnerEnvFile lets process env win, so the
    // child must not inherit A2A_CLAUDE_EFFORT for the value to be file-only.
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv.A2A_CLAUDE_EFFORT;
    const { stdout } = await execFileAsync(process.execPath, [CLI, "doctor", "--env-file", envFile], {
      env: childEnv,
      timeout: 120_000,
    });
    return JSON.parse(stdout) as DoctorOutput;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("#2238 doctor reports an env-file-only invalid A2A_CLAUDE_EFFORT as invalid", async () => {
  const report = await runDoctor("A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=claude-code\nA2A_CLAUDE_EFFORT=extreme\n");
  assert.deepEqual(
    report.githubPatch.detail.claudeEffort,
    { configured: null, source: "invalid" },
    JSON.stringify(report.githubPatch.detail),
  );
});

test("#2238 doctor projects an env-file-only valid A2A_CLAUDE_EFFORT", async () => {
  const report = await runDoctor("A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=claude-code\nA2A_CLAUDE_EFFORT=medium\n");
  assert.deepEqual(
    report.githubPatch.detail.claudeEffort,
    { configured: "medium", source: "A2A_CLAUDE_EFFORT" },
    JSON.stringify(report.githubPatch.detail),
  );
});
