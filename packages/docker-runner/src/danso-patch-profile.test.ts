import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildDansoPatchCommandScript, loadConfig, normalizePatchCommandProfile } from "./config.js";
import { normalizeTask } from "./task-normalizer.js";

/**
 * danso patch profile (a2a-nexus#2315). Pure config/script tests plus one
 * executable harness that runs the rendered script against a fake `danso`
 * with the fixed container paths rewritten into a temp dir. No provider,
 * network, docker, or credential access.
 */

const baseEnv = { A2A_DOCKER_RUNNER_SKIP_ENGINE_DETECT: "1" };
const trustedDanso = {
  ...baseEnv,
  A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "danso",
  A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
};
const MAX_ARG_STRLEN = 128 * 1024;
const FULL_HELP = "Usage: danso [OPTIONS] --session <SESSION> [PROMPT]\n  --prompt-file <PATH>\n  --system-context-file <FILE>\n  --tool-home <TOOL_HOME>\n  --sandbox <SANDBOX>\n";

test("danso profile name normalizes; unknown profiles are still rejected", () => {
  assert.equal(normalizePatchCommandProfile("danso"), "danso");
  assert.equal(normalizePatchCommandProfile(" DANSO "), "danso");
  assert.equal(normalizePatchCommandProfile("danso_cli"), "danso");
  assert.throws(() => normalizePatchCommandProfile("dansoo"), /unsupported A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: dansoo/);
  assert.throws(() => normalizePatchCommandProfile("unknown-harness"), /unsupported/);
});

test("danso profile defaults: bridge network, read-only /run/secrets/danso-dir mount, rendered script", async () => {
  const config = await loadConfig({ ...trustedDanso, A2A_DOCKER_RUNNER_IMAGE: "a2a-docker-runner-danso:0.1.0-test" });

  assert.equal(config.commandProfile, "danso");
  assert.equal(config.network, "bridge");
  assert.deepEqual(config.dansoProfile, { configDir: "/var/lib/a2a-runner/danso-dir" });
  assert.deepEqual(config.extraMounts, [
    { source: "/var/lib/a2a-runner/danso-dir", target: "/run/secrets/danso-dir", readOnly: true },
  ]);
  assert.equal(config.containedSubagents?.enabled, false);
  assert.equal(config.piriProfile, undefined);

  const custom = await loadConfig({ ...trustedDanso, A2A_DOCKER_RUNNER_DANSO_CONFIG_DIR: "/srv/danso-glm" });
  assert.deepEqual(custom.extraMounts, [{ source: "/srv/danso-glm", target: "/run/secrets/danso-dir", readOnly: true }]);

  const untrusted = await loadConfig({ ...baseEnv, A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "danso" });
  assert.equal(untrusted.network, "none");
});

test("danso image family is inferred and mismatches are rejected both ways", async () => {
  const ok = await loadConfig({ ...trustedDanso, A2A_DOCKER_RUNNER_IMAGE: "ghcr.io/jinwon-int/a2a-docker-runner-danso@sha256:abc" });
  assert.equal(ok.commandProfile, "danso");

  await assert.rejects(
    () => loadConfig({ ...trustedDanso, A2A_DOCKER_RUNNER_IMAGE: "a2a-docker-runner-piri:v0.84.2-piri.1-cf2c218" }),
    /image\/profile mismatch.*piri runner image.*PROFILE=danso/,
  );
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "piri",
      A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
      A2A_DOCKER_RUNNER_IMAGE: "a2a-docker-runner-danso:0.1.0",
    }),
    /image\/profile mismatch.*danso runner image.*PROFILE=piri/,
  );
});

