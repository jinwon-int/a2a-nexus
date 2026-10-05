import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "./config.js";

/**
 * a2a-nexus#2314: patch profiles must not put the whole prompt into one argv
 * string. Linux caps a single argv element at MAX_ARG_STRLEN (131072 bytes
 * including the NUL), so `--message "$PROMPT"` fails with E2BIG before the CLI
 * starts. The claude-code profile hands the assignment to the bridge as a file
 * when the bridge baked into the image supports it, and fails before exec with
 * a named error otherwise. hermes/openclaw (no file input) fail before exec.
 *
 * The executable harness rewrites the fixed container paths into a temp dir and
 * runs the rendered script against a fake `claude` CLI and a fake bridge. No
 * provider, network, docker, or credential access.
 */

const MAX_ARG_STRLEN = 128 * 1024;
const LARGE_PROMPT = `# Assignment\n${"x".repeat(200 * 1024)}\n`;
const SMALL_PROMPT = "# Assignment\nFix the README typo.\n";
const TASK = { repo: "jinwon-int/example", issue: "42", issueUrl: "https://github.com/jinwon-int/example/issues/42" };
const HEADER = `GitHub development assignment\nRepository: ${TASK.repo}\nIssue: ${TASK.issue}\nIssue URL: ${TASK.issueUrl}\n\n`;

const FAKE_BRIDGE_RECORDER = `
import { readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const file = at("--message-file");
writeFileSync(process.env.FAKE_BRIDGE_RECORD, JSON.stringify({
  argv: argv.map((a) => (a.length > 256 ? "<" + Buffer.byteLength(a) + " bytes>" : a)),
  argvMaxBytes: Math.max(...argv.map((a) => Buffer.byteLength(a))),
  argvTotalBytes: argv.reduce((n, a) => n + Buffer.byteLength(a) + 1, 0),
  messageFile: file ?? null,
  message: file ? readFileSync(file, "utf8") : (at("--message") ?? null),
}));
process.stdout.write('{"payloads":[{"text":"{}"}]}\\n');
`;

interface HarnessResult {
  status: number | null;
  stderr: string;
  summary: string;
  patchLog: string;
  record?: { argv: string[]; argvMaxBytes: number; argvTotalBytes: number; messageFile: string | null; message: string | null };
}

async function runClaudeCodeScript(options: { prompt: string; bridgeSupportsMessageFile: boolean }): Promise<HarnessResult> {
  const root = mkdtempSync(join(tmpdir(), "a2a-claude-code-profile-"));
  try {
    const work = join(root, "work");
    const artifacts = join(work, "artifacts");
    const repo = join(work, "repo");
    const secrets = join(root, "secrets");
    const claudeDir = join(secrets, "claude-dir");
    const bin = join(root, "bin");
    const tmp = join(root, "tmp");
    for (const dir of [artifacts, repo, claudeDir, bin, tmp]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(artifacts, "prompt.md"), options.prompt);
    writeFileSync(join(artifacts, "summary.txt"), "");
    writeFileSync(join(artifacts, "task.json"), JSON.stringify(TASK));

    const fakeClaude = join(bin, "claude");
    writeFileSync(fakeClaude, '#!/usr/bin/env bash\necho "2.1.280 (Claude Code)"\n');
    chmodSync(fakeClaude, 0o755);

    const bridgePath = join(root, "claude-a2a-patch-bridge.mjs");
    const marker = options.bridgeSupportsMessageFile ? "// a2a-bridge-capability: message-file\n" : "";
    writeFileSync(bridgePath, marker + FAKE_BRIDGE_RECORDER);

    const config = await loadConfig({
      A2A_DOCKER_RUNNER_SKIP_ENGINE_DETECT: "1",
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "claude-code",
      A2A_CLAUDE_PATCH_BRIDGE: bridgePath,
    });
    // Rewrite only the fixed container /tmp paths: the sandbox root (and the
    // fake bridge path) also live under the host tmpdir.
    const script = String(config.commandScript)
      .replaceAll("/tmp/claude-home", `${tmp}/claude-home`)
      .replaceAll("/tmp/claude-assignment.md", `${tmp}/claude-assignment.md`)
      .replaceAll("/run/secrets/", `${secrets}/`)
      .replaceAll("/work/", `${work}/`);
    const scriptPath = join(root, "patch-command.sh");
    writeFileSync(scriptPath, script, { mode: 0o700 });

    const recordPath = join(root, "record.json");
    const result = spawnSync("bash", [scriptPath], {
      cwd: repo,
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, FAKE_BRIDGE_RECORD: recordPath },
    });
    const patchLogPath = join(artifacts, "patch-command.log");
    return {
      status: result.status,
      stderr: result.stderr,
      summary: readFileSync(join(artifacts, "summary.txt"), "utf8"),
      patchLog: existsSync(patchLogPath) ? readFileSync(patchLogPath, "utf8") : "",
      record: existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, "utf8")) : undefined,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("claude-code: a >128 KiB assignment reaches a capable bridge as --message-file, never as argv", async () => {
  const run = await runClaudeCodeScript({ prompt: LARGE_PROMPT, bridgeSupportsMessageFile: true });

  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.record, "bridge was invoked");
  const record = run.record!;
  assert.ok(record.argvMaxBytes < 1024, `largest argv element ${record.argvMaxBytes}B`);
  assert.ok(record.argvTotalBytes < MAX_ARG_STRLEN);
  assert.ok(record.argv.includes("--message-file"));
  assert.ok(!record.argv.includes("--message"), "--message must not be passed alongside --message-file");
  assert.match(String(record.messageFile), /\/tmp\/claude-assignment\.md$/);
  // Same bytes the old argv path produced: header + prompt with trailing newlines stripped.
  assert.equal(record.message, HEADER + LARGE_PROMPT.replace(/\n+$/, ""));
  assert.match(run.summary, new RegExp(`prompt_transport=file bytes=${Buffer.byteLength(HEADER + LARGE_PROMPT.replace(/\n+$/, ""))}\\n`));
});

