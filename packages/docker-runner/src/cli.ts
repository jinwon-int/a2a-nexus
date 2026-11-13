#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SERVICE_ENV_FILE,
  WORKDIR_TTL_ENV,
  loadConfig,
  mergeRunnerEnvFile,
  parseTtlMs,
  resolveRootDir,
  resolveWorkdirTtl,
} from "./config.js";
import { runEngineSmokeFixture } from "./engine-smoke.js";
import {
  backupServiceEnvFile,
  checkRunEnvParity,
  checkServiceEnvFile,
  cleanup,
  doctor,
  install,
  installCleanupTimer,
  rotateServiceEnvBackups,
} from "./ops.js";
import {
  DEFAULT_ENV_DIR,
  DEFAULT_KEEP_ROLLBACK,
  DEFAULT_MIN_AGE_MS,
  DEPLOY_RECORD_DIRS_ENV,
  imagesEnvFiles,
  parseImagesArgs,
  pruneRunnerImages,
} from "./runner-images.js";
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
    const config = await loadConfig(env).catch((error: unknown) => {
      // #2398: a config error caused by an env-file-only key never affects `run`
      // (process env only); say so instead of reporting a runner-wide failure.
      throw new Error(withRunEnvParityNote(error, resolveCliEnvFile()));
    });
    // #2267: tell doctor which env file was read so it can flag a stale default.
    // #2398: `run` uses process.env only — pass it so doctor can flag env-file-only keys.
    console.log(JSON.stringify(await doctor(config, { env, envFile: resolveCliEnvFile(), processEnv: process.env }), null, 2));
    return;
  }

  if (command === "install" || command === "setup") {
    const env = loadCliEnv({ A2A_DOCKER_RUNNER_SKIP_ENGINE_DETECT: "1" });
    const config = await loadConfig(env);
    // #2395: --egress creates the internal network + proxy container
    // (A2A_DOCKER_RUNNER_EGRESS_MODE must be observe/enforce); --dry-run with
    // --egress prints the engine commands without running them.
    const report = await install(config, {
      egress: process.argv.includes("--egress"),
      egressOptions: { dryRun: process.argv.includes("--dry-run") },
    });
    if (report.egress && !report.egress.ok) process.exitCode = 1;
    // #2267 R2: opt-in periodic cleanup. Writes unit files only; enabling the
    // timer stays an explicit operator step (see report.cleanupTimer.nextSteps).
    if (process.argv.includes("--cleanup-timer")) {
      const ttl = processFlag("--ttl") ?? resolveWorkdirTtl(env)?.raw;
      if (!ttl) throw new Error(`--cleanup-timer needs --ttl <ttl> or ${WORKDIR_TTL_ENV} in the env file`);
      const cleanupTimer = await installCleanupTimer({
        cliPath: fileURLToPath(import.meta.url),
        envFile: resolveCliEnvFile(),
        ttl,
        unitDir: processFlag("--unit-dir"),
      });
      console.log(JSON.stringify({ ...report, cleanupTimer }, null, 2));
      return;
    }
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (command === "cleanup") {
    // #2267: cleanup needs only the task root. Going through loadConfig made it
    // fail on profile/mount validation (e.g. a stale default env file carrying a
    // hermes EXTRA_MOUNTS_JSON) that has nothing to do with pruning workDirs.
    const env = loadCliEnv();
    const envFile = resolveCliEnvFile();
    const rootDir = resolveRootDir(env, processFlag("--root"));
    // TTL precedence: --ttl > A2A_DOCKER_RUNNER_WORKDIR_TTL (env file) > 24h legacy default.
    const ttlMs = parseTtlMs(processFlag("--ttl", arg) ?? resolveWorkdirTtl(env)?.raw ?? "24h");
    const dryRun = process.argv.includes("--dry-run");
    const envFileCheck = await checkServiceEnvFile({ envFile });
    if (envFileCheck.status !== "ok") {
      console.error(`warning: ${envFileCheck.message}`);
    }
    console.log(JSON.stringify(await cleanup({ rootDir, ttlMs, dryRun }), null, 2));
    return;
  }

  if (command === "env-backups") {
    // #2268: inventory/rotate the secret-bearing `<envFile>.*` backup copies.
    // Dry-run unless --prune; --create <tag> takes a fresh 0600 backup first.
    const envFile = resolveCliEnvFile();
    const keepFlag = processFlag("--keep");
    const keep = keepFlag === undefined ? undefined : Number(keepFlag);
    if (keep !== undefined && (!Number.isInteger(keep) || keep < 0)) throw new Error(`invalid --keep: ${keepFlag}`);
    const maxAgeFlag = processFlag("--max-age");
    const maxAgeMs = maxAgeFlag === undefined ? undefined : parseTtlMs(maxAgeFlag);
    const dryRun = !process.argv.includes("--prune");
    const tag = processFlag("--create");
    if (process.argv.includes("--create") && !tag) throw new Error("--create needs a <tag>");
    const result = tag
      ? await backupServiceEnvFile({ envFile, tag, keep, maxAgeMs, dryRun })
      : await rotateServiceEnvBackups({ envFile, keep, maxAgeMs, dryRun });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "images") {
    // #2547: runner image retention. Dry-run unless --apply; never touches
    // images outside the a2a-docker-runner* repositories. Strict argument
    // parsing: a mistyped or value-less flag is an error, never ignored.
    const args = parseImagesArgs(process.argv.slice(3));
    const single = (name: string): string | undefined => {
      const list = args.values[name] ?? [];
      if (list.length > 1) throw new Error(`images: ${name} given more than once`);
      return list[0];
    };
    // --env-file may repeat (several workers with env files outside --env-dir). Every --env-file and
    // A2A_DOCKER_RUNNER_ENV_FILE is live evidence (#2554: a flag no longer hides the env var's file);
    // the first --env-file, else A2A_DOCKER_RUNNER_ENV_FILE, supplies CLI settings.
    const { live: explicitEnvFiles, settings } = imagesEnvFiles(args.values["--env-file"] ?? [], process.env.A2A_DOCKER_RUNNER_ENV_FILE);
    const envFile = settings ?? DEFAULT_SERVICE_ENV_FILE;
    const env = mergeRunnerEnvFile({ ...process.env }, envFile);
    const engineFlag = single("--engine") ?? env.A2A_DOCKER_RUNNER_ENGINE ?? "docker";
    if (engineFlag !== "docker" && engineFlag !== "podman") throw new Error(`invalid --engine: ${engineFlag}`);
    const keepRollbackFlag = single("--keep-rollback");
    const keepRollback = keepRollbackFlag === undefined ? DEFAULT_KEEP_ROLLBACK : Number(keepRollbackFlag);
    if (!Number.isInteger(keepRollback) || keepRollback < 0) throw new Error(`invalid --keep-rollback: ${keepRollbackFlag}`);
    const keepNewerFlag = single("--keep-newer");
    const keepNewer = keepNewerFlag === undefined ? undefined : Number(keepNewerFlag);
    if (keepNewer !== undefined && (!Number.isInteger(keepNewer) || keepNewer < 0)) throw new Error(`invalid --keep-newer: ${keepNewerFlag}`);
    const minAgeFlag = single("--min-age");
    const minAgeMs = minAgeFlag === undefined ? DEFAULT_MIN_AGE_MS : minAgeFlag === "0" ? 0 : parseTtlMs(minAgeFlag);
    const deployRecordDirs = [
      ...(args.values["--deploy-record-dir"] ?? []),
      ...(env[DEPLOY_RECORD_DIRS_ENV] ?? "").split(":").map((dir) => dir.trim()).filter(Boolean),
    ];
    const report = await pruneRunnerImages({
      engine: engineFlag,
      apply: args.apply,
      builderCache: args.builderCache,
      keepRollback,
      keepNewer,
      includeNewer: args.includeNewer,
      minAgeMs,
      keepRefs: args.values["--keep"] ?? [],
      allowRepositories: args.values["--repository"] ?? [],
      envDir: single("--env-dir") ?? DEFAULT_ENV_DIR,
      deployRecordDirs,
      // An env file the operator named is live evidence wherever it lives (the stale CLI default is not).
      extraLiveFiles: explicitEnvFiles,
      isRoot: typeof process.getuid === "function" ? process.getuid() === 0 : undefined,
    });
    console.log(JSON.stringify(report, null, 2));
    if (report.mode === "apply" && !report.plan.applyAllowed) process.exitCode = 2;
    else if (!report.ok) process.exitCode = 1;
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

async function readTask(path?: string): Promise<RunnerTask> {
  const input = path && path !== "-" ? await readFile(path, "utf8") : await readStdin();
  return JSON.parse(input) as RunnerTask;
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

function withRunEnvParityNote(error: unknown, envFile: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const parity = checkRunEnvParity({ envFile, processEnv: process.env });
  if (parity.status !== "warn") return message;
  const keys = (parity.detail?.fileOnlyRunnerKeys as string[] | undefined) ?? [];
  return `${message}\n(doctor merged ${envFile}; these A2A_* keys come only from that file and are NOT seen by \`run\`, which uses the process env only: ${keys.join(", ")})`;
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
  a2a-docker-runner install [--env-file /etc/default/a2a-hermes-worker] [--cleanup-timer [--ttl 14d] [--unit-dir /etc/systemd/system]]
    (--cleanup-timer writes <unit>.service/.timer for a daily cleanup; TTL from --ttl or A2A_DOCKER_RUNNER_WORKDIR_TTL;
     enabling the timer is left to the operator — see cleanupTimer.nextSteps in the output)
  a2a-docker-runner install --egress [--dry-run] [--env-file /etc/default/a2a-hermes-worker]
    (#2395: needs A2A_DOCKER_RUNNER_EGRESS_MODE=observe|enforce; creates the --internal network and (re)creates the
     labelled allowlist proxy container, then checks readiness; recreating drops open tunnels — run with no task in flight)
  a2a-docker-runner cleanup [--env-file /etc/default/a2a-hermes-worker] [--root /var/lib/openclaw-a2a/tasks] [--ttl 24h] [--dry-run]
    (cleanup reads only A2A_DOCKER_RUNNER_ROOT / --root; it does not validate the full runner config;
     TTL precedence: --ttl > A2A_DOCKER_RUNNER_WORKDIR_TTL > 24h)
  a2a-docker-runner env-backups [--env-file /etc/default/a2a-hermes-worker] [--keep 5] [--max-age 30d] [--prune] [--create <tag>]
    (lists <env-file>.* backup copies and the rotation plan: keep the newest --keep, prune the rest older than
     --max-age (0 = all beyond --keep). Dry-run unless --prune. --create <tag> first copies the live file to
     <env-file>.bak-<tag>-<UTC stamp> with mode 0600 — the helper deploy scripts should use)
  a2a-docker-runner images [--apply] [--keep-rollback 1] [--keep-newer 1] [--include-newer] [--min-age 72h]
                           [--keep <image-ref>]... [--repository <repo>]... [--builder-cache] [--engine docker|podman]
                           [--env-dir /etc/default] [--env-file <file>]...
                           [--deploy-record-dir <dir>]...
    (#2547: lists a2a-docker-runner* image tags to remove. Keeps the image(s) in use — running worker env
     (/proc/<pid>/environ) and its systemd EnvironmentFile, env files in --env-dir, any container incl. stopped,
     --keep — plus --keep-rollback per worker (its own newest backup, incl. next to an env file outside
     --env-dir; then --deploy-record-dir / ${DEPLOY_RECORD_DIRS_ENV}; else the newest image built before that
     worker's image), tags named *rollback*, images built or loaded within --min-age, and --keep-newer images
     built after the in-use one (more are listed in plan.newerToReview and only removed with --include-newer).
     Every --env-file and A2A_DOCKER_RUNNER_ENV_FILE counts as a live env file (the first --env-file, else
     A2A_DOCKER_RUNNER_ENV_FILE, supplies CLI settings). Flags take
     "--flag value" or "--flag=value"; an unknown or value-less flag is an error.
     A runner repository that no running process or live env file uses is left alone unless named with
     --repository (containers and --keep protect their images but do not open a repository).
     Other images are never touched. Dry-run unless --apply; --apply re-plans, re-checks each tag's id, uses
     "image rm" without -f, and is refused (exit 2) when an in-use/--keep ref does not resolve, /proc is not fully
     readable, or there is no in-use evidence. --builder-cache adds "docker builder prune -f --filter until=<min-age>"
     (the engine's whole build cache older than that, not only runner builds).)
  a2a-docker-runner run <task.json>
  cat task.json | a2a-docker-runner run -
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