test("EXPECTED_PATCH_COMMAND_PROFILE pins the danso lane", async () => {
  const pinned = await loadConfig({ ...trustedDanso, A2A_DOCKER_RUNNER_EXPECTED_PATCH_COMMAND_PROFILE: "danso" });
  assert.equal(pinned.commandProfile, "danso");

  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_EXPECTED_PATCH_COMMAND_PROFILE: "danso",
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "piri",
      A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
    }),
    /EXPECTED_PATCH_COMMAND_PROFILE=danso requires A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=danso; got piri/,
  );
  await assert.rejects(
    () => loadConfig({ ...trustedDanso, A2A_DOCKER_RUNNER_EXPECTED_PATCH_COMMAND_PROFILE: "piri" }),
    /EXPECTED_PATCH_COMMAND_PROFILE=piri requires A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=piri; got danso/,
  );
});

test("danso explicit extra mounts must carry the danso config mount from the configured source", async () => {
  await assert.rejects(
    () => loadConfig({
      ...trustedDanso,
      A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([{ source: "/srv/scratch", target: "/scratch", readOnly: true }]),
    }),
    (error: Error & { code?: string }) => error.code === "profile_mount_missing" && /danso patch profile requires a \/run\/secrets\/danso-dir mount/.test(error.message),
  );
  await assert.rejects(
    () => loadConfig({
      ...trustedDanso,
      A2A_DOCKER_RUNNER_DANSO_CONFIG_DIR: "/srv/danso-glm",
      A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([{ source: "/srv/other", target: "/run/secrets/danso-dir", readOnly: true }]),
    }),
    (error: Error & { code?: string }) => error.code === "profile_mount_source_conflict",
  );
  const explicit = await loadConfig({
    ...trustedDanso,
    A2A_DOCKER_RUNNER_DANSO_CONFIG_DIR: "/srv/danso-glm",
    A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([{ source: "/srv/danso-glm", target: "/run/secrets/danso-dir", readOnly: true }]),
  });
  assert.equal(explicit.extraMounts?.[0]?.target, "/run/secrets/danso-dir");

  for (const [source, target] of [
    ["/srv/x", "/run/secrets/danso-dir"],
    ["/root/.config/danso", "/scratch"],
    ["/home/worker/.config/danso", "/scratch"],
    ["/root/.danso", "/scratch"],
  ]) {
    await assert.rejects(
      () => loadConfig({
        ...trustedDanso,
        A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
          { source: "/var/lib/a2a-runner/danso-dir", target: "/run/secrets/danso-dir", readOnly: true },
          { source, target, readOnly: false },
        ]),
      }),
      (error: Error & { code?: string }) => error.code === "forbidden_writable_runtime_mount",
      `${source} -> ${target} must not be mountable read-write`,
    );
  }
});