test("claude-code: a bridge without --message-file support keeps the argv path for normal prompts", async () => {
  const run = await runClaudeCodeScript({ prompt: SMALL_PROMPT, bridgeSupportsMessageFile: false });

  assert.equal(run.status, 0, run.stderr);
  const record = run.record!;
  assert.ok(record.argv.includes("--message"));
  assert.ok(!record.argv.includes("--message-file"));
  assert.equal(record.message, HEADER + SMALL_PROMPT.replace(/\n+$/, ""));
  assert.match(run.summary, /prompt_transport=argv bytes=\d+\n/);
});

test("claude-code: a bridge without --message-file support fails before exec on a >128 KiB assignment", async () => {
  const run = await runClaudeCodeScript({ prompt: LARGE_PROMPT, bridgeSupportsMessageFile: false });

  assert.equal(run.status, 2);
  assert.equal(run.record, undefined, "bridge must not be exec'd with an oversized argv");
  assert.match(run.summary, /error=claude_prompt_too_large bytes=\d+ max=131071\n/);
  assert.match(run.summary, /failure_category=claude_prompt_too_large\n/);
  assert.match(run.patchLog, /supports --message-file/);
  assert.ok(!run.patchLog.includes("xxxxxxxx"), "the failure log must not echo the prompt");
});

for (const profile of ["hermes", "openclaw"] as const) {
  test(`${profile}: oversized prompts fail before exec with ${profile}_prompt_too_large`, async () => {
    const config = await loadConfig({
      A2A_DOCKER_RUNNER_SKIP_ENGINE_DETECT: "1",
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: profile,
    });
    const script = String(config.commandScript);
    const promptFile = `/work/artifacts/${profile}-prompt.md`;
    const upper = profile.toUpperCase();
    const guard = script.indexOf(`${upper}_ASSIGNMENT_BYTES="$(wc -c < ${promptFile}`);
    const expand = script.indexOf(`${upper}_ASSIGNMENT_PROMPT="$(cat ${promptFile})"`);
    assert.ok(guard > 0, "size guard present");
    assert.ok(expand > guard, "size guard runs before the prompt is expanded into argv");
    const guardBlock = script.slice(guard, expand);
    assert.match(guardBlock, new RegExp(`-ge 131072 \\]`));
    assert.match(guardBlock, new RegExp(`failure_category=${profile}_prompt_too_large`));
    assert.match(guardBlock, /exit 2\n/);
    const syntax = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);
  });
}
