// #2554: `images` CLI wiring of imagesEnvFiles — every --env-file and A2A_DOCKER_RUNNER_ENV_FILE are
// live env files; the first --env-file, else A2A_DOCKER_RUNNER_ENV_FILE, supplies the CLI settings.
// No real engine runs: a fake `docker` / `podman` on PATH answers the inventory calls (dry-run only).
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("./cli.js", import.meta.url));
// The fake engine must be executable: the OS tmpdir may be mounted noexec, so the fixture lives
// in the package's git-ignored tmp/ directory instead.
const FIXTURE_ROOT = fileURLToPath(new URL("../tmp/", import.meta.url));
const R = "a2a-docker-runner-claude";
const DAY = 86_400_000;

interface ImagesOutput {
  mode: string;
  engine: string;
  evidence: { configured: Array<{ ref: string; source: string; file?: string }> };
  plan: { repositories: Array<{ keep: Array<{ tag: string; reason?: string }> }>; candidates: Array<{ tag: string }> };
}

interface Fixture {
  dir: string;
  envDir: string;
  bin: string;
  callLog: string;
  file: (name: string, body: string) => Promise<string>;
}

/** Fake engine CLI: answers `image ls|inspect`, `ps`, `container inspect`, `info`; logs every call. */
function fakeEngineScript(callLog: string): string {
  const now = Date.now();
  const images = ["one", "two", "three", "old"].map((name, index) => ({
    id: `sha256:${name.padEnd(12, "0")}`,
    tags: [`${R}:${name}`],
    created: new Date(now - (10 + index * 5) * DAY).toISOString(),
  }));
  return `#!${process.execPath}
const { appendFileSync } = process.getBuiltinModule("node:fs");
const { basename } = process.getBuiltinModule("node:path");
const images = ${JSON.stringify(images)};
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callLog)}, JSON.stringify([basename(process.argv[1]), ...args]) + "\\n");
const [a, b] = args;
if (a === "image" && b === "ls") { process.stdout.write(images.map((img) => img.id).join("\\n") + "\\n"); process.exit(0); }
if (a === "image" && b === "inspect") {
  const withLastTag = args[3].includes("LastTagTime");
  process.stdout.write(images.map((img) => {
    const cols = [img.id, img.tags, [], img.created, 1024];
    if (withLastTag) cols.push("0001-01-01T00:00:00Z");
    return cols.map((col) => JSON.stringify(col)).join("\\t");
  }).join("\\n") + "\\n");
  process.exit(0);
}
if (a === "ps") process.exit(0);
if (a === "info") { process.stdout.write("/var/lib/fake-engine\\n"); process.exit(0); }
process.stderr.write("unexpected " + args.join(" ") + "\\n");
process.exit(1);
`;
}