test("danso script passes the prompt as --prompt-file and never through argv", () => {
  const script = buildDansoPatchCommandScript({});
  assert.match(script, /--prompt-file \/work\/artifacts\/prompt\.md \\\n/);
  assert.match(script, /--system-context-file \/work\/artifacts\/danso-system-context\.md \\\n/);
  assert.doesNotMatch(script, /\$\(cat/);
  assert.doesNotMatch(script, /prompt\.md\)"/);
  assert.doesNotMatch(script, /\n\s*--\s*\\?\n/, "no `--` positional prompt separator");
  assert.match(script, /--sandbox host \\\n/);
  assert.match(script, /--provider glm \\\n/);
  assert.match(script, /--tool-home "\$A2A_DANSO_TOOL_HOME" \\\n/);
  assert.match(script, /A2A_LIFECYCLE_GUARD_BIN=\/work\/a2a-danso-lifecycle-guard-bin\n/);
  assert.match(script, /A2A_DANSO_TOOL_HOME=\/tmp\/danso-tool-home\n/);
  assert.match(script, /ln -s "\$A2A_LIFECYCLE_GUARD_BIN" "\$A2A_DANSO_TOOL_HOME\/\.cargo\/bin"/);
  assert.match(script, /add\|commit\|push\|checkout\|switch\|reset\|merge\|rebase\|tag\)/);
  assert.match(script, /"pr create"\|"pr merge"\|"issue close"\|"issue comment"\)/);
  assert.match(script, /lifecycle_guard=enabled profile=danso/);
  assert.match(script, /for a2a_danso_flag in --prompt-file --system-context-file --tool-home --sandbox; do/);
  assert.match(script, /A2A_DANSO_DEFAULT_MODEL='glm-5\.3-flash'/);
  assert.match(script, /A2A_DANSO_DEFAULT_TIMEOUT_SEC='3600'/);
  assert.match(script, /A2A_DANSO_DEFAULT_MAX_TURNS='128'/);
  const syntax = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("danso host-env defaults are validated at config load", () => {
  assert.throws(() => buildDansoPatchCommandScript({ A2A_DANSO_PATCH_TIMEOUT_SEC: "5400" }), /between 1 and 3600/);
  assert.throws(() => buildDansoPatchCommandScript({ A2A_DANSO_PATCH_TIMEOUT_SEC: "0" }), /between 1 and 3600/);
  assert.throws(() => buildDansoPatchCommandScript({ A2A_DANSO_PATCH_MAX_TURNS: "200" }), /between 1 and 128/);
  assert.throws(() => buildDansoPatchCommandScript({ A2A_DANSO_PATCH_MAX_TURNS: "abc" }), /between 1 and 128/);
  assert.throws(() => buildDansoPatchCommandScript({ A2A_DANSO_PROVIDER_TIMEOUT_SECONDS: "600" }), /between 1 and 300/);
  assert.throws(() => buildDansoPatchCommandScript({ A2A_DANSO_MAX_PROMPT_BYTES: "2000000" }), /between 1 and 1048576/);
  assert.match(buildDansoPatchCommandScript({}), /A2A_DANSO_DEFAULT_MAX_PROMPT_BYTES='65536'/);
  assert.match(buildDansoPatchCommandScript({}), /A2A_DANSO_DEFAULT_PROVIDER_TIMEOUT_SECONDS='300'/);
  const custom = buildDansoPatchCommandScript({ A2A_DANSO_MODEL: "glm-5.3", A2A_DANSO_EFFORT: "low", A2A_DANSO_PATCH_TIMEOUT_SEC: "1800", A2A_DANSO_PATCH_MAX_TURNS: "64" });
  assert.match(custom, /A2A_DANSO_DEFAULT_MODEL='glm-5\.3'/);
  assert.match(custom, /A2A_DANSO_DEFAULT_EFFORT='low'/);
  assert.match(custom, /A2A_DANSO_DEFAULT_TIMEOUT_SEC='1800'/);
  assert.match(custom, /A2A_DANSO_DEFAULT_MAX_TURNS='64'/);
});

test("task-level worker model/thinking reach the danso container env", () => {
  const task = normalizeTask({
    id: "danso-model",
    intent: "propose_patch",
    mode: "github-propose-patch",
    repo: "jinwon-int/test-repo",
    workerModel: "zai/glm-5.3-flash",
    workerThinking: "medium",
  });
  assert.equal(task.env?.A2A_DANSO_MODEL, "zai/glm-5.3-flash");
  assert.equal(task.env?.A2A_DANSO_EFFORT, "medium");
});

// ---------------------------------------------------------------------------
// Executable harness: the rendered script with its fixed container paths
// rewritten into a temp sandbox, run against a fake `danso`.
// ---------------------------------------------------------------------------

const FAKE_DANSO_RECORDER = `
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const toolHome = at("--tool-home");
const guard = (bin, args) => spawnSync(toolHome + "/.cargo/bin/" + bin, args, { encoding: "utf8" });
const promptFile = at("--prompt-file");
// Mirror real danso (src/context.rs): the system context must be an
// owner-only bounded regular file, otherwise exit 2 before any provider call.
const ctxPath = at("--system-context-file");
const ctx = ctxPath ? statSync(ctxPath) : undefined;
if (!ctx || !ctx.isFile() || (ctx.mode & 0o777) !== 0o600 || ctx.nlink !== 1 || ctx.size > 32768
    || (typeof process.geteuid === "function" && ctx.uid !== process.geteuid())) {
  process.stderr.write("system context requires an owner-only bounded regular file\\n");
  process.exit(2);
}
writeFileSync(process.env.FAKE_DANSO_RECORD, JSON.stringify({
  argv,
  argvMaxBytes: Math.max(...argv.map((a) => Buffer.byteLength(a))),
  argvTotalBytes: argv.reduce((n, a) => n + Buffer.byteLength(a) + 1, 0),
  promptFile,
  promptFileBytes: promptFile ? statSync(promptFile).size : -1,
  systemContext: readFileSync(at("--system-context-file"), "utf8"),
  systemContextMode: (statSync(at("--system-context-file")).mode & 0o777).toString(8),
  credentialMatches: process.env.ZAI_API_KEY === process.env.FAKE_EXPECTED_KEY,
  glmEndpoint: process.env.DANSO_GLM_ENDPOINT ?? null,
  unrelatedLeaked: process.env.UNRELATED_SECRET !== undefined,
  home: process.env.HOME,
  gitCommitGuard: guard("git", ["commit", "-m", "x"]).status,
  gitBranchGuard: guard("git", ["branch", "evil"]).status,
  ghPrCreateGuard: guard("gh", ["pr", "create"]).status,
}));
// Mirror real danso output modes (src/output.rs, src/cli.rs): -p conflicts
// with --progress-jsonl; -p prints only the final text; --progress-jsonl
// prints the JSONL transcript plus body-free frames with SORTED keys.
const print = argv.includes("-p") || argv.includes("--print");
const progressJsonl = argv.includes("--progress-jsonl");
if (print && progressJsonl) { process.stderr.write("error: -p conflicts with --progress-jsonl\\n"); process.exit(2); }
const finalText = '{"status":"done","summary":"ok","findings":[],"risks":[],"recommendations":[],"evidenceRefs":[]}';
const msg = (text) => JSON.stringify({ message: { content: [{ text, type: "text" }], role: "assistant" }, type: "message" });
if (progressJsonl) {
  process.stdout.write(JSON.stringify({ message: { content: [{ text: "SECRET-PROMPT-BODY", type: "text" }], role: "user" }, type: "message" }) + "\\n");
  if (argv.includes("--stream-requests")) process.stdout.write('{"elapsed_ms":5,"remaining":127,"sequence":1,"type":"danso_request","version":1}\\n');
  process.stdout.write('{"phase":"started","sequence":1,"tool":"bash","type":"danso_progress","version":1}\\n');
  process.stdout.write(JSON.stringify({ message: { content: [{ text: "TOOL-OUTPUT-BODY", type: "toolResult" }], role: "toolResult" }, type: "message" }) + "\\n");
  process.stdout.write('{"phase":"settled","sequence":1,"success":true,"tool":"bash","type":"danso_progress","version":1}\\n');
  process.stdout.write("not json at all\\n");
  process.stdout.write(msg("") + "\\n");
  process.stdout.write(msg(finalText) + "\\n");
} else {
  process.stdout.write(finalText + "\\n");
}
process.exit(Number(process.env.FAKE_DANSO_EXIT || "0"));
`;

interface HarnessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  summary: string;
  record?: Record<string, unknown>;
  progress: string;
  patchLog: string;
  transcriptLeft: boolean;
  root: string;
}

