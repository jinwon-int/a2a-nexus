#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { DEFAULT_SERVICE_ENV_FILE, loadConfig, mergeRunnerEnvFile, resolveRootDir } from "./config.js";
import { runEngineSmokeFixture } from "./engine-smoke.js";
import { checkServiceEnvFile, cleanup, doctor, install } from "./ops.js";
import { runTask } from "./runner.js";
import type { RunnerTask } from "./types.js";

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "run") {
    const task = await readTask(arg);
    const config = await loadConfig();
    const result = await runTask(config, task);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  if (command === "smoke") {
    const config = await loadConfig();
    console.log(JSON.stringify(await runEngineSmokeFixture(config), null, 2));
    return;
  }

  if (command === "doctor") {
    // Pass the merged env (env file included) so doctor can tell an env-file-only
    // invalid A2A_CLAUDE_EFFORT apart from an unset one (#2238).
    const env = loadCliEnv({ A2A_DOCKER_RUNNER_SKIP_ENGINE_DETECT: "1" });
    const config = await loadConfig(env);
    // #2267: tell doctor which env file was read so it can flag a stale default.
    console.log(JSON.stringify(await doctor(config, { env, envFile: resolveCliEnvFile() }), null, 2));
    return;
  }

  if (command === "install" || command === "setup") {
    const config = await loadConfig(loadCliEnv({ A2A_DOCKER_RUNNER_SKIP_ENGINE_DETECT: "1" }));
    console.log(JSON.stringify(await install(config), null, 2));
    return;
  }

  if (command === "cleanup") {
    // #2267: cleanup needs only the task root. Going through loadConfig made it
    // fail on profile/mount validation (e.g. a stale default env file carrying a
    // hermes EXTRA_MOUNTS_JSON) that has nothing to do with pruning workDirs.
    const env = loadCliEnv();
    const envFile = resolveCliEnvFile();
    const rootDir = resolveRootDir(env, processFlag("--root"));
    const ttlMs = parseTtlMs(processFlag("--ttl", arg) ?? "24h");
    const dryRun = process.argv.includes("--dry-run");
    const envFileCheck = await checkServiceEnvFile({ envFile });
    if (envFileCheck.status !== "ok") {
      console.error(`warning: ${envFileCheck.message}`);
    }
    console.log(JSON.stringify(await cleanup({ rootDir, ttlMs, dryRun }), null, 2));
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

async function readTask(path?: string): Promise<RunnerTask> {
  const input = path && path !== "-" ? await readFile(path, "utf8") : await readStdin();
  return JSON.parse(input) as RunnerTask;
}

function parseTtlMs(value: string): number {
  const match = value.match(/^(\d+)(ms|s|m|h|d)?$/);
  if (!match) throw new Error(`invalid ttl: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return amount * multipliers[unit];
}

function processFlag(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0) {
    const value = process.argv[index + 1];
    return value?.startsWith("--") ? undefined : value;
  }
  return fallback?.startsWith("--") ? undefined : fallback;
}

/** Service env file the CLI reads: `--env-file` > `A2A_DOCKER_RUNNER_ENV_FILE` > default. */
function resolveCliEnvFile(): string {
  return processFlag("--env-file") ?? process.env.A2A_DOCKER_RUNNER_ENV_FILE ?? DEFAULT_SERVICE_ENV_FILE;
}

function loadCliEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return mergeRunnerEnvFile({ ...process.env, ...extra }, resolveCliEnvFile());
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
  });
}

function printHelp(): void {
  console.log(`a2a-docker-runner

Usage:
  a2a-docker-runner doctor [--env-file /etc/default/openclaw-a2a-worker]
  a2a-docker-runner smoke
  a2a-docker-runner install [--env-file /etc/default/openclaw-a2a-worker]
  a2a-docker-runner cleanup [--env-file /etc/default/a2a-hermes-worker] [--root /var/lib/openclaw-a2a/tasks] [--ttl 24h] [--dry-run]
    (cleanup reads only A2A_DOCKER_RUNNER_ROOT / --root; it does not validate the full runner config)
  a2a-docker-runner run <task.json>
  cat task.json | a2a-docker-runner run -
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