async function withFixture(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  await mkdir(FIXTURE_ROOT, { recursive: true });
  const dir = await mkdtemp(join(FIXTURE_ROOT, "a2a-images-cli-"));
  try {
    const envDir = join(dir, "env-dir"); // empty: env files are found only through the CLI wiring
    const bin = join(dir, "bin");
    const callLog = join(dir, "engine-calls.log");
    await mkdir(envDir);
    await mkdir(bin);
    const script = fakeEngineScript(callLog);
    for (const engine of ["docker", "podman"]) {
      await writeFile(join(bin, engine), script, "utf8");
      await chmod(join(bin, engine), 0o755);
    }
    const file = async (name: string, content: string): Promise<string> => {
      const path = join(dir, name);
      await writeFile(path, content, { mode: 0o600 });
      return path;
    };
    await body({ dir, envDir, bin, callLog, file });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Run `images` (dry-run) with the fake engine first on PATH and no inherited A2A_* settings. */
async function runImages(fixture: Fixture, args: string[], envVarFile?: string): Promise<{ report: ImagesOutput; calls: string[][] }> {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("A2A_")) env[key] = value;
  env.PATH = `${fixture.bin}${delimiter}${process.env.PATH ?? ""}`;
  if (envVarFile !== undefined) env.A2A_DOCKER_RUNNER_ENV_FILE = envVarFile;
  const { stdout } = await execFileAsync(process.execPath, [CLI, "images", "--env-dir", fixture.envDir, ...args], { env, timeout: 60_000 });
  const log = await readFile(fixture.callLog, "utf8").catch(() => "");
  const calls = log.split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
  return { report: JSON.parse(stdout) as ImagesOutput, calls };
}

const configuredFiles = (report: ImagesOutput): string[] => [...new Set(report.evidence.configured.map((ref) => ref.file ?? ""))].sort();
const reasonOf = (report: ImagesOutput, tag: string): string | undefined =>
  report.plan.repositories.flatMap((repo) => repo.keep).find((entry) => entry.tag === tag)?.reason;

test("#2554 images: repeated --env-file flags and A2A_DOCKER_RUNNER_ENV_FILE are all live env files", async () => {
  await withFixture(async (fixture) => {
    const first = await fixture.file("first.env", `A2A_DOCKER_RUNNER_IMAGE=${R}:one\n`);
    const second = await fixture.file("second.env", `A2A_DOCKER_RUNNER_IMAGE=${R}:two\n`);
    const fromVar = await fixture.file("from-var.env", `A2A_DOCKER_RUNNER_IMAGE=${R}:three\n`);
    // "--flag value" and "--flag=value" both repeat.
    const { report, calls } = await runImages(fixture, ["--env-file", first, `--env-file=${second}`], fromVar);
    assert.equal(report.mode, "dry-run");
    assert.deepEqual(configuredFiles(report), [first, fromVar, second].sort(), JSON.stringify(report.evidence.configured));
    for (const tag of [`${R}:one`, `${R}:two`, `${R}:three`]) assert.equal(reasonOf(report, tag), "in-use", tag);
    assert.ok(!report.plan.candidates.some((entry) => [`${R}:one`, `${R}:two`, `${R}:three`].includes(entry.tag)));
    // Dry-run: the fake engine only ever answered inventory calls.
    assert.ok(calls.length > 0, "the fake engine on PATH was used");
    assert.ok(!calls.some(([, a, b]) => (a === "image" && b === "rm") || a === "builder"), JSON.stringify(calls));
  });
});

test("#2554 images: the same file as --env-file and A2A_DOCKER_RUNNER_ENV_FILE is one live env file", async () => {
  await withFixture(async (fixture) => {
    const shared = await fixture.file("shared.env", `A2A_DOCKER_RUNNER_IMAGE=${R}:one\n`);
    const { report } = await runImages(fixture, ["--env-file", shared], shared);
    assert.deepEqual(report.evidence.configured.map((ref) => ref.file), [shared], JSON.stringify(report.evidence.configured));
  });
});

test("#2554 images: without --env-file, A2A_DOCKER_RUNNER_ENV_FILE is the settings file and live evidence", async () => {
  await withFixture(async (fixture) => {
    const fromVar = await fixture.file("from-var.env", `A2A_DOCKER_RUNNER_ENGINE=podman\nA2A_DOCKER_RUNNER_IMAGE=${R}:three\n`);
    const { report, calls } = await runImages(fixture, [], fromVar);
    assert.equal(report.engine, "podman", "the engine setting comes from A2A_DOCKER_RUNNER_ENV_FILE");
    assert.ok(calls.length > 0 && calls.every(([engine]) => engine === "podman"), JSON.stringify(calls));
    assert.deepEqual(configuredFiles(report), [fromVar]);
    assert.equal(reasonOf(report, `${R}:three`), "in-use");
  });
});

test("#2554 images: the first --env-file supplies settings; A2A_DOCKER_RUNNER_ENV_FILE stays live evidence only", async () => {
  await withFixture(async (fixture) => {
    const first = await fixture.file("first.env", `A2A_DOCKER_RUNNER_ENGINE=docker\nA2A_DOCKER_RUNNER_IMAGE=${R}:one\n`);
    const second = await fixture.file("second.env", `A2A_DOCKER_RUNNER_ENGINE=podman\nA2A_DOCKER_RUNNER_IMAGE=${R}:two\n`);
    const fromVar = await fixture.file("from-var.env", `A2A_DOCKER_RUNNER_ENGINE=podman\nA2A_DOCKER_RUNNER_IMAGE=${R}:three\n`);
    const { report, calls } = await runImages(fixture, ["--env-file", first, "--env-file", second], fromVar);
    assert.equal(report.engine, "docker", "settings come from the first --env-file, not the second or the env var's file");
    assert.ok(calls.length > 0 && calls.every(([engine]) => engine === "docker"), JSON.stringify(calls));
    assert.deepEqual(configuredFiles(report), [first, fromVar, second].sort());
    assert.equal(reasonOf(report, `${R}:three`), "in-use");

    // Flag order decides: the other file first switches the settings to it.
    const swapped = await runImages(fixture, ["--env-file", second, "--env-file", first], fromVar);
    assert.equal(swapped.report.engine, "podman");
    assert.deepEqual(configuredFiles(swapped.report), [first, fromVar, second].sort());
  });
});