function runDansoScript(options: {
  prompt: string;
  help?: string;
  exitCode?: number;
  glmEnv?: string;
  scriptEnv?: Record<string, string>;
  runEnv?: Record<string, string>;
  taskJson?: Record<string, unknown>;
}): HarnessResult {
  const root = mkdtempSync(join(tmpdir(), "a2a-danso-profile-"));
  try {
    const work = join(root, "work");
    const artifacts = join(work, "artifacts");
    const repo = join(work, "repo");
    const secrets = join(root, "secrets", "danso-dir");
    const bin = join(root, "bin");
    for (const dir of [artifacts, repo, secrets, bin]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(artifacts, "prompt.md"), options.prompt);
    writeFileSync(join(artifacts, "summary.txt"), "");
    writeFileSync(join(work, "task.json"), JSON.stringify(options.taskJson ?? { mode: "github-propose-patch" }));
    writeFileSync(
      join(secrets, "glm.env"),
      options.glmEnv ?? "# fixture\nexport ZAI_API_KEY='fixture-zai-key-not-real'\nDANSO_GLM_ENDPOINT=coding\nUNRELATED_SECRET=nope\n",
    );
    writeFileSync(join(root, "recorder.mjs"), FAKE_DANSO_RECORDER);
    const fake = join(bin, "danso");
    writeFileSync(fake, [
      "#!/usr/bin/env bash",
      'if [ "${1:-}" = "--help" ]; then printf "%s" "$FAKE_DANSO_HELP"; exit 0; fi',
      'if [ "${1:-}" = "--version" ]; then echo "danso 0.1.0-fixture"; exit 0; fi',
      `exec "${process.execPath}" "${join(root, "recorder.mjs")}" "$@"`,
      "",
    ].join("\n"));
    chmodSync(fake, 0o755);

    const script = buildDansoPatchCommandScript(options.scriptEnv ?? {})
      .replaceAll("/run/secrets/danso-dir", secrets)
      .replaceAll("/tmp/danso-home", join(root, "danso-home"))
      .replaceAll("/tmp/danso-tool-home", join(root, "danso-tool-home"))
      .replaceAll("/work/", `${work}/`);
    const scriptPath = join(root, "patch-command.sh");
    writeFileSync(scriptPath, script, { mode: 0o700 });

    const recordPath = join(root, "record.json");
    // Run under the container's default umask (022), not the caller's: an
    // operator shell with umask 077 would hide a world-readable system context
    // that real danso refuses (a2a-nexus#2315 first real-binary canary).
    const result = spawnSync("bash", ["-c", 'umask 022; exec bash "$0"', scriptPath], {
      cwd: repo,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        FAKE_DANSO_HELP: options.help ?? FULL_HELP,
        FAKE_DANSO_RECORD: recordPath,
        FAKE_DANSO_EXIT: String(options.exitCode ?? 0),
        FAKE_EXPECTED_KEY: "fixture-zai-key-not-real",
        ...options.runEnv,
      },
    });
    const progressPath = join(artifacts, "danso-progress.jsonl");
    const patchLogPath = join(artifacts, "patch-command.log");
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      summary: readFileSync(join(artifacts, "summary.txt"), "utf8"),
      record: existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, "utf8")) : undefined,
      progress: existsSync(progressPath) ? readFileSync(progressPath, "utf8") : "",
      patchLog: existsSync(patchLogPath) ? readFileSync(patchLogPath, "utf8") : "",
      transcriptLeft: existsSync(join(work, ".a2a-danso-transcript.jsonl")),
      root,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a >128 KiB prompt reaches danso as a file, never as an argv element", () => {
  // danso itself caps prompts at 65,536 bytes today (jinwon-int/danso#207), so
  // the script's cap is raised here to prove the transport, not the cap.
  const prompt = `# Assignment\n${"x".repeat(200 * 1024)}\n`;
  const run = runDansoScript({ prompt, scriptEnv: { A2A_DANSO_MAX_PROMPT_BYTES: "1048576" } });

  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.record, "fake danso was invoked");
  const record = run.record as Record<string, unknown>;
  // danso refuses a system context that is not exactly 0600 (src/context.rs).
  assert.equal(record.systemContextMode, "600");
  assert.equal(record.promptFileBytes, Buffer.byteLength(prompt));
  assert.match(String(record.promptFile), /\/work\/artifacts\/prompt\.md$/);
  assert.ok((record.argvMaxBytes as number) < 1024, `largest argv element ${record.argvMaxBytes}B`);
  assert.ok((record.argvTotalBytes as number) < MAX_ARG_STRLEN);
  const argv = record.argv as string[];
  assert.ok(argv.every((arg) => !arg.includes("xxxxxxxx")), "prompt text must not appear in argv");
  for (const flag of ["--sandbox", "--provider", "--max-turns", "--timeout-seconds", "--provider-timeout-seconds", "--reasoning-effort"]) {
    assert.ok(argv.includes(flag), `missing ${flag}`);
  }
  assert.equal(argv[argv.indexOf("--sandbox") + 1], "host");
  assert.equal(argv[argv.indexOf("--model") + 1], "glm-5.3-flash");
  assert.match(String(record.systemContext), /Edit files only/);
  assert.match(run.summary, /prompt_transport=file path=.*\/work\/artifacts\/prompt\.md/);
  assert.match(run.summary, /danso_exit=0/);
});

test("glm.env: allowlisted keys reach danso, values are never printed, other keys are ignored", () => {
  const run = runDansoScript({ prompt: "fix it\n" });
  assert.equal(run.status, 0, run.stderr);
  const record = run.record as Record<string, unknown>;
  assert.equal(record.credentialMatches, true);
  assert.equal(record.glmEndpoint, "coding");
  assert.equal(record.unrelatedLeaked, false);
  assert.match(run.summary, /danso_credential=glm\.env keys=ZAI_API_KEY,DANSO_GLM_ENDPOINT\n/);
  for (const text of [run.stdout, run.stderr, run.summary]) {
    assert.doesNotMatch(text, /fixture-zai-key-not-real/);
  }

  const missing = runDansoScript({ prompt: "fix it\n", glmEnv: "DANSO_GLM_ENDPOINT=coding\n" });
  assert.equal(missing.status, 2);
  assert.match(missing.summary, /error=danso_glm_credential_missing/);
  assert.equal(missing.record, undefined);
});

test("lifecycle guard shims sit first on danso's rebuilt tool PATH", () => {
  const run = runDansoScript({ prompt: "fix it\n" });
  assert.equal(run.status, 0, run.stderr);
  const record = run.record as Record<string, unknown>;
  assert.equal(record.gitCommitGuard, 90);
  assert.equal(record.gitBranchGuard, 90);
  assert.equal(record.ghPrCreateGuard, 90);
  assert.match(String(record.home), /\/danso-home$/);
  assert.match(run.summary, /lifecycle_guard=enabled profile=danso/);
});

test("prompts over danso's 65,536-byte cap fail closed before danso runs", () => {
  const atCap = runDansoScript({ prompt: "y".repeat(65536) });
  assert.equal(atCap.status, 0, atCap.stderr);
  assert.ok(atCap.record, "a prompt exactly at the cap is passed to danso");
  assert.match(atCap.summary, /danso_prompt_bytes=65536 max=65536\n/);

  const over = runDansoScript({ prompt: "y".repeat(65537) });
  assert.equal(over.status, 2);
  assert.equal(over.record, undefined, "danso must not be invoked");
  assert.match(over.summary, /error=danso_prompt_too_large bytes=65537 max=65536\n/);
  assert.match(over.summary, /failure_category=danso_prompt_too_large\n/);
  assert.match(over.patchLog, /The task prompt is 65537 bytes; danso accepts at most 65536 bytes \(A2A_DANSO_MAX_PROMPT_BYTES\)/);
  assert.doesNotMatch(over.summary + over.patchLog, /yyyyyyyy/, "the prompt body is never echoed");

  // The cap is an env knob (host default baked at render time, container env wins).
  const raisedByHost = runDansoScript({ prompt: "y".repeat(65537), scriptEnv: { A2A_DANSO_MAX_PROMPT_BYTES: "70000" } });
  assert.equal(raisedByHost.status, 0, raisedByHost.stderr);
  const loweredInContainer = runDansoScript({ prompt: "y".repeat(2048), runEnv: { A2A_DANSO_MAX_PROMPT_BYTES: "1024" } });
  assert.equal(loweredInContainer.status, 2);
  assert.match(loweredInContainer.summary, /error=danso_prompt_too_large bytes=2048 max=1024\n/);

  const empty = runDansoScript({ prompt: "" });
  assert.equal(empty.status, 2);
  assert.equal(empty.record, undefined);
  assert.match(empty.summary, /error=danso_prompt_empty\n/);
});

test("a danso build without --prompt-file fails closed before any run (no argv fallback)", () => {
  const run = runDansoScript({
    prompt: "fix it\n",
    help: "Usage: danso [OPTIONS] --session <SESSION> [PROMPT]\n  --system-context-file <FILE>\n  --tool-home <TOOL_HOME>\n  --sandbox <SANDBOX>\n",
  });
  assert.equal(run.status, 2);
  assert.equal(run.record, undefined, "danso must not be invoked for the task");
  assert.match(run.summary, /error=danso_cli_flag_unsupported flag=--prompt-file/);
  assert.match(run.summary, /failure_category=danso_cli_upgrade_required/);
});

test("danso exit codes map onto failure categories and propagate", () => {
  for (const [code, category] of [[2, "danso_invocation_invalid"], [3, "danso_provider_failure"], [124, "danso_timeout"], [7, "danso_runtime_failure"]] as const) {
    const run = runDansoScript({ prompt: "fix it\n", exitCode: code });
    assert.equal(run.status, code);
    assert.match(run.summary, new RegExp(`danso_exit=${code}\\n`));
    assert.match(run.summary, new RegExp(`failure_category=${category}`));
  }
});

test("progress file gets body-free tool/request frames from --progress-jsonl; final answer stays on stdout; transcript is not kept", () => {
  const run = runDansoScript({ prompt: "fix it\n" });
  assert.equal(run.status, 0, run.stderr);
  const argv = (run.record as Record<string, unknown>).argv as string[];
  assert.ok(argv.includes("--progress-jsonl") && argv.includes("--stream-requests"));
  assert.ok(!argv.includes("-p"), "-p conflicts with --progress-jsonl in real danso");
  const frames = run.progress.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(frames.map((frame) => `${frame.type}:${frame.phase ?? ""}`), [
    "danso_request:",
    "danso_progress:started",
    "danso_progress:settled",
  ]);
  assert.doesNotMatch(run.progress, /SECRET-PROMPT-BODY|TOOL-OUTPUT-BODY|"message"/);
  assert.match(run.stdout, /\{"status":"done","summary":"ok"/);
  assert.doesNotMatch(run.stdout, /SECRET-PROMPT-BODY|TOOL-OUTPUT-BODY/);
  assert.match(run.summary, /danso_progress_frames=3/);
  assert.equal(run.transcriptLeft, false, "transcript scratch file removed");
});

test("model ids normalize to bare GLM ids; non-GLM models and bad efforts fail closed", () => {
  const prefixed = runDansoScript({ prompt: "x\n", scriptEnv: { A2A_DANSO_MODEL: "zai/glm-5.3[1m]", A2A_DANSO_EFFORT: "off" } });
  assert.equal(prefixed.status, 0, prefixed.stderr);
  const argv = (prefixed.record as Record<string, unknown>).argv as string[];
  assert.equal(argv[argv.indexOf("--model") + 1], "glm-5.3");
  assert.equal(argv[argv.indexOf("--reasoning-effort") + 1], "none");

  const adaptive = runDansoScript({ prompt: "x\n", scriptEnv: { A2A_DANSO_EFFORT: "adaptive" } });
  assert.equal(adaptive.status, 0, adaptive.stderr);
  assert.ok(!((adaptive.record as Record<string, unknown>).argv as string[]).includes("--reasoning-effort"));

  const gpt = runDansoScript({ prompt: "x\n", scriptEnv: { A2A_DANSO_MODEL: "openai-codex/gpt-5.6-sol" } });
  assert.equal(gpt.status, 2);
  assert.match(gpt.summary, /error=danso_model_unsupported/);
  assert.equal(gpt.record, undefined);

  const effort = runDansoScript({ prompt: "x\n", scriptEnv: { A2A_DANSO_EFFORT: "ultra" } });
  assert.equal(effort.status, 2);
  assert.match(effort.summary, /error=danso_effort_invalid/);
});

test("read-only validation tasks get the read-only system context", () => {
  const run = runDansoScript({ prompt: "check\n", taskJson: { mode: "github-read-only-validation", readOnlyValidation: true } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(String((run.record as Record<string, unknown>).systemContext), /READ-ONLY validation\/analysis task/);
  assert.match(run.summary, /read_only=1/);
});
